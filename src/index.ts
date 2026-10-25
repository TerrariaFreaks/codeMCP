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

// 7. Who uses this?
server.registerTool(
  "find_callers",
  {
    description:
      "Finds where a function, method, class or React component is used: calls, `new X()`, JSX usage (<X />), and places where it is passed as a callback or route handler (e.g. router.post('/login', login)). Each result shows the calling function, file, line and the line of code, with a confidence: 'resolved' (matched through imports or same-file definitions) or 'name-match' (matched by name only, e.g. obj.method() where the object's type is unknown). Use this to answer 'what calls X?' or 'where is X used?'. The name is exact and case-sensitive; use search_symbols first if unsure of the exact name.",
    inputSchema: {
      name: z.string().min(1).describe("Exact name of the function, method, class or component"),
      file: z.string().optional()
        .describe("Only usages of the definition in this file (relative path). Use when several files define the same name."),
      limit: z.number().int().min(1).max(100).default(30).describe("Maximum callers to return"),
    },
  },
  async ({ name, file, limit }) => {
    await index.ensureFresh();
    const g = index.graph();
    let fileArg: string | undefined;
    if (file) {
      const r = g.resolveFileArg(file);
      if (!r.ok) return asError(r.message);
      fileArg = r.file;
    }
    const defs = g.definitionsOf(name, fileArg);
    const hits = g.callersOf(name, fileArg);
    if (defs.length === 0 && hits.length === 0) {
      return asText({
        name,
        note: "No definition or usage found with this exact name. Try search_symbols for a partial, case-insensitive search.",
      });
    }
    const shown = hits.slice(0, limit);
    return asText({
      name,
      definitions: defs.map((d) => ({
        file: d.file, kind: d.kind, startLine: d.startLine, endLine: d.endLine, parent: d.parent,
      })),
      totalCallers: hits.length,
      resolved: hits.filter((h) => h.confidence === "resolved").length,
      nameMatchOnly: hits.filter((h) => h.confidence === "name-match").length,
      truncated: hits.length > shown.length,
      callers: shown.map((h) => ({
        inFunction: h.symbol ?? "(top level of file)",
        file: h.file,
        line: h.line,
        kind: h.kind,
        confidence: h.confidence,
        code: index.lineText(h.file, h.line),
      })),
    });
  }
);

// 8. File-level dependencies
server.registerTool(
  "get_dependency_graph",
  {
    description:
      "Shows how files depend on each other through imports. With a file: what it imports and what imports it (direct and, with depth, indirect), plus the npm packages it uses. Without a file: a project overview with the most imported files (the risky hubs), the files with the most imports, the most used npm packages, and circular import chains. Use this to understand architecture or find tightly coupled code.",
    inputSchema: {
      file: z.string().optional().describe("File path relative to the project root. Omit for a project overview."),
      direction: z.enum(["imports", "importedBy", "both"]).default("both")
        .describe("imports = what this file depends on, importedBy = what depends on it"),
      depth: z.number().int().min(1).max(4).default(1).describe("How many hops to follow"),
    },
  },
  async ({ file, direction, depth }) => {
    await index.ensureFresh();
    const g = index.graph();
    if (!file) return asText(g.overview());
    const r = g.resolveFileArg(file);
    if (!r.ok) return asError(r.message);
    return asText(g.fileDependencies(r.file, direction, depth));
  }
);

// 9. What breaks if I change this?
server.registerTool(
  "change_impact",
  {
    description:
      "Estimates what could break if you change a function, method, class or component (give name) or a whole file (give file). Returns the functions that call it directly and indirectly (depth 1 = direct), the files that import the file where it is defined, and test files that are likely affected. Direct callers include 'name-match' guesses; indirect links only follow 'resolved' connections. This is a static estimate: dynamic calls and runtime behavior can't be seen.",
    inputSchema: {
      name: z.string().optional().describe("Exact name of the function, method, class or component"),
      file: z.string().optional()
        .describe("File path relative to the project root. Alone = impact of changing the whole file. With name = the definition in that file."),
      depth: z.number().int().min(1).max(4).default(2).describe("How many hops of callers/importers to follow"),
    },
  },
  async ({ name, file, depth }) => {
    if (!name && !file) return asError("Provide a name, a file, or both.");
    await index.ensureFresh();
    const g = index.graph();
    let fileArg: string | undefined;
    if (file) {
      const r = g.resolveFileArg(file);
      if (!r.ok) return asError(r.message);
      fileArg = r.file;
    }
    if (name && g.definitionsOf(name, fileArg).length === 0) {
      return asError(
        `No definition named "${name}"${fileArg ? ` in ${fileArg}` : ""} found. Names are exact and case-sensitive; try search_symbols.`
      );
    }
    const r = g.impact({ name, file: fileArg, depth });
    return asText({
      target: name ?? fileArg,
      definedIn: r.definitions.map((d) => ({ file: d.file, kind: d.kind, startLine: d.startLine, endLine: d.endLine })),
      summary: {
        callers: r.callers.length,
        directCallers: r.callers.filter((c) => c.depth === 1).length,
        importerFiles: r.importers.length,
        affectedFiles: r.affectedFiles.length,
        testFiles: r.testsLikelyAffected.length,
        truncated: r.truncated,
      },
      callers: r.callers.map((c) => ({
        depth: c.depth, inFunction: c.symbol ?? "(top level of file)", file: c.file, line: c.line,
        kind: c.kind, confidence: c.confidence,
      })),
      filesThatImportIt: r.importers.slice(0, 60),
      testsLikelyAffected: r.testsLikelyAffected,
      notes: [
        "Static analysis only: dynamic calls, event handlers wired at runtime and aliased imports from tsconfig paths may be missed.",
        "'name-match' callers are guesses based on the method name alone.",
      ],
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`codebase-mcp running on stdio, project: ${projectRoot}`);
index.ensureFresh().catch((err) => console.error("initial index failed:", err));