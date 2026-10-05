import type { Db } from "../storage/db.ts";
import { all, get, run } from "../storage/db.ts";
import type { AppConfig } from "../config/types.ts";
import { resolveWorkItemArg } from "../domain/ids.ts";
import { azureDescriptionFromPayload } from "../analysis/story.ts";
import { hasValidAzureId, resolveAssignment } from "../domain/members.ts";
import { AzureDevOpsClient, persistWorkItems, type AzureWorkItem } from "../adapters/azure/client.ts";
import { FetchHttpClient } from "../adapters/http.ts";
import { azurePat } from "../config/load.ts";

export interface PublishPreview {
  enabled: boolean;
  parent: { id: string; azureId: number; revision: number | null; title: string };
  operations: Array<{
    idempotencyKey: string;
    type: string;
    fields: Record<string, string>;
    relations: Array<{ rel: string; target: string }>;
    assignedTo: string | null;
    azureId: number | null;
  }>;
  conflict: boolean;
  expectedRevision: number | null;
  currentRevision: number | null;
}

export function previewPublish(
  db: Db,
  config: AppConfig,
  rawId: string,
  expectedRevision?: number,
  opts?: { approvedOnly?: boolean }
): PublishPreview {
  const id = resolveWorkItemArg(rawId, config.azure.organization, config.azure.project);
  const parent = get<{ id: string; azure_id: number; source_revision: number | null; title: string }>(
    db,
    "SELECT id, azure_id, source_revision, title FROM work_items WHERE id = ?",
    id
  );
  if (!parent) throw new Error(`Work Item no encontrado: ${id}`);
  const sql = opts?.approvedOnly
    ? "SELECT idempotency_key, title, layer, assigned_to_id, azure_id, payload_json FROM draft_tasks WHERE parent_id = ? AND review_status = 'approved'"
    : "SELECT idempotency_key, title, layer, assigned_to_id, azure_id, payload_json FROM draft_tasks WHERE parent_id = ? AND azure_id IS NULL";
  const drafts = all<{
    idempotency_key: string;
    title: string;
    layer: string;
    assigned_to_id: string | null;
    azure_id: number | null;
    payload_json: string;
  }>(db, sql, id);
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
        "System.Description": azureDescriptionFromPayload(parseDraftPayload(d.payload_json))
      },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", target: String(parent.azure_id) }],
      assignedTo: resolveAssignment(config, d.assigned_to_id).assignedTo,
      azureId: d.azure_id
    })),
    conflict,
    expectedRevision: expectedRevision ?? currentRevision,
    currentRevision
  };
}

function parseDraftPayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface PublishedTask {
  azureId: number;
  title: string;
  idempotencyKey: string;
  reused: boolean;
  updated: boolean;
}

export async function applyPublish(
  db: Db,
  config: AppConfig,
  preview: PublishPreview,
  client?: AzureDevOpsClient
): Promise<{ published: boolean; reason: string; created: PublishedTask[] }> {
  if (!config.azure.writes.enabled) {
    return { published: false, created: [], reason: "writes.enabled=false. Exportá el preview y copiá a Azure manualmente." };
  }
  if (preview.conflict) {
    return { published: false, created: [], reason: "Conflicto de revisión: no se sobreescribe. Releé Azure y regenerá el preview." };
  }
  if (preview.operations.length === 0) {
    return { published: false, created: [], reason: "No hay tareas aprobadas para publicar." };
  }

  const pat = azurePat();
  const azure = client ?? (pat ? new AzureDevOpsClient(config, new FetchHttpClient(), { pat }) : null);
  if (!azure) {
    return {
      published: false,
      created: [],
      reason: "Escritura habilitada, pero no hay PAT de Azure. Definí AZURE_DEVOPS_PAT en el .env local."
    };
  }

  const created: PublishedTask[] = [];
  const errors: string[] = [];
  for (const op of preview.operations) {
    const title = op.fields["System.Title"] ?? "(sin título)";
    const tag = publishTag(op.idempotencyKey);
    const identity = azureIdentity(config, op.assignedTo);
    try {
      if (op.azureId) {
        const fields: Record<string, string> = {
          "System.Title": title,
          "System.Description": op.fields["System.Description"] ?? "",
          "System.IterationPath": op.fields["System.IterationPath"] ?? config.azure.iterationPath
        };
        if (identity) fields["System.AssignedTo"] = identity;
        const item = await azure.updateWorkItemFields(op.azureId, fields);
        persistWorkItems(db, config, [item], `publish-${item.id}`);
        run(
          db,
          "UPDATE draft_tasks SET azure_id = ?, publish_status = 'published' WHERE idempotency_key = ?",
          item.id,
          op.idempotencyKey
        );
        created.push({ azureId: item.id, title, idempotencyKey: op.idempotencyKey, reused: false, updated: true });
        continue;
      }
      const result = await azure.createChildWorkItem({
        type: op.type,
        parentAzureId: preview.parent.azureId,
        title,
        description: op.fields["System.Description"] ?? "",
        iterationPath: op.fields["System.IterationPath"] ?? config.azure.iterationPath,
        areaPath: config.azure.areaPath,
        assignedTo: identity,
        tag
      });
      const item = withParentLink(result.item, config, preview.parent.azureId);
      run(
        db,
        "UPDATE draft_tasks SET azure_id = ?, publish_status = 'published' WHERE idempotency_key = ?",
        item.id,
        op.idempotencyKey
      );
      persistWorkItems(db, config, [item], `publish-${item.id}`);
      created.push({ azureId: item.id, title, idempotencyKey: op.idempotencyKey, reused: result.reused, updated: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${title}: ${message}`);
      run(
        db,
        "UPDATE draft_tasks SET publish_status = 'queued' WHERE idempotency_key = ? AND azure_id IS NULL",
        op.idempotencyKey
      );
    }
  }

  return {
    published: errors.length === 0 && created.length > 0,
    created,
    reason: publishReason(created, errors)
  };
}

export function publishTag(idempotencyKey: string): string {
  const slug = idempotencyKey.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  return `tlc-${slug || "draft"}`;
}

function azureIdentity(config: AppConfig, memberId: string | null): string | null {
  if (!memberId) return null;
  const member = config.team.members.find((m) => m.id === memberId);
  if (!member || !hasValidAzureId(member.azureId)) return null;
  return member.displayName;
}

function withParentLink(item: AzureWorkItem, config: AppConfig, parentAzureId: number): AzureWorkItem {
  const parentUrl = `https://dev.azure.com/${encodeURIComponent(config.azure.organization)}/${encodeURIComponent(config.azure.project)}/_apis/wit/workItems/${parentAzureId}`;
  const relations = item.relations ?? [];
  if (relations.some((rel) => rel.rel === "System.LinkTypes.Hierarchy-Reverse")) return item;
  return {
    ...item,
    relations: [...relations, { rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl }]
  };
}

function publishReason(created: PublishedTask[], errors: string[]): string {
  const parts: string[] = [];
  if (created.length) {
    parts.push(
      `En Azure: ${created
        .map((item) => `${item.updated ? "actualizada" : item.reused ? "ya estaba" : "creada"} #${item.azureId} ${item.title}`)
        .join("; ")}.`
    );
  }
  if (errors.length) parts.push(`No se pudieron crear: ${errors.join(" | ")}.`);
  return parts.join(" ") || "No se creó ninguna tarea.";
}
