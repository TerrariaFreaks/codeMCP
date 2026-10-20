import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", ".cache",
]);
const IGNORED_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function walkProject(root: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(full);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;
        if (!CODE_EXTENSIONS.has(path.extname(entry.name))) continue;
        // forward slashes so paths look the same on Windows and Mac/Linux
        results.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }

  await visit(root);
  return results.sort();
}