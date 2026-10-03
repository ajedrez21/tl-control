import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { get, setMeta } from "./db.ts";
import { nowIso } from "../domain/time.ts";

export function backupDb(dbPath: string, backupsDir: string): string {
  mkdirSync(backupsDir, { recursive: true });
  const stamp = nowIso().replaceAll(":", "").replaceAll(".", "");
  const dest = join(backupsDir, `tl-control-${stamp}.sqlite`);
  copyFileSync(dbPath, dest);
  writeFileSync(`${dest}.meta.json`, JSON.stringify({ createdAt: nowIso(), source: dbPath }, null, 2));
  return dest;
}

export function restoreDb(backupPath: string, dbPath: string): void {
  copyFileSync(backupPath, dbPath);
}

export function audit(db: Db, actor: string, action: string, target?: string, detail?: unknown): void {
  db.prepare(
    "INSERT INTO audit_log(at, actor, action, target, detail_json) VALUES(?, ?, ?, ?, ?)"
  ).run(nowIso(), actor, action, target ?? null, detail ? JSON.stringify(detail) : null);
}

export function lastSync(db: Db): { id: string; finished_at: string | null; status: string; coverage_json: string | null } | undefined {
  return get(db, "SELECT id, finished_at, status, coverage_json FROM sync_runs ORDER BY started_at DESC LIMIT 1");
}

export function markDemo(db: Db, value: boolean): void {
  setMeta(db, "demo", value ? "true" : "false");
}
