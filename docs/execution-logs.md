# Casefile — Structured Execution Logs

Casefile produces structured, machine-readable execution logs at two
levels. This document describes both, the event schema, and where to find
the committed recordings so a judge can inspect a real run without
standing the system up.

## Two levels of logging

**1. Durable, hash-bearing records in Postgres (the source of truth).**
Every tool call and every finding is persisted, not just streamed:

- `execution_logs` — one row per tool call, with the tool name, the
  `verified_hash` of the artifact bytes the tool actually read, the
  `output_hash` of what was returned to the model, an `ok` flag, and the
  timing. The logged `input` also records the serving MCP endpoint
  (`mcpEndpoint` — `in-process` or the remote URL) and, for
  artifact-backed tools, the `evidenceMode` (`inline` or `reference`) used
  to pass the verified bytes; remote-only discovered-tool calls are flagged
  `remote: true`. This is what the Case Room's **Chain of Custody** view
  renders, and it is what makes any conclusion replayable.
- `analysis_steps` — one row per finding, with the structured
  `(phase, rationale, expected, found, next_step)` schema written through
  the `record_finding` tool.
- `incident_reports` — the final report row (summary, severity, IOCs,
  TTPs, timeline, recommendations, numeric confidence).

These tables are the trust anchor: because each artifact read is logged
with its hash, the audit trail can show whether any stated finding is
actually backed by an observation (see the bypass discussion in
[`architecture.md`](architecture.md) and
[`accuracy-report.md`](accuracy-report.md)).

**2. The live SSE event stream (the real-time view).** During an
investigation the agent streams events over Server-Sent Events so the UI
can render the reasoning loop as it happens. The accuracy harness
captures that exact stream verbatim to `events.jsonl`, one JSON object
per line.

## Committed sample recordings

Because `.local/` is git-ignored, representative recordings are committed
under [`sample-logs/`](sample-logs/) for the four measured cases:

```
docs/sample-logs/
  ssh-bruteforce-breakthrough.events.jsonl   ssh-bruteforce-breakthrough.summary.json
  powershell-encoded-payload.events.jsonl    powershell-encoded-payload.summary.json
  dns-data-exfiltration.events.jsonl         dns-data-exfiltration.summary.json
  disk-image-carve.events.jsonl              disk-image-carve.summary.json
```

`*.events.jsonl` is the full event stream; `*.summary.json` is the
roll-up (status, stop reason, step/finding/self-correction counts, tool
calls, tool errors, token usage, wall time).

## Event stream schema

Each line in `events.jsonl` is `{"ev": <type>, "data": {...}}`. The
event types, in the order they appear during a run:

| `ev` | Emitted | Key `data` fields |
| --- | --- | --- |
| `started` | once, at the top | `caseId`, `model`, `iterationLimit` |
| `iteration` | start of each loop turn | `iteration` (1-based) |
| `tokens` | after each model call | `promptTokens`, `completionTokens`, `total` (cumulative) |
| `tool_call` | per tool the model invokes | `iteration`, `toolCallId`, `name`, `args` |
| `tool_result` | per tool completion | `toolCallId`, `name`, `ok`, `summary` |
| `finding` | per `record_finding` | `analysisStepId`, `step`, `phase`, `found` (and the rest of the five-field schema) |
| `finalized` | once, when the agent finalises | `reportId` |
| `done` | terminal | `reason` (e.g. `finalized`) |

(An `error` event is emitted if a tool fails; the measured runs have zero
tool errors, so it does not appear in the committed recordings.)

## Reading an iteration trace

A run reads top-to-bottom as a sequence of iterations. The opening of the
SSH recording:

```json
{"ev":"started","data":{"type":"started","caseId":"02cebf70-…","model":"gpt-5.4","iterationLimit":25}}
{"ev":"iteration","data":{"type":"iteration","iteration":1}}
{"ev":"tokens","data":{"type":"tokens","promptTokens":2097,"completionTokens":15,"total":2112}}
{"ev":"tool_call","data":{"type":"tool_call","iteration":1,"toolCallId":"call_…","name":"list_artifacts","args":{}}}
{"ev":"tool_result","data":{"type":"tool_result","toolCallId":"call_…","name":"list_artifacts","ok":true,"summary":"ok"}}
{"ev":"iteration","data":{"type":"iteration","iteration":2}}
```

The agent opens every case the same way — `list_artifacts` to see what it
has — then fans out into `parse_log`, `extract_iocs`, `build_timeline`,
`fetch_url`, etc., interleaving `record_finding` calls as it forms
conclusions, and ends with `finalize` → `finalized` → `done`. A `finding`
event carries the `execution_log_id` of the tool call it is based on, so
each conclusion points back at the hash-verified observation that
supports it:

```json
{"ev":"finding","data":{"type":"finding","analysisStepId":"…","step":1,"phase":"triage","found":"analyze_disk_image on artifact 9a508ece-… (execution_log_id e8921ca9-…) reported a 4096-byte image …"}}
```

## Token usage

`tokens` events are cumulative, so the last one in a run is the total. For
the four measured cases:

| Case | Total tokens | Tool calls | Wall time |
| --- | --- | --- | --- |
| SSH Brute Force → Breach | 41,937 | 9 | 35.9 s |
| Encoded PowerShell | 41,544 | 11 | 55.9 s |
| DNS Data Exfiltration | 25,267 | 11 | 32.2 s |
| Disk Image Carve | 29,894 | 11 | 30.9 s |

## Honesty note: `fetch_url` interface drift in the recordings

The committed recordings were captured before the `fetch_url` tool was
hardened. In them you will see a `tool_call` like:

```json
{"name":"fetch_url","args":{"url":"https://ipinfo.io/91.219.236.142/json","method":"GET","headers":null,"body":null}}
```

— i.e. the model passing a full `url`. The **current** tool surface
(`lib/sift-agent/src/tool-adapter.ts`) no longer accepts a raw URL: the
model supplies an *endpoint name* plus an *IOC value*, and the URL is
built server-side from a fixed template with IOC-kind validation (see
[`architecture.md`](architecture.md)). The recordings are kept as-is
rather than rewritten, so the event shape for `fetch_url` args reflects
the older interface; every other event type is unchanged.

## Reproducing

Run a case end-to-end and write fresh logs under
`.local/accuracy/runs/<id>/`:

```sh
node .local/accuracy/run-one.mjs ssh-bruteforce-breakthrough
```

Note: the harness authenticates against the same gate as the production
API. See [`accuracy-report.md`](accuracy-report.md) for the current state
of unattended reproduction.
