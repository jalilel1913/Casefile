# Protocol SIFT — Autonomous Incident-Response Agent

Protocol SIFT is a fully autonomous incident-response agent. A human
uploads evidence (logs, network captures, suspicious files) into a
case folder and SIFT investigates end-to-end: forms hypotheses, runs
forensic tools to test them, records its reasoning as it goes, and
produces a final incident report with severity, IOCs, a chronological
timeline, recommendations, a numeric confidence score, and a
verifiable chain of custody.

**License:** MIT — see [`LICENSE`](LICENSE).

## Documentation

- [`docs/description.md`](docs/description.md) — prose overview: what
  it is, what it solves, who it's for, what's novel.
- [`docs/architecture.md`](docs/architecture.md) — system diagrams,
  request-path sequence, three-layer integrity model, file:function
  landmarks.
- [`docs/dataset.md`](docs/dataset.md) — three bundled sample cases:
  scenarios, evidence, ground truth, expected behavior.
- [`docs/accuracy-report.md`](docs/accuracy-report.md) — end-to-end
  accuracy results on the bundled dataset (3/3 cases finalise, 0 tool
  errors, severities high/medium/high).

## Quick start (Replit — recommended)

This repo is a Replit project. If you opened it in Replit:

1. Click **Run** (or the green play button at the top). This starts
   three workflows defined in `artifacts/*/.replit-artifact/artifact.toml`:
   the API server, the Case Room web UI, and an internal mockup
   sandbox.
2. Open the Case Room preview pane that appears.
3. Click **Load sample → SSH Brute Force → Breach** (or one of the
   other two).
4. Click **Start investigation**. The investigation streams live: each
   tool call, each finding, each phase change.
5. When the agent calls `finalize`, the incident report renders below
   the live timeline. Open the **Chain of Custody** tab to see every
   `execution_logs` row with verified hashes.

The Replit container already has:
- Postgres provisioned and `DATABASE_URL` set.
- The OpenAI integration wired through Replit's proxy
  (`AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`
  injected automatically; no key on your part).
- `PORT` and `BASE_PATH` injected per artifact.

If something is broken on first run, see **Troubleshooting** below.

## Quick start (local machine)

Prerequisites: Node 24+, pnpm 9+, Postgres 16+. Note: the OpenAI
client in `lib/integrations-openai-ai-server` is hard-wired to the
Replit AI Integrations proxy. To run fully off-Replit you either need
access to that proxy (set both `AI_INTEGRATIONS_OPENAI_*` vars below)
or swap the client for a stock `openai` instance pointed at
`api.openai.com`.

```sh
# 1. Install dependencies
pnpm install

# 2. Set env vars in your shell (or a tool like direnv)
#    Required:
export DATABASE_URL=postgres://user:pass@localhost:5432/sift
export PORT=8080
export AI_INTEGRATIONS_OPENAI_BASE_URL=https://...   # Replit AI proxy URL
export AI_INTEGRATIONS_OPENAI_API_KEY=...            # Replit AI proxy key
#    Optional:
export LOG_LEVEL=info

# 3. Apply DB schema (creates tables; integrity triggers are installed
#    at API-server startup, not by this command)
pnpm --filter @workspace/db run push

# 4. Start the API server (uses $PORT)
pnpm --filter @workspace/api-server run dev

# 5. In a second terminal, start the Case Room UI.
#    It also requires PORT and BASE_PATH:
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/case-room run dev
```

The API server listens on `http://localhost:$PORT`. The Case Room UI
listens on its own `$PORT` and talks to the API server using its
generated client; in dev there is no Vite proxy, so the API server's
base URL is wired through `BASE_PATH` / build-time config. The
simplest off-Replit setup is to put both behind a reverse proxy that
serves the UI and the `/api/*` routes from the same origin.

## A 5-minute guided walkthrough

The fastest way to see what SIFT does:

1. Load the **Encoded PowerShell** sample case. (`docs/dataset.md`
   describes the scenario.)
2. Start the investigation. Watch the live stream:
   - **Triage phase** — the agent calls `list_artifacts`, then
     `parse_log` on the Sysmon log.
   - **Deep analysis** — `extract_iocs` captures the Cyrillic
     homoglyph sender domain in the `suspiciousDomains` field;
     `fetch_url` enriches the C2 IP against public threat-intel.
   - **Self-correction** — threat-intel returns benign for the IP, but
     the local forensic evidence (encoded PowerShell + WINWORD parent
     + Run-key persistence + DLL drop) still implies compromise. The
     agent records a `self_correction` finding and *tempers* its
     confidence rather than flipping its conclusion.
   - **Finalize** — severity = medium, confidence ≈ 0.7.
3. Open the **Chain of Custody** tab. Every tool call is there with
   the verified SHA-256 of the artifact bytes it actually read. You
   can re-derive any conclusion from the persisted record.
4. Repeat with the **DNS Data Exfiltration** sample for a different
   shape (high-volume pattern recognition + newly-registered domain).

## Reproducing the accuracy report

The accuracy harness runs each bundled case through the production
REST + SSE path and writes per-case artifacts under
`.local/accuracy/runs/<id>/`.

```sh
# Run one case
node .local/accuracy/run-one.mjs ssh-bruteforce-breakthrough
node .local/accuracy/run-one.mjs powershell-encoded-payload
node .local/accuracy/run-one.mjs dns-data-exfiltration

# Or run all three serially
node .local/accuracy/run.mjs
```

Each run produces `summary.json` (status, tool counts, token usage,
wall time, confidence), `events.jsonl` (the full SSE stream),
`detail.json` (the persisted DB state), and `report.md` (a rendered
incident report). See [`docs/accuracy-report.md`](docs/accuracy-report.md)
for the scoring rubric and current numbers.

## Project layout

```
artifacts/
  api-server/        Express 5 HTTP + SSE entry point
  case-room/         React + Vite UI (live investigation, evidence, chain-of-custody, IR report)
  mockup-sandbox/    Internal design preview (not shipped)

lib/
  api-spec/          OpenAPI source of truth + orval codegen
  api-zod/           Generated Zod request/response schemas
  api-client-react/  Generated React Query hooks
  db/                Drizzle schema, integrity triggers, hash verification
  sift-tools/        Six forensic tools (pure; only mcpFetcher touches the network)
  sift-agent/        Reasoning loop, OpenAI tool-call adapter, system prompt

docs/                Architecture, description, dataset, accuracy report
.local/accuracy/     Reproducible accuracy harness + per-run output
```

## Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm run typecheck` | Full typecheck across all packages |
| `pnpm run build` | Typecheck + build all packages |
| `pnpm --filter @workspace/db run push` | Push DB schema changes (dev only) |
| `pnpm --filter @workspace/api-spec run codegen` | Regenerate `api-zod` + `api-client-react` from `openapi.yaml` |
| `pnpm --filter @workspace/api-server run dev` | Run API server locally |
| `pnpm --filter @workspace/case-room run dev` | Run Case Room UI locally |
| `node .local/accuracy/run-one.mjs <id>` | Run one accuracy case |

## Troubleshooting

**The UI loads but "Start investigation" hangs.** The API server is
not reachable. Check the `api-server` workflow log; if the process
exited, the most common cause is a missing `DATABASE_URL`. On Replit
this is provisioned automatically — restart the workflow.

**`drizzle-kit push` fails with a connection error.** Postgres isn't
running or `DATABASE_URL` isn't set. On Replit, open the Database tab
and confirm the database is provisioned.

**The agent times out or hits `max_iterations`.** Usually a tool error
loop. Open the case's Chain of Custody view; any tool with `ok=false`
shows the error message. The accuracy report (`docs/accuracy-report.md`)
documents the four issues that have been fixed and the verification
that the suite re-runs clean.

**`fetch_url` returns "SSRF protection".** Working as designed —
`mcpFetcher` refuses private, loopback, link-local, CGNAT, multicast,
decimal-encoded, and hex-encoded hosts, and refuses any name that
resolves to one of those. Point it at a public IP literal or a
hostname that resolves to a public IP.

**Codegen produces a diff I don't want.** The OpenAPI spec
(`lib/api-spec/openapi.yaml`) is the source of truth — `api-zod` and
`api-client-react` are *generated*. Edit the spec and re-run
`pnpm --filter @workspace/api-spec run codegen`.
