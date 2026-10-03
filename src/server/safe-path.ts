import { relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";

export function isInsideDir(rootDir: string, targetPath: string): boolean {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return false;
  return existsSync(target) || true;
}

export function assertInsideDir(rootDir: string, targetPath: string): string {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error("PATH_REJECTED");
  }
  return target;
}
