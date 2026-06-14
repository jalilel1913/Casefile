import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildSiftMcpServer } from "./server.js";

/**
 * Standalone stdio entrypoint so any external MCP client (Claude Desktop,
 * an IDE, the MCP inspector, etc.) can connect to the sift-tools server:
 *
 *   pnpm --filter @workspace/sift-mcp start
 */
const server = buildSiftMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
