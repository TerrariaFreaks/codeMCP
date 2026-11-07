# codebase-mcp

codebase-mcp is an MCP (Model Context Protocol) server, written in TypeScript, that gives AI assistants a structural understanding of a JavaScript or TypeScript codebase.

Instead of reading dozens of files or guessing from memory, an assistant such as Claude can call this server's tools to find out exactly where something is defined, what uses it, which files depend on which, and what could break if a piece of code changes. Every answer comes back as structured data with file paths and line numbers.

The server contains no language model and needs no API key. The AI client it is connected to supplies the model. Everything runs locally on your machine, and your project is never modified.

This document explains what the project does, how each tool works, how to run it, how it is built internally, and how to fix common problems. It is written to be useful both as a user guide and as a study guide for understanding the code.

## Contents

1. [Background: what MCP is](#1-background-what-mcp-is)
2. [What the project does](#2-what-the-project-does)
3. [Requirements and installation](#3-requirements-and-installation)
4. [Connecting it to an AI client](#4-connecting-it-to-an-ai-client)
5. [The tools](#5-the-tools)
6. [The command-line search](#6-the-command-line-search)
7. [All commands at a glance](#7-all-commands-at-a-glance)
8. [How it is built](#8-how-it-is-built)
9. [How a request flows through the system](#9-how-a-request-flows-through-the-system)
10. [Design decisions](#10-design-decisions)
11. [Known limitations](#11-known-limitations)
12. [Security and privacy](#12-security-and-privacy)
13. [Troubleshooting](#13-troubleshooting)
14. [Glossary](#14-glossary)
15. [Possible future work](#15-possible-future-work)

---

## 1. Background: what MCP is

The Model Context Protocol (MCP) is an open standard that lets AI assistants use external programs. A program that offers abilities to an assistant is called an MCP server. The assistant side is called the client. Claude Desktop is one example of a client.

An MCP server offers **tools**. Each tool has a name, a plain-language description, and a list of inputs. The client shows these to the model. During a conversation, the model decides on its own when a tool would help, calls it with some inputs, receives the result, and uses that result in its answer.

Two consequences matter for this project:

- The model decides *when* to call a tool. The server decides *what* the tools are, how they behave, and what they return. This project is the tool side.
- Because the model lives in the client, the server needs no API key and no model of its own.

This server communicates with the client over **stdio**: the client starts the server as a child process and exchanges messages through its standard input and output. That is why the server must never print ordinary output to stdout, and uses stderr for all logging.

## 2. What the project does

Large codebases are hard for an AI assistant to work with. It can only read a few files at a time, and it is unreliable at exact, large-scale questions such as counting usages or following imports across hundreds of files. Without help it either reads too much, which is slow, or guesses, which produces invented function names.

codebase-mcp does the exact work in code and leaves the judgement to the model. It parses the project, builds an index, and exposes eight focused tools that the assistant can call and combine. A typical chain looks like this:

1. `search_code` finds where a word appears and which function it sits in.
2. `get_file_outline` shows the structure of that file.
3. `find_callers` shows what uses the function.
4. `change_impact` estimates what would be affected by changing it.

What it covers:

- Languages: JavaScript and TypeScript (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`)
- Code structure: functions, arrow-function components, classes, methods, interfaces, type aliases, enums
- Relationships: imports (ES modules, CommonJS `require`, dynamic `import()`, re-exports), default exports, calls, `new` expressions, JSX component usage, and functions passed as arguments such as route handlers and callbacks
- Analysis: dependency graph, circular import detection, call graph, change impact

## 3. Requirements and installation

**Requirements**

- Node.js 22.13 or newer. The server uses Node's built-in `node:sqlite` module, which is not available in older versions. Check with `node -v`.
- An MCP-capable AI client, for example Claude Desktop.

**Dependencies**

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` (1.x) | The official MCP SDK: server, tool registration, stdio transport |
| `zod` (3.x) | Validates and describes each tool's inputs |
| `web-tree-sitter` (0.22.6) | tree-sitter parser compiled to WebAssembly |
| `tree-sitter-wasms` | Prebuilt grammars for JavaScript, TypeScript and TSX |
| `typescript`, `@types/node` (dev) | Compiling and type-checking |

`web-tree-sitter` is pinned to 0.22.6 because newer versions failed to load the grammars shipped in `tree-sitter-wasms` when tested. If you upgrade one, upgrade both together and re-test.

Nothing needs to be compiled natively. tree-sitter runs as WebAssembly and SQLite is built into Node.

**Install and build**

```
npm install
npm run build
```

`npm run build` runs the TypeScript compiler and writes the result to the `dist` folder. You must rebuild after every code change.

Node prints a line saying `ExperimentalWarning: SQLite is an experimental feature` to stderr. This is expected and harmless.

## 4. Connecting it to an AI client

The server is started with one required argument: the folder of the project you want it to analyse.

```
node dist/index.js <path-to-project>
```

If the argument is missing or the folder does not exist, the server prints an error to stderr and exits.

**Claude Desktop**

Open Settings, then Developer, then Edit Config, and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "codebase-mcp": {
      "command": "node",
      "args": [
        "C:/path/to/codebase-mcp/dist/index.js",
        "C:/path/to/the/project/you/want/to/explore"
      ]
    }
  }
}
```

If the config file already contains other settings, merge the `mcpServers` block into the existing top-level object instead of adding a second set of braces. Then fully quit Claude Desktop (from the system tray, not just closing the window) and reopen it. Under Settings, Developer, the server should show as running.

Tips:

- Use forward slashes in paths, even on Windows.
- Paths containing spaces work in the config file as written.
- To explore several projects, add one entry per project with different names, for example `codebase-mcp-api` and `codebase-mcp-web`.
- Other MCP clients start the server the same way: the command is `node`, and the arguments are the path to `dist/index.js` and the project folder. The place where you register the server differs between clients, so check that client's MCP documentation.

**Testing without an AI client: the MCP Inspector**

The Inspector is a browser tool for calling an MCP server's tools by hand:

```
npx @modelcontextprotocol/inspector node dist/index.js C:/path/to/project
```

Click Connect, open the Tools tab, click List Tools, choose a tool, fill in its inputs, and click Run Tool. This is the fastest way to test a change, because it shows the raw output exactly as the model would receive it.

## 5. The tools

The server registers eight tools. All of them return their result as formatted JSON text. On a problem such as a missing file, they return an error message instead, flagged as an error so the client knows the call failed.

Tools that query the index first make sure the index is fresh (see section 8), so results always reflect the current state of the files.

### hello

A health check. Takes a `name` and replies with a greeting. Use it to confirm the server is connected.

### list_project_files

Lists the source files in the project.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer, 1 to 1000 | 200 | Maximum number of paths to return |

Returns `projectRoot`, `totalFiles`, `returned`, `truncated` and `files` (paths relative to the project root, sorted). The folders `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.turbo` and `.cache` are skipped, as are `package-lock.json`, `yarn.lock` and `pnpm-lock.yaml`. Only files with the supported extensions are listed.

Use it first to see how a project is laid out.

### get_file_outline

Returns the structure of one file without reading all of it.

| Input | Type | Description |
|-------|------|-------------|
| `path` | string | File path relative to the project root, for example `src/index.ts` |

Returns `file`, `totalLines`, `symbolCount` and `symbols`. Each symbol has:

- `name`
- `kind`: `function`, `class`, `method`, `interface`, `type` or `enum`
- `startLine` and `endLine` (1-based)
- `parent`: the class name, for methods
- `exported`: whether the declaration is exported

This tool parses the file directly each time. Arrow functions assigned to a variable, such as `const Button = () => ...`, are listed as functions.

Errors are returned for paths outside the project folder, unsupported file types, and files that do not exist.

### search_symbols

Finds where something is defined, by name.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | | Part of a symbol name |
| `kind` | enum | any | Optionally restrict to one kind of symbol |
| `limit` | integer, 1 to 100 | 25 | Maximum results |

Matching is case-insensitive and matches anywhere in the name, so `auth` finds `authMiddleware`, `AuthService` and `isAuthenticated`. Results are ordered with exact matches first, then names that start with the query, then everything else. The response includes `count`, `truncated`, the index size (`files` and `symbols`), and the results, each with file, kind, line range, parent and exported flag.

This searches definition names only. It does not search inside code, and it does not match by meaning.

### search_code

Searches the text of every source file.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string, up to 200 characters | | The word or text to find |
| `wholeWord` | boolean | false | Match the exact identifier only, not longer names containing it |
| `pathPrefix` | string | none | Only search files whose path starts with this, for example `backend/` |
| `limit` | integer, 1 to 200 | 30 | Maximum hits returned |

Matching is case-insensitive and finds substrings, so it works for identifiers, strings, routes and environment variable names such as `MONGO_URI`. The response contains:

- `totalMatches` and `filesWithMatches`
- `byFile`: the files with the most matches
- `results`: each hit with `file`, `line`, `text`, `inSymbol` (the function or class the line is inside, with its line range) and `isDefinition` (true when the line is where a matching symbol is defined)
- `truncated` when more hits exist than were returned, and `capped` when counting stopped at 5,000 matches

Matching works within a single line. A phrase split across two lines will not match. Very short queries work but match a great deal, so prefer specific words.

### find_callers

Shows everything that uses a function, method, class or React component.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | | Exact, case-sensitive name |
| `file` | string | none | Only usages of the definition in this file. Use when several files define the same name |
| `limit` | integer, 1 to 100 | 30 | Maximum callers returned |

The response lists the `definitions` found, the totals (`totalCallers`, `resolved`, `nameMatchOnly`), and the callers. Each caller has:

- `inFunction`: the function or method the usage sits inside, or "(top level of file)"
- `file` and `line`
- `code`: the line of code itself
- `kind`: how it is used
- `confidence`: how certain the match is

The four kinds of usage:

| Kind | Meaning | Example |
|------|---------|---------|
| `call` | A function or method call | `signToken(user)` |
| `new` | A constructor call | `new OrderService()` |
| `jsx` | A React component rendered | `<Navbar />` |
| `ref` | Passed as an argument, such as a route handler or callback | `router.post("/login", login)` |

The two confidence levels:

- `resolved`: the usage was linked to the definition through an import or a same-file definition. This includes aliased imports (`import { signToken as makeToken }`), default imports, namespace imports, CommonJS `require`, barrel files, `this.method()` inside a class, and static calls such as `OrderService.make()`.
- `name-match`: only the method name matched, for example `svc.place()` where the type of `svc` is unknown. Treat these as candidates, not facts.

If the name is not found at all, the tool says so and suggests `search_symbols`.

### get_dependency_graph

Shows how files depend on each other through imports. It has two modes.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | none | File path relative to the project root. Omit for a project overview |
| `direction` | `imports`, `importedBy` or `both` | `both` | Which way to follow dependencies |
| `depth` | integer, 1 to 4 | 1 | How many hops to follow |

The file argument is flexible. An exact path works, and so does a unique ending such as `token.js`. If the ending matches several files, the tool lists them and asks for a more specific path.

**With a file**, it returns `imports` (files it depends on), `importedBy` (files that depend on it), each with a depth number, and `externalPackages` (the npm packages it uses).

**Without a file**, it returns a project overview:

- `totalFiles` and `internalImportEdges`
- `mostImportedFiles`: the hubs that many files depend on, which are the riskiest to change
- `filesWithMostImports`: the files that depend on the most others
- `externalPackages`: the npm packages used most widely
- `circularDependencies`: groups of files that import each other in a cycle (up to 5 shown)

### change_impact

Estimates what could break if you change something.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | none | Exact name of a function, method, class or component |
| `file` | string | none | File path. Alone, it means "change the whole file". With a name, it picks the definition in that file |
| `depth` | integer, 1 to 4 | 2 | How many hops of callers and importers to follow |

At least one of `name` or `file` is required. The response contains:

- `definedIn`: where the target is defined
- `summary`: counts of callers, direct callers, importing files, affected files and test files
- `callers`: each caller with its `depth` (1 means a direct caller, 2 means a caller of a caller, and so on)
- `filesThatImportIt`: files that import the defining file, with their depth
- `testsLikelyAffected`: affected files whose names match `.test.`, `.spec.` or `__tests__/`
- `notes`: reminders about the limits of static analysis

Direct callers may include `name-match` guesses. Beyond depth 1, only `resolved` links are followed, so an uncertain match does not grow into a long chain of noise. Up to 150 callers are returned, and `truncated` says if more existed.

## 6. The command-line search

The same index that powers the tools also powers a standalone command, so you can search a project yourself without an AI client.

```
node dist/cli.js <project-folder> <word> [--whole] [--limit=N]
```

| Part | Meaning |
|------|---------|
| `<project-folder>` | The project to search |
| `<word>` | What to look for. Several words are joined into one phrase |
| `--whole` | Match whole identifiers only |
| `--limit=N` | Number of hits to show (default 30) |

Examples:

```
node dist/cli.js C:/projects/MyApp login
node dist/cli.js C:/projects/MyApp login --whole
node dist/cli.js C:/projects/MyApp socket --limit=100
node dist/cli.js C:/projects/MyApp "mongoose.model"
```

The output has three parts: a summary line with the total number of matches and files, a short list of the files with the most matches, and then each hit grouped by file with its line number. A `(def)` marker shows where the word is defined, and a bracket at the end of the line shows the function or class the line sits inside:

```
"order": 5 matches in 1 files

Most matches:
     5  server/routes.js

server/routes.js
      7: (def) export function createOrder(req, res) {  [in createOrder (function, lines 7-10)]
      8: const order = { user: req.user, id: 1 };  [in createOrder (function, lines 7-10)]
```

If nothing matches, it prints "No matches". With no arguments it prints a usage line. The first run on a project builds the index, so it takes a moment. Later runs are nearly instant.

An optional shortcut can be added to `package.json` so that `npm run search -- <project> <word>` works:

```
npm pkg set scripts.search="node dist/cli.js"
```

## 7. All commands at a glance

| Goal | Command |
|------|---------|
| Check Node version | `node -v` |
| Install dependencies | `npm install` |
| Compile the project | `npm run build` |
| Start the server by hand (it waits for a client) | `node dist/index.js <project>` or `npm start -- <project>` |
| Test the tools in a browser | `npx @modelcontextprotocol/inspector node dist/index.js <project>` |
| Search from the terminal | `node dist/cli.js <project> <word> [--whole] [--limit=N]` |
| Reset the index (PowerShell) | `Remove-Item -Recurse -Force $HOME\.codebase-mcp` |
| Reset the index (macOS or Linux) | `rm -rf ~/.codebase-mcp` |

After changing any code: run `npm run build`, then reconnect the Inspector, or fully quit and reopen the AI client.

## 8. How it is built

### Project layout

```
src/
  index.ts          MCP server: tool definitions, input validation, output shaping
  walk.ts           Finds the source files in a project
  parse.ts          tree-sitter analysis: symbols, imports, calls, exports
  symbol-index.ts   SQLite index, incremental refresh, symbol and text search
  graph.ts          Import resolution, caller matching, dependency graph, change impact
  cli.ts            Command-line search
```

Configuration files: `package.json` (with `"type": "module"` and a `build` script) and `tsconfig.json` (strict mode, `NodeNext` modules, and `"types": ["node"]`, which newer TypeScript versions require in order to load the Node type definitions).

### walk.ts: finding files

`walkProject` walks the project folder recursively and returns the relative paths of source files. It skips the ignored folders and lockfiles listed in section 5, keeps only the supported extensions, converts paths to forward slashes so they look the same on every operating system, and returns them sorted. It also exports the set of supported extensions, which other modules reuse.

### parse.ts: understanding code with tree-sitter

tree-sitter turns source code into a syntax tree: a nested structure of nodes such as `function_declaration`, `call_expression` and `import_statement`, each with a type, a position, and named parts. Working with this tree is far more reliable than searching text with patterns, because it understands the language's structure.

The module loads the tree-sitter runtime and the needed grammar as WebAssembly, caches the loaded languages and parsers, and picks the grammar from the file extension (TypeScript, TSX or JavaScript). The main function, `analyzeFile`, makes two passes over the tree.

**Pass 1: symbols.** Looks at the top-level declarations (and inside `export` statements) and records functions, arrow functions or function expressions assigned to variables, classes, interfaces, type aliases and enums. For classes it also records each method with its parent class. Every symbol stores its line range.

**Pass 2: relationships.** Walks the entire tree using an explicit stack, rather than recursion, so very deep syntax trees cannot overflow the call stack. It handles:

- `import_statement`: default, named (with aliases), namespace and side-effect imports
- `export_statement`: re-exports (`export { x } from "./y"`, `export * from`) and default exports, including the name being exported
- `require("...")`: including `const x = require(...)` and destructured `const { a, b } = require(...)`
- dynamic `import("...")`
- `call_expression`: plain calls (`foo()`) and member calls (`obj.method()`), recording the object as an identifier, `this`, `super`, or a placeholder for complex expressions. Calls on `console`, `Math`, `JSON` and a few other built-in objects are ignored as noise
- identifiers and member expressions passed as call arguments, recorded as `ref` usages. This is what captures route handlers and callbacks
- `new_expression` and JSX tags (only capitalized names, which are components)
- `module.exports = Name`, recorded as the file's default export

Afterwards, each call site is attributed to the smallest symbol whose line range contains it. That is how the tool can say a call happens "inside `login`".

The module also exports `extractSymbols`, a thin wrapper used by `get_file_outline`.

### symbol-index.ts: the incremental SQLite index

`SymbolIndex` stores everything in a SQLite database using Node's built-in `node:sqlite`. The database file lives in `~/.codebase-mcp/`, named from a hash of the project path, so each project gets its own file and nothing is added to the project itself.

Tables:

| Table | Contents |
|-------|----------|
| `files` | Each indexed file with its modification time and size |
| `symbols` | Every symbol: name, kind, file, line range, parent, exported |
| `lines` | A full-text (FTS5) table with one row per non-empty line of code, using the trigram tokenizer |
| `imports` | Every import or re-export: the specifier, the local name, the imported name, the kind and the line |
| `calls` | Every call site: file, enclosing function and class, callee, object, kind, line |
| `default_exports` | The name of each file's default export, when it has one |

**Incremental updates.** `ensureFresh` re-scans the project, but compares each file's modification time and size with what is stored, and only re-parses files that changed. Deleted files are removed from every table. Each file's update runs inside a transaction. To avoid redundant work, a refresh runs at most once every five seconds, and concurrent calls share one running refresh. When the server starts, indexing begins in the background so the server is available immediately. Files larger than 1 MB are skipped, and lines are cut at 300 characters before indexing.

**Schema versions.** The database records a schema version. If the stored version is older than the code's, the old tables are dropped and the index is rebuilt automatically.

**Searching.** `search` queries the `symbols` table by name. `searchCode` queries the `lines` table, optionally filtered by path, applies the whole-word filter in code, counts matches per file, and looks up the enclosing symbol for each hit. The trigram tokenizer is what makes substring matching fast and lets it match fragments of identifiers.

**Graph access.** `graph()` builds a `CodeGraph` from the tables and caches it. The cache is thrown away whenever a refresh changes anything. `lineText` fetches a single line of code, used to show call sites.

### graph.ts: relationships and impact

`CodeGraph` is built from the rows in the index and works entirely in memory.

**Resolving imports.** A specifier such as `../models/User` becomes a real file. Specifiers that do not start with a dot are treated as npm packages (the package name is extracted, handling scoped packages such as `@scope/name`). For relative specifiers the resolver tries the exact path, TypeScript-style substitution (`./x.js` maps to `x.ts` or `x.tsx`), each supported extension, and `index` files inside folders. The result is cached.

**Building the graph.** Resolved imports become edges between files, stored in both directions so the graph can be walked forwards (what a file depends on) and backwards (what depends on it). Re-exports are kept separately so barrel files can be followed.

**Matching a call to its definition.** For every call site the graph decides what it refers to:

1. A plain call whose name was imported: follow the import to its file. For default imports, use the default export name recorded for that file. Follow re-export chains up to five levels deep to reach the real definition. Calls to functions imported from npm packages are dropped.
2. A plain call whose name is defined in the same file: resolved to that file.
3. `this.method()` inside a class: resolved to the same file.
4. `object.method()` where `object` is an imported module or default import: resolved to that module's file.
5. `Class.method()` where the class is defined in the same file: resolved to the same file.
6. Anything else: a `name-match` guess on the method name alone. Passed-as-argument references are never guessed, only resolved ones are kept.

**Dependency queries.** Breadth-first search over the forward or backward edges, up to the requested depth, gives `imports` and `importedBy`. The overview counts edges per file, ranks the hubs, tallies npm package usage, and finds circular imports using Tarjan's algorithm, which identifies groups of files that can all reach each other.

**Change impact.** Starting from the target, it finds direct callers, then repeats for each caller to find callers of callers, up to the requested depth. Beyond the first level only `resolved` links are followed. Separately, it walks backwards through the import edges from the defining file to list the files that depend on it. Files matching test naming patterns are reported as likely affected tests.

### index.ts: the MCP server

Reads the project folder from the command line, validates it, creates the index, and registers each tool with `registerTool`. Every tool definition has four parts: a name, a description written for the model to read, an input schema built with zod, and a handler function. Shared helpers format successful results as JSON text and errors as error-flagged messages. After the tools are registered, the server connects over stdio and starts indexing in the background.

### cli.ts

Parses the command-line arguments, validates the folder, builds or refreshes the index with the same `SymbolIndex` class, runs `searchCode`, and prints a formatted report. It shows how the index can serve more than one interface.

## 9. How a request flows through the system

Following one question from start to finish: *"What calls `signToken`?"*

1. You ask Claude. Claude sees the tool list and decides `find_callers` is the right tool, then calls it with `name: "signToken"`.
2. The MCP SDK validates the input against the zod schema and runs the handler in `index.ts`.
3. The handler calls `ensureFresh`. Changed files, if any, are re-parsed and their rows replaced in the database.
4. The handler asks the index for the graph. If nothing changed since last time, the cached graph is reused.
5. `graph.ts` looks up all call sites whose resolved target is `signToken`. Each was matched when the graph was built, using the import-resolution rules above.
6. The handler shapes the result: definitions, totals, and each caller with the line of code fetched from the index.
7. The JSON travels back over stdio to Claude, which reads it and writes its answer.

Everything between steps 2 and 6 is ordinary deterministic code, which is the point: the model gets exact facts and uses its judgement on top of them.

A useful way to study the code is to add a temporary `console.error` at each of these steps and run a single tool in the MCP Inspector, then watch the data move through.

## 10. Design decisions

- **Logic in the server, judgement in the model.** Tools return exact, structured facts. The assistant decides what to do with them.
- **Confidence labels instead of false precision.** JavaScript is dynamic, so some matches are guesses. Marking each one `resolved` or `name-match` lets the model and the reader weigh them properly, and restricting deeper `change_impact` levels to `resolved` links keeps guesses from compounding.
- **Usage, not just calls.** In real JavaScript projects, route handlers, middleware and React components are referenced or rendered rather than called. Recording `ref` and `jsx` usages makes `find_callers` useful on typical web projects.
- **WebAssembly tree-sitter and built-in SQLite.** No native modules to compile, which avoids the most common installation failures, particularly on Windows.
- **Trigram full-text search.** Matches fragments of identifiers, routes and variable names, which a word-based tokenizer would miss.
- **Index stored outside the project.** No files are added to the repository and nothing needs to be git-ignored.
- **Incremental indexing.** Only changed files are re-parsed, so the cost after the first run is small.
- **Bounded output.** Results are capped and report truncation, so a broad query cannot flood the model's context.
- **Small, single-purpose tools with descriptive text.** The description is what the model reads when deciding whether to use a tool, so each one says what it does, what it returns, and when to use it.

## 11. Known limitations

Static analysis of JavaScript has real limits. The known ones:

- **Path aliases are not resolved.** Imports such as `@/components/Button`, configured through `tsconfig` paths or a bundler, are treated as npm packages, so those edges are missing from the graph. Relative imports work.
- **Method calls on variables are guesses.** In `const svc = new OrderService(); svc.place()`, the tool does not infer that `svc` is an `OrderService`, so `place` is reported as `name-match`.
- **Symbols are top-level only.** Nested functions, methods inside object literals, and components wrapped in `React.memo()` or `forwardRef()` are not listed as symbols. Calls inside them are attributed to the enclosing top-level symbol, or to the top level of the file.
- **Types are not tracked as usages.** `find_callers` on an interface or type alias finds nothing, because only calls, `new`, JSX and arguments are recorded.
- **Dynamic behaviour is invisible.** Computed property calls, `eval`, handlers registered at runtime and `require` with a variable cannot be seen.
- **Text search is line-based**, and counting stops at 5,000 matches.
- **Scope.** JavaScript and TypeScript only. Files over 1 MB are skipped.
- **Test detection is name-based.** It looks for `.test.`, `.spec.` and `__tests__/`.

## 12. Security and privacy

- **Read-only.** The server never writes to or modifies the project. Its only writes are to its own index in `~/.codebase-mcp`.
- **Path containment.** `get_file_outline` resolves the requested path against the project root and refuses anything that escapes it, such as `../../etc/passwd`.
- **Local.** The server makes no network requests and sends no telemetry. What the AI client sends to its model is governed by that client, so be aware that tool results returned to the assistant may include snippets of your code.
- **Logging.** All diagnostic output goes to stderr, never stdout, because stdout carries the protocol.

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Build error `TS2591: Cannot find name 'process'` or `node:fs` | Node type definitions are not loaded | Run `npm install -D @types/node` and make sure `tsconfig.json` contains `"types": ["node"]` |
| Server shows as failed in the AI client | Missing or wrong project path, or code not rebuilt | Check the second argument in the config, run `npm run build`, then fully quit and reopen the client |
| "Project folder not found" | A placeholder or mistyped path was used | Use the real path, with forward slashes. Quote it if it contains spaces |
| New or changed tool does not appear | Old build, or the client or Inspector still running the old version | Run `npm run build` again, then reconnect the Inspector or fully restart the client |
| A tool is registered but errors on connect | The tool was added after `server.connect(...)` | Register all tools before connecting |
| `search_symbols` or `search_code` returns nothing right after startup | The first index is still being built in the background | Wait a few seconds and run it again |
| Inspector tool list looks empty or cut off | The panel layout is squeezed | Zoom the browser out with Ctrl and minus, or drag the divider down |
| Garbled or failing connection after adding code | `console.log` was used, which corrupts stdout | Replace it with `console.error` |
| Error loading a tree-sitter grammar | `web-tree-sitter` and `tree-sitter-wasms` versions are incompatible | Keep `web-tree-sitter` at 0.22.6, or upgrade both and re-test |
| `ExperimentalWarning: SQLite` | Node marks its built-in SQLite as experimental | Harmless, ignore it |
| `npm` or `npx` blocked in PowerShell | Script execution policy | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Index seems stale or wrong | Corrupted or outdated index | Delete the `.codebase-mcp` folder in your home directory and rerun |
| Imports through `@/...` missing from the graph | Path aliases are not supported | See known limitations |

## 14. Glossary

- **MCP (Model Context Protocol):** an open standard that lets AI assistants use external tools.
- **MCP server / client:** the program that offers tools, and the AI application that uses them.
- **Tool:** a named ability the server offers, with a description and typed inputs.
- **stdio:** communication through a program's standard input and output.
- **tree-sitter:** a parsing library that turns source code into a syntax tree.
- **Syntax tree / AST:** a nested structure representing the grammar of a piece of code.
- **WebAssembly (WASM):** a portable binary format, used here so tree-sitter runs without native compilation.
- **Symbol:** a named definition in code, such as a function, class or interface.
- **Call site:** a place in the code where something is called or used.
- **Barrel file:** a file such as `index.js` that re-exports things from other files.
- **Default export:** the single main thing a file exports, imported without braces.
- **Circular dependency:** files that import each other, directly or through a chain.
- **Resolved / name-match:** the two confidence levels for a caller. Resolved means linked through imports. Name-match means matched by name only.
- **FTS5 / trigram:** SQLite's full-text search engine, and a tokenizer that indexes three-character fragments so substrings can be found quickly.
- **Incremental indexing:** updating only what changed instead of rebuilding everything.
- **Static analysis:** examining code without running it.

## 15. Possible future work

- Resolve `tsconfig.json` path aliases
- Infer the type of variables created with `new` so instance method calls can be resolved
- Recognize Express routes, Mongoose models and wrapped React components as symbols
- Track type and interface usage
- Add an automated test suite with fixture projects
- Add support for more languages by adding tree-sitter grammars
- Add a helper tool that inspects a project's runtime, ports, environment variables and services, and writes a containerization script
- Publish as an npm package so it can be started with `npx`