# Casefile — Written Description

> Devpost-style submission write-up. The five headings below map to the
> standard Devpost prompts (Inspiration / What it does / How we built it /
> Challenges / What we learned / What's next), followed by a Built-With
> list.

## Inspiration

Two real problems push in opposite directions, and Casefile is built to
address both at once.

**Senior analysts cannot scale.** The bottleneck in any blue team is the
number of incidents a senior analyst can triage per day. Junior analysts
learn by watching, but the watching is piecemeal — they see the final
report, never the chain of reasoning that produced it. The learning
curve is years long and largely tacit.

**LLM agents in security cannot be trusted on their own.** A model that
writes confident-sounding IR conclusions without proof is worse than no
agent at all, because it pollutes the case record with hallucinated
indicators a human then has to disprove. The hackathon brief asked for
an agent whose conclusions are *verifiable*, not just plausible.

Casefile is useful for the first problem only because it is trustworthy
for the second.

## What it does

A human uploads evidence — logs, network captures, packet captures, disk
images, host-context notes — into a case folder. Casefile then
investigates end-to-end on its own:

- forms hypotheses and picks forensic tools to test them;
- runs those tools over the *verified* evidence bytes;
- records each step as a structured finding (phase, rationale, what it
  expected, what it found, what to do next);
- self-corrects when threat-intel or a later tool contradicts an earlier
  hypothesis;
- produces a final incident report with severity, IOCs, a chronological
  timeline, recommendations, a numeric confidence score, and a
  verifiable chain of custody.

Everything streams to the browser live over Server-Sent Events, so a
junior analyst can watch a senior-style reasoning loop unfold one tool
call at a time. A "Chain of Custody" view shows every tool call with the
SHA-256 of the exact bytes it read, so any conclusion can be re-derived
from the persisted record.

Seven hand-authored sample cases ship in the UI as one-click loads,
spanning credential attack, endpoint malware, DNS exfiltration, disk
forensics, C2 beaconing over PCAP, ransomware-in-progress, and an
insider data-theft scenario where the *correct* call is a policy
judgment grounded strictly in the evidence. See
[`dataset.md`](dataset.md).

### Who it is for

- **Junior analysts**, who watch the rationale/expectation/result of
  each tool call instead of just the final verdict.
- **SOC managers**, who get an auto-triaged first pass with a confidence
  score and severity they can use to route work.
- **Tabletop exercises**, where Casefile can act as a synthetic
  responder against a scripted scenario.

## How we built it

Casefile is a pnpm monorepo with TypeScript project references. The whole
thing is one Postgres-backed Express 5 service plus a React + Vite UI,
organized into three layers.

**1. The agent loop (`lib/sift-agent/`).** The architectural pattern is
a *Direct Agent Extension*: a single agent built directly on the model's
native tool-calling. The loop drives **OpenAI gpt-5.4** (through the
Replit AI Integrations proxy — no API key in app code) with a system
prompt that defines a four-beat investigation cycle (triage → deep
analysis → synthesis → self-correction), an enumerated tool table, and
one non-negotiable rule: *never claim a fact about evidence without a
tool-verified observation to back it up*. Every reasoning step, tool
call, and tool result streams back to the browser over SSE.

**2. The forensic tool suite (`lib/sift-tools/`).** Eight pure
functions: a log parser, an IOC extractor (with Unicode-aware homoglyph
detection), an entropy scanner, a timeline builder, a network analyzer,
a PCAP analyzer, a disk-image analyzer (a pure-Node MBR/GPT parser that
hashes and reads *decoded* bytes), and `mcpFetcher` — the one tool that
touches the network. This is a *self-built, SIFT-style* toolkit; it is
not the SANS SIFT Workstation, and "SIFT" here is an homage rather than
a dependency.

These tools are not called directly by the agent. They are wrapped by a
**custom MCP (Model Context Protocol) server** (`lib/sift-mcp/`, built on
the official `@modelcontextprotocol/sdk`) that registers each one as a
typed, schema-validated MCP tool. The agent executes every forensic tool
by issuing an MCP `tools/call` over an in-process client
(`InMemoryTransport`), and a stdio entrypoint exposes the identical tool
surface to any external MCP client. This is the hackathon's **Custom MCP
Server** pattern: the agent speaks MCP to reach its tools, and the MCP
server registers only the typed forensic functions — there is no
`execute_shell` or other generic primitive on that surface.

**3. The persistence + integrity layer (`lib/db/`).** This is the part
that makes the agent trustworthy. Postgres triggers make evidence
immutable, every artifact read is hash-verified at runtime, and every
tool call and finding is persisted with cryptographic provenance.

The REST contract is an OpenAPI spec (`lib/api-spec/openapi.yaml`) from
which the Zod schemas and React Query hooks are generated with Orval, so
the client and server never drift.

### The trust model, concretely

Casefile separates **architectural** guardrails (enforced by code/DB/runtime
— the agent cannot bypass them) from **prompt-based** guardrails
(instructions a misaligned model could ignore). The full breakdown,
including what happens when the agent *tries* to bypass each one, is in
[`architecture.md`](architecture.md). The short version:

- **Storage immutability.** `BEFORE` triggers on `case_artifacts` reject
  any UPDATE that touches evidence content or its hash, and any direct
  DELETE that is not a cascade from the case. A compromised agent
  process has no path to tamper with its own inputs — the database
  refuses.
- **Read-time verification.** Every artifact read goes through
  `loadVerifiedArtifact()`, which re-hashes the bytes and compares to
  the upload-time hash. A mismatch raises a `SPOLIATION` event and halts
  the investigation. The verified hash and a hash of the tool's output
  are written to `execution_logs`, so the chain-of-custody view replays
  exactly what the agent saw.
- **No arbitrary egress.** `fetch_url` does not accept a URL. The model
  supplies an endpoint name and an IOC value; the URL is built
  server-side from a fixed template, the IOC is validated by kind, and
  `mcpFetcher` applies three SSRF layers plus a timeout/size cap.
- **Reasoning provenance.** Every conclusion is an `analysis_steps` row
  with a five-field schema, and the final report commits to a numeric
  confidence (0.00–1.00) and a 5-level severity enum. The agent cannot
  hedge.

### Self-correction

The fourth beat of the cycle is the most important for trustworthiness.
When two pieces of evidence disagree — say, an IOC is flagged locally but
`fetch_url` to public threat-intel returns benign — the agent is
instructed to write a `self_correction` finding rather than pick the
convenient answer. In the bundled PowerShell case, the agent's initial
hypothesis rates the incident high, threat-intel comes back clean for the
C2 IP, and the agent *tempers* its confidence instead of flipping its
conclusion, because the local attack chain (encoded command + WINWORD
parent + Run-key persistence + DLL drop) still stands. The downgrade is
the right answer, and it is visible to the human in the UI.

## Challenges we ran into

- **Making integrity enforced, not advisory.** An application-layer
  immutability check is one stray code path away from being bypassed. We
  moved the guarantee into Postgres `BEFORE` triggers so it holds
  regardless of what the application (or the agent) tries.
- **Stopping the agent from constructing its own URLs.** An early version
  let the model pass a full URL to the fetch tool — a textbook SSRF
  surface. We re-architected `fetch_url` so the model only names an
  endpoint and supplies an IOC, and the server owns URL construction.
- **Binary evidence.** Disk images forced the hashing and IOC paths to
  operate over *decoded* bytes (base64 on the wire, hashed after decode)
  so a stored `sha256Hash` matches what `sha256sum` prints on the
  original file.
- **Homoglyph IOCs.** The Cyrillic-lookalike sender domain in the
  PowerShell case originally truncated in the extractor; the domain regex
  was rewritten with Unicode property classes and a `suspiciousDomains`
  signal for ASCII/non-ASCII label mixing.
- **Schema ergonomics.** The model liked to pass `null` for optional tool
  fields; the Zod schemas were switched to `.nullish()` so those shapes
  flow through instead of costing a recovery iteration.

## What we learned

- **Trust is an architecture problem, not a prompt problem.** The
  controls that actually held under test were the ones the model could
  not route around. Prompt rules shape behavior; they do not guarantee
  it. Naming that distinction explicitly changed how we built every
  feature.
- **Structured reasoning beats freeform "thoughts."** Forcing every
  conclusion into a five-field schema made the agent auditable and made
  the training-mode UI possible — you can count and inspect every
  revision.
- **Reproducibility is a design constraint.** Keeping the tools pure and
  local means a judge can re-run a tool on the same bytes and get
  identical output, which is what a forensic finding requires.

## What's next

- A larger, adversarial benchmark (30+ cases, including planted
  distractors and "this is a false positive / insufficient evidence"
  cases) with a machine-checkable ground-truth schema so the harness can
  self-score instead of relying on human review.
- A dev-mode auth path for the accuracy harness so all seven cases re-run
  unattended (the harness currently sits behind the same auth gate as the
  production API — see [`accuracy-report.md`](accuracy-report.md)).
- Optional human-in-the-loop checkpoints before high-severity finalize.

## Built with

- **Language / runtime:** TypeScript 5.9, Node.js 24
- **AI:** OpenAI **gpt-5.4** via the Replit AI Integrations proxy
- **Backend:** Express 5, Server-Sent Events
- **Database:** PostgreSQL, Drizzle ORM, SQL triggers
- **Validation / contract:** Zod (`zod/v4`), OpenAPI, Orval codegen
- **Frontend:** React, Vite, wouter, TanStack Query
- **Auth:** Replit Auth (OIDC)
- **Tooling / infra:** pnpm workspaces, esbuild, Replit (AI Integrations,
  Auth, Deployments)
- **Forensics:** a self-built, SIFT-style forensic toolkit (log/IOC/
  entropy/timeline/network/PCAP/disk-image analysis) — *not* the SANS
  SIFT Workstation

> Honesty notes for judges: Casefile *does* speak the Model Context
> Protocol — the forensic tools are wrapped by a custom MCP server
> (`lib/sift-mcp`) that the agent calls over an in-process MCP client.
> The separately-named `mcpFetcher` tool and `mcp_endpoint` artifact kind
> are older internal labels unrelated to that MCP layer. The forensic
> suite is original code inspired by SIFT, not the SANS SIFT Workstation
> or "Protocol SIFT".

## What this is not

- Not an EDR or SIEM. It does not collect telemetry — a human collects
  and uploads the evidence.
- Not a replacement for a senior analyst. It is a faster, more patient
  first-pass triage that produces audit-trail artifacts a senior can use.
- It does not write back to production systems. No containment action, no
  firewall rule, no AD lockout. It recommends; a human acts.

## Try it out

See [`../README.md`](../README.md) for setup, the seven sample cases, and
a suggested walkthrough.
