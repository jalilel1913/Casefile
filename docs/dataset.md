# Casefile — Sample Dataset

Four sample cases ship with Casefile, bundled into the UI as
one-click "Load sample" buttons and into the accuracy harness as the
fixed evaluation set. They were hand-authored to be realistic in shape
and content, not collected from real customer incidents.

**Source of truth:** [`artifacts/case-room/src/lib/sample-cases.ts`](../artifacts/case-room/src/lib/sample-cases.ts)
**Reproducer:** `node .local/accuracy/run-one.mjs <sample-id>` runs one
case end-to-end through the production REST + SSE path; results are
written to `.local/accuracy/runs/<sample-id>/` (summary.json,
events.jsonl, detail.json, report.md).

## Why these three cases

The first three were chosen to span the three most common incident
classes a SOC analyst sees in the first hour of any week — credential
attack, endpoint malware, and data exfiltration. The fourth covers
disk forensics, which is a structurally different evidence type
(binary, base64-encoded on the wire, hashed over decoded bytes) and
exercises the only binary-consuming tool in the registry. Each case
exercises a *different* subset of the agent's capabilities:

| Case | Class | Primary tools exercised | Key behavior under test |
| --- | --- | --- | --- |
| SSH Brute Force → Breach | Credential attack | `parse_log`, `build_timeline`, `extract_iocs`, `fetch_url` | Multi-stage attack reconstruction; recognising the brute-force → success → post-exploit pivot |
| Encoded PowerShell | Malware / phishing | `parse_log`, `extract_iocs`, `fetch_url`, IOC homoglyph capture | Self-correction after threat-intel contradicts initial hypothesis; recognising IDN/homoglyph sender spoofing |
| DNS Data Exfiltration | Data exfiltration | `parse_log`, `analyze_network`, `extract_iocs`, `fetch_url` | High-volume pattern recognition; identifying covert channel vs. legitimate DNS noise; recognising newly-registered exfil domain |
| Disk Image Carve | Disk forensics | `analyze_disk_image`, `extract_iocs`, `fetch_url` | Binary-artifact handling end to end (base64 upload, hash-over-bytes, partition parsing, string extraction); recognising that a text-only IOC pass on a binary returns nothing and pivoting to the binary tool |

Together they cover all seven forensic tools in `lib/sift-tools/` and
the full finalize cycle (`triage → deep_analysis → synthesis →
self_correction → finalize`).

---

## Case 1 — SSH Brute Force → Breach

- **Sample ID:** `ssh-bruteforce-breakthrough`
- **Short label:** SSH Brute Force → Breach
- **Scenario class:** Credential attack
- **Target host:** `web-prod-02` (10.0.4.21, Ubuntu 22.04, OpenSSH 8.9p1)
- **Attacker IP:** `185.220.101.47` (known Tor exit node, plausible threat-intel hit)

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `auth.log` | `log_file` | 24 syslog lines — 19 failed SSH logins (12 invalid users + 6 against real `deploy` account) over ~50 s, then one accepted password for `deploy`, then `sudo` to read `/etc/shadow`, `wget` a remote shell script to `/tmp/.k`, and execute it |
| `host_context.md` | `text` | Host posture: SSH exposed to 0.0.0.0/0, Fail2ban disabled, MFA on SSH not configured, a config push at 02:50Z accidentally re-enabled `PasswordAuthentication` |

### Ground truth (what really happened)

1. External attacker from a Tor exit node spray-attacks SSH for common
   service-account usernames (admin, root, postgres, oracle, jenkins,
   git, ubuntu, ec2-user, devops, test, backup) — all fail because the
   accounts don't exist or password auth isn't allowed for them.
2. Attacker pivots to the `deploy` service account (which *does*
   exist) and guesses its password in 6 attempts (one accepted at
   03:14:52Z after 6 failed attempts on the same user).
3. The success is enabled by a 24-minute-old misconfiguration that
   re-enabled `PasswordAuthentication` for SSH.
4. Within 12 seconds the session escalates to `sudo cat /etc/shadow`,
   pulls a remote shell script from the same IP, and executes it.

The host should be considered compromised, the `deploy` account
credentials should be considered burned, and the misconfig at 02:50Z
is the root cause.

### Expected good agent behavior

- Calls `parse_log` on `auth.log`; recognises the brute-force pattern
  (19 fails in ~50 s from one IP).
- Calls `extract_iocs` and captures `185.220.101.47` and the
  `http://185.220.101.47:8080/k.sh` URL.
- Calls `fetch_url` to enrich `185.220.101.47` against public
  threat-intel; gets back evidence of Tor / abuse history.
- Calls `build_timeline` and notices the burst followed by a single
  success then immediate post-exploit activity.
- Records findings tagged `triage` (brute force detected),
  `deep_analysis` (account compromise confirmed by success),
  `synthesis` (root cause = recent misconfig), and ideally one
  `self_correction` (e.g., reconciling the host_context note that
  password auth "was supposed to be off").
- Finalises with severity = **high** (single host compromise + privilege
  escalation, but contained to one host), confidence ≥ 0.85.

### Current accuracy run

`status=complete`, `stop_reason=finalized`, 0 tool errors,
severity=high, confidence=0.95, ~38 s wall time, 1 self-correction.
See [`accuracy-report.md`](accuracy-report.md) for the full row.

---

## Case 2 — Encoded PowerShell

- **Sample ID:** `powershell-encoded-payload`
- **Short label:** Encoded PowerShell
- **Scenario class:** Malware / phishing
- **Target host:** `WIN-FIN-07` (finance workstation, Defender + Sysmon)
- **Target user:** `CORP\jhamilton` (Finance — Senior Analyst)
- **Attacker C2:** `45.33.32.156` (a benign address used here as a
  deliberate misdirection — see "Self-correction trap" below)

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `powershell_sysmon.log` | `log_file` | 6 events: PowerShell ScriptBlock logging (4104) with base64-encoded payload, the decoded equivalent, Sysmon network connect to `45.33.32.156:80`, Sysmon process create showing `WINWORD.EXE → powershell.exe -enc …`, file create of `l.dll` to `%AppData%`, Run-key registry persistence as "OneDriveSync" |
| `endpoint_context.md` | `text` | Endpoint posture, user info, baseline timestamp, and the user's note that they clicked through a macro warning on a Word doc emailed from **`cfo-office@corp-fіnance.com`** — the `і` is **U+0456 Cyrillic 'і'**, not the ASCII `i` |

### Ground truth (what really happened)

1. Spear-phish email impersonating the CFO's office using a Cyrillic
   homoglyph domain (`corp-fіnance.com` ≠ `corp-finance.com`).
2. Word macro launches an encoded PowerShell one-liner that downloads
   `a.ps1` from `http://45.33.32.156/a.ps1` and IEX-executes it.
3. PowerShell pulls down `l.dll`, drops it to `%AppData%`, runs it via
   `rundll32.exe`, and registers a Run-key for persistence.
4. The `45.33.32.156` IP is *not* on common threat-intel block lists
   — it's a legitimate-looking endpoint used in the scenario to test
   whether the agent will defer to public reputation over local
   forensic evidence.

The endpoint should be considered compromised, the user account should
be considered phished, and the homoglyph sender domain is the
attribution lead.

### Self-correction trap (the point of this case)

This is the case designed to test the agent's *self-correction* beat.
A naïve agent will:

1. See the encoded PowerShell + Run-key + DLL drop and rate the
   incident high.
2. `fetch_url` the C2 IP, see it has no malicious reputation, and
   either (a) ignore the contradiction or (b) over-correct and dismiss
   the incident.

The correct behavior is to record a `self_correction` finding that
acknowledges the contradiction *and* explains why the local forensic
evidence still outweighs the negative reputation result (encoded
command + WINWORD parent + Run-key + DLL drop is a known attack chain
regardless of what OTX says about the IP), then finalize with a
*tempered* confidence rather than a wrong one.

### Expected good agent behavior

- Calls `parse_log` on the Sysmon log; identifies WINWORD → powershell
  chain.
- Calls `extract_iocs` on the endpoint context and **captures the
  Cyrillic homoglyph domain** in the new `suspiciousDomains` output
  field.
- Calls `fetch_url` against `45.33.32.156` threat-intel; gets back a
  benign-looking response.
- Records a `self_correction` finding that reconciles the local
  evidence vs. the negative threat-intel result.
- Finalises with severity = **medium** (single endpoint compromised,
  contained, but with sensitive-user exposure), confidence ≈ 0.65–0.85
  (the tempered range is the right answer).

### Current accuracy run

`status=complete`, `stop_reason=finalized`, 0 tool errors,
severity=medium, confidence=0.69, ~56 s wall time, 1 self-correction.
The 0.69 (down from an initial 0.85 internal estimate) is the
self-correction at work — exactly the behavior under test.

---

## Case 3 — DNS Data Exfiltration

- **Sample ID:** `dns-data-exfiltration`
- **Short label:** DNS Data Exfiltration
- **Scenario class:** Data exfiltration
- **Target host:** `DB-REPLICA-03` (10.0.7.84, PostgreSQL read replica
  for production customer DB)
- **Exfil channel:** TXT queries to `*.exfil-gateway.com` via internal
  resolver `ns1.corp.local`

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `bind9_query.log` | `network_capture` | bind9 query log excerpt: 12 representative TXT queries to high-entropy 48-char subdomains under `exfil-gateway.com`, plus an aggregate footer reporting 4,814 total queries in 12 m 44 s from one client (mean inter-query interval 156 ms) |
| `host_context.md` | `text` | Host role (prod DB replica), egress policy (should only talk to 10.0.0.0/8 + internal NTP/DNS), the fact that the resolver forwards external lookups to 8.8.8.8, and that `exfil-gateway.com` was registered 6 days ago via Namecheap with Cloudflare NS records |

### Ground truth (what really happened)

A production DB read replica is exfiltrating data via DNS tunneling.
The encoding is base32-style (high-entropy fixed-length subdomain
labels), the channel is TXT records, and the destination is a
newly-registered domain with no business purpose. Volume (~6.3
queries/s sustained over 12 minutes) and packet size (48-char labels
≈ 30 bytes payload per packet) imply ~22 KB of exfiltrated data.

The DB replica should be considered compromised, the egress policy
clearly failed in spirit (the queries are technically internal to
`ns1.corp.local`, but `ns1` forwards them straight out), and the
incident should escalate to the Data Platform team.

### Expected good agent behavior

- Calls `parse_log` on the bind9 query log; counts the queries and
  notices the high cardinality of unique subdomains.
- Calls `extract_iocs`; surfaces `exfil-gateway.com` and the DB replica
  source IP (`10.0.7.84`).
- Calls `fetch_url` against `exfil-gateway.com` threat-intel; either
  gets back zero pulses (newly-registered, not yet flagged) or hits the
  registration date.
- Records a `self_correction` finding that reconciles "no threat-intel
  hit" with "the local forensic evidence still makes this exfil"
  (mirrors the Case 2 self-correction trap, in a different domain).
- Recommends DNS sinkhole, replica isolation, and a DB read-audit.
- Finalises with severity = **high** (active exfil from production
  customer DB; data egress = customer data exposure risk), confidence
  ≥ 0.80.

### Current accuracy run

`status=complete`, `stop_reason=finalized`, 0 tool errors,
severity=high, confidence=0.84, ~32 s wall time, 1 self-correction.

---

## Case 4 — Disk Image Carve

- **Sample ID:** `disk-image-carve`
- **Short label:** Disk Image Carve
- **Scenario class:** Disk forensics
- **Target host:** `WIN-FIN-07` (same finance laptop from Case 2)
- **Source:** ~4 KB raw image carved from unallocated space; treated
  as cold evidence (must round-trip with hash intact)

### Evidence artifacts

| Filename | Kind | Encoding | Contents |
| --- | --- | --- | --- |
| `carved.img` | `disk_image` | `base64` | A synthetic 4096-byte raw image: 512-byte MBR with one bootable Linux partition (type 0x83, startLBA=1, sizeLBA=7) followed by 7 sectors of mostly-zero data with embedded ASCII strings (C2 IP, callback URL, exfil endpoint, implant user + password, `cron @reboot` persistence, last-beacon timestamp). Built programmatically in `buildSampleDiskImage()` so the bytes are deterministic and the artifact never contains real malware |
| `triage_note.md` | `text` | `text` | SOC L2 triage note framing the carve and listing four triage objectives |

### Why this case exists

Cases 1–3 only exercise text artifacts. This case is the only one that
exercises:

- The `disk_image` artifact kind end-to-end.
- The `content_encoding=base64` upload path on `POST /cases/:id/artifacts`.
- Hashing over **decoded bytes** instead of the UTF-8 stream (so the
  artifact's `sha256Hash` matches what `sha256sum carved.img` would
  print on the original file).
- The binary-consuming `analyze_disk_image` tool (pure-Node MBR/GPT
  parser, filesystem-signature detector, printable-string extractor,
  embedded-indicator harvester).
- The "fallback to the right tool" decision: a text-only `extract_iocs`
  pass over a base64 string returns nothing useful; the agent must
  recognise that and reach for `analyze_disk_image`.

### Ground truth (what really happened)

A small fragment of a Linux rescue / staging image was carved off
WIN-FIN-07's unallocated space. The image has a single bootable Linux
partition but no detectable filesystem superblock (the carve was too
shallow). The slack space contains plain-text indicators that, taken
together, look like staging notes for an implant: a C2 IP
(`91.219.236.142`), a callback URL on `malware-staging.xyz`, an exfil
endpoint on `exfil-c2.evil-domain.org`, a credential pair
(`deploy` / `P@ssw0rd-from-disk`), and a `cron @reboot` persistence
line under `/opt/.k/run.sh`. The carve alone does not prove execution
on WIN-FIN-07 — that is the SOC's pivot.

### Expected good agent behavior

- Calls `analyze_disk_image` on `carved.img`; reports MBR + 1 Linux
  partition + the embedded IP, URLs, and domains.
- Calls `extract_iocs` on the same artifact; either gets the indicators
  again (text scan over the base64 string) or gets nothing (the
  agent must notice and proceed).
- Calls `fetch_url` against threat intel for at least the C2 IP.
- Records findings for the embedded credentials and the persistence
  command — the analyst's true value-add over a raw string dump.
- Finalises with severity around **medium** (not critical — the carve
  proves staging artifacts existed, not active compromise), with
  recommendations to pivot to endpoint / network telemetry on the
  extracted indicators.

### Current accuracy run

`status=complete`, `stop_reason=finalized`, 0 tool errors,
severity=medium, ~26 s wall time, 10 tool calls, 2 findings, IOCs:
1 IP + 2 domains + 2 URLs + 1 user + 1 password + 1 persistence cron.

---

## How the harness uses this dataset

`.local/accuracy/run.mjs` and `.local/accuracy/run-one.mjs` read
`SAMPLE_CASES` directly from `artifacts/case-room/src/lib/sample-cases.ts`
(via a small `Function`-based loader to avoid TS compilation in the
harness), then for each case:

1. `POST /api/cases` to create a fresh case container.
2. `POST /api/cases/:id/artifacts` for each bundled artifact (the
   server computes SHA-256 at upload; the agent re-verifies it on
   every read).
3. `POST /api/cases/:id/investigate` and consumes the SSE stream until
   the terminal `done` event, recording every `tool_call`,
   `tool_result`, `finding`, `error`, `tokens`, and `done` event.
4. `GET /api/cases/:id` to capture the persisted analysis steps and
   incident report from the database (not the in-flight stream).
5. Writes `summary.json`, `events.jsonl`, `detail.json`, and (if a
   report was produced) `report.md` under
   `.local/accuracy/runs/<sample-id>/`.

This is the exact same code path a human user exercises through the
UI, with no mocks. The harness exists to make every run reproducible
and machine-readable; the assertions about correctness live in
[`accuracy-report.md`](accuracy-report.md).

## How to add a new case

1. Append a `SampleCase` entry to `SAMPLE_CASES` in
   `artifacts/case-room/src/lib/sample-cases.ts`. Required fields:
   `id` (kebab-case), `shortLabel`, `title`, `scenario`,
   `description`, `artifacts[]`.
2. Each artifact needs `kind` (one of the `ArtifactKind` enum:
   `log_file`, `network_capture`, `memory_strings`, `text`,
   `mcp_endpoint`, `disk_image`), `filename`, and `content` (string).
   For `disk_image` (and any other binary kind added later), set
   `contentEncoding: "base64"` and pass the base64-encoded bytes as
   `content`; the server hashes the decoded payload so the stored
   `sha256Hash` matches `sha256sum file`.
3. The case becomes available in the UI's "Load sample" dropdown
   automatically and in the accuracy harness via
   `node .local/accuracy/run-one.mjs <id>`.
4. Run it once, eyeball the report, then add a "Per-case scoring"
   section to `docs/accuracy-report.md` documenting the expected
   behavior and the observed run.

There is no separate ground-truth file format. The ground truth lives
in this document and the per-case scoring in the accuracy report. For
v2, a JSON ground-truth schema with assertion DSL would let the
harness self-score rather than relying on human review.
