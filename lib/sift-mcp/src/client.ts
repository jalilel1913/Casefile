import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { err, ok, type ToolResult } from "@workspace/sift-tools";
import { buildSiftMcpServer } from "./server.js";

/**
 * The sift-tools MCP client operates in one of two modes:
 *
 *  - **in-process** (default): a real MCP client/server pair linked over an
 *    in-memory transport. The forensic tools run inside this Node process.
 *
 *  - **remote**: when `SIFT_MCP_URL` is set, the client connects over the MCP
 *    Streamable-HTTP transport to a SIFT MCP server running elsewhere — e.g. a
 *    self-hosted SANS SIFT Workstation VM wrapping real DFIR tooling. An
 *    optional `SIFT_MCP_TOKEN` is sent as a bearer token.
 *
 * Either way the agent calls `callSiftTool` and gets back the same `ToolResult`
 * envelope; the transport boundary is invisible to the caller. The
 * evidence-integrity guarantees (hash verification + execution-log writes) live
 * one layer up in the agent's tool-runner and apply identically in both modes.
 */
function remoteUrl(): string | null {
  const u = process.env.SIFT_MCP_URL?.trim();
  return u ? u : null;
}

function remoteToken(): string | null {
  const t = process.env.SIFT_MCP_TOKEN?.trim();
  return t ? t : null;
}

/** True when the agent is configured to reach a remote SIFT MCP server. */
export function isRemoteMcp(): boolean {
  return remoteUrl() !== null;
}

/**
 * A short label for the active MCP endpoint, recorded in execution_logs so the
 * chain of custody shows whether a tool ran in-process or against a remote
 * Workstation. Returns the remote host (never the token) or "in-process".
 */
export function getActiveMcpEndpoint(): string {
  const u = remoteUrl();
  if (!u) return "in-process";
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

let clientPromise: Promise<Client> | null = null;

async function buildInProcessClient(): Promise<Client> {
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
}

async function buildRemoteClient(url: string): Promise<Client> {
  const token = remoteToken();
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
  });
  const client = new Client({
    name: "casefile-agent",
    version: "0.1.0",
  });
  await client.connect(transport);
  return client;
}

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    const url = remoteUrl();
    const build = url ? buildRemoteClient(url) : buildInProcessClient();
    // Do not poison the singleton on a transient remote-connect failure: clear
    // it so the next call retries instead of replaying a rejected promise.
    clientPromise = build.catch((e) => {
      clientPromise = null;
      throw e;
    });
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
 * Invoke a sift-tool by name through the active MCP client (in-process or
 * remote). Returns the same `ToolResult` envelope as a direct `invokeTool`
 * call so callers in the agent layer do not need to know they are crossing an
 * MCP boundary — or which side of the network it landed on.
 */
export async function callSiftTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult<unknown>> {
  let client: Client;
  try {
    client = await getClient();
  } catch (e) {
    return err(
      `Could not reach the ${isRemoteMcp() ? `remote SIFT MCP server (${getActiveMcpEndpoint()})` : "in-process SIFT MCP server"}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
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

/** A tool advertised by the active MCP server, as seen over `tools/list`. */
export interface DiscoveredTool {
  name: string;
  description: string | null;
  /** JSON Schema for the tool's arguments, as advertised by the server. */
  inputSchema: Record<string, unknown>;
}

/**
 * Ask the active MCP server which tools it offers. In remote mode this is how
 * the agent learns what the real Workstation can actually do, rather than
 * assuming a fixed local catalog. In in-process mode it returns the built-in
 * sift-tools.
 */
export async function listSiftTools(): Promise<DiscoveredTool[]> {
  const client = await getClient();
  const res = await client.listTools();
  return (res.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? null,
    inputSchema: (t.inputSchema ?? {
      type: "object",
      properties: {},
    }) as Record<string, unknown>,
  }));
}
