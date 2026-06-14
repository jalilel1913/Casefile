---
name: MCP tool layer & trust boundary
description: How Casefile's forensic tools are reached over MCP and where the integrity boundary sits.
---

## Architecture
The agent does not call sift-tools directly. `lib/sift-mcp` (@workspace/sift-mcp,
official @modelcontextprotocol/sdk) registers every sift-tools `TOOL_REGISTRY`
entry as a typed MCP tool. The agent (`lib/sift-agent/src/tool-runner.ts`) executes
each forensic tool via `callSiftTool` (in-process MCP Client over `InMemoryTransport`).
A stdio entrypoint (`lib/sift-mcp/src/stdio.ts`) exposes the same surface to external
MCP clients. Maps to the hackathon "Custom MCP Server" pattern.

## Decision: integrity enforcement stays agent-side, before the MCP call
`loadVerifiedArtifact` (hash re-verification) and `execution_logs` writes remain in
the agent layer; the MCP server only runs the pure tool. Do NOT move integrity checks
behind the MCP boundary.
**Why:** the MCP server is a generic, reusable tool surface (also reachable over
stdio by other clients); evidence provenance is Casefile-specific and must hold
regardless of which client calls the tools. Keeping verification agent-side preserves
the "what bytes did the agent actually reason over" audit guarantee.
**How to apply:** any new evidence-bound tool path must verify + log in tool-runner,
then call the tool over MCP — never expect the MCP server to enforce provenance.

## Constraint: MCP tool input schemas must be ZodObject
`server.ts` extracts `.shape` from each tool's `inputSchema` to build the MCP input
schema, so every sift-tool input must stay a `ZodObject`. Non-object schemas would
break MCP registration.

## Constraint: Set fields cannot cross the MCP (JSON-RPC) boundary
`mcpFetcher.allowedHosts` is a `Set<string>` in sift-tools. The client normalizes
Set->array before the call and the server reconstructs array->Set before `invokeTool`.
Any future Set/Map-typed tool field needs the same normalize/reconstruct treatment.
