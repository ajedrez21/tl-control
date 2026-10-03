import type { Db } from "../../storage/db.ts";
import { get, run } from "../../storage/db.ts";
import { nowIso } from "../../domain/time.ts";
import { workItemKey } from "../../domain/ids.ts";
import { validateTeamAi } from "./validate.ts";

export interface WorkResult {
  artifactId: string;
  schemaVersion: string;
  workItem: { organization: string; project: string; id: number };
  contextHash: string;
  [key: string]: unknown;
}

export function importWorkResult(db: Db, payload: unknown, origin: string): { imported: boolean; revision: number } {
  const check = validateTeamAi("work-result", payload);
  if (!check.ok) {
    throw new Error(`work-result.json inválido: ${check.errors.join("; ")}`);
  }
  const body = payload as WorkResult;
  const existing = get<{ payload_json: string; revision: number }>(
    db,
    "SELECT payload_json, revision FROM workflow_results WHERE artifact_id = ?",
    body.artifactId
  );
  if (existing) {
    if (existing.payload_json === JSON.stringify(body)) {
      return { imported: false, revision: existing.revision };
    }
    const revision = existing.revision + 1;
    run(
      db,
      "UPDATE workflow_results SET origin = ?, imported_at = ?, revision = ?, payload_json = ?, context_hash = ?, work_item_id = ? WHERE artifact_id = ?",
      origin,
      nowIso(),
      revision,
      JSON.stringify(body),
      body.contextHash,
      workItemKey(body.workItem.organization, body.workItem.project, body.workItem.id),
      body.artifactId
    );
    return { imported: true, revision };
  }
  run(
    db,
    "INSERT INTO workflow_results(artifact_id, origin, imported_at, revision, payload_json, context_hash, work_item_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    body.artifactId,
    origin,
    nowIso(),
    1,
    JSON.stringify(body),
    body.contextHash,
    workItemKey(body.workItem.organization, body.workItem.project, body.workItem.id)
  );
  return { imported: true, revision: 1 };
}
