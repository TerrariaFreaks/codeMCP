codebase-mcp

codebase-mcp is an MCP (Model Context Protocol) server, written in TypeScript, that helps AI assistants understand a JavaScript or TypeScript codebase. Instead of reading dozens of files or guessing, an assistant like Claude can call its tools to look up exactly where something is defined, what uses it, and what could break if it changes. The server has no LLM inside it and needs no API key, because the AI client it connects to supplies the model. Everything runs locally and never modifies the project.

The tools
list_project_files lists the source files in the project, skipping folders like node_modules, .git and dist.
get_file_outline returns the functions, classes, methods, interfaces, types and enums in one file, with exact line numbers.
search_symbols finds where something is defined by name, using a case-insensitive partial match.
search_code searches the text of every file and shows each match with its line number and the function or class it sits inside.
find_callers shows everything that uses a function, method, class or React component. That includes calls, new X(), JSX like <Navbar />, and handlers passed as arguments, such as router.post("/login", login).
get_dependency_graph shows what a file imports and what imports it. With no file given, it gives a project overview: the most-imported files, the npm packages used, and any circular imports.
change_impact estimates what could break if you change a function or file. It lists direct and indirect callers, the files that import it, and test files likely to be affected.
hello is a simple health-check tool used to confirm the server is connected.
How it was built

The server is written in TypeScript on the official MCP SDK, with zod validating each tool’s inputs. It talks to the AI client over stdio.

Parsing. Files are parsed with tree-sitter, running as WebAssembly so nothing native has to be compiled. In one pass over each file’s syntax tree, the parser collects the symbols with their line ranges, the imports (ES modules, CommonJS require, dynamic import(), re-exports), the default export, and every call site. Each call site is tagged with the function it sits inside.

Indexing. The results go into a SQLite database using Node’s built-in node:sqlite. The index is incremental: on each query, files are compared by modification time and size, and only changed files are re-parsed. Deleted files are removed. The database lives in ~/.codebase-mcp/, outside the project, so nothing is added to your repository.

Code search. Every line of code is stored in a SQLite full-text table with the trigram tokenizer. That allows fast substring search that works on identifiers, routes and environment variable names.

Graph logic. On demand, the server resolves each import to a real file, handling TypeScript-style ./x.js imports that point to x.ts, index files, aliased imports, default exports and barrel files. It then matches each call site to its definition. Matches are labelled resolved when they come through imports or same-file definitions, and name-match when they are only matched by method name. Cycle detection uses Tarjan’s algorithm, and change_impact walks the graph outward from the changed code. Indirect callers follow only resolved links, so guesses don’t pile up.

The command-line search

The same index also powers a standalone command, so you can search without an AI client:

node dist/cli.js <project-folder> <word> [--whole] [--limit=50]

It prints the total number of matches, the files with the most matches, and each hit with its line number and enclosing function.

Known limitations
Imports through path aliases like @/components/Button aren’t resolved yet.
Method calls on a variable (svc.place()) are reported as low-confidence name-match.
Only top-level functions and class methods are listed as symbols, not nested functions.
Types and interfaces aren’t tracked as usages.
Dynamic code can’t be seen by static analysis.
Setup

It needs Node.js 22.13 or newer. Build it with npm install and npm run build. Then add one entry to the AI client’s config, pointing to dist/index.js and passing the project folder as the second argument.