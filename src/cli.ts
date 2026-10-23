import path from "node:path";
import { statSync } from "node:fs";
import { SymbolIndex } from "./symbol-index.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.startsWith("--limit=")));
const limitArg = args.find((a) => a.startsWith("--limit="));
const positional = args.filter((a) => !a.startsWith("--"));
const [rawRoot, ...words] = positional;
const query = words.join(" ");

if (!rawRoot || !query) {
  console.log("Usage: node dist/cli.js <project-folder> <word> [--whole] [--limit=50]");
  process.exit(1);
}
const root = path.resolve(rawRoot);
try {
  if (!statSync(root).isDirectory()) throw new Error();
} catch {
  console.log(`Project folder not found: ${root}`);
  process.exit(1);
}

const index = new SymbolIndex(root);
await index.ensureFresh();
const r = index.searchCode(query, {
  wholeWord: flags.has("--whole"),
  limit: limitArg ? Number(limitArg.split("=")[1]) || 30 : 30,
});

if (r.totalMatches === 0) {
  console.log(`No matches for "${query}".`);
  process.exit(0);
}
console.log(
  `\n"${query}": ${r.totalMatches}${r.capped ? "+" : ""} matches in ${r.filesWithMatches} files\n`
);
console.log("Most matches:");
for (const f of r.byFile.slice(0, 8)) console.log(`  ${String(f.count).padStart(4)}  ${f.file}`);
console.log("");
let lastFile = "";
for (const h of r.results) {
  if (h.file !== lastFile) { console.log(h.file); lastFile = h.file; }
  const where = h.inSymbol ? `  [in ${h.inSymbol}]` : "";
  console.log(`  ${String(h.line).padStart(5)}: ${h.isDefinition ? "(def) " : ""}${h.text}${where}`);
}
if (r.truncated) console.log(`\n...showing ${r.returned} of ${r.totalMatches}. Use --limit=100 for more.`);