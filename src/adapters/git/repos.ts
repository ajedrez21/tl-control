import { readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

export interface RepoSnapshot {
  repoId: string;
  path: string;
  available: boolean;
  sha: string | null;
  baseRef: string;
  error?: string;
}

export function inspectRepo(repoId: string, localPath: string, baseRef: string): RepoSnapshot {
  if (!localPath || !existsSync(localPath)) {
    return { repoId, path: localPath, available: false, sha: null, baseRef, error: "Ruta no configurada o inaccesible" };
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: localPath, encoding: "utf8" }).trim();
    return { repoId, path: localPath, available: true, sha, baseRef };
  } catch (error) {
    return { repoId, path: localPath, available: false, sha: null, baseRef, error: String(error) };
  }
}

export function searchCandidates(
  localPath: string,
  needles: string[],
  maxFiles = 40
): Array<{ path: string; verified: boolean; sha: string }> {
  if (!localPath || !existsSync(localPath)) return [];
  const hits: Array<{ path: string; verified: boolean; sha: string }> = [];
  walk(localPath, localPath, (abs, rel) => {
    if (hits.length >= maxFiles) return;
    if (!/\.(ts|tsx|js|jsx|cs|sql|json)$/i.test(rel)) return;
    const text = readFileSync(abs, "utf8");
    if (needles.some((n) => n && text.toLowerCase().includes(n.toLowerCase()))) {
      const sha = createHash("sha256").update(text).digest("hex");
      hits.push({ path: rel.replaceAll("\\", "/"), verified: true, sha });
    }
  });
  return hits;
}

function walk(root: string, dir: string, visit: (abs: string, rel: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, visit);
    else if (entry.isFile()) {
      try {
        if (statSync(abs).size > 800_000) continue;
      } catch {
        continue;
      }
      visit(abs, relative(root, abs));
    }
  }
}
