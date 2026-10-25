import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import path from "node:path";

export interface SymbolInfo {
  name: string;
  kind: string; // function | class | method | interface | type | enum
  startLine: number; // 1-based
  endLine: number;
  parent?: string; // class name for methods
  exported: boolean;
}

export interface ImportInfo {
  specifier: string; // './utils' or 'express'
  localName: string | null; // name used in this file (null for side-effect imports)
  importedName: string | null; // 'default', '*', or the original exported name
  kind: "import" | "reexport" | "require" | "dynamic";
  line: number;
}

export interface CallInfo {
  callee: string;
  object: string | null; // null = plain call; 'this' | 'super' | identifier | '*' (complex)
  kind: "call" | "new" | "jsx" | "ref"; // ref = passed as an argument (callback, route handler)
  line: number;
  caller: string | null; // enclosing function/method name
  callerParent: string | null; // enclosing class name
}

export interface FileAnalysis {
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  calls: CallInfo[];
  defaultExport: string | null;
}

const require = createRequire(import.meta.url);
const wasmDir = path.join(
  path.dirname(require.resolve("tree-sitter-wasms/package.json")),
  "out"
);

const GRAMMAR_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

let initPromise: Promise<void> | null = null;
const languages = new Map<string, Parser.Language>();
const parsers = new Map<string, Parser>();

async function getParser(ext: string): Promise<Parser | null> {
  const grammar = GRAMMAR_BY_EXT[ext];
  if (!grammar) return null;
  initPromise ??= Parser.init();
  await initPromise;
  let lang = languages.get(grammar);
  if (!lang) {
    lang = await Parser.Language.load(path.join(wasmDir, `tree-sitter-${grammar}.wasm`));
    languages.set(grammar, lang);
  }
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(lang);
    parsers.set(grammar, parser);
  }
  return parser;
}

const DECLARATION_KINDS: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

// Calls on these objects are noise (console.log, Math.max, JSON.parse ...)
const IGNORED_OBJECTS = new Set([
  "console", "Math", "JSON", "Object", "Array", "Promise", "process",
  "Number", "String", "Date", "Reflect", "Symbol", "Boolean",
]);

function stringValue(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node || node.type !== "string") return null;
  return node.text.slice(1, -1);
}

export async function analyzeFile(source: string, ext: string): Promise<FileAnalysis | null> {
  const parser = await getParser(ext);
  if (!parser) return null;
  const tree = parser.parse(source);

  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const rawCalls: Omit<CallInfo, "caller" | "callerParent">[] = [];
  let defaultExport: string | null = null;

  // ---------- Pass 1: symbols (top-level declarations and class methods) ----------
  const addSymbol = (node: Parser.SyntaxNode, name: string, kind: string, exported: boolean, parent?: string) => {
    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(parent ? { parent } : {}),
      exported,
    });
  };

  const visitTop = (node: Parser.SyntaxNode, exported: boolean) => {
    const kind = DECLARATION_KINDS[node.type];
    if (kind) {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      addSymbol(node, name, kind, exported);
      if (kind === "class") {
        const body = node.childForFieldName("body");
        for (const member of body?.namedChildren ?? []) {
          if (member.type === "method_definition") {
            const mName = member.childForFieldName("name")?.text ?? "(anonymous)";
            addSymbol(member, mName, "method", exported, name);
          }
        }
      }
      return;
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const value = decl.childForFieldName("value");
        const nameNode = decl.childForFieldName("name");
        if (!nameNode) continue;
        if (value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function")) {
          addSymbol(node, nameNode.text, "function", exported);
        }
      }
      return;
    }
    if (node.type === "export_statement") {
      for (const child of node.namedChildren) visitTop(child, true);
    }
  };
  for (const child of tree.rootNode.namedChildren) visitTop(child, false);

  // ---------- Pass 2: imports, calls, default export (whole tree) ----------
  const addImport = (
    specifier: string,
    localName: string | null,
    importedName: string | null,
    kind: ImportInfo["kind"],
    line: number
  ) => imports.push({ specifier, localName, importedName, kind, line });

  const addCall = (callee: string, object: string | null, kind: CallInfo["kind"], line: number) =>
    rawCalls.push({ callee, object, kind, line });

  const objectLabel = (obj: Parser.SyntaxNode | null): string =>
    obj && (obj.type === "identifier" || obj.type === "this" || obj.type === "super") ? obj.text : "*";

  const handleImportStatement = (node: Parser.SyntaxNode) => {
    const spec = stringValue(node.childForFieldName("source"));
    if (spec === null) return;
    const line = node.startPosition.row + 1;
    let any = false;
    for (const child of node.namedChildren) {
      if (child.type !== "import_clause") continue;
      for (const c of child.namedChildren) {
        if (c.type === "identifier") {
          addImport(spec, c.text, "default", "import", line);
          any = true;
        } else if (c.type === "namespace_import") {
          const id = c.namedChildren.find((x) => x.type === "identifier");
          if (id) { addImport(spec, id.text, "*", "import", line); any = true; }
        } else if (c.type === "named_imports") {
          for (const s of c.namedChildren) {
            if (s.type !== "import_specifier") continue;
            const n = s.childForFieldName("name");
            const a = s.childForFieldName("alias");
            if (n) { addImport(spec, (a ?? n).text, n.text, "import", line); any = true; }
          }
        }
      }
    }
    if (!any) addImport(spec, null, null, "import", line);
  };

  const handleExportStatement = (node: Parser.SyntaxNode) => {
    const spec = stringValue(node.childForFieldName("source"));
    if (spec !== null) {
      const line = node.startPosition.row + 1;
      let any = false;
      for (const c of node.namedChildren) {
        if (c.type === "export_clause") {
          for (const s of c.namedChildren) {
            if (s.type !== "export_specifier") continue;
            const n = s.childForFieldName("name");
            const a = s.childForFieldName("alias");
            if (n) { addImport(spec, (a ?? n).text, n.text, "reexport", line); any = true; }
          }
        }
      }
      if (!any) addImport(spec, "*", "*", "reexport", line);
    }
    if (node.children.some((c) => c.type === "default")) {
      const decl = node.childForFieldName("declaration");
      const value = node.childForFieldName("value");
      if (decl) {
        const n = decl.childForFieldName("name")?.text;
        if (n) defaultExport = n;
      } else if (value && value.type === "identifier") {
        defaultExport = value.text;
      }
    }
  };

  const handleRequire = (node: Parser.SyntaxNode, spec: string, line: number) => {
    const parent = node.parent;
    const isInit = parent?.type === "variable_declarator" && parent.childForFieldName("value")?.id === node.id;
    if (!isInit || !parent) { addImport(spec, null, null, "require", line); return; }
    const nameNode = parent.childForFieldName("name");
    if (nameNode?.type === "identifier") {
      addImport(spec, nameNode.text, "*", "require", line);
    } else if (nameNode?.type === "object_pattern") {
      let any = false;
      for (const p of nameNode.namedChildren) {
        if (p.type === "shorthand_property_identifier_pattern") {
          addImport(spec, p.text, p.text, "require", line); any = true;
        } else if (p.type === "pair_pattern") {
          const k = p.childForFieldName("key");
          const v = p.childForFieldName("value");
          if (k && v?.type === "identifier") { addImport(spec, v.text, k.text, "require", line); any = true; }
        }
      }
      if (!any) addImport(spec, null, null, "require", line);
    } else {
      addImport(spec, null, null, "require", line);
    }
  };

  const handleCall = (node: Parser.SyntaxNode) => {
    const fn = node.childForFieldName("function");
    if (!fn) return;
    const args = node.childForFieldName("arguments");
    const line = node.startPosition.row + 1;

    if (fn.type === "import") {
      const spec = stringValue(args?.namedChild(0));
      if (spec !== null) addImport(spec, null, null, "dynamic", line);
      return;
    }
    if (fn.type === "identifier" && fn.text === "require") {
      const spec = stringValue(args?.namedChild(0));
      if (spec !== null) { handleRequire(node, spec, line); return; }
    }

    let callee: string;
    let object: string | null = null;
    if (fn.type === "identifier") {
      callee = fn.text;
    } else if (fn.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      if (!prop) return;
      callee = prop.text;
      object = objectLabel(fn.childForFieldName("object"));
      if (IGNORED_OBJECTS.has(object)) return;
    } else {
      return;
    }
    if (callee === "require") return;
    addCall(callee, object, "call", line);

    // Things passed as arguments: callbacks, route handlers, middleware
    for (const a of args?.namedChildren ?? []) {
      if (a.type === "identifier" && a.text !== "undefined") {
        addCall(a.text, null, "ref", a.startPosition.row + 1);
      } else if (a.type === "member_expression") {
        const o = a.childForFieldName("object");
        const p = a.childForFieldName("property");
        if (o?.type === "identifier" && p) addCall(p.text, o.text, "ref", a.startPosition.row + 1);
      }
    }
  };

  const handleNew = (node: Parser.SyntaxNode) => {
    const c = node.childForFieldName("constructor");
    const line = node.startPosition.row + 1;
    if (c?.type === "identifier") {
      addCall(c.text, null, "new", line);
    } else if (c?.type === "member_expression") {
      const prop = c.childForFieldName("property");
      if (prop) addCall(prop.text, objectLabel(c.childForFieldName("object")), "new", line);
    }
  };

  const handleJsx = (node: Parser.SyntaxNode) => {
    const name = node.childForFieldName("name");
    if (name?.type === "identifier" && /^[A-Z]/.test(name.text)) {
      addCall(name.text, null, "jsx", node.startPosition.row + 1);
    }
  };

  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "import_statement": handleImportStatement(node); break;
      case "export_statement": handleExportStatement(node); break;
      case "call_expression": handleCall(node); break;
      case "new_expression": handleNew(node); break;
      case "jsx_opening_element":
      case "jsx_self_closing_element": handleJsx(node); break;
      case "assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.text === "module.exports" && right?.type === "identifier") defaultExport = right.text;
        break;
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }

  // Attribute each call to the smallest enclosing function/class/method
  const calls: CallInfo[] = rawCalls.map((c) => {
    let best: SymbolInfo | null = null;
    for (const s of symbols) {
      if (s.startLine <= c.line && c.line <= s.endLine) {
        if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
      }
    }
    return { ...c, caller: best?.name ?? null, callerParent: best?.parent ?? null };
  });

  tree.delete();
  return { symbols, imports, calls, defaultExport };
}

/** Symbols only (used by get_file_outline). */
export async function extractSymbols(source: string, ext: string): Promise<SymbolInfo[] | null> {
  const analysis = await analyzeFile(source, ext);
  return analysis ? analysis.symbols : null;
}