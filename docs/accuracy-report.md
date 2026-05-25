# Casefile — Accuracy Report

**Run date:** 2026-05-23
**Model:** gpt-5 (via Replit OpenAI integration)
**Agent build:** Step 9 (post case-status fix)
**Reproducer:** `node .local/accuracy/run.mjs` — drives all three sample
cases end-to-end through the public REST + SSE API and writes per-case
artifacts under `.local/accuracy/runs/<sample-id>/`.

## Methodology

For each of the three bundled sample cases
(`artifacts/case-room/src/lib/sample-cases.ts`), the runner performs the
exact sequence a real analyst would:

1. `POST /api/cases` to create a fresh case container.
2. `POST /api/cases/:id/artifacts` for each bundled artifact (logs +
   host-context). The server computes SHA-256 at upload; the agent
   re-verifies it on every read.
3. `POST /api/cases/:id/investigate` and consumes the SSE stream until
   the terminal `done` event.
4. `GET /api/cases/:id` to capture the persisted analysis steps and
   incident report from the database (not the in-flight stream).

This exercises the production code path end-to-end: real LLM, real tools,
real database writes, real evidence-integrity triggers. No mocks.

Each case is scored on three axes:

- **Scenario identification** — did the agent correctly classify the
  incident type and root cause?
- **IOC extraction** — were the primary indicators captured?
- **Recommendation actionability** — are the response steps concrete and
  ordered correctly (contain → preserve → eradicate → hunt)?

## Quantitative Summary

| Case | Status | Steps | Findings | Self-Corrections | Tool Calls | Tool Errors | Tokens | Wall Time | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SSH Brute Force → Breach | complete | 4 | 4 | 1 | 13 | 2 | 62,195 | 56.4 s | 0.95 |
| Encoded PowerShell | complete | 3 | 3 | 1 | 11 | 1 | 30,312 | 37.8 s | 0.69 |
| DNS Data Exfiltration | complete | 4 | 4 | 1 | 13 | 2 | 37,391 | 43.6 s | 0.88 |

All three runs terminated with `stop_reason=finalized` (the agent
voluntarily called `finalize`, was not truncated by max-iteration or
max-token guards) and the case lifecycle correctly transitioned
`pending → analyzing → complete`.

## Per-case scoring

### Case 1 — SSH brute force with successful breakthrough (web-prod-02)

**Ground truth:** 19 failed SSH logins from 185.220.101.47, eventually
succeeding as the `deploy` account; immediate `sudo cat /etc/shadow` →
`wget` of remote payload to `/tmp/.k` → executed as root. Source IP is a
known Tor exit. Host is fully compromised.

**Agent output:**

- Scenario classification: **correct** — "compromised via SSH brute
  force against the deploy account from 185.220.101.47".
- IOCs captured: source IP, payload URL, compromised account,
  `/etc/shadow` read, `/tmp/.k` dropper path. All primary indicators
  present. Also extracted the internal host IP (10.0.4.21) from the
  context artifact.
- Tor exit attribution: agent called `fetch_url` against `ipinfo.io` and
  retrieved hostname `tor-exit-47.for-privacy.net` in Berlin (AS60729
  Stiftung Erneuerbare Freiheit) — correct attribution sourced from real
  public enrichment.
- Recommendations: isolate host, treat as fully compromised, lock the
  `deploy` account, rotate any credentials accessible from the host
  (treat `/etc/shadow` as exposed), block the source IP, disable
  password SSH, hunt for `/tmp/.k` and follow-on persistence. Ordering
  is correct (contain → preserve → eradicate → hunt).
- Confidence 0.95 — appropriate.

**Verdict: pass.** No false IOCs, no missed primary indicators, blast
radius correctly bounded ("not enough evidence here to prove lateral
movement beyond web-prod-02" — accurate per the artifacts provided).

### Case 2 — Encoded PowerShell from Word macro (WIN-FIN-07)

**Ground truth:** A finance user opened a `.docm` from a Cyrillic-
homoglyph sender (`cfo-office@corp-fіnance.com`). Word spawned an
encoded PowerShell downloader to `http://45.33.32.156/a.ps1`, dropped
`l.dll` to `%AppData%`, executed it via `rundll32`, and set a Run-key
for persistence.

**Agent output:**

- Scenario classification: **correct** — macro-driven downloader, DLL
  staging, persistence via Run key.
- IOCs captured: external IP, payload URL, dropped DLL path, document
  path, parent process chain, persistent user account.
- IOC extraction issue: the Cyrillic homoglyph sender domain was
  captured as `nance.com` instead of `corp-fіnance.com`. The regex in
  the IOC extractor does not handle Cyrillic homoglyphs as a single
  visual unit. Minor — agent still flagged the document path as
  suspicious — but worth fixing.
- **Self-correction (hypothesis revision):** external enrichment of
  45.33.32.156 returned `scanme.nmap.org` on Akamai Connected Cloud.
  Rather than ignore this contradiction, the agent flagged it
  explicitly in its synthesis step and in the final report summary,
  then **lowered confidence to 0.69** to reflect that high-confidence
  attribution of the IP as malicious is not supported by the available
  enrichment data alone. This is the precise behavior the hackathon
  brief calls "genuine self-correction" — the agent did not paper over
  evidence that conflicted with its working hypothesis.
- Recommendations: isolate host, acquire the `.docm` and dropped DLL,
  pull full PowerShell/Sysmon logs, block the IP/URL while validating
  whether the infrastructure was attacker-controlled at the time, hunt
  for the document and DLL across the environment, reset credentials
  for `jhamilton` if interactive compromise is confirmed. Ordering
  correct.

**Verdict: pass with one minor IOC-extractor finding.** The confidence
calibration is exemplary.

### Case 3 — DNS tunneling exfiltration (DB-REPLICA-03)

**Ground truth:** 4,800+ TXT queries from a production read-replica to
`*.exfil-gateway.com` over 12 minutes; high-entropy unique subdomains
~48 chars long; explicit `END.0000`/`END.0001` terminator markers; host
has no business reason to talk to that domain.

**Agent output:**

- Scenario classification: **correct** — "structured DNS
  tunneling/exfiltration channel rather than normal application DNS
  use", and explicitly recognized the `END.NNNN` terminator pattern as a
  structured channel marker.
- IOCs captured: source IP, base domain, all 10 sample subdomains, both
  END markers, internal resolver, the upstream `8.8.8.8` forwarder.
- External enrichment: agent attempted to enrich `exfil-gateway.com` via
  AlienVault OTX and confirmed `8.8.8.8` as Google Public DNS — used to
  justify the recommendation about restricting direct public-resolver
  access.
- Recommendations: isolate the replica, block the domain at DNS
  resolvers and DNS firewalls, restrict direct public DNS from
  production subnets, collect volatile evidence and PCAP for the exfil
  window, **review what data the replica had access to** (good — speaks
  to actual incident scope, not just network containment), hunt for
  similar high-entropy TXT patterns from other internal assets.
- Confidence 0.88 — appropriate (high-conviction tunneling channel,
  open question on payload contents without raw query bodies).

**Verdict: pass.**

## Self-correction analysis

Every run produced exactly one `self_correction` step. Two distinct
flavors of self-correction were observed:

1. **Mechanical retry** (Cases 1 and 3): the agent issued parallel
   `fetch_url` calls with `headers: null` and `body: null`, which the
   tool adapter rejected as schema violations. The agent recovered on
   the next iteration by reissuing with empty-object/empty-string
   placeholders. This is robust but not architecturally interesting —
   the tool schema should accept `null` for optional fields. (See
   "Failure modes" below.)
2. **Hypothesis revision** (Case 2): the agent received external
   enrichment data that contradicted its working hypothesis (attacker
   IP mapping to a well-known scanning service on commodity cloud
   infrastructure) and **explicitly downgraded confidence and surfaced
   the contradiction in the report**. This is the behavior the brief
   rewards. The system prompt's instruction — "if external enrichment
   contradicts your hypothesis, do not silently drop the contradiction"
   — produced the desired result.

The training-mode UI and the amber-bordered self-correction cards in the
case room make both flavors visible to a reviewer: they can count
revisions and inspect what changed, which is the auditability property
incident response demands.

## Failure modes observed

The runs surfaced four issues, none of which blocked completion:

1. **Tool schema rejects `null` for optional fields** (3 cases, 5
   total rejections). When the agent omits `headers` or `body` on
   `fetch_url`, it passes JSON `null` instead of an empty object/string.
   Zod schemas reject. Agent self-corrects in one extra iteration. Fix:
   change the tool input schemas to accept `null` and coerce, or
   document the empty-shape convention in the system prompt. Cost: ~2
   wasted tool calls and ~500 wasted tokens per affected case.
2. **`build_timeline` rejects events with `source: null`** (1 case).
   Same root cause. Same one-iteration recovery.
3. **IOC extractor does not handle Cyrillic homoglyphs** (Case 2). The
   lookalike sender domain `corp-fіnance.com` (Cyrillic 'і') was
   truncated to `nance.com`. Recommend either (a) widening the domain
   regex to include the IDN/Cyrillic ranges, or (b) adding a dedicated
   homoglyph-detection pass that flags domains containing non-ASCII
   characters in TLDs typically used as ASCII.
4. **The incident report has no `severity` field** (all 3 cases). The
   summary, IOCs, timeline, confidence, and recommendations are
   captured, but there is no explicit `severity` enum
   (informational/low/medium/high/critical). Reviewers expect that on a
   real IR report. Recommend adding `severity` to the
   `incident_reports` table and the `finalize` tool schema.

None of these are blockers for the hackathon submission, but #4 is the
most visible gap and would be a one-day fix.

### Fixes applied (2026-05-24 follow-up)

All four issues above were addressed in a same-day patch and the suite
re-ran clean:

1. `McpFetcherInput.headers/body` and `TimelineEventInput.source` switched
   from `.optional()` to `.nullish()` in `lib/sift-tools/`. The agent's
   `null` shapes now flow through without rejection. Verified: 0 tool
   errors across all three cases on re-run (vs. 5 on the original run).
2. Same root cause as #1; same fix resolves it.
3. `iocExtractor` domain regex rewritten with Unicode property classes
   (`\p{L}\p{N}`) and Unicode-aware lookarounds in place of ASCII `\b`.
   A new `suspiciousDomains` output array flags any captured domain
   (including those embedded in email addresses) whose labels mix ASCII
   Latin with non-ASCII letters — a strong homoglyph / IDN-spoofing
   signal. Unit-verified against `corp-fіnance.com` and `payρal.com`.
4. New `incident_severity` Postgres enum
   (`informational | low | medium | high | critical`) added to
   `incident_reports`. `FinalizeArgs` requires it; the system prompt
   teaches the five levels. Re-run produced: SSH = high, PowerShell =
   medium, DNS = high — all consistent with each scenario's blast
   radius.

Re-run summary (`node .local/accuracy/run-one.mjs <id>` per case):

| Case | Status | Tool Errors | Severity | Wall Time |
| --- | --- | --- | --- | --- |
| SSH Brute Force → Breach | complete | 0 | high | 38.2 s |
| Encoded PowerShell | complete | 0 | medium | 55.9 s |
| DNS Data Exfiltration | complete | 0 | high | 32.2 s |

## What the runs do NOT prove

Limitations of this report:

- Only 3 sample cases. A real accuracy benchmark would need 30+ cases
  with deliberately adversarial variants (planted distractors,
  ambiguous evidence, false alarms that should resolve to "no
  incident").
- All 3 cases produced clear narratives. Cases where the *correct*
  answer is "insufficient evidence to determine" or "this is a false
  positive" are not represented in the dataset.
- The agent's external enrichment depends on live public APIs
  (`ipinfo.io`, `otx.alienvault.com`). If those rate-limit or return
  different data on a future run, scoring may shift slightly. The
  reasoning trace, however, will still expose what data the agent
  actually saw — that's the value of the structured analysis steps.

## Architectural defenses verified by this run

The brief specifically calls for architecture that **enforces** evidence
integrity rather than relying on prompt adherence. These mechanisms
were active during all three runs:

- All artifact reads were hash-verified at runtime against the
  SHA-256 computed at upload time (`lib/db/src/integrity.ts`).
- Postgres triggers prevented any UPDATE/DELETE on the `artifacts`
  table (`lib/db/src/triggers.sql`).
- The agent had no shell-execution tool. It had only the typed
  forensic functions listed in the tool registry — no path existed for
  it to mutate or destroy evidence even if instructed to.
- SSRF defenses in `fetch_url` (DNS resolution + private/loopback IP
  rejection) executed cleanly against all enrichment requests.

## Bottom line

Three cases, three correct scenario identifications, three actionable
incident reports, three properly calibrated confidence scores
(including one appropriate downgrade in response to contradicting
evidence). One bug worth fixing (homoglyph IOC extraction), one schema
ergonomics issue worth addressing (null vs empty on optional tool
fields), one missing report field (severity enum). The agent works.
