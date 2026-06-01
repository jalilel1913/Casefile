# Casefile — Sample Dataset

Seven sample cases ship with Casefile, bundled into the UI as one-click
"Load sample" buttons and into the accuracy harness as the fixed
evaluation set. They were hand-authored to be realistic in shape and
content, not collected from real customer incidents. No artifact
contains live malware — binary artifacts are synthetic and built
deterministically in code.

**Source of truth:** [`artifacts/case-room/src/lib/sample-cases.ts`](../artifacts/case-room/src/lib/sample-cases.ts)
**Reproducer:** `node .local/accuracy/run-one.mjs <sample-id>` runs one
case end-to-end through the production REST + SSE path; results are
written to `.local/accuracy/runs/<sample-id>/` (summary.json,
events.jsonl, detail.json, report.md). Committed copies of the recorded
runs live in [`sample-logs/`](sample-logs/) — see
[`execution-logs.md`](execution-logs.md).

## Why these seven cases

The set is chosen to span the incident classes a SOC sees most, and to
exercise *different* subsets of the agent's capabilities and *different*
evidence types (text logs, network/PCAP, binary disk image), including
one case whose correct answer is a careful, evidence-bounded judgment
rather than a slam-dunk "compromised."

| # | Case | Class | Primary tools exercised | Key behavior under test |
| --- | --- | --- | --- | --- |
| 1 | SSH Brute Force → Breach | Credential attack | `parse_log`, `build_timeline`, `extract_iocs`, `fetch_url` | Multi-stage attack reconstruction; brute-force → success → post-exploit pivot |
| 2 | Encoded PowerShell | Malware / phishing | `parse_log`, `extract_iocs`, `fetch_url` | Self-correction after threat-intel contradicts hypothesis; IDN/homoglyph sender capture |
| 3 | DNS Data Exfiltration | Data exfiltration | `parse_log`, `analyze_network`, `extract_iocs`, `fetch_url` | High-volume covert-channel recognition; newly-registered exfil domain |
| 4 | Disk Image Carve | Disk forensics | `analyze_disk_image`, `extract_iocs`, `fetch_url` | Binary-artifact handling end to end (base64 upload, hash-over-bytes, partition parse, string extraction) |
| 5 | C2 Beacon (pcap) | Command & control | `analyze_pcap`, `analyze_network`, `extract_iocs`, `fetch_url` | Periodic-beacon detection from a packet capture; fixed-cadence egress that bypasses the proxy |
| 6 | Ransomware In Progress | Ransomware | `parse_log`, `build_timeline`, `extract_iocs` | Kill-chain reconstruction; blast-radius scoping; correct **critical** severity with urgent containment |
| 7 | Insider Data Theft | Insider threat | `parse_log`, `build_timeline`, `extract_iocs`, `fetch_url` | Evidence-bounded judgment; anti-destruction (history/shred); exfil-channel attribution without over-reaching |

Together they cover all eight forensic tools in `lib/sift-tools/` and the
full finalize cycle (`triage → deep_analysis → synthesis →
self_correction → finalize`).

---

## Case 1 — SSH Brute Force → Breach

- **Sample ID:** `ssh-bruteforce-breakthrough`
- **Scenario class:** Credential attack
- **Target host:** `web-prod-02` (10.0.4.21, Ubuntu 22.04, OpenSSH 8.9p1)
- **Attacker IP:** `185.220.101.47` (known Tor exit node)

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `auth.log` | `log_file` | 24 syslog lines — 19 failed SSH logins (12 invalid users + 6 against the real `deploy` account) over ~50 s, then one accepted password for `deploy`, then `sudo` to read `/etc/shadow`, a `wget` of a remote shell script to `/tmp/.k`, and its execution |
| `host_context.md` | `text` | Host posture: SSH exposed to 0.0.0.0/0, Fail2ban disabled, no SSH MFA, and a config push at 02:50Z that accidentally re-enabled `PasswordAuthentication` |

### Ground truth

An external attacker from a Tor exit sprays SSH for common service
usernames (all fail), pivots to the real `deploy` account, guesses its
password in 6 attempts (accepted at 03:14:52Z), and within 12 seconds
escalates to `sudo cat /etc/shadow`, pulls a remote shell script from the
same IP, and runs it. The success is enabled by the 24-minute-old
misconfiguration. Host compromised; `deploy` creds burned; the 02:50Z
misconfig is root cause.

### Expected good agent behavior

Recognise the brute-force burst; capture `185.220.101.47` and
`http://185.220.101.47:8080/k.sh`; enrich the IP (Tor/abuse); build the
timeline (burst → single success → immediate post-exploit); record
`triage`/`deep_analysis`/`synthesis` findings and ideally one
`self_correction`. Finalise **high** (single-host compromise + priv-esc,
contained), confidence ≥ 0.85.

---

## Case 2 — Encoded PowerShell

- **Sample ID:** `powershell-encoded-payload`
- **Scenario class:** Malware / phishing
- **Target host:** `WIN-FIN-07` (finance workstation, Defender + Sysmon)
- **Target user:** `CORP\jhamilton`
- **Apparent C2:** `45.33.32.156` (benign — deliberate misdirection)

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `powershell_sysmon.log` | `log_file` | 6 events: ScriptBlock 4104 with base64 payload + decoded equivalent, Sysmon network connect to `45.33.32.156:80`, `WINWORD.EXE → powershell.exe -enc …`, file create of `l.dll` to `%AppData%`, Run-key persistence as "OneDriveSync" |
| `endpoint_context.md` | `text` | Posture + the user's note that they clicked through a macro warning on a Word doc from **`cfo-office@corp-fіnance.com`** — the `і` is **U+0456 Cyrillic 'і'**, not ASCII `i` |

### Ground truth

Spear-phish using a Cyrillic homoglyph domain; Word macro launches an
encoded PowerShell downloader; PowerShell drops and runs `l.dll` and sets
a Run-key. The `45.33.32.156` IP is *not* on common block lists — it is
in the scenario to test whether the agent defers to public reputation
over local forensic evidence.

### Self-correction trap (the point of this case)

The correct behavior is a `self_correction` finding that acknowledges the
benign threat-intel result *and* explains why the local attack chain
(encoded command + WINWORD parent + Run-key + DLL drop) still outweighs
it — then finalise with a *tempered* confidence rather than a wrong one.
Finalise **medium**, confidence ≈ 0.65–0.85.

---

## Case 3 — DNS Data Exfiltration

- **Sample ID:** `dns-data-exfiltration`
- **Scenario class:** Data exfiltration
- **Target host:** `DB-REPLICA-03` (10.0.7.84, PostgreSQL read replica)
- **Exfil channel:** TXT queries to `*.exfil-gateway.com` via `ns1.corp.local`

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `bind9_query.log` | `log_file` | bind9 excerpt: 12 representative TXT queries to high-entropy 48-char subdomains under `exfil-gateway.com`, plus a footer reporting 4,814 queries in 12 m 44 s from one client (~156 ms mean interval) |
| `host_context.md` | `text` | Prod DB replica role, egress policy (10.0.0.0/8 + internal NTP/DNS only), resolver forwards external lookups to 8.8.8.8, and `exfil-gateway.com` registered 6 days ago via Namecheap |

### Ground truth

A production DB replica is exfiltrating via DNS tunneling: base32-style
high-entropy labels, TXT records, newly-registered destination, ~6.3
queries/s for 12 minutes (≈22 KB exfiltrated). Replica compromised;
egress policy failed in spirit; escalate to Data Platform.

### Expected good agent behavior

Count the queries and unique-subdomain cardinality; surface
`exfil-gateway.com` and `10.0.7.84`; enrich the domain (zero pulses or
registration date); record a `self_correction` reconciling "no
threat-intel hit" with "local evidence still makes this exfil";
recommend DNS sinkhole, replica isolation, DB read-audit. Finalise
**high**, confidence ≥ 0.80.

---

## Case 4 — Disk Image Carve

- **Sample ID:** `disk-image-carve`
- **Scenario class:** Disk forensics
- **Target host:** `WIN-FIN-07`
- **Source:** ~4 KB raw image carved from unallocated space

### Evidence artifacts

| Filename | Kind | Encoding | Contents |
| --- | --- | --- | --- |
| `carved.img` | `disk_image` | `base64` | Synthetic 4096-byte raw image: 512-byte MBR with one bootable Linux partition (type 0x83) followed by 7 sectors of mostly-zero data with embedded ASCII strings (C2 IP, callback URL, exfil endpoint, implant creds, `cron @reboot` persistence). Deterministic; never contains real malware |
| `triage_note.md` | `text` | `text` | SOC L2 triage note framing the carve and its objectives |

### Why this case exists

It is the only case that exercises the `disk_image` kind, the
`content_encoding=base64` upload path, hashing over **decoded** bytes,
the binary-consuming `analyze_disk_image` tool, and the "fall back to the
right tool" decision (a text IOC pass over base64 returns nothing useful).

### Ground truth

A fragment of a Linux staging image carved off unallocated space:
single bootable Linux partition, no detectable superblock, slack-space
plaintext indicators that look like implant staging — C2 IP
`91.219.236.142`, a callback URL on `malware-staging.xyz`, an exfil
endpoint on `exfil-c2.evil-domain.org`, a credential pair
(`deploy` / `P@ssw0rd-from-disk`), and `cron @reboot` under
`/opt/.k/run.sh`. The carve proves *staging artifacts existed*, not
execution on WIN-FIN-07 — that is the SOC's pivot.

### Expected good agent behavior

`analyze_disk_image` → MBR + 1 Linux partition + embedded indicators;
record the credentials and persistence command; enrich the C2 IP;
finalise around **medium** (staging, not active compromise) with a pivot
to endpoint/network telemetry.

---

## Case 5 — C2 Beacon (pcap)

- **Sample ID:** `c2-beacon-pcap`
- **Scenario class:** Command & control
- **Target host:** `WIN-ENG-14` (10.0.9.30, engineering workstation)
- **C2:** `45.61.138.92`, domain `sync.fastcdn-telemetry.live` (registered ~2 days prior)

### Evidence artifacts

| Filename | Kind | Encoding | Contents |
| --- | --- | --- | --- |
| `win-eng-14.pcap` | `network_capture` | `base64` | A synthetic packet-capture summary: a DNS lookup for the 2-day-old domain, then repeated TCP/443 connections to `45.61.138.92` at a fixed 30-second cadence (low jitter, small uniform request sizes) — direct egress that bypasses the mandatory proxy |
| `capture_context.md` | `text` | `text` | NDR sensor context: host role, the mandatory-proxy policy this traffic violates, and the absence of any EDR detection |

### Ground truth

WIN-ENG-14 is beaconing to attacker C2. The signal is the *regularity*:
a fixed ~30 s interval to a freshly-registered domain over direct 443
egress, bypassing the proxy, with uniform small payloads — the classic
automated-beacon shape, not human browsing. The host should be treated
as compromised and contained; the destination is the pivot indicator.

### Expected good agent behavior

- Calls `analyze_pcap` on the capture; reports the periodic cadence,
  low jitter, and connection count to a single external IP on 443.
- Calls `extract_iocs` / `analyze_network`; surfaces `45.61.138.92`,
  `sync.fastcdn-telemetry.live`, and the source `10.0.9.30`.
- Calls `fetch_url` to enrich the IP/domain (newly-registered; little or
  no reputation yet).
- Reasons that fixed-interval egress to a 2-day-old domain bypassing the
  proxy is automated C2 *despite* thin reputation data — a
  self-correction-flavored judgment.
- Finalises **high** (active C2 channel on a corporate endpoint,
  contained to one host), confidence ≥ 0.80, recommending host
  isolation, proxy-bypass remediation, and a hunt for the same cadence
  elsewhere.

---

## Case 6 — Ransomware In Progress

- **Sample ID:** `ransomware-in-progress`
- **Scenario class:** Ransomware
- **Target host:** `FS-CORP-01` (primary departmental file server)
- **Lateral target:** `FS-CORP-02`
- **Actor context:** unsigned `runner.exe` running as the `svc-backup` service account

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `fs-corp-01_sysmon.log` | `log_file` | Sysmon kill chain: unsigned `runner.exe` under `svc-backup` deletes volume shadow copies (`vssadmin`), disables boot recovery (`bcdedit`), purges the backup catalog (`wbadmin`), stops Veeam, kills Defender, then mass-encrypts `D:\dept_shares` (40k+ `.lockbit5` files), then pivots to `FS-CORP-02` over SMB via PsExec |
| `asset_context.md` | `text` | Asset criticality (primary file server), the `svc-backup` account's expected behavior, and the operational fact that containment will take company-wide shares offline |

### Ground truth

This is an *active*, *destructive*, *spreading* ransomware deployment:
backups and recovery are being destroyed first (anti-recovery), Defender
is killed (anti-detection), encryption is underway at scale, and lateral
movement to FS-CORP-02 has begun. This is the case where hesitation is
the wrong answer — the correct call is the highest severity and immediate
containment even at the cost of availability.

### Expected good agent behavior

- Calls `parse_log` and reconstructs the ordered kill chain
  (shadow-copy deletion → recovery disable → catalog purge → Veeam stop
  → Defender kill → mass-encrypt → SMB/PsExec pivot).
- Calls `build_timeline`; shows the destructive steps preceding
  encryption (the hallmark of modern ransomware).
- Calls `extract_iocs`; surfaces `runner.exe`, the `.lockbit5`
  extension, the `svc-backup` abuse, and `FS-CORP-02` as the lateral
  target.
- Records the blast radius explicitly (two servers, 40k+ files, backups
  destroyed).
- Finalises **critical**, high confidence, recommending *immediate*
  isolation of FS-CORP-01 and FS-CORP-02, disabling the `svc-backup`
  account, and accepting the shares-offline tradeoff — and noting that
  destroyed backups change the recovery posture.

---

## Case 7 — Insider Data Theft

- **Sample ID:** `insider-data-theft`
- **Scenario class:** Insider threat
- **Target host:** `db-bastion-01` (production DB bastion)
- **Actor:** `rkapoor` (senior DBA, resigned to join a competitor)
- **Exfil channels:** USB + upload to `file.io`

### Evidence artifacts

| Filename | Kind | Contents |
| --- | --- | --- |
| `db-bastion-01_audit.log` | `log_file` | Off-hours session for `rkapoor` starting 23:41: shell history disabled, bulk dump of ~2.8M customer records and ~980k cardholder rows from production, archive copied to a USB device and uploaded to `file.io`, then staging files shredded and history cleared — no change ticket, no second approver |
| `personnel_context.md` | `text` | HR/access context: the DBA's resignation and competitor destination, normal duties, and the change-control policy that off-hours bulk extraction violates |

### Why this case exists

It is the only case where the *correct* output is a careful,
evidence-bounded judgment rather than a clear external compromise. The
trap is over-reaching: the agent must conclude policy-violating insider
exfiltration **only from what the artifacts show**, distinguish *what is
proven* (the dump, the USB copy, the `file.io` upload, the
anti-forensics) from *what is inferred* (intent / competitor benefit),
and not invent indicators. The anti-forensic steps (history off, shred,
clear) are themselves part of the evidence.

### Expected good agent behavior

- Calls `parse_log` / `build_timeline`; reconstructs the off-hours
  sequence and flags the anti-forensics (history disabled then cleared,
  staging shredded).
- Calls `extract_iocs`; surfaces `rkapoor`, `file.io`, the USB copy, and
  the record/row counts as scope.
- Optionally `fetch_url` to characterise `file.io` as an anonymous
  file-sharing service (supports the exfil-channel reading).
- Keeps conclusions strictly evidence-based: states what is proven vs.
  inferred, and does not assert competitor handoff as fact.
- Finalises **high** (confirmed bulk PII/PCI exfiltration with
  anti-forensics; data exposure is real) with response steps:
  preserve the bastion, disable `rkapoor`, legal/HR hold, scope the
  exact records taken, and treat the `file.io` upload as external
  exposure.

---

## How the harness uses this dataset

`.local/accuracy/run.mjs` and `.local/accuracy/run-one.mjs` read
`SAMPLE_CASES` directly from
`artifacts/case-room/src/lib/sample-cases.ts` (via a small
`Function`-based loader to avoid TS compilation in the harness), then for
each case:

1. `POST /api/cases` to create a fresh case container.
2. `POST /api/cases/:id/artifacts` for each bundled artifact (the server
   computes SHA-256 at upload — over decoded bytes for base64 kinds; the
   agent re-verifies on every read).
3. `POST /api/cases/:id/investigate` and consumes the SSE stream until
   the terminal `done` event, recording every `tool_call`,
   `tool_result`, `finding`, `error`, `tokens`, and `done` event.
4. `GET /api/cases/:id` to capture the persisted analysis steps and
   incident report from the database (not the in-flight stream).
5. Writes `summary.json`, `events.jsonl`, `detail.json`, and (if a
   report was produced) `report.md` under
   `.local/accuracy/runs/<sample-id>/`.

This is the exact same code path a human exercises through the UI, with
no mocks. The harness now runs behind the same authentication gate as the
production API; see [`accuracy-report.md`](accuracy-report.md) for what
that means for reproducing the numbers.

## How to add a new case

1. Append a `SampleCase` entry to `SAMPLE_CASES` in
   `artifacts/case-room/src/lib/sample-cases.ts`. Required fields:
   `id` (kebab-case), `shortLabel`, `title`, `scenario`,
   `description`, `artifacts[]`.
2. Each artifact needs `kind` (one of the `ArtifactKind` enum:
   `log_file`, `network_capture`, `memory_strings`, `text`,
   `mcp_endpoint`, `disk_image`), `filename`, and `content` (string).
   For binary kinds (`disk_image`, `network_capture` carrying a PCAP),
   set `contentEncoding: "base64"` and pass base64 bytes; the server
   hashes the decoded payload so the stored `sha256Hash` matches
   `sha256sum file`.
3. The case appears in the UI "Load sample" dropdown automatically and in
   the harness via `node .local/accuracy/run-one.mjs <id>`.
4. Run it once, eyeball the report, then add a per-case section to
   `docs/accuracy-report.md`.

There is no separate ground-truth file format. The ground truth lives in
this document; per-case scoring lives in the accuracy report. For v2, a
JSON ground-truth schema with an assertion DSL would let the harness
self-score rather than relying on human review.
