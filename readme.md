Project goal

Build an MCP server that gives AI assistants a structured understanding of a codebase (functions, classes, imports, callers, history), so they can answer questions about big projects accurately without reading everything.

Final tool list (8 tools)
#	Tool	What it answers	Phase
1	list_project_files	What files exist (junk filtered out)?	2
2	get_file_outline	What functions and classes are in this file, and on which lines?	3
3	search_symbols	Where is something named like auth or createOrder defined?	3
4	find_callers	What calls this function?	4
5	get_dependency_graph	What does this module import, and what imports it?	4
6	change_impact	If I edit this function, what could break?	4
7	code_hotspots	Which files are big, highly connected, and frequently changed (risky)?	5
8	find_unused_code	Which exports are never used anywhere?	5

Tools 7 and 8 are the stretch goals. If time runs short, tools 1 to 6 are already a strong project.

Milestones
Phase 1 (done): hello world server connected to Claude Desktop
Phase 2: folder argument, file walking, list_project_files
Phase 3: tree-sitter parsing, SQLite index, get_file_outline, search_symbols
Phase 4: imports and calls extracted, find_callers, get_dependency_graph, change_impact
Phase 5: incremental re-indexing (only changed files), git history, code_hotspots, find_unused_code
Phase 6: tests, README, demo GIF, publish to npm
Supported languages (to keep scope sane)

Start with JavaScript and TypeScript only, since that’s your stack. Adding Python later is a good bonus, because tree-sitter makes it mostly a matter of adding a new grammar.

Success criteria

You’ll know it works when:

It indexes one of your real MERN projects in under about 30 seconds
Claude correctly answers 10 test questions about that project using your tools (for example, “what calls X?”)
You can show a before/after: the same question asked with and without your server, comparing accuracy and how many files Claude had to read
Someone else can install it with one config line