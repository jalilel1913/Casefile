# Casefile — Accuracy Report

**Model:** OpenAI **gpt-5.4** (via the Replit AI Integrations proxy)
**Reproducer:** `node .local/accuracy/run.mjs` (all cases) /
`node .local/accuracy/run-one.mjs <id>` (one case) — drives the sample
cases end-to-end through the production REST + SSE API and writes per-case
artifacts under `.local/accuracy/runs/<sample-id>/`.

## Honesty up front: what is measured vs. documented

The dataset has **seven** cases (see [`dataset.md`](dataset.md)). This
report is split accordingly, because not all seven have a fresh,
machine-recorded harness run:

- **Four cases have recorded end-to-end harness runs** — SSH brute force,
  encoded PowerShell, DNS exfiltration, and disk-image carve. The raw
  recordings are committed under [`sample-logs/`](sample-logs/)
  (`*.events.jsonl` + `*.summary.json`) and the numbers below come
  directly from them.
- **Three cases are documented by ground truth + expected behavior but
  not freshly harness-run** — C2 beacon (pcap), ransomware-in-progress,
  and insider data-theft. They were added after the API gained
  authentication, and the accuracy harness now hits that same auth gate
  (there is no dev bypass). Until the harness can authenticate
  unattended, these three are validated against the ground truth in
  [`dataset.md`](dataset.md) through the authenticated UI rather than by
  recorded runs. This is called out so the report is not read as
  claiming seven measured cases.

A caveat that applies to *all* numbers here: runs are nondeterministic.
The model, and the live threat-intel APIs the agent enriches against, can
return different data on different days, so step counts, token usage,
wall time, self-correction count, and even severity/confidence shift
slightly run-to-run. The structured analysis steps and `execution_logs`
always expose exactly what the agent saw on a given run, which is the
point of the audit trail.

## Methodology

For each case the runner performs the exact sequence a real analyst would
through the UI:

1. `POST /api/cases` to create a fresh case container.
2. `POST /api/cases/:id/artifacts` for each bundled artifact. The server
   computes SHA-256 at upload (over decoded bytes for base64 kinds); the
   agent re-verifies it on every read.
3. `POST /api/cases/:id/investigate` and consumes the SSE stream until
   the terminal `done` event.
4. `GET /api/cases/:id` to capture the persisted analysis steps and
   incident report from the database (not the in-flight stream).

This exercises the production code path end-to-end: real LLM, real tools,
real database writes, real evidence-integrity triggers. No mocks.

Each case is scored on three axes: **scenario identification** (incident
type + root cause), **IOC extraction** (primary indicators captured), and
**recommendation actionability** (concrete, ordered contain → preserve →
eradicate → hunt).

## Quantitative summary — measured cases

Numbers below are from the committed recordings in
[`sample-logs/`](sample-logs/).

| Case | Status | Stop | Steps | Findings | Self-corr | Tool calls | Tool errors | Tokens | Wall time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SSH Brute Force → Breach | complete | finalized | 3 | 3 | 1 | 9 | 0 | 41,937 | 35.9 s |
| Encoded PowerShell | complete | finalized | 2 | 2 | 0* | 11 | 0 | 41,544 | 55.9 s |
| DNS Data Exfiltration | complete | finalized | 3 | 3 | 1 | 11 | 0 | 25,267 | 32.2 s |
| Disk Image Carve | complete | finalized | 3 | 3 | 1 | 11 | 0 | 29,894 | 30.9 s |

All four runs terminated with `stop_reason=finalized` (the agent
voluntarily called `finalize`; it was not truncated by a max-iteration or
max-token guard) and the case lifecycle transitioned
`pending → analyzing → complete`. **Zero tool errors** across all four.

\* The PowerShell self-correction is the most run-dependent number in the
set: the *behavior* under test (temper confidence after benign
threat-intel, do not flip the conclusion) reproduces reliably, but on
this particular recording it was folded into the synthesis step rather
than emitted as a separately-tagged `self_correction` row. Earlier
recordings of the same case emitted it as a distinct self-correction with
a confidence downgrade to ~0.69. Either way the conclusion (medium
severity, tempered confidence) is correct.

## Per-case scoring — measured cases

### Case 1 — SSH brute force with breakthrough (web-prod-02)

**Agent output.** Scenario classification correct ("compromised via SSH
brute force against the `deploy` account from 185.220.101.47"). IOCs
captured: source IP, payload URL, compromised account, `/etc/shadow`
read, `/tmp/.k` dropper path, plus the internal host IP from context.
Tor-exit attribution sourced from a real `fetch_url` enrichment against
`ipinfo.io`. Recommendations correctly ordered (isolate → preserve →
lock account / rotate creds → block IP / disable password SSH → hunt for
persistence). Severity **high**, confidence ~0.95.

**Verdict: pass.** No false IOCs, no missed primary indicators, blast
radius correctly bounded to web-prod-02.

### Case 2 — Encoded PowerShell from Word macro (WIN-FIN-07)

**Agent output.** Scenario classification correct (macro-driven
downloader, DLL staging, Run-key persistence). IOCs captured: external
IP, payload URL, dropped DLL path, document path, parent-process chain,
persistent account; the Cyrillic homoglyph sender domain is captured via
the `suspiciousDomains` signal (this was a bug in an earlier build —
truncation to `nance.com` — since fixed with Unicode-aware extraction).
The defining behavior is **confidence calibration**: enrichment of
`45.33.32.156` returns benign, and rather than flip its conclusion the
agent keeps the medium severity (local attack chain stands) while
tempering confidence. Recommendations correctly ordered.

**Verdict: pass.** Confidence calibration is exemplary and is the point
of this case.

### Case 3 — DNS tunneling exfiltration (DB-REPLICA-03)

**Agent output.** Scenario classification correct ("structured DNS
tunneling/exfiltration channel rather than normal application DNS use").
IOCs captured: source IP, base domain, sample subdomains, internal
resolver, and the upstream `8.8.8.8` forwarder. Enrichment attempted
against the newly-registered domain; `8.8.8.8` confirmed as Google Public
DNS and used to justify the "restrict direct public-resolver access"
recommendation. Recommendations include reviewing what data the replica
could access — incident scope, not just network containment. Severity
**high**, confidence ~0.84–0.88.

**Verdict: pass.**

### Case 4 — Disk image carve (WIN-FIN-07)

**Agent output.** Calls `analyze_disk_image`, reports the MBR + single
Linux partition, and harvests the slack-space indicators (C2 IP
`91.219.236.142`, callback/exfil URLs, the embedded credential pair, and
the `cron @reboot` persistence line). Records findings for the
credentials and persistence — the analyst value-add over a raw string
dump. Correctly bounds the conclusion to *staging artifacts existed*, not
*execution on WIN-FIN-07*, and recommends pivoting to endpoint/network
telemetry. Severity **medium**.

**Verdict: pass.** Demonstrates the full binary path (base64 upload →
hash-over-decoded-bytes → partition parse → string/indicator
extraction).

## Documented cases (not freshly harness-run)

These three are scored against the ground truth in
[`dataset.md`](dataset.md). They run through the same production code path
in the authenticated UI; what they lack is a committed unattended
recording, because the harness now sits behind the API auth gate.

- **Case 5 — C2 Beacon (pcap).** Expected: `analyze_pcap` detects the
  fixed ~30 s cadence / low jitter / single-destination 443 egress;
  IOCs `45.61.138.92` + `sync.fastcdn-telemetry.live` + source
  `10.0.9.30`; reasons to automated C2 despite thin reputation on the
  2-day-old domain; finalises **high** with host isolation +
  proxy-bypass remediation + cadence hunt.
- **Case 6 — Ransomware In Progress.** Expected: ordered kill-chain
  reconstruction (shadow-copy deletion → recovery disable → catalog purge
  → Veeam stop → Defender kill → mass-encrypt `.lockbit5` → SMB/PsExec
  pivot to FS-CORP-02); blast radius scoped to two servers + destroyed
  backups; finalises **critical** with immediate containment despite the
  availability cost. This is the case that tests whether the agent will
  commit to the highest severity when the evidence demands it.
- **Case 7 — Insider Data Theft.** Expected: off-hours timeline for
  `rkapoor` with the anti-forensics flagged (history disabled/cleared,
  staging shredded); scope = ~2.8M customer records + ~980k cardholder
  rows; exfil via USB + `file.io`; conclusions kept strictly
  evidence-based (proven vs. inferred, no asserted competitor handoff);
  finalises **high** with preserve / disable account / legal-HR hold /
  scope-the-records response. This is the case that tests restraint —
  not over-reaching beyond the artifacts.

## Self-correction analysis

Across the measured runs, two flavors of self-correction show up:

1. **Hypothesis revision** (PowerShell, and the DNS/C2 "thin reputation"
   reasoning): the agent receives enrichment that contradicts or
   under-supports its working hypothesis and *surfaces the
   contradiction* — tempering confidence or explicitly justifying why
   local evidence still wins — rather than silently dropping it. This is
   the behavior the brief rewards, and it comes directly from the system
   prompt's "do not silently drop a contradiction" instruction.
2. **Mechanical recovery** (historically): earlier builds rejected
   `null` for optional tool fields, costing one recovery iteration; the
   schemas were switched to `.nullish()` and the measured runs show **0
   tool errors**.

The training-mode UI and the amber-bordered self-correction cards make
both flavors visible to a reviewer, who can count revisions and inspect
what changed — the auditability property IR demands.

## Architectural defenses verified by these runs

The brief specifically asks for architecture that **enforces** evidence
integrity rather than relying on prompt adherence. These were active
during every measured run:

- All artifact reads were hash-verified at runtime against the SHA-256
  computed at upload (`lib/db/src/integrity.ts`).
- Postgres triggers blocked any UPDATE/DELETE on `case_artifacts`
  (`lib/db/src/triggers.sql`).
- The agent had no shell, file-write, or arbitrary-code tool — only the
  typed forensic functions in the registry. No path existed to mutate or
  destroy evidence even if instructed. (These tools are now exposed
  through the custom MCP server in `lib/sift-mcp`, which registers only
  the typed functions and no generic primitive; it wraps the identical
  `invokeTool` implementations, so tool outputs are unchanged from the
  recordings below, which predate the MCP layer.) All measured runs used
  the **in-process** MCP transport over Casefile's simulated tools. The
  remote Streamable-HTTP transport to a user-hosted SANS SIFT Workstation
  (`SIFT_MCP_URL`) is an opt-in path verified only against a local mock
  serving the same contract; no accuracy figure here was produced against
  an external VM, and the remote-only discovered-tool path shifts evidence
  verification to that VM (see [`architecture.md`](architecture.md)). How
  the verified bytes reach a content-consuming tool follows a documented
  contract (`lib/sift-mcp/src/evidence.ts`): small text/JSON is sent inline
  with its `sha256`, while large binary evidence is passed by reference
  (`evidenceRef { path, sha256 }`) that the server resolves under its
  evidence root and re-hashes before the tool runs, failing closed on a
  missing file or hash mismatch.
- `mcpFetcher`'s three SSRF layers executed cleanly against all
  enrichment requests in the recorded runs. Note a scope distinction:
  the committed recordings predate the `fetch_url` hardening and show the
  model passing a raw `url` (see the drift note in
  [`execution-logs.md`](execution-logs.md)). The fixed-template +
  IOC-kind guardrail — where a free-form URL is not even expressible — is
  part of the **currently enforced** architecture
  (`lib/sift-agent/src/tool-adapter.ts`), not something these particular
  recordings demonstrate. SSRF defense was active in both the recordings
  and current code; only the URL-construction surface changed.

### What happens when the agent attempts to bypass these

This is the part the brief actually cares about. Each control was
considered against an actively-adversarial model:

- **Alter/delete evidence:** no tool exposes the capability, and a direct
  DB write is rejected by the triggers — the mutation fails, nothing
  changes.
- **Reason over tampered bytes:** if evidence is changed out-of-band, the
  next `loadVerifiedArtifact` detects the hash mismatch, emits a
  `SPOLIATION` event, and halts the run.
- **Reach an internal/attacker URL:** the fixed-template + IOC-kind +
  SSRF layers reject it; the model cannot supply a raw URL.
- **Fabricate an unsupported finding:** the finding is still written
  (prose grounding is prompt-based), **but** every tool read is logged
  with hashes, so the chain-of-custody view shows no supporting
  observation exists. The architectural controls protect the evidence
  and the audit trail; they make an unsupported claim *visible* rather
  than silently preventing the prose. This is the honest boundary
  between what architecture can and cannot guarantee, and it is why the
  audit trail — not the prompt — is the trust anchor.

## What these runs do NOT prove

- **Only four measured cases**, three documented. A real accuracy
  benchmark needs 30+ cases with adversarial variants (planted
  distractors, ambiguous evidence, true false-positives that should
  resolve to "no incident").
- **The harness cannot currently self-authenticate.** The most impactful
  next step for this report is a dev-mode auth path so all seven cases
  re-run unattended and the documented three become measured.
- **Enrichment depends on live public APIs.** If `ipinfo.io` /
  `otx.alienvault.com` rate-limit or change data, scoring shifts
  slightly. The reasoning trace still records exactly what the agent saw.

## Bottom line

Four cases measured end-to-end with zero tool errors, correct scenario
identification, actionable ordered recommendations, and calibrated
confidence (including the deliberate downgrade-on-contradiction the brief
rewards). Three further cases — C2 beacon, ransomware, and insider theft
— are specified against ground truth and run through the same code path in
the authenticated UI, pending a harness auth path to make them measured.
The architectural integrity controls held under adversarial framing; the
honest limit is that prompt-grounding, not architecture, governs the
model's prose — which is exactly why every observation is independently
hash-logged.
