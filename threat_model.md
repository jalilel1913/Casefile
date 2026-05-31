# Threat Model

## Project Overview

Casefile is a forensic case-management and incident-response application. A React/Vite frontend in `artifacts/case-room` lets analysts create cases, upload evidence, launch an autonomous investigation loop, and review structured findings, execution logs, and reports. An Express 5 API in `artifacts/api-server` persists case data in PostgreSQL via Drizzle and calls an OpenAI-backed agent in `lib/sift-agent`, which can invoke local forensic tools from `lib/sift-tools` plus a restricted outbound fetch tool for threat-intel enrichment.

The current deployment is `https://cas3fil3.replit.app` and is `password`-gated at the platform edge. Per scan assumptions, endpoints are not reachable from the general public internet without that outer gate, so the most relevant production risks are authenticated-user isolation failures, legacy-data exposure, and agent/tool boundary failures rather than fully public anonymous attack paths. `artifacts/mockup-sandbox` remains dev-only unless a production path is shown to serve it.

## Assets

- **Case data and uploaded evidence** — case titles/descriptions, uploaded logs, memory strings, packet captures, MCP URLs, and disk images. These often contain credentials, tokens, internal hostnames, or other sensitive incident-response material.
- **Incident reports and analysis steps** — the agent's conclusions, intermediate findings, and training-oriented reasoning records. Exposure or tampering can mislead analysts and leak derived evidence.
- **Execution logs / chain-of-custody records** — tool inputs, hashes, outputs, and failure records. These are sensitive because they can expose both evidence-derived content and the exact sequence of investigative actions.
- **Sessions and identity bindings** — Replit OIDC tokens, server-side sessions, and per-case ownership bindings. Compromise would allow access to private forensic data.
- **Availability and spend budget** — investigations can trigger repeated LLM calls and expensive parsing over large artifacts, creating both DoS and direct cost risk.
- **Application secrets and integrations** — database credentials and Replit-managed OpenAI integration access used by the server-side agent.

## Trust Boundaries

- **Browser to API server** — the browser is untrusted. The server must authenticate callers, authorize access to each case object, validate uploads, and avoid reflecting sensitive evidence to the wrong user.
- **API server to PostgreSQL** — the API has access to the full corpus of case data, reports, and logs. Broken access control at the API layer exposes high-sensitivity customer evidence.
- **API server / investigation loop to OpenAI** — evidence-derived content crosses to an external model provider when an investigation runs. That boundary is intentional but sensitive and should remain tightly scoped.
- **LLM to tool boundary** — untrusted artifact content becomes model context, and the model can choose tools. Tool schemas and dispatch policy must stop prompt-injected evidence from turning into unintended capabilities or data disclosure.
- **Server to external threat-intel services** — `fetch_url` / `mcpFetcher` is the only intended outbound network path. It must prevent SSRF and also prevent evidence exfiltration through overly flexible request construction.
- **Authenticated user to other users' case data** — the key application boundary is tenant isolation between analysts and case owners, including legacy rows created before auth ownership existed.
- **Production vs dev-only artifacts** — `artifacts/mockup-sandbox` is not assumed to ship to production and should be ignored unless production reachability is demonstrated.

## Scan Anchors

- **Production entry points**: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/*`, `artifacts/case-room/src/main.tsx`.
- **Highest-risk areas**: auth/session handling in `artifacts/api-server/src/routes/auth.ts` and `src/lib/auth.ts`; ownership enforcement in `artifacts/api-server/src/lib/case-auth.ts` plus direct-ID routes in `src/routes/artifacts.ts` and `src/routes/steps.ts`; agent/tool dispatch in `lib/sift-agent/src/*`; outbound fetch policy in `lib/sift-tools/src/mcp.ts`.
- **Public-ish surfaces after platform gate**: `/api/health`, login/logout/auth callbacks, and the password-gated web app itself.
- **Authenticated surfaces**: case CRUD, artifact upload/read, execution logs, chain-of-custody, and investigation start/stream endpoints under `/api`.
- **Legacy-risk surfaces**: rows in `cases.owner_user_id IS NULL` created before auth ownership existed; these should be treated as inaccessible unless explicitly migrated.
- **Usually dev-only**: `artifacts/mockup-sandbox/**` unless a production path serves it.

## Threat Categories

### Spoofing

Users authenticate through Replit OIDC and the API loads server-side sessions in `authMiddleware`. The system must require a valid session for every case, artifact, log, and investigation endpoint, and bearer-style mobile sessions must be treated with the same rigor as cookie-backed browser sessions.

### Tampering

Evidence integrity is protected by database triggers and read-time SHA-256 verification, but those controls only matter if untrusted users cannot mutate other users' cases. The server must ensure create, upload, delete, and investigation actions are bound to the authenticated owner, and legacy rows without an owner must not silently fall back to shared access.

### Information Disclosure

Uploaded evidence, execution logs, and reports may contain highly sensitive incident-response data. The system must enforce per-case authorization on every direct-ID route, prevent legacy null-owner records from becoming readable to arbitrary authenticated users, and avoid letting model/tool interactions disclose unrelated evidence to external services beyond the explicitly intended OpenAI and threat-intel boundaries.

### Denial of Service

Investigations can consume model tokens and CPU over large artifacts, while uploads can be sizable. The system must keep authentication and rate limits on expensive routes and maintain payload size limits so a user cannot exhaust storage or model budget through repeated uploads or investigations.

### Elevation of Privilege

There is no distinct admin plane today, so elevation risk centers on broken object-level authorization and agent/tool overreach. The system must ensure that direct artifact and step-log endpoints enforce the same ownership rules as case-scoped routes, and that prompt-injected evidence cannot cause the LLM-controlled tool layer to exercise broader network or disclosure capability than intended.