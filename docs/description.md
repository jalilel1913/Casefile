# Casefile — Written Description

## What it is

Casefile is a fully autonomous incident-response (IR) agent. A
human uploads evidence — logs, network captures, suspicious files,
host-context notes — into a case folder and Casefile investigates it
end-to-end: forms hypotheses, runs forensic tools to test them, records
its reasoning as it goes, and produces a final incident report with
severity, IOCs, a chronological timeline, recommendations, a numeric
confidence score, and a verifiable chain of custody.

The agent runs on top of GPT-5 and a hand-built suite of six forensic
tools. The reasoning loop, the tool catalog, and the persistence layer
are deliberately separated so each piece is replaceable and each tool
output is reproducible.

## The problem

Two real problems push in opposite directions, and Casefile addresses both
at once.

**1. Senior analysts cannot scale.** The bottleneck in any blue team
is the number of incidents a senior analyst can triage per day. Junior
analysts are forced to learn by watching, but the watching is
piecemeal — they see the final report, not the chain of reasoning that
produced it. As a result the learning curve is years long and largely
tacit.

**2. LLM agents in security cannot be trusted on their own.** A
language model that writes confident-sounding IR conclusions without
proof is worse than no agent at all, because it pollutes the case
record with hallucinated indicators that a human then has to disprove.
The brief for this hackathon asked for an agent whose conclusions are
*verifiable*, not just plausible.

Casefile is built to be useful for the first problem only because it is
trustworthy for the second.

## Who it is for

- **Junior analysts**, who get to watch a senior-style reasoning loop
  unfold one step at a time, with the rationale, expectation, and
  found-result for each tool call exposed in the UI.
- **SOC managers**, who get a fully auto-triaged first pass on
  incoming cases with a confidence score and severity that they can
  use to route work.
- **Red/blue tabletop exercises**, where Casefile can be pointed at a
  scenario and used as a synthetic adversary or a synthetic responder
  for training.

## How it works (technical narrative)

The full architecture is in [`architecture.md`](architecture.md). This
section is the prose version of the same shape, emphasising the design
choices that matter.

The system is one Postgres-backed Fastify service with three layers:

1. **The agent loop** (`lib/sift-agent/`) drives GPT-5 in a
   tool-calling loop. The model is given a system prompt that defines
   the four-beat investigation cycle (triage → deep analysis →
   synthesis → self-correction), an enumerated tool table, and one
   non-negotiable rule: *never claim a fact about evidence without a
   tool-verified observation to back it up*. The loop streams every
   reasoning step, tool call, and tool result back to the browser over
   Server-Sent Events.

2. **The forensic tool suite** (`lib/sift-tools/`) is six pure
   functions: a log parser, an IOC extractor (with Unicode-aware
   homoglyph detection), an entropy scanner, a timeline builder, a
   network analyser, and `mcpFetcher` — the one and only tool that
   touches the network, used to enrich indicators against public
   threat-intel endpoints. `mcpFetcher` has three concentric layers
   of SSRF defence (literal-host blocking including
   decimal/hex-encoded IPv4 and IPv6 loopback/ULA forms, DNS
   resolution checking, and a 10s/500 KB timeout cap).

3. **The persistence + integrity layer** (`lib/db/`) is the part that
   makes the agent trustworthy. It enforces three guarantees that
   together form the "evidence integrity invariant" described below.

### The evidence-integrity invariant

A judge reading the brief asked: *if the LLM tries to lie about what
the evidence said, how do you catch it?* Casefile answers in three layers,
all enforced rather than advised.

**Storage immutability.** Two `BEFORE` triggers on `case_artifacts`
(in `lib/db/src/triggers.sql`) reject any `UPDATE` that touches
evidence content or its stored SHA-256 hash, and reject any direct
`DELETE` that is not a cascade from the parent case row. Even a
compromised agent process cannot tamper with the inputs it is
reasoning about, because the application layer has no path through
which to do so — the database refuses.

**Read-time verification.** Every tool that reads an artifact does so
through `loadVerifiedArtifact()`, which re-hashes the bytes on each
read and compares to the hash stored at upload time. A mismatch raises
`ArtifactIntegrityError`, the agent yields a `SPOLIATION` event, and
the investigation halts. The hash actually seen during the read, plus
a hash of the tool's output, are written to `execution_logs` — so the
chain-of-custody view in the UI can replay exactly what the agent saw,
in order, with cryptographic proof.

**Reasoning provenance.** Every meaningful conclusion the agent draws
is written as an `analysis_steps` row via the `record_finding` tool.
The schema is structured: `phase`, `rationale`, `expected`, `found`,
`next_step`. The agent is required to populate all five — there is no
free-form "thought" field where it can hide. The final
`incident_reports` row commits to a numeric confidence (0.00–1.00) and
a 5-level severity enum (informational / low / medium / high /
critical). The agent cannot hedge.

### Self-correction

The fourth beat of the investigation cycle is the most important one
for trustworthiness. When two pieces of evidence disagree — say, an
IOC extractor flags `scanme.nmap.org` as suspicious but a `fetch_url`
to public threat-intel returns "this is a legitimate scan target
operated by the nmap project" — the agent is instructed to write a
`self_correction` finding rather than picking the more convenient
answer. In the bundled PowerShell sample case, this is exactly what
happens: the agent's initial confidence is 0.85, then it issues a
self-correction after the IP enrichment comes back benign, and
finalises at 0.69. The downgrade is the right answer, and it is
visible to the human in the UI.

The bundled accuracy report (`docs/accuracy-report.md`) verifies that
all three sample cases produce at least one self-correction finding
and terminate with `stop_reason=finalized` (the agent voluntarily
called `finalize`, not truncated by a max-iteration guard).

## What is novel

- **Database-enforced evidence immutability.** Most agent frameworks
  treat artifact integrity as an application-layer convention. Casefile
  treats it as a database constraint. A new contributor who writes a
  code path that tries to mutate `case_artifacts.content` gets an
  exception from Postgres, not a code review comment.
- **Hashed tool I/O on every call.** Every `execution_logs` row stores
  both the verified hash of the artifact read and a hash of the tool's
  output. The chain-of-custody view is not a log — it is a replayable
  proof.
- **Structured reasoning, not freeform thought.** `analysis_steps`
  forces the agent into a five-field schema. Findings cannot be
  ambiguous, hedged, or absent.
- **Severity + confidence are both required.** The agent has to commit
  to a number and a level. There is no "the situation is concerning"
  escape hatch.
- **One network tool, three SSRF layers.** Threat-intel enrichment is
  table-stakes for an IR agent and is also the single largest
  potential blast radius. Concentrating egress into one Zod-validated,
  SSRF-hardened function keeps the audit surface tiny.

## What has been measured

Three bundled sample cases (SSH brute-force with breakthrough, encoded
PowerShell from a Word macro, DNS-tunnel data exfiltration) are run
end-to-end through the production code path — real LLM, real tools,
real database writes, real integrity triggers, no mocks — by
`.local/accuracy/run.mjs`. The accuracy report
(`docs/accuracy-report.md`) records: status, step count, finding
count, self-correction count, tool calls, tool errors, token usage,
wall time, and confidence per case.

Current numbers (post-fixes):

| Case | Status | Tool Errors | Self-Corrections | Severity | Confidence | Wall Time |
| --- | --- | --- | --- | --- | --- | --- |
| SSH Brute Force → Breach | complete | 0 | 1 | high | 0.95 | 38 s |
| Encoded PowerShell | complete | 0 | 1 | medium | 0.69 | 56 s |
| DNS Data Exfiltration | complete | 0 | 1 | high | 0.84 | 32 s |

All three terminate with `stop_reason=finalized`. All three produce at
least one self-correction. Zero tool errors across all three. The
PowerShell case correctly downgrades its own confidence after
enrichment contradicts its initial hypothesis, demonstrating the
self-correction loop is real rather than ceremonial.

## What this is not

- It is not an EDR or a SIEM. It does not collect telemetry — a human
  collects the evidence and uploads it.
- It is not a replacement for a senior analyst. It is a faster,
  cheaper, more patient first-pass triage that produces audit-trail
  artifacts a senior analyst can use.
- It does not write back to production systems. There is no
  containment action, no firewall rule, no AD lockout. It produces
  recommendations; a human acts on them.

## Try it out

See [`../README.md`](../README.md) for setup, sample cases, and a
suggested walkthrough.
