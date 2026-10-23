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

export async function extractSymbols(source: string, ext: string): Promise<SymbolInfo[] | null> {
  const parser = await getParser(ext);
  if (!parser) return null;
  const tree = parser.parse(source);
  const symbols: SymbolInfo[] = [];

  const add = (node: Parser.SyntaxNode, name: string, kind: string, exported: boolean, parent?: string) => {
    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(parent ? { parent } : {}),
      exported,
    });
  };

  const visit = (node: Parser.SyntaxNode, exported: boolean) => {
    const kind = DECLARATION_KINDS[node.type];
    if (kind) {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      add(node, name, kind, exported);
      if (kind === "class") {
        const body = node.childForFieldName("body");
        for (const member of body?.namedChildren ?? []) {
          if (member.type === "method_definition") {
            const mName = member.childForFieldName("name")?.text ?? "(anonymous)";
            add(member, mName, "method", exported, name);
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
          add(node, nameNode.text, "function", exported);
        }
      }
      return;
    }
    if (node.type === "export_statement") {
      for (const child of node.namedChildren) visit(child, true);
    }
  };

  for (const child of tree.rootNode.namedChildren) visit(child, false);
  tree.delete();
  return symbols;
}