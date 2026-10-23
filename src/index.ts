import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { walkProject, CODE_EXTENSIONS } from "./walk.js";
import { extractSymbols } from "./parse.js";
import { SymbolIndex } from "./symbol-index.js";

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

const server = new McpServer({ name: "codebase-mcp", version: "0.3.0" });
const index = new SymbolIndex(projectRoot);

const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const asError = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

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

// 3. List files
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
    return asText({
      projectRoot,
      totalFiles: files.length,
      returned: shown.length,
      truncated: files.length > shown.length,
      files: shown,
    });
  }
);

// 4. File outline
server.registerTool(
  "get_file_outline",
  {
    description:
      "Returns the functions, classes, methods, interfaces, types and enums defined in one source file, with exact line numbers. Use this to understand a file without reading all of it.",
    inputSchema: {
      path: z.string().describe("File path relative to the project root, e.g. src/index.ts"),
    },
  },
  async ({ path: relPath }) => {
    const full = path.resolve(projectRoot, relPath);
    // Safety: never read outside the project folder
    const rel = path.relative(projectRoot, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return asError("Path must be inside the project folder.");
    }
    const ext = path.extname(full);
    if (!CODE_EXTENSIONS.has(ext)) {
      return asError(`Unsupported file type "${ext}". Supported: ${[...CODE_EXTENSIONS].join(", ")}`);
    }
    let source: string;
    try {
      source = await readFile(full, "utf8");
    } catch {
      return asError(`File not found: ${relPath}`);
    }
    const symbols = await extractSymbols(source, ext);
    return asText({
      file: rel.split(path.sep).join("/"),
      totalLines: source.split("\n").length,
      symbolCount: symbols?.length ?? 0,
      symbols,
    });
  }
);

// 5. Search symbols across the whole project
server.registerTool(
  "search_symbols",
  {
    description:
      "Finds where functions, classes, methods, interfaces, types or enums are defined anywhere in the project, by name (case-insensitive, partial match). Returns file paths and line numbers. Use this to locate code like 'auth' or 'createOrder' without reading files.",
    inputSchema: {
      query: z.string().min(1).describe("Part of the symbol name to search for"),
      kind: z.enum(["function", "class", "method", "interface", "type", "enum"]).optional()
        .describe("Only return this kind of symbol"),
      limit: z.number().int().min(1).max(100).default(25).describe("Maximum results"),
    },
  },
  async ({ query, kind, limit }) => {
    await index.ensureFresh();
    const { rows, truncated } = index.search(query, kind, limit);
    return asText({ query, count: rows.length, truncated, index: index.stats(), results: rows });
  }
);

// 6. Search the text of the code
server.registerTool(
  "search_code",
  {
    description:
      "Finds every line in the project's source files that contains a word or text (case-insensitive, partial match, works for identifiers, strings, routes, env vars like MONGO_URI, etc.). Each hit includes the file, line number, the line, and the function or class it sits inside. Also reports total matches and which files have the most. Use this to see where something is used, not just defined.",
    inputSchema: {
      query: z.string().min(1).max(200).describe("The word or text to look for"),
      wholeWord: z.boolean().default(false)
        .describe("Only match the exact word, not longer names containing it"),
      pathPrefix: z.string().optional()
        .describe("Only search files whose path starts with this, e.g. 'backend/' "),
      limit: z.number().int().min(1).max(200).default(30).describe("Maximum hits to return"),
    },
  },
  async ({ query, wholeWord, pathPrefix, limit }) => {
    await index.ensureFresh();
    return asText(index.searchCode(query, { wholeWord, pathPrefix, limit }));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`codebase-mcp running on stdio, project: ${projectRoot}`);
index.ensureFresh().catch((err) => console.error("initial index failed:", err));