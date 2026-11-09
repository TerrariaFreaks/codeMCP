import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 1_000_000; // refuse files larger than ~1 MB
const MAX_LINE_CHARS = 600; // cut absurdly long lines (minified code)
export const MAX_LINES_PER_CALL = 400;

// Files and folders that commonly hold secrets are never readable.
const BLOCKED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);
const SECRET_FILE_PATTERNS = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production ...
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc)$/i,
  /^credentials(\..+)?$/i,
  /^secrets?(\..+)?$/i,
  /service-?account.*\.json$/i,
];
const SAFE_ENV_TEMPLATE = /^\.env\.(example|sample|template|defaults)$/i;

export function isBlockedPath(relPosix: string): boolean {
  const parts = relPosix.split("/").filter(Boolean);
  if (parts.some((p) => BLOCKED_DIRS.has(p.toLowerCase()))) return true;
  const base = parts[parts.length - 1] ?? "";
  if (SAFE_ENV_TEMPLATE.test(base)) return false;
  return SECRET_FILE_PATTERNS.some((re) => re.test(base));
}

export type ReadResult =
  | {
      ok: true;
      file: string;
      totalLines: number;
      startLine: number;
      endLine: number;
      truncated: boolean;
      nextStartLine: number | null;
      text: string; // line-numbered source
    }
  | { ok: false; message: string };

const fail = (message: string): ReadResult => ({ ok: false, message });

/** Binary if the start contains a zero byte or lots of invalid UTF-8. */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return true;
  const sample = head.toString("utf8");
  const bad = (sample.match(/\uFFFD/g) ?? []).length;
  return sample.length > 0 && bad / sample.length > 0.01;
}

/** Read a file (or a line range) from inside the project, safely. */
export async function readProjectFile(
  root: string,
  relPath: string,
  startLine?: number,
  endLine?: number,
  maxLines: number = MAX_LINES_PER_CALL
): Promise<ReadResult> {
  if (!relPath || !relPath.trim()) return fail("A file path is required.");

  const full = path.resolve(root, relPath);
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return fail("Path must be a file inside the project folder.");
  }
  const relPosix = rel.split(path.sep).join("/");
  if (isBlockedPath(relPosix)) {
    return fail(`Reading "${relPosix}" is blocked because it may contain secrets (keys, credentials, .env files).`);
  }

  // Resolve symbolic links so a link inside the project cannot point outside it.
  let realRoot: string;
  let realFull: string;
  try {
    realRoot = await realpath(root);
    realFull = await realpath(full);
  } catch {
    return fail(`File not found: ${relPosix}`);
  }
  const realRel = path.relative(realRoot, realFull);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    return fail("Path resolves to a location outside the project folder.");
  }
  if (isBlockedPath(realRel.split(path.sep).join("/"))) {
    return fail(`Reading "${relPosix}" is blocked because it may contain secrets.`);
  }

  const st = await stat(realFull);
  if (!st.isFile()) return fail(`Not a file: ${relPosix}`);
  if (st.size > MAX_BYTES) {
    return fail(`File is too large to read (${Math.round(st.size / 1024)} KB, limit ${Math.round(MAX_BYTES / 1000)} KB).`);
  }
  const buf = await readFile(realFull);
  if (looksBinary(buf)) return fail(`Binary file, not shown: ${relPosix}`);

  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  const total = lines.length;
  if (total === 0) {
    return { ok: true, file: relPosix, totalLines: 0, startLine: 0, endLine: 0, truncated: false, nextStartLine: null, text: "(empty file)" };
  }

  const start = startLine ?? 1;
  if (start > total) return fail(`startLine ${start} is beyond the end of the file (${total} lines).`);
  const wantedEnd = Math.min(endLine ?? total, total);
  if (wantedEnd < start) return fail("endLine must be greater than or equal to startLine.");
  const end = Math.min(wantedEnd, start + maxLines - 1);

  const width = String(end).length;
  const text = lines
    .slice(start - 1, end)
    .map((line, i) => {
      const shown = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + " ...[line cut]" : line;
      return `${String(start + i).padStart(width)}| ${shown}`;
    })
    .join("\n");

  return {
    ok: true,
    file: relPosix,
    totalLines: total,
    startLine: start,
    endLine: end,
    truncated: end < wantedEnd,
    nextStartLine: end < total ? end + 1 : null,
    text,
  };
}

/** Plain-text rendering used by the tools. */
export function formatRead(r: Extract<ReadResult, { ok: true }>): string {
  const header = r.totalLines === 0
    ? `${r.file} (empty)`
    : `${r.file}  (lines ${r.startLine}-${r.endLine} of ${r.totalLines})`;
  const tail = r.truncated && r.nextStartLine
    ? `\n[Output limited to ${MAX_LINES_PER_CALL} lines. Call again with startLine=${r.nextStartLine} to continue.]`
    : "";
  return `${header}\n${r.text}${tail}`;
}