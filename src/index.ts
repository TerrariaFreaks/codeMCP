import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { statSync } from "node:fs";
import path from "node:path";
import { walkProject } from "./walk.js";

// 1. Read the project folder from the command line
const rawRoot = process.argv[2];
if (!rawRoot) {
  console.error("Usage: node dist/index.js <path-to-project>");
  process.exit(1);
}
const projectRoot = path.resolve(rawRoot);
try {
  if (!statSync(projectRoot).isDirectory()) throw new Error("not a directory");
} catch {
  console.error(`Project folder not found: ${projectRoot}`);
  process.exit(1);
}

const server = new McpServer({ name: "codebase-mcp", version: "0.2.0" });

// 2. Keep hello for testing
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

// 3. First real tool
server.registerTool(
  "list_project_files",
  {
    description:
      "Lists the JavaScript/TypeScript source files in the project, with junk like node_modules and build output excluded. Use this first to see how a project is laid out.",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(200)
        .describe("Maximum number of file paths to return"),
    },
  },
  async ({ limit }) => {
    const files = await walkProject(projectRoot);
    const shown = files.slice(0, limit);
    const result = {
      projectRoot,
      totalFiles: files.length,
      returned: shown.length,
      truncated: files.length > shown.length,
      files: shown,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`codebase-mcp running on stdio, project: ${projectRoot}`);