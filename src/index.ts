import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "codebase-mcp", version: "0.1.0" });

server.registerTool(
  "hello",
  {
    description: "Greets a person by name. Use this to test that the server works.",
    inputSchema: { name: z.string().describe("The person's name") },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello ${name}, your MCP server is alive!` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("codebase-mcp running on stdio");