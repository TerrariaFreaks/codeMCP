import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { walkProject } from "./walk.js";
import { analyzeFile } from "./parse.js";
import { CodeGraph } from "./graph.js";

const MAX_FILE_BYTES = 1_000_000; // skip huge generated files
const MAX_LINE_CHARS = 300; // long minified lines are cut for indexing
const SCHEMA_VERSION = 3;
const CANDIDATE_CAP = 5000;

export interface SymbolRow {
  name: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  parent: string | null;
  exported: boolean;
}

export interface CodeHit {
  file: string;
  line: number;
  text: string;
  inSymbol: string | null;
  isDefinition: boolean;
}

export interface CodeSearchResult {
  query: string;
  totalMatches: number;
  capped: boolean;
  filesWithMatches: number;
  byFile: { file: string; count: number }[];
  returned: number;
  truncated: boolean;
  results: CodeHit[];
}

export class SymbolIndex {
  private db: DatabaseSync;
  private running: Promise<void> | null = null;
  private lastRun = 0;
  private graphCache: CodeGraph | null = null;
  readonly dbPath: string;

  constructor(private root: string) {
    // Store the index outside the user's project, keyed by project path
    const key = createHash("sha1").update(root).digest("hex").slice(0, 12);
    const dir = path.join(os.homedir(), ".codebase-mcp");
    mkdirSync(dir, { recursive: true });
    this.dbPath = path.join(dir, `${key}.sqlite`);
    this.db = new DatabaseSync(this.dbPath);

    // If the schema is older, throw the old index away and rebuild it
    const version = (this.db.prepare("PRAGMA user_version").get() as any).user_version as number;
    if (version < SCHEMA_VERSION) {
      this.db.exec(
        "DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS lines; " +
          "DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS calls; DROP TABLE IF EXISTS default_exports;"
      );
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        parent TEXT, exported INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
      CREATE VIRTUAL TABLE IF NOT EXISTS lines USING fts5(
        file UNINDEXED, line_no UNINDEXED, text, tokenize = 'trigram'
      );
      CREATE TABLE IF NOT EXISTS imports (
        file TEXT NOT NULL, specifier TEXT NOT NULL, local_name TEXT,
        imported_name TEXT, kind TEXT NOT NULL, line INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file);
      CREATE TABLE IF NOT EXISTS calls (
        file TEXT NOT NULL, caller TEXT, caller_parent TEXT, callee TEXT NOT NULL,
        object TEXT, kind TEXT NOT NULL, line INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(file);
      CREATE TABLE IF NOT EXISTS default_exports (file TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);
  }

  /** Re-scan the project, but only re-parse files that changed. */
  ensureFresh(): Promise<void> {
    if (this.running) return this.running;
    if (Date.now() - this.lastRun < 5000) return Promise.resolve();
    this.running = this.refresh().finally(() => {
      this.running = null;
      this.lastRun = Date.now();
    });
    return this.running;
  }

  private async refresh(): Promise<void> {
    const files = await walkProject(this.root);
    const known = new Map<string, { mtime_ms: number; size: number }>();
    for (const r of this.db.prepare("SELECT path, mtime_ms, size FROM files").all() as any[]) {
      known.set(r.path, { mtime_ms: r.mtime_ms, size: r.size });
    }

    const delSymbols = this.db.prepare("DELETE FROM symbols WHERE file = ?");
    const delLines = this.db.prepare("DELETE FROM lines WHERE file = ?");
    const delImports = this.db.prepare("DELETE FROM imports WHERE file = ?");
    const delCalls = this.db.prepare("DELETE FROM calls WHERE file = ?");
    const delDefault = this.db.prepare("DELETE FROM default_exports WHERE file = ?");
    const insImport = this.db.prepare(
      "INSERT INTO imports (file, specifier, local_name, imported_name, kind, line) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insCall = this.db.prepare(
      "INSERT INTO calls (file, caller, caller_parent, callee, object, kind, line) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const insDefault = this.db.prepare("INSERT INTO default_exports (file, name) VALUES (?, ?)");
    const delFile = this.db.prepare("DELETE FROM files WHERE path = ?");
    const insSymbol = this.db.prepare(
      "INSERT INTO symbols (file, name, kind, start_line, end_line, parent, exported) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const insLine = this.db.prepare("INSERT INTO lines (file, line_no, text) VALUES (?, ?, ?)");
    const upsertFile = this.db.prepare(
      "INSERT INTO files (path, mtime_ms, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size"
    );

    const seen = new Set(files);
    let parsed = 0, skipped = 0, failed = 0, removed = 0;

    for (const rel of files) {
      const full = path.join(this.root, rel);
      try {
        const st = await stat(full);
        const old = known.get(rel);
        if (old && old.mtime_ms === st.mtimeMs && old.size === st.size) { skipped++; continue; }

        const tooBig = st.size > MAX_FILE_BYTES;
        const source = tooBig ? "" : await readFile(full, "utf8");
        const analysis = tooBig ? null : await analyzeFile(source, path.extname(rel));
        const symbols = analysis?.symbols ?? [];

        this.db.exec("BEGIN");
        if (old) {
          delSymbols.run(rel); delLines.run(rel);
          delImports.run(rel); delCalls.run(rel); delDefault.run(rel);
        }
        for (const s of symbols) {
          insSymbol.run(rel, s.name, s.kind, s.startLine, s.endLine, s.parent ?? null, s.exported ? 1 : 0);
        }
        for (const i of analysis?.imports ?? []) {
          insImport.run(rel, i.specifier, i.localName, i.importedName, i.kind, i.line);
        }
        for (const c of analysis?.calls ?? []) {
          insCall.run(rel, c.caller, c.callerParent, c.callee, c.object, c.kind, c.line);
        }
        if (analysis?.defaultExport) insDefault.run(rel, analysis.defaultExport);
        const lines = source.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i].trim();
          if (text) insLine.run(rel, i + 1, text.slice(0, MAX_LINE_CHARS));
        }
        upsertFile.run(rel, st.mtimeMs, st.size);
        this.db.exec("COMMIT");
        parsed++;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch {}
        failed++;
        console.error(`index: failed on ${rel}:`, err);
      }
    }

    // Remove files that no longer exist
    for (const p of known.keys()) {
      if (!seen.has(p)) {
        delSymbols.run(p); delLines.run(p); delFile.run(p);
        delImports.run(p); delCalls.run(p); delDefault.run(p);
        removed++;
      }
    }
    if (parsed > 0 || removed > 0) this.graphCache = null;
    console.error(`index: ${parsed} parsed, ${skipped} unchanged, ${failed} failed`);
  }

  /** Import/call graph, rebuilt only when the index has changed. */
  graph(): CodeGraph {
    if (!this.graphCache) {
      const all = (sql: string) => this.db.prepare(sql).all() as any[];
      this.graphCache = new CodeGraph({
        files: all("SELECT path FROM files").map((r) => r.path as string),
        symbols: all(
          "SELECT file, name, kind, start_line AS startLine, end_line AS endLine, parent, exported FROM symbols"
        ),
        imports: all(
          "SELECT file, specifier, local_name AS localName, imported_name AS importedName, kind, line FROM imports"
        ),
        calls: all(
          "SELECT file, caller, caller_parent AS callerParent, callee, object, kind, line FROM calls"
        ),
        defaults: all("SELECT file, name FROM default_exports"),
      });
    }
    return this.graphCache;
  }

  /** The text of one line, for showing call sites. */
  lineText(file: string, line: number): string | null {
    const r = this.db
      .prepare("SELECT text FROM lines WHERE file = ? AND line_no = ?")
      .get(file, line) as any;
    return r ? (r.text as string).slice(0, 200) : null;
  }

  stats() {
    const f = this.db.prepare("SELECT COUNT(*) AS n FROM files").get() as any;
    const s = this.db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as any;
    return { files: f.n as number, symbols: s.n as number };
  }

  search(query: string, kind: string | undefined, limit: number): { rows: SymbolRow[]; truncated: boolean } {
    const esc = query.replace(/[\\%_]/g, (m) => "\\" + m);
    const sql = `
      SELECT name, kind, file, start_line AS startLine, end_line AS endLine, parent, exported
      FROM symbols
      WHERE name LIKE ? ESCAPE '\\' ${kind ? "AND kind = ?" : ""}
      ORDER BY CASE
        WHEN name = ? COLLATE NOCASE THEN 0
        WHEN name LIKE ? ESCAPE '\\' THEN 1
        ELSE 2 END, name COLLATE NOCASE, file
      LIMIT ?`;
    const params: (string | number)[] = [`%${esc}%`];
    if (kind) params.push(kind);
    params.push(query, `${esc}%`, limit + 1);
    const all = this.db.prepare(sql).all(...params) as any[];
    const rows = all.slice(0, limit).map((r) => ({ ...r, exported: !!r.exported })) as SymbolRow[];
    return { rows, truncated: all.length > limit };
  }

  /** Find every line containing the text, with the function/class it sits in. */
  searchCode(
    query: string,
    opts: { wholeWord?: boolean; pathPrefix?: string; limit?: number } = {}
  ): CodeSearchResult {
    const limit = opts.limit ?? 30;
    const esc = query.replace(/[\\%_]/g, (m) => "\\" + m);
    const params: (string | number)[] = [`%${esc}%`];
    let sql = "SELECT file, line_no AS line, text FROM lines WHERE text LIKE ? ESCAPE '\\'";
    if (opts.pathPrefix) {
      const p = opts.pathPrefix.replace(/\\/g, "/").replace(/[\\%_]/g, (m) => "\\" + m);
      sql += " AND file LIKE ? ESCAPE '\\'";
      params.push(`${p}%`);
    }
    sql += " ORDER BY file, line_no LIMIT ?";
    params.push(CANDIDATE_CAP + 1);

    let rows = this.db.prepare(sql).all(...params) as { file: string; line: number; text: string }[];
    const capped = rows.length > CANDIDATE_CAP;
    if (capped) rows = rows.slice(0, CANDIDATE_CAP);

    if (opts.wholeWord) {
      const re = new RegExp(
        `(?<![A-Za-z0-9_$])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$])`,
        "i"
      );
      rows = rows.filter((r) => re.test(r.text));
    }

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.file, (counts.get(r.file) ?? 0) + 1);
    const byFile = [...counts.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, 15);

    const shown = rows.slice(0, limit);
    const symCache = new Map<string, any[]>();
    const symbolsOf = (file: string) => {
      let list = symCache.get(file);
      if (!list) {
        list = this.db
          .prepare("SELECT name, kind, parent, start_line, end_line FROM symbols WHERE file = ?")
          .all(file) as any[];
        symCache.set(file, list);
      }
      return list;
    };

    const results: CodeHit[] = shown.map((r) => {
      const syms = symbolsOf(r.file);
      let best: any = null;
      for (const s of syms) {
        if (s.start_line <= r.line && r.line <= s.end_line) {
          if (!best || s.end_line - s.start_line < best.end_line - best.start_line) best = s;
        }
      }
      return {
        file: r.file,
        line: r.line,
        text: r.text.slice(0, 200),
        inSymbol: best
          ? `${best.parent ? best.parent + "." : ""}${best.name} (${best.kind}, lines ${best.start_line}-${best.end_line})`
          : null,
        isDefinition: syms.some((s) => s.start_line === r.line && s.name.toLowerCase().includes(query.toLowerCase())),
      };
    });

    return {
      query,
      totalMatches: rows.length,
      capped,
      filesWithMatches: counts.size,
      byFile,
      returned: results.length,
      truncated: rows.length > shown.length,
      results,
    };
  }
}