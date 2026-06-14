import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { buildSiftMcpServer } from "./server.js";

/**
 * Network entrypoint for the SIFT MCP server, served over the MCP
 * Streamable-HTTP transport.
 *
 * Two uses:
 *
 *  1. **Local mock** — run it inside Replit and point the agent at it with
 *     `SIFT_MCP_URL=http://localhost:<port>/mcp` to exercise the remote-client
 *     code path end-to-end without a real VM:
 *
 *         pnpm --filter @workspace/sift-mcp serve
 *
 *  2. **On a SIFT Workstation VM** — run this same server (or a real-tool
 *     variant; see `reference/sift-workstation-server.mjs`) on the VM and set
 *     `SIFT_MCP_URL` on the agent to the VM's address. Set a shared
 *     `SIFT_MCP_TOKEN` on both sides to require a bearer token.
 *
 * The server is stateless: a fresh MCP server + transport is built per request,
 * which is the SDK's recommended shape for a pure tool server (no sessions, no
 * cross-request state to leak).
 */
const PORT = Number(process.env.PORT ?? process.env.SIFT_MCP_PORT ?? 8790);
const TOKEN = process.env.SIFT_MCP_TOKEN?.trim() || null;
/**
 * When set, the mock advertises one extra tool that is NOT part of the built-in
 * sift-tools catalog. It exists so the agent's remote tool-*discovery* path can
 * be verified locally: a tool the agent has no static wrapper for must still be
 * discovered over tools/list and exposed to the model. A real Workstation would
 * advertise its own such tools (volatility, sleuthkit, yara, ...).
 */
const MOCK_EXTRA = !!(process.env.SIFT_MCP_MOCK_EXTRA?.trim());

function buildServer() {
  const server = buildSiftMcpServer();
  if (MOCK_EXTRA) {
    server.registerTool(
      "sift_workstation_probe",
      {
        description:
          "Reference-only remote tool advertised by the SIFT Workstation mock. " +
          "Echoes a target string back so the agent's remote tool-discovery and " +
          "generic dispatch path can be verified. Not a built-in sift-tool.",
        inputSchema: {
          target: z
            .string()
            .describe("An evidence path or indicator on the Workstation."),
        },
      },
      async (args) => {
        const target = (args as { target?: unknown })?.target ?? "";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                probed: String(target),
                served_by: "sift-workstation-mock",
                note: "remote-only tool, discovered over MCP tools/list",
              }),
            },
          ],
        };
      },
    );
  }
  return server;
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const httpServer = createServer(async (req, res) => {
  // Lightweight health probe so a VM operator can confirm the server is up.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ status: "ok", server: "casefile-sift-mcp", auth: !!TOKEN }),
    );
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  if (TOKEN) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      unauthorized(res);
      return;
    }
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "internal_error",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `SIFT MCP server (Streamable HTTP) listening on :${PORT}` +
      ` — POST /mcp${TOKEN ? " (bearer auth required)" : ""}` +
      `${MOCK_EXTRA ? " [mock extra tool enabled]" : ""}`,
  );
});
