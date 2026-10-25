import path from "node:path";

export interface SymRow {
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  parent: string | null;
  exported: number;
}
export interface ImportRow {
  file: string;
  specifier: string;
  localName: string | null;
  importedName: string | null;
  kind: string;
  line: number;
}
export interface CallRow {
  file: string;
  caller: string | null;
  callerParent: string | null;
  callee: string;
  object: string | null;
  kind: string;
  line: number;
}
export interface GraphRows {
  files: string[];
  symbols: SymRow[];
  imports: ImportRow[];
  calls: CallRow[];
  defaults: { file: string; name: string }[];
}

export interface CallerHit {
  file: string;
  symbol: string | null; // e.g. "OrderService.place", null = top level of the file
  callerName: string | null;
  line: number;
  kind: string;
  confidence: "resolved" | "name-match";
  targetFile: string | null;
}

type Resolution =
  | { type: "internal"; file: string }
  | { type: "external"; pkg: string }
  | { type: "unresolved" };

interface ResolvedCall extends CallerHit {
  targetName: string;
}

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//;

export const isTestFile = (f: string) => TEST_RE.test(f);

function packageName(spec: string): string {
  if (spec.startsWith("node:")) return spec;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export class CodeGraph {
  private fileSet: Set<string>;
  private symbolsByFile = new Map<string, SymRow[]>();
  private symbolsByName = new Map<string, SymRow[]>();
  private defaultName = new Map<string, string>();
  private resolveCache = new Map<string, Resolution>();
  private localImports = new Map<string, Map<string, { resolved: string | null; imported: string }>>();
  private reexports = new Map<string, ImportRow[]>();
  private forward = new Map<string, Set<string>>();
  private reverse = new Map<string, Set<string>>();
  private externalUse = new Map<string, Set<string>>();
  private byTargetName = new Map<string, ResolvedCall[]>();

  constructor(rows: GraphRows) {
    this.fileSet = new Set(rows.files);
    for (const f of rows.files) { this.forward.set(f, new Set()); this.reverse.set(f, new Set()); }
    for (const d of rows.defaults) this.defaultName.set(d.file, d.name);
    for (const s of rows.symbols) {
      (this.symbolsByFile.get(s.file) ?? this.symbolsByFile.set(s.file, []).get(s.file)!).push(s);
      (this.symbolsByName.get(s.name) ?? this.symbolsByName.set(s.name, []).get(s.name)!).push(s);
    }

    for (const imp of rows.imports) {
      const res = this.resolveSpecifier(imp.file, imp.specifier);
      if (res.type === "internal") {
        this.forward.get(imp.file)!.add(res.file);
        this.reverse.get(res.file)!.add(imp.file);
      } else if (res.type === "external") {
        (this.externalUse.get(res.pkg) ?? this.externalUse.set(res.pkg, new Set()).get(res.pkg)!).add(imp.file);
      }
      if (imp.kind === "reexport") {
        (this.reexports.get(imp.file) ?? this.reexports.set(imp.file, []).get(imp.file)!).push(imp);
      } else if (imp.localName) {
        let m = this.localImports.get(imp.file);
        if (!m) { m = new Map(); this.localImports.set(imp.file, m); }
        m.set(imp.localName, {
          resolved: res.type === "internal" ? res.file : null,
          imported: imp.importedName ?? "*",
        });
      }
    }

    for (const c of rows.calls) {
      const target = this.resolveCall(c);
      if (!target) continue;
      const rc: ResolvedCall = {
        file: c.file,
        symbol: c.caller ? `${c.callerParent ? c.callerParent + "." : ""}${c.caller}` : null,
        callerName: c.caller,
        line: c.line,
        kind: c.kind,
        confidence: target.confidence,
        targetFile: target.file,
        targetName: target.name,
      };
      (this.byTargetName.get(target.name) ?? this.byTargetName.set(target.name, []).get(target.name)!).push(rc);
    }
  }

  // ---------- import resolution ----------
  private resolveSpecifier(from: string, spec: string): Resolution {
    const key = `${from}\u0000${spec}`;
    const cached = this.resolveCache.get(key);
    if (cached) return cached;
    let result: Resolution;
    if (!spec.startsWith(".")) {
      result = { type: "external", pkg: packageName(spec) };
    } else {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      const candidates = [base];
      const m = base.match(/\.[cm]?jsx?$/);
      if (m) {
        const stem = base.slice(0, -m[0].length);
        candidates.push(stem + ".ts", stem + ".tsx"); // TS style: import "./x.js" -> x.ts
      }
      for (const e of EXTS) candidates.push(base + e);
      for (const e of EXTS) candidates.push(`${base}/index${e}`);
      const found = candidates.find((c) => this.fileSet.has(c));
      result = found ? { type: "internal", file: found } : { type: "unresolved" };
    }
    this.resolveCache.set(key, result);
    return result;
  }

  private hasSymbol(file: string, name: string): boolean {
    return (this.symbolsByFile.get(file) ?? []).some((s) => s.name === name);
  }

  /** Follow `export { x } from './y'` chains (barrel files) to the real definition. */
  private followReexport(file: string, name: string, depth = 0): { file: string; name: string } {
    if (depth > 5 || this.hasSymbol(file, name)) return { file, name };
    for (const r of this.reexports.get(file) ?? []) {
      if (r.localName !== name && r.localName !== "*") continue;
      const res = this.resolveSpecifier(file, r.specifier);
      if (res.type !== "internal") continue;
      let n = r.localName === "*" ? name : (r.importedName ?? name);
      if (n === "default") n = this.defaultName.get(res.file) ?? name;
      const out = this.followReexport(res.file, n, depth + 1);
      if (this.hasSymbol(out.file, out.name)) return out;
    }
    return { file, name };
  }

  private resolveImportedName(resolvedFile: string, imported: string, localName: string) {
    let name = imported;
    if (name === "default" || name === "*") name = this.defaultName.get(resolvedFile) ?? localName;
    return this.followReexport(resolvedFile, name);
  }

  private resolveCall(c: CallRow): { file: string | null; name: string; confidence: "resolved" | "name-match" } | null {
    const imports = this.localImports.get(c.file);
    const isRef = c.kind === "ref";

    if (c.object === null) {
      const imp = imports?.get(c.callee);
      if (imp) {
        if (!imp.resolved) return null; // function from an npm package
        const t = this.resolveImportedName(imp.resolved, imp.imported, c.callee);
        return { file: t.file, name: t.name, confidence: "resolved" };
      }
      if (this.hasSymbol(c.file, c.callee)) return { file: c.file, name: c.callee, confidence: "resolved" };
      if (isRef) return null;
      return { file: null, name: c.callee, confidence: "name-match" };
    }

    if (c.object === "this") {
      if (c.callerParent) return { file: c.file, name: c.callee, confidence: "resolved" };
      return isRef ? null : { file: null, name: c.callee, confidence: "name-match" };
    }
    if (c.object === "super" || c.object === "*") {
      return isRef ? null : { file: null, name: c.callee, confidence: "name-match" };
    }

    const imp = imports?.get(c.object);
    if (imp) {
      if (!imp.resolved) return null; // axios.get(), express.Router() ...
      const t = this.followReexport(imp.resolved, c.callee);
      return { file: t.file, name: t.name, confidence: "resolved" };
    }
    if (this.hasSymbol(c.file, c.object)) return { file: c.file, name: c.callee, confidence: "resolved" };
    return isRef ? null : { file: null, name: c.callee, confidence: "name-match" };
  }

  // ---------- lookups ----------
  resolveFileArg(input: string): { ok: true; file: string } | { ok: false; message: string } {
    const norm = input.replace(/\\/g, "/").replace(/^\.\//, "");
    if (this.fileSet.has(norm)) return { ok: true, file: norm };
    const matches = [...this.fileSet].filter((f) => f.endsWith("/" + norm));
    if (matches.length === 1) return { ok: true, file: matches[0] };
    if (matches.length > 1) {
      return { ok: false, message: `"${input}" matches several files, be more specific: ${matches.slice(0, 8).join(", ")}` };
    }
    const lower = norm.toLowerCase();
    const similar = [...this.fileSet].filter((f) => f.toLowerCase().includes(lower)).slice(0, 8);
    return {
      ok: false,
      message: `File not found in the index: ${input}.` + (similar.length ? ` Similar: ${similar.join(", ")}` : ""),
    };
  }

  definitionsOf(name: string, file?: string): SymRow[] {
    return (this.symbolsByName.get(name) ?? []).filter((s) => !file || s.file === file);
  }

  callersOf(name: string, file?: string): CallerHit[] {
    const out: CallerHit[] = [];
    for (const rc of this.byTargetName.get(name) ?? []) {
      if (file && rc.confidence === "resolved" && rc.targetFile !== file) continue;
      const { targetName: _t, ...hit } = rc;
      out.push(hit);
    }
    return out.sort(
      (a, b) =>
        (a.confidence === b.confidence ? 0 : a.confidence === "resolved" ? -1 : 1) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    );
  }

  // ---------- dependency graph ----------
  private bfs(start: string, adj: Map<string, Set<string>>, depth: number) {
    const seen = new Set([start]);
    const out: { file: string; depth: number }[] = [];
    let frontier = [start];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const n of [...(adj.get(f) ?? [])].sort()) {
          if (seen.has(n)) continue;
          seen.add(n);
          out.push({ file: n, depth: d });
          next.push(n);
        }
      }
      frontier = next;
    }
    return out;
  }

  fileDependencies(file: string, direction: "imports" | "importedBy" | "both", depth: number) {
    const externals = new Set<string>();
    for (const [pkg, files] of this.externalUse) if (files.has(file)) externals.add(pkg);
    return {
      file,
      imports: direction === "importedBy" ? undefined : this.bfs(file, this.forward, depth),
      importedBy: direction === "imports" ? undefined : this.bfs(file, this.reverse, depth),
      externalPackages: direction === "importedBy" ? undefined : [...externals].sort(),
    };
  }

  overview() {
    const top = (m: Map<string, Set<string>>) =>
      [...m.entries()]
        .map(([file, s]) => ({ file, count: s.size }))
        .filter((x) => x.count > 0)
        .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
        .slice(0, 10);
    let edges = 0;
    for (const s of this.forward.values()) edges += s.size;
    return {
      totalFiles: this.fileSet.size,
      internalImportEdges: edges,
      mostImportedFiles: top(this.reverse).map((x) => ({ file: x.file, importedByCount: x.count })),
      filesWithMostImports: top(this.forward).map((x) => ({ file: x.file, importsCount: x.count })),
      externalPackages: [...this.externalUse.entries()]
        .map(([pkg, files]) => ({ package: pkg, usedInFiles: files.size }))
        .sort((a, b) => b.usedInFiles - a.usedInFiles || a.package.localeCompare(b.package))
        .slice(0, 20),
      circularDependencies: this.findCycles(5),
    };
  }

  /** Strongly connected components with more than one file = import cycles (Tarjan). */
  private findCycles(max: number): string[][] {
    let counter = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const cycles: string[][] = [];
    const strong = (v: string) => {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of this.forward.get(v) ?? []) {
        if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
        const selfLoop = comp.length === 1 && this.forward.get(comp[0])!.has(comp[0]);
        if (comp.length > 1 || selfLoop) cycles.push(comp.sort());
      }
    };
    for (const f of [...this.fileSet].sort()) if (!index.has(f)) strong(f);
    return cycles.sort((a, b) => b.length - a.length).slice(0, max);
  }

  // ---------- change impact ----------
  impact(opts: { name?: string; file?: string; depth: number }) {
    const CAP = 150;
    const defs = opts.name ? this.definitionsOf(opts.name, opts.file) : [];
    const targetFiles = new Set<string>();
    if (opts.file) targetFiles.add(opts.file);
    for (const d of defs) targetFiles.add(d.file);

    const callers: (CallerHit & { depth: number })[] = [];
    const seenHits = new Set<string>();
    const expanded = new Set<string>();
    let truncated = false;
    let frontier: { name: string; file: string | null }[] = opts.name ? [{ name: opts.name, file: opts.file ?? null }] : [];

    for (let d = 1; d <= opts.depth && frontier.length; d++) {
      const next: { name: string; file: string | null }[] = [];
      for (const t of frontier) {
        for (const h of this.callersOf(t.name, t.file ?? undefined)) {
          if (d > 1 && h.confidence !== "resolved") continue; // only follow solid links deeper
          const key = `${h.file}|${h.symbol}|${h.line}|${h.kind}`;
          if (seenHits.has(key)) continue;
          seenHits.add(key);
          if (callers.length >= CAP) { truncated = true; continue; }
          callers.push({ ...h, depth: d });
          if (h.callerName) {
            const ek = `${h.file}|${h.symbol}`;
            if (!expanded.has(ek)) { expanded.add(ek); next.push({ name: h.callerName, file: h.file }); }
          }
        }
      }
      frontier = next;
    }

    const importerDepth = new Map<string, number>();
    for (const tf of targetFiles) {
      for (const r of this.bfs(tf, this.reverse, opts.depth)) {
        const cur = importerDepth.get(r.file);
        if (cur === undefined || r.depth < cur) importerDepth.set(r.file, r.depth);
      }
    }
    for (const tf of targetFiles) importerDepth.delete(tf);
    const importers = [...importerDepth.entries()]
      .map(([file, depth]) => ({ file, depth }))
      .sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));

    const affected = new Set<string>([...callers.map((c) => c.file), ...importers.map((i) => i.file)]);
    for (const tf of targetFiles) affected.delete(tf);

    return {
      definitions: defs,
      targetFiles: [...targetFiles],
      callers,
      importers,
      affectedFiles: [...affected].sort(),
      testsLikelyAffected: [...affected].filter(isTestFile).sort(),
      truncated,
    };
  }
}