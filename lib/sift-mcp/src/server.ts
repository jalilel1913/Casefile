import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TOOL_REGISTRY,
  invokeTool,
  type AnyToolDescriptor,
  type ToolName,
} from "@workspace/sift-tools";
import { z } from "zod";

export const SIFT_MCP_SERVER_NAME = "casefile-sift-tools";
export const SIFT_MCP_SERVER_VERSION = "0.1.0";

/**
 * Build the MCP-facing input shape for a tool. We reuse each sift-tool's own
 * Zod object shape so the schema the MCP client sees matches the schema the
 * tool actually validates against.
 *
 * The one exception is `mcpFetcher.allowedHosts`, which the tool models as a
 * `Set<string>`. A Set cannot survive JSON-RPC serialization, so over the MCP
 * boundary it is exposed as an array and reconstructed into a Set inside the
 * handler before validation.
 */
function inputShapeFor(name: string, schema: z.ZodTypeAny): z.ZodRawShape {
  const shape = { ...(schema as z.ZodObject<z.ZodRawShape>).shape };
  if (name === "mcpFetcher") {
    shape.allowedHosts = z
      .array(z.string())
      .optional()
      .describe("Approved hostnames the fetch may contact (allowlist).");
  }
  return shape;
}

/**
 * Construct an MCP server that exposes every forensic tool in the sift-tools
 * registry as a typed, structured MCP tool. The server holds no generic
 * `execute_shell` primitive — the agent (or any MCP client) can only call the
 * specific, schema-validated functions registered here. Raw tool output is
 * parsed and returned as JSON text.
 */
export function buildSiftMcpServer(): McpServer {
  const server = new McpServer({
    name: SIFT_MCP_SERVER_NAME,
    version: SIFT_MCP_SERVER_VERSION,
  });

  for (const [name, descriptor] of Object.entries(TOOL_REGISTRY)) {
    const tool = descriptor as AnyToolDescriptor;
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: inputShapeFor(name, tool.inputSchema),
      },
      async (args) => {
        let toolInput = (args ?? {}) as Record<string, unknown>;
        if (name === "mcpFetcher" && Array.isArray(toolInput.allowedHosts)) {
          toolInput = {
            ...toolInput,
            allowedHosts: new Set(toolInput.allowedHosts as string[]),
          };
        }
        const result = await invokeTool(name as ToolName, toolInput);
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result.data) },
          ],
        };
      },
    );
  }

  return server;
}
