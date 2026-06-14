import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { err, ok, type ToolResult } from "@workspace/sift-tools";
import { buildSiftMcpServer } from "./server.js";

/**
 * A single in-process MCP client linked to the sift-tools MCP server over an
 * in-memory transport. This is a genuine MCP client/server pair speaking the
 * real protocol (JSON-RPC), with no subprocess to manage — every tool the
 * agent runs is dispatched as an MCP `tools/call` request.
 */
let clientPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const server = buildSiftMcpServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({
        name: "casefile-agent",
        version: "0.1.0",
      });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    })();
  }
  return clientPromise;
}

function normalizeArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v instanceof Set ? Array.from(v) : v;
  }
  return out;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("");
}

/**
 * Invoke a sift-tool by name through the in-process MCP client. Returns the
 * same `ToolResult` envelope as a direct `invokeTool` call so callers in the
 * agent layer do not need to know they are crossing an MCP boundary.
 */
export async function callSiftTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult<unknown>> {
  const client = await getClient();
  let res;
  try {
    res = await client.callTool({
      name,
      arguments: normalizeArgs(input),
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  const text = extractText(res.content);
  if (res.isError) {
    return err(text || `MCP tool '${name}' returned an error`);
  }
  if (!text) return ok(null);
  try {
    return ok(JSON.parse(text));
  } catch {
    return ok(text);
  }
}
