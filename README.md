# Casefile — Autonomous Incident-Response Agent

Casefile is a fully autonomous incident-response agent. A human uploads
evidence (logs, network/packet captures, disk images, suspicious files)
into a case folder and Casefile investigates end-to-end: forms
hypotheses, runs forensic tools to test them, records its reasoning as it
goes, and produces a final incident report with severity, IOCs, a
chronological timeline, recommendations, a numeric confidence score, and
a verifiable chain of custody.

It runs on **OpenAI gpt-5.4** and a self-built, SIFT-style forensic
toolkit, in a single-agent **Direct Agent Extension** pattern: one agent
driven directly on the model's native tool-calling in a persistent
reasoning loop. (It is *not* the SANS SIFT Workstation, and despite the
`mcpFetcher` / `mcp_endpoint` names it does *not* use the Model Context
Protocol — those are internal labels.)

**License:** MIT — see [`LICENSE`](LICENSE).

## Documentation

- [`docs/description.md`](docs/description.md) — Devpost-style write-up:
  inspiration, what it does, how it was built, challenges, lessons,
  what's next, and the Built-With list.
- [`docs/architecture.md`](docs/architecture.md) — architectural pattern,
  request path, the prompt-based vs. architectural guardrail model
  (including what happens when the agent tries to bypass them), the
  three-layer integrity model, and file:function landmarks. Standalone
  diagram: [`docs/architecture-diagram.svg`](docs/architecture-diagram.svg).
- [`docs/dataset.md`](docs/dataset.md) — the seven bundled sample cases:
  scenarios, evidence, ground truth, expected behavior.
- [`docs/accuracy-report.md`](docs/accuracy-report.md) — end-to-end
  results: four cases measured with recorded runs (0 tool errors, all
  finalised), three further cases documented against ground truth and
  pending an unattended harness auth path.
- [`docs/execution-logs.md`](docs/execution-logs.md) — the structured
  execution-log model (Postgres records + SSE event stream), the event
  schema, and committed sample recordings in
  [`docs/sample-logs/`](docs/sample-logs/).

## Quick start (Replit — recommended)

This repo is a Replit project. If you opened it in Replit:

1. Click **Run** (or the green play button). This starts the workflows
   defined under `artifacts/*/.replit-artifact/artifact.toml`: the API
   server, the Case Room web UI, and an internal mockup sandbox.
2. Open the Case Room preview pane (sign in with Replit Auth when
   prompted).
3. Click **Load sample** and pick any of the seven cases (e.g. **SSH
   Brute Force → Breach**).
4. Click **Start investigation**. The investigation streams live: each
   tool call, each finding, each phase change.
5. When the agent calls `finalize`, the incident report renders below the
   live timeline. Open the **Chain of Custody** tab to see every
   `execution_logs` row with verified hashes.

The Replit container already has:
- Postgres provisioned and `DATABASE_URL` set.
- The OpenAI integration wired through Replit's proxy
  (`AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`
  injected automatically; no key on your part).
- `PORT` and `BASE_PATH` injected per artifact.

If something is broken on first run, see **Troubleshooting** below.

> **Published deployment.** The deployment target is Replit Autoscale.
> When a hosted instance is published it is password-gated at the
> platform edge, so the canonical live URL (if one is provided for
> judging) is listed on the submission page rather than hard-coded here.
> The Replit "Run" flow above and the local setup below are the primary,
> always-available ways to exercise the app.

## Quick start (local machine)

Prerequisites: Node 24+, pnpm 9+, Postgres 16+. Note: the OpenAI client
in `lib/integrations-openai-ai-server` is wired to the Replit AI
Integrations proxy. To run fully off-Replit you either need access to
that proxy (set both `AI_INTEGRATIONS_OPENAI_*` vars below) or swap the
client for a stock `openai` instance pointed at `api.openai.com`.

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
generated client. The simplest off-Replit setup is to put both behind a
reverse proxy that serves the UI and the `/api/*` routes from the same
origin.

## A 5-minute guided walkthrough

The fastest way to see what Casefile does:

1. Load the **Encoded PowerShell** sample case. (`docs/dataset.md`
   describes the scenario.)
2. Start the investigation. Watch the live stream:
   - **Triage** — the agent calls `list_artifacts`, then `parse_log` on
     the Sysmon log.
   - **Deep analysis** — `extract_iocs` captures the Cyrillic homoglyph
     sender domain via the `suspiciousDomains` field; `fetch_url`
     enriches the C2 IP against public threat-intel.
   - **Self-correction** — threat-intel returns benign for the IP, but
     the local forensic evidence (encoded PowerShell + WINWORD parent +
     Run-key persistence + DLL drop) still implies compromise. The agent
     *tempers* its confidence rather than flipping its conclusion.
   - **Finalize** — severity = medium, tempered confidence.
3. Open the **Chain of Custody** tab. Every tool call is there with the
   verified SHA-256 of the artifact bytes it actually read.
4. For contrast, try **Ransomware In Progress** (the agent commits to
   **critical** + immediate containment) and **Insider Data Theft**
   (where the correct answer is an evidence-bounded judgment, not an
   external compromise).

## Reproducing the accuracy report

The accuracy harness runs each bundled case through the production REST +
SSE path and writes per-case artifacts under
`.local/accuracy/runs/<id>/`.

```sh
# Run one case
node .local/accuracy/run-one.mjs ssh-bruteforce-breakthrough

# Or run all cases serially
node .local/accuracy/run.mjs
```

Each run produces `summary.json` (status, tool counts, token usage, wall
time), `events.jsonl` (the full SSE stream), `detail.json` (the persisted
DB state), and `report.md` (a rendered incident report). Committed copies
of four recorded runs live in [`docs/sample-logs/`](docs/sample-logs/).

> The harness authenticates against the same gate as the production API.
> See [`docs/accuracy-report.md`](docs/accuracy-report.md) for which
> cases currently have recorded runs and what is needed to make the rest
> reproduce unattended.

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
  sift-tools/        Eight forensic tools (pure; only mcpFetcher touches the network)
  sift-agent/        Reasoning loop, OpenAI tool-call adapter, system prompt

docs/                Architecture, description, dataset, accuracy report, execution logs, sample logs
.local/accuracy/     Reproducible accuracy harness + per-run output (git-ignored)
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

**The UI loads but "Start investigation" hangs.** The API server is not
reachable. Check the `api-server` workflow log; if the process exited,
the most common cause is a missing `DATABASE_URL`. On Replit this is
provisioned automatically — restart the workflow.

**`drizzle-kit push` fails with a connection error.** Postgres isn't
running or `DATABASE_URL` isn't set. On Replit, open the Database tab and
confirm the database is provisioned.

**A request returns 401.** The API is gated by Replit Auth. Sign in
through the Case Room UI; for scripted access the accuracy harness must
present a valid session (see `docs/accuracy-report.md`).

**`fetch_url` returns "SSRF protection".** Working as designed —
`mcpFetcher` refuses private, loopback, link-local, CGNAT, multicast,
decimal-encoded, and hex-encoded hosts, and refuses any name that
resolves to one of those. The agent reaches it only through fixed
server-side URL templates, so it cannot point it at an arbitrary URL.

**Codegen produces a diff I don't want.** The OpenAPI spec
(`lib/api-spec/openapi.yaml`) is the source of truth — `api-zod` and
`api-client-react` are *generated*. Edit the spec and re-run
`pnpm --filter @workspace/api-spec run codegen`.
