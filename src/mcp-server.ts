import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./lib/mcp-instance";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] MesDessous Knowledge Base MCP server running (stdio)");
}

main().catch((err) => {
  console.error("[mcp] Fatal error:", err);
  process.exit(1);
});



