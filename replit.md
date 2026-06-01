# Casefile — Analyst Training Loop

## Overview

Casefile is a fully autonomous incident response agent that processes forensic case data
(logs, network captures, memory strings, MCP endpoints) and explains its reasoning at every
step. Designed to train junior analysts by making the senior-analyst decision-making process
transparent — what tool was chosen, why, what was expected, what was actually found, and how
the investigation pivots when findings don't add up.

License: MIT.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **AI engine**: OpenAI gpt-5.4 via Replit AI Integrations proxy
  (no API key required; client at `lib/integrations-openai-ai-server`)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Build Progress

- [x] Step 1 — MIT license + OpenAI AI integration setup
- [x] Step 2 — Database schema (cases, artifacts, analysis steps, exec logs, reports)
- [x] Step 3 — OpenAPI spec + codegen + 11 REST endpoints
- [x] Step 4 — Forensic tool suite (log parser, IOC extractor, timeline, network, entropy, MCP)
- [x] Step 5 — Evidence integrity enforcement (architectural read-only boundary)
- [x] Step 6 — Autonomous agent reasoning loop (streaming SSE)
- [x] Step 7 — React frontend case room interface
- [x] Step 8 — Streaming polish + bundled sample dataset
- [x] Step 9 — Structured reasoning cards + training-mode toggle + execution-log viewer

## Hackathon Timeline

Deadline: ~49 days from April 27, 2026 (≈ June 15, 2026).
Cadence: teaching-paced, 4–5 build days per week. Buffer of ~17–21 days built in.

| Week | Dates (approx) | Focus |
|------|----------------|-------|
| 1 | Apr 27 – May 3 | Steps 2 & 3 — DB schema + OpenAPI spec/endpoints |
| 2 | May 4 – May 10 | Step 4 part 1 — log parser, IOC extractor, timeline builder |
| 3 | May 11 – May 17 | Step 4 part 2 + Step 5 — network/entropy/MCP tools, then integrity guard |
| 4 | May 18 – May 24 | Step 6 — autonomous agent reasoning loop with SSE streaming |
| 5 | May 25 – May 31 | Step 7 — React "case room" frontend + start rough demo takes |
| 6 | Jun 1 – Jun 7 | Step 8 — sample dataset, accuracy run, polish |
| 7 | Jun 8 – Jun 14 | Demo video, architecture diagram, written description, try-it-out instructions. **Code freeze 48h before deadline.** |

### Discipline rules

1. **No scope creep.** New ideas go in `ideas-for-v2.md`, not into the build plan.
2. **Demo work starts Week 5**, not the last week. Polished demo = judging weight.
3. **Code freeze 48h before submission.** Final 2 days are docs, video, and dry runs only.

## Hackathon Deliverables Checklist

- [x] (1) MIT-licensed code repo
- [ ] (2) Demo video
- [x] (3) Architecture diagram — `docs/architecture.md` (Mermaid) + uploadable `docs/architecture-diagram.svg`
- [x] (4) Written description — `docs/description.md` (Devpost format + Built-With)
- [x] (5) Dataset documentation — `docs/dataset.md` (all seven sample cases)
- [x] (6) Accuracy report — `docs/accuracy-report.md` (4 cases measured w/ recorded runs, 3 documented; harness now auth-gated)
- [x] (7) Try-it-out instructions — `README.md`
- [x] (8) Structured execution logs — `docs/execution-logs.md` + recorded runs in `docs/sample-logs/`

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
