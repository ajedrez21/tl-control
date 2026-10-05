import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../storage/db.ts";
import { get, run } from "../storage/db.ts";
import type { AppConfig } from "../config/types.ts";
import { audit } from "../storage/backup.ts";
import { nowIso } from "../domain/time.ts";
import { resolveDataDir } from "../config/load.ts";
import { applyPublish, previewPublish, type PublishedTask } from "../cli/publish.ts";
import type { AzureDevOpsClient } from "../adapters/azure/client.ts";
import { resolveWorkItemArg } from "../domain/ids.ts";
import { defaultOwnerMember, resolveAssignment } from "../domain/members.ts";

export type ReviewStatus = "pending" | "approved" | "rejected";

interface DraftRow {
  id: string;
  parent_id: string;
  title: string;
  layer: string;
  assigned_to_id: string | null;
  payload_json: string;
  azure_id: number | null;
  publish_status: string;
  review_status: string;
  idempotency_key: string;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadDraft(db: Db, draftId: string): DraftRow {
  const row = get<DraftRow>(db, "SELECT * FROM draft_tasks WHERE id = ?", draftId);
  if (!row) throw new Error(`Borrador no encontrado: ${draftId}`);
  return row;
}

function layerRole(layer: string): "frontend" | "backend" | null {
  if (layer === "FE") return "frontend";
  if (layer === "BE") return "backend";
  return null;
}

export function assignDraft(
  db: Db,
  config: AppConfig,
  draftId: string,
  memberId: string | null
): {
  ok: true;
  draftId: string;
  assignedTo: string | null;
  requestedId: string | null;
  fallback: boolean;
  reason: string | null;
} {
  const draft = loadDraft(db, draftId);
  const requested = memberId && memberId.trim() ? memberId.trim() : null;
  if (requested) {
    const member = config.team.members.find((m) => m.id === requested);
    if (!member) throw new Error(`Miembro no encontrado: ${requested}`);
    const expected = layerRole(draft.layer);
    const owner = defaultOwnerMember(config);
    if (expected && member.role !== expected && member.role !== "other" && member.id !== owner.id) {
      throw new Error(`El rol de ${member.displayName} (${member.role}) no coincide con la capa ${draft.layer}.`);
    }
  }
  const resolution = resolveAssignment(config, requested);
  const assigned = resolution.assignedTo;
  const payload = parsePayload(draft.payload_json);
  payload.assignedTo = assigned;
  payload.assignment = assigned ?? "UNASSIGNED";
  if (resolution.fallback) {
    payload.requestedAssignee = resolution.requestedId;
    payload.assignmentFallback = resolution.reason;
  } else {
    delete payload.requestedAssignee;
    delete payload.assignmentFallback;
  }
  run(
    db,
    "UPDATE draft_tasks SET assigned_to_id = ?, payload_json = ? WHERE id = ?",
    assigned,
    JSON.stringify(payload),
    draftId
  );
  audit(db, "ui", "draft-assign", draftId, {
    assignedTo: assigned,
    requestedId: resolution.requestedId,
    fallback: resolution.fallback,
    parentId: draft.parent_id
  });
  return {
    ok: true,
    draftId,
    assignedTo: assigned,
    requestedId: resolution.requestedId,
    fallback: resolution.fallback,
    reason: resolution.reason
  };
}

export function reviewDraft(
  db: Db,
  draftId: string,
  status: ReviewStatus
): { ok: true; draftId: string; reviewStatus: ReviewStatus } {
  if (!["pending", "approved", "rejected"].includes(status)) {
    throw new Error(`Estado de revisión inválido: ${status}`);
  }
  loadDraft(db, draftId);
  run(db, "UPDATE draft_tasks SET review_status = ? WHERE id = ?", status, draftId);
  audit(db, "ui", "draft-review", draftId, { reviewStatus: status });
  return { ok: true, draftId, reviewStatus: status };
}

export async function publishApprovedDrafts(
  db: Db,
  config: AppConfig,
  rawId: string,
  confirm: boolean,
  client?: AzureDevOpsClient
): Promise<{
  ok: boolean;
  published: boolean;
  reason: string;
  preview: ReturnType<typeof previewPublish>;
  exportPath: string | null;
  created: PublishedTask[];
}> {
  const parentId = resolveWorkItemArg(rawId, config.azure.organization, config.azure.project);
  const preview = previewPublish(db, config, rawId, undefined, { approvedOnly: true });
  if (preview.operations.length === 0) {
    return {
      ok: false,
      published: false,
      reason: "No hay tareas aprobadas para publicar. Revisá y aprobá al menos un borrador.",
      preview,
      exportPath: null,
      created: []
    };
  }
  if (!confirm) {
    return {
      ok: true,
      published: false,
      reason: "Preview listo. Confirmá para crear las tareas en Azure.",
      preview,
      exportPath: null,
      created: []
    };
  }

  const dir = join(resolveDataDir(config), "exports");
  mkdirSync(dir, { recursive: true });
  const exportPath = join(dir, `publish-${preview.parent.azureId}-${Date.now()}.json`);
  writeFileSync(exportPath, `${JSON.stringify({ generatedAt: nowIso(), preview }, null, 2)}\n`, "utf8");

  const applied = await applyPublish(db, config, preview, client);
  if (!config.azure.writes.enabled) {
    run(
      db,
      "UPDATE draft_tasks SET publish_status = 'queued' WHERE parent_id = ? AND review_status = 'approved' AND azure_id IS NULL",
      parentId
    );
  }
  audit(db, "ui", "draft-publish", parentId, {
    published: applied.published,
    reason: applied.reason,
    exportPath,
    count: preview.operations.length
  });
  return {
    ok: true,
    published: applied.published,
    reason: applied.reason,
    preview,
    exportPath,
    created: applied.created
  };
}
