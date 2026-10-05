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

export function lastSync(
  db: Db,
  iterationId?: string
): { id: string; finished_at: string | null; status: string; coverage_json: string | null } | undefined {
  if (iterationId) {
    return get(
      db,
      "SELECT id, finished_at, status, coverage_json FROM sync_runs WHERE iteration_id = ? ORDER BY started_at DESC LIMIT 1",
      iterationId
    );
  }
  return get(db, "SELECT id, finished_at, status, coverage_json FROM sync_runs ORDER BY started_at DESC LIMIT 1");
}

export function purgeDemoDataset(db: Db): void {
  const prefix = "fabrikam-demo/%";
  const tables = [
    "comments",
    "work_item_revisions",
    "work_item_relations",
    "evidence",
    "attachments",
    "analyses",
    "contracts",
    "dependencies",
    "questions",
    "draft_tasks",
    "context_packages",
    "workflow_results",
    "tl_notes",
    "pull_requests",
    "alerts"
  ];
  for (const table of tables) {
    const column = table === "draft_tasks" ? "parent_id" : table === "alerts" ? "work_item_id" : "work_item_id";
    if (table === "draft_tasks") {
      db.prepare(`DELETE FROM draft_tasks WHERE parent_id LIKE ?`).run(prefix);
      continue;
    }
    if (table === "work_item_revisions" || table === "work_item_relations") {
      db.prepare(`DELETE FROM ${table} WHERE work_item_id LIKE ?`).run(prefix);
      continue;
    }
    db.prepare(`DELETE FROM ${table} WHERE ${column} LIKE ?`).run(prefix);
  }
  db.prepare("DELETE FROM work_items WHERE organization = ?").run("fabrikam-demo");
  db.prepare("DELETE FROM iterations WHERE id LIKE ?").run("TL Control Demo%");
  db.prepare("DELETE FROM sync_runs WHERE id LIKE ? OR iteration_id LIKE ?").run("sync-demo%", "TL Control Demo%");
  db.prepare(
    "DELETE FROM member_board WHERE member_id IN ('fe-lucia','fe-martin','be-paula','be-diego','be-sofia')"
  ).run();
  db.prepare(
    "DELETE FROM members WHERE id IN ('fe-lucia','fe-martin','be-paula','be-diego','be-sofia')"
  ).run();
  db.prepare("DELETE FROM findings WHERE report_id LIKE ?").run("sec-4112%");
  db.prepare("DELETE FROM security_reports WHERE id LIKE ?").run("sec-4112%");
  db.prepare("DELETE FROM snapshots WHERE iteration_id LIKE ?").run("TL Control Demo%");
  db.prepare("DELETE FROM pull_requests WHERE source = ?").run("demo");
  db.prepare("DELETE FROM deployments WHERE id LIKE ?").run("dep-%");
  db.prepare("DELETE FROM release_work_items WHERE release_id LIKE ?").run("rel-%");
  db.prepare("DELETE FROM release_components WHERE release_id LIKE ?").run("rel-%");
  db.prepare("DELETE FROM release_packages WHERE id LIKE ?").run("rel-%");
  setMeta(db, "demo", "false");
  setMeta(db, "demo_warning", "");
}

export function markDemo(db: Db, value: boolean): void {
  setMeta(db, "demo", value ? "true" : "false");
}
