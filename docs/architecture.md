# Casefile — Architecture

Casefile is an autonomous incident-response agent. A human uploads
evidence (logs, network captures, suspicious files) into a case folder
and the system investigates end-to-end: forms hypotheses, runs forensic
tools, records findings as it goes, and produces a final incident report
with a verifiable chain of custody.

This document is the architecture map a judge or new contributor should
read first. It covers the request path, the evidence-integrity model,
and the file:function landmarks for every meaningful step.

## System overview

```mermaid
flowchart TB
    subgraph Browser["Browser"]
        UI["Case Room (React + Vite)<br/>artifacts/case-room"]
    end

    subgraph Server["Replit container"]
        API["API Server (Fastify)<br/>artifacts/api-server"]
        Agent["Casefile Agent (reasoning loop)<br/>lib/sift-agent"]
        Tools["Forensic tools (pure functions)<br/>lib/sift-tools"]
        DB[("Postgres<br/>lib/db<br/>+ integrity triggers")]
    end

    LLM["OpenAI GPT-5<br/>(via Replit AI proxy)"]
    Intel["Public threat-intel<br/>(AlienVault OTX, ipinfo.io, …)"]

    UI -- "REST: create case,<br/>upload artifacts" --> API
    UI -- "SSE: live investigation stream" --> API
    API -- "runInvestigation()" --> Agent
    Agent -- "chat.completions.create<br/>(with tool definitions)" --> LLM
    LLM -- "tool_calls" --> Agent
    Agent -- "dispatchToolCall()" --> Tools
    Tools -- "mcpFetcher only<br/>(SSRF-gated)" --> Intel
    Agent <-- "verified artifact reads<br/>+ execution_logs writes<br/>+ analysis_steps writes<br/>+ incident_reports writes" --> DB
    API <-- "case + report reads" --> DB
```

## Request path: `POST /api/cases/:id/investigate`

This is the single hot path the agent exercises during a case. Every
file and function below is the actual landing place, not a sketch.

```mermaid
sequenceDiagram
    participant U as Browser
    participant A as API Server<br/>(investigate.ts)
    participant G as Agent loop<br/>(agent.ts)
    participant D as Tool dispatch<br/>(tool-adapter.ts)
    participant R as Tool runner<br/>(tool-runner.ts)
    participant T as Forensic tool<br/>(sift-tools)
    participant DB as Postgres<br/>(integrity triggers)
    participant L as OpenAI GPT-5

    U->>A: POST /investigate (open SSE)
    A->>G: runInvestigation({ caseId })
    loop until finalize / max-iter
        G->>L: chat.completions.create(messages, tools)
        L-->>G: assistant message + tool_calls[]
        G-->>A: stream "thought", "tool_call" events
        A-->>U: SSE: event:tool_call

        alt artifact-bound tool (parse_log, extract_iocs, scan_entropy)
            G->>D: dispatchToolCall
            D->>R: runToolOnArtifact(caseId, artifactId, toolName)
            R->>DB: loadVerifiedArtifact(artifactId)
            Note over R,DB: re-hashes content,<br/>compares to stored sha256
            R->>T: invokeTool(input)
            T-->>R: structured output
            R->>DB: INSERT execution_logs<br/>(verified_hash, output_hash, ok)
        else structured tool (build_timeline, analyze_network, fetch_url)
            G->>D: dispatchToolCall
            D->>R: runTool(caseId, toolName, input)
            R->>T: invokeTool(input)
            T-->>R: structured output
            R->>DB: INSERT execution_logs
        else record_finding
            G->>D: dispatchRecordFinding
            D->>DB: INSERT analysis_steps<br/>(phase, rationale, expected, found, next_step)
        else finalize
            G->>D: dispatchFinalize
            D->>DB: UPSERT incident_reports<br/>(summary, severity, iocs, ttps,<br/>timeline, recommendations, confidence)
        end

        G-->>A: stream "tool_result" / "finding" / "finalized"
        A-->>U: SSE event
    end

    A-->>U: SSE event:done
```

### File:function landmarks

| Step | File | Function |
| --- | --- | --- |
| HTTP entry + SSE writer | `artifacts/api-server/src/routes/investigate.ts` | `router.post("/cases/:caseId/investigate")` |
| Agent loop driver | `lib/sift-agent/src/agent.ts` | `runInvestigation` |
| LLM tool-call dispatch | `lib/sift-agent/src/tool-adapter.ts` | `dispatchToolCall` |
| Artifact tool wrapper | `lib/sift-agent/src/tool-runner.ts` | `runToolOnArtifact` |
| Structured tool wrapper | `lib/sift-agent/src/tool-runner.ts` | `runTool` |
| Forensic tool table | `lib/sift-tools/src/index.ts` | `invokeTool` |
| Hash re-verification | `lib/db/src/integrity.ts` | `loadVerifiedArtifact` |
| Finding write | `lib/sift-agent/src/tool-adapter.ts` | `dispatchRecordFinding` |
| Final report write | `lib/sift-agent/src/tool-adapter.ts` | `dispatchFinalize` |
| Immutability triggers | `lib/db/src/triggers.sql` | `sift_reject_artifact_mutation` |

## Evidence-integrity model

The brief asks for an agent whose conclusions can be trusted. Casefile
treats that as three concentric layers, all enforced — not advisory.

```mermaid
flowchart LR
    subgraph L1["Layer 1 — storage immutability<br/>(Postgres triggers)"]
        T1["sift_artifact_immutable<br/>(BEFORE UPDATE)"]
        T2["sift_artifact_no_direct_delete<br/>(BEFORE DELETE)"]
    end

    subgraph L2["Layer 2 — read-time verification<br/>(per tool call)"]
        H1["loadVerifiedArtifact()<br/>re-hashes on every read"]
        H2["execution_logs.verified_hash<br/>(what we actually saw)"]
        H3["execution_logs.output_hash<br/>(what we returned to the LLM)"]
    end

    subgraph L3["Layer 3 — reasoning provenance<br/>(per finding)"]
        S1["analysis_steps row per finding<br/>(phase, rationale, expected, found)"]
        S2["incident_reports.confidence + severity<br/>(agent must commit a number)"]
    end

    Upload["POST /artifacts<br/>SHA-256 at write"] --> L1
    L1 --> L2
    L2 --> L3
    L3 --> Report["Final report shown to user<br/>+ chain-of-custody view"]
```

**Layer 1 — Storage immutability.** Two `BEFORE` triggers on
`case_artifacts` (see `lib/db/src/triggers.sql`) reject any `UPDATE`
that touches evidence content or its stored hash, and reject any
direct `DELETE` that is not a cascade from `cases`. The agent cannot
tamper with the input it is reasoning about, even if the LLM tries to.

**Layer 2 — Read-time verification.** `loadVerifiedArtifact` re-hashes
the artifact bytes on every read and aborts the investigation with a
`SPOLIATION` event if the stored and recomputed hashes disagree. The
verified hash, and a hash of the tool's output, are both persisted to
`execution_logs` — so the chain-of-custody view can replay exactly what
the agent saw.

**Layer 3 — Reasoning provenance.** Every meaningful conclusion is
written as an `analysis_steps` row through the `record_finding` tool,
with a structured (phase, rationale, expected, found, next_step)
schema. The final `incident_reports` row commits to a numeric
confidence and a 5-level severity enum, so the agent cannot hedge its
way out of being judged.

## Forensic tool catalog

All tools live in `lib/sift-tools/src/` and follow the same
`ToolDescriptor<Input, Output>` shape: a Zod input schema, a Zod output
schema, and a pure `run()` function. Only `mcpFetcher` touches the
network; everything else is pure-local.

| Tool | Purpose | Network? |
| --- | --- | --- |
| `logParser` | Parses syslog / auth.log / generic event lines into structured rows | no |
| `iocExtractor` | Sweeps text for IPs, domains (incl. IDN/homoglyph), URLs, emails, hashes, CVEs, file paths | no |
| `entropyScanner` | Shannon entropy of an artifact — flags encrypted/packed payloads | no |
| `timelineBuilder` | Sorts events chronologically, detects bursts and gaps | no |
| `networkAnalyzer` | Summarises a connection list, flags suspicious ports / unique IPs | no |
| `mcpFetcher` | Fetches a public HTTP(S) URL for threat-intel enrichment | **yes** |

`mcpFetcher` is defended against SSRF at three levels: literal host
checks (blocks loopback / RFC1918 / link-local / ULA, including
decimal-encoded and hex-encoded IPv4 and IPv6 loopback/ULA forms), DNS
resolution checks (refuses any name that resolves to a private /
loopback / CGNAT / multicast address), and a 10s timeout plus
~500 KB response cap.

## Package layout

```
artifacts/
  api-server/        Fastify HTTP + SSE entry point (REST contract in lib/api-spec)
  case-room/         React + Vite UI — live investigation timeline, evidence locker,
                     chain-of-custody view, IR report renderer
  mockup-sandbox/    Internal-only design preview environment (not shipped)

lib/
  api-spec/          OpenAPI source of truth (openapi.yaml) + orval codegen
  api-zod/           Generated Zod request/response schemas (do not hand-edit)
  api-client-react/  Generated React Query hooks for the frontend
  db/                Drizzle schema, integrity triggers, hash-verification helpers
  sift-tools/        The forensic-tool catalog (pure, no DB, no network except mcpFetcher)
  sift-agent/        The reasoning loop, OpenAI tool-call adapter, system prompt
```

The agent depends on `sift-tools` and `db`. The API server depends on
the agent and `db`. The UI depends on `api-client-react` and
`api-zod`. There are no cycles.

## Why this shape

- **Tools are pure and local.** A forensic finding has to be
  reproducible. Putting the tools in their own package with no DB and
  no network (except the one explicitly-network tool) means an
  evaluator can re-run `invokeTool` on the same bytes and get the same
  output, byte for byte.
- **Integrity lives in the database, not the application.** An
  application-layer immutability check can be bypassed by any
  contributor who writes a new code path. A trigger cannot.
- **The agent's reasoning is a first-class table.** `analysis_steps` is
  not a log — it is the chain of thought, structured. The UI renders
  it directly, and the accuracy report
  (`docs/accuracy-report.md`) scores against it.
- **One network tool, three SSRF layers.** Threat-intel enrichment is
  table-stakes for an IR agent, but it is also the single biggest
  blast radius. Concentrating all egress into one Zod-validated,
  SSRF-hardened function keeps the audit surface tiny.
