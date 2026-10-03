import type { Db } from "../storage/db.ts";
import { get } from "../storage/db.ts";
import type { AppConfig } from "../config/types.ts";
import { nowIso } from "../domain/time.ts";
import { resolveWorkItemArg } from "../domain/ids.ts";
import { all } from "../storage/db.ts";

export interface PublishPreview {
  enabled: boolean;
  parent: { id: string; azureId: number; revision: number | null; title: string };
  operations: Array<{
    idempotencyKey: string;
    type: string;
    fields: Record<string, string>;
    relations: Array<{ rel: string; target: string }>;
    assignedTo: string | null;
  }>;
  conflict: boolean;
  expectedRevision: number | null;
  currentRevision: number | null;
}

export function previewPublish(db: Db, config: AppConfig, rawId: string, expectedRevision?: number): PublishPreview {
  const id = resolveWorkItemArg(rawId, config.azure.organization, config.azure.project);
  const parent = get<{ id: string; azure_id: number; source_revision: number | null; title: string }>(
    db,
    "SELECT id, azure_id, source_revision, title FROM work_items WHERE id = ?",
    id
  );
  if (!parent) throw new Error(`Work Item no encontrado: ${id}`);
  const drafts = all<{ idempotency_key: string; title: string; layer: string; assigned_to_id: string | null; azure_id: number | null }>(
    db,
    "SELECT idempotency_key, title, layer, assigned_to_id, azure_id FROM draft_tasks WHERE parent_id = ?",
    id
  );
  const currentRevision = parent.source_revision;
  const conflict =
    expectedRevision !== undefined && currentRevision !== null && expectedRevision !== currentRevision;
  return {
    enabled: config.azure.writes.enabled,
    parent: {
      id: parent.id,
      azureId: parent.azure_id,
      revision: parent.source_revision,
      title: parent.title
    },
    operations: drafts.map((d) => ({
      idempotencyKey: d.idempotency_key,
      type: config.azure.workItemTypes.task,
      fields: {
        "System.Title": d.title,
        "System.IterationPath": config.azure.iterationPath,
        "System.Description": `Borrador TL Control ${nowIso()}`
      },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", target: String(parent.azure_id) }],
      assignedTo: d.assigned_to_id
    })),
    conflict,
    expectedRevision: expectedRevision ?? currentRevision,
    currentRevision
  };
}

export function applyPublish(_db: Db, config: AppConfig, preview: PublishPreview): { published: boolean; reason: string } {
  if (!config.azure.writes.enabled) {
    return { published: false, reason: "writes.enabled=false. Exportá el preview y copiá a Azure manualmente." };
  }
  if (preview.conflict) {
    return { published: false, reason: "Conflicto de revisión: no se sobreescribe. Releé Azure y regenerá el preview." };
  }
  return {
    published: false,
    reason: "Capacidad de escritura presente en el adaptador pero no ejecutada sin operación CLI `publish --confirm` autenticada. Retry usa idempotencyKey y no duplica."
  };
}
