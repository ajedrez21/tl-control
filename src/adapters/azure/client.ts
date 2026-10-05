import type { AppConfig } from "../../config/types.ts";
import { isPlaceholderOrg } from "../../config/types.ts";
import { workItemKey } from "../../domain/ids.ts";
import { resolveAssignee, upsertMembers } from "../../domain/members.ts";
import { normalizeState } from "../../domain/states.ts";
import { nowIso } from "../../domain/time.ts";
import { emptyCoverage, withRetry, type CoverageMap, type HttpClient } from "../http.ts";
import type { Db } from "../../storage/db.ts";
import { withTransaction } from "../../storage/db.ts";
import { markDemo, purgeDemoDataset } from "../../storage/backup.ts";

export interface AzureAuth {
  pat?: string;
}

function authHeader(pat?: string): Record<string, string> {
  if (!pat) return {};
  const token = Buffer.from(`:${pat}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

export class AzureUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly coverageKey: string
  ) {
    super(message);
  }
}

export class AzureDevOpsClient {
  constructor(
    private readonly config: AppConfig,
    private readonly http: HttpClient,
    private readonly auth: AzureAuth
  ) {}

  private base(): string {
    const { organization, project, apiVersion } = this.config.azure;
    return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis`;
  }

  async wiql(query: string): Promise<{ ids: number[]; coverage: CoverageMap }> {
    const coverage = emptyCoverage();
    const res = await withRetry(this.http, {
      method: "POST",
      url: `${this.base()}/wit/wiql?api-version=${this.config.azure.apiVersion}`,
      headers: { "Content-Type": "application/json", ...authHeader(this.auth.pat) },
      body: JSON.stringify({ query })
    });
    if (res.status === 401) {
      coverage.workItems = "UNAUTHORIZED";
      throw new AzureUnavailableError("No autenticado en Azure DevOps", 401, "workItems");
    }
    if (res.status === 403) {
      coverage.workItems = "UNAUTHORIZED";
      throw new AzureUnavailableError("Sin autorización para Work Items", 403, "workItems");
    }
    if (res.status === 404) {
      coverage.workItems = "NOT_AVAILABLE";
      throw new AzureUnavailableError("Recurso Azure no encontrado", 404, "workItems");
    }
    if (res.status >= 400) {
      coverage.workItems = "ERROR";
      throw new AzureUnavailableError(`Azure WIQL ${res.status}`, res.status, "workItems");
    }
    const json = JSON.parse(res.body) as { workItems?: Array<{ id: number }> };
    coverage.workItems = "OK";
    return { ids: (json.workItems ?? []).map((w) => w.id), coverage };
  }

  async getWorkItems(ids: number[]): Promise<{ items: AzureWorkItem[]; coverage: CoverageMap }> {
    const coverage = emptyCoverage();
    if (ids.length === 0) {
      coverage.workItems = "OK";
      return { items: [], coverage };
    }
    const items: AzureWorkItem[] = [];
    const chunks = chunk(ids, 200);
    for (const group of chunks) {
      const url = `${this.base()}/wit/workitems?ids=${group.join(",")}&$expand=all&api-version=${this.config.azure.apiVersion}`;
      const res = await withRetry(this.http, {
        method: "GET",
        url,
        headers: authHeader(this.auth.pat)
      });
      if (res.status >= 400) {
        coverage.workItems = res.status === 403 || res.status === 401 ? "UNAUTHORIZED" : "ERROR";
        throw new AzureUnavailableError(`Work items batch ${res.status}`, res.status, "workItems");
      }
      const json = JSON.parse(res.body) as { value: AzureWorkItem[] };
      items.push(...(json.value ?? []));
    }
    coverage.workItems = "OK";
    return { items, coverage };
  }

  async listComments(azureId: number): Promise<{ comments: AzureComment[]; status: CoverageMap["comments"] }> {
    const url = `${this.base()}/wit/workItems/${azureId}/comments?api-version=${this.config.azure.apiVersion}-preview.4`;
    const res = await withRetry(this.http, { method: "GET", url, headers: authHeader(this.auth.pat) });
    if (res.status === 401 || res.status === 403) return { comments: [], status: "UNAUTHORIZED" };
    if (res.status === 404) return { comments: [], status: "NOT_AVAILABLE" };
    if (res.status >= 400) return { comments: [], status: "ERROR" };
    const json = JSON.parse(res.body) as { comments?: AzureComment[] };
    return { comments: json.comments ?? [], status: "OK" };
  }

  async listRevisions(azureId: number): Promise<{ revisions: AzureRevision[]; status: CoverageMap["revisions"] }> {
    const url = `${this.base()}/wit/workItems/${azureId}/revisions?api-version=${this.config.azure.apiVersion}`;
    const res = await withRetry(this.http, { method: "GET", url, headers: authHeader(this.auth.pat) });
    if (res.status === 401 || res.status === 403) return { revisions: [], status: "UNAUTHORIZED" };
    if (res.status === 404) return { revisions: [], status: "NOT_AVAILABLE" };
    if (res.status >= 400) return { revisions: [], status: "ERROR" };
    const json = JSON.parse(res.body) as { value?: AzureRevision[] };
    return { revisions: json.value ?? [], status: "OK" };
  }

  async addComment(azureId: number, text: string): Promise<{ id: number; createdDate: string }> {
    const url = `${this.base()}/wit/workItems/${azureId}/comments?api-version=${this.config.azure.apiVersion}-preview.4`;
    const res = await withRetry(this.http, {
      method: "POST",
      url,
      headers: { ...authHeader(this.auth.pat), "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (res.status === 401 || res.status === 403) throw new Error("Azure rechazó el comentario (sin permiso).");
    if (res.status >= 400) throw new Error("Azure no aceptó el comentario.");
    const json = JSON.parse(res.body) as { id?: number; createdDate?: string };
    if (!json.id) throw new Error("Azure no devolvió el comentario.");
    return { id: json.id, createdDate: json.createdDate || new Date().toISOString() };
  }

  async downloadAttachment(url: string): Promise<{ bytes: Buffer; status: CoverageMap["attachments"] }> {
    const res = await withRetry(this.http, { method: "GET", url, headers: authHeader(this.auth.pat) });
    if (res.status === 401 || res.status === 403) return { bytes: Buffer.alloc(0), status: "UNAUTHORIZED" };
    if (res.status >= 400) return { bytes: Buffer.alloc(0), status: "NOT_AVAILABLE" };
    return { bytes: Buffer.from(res.body, "binary"), status: "OK" };
  }

  async findIdByTag(tag: string): Promise<number | null> {
    const project = wiqlLiteral(this.config.azure.project);
    const needle = wiqlLiteral(tag);
    const { ids } = await this.wiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${project} AND [System.Tags] CONTAINS ${needle}`
    );
    return ids[0] ?? null;
  }

  async createChildWorkItem(input: {
    type: string;
    parentAzureId: number;
    title: string;
    description: string;
    iterationPath: string;
    areaPath: string;
    assignedTo: string | null;
    tag: string;
  }): Promise<{ item: AzureWorkItem; reused: boolean }> {
    const existingId = await this.findIdByTag(input.tag);
    if (existingId) {
      const found = await this.readWorkItem(existingId);
      return { item: found, reused: true };
    }

    const parentUrl = `${this.base()}/wit/workItems/${input.parentAzureId}`;
    let patch = workItemPatch(input, parentUrl);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const item = await this.postWorkItem(input.type, patch);
        return { item, reused: false };
      } catch (error) {
        lastError = error;
        if (!(error instanceof AzureUnavailableError) || error.status !== 400) break;
        const next = dropRejectedField(patch, error.message);
        if (!next) break;
        patch = next;
      }
    }

    const raced = await this.findIdByTag(input.tag).catch(() => null);
    if (raced) return { item: await this.readWorkItem(raced), reused: true };
    throw lastError instanceof Error ? lastError : new AzureUnavailableError("No se pudo crear la tarea en Azure", 500, "workItems");
  }

  private async readWorkItem(azureId: number): Promise<AzureWorkItem> {
    const { items } = await this.getWorkItems([azureId]);
    const item = items[0];
    if (!item) throw new AzureUnavailableError(`No se pudo leer el work item ${azureId}`, 404, "workItems");
    return item;
  }

  async updateWorkItemFields(azureId: number, fields: Record<string, string>): Promise<AzureWorkItem> {
    const patch: JsonPatch[] = Object.entries(fields).map(([name, value]) => ({
      op: "add",
      path: `/fields/${name}`,
      value
    }));
    const url = `${this.base()}/wit/workitems/${azureId}?api-version=${this.config.azure.apiVersion}`;
    return this.sendWorkItemPatch(url, patch);
  }

  private async postWorkItem(type: string, patch: JsonPatch[]): Promise<AzureWorkItem> {
    const url = `${this.base()}/wit/workitems/${encodeURIComponent(`$${type}`)}?api-version=${this.config.azure.apiVersion}`;
    return this.sendWorkItemPatch(url, patch, "POST");
  }

  private async sendWorkItemPatch(url: string, patch: JsonPatch[], method: "POST" | "PATCH" = "PATCH"): Promise<AzureWorkItem> {
    const res = await this.http.request({
      method,
      url,
      headers: { "Content-Type": "application/json-patch+json", ...authHeader(this.auth.pat) },
      body: JSON.stringify(patch)
    });
    if (res.status === 401 || res.status === 403) {
      throw new AzureUnavailableError("Sin permiso para escribir work items en Azure", res.status, "workItems");
    }
    if (res.status >= 400) {
      throw new AzureUnavailableError(shortAzureError(res.status, res.body), res.status, "workItems");
    }
    return JSON.parse(res.body) as AzureWorkItem;
  }
}

interface JsonPatch {
  op: "add";
  path: string;
  value: unknown;
}

function workItemPatch(
  input: {
    title: string;
    description: string;
    iterationPath: string;
    areaPath: string;
    assignedTo: string | null;
    tag: string;
  },
  parentUrl: string
): JsonPatch[] {
  const patch: JsonPatch[] = [
    { op: "add", path: "/fields/System.Title", value: input.title },
    { op: "add", path: "/fields/System.Description", value: input.description },
    { op: "add", path: "/fields/System.IterationPath", value: input.iterationPath },
    { op: "add", path: "/fields/System.Tags", value: input.tag },
    { op: "add", path: "/fields/Microsoft.VSTS.Common.Activity", value: "Development" },
    {
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl }
    }
  ];
  if (input.areaPath) patch.push({ op: "add", path: "/fields/System.AreaPath", value: input.areaPath });
  if (input.assignedTo) patch.push({ op: "add", path: "/fields/System.AssignedTo", value: input.assignedTo });
  return patch;
}

function dropRejectedField(patch: JsonPatch[], message: string): JsonPatch[] | null {
  const text = message.toLowerCase();
  const path = text.includes("assigned")
    ? "/fields/System.AssignedTo"
    : text.includes("activity")
      ? "/fields/Microsoft.VSTS.Common.Activity"
      : null;
  if (!path || !patch.some((op) => op.path === path)) return null;
  return patch.filter((op) => op.path !== path);
}

function wiqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function shortAzureError(status: number, body: string): string {
  let message = body;
  try {
    const json = JSON.parse(body) as { message?: string };
    if (typeof json.message === "string" && json.message.trim()) message = json.message;
  } catch {
    message = body;
  }
  const clean = message.replace(/\s+/g, " ").trim().slice(0, 180);
  return clean ? `Azure ${status}: ${clean}` : `Azure ${status}`;
}

export interface AzureWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
}

export interface AzureComment {
  id: number;
  text: string;
  createdDate: string;
  createdBy?: { displayName?: string; id?: string };
}

export interface AzureRevision {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function persistWorkItems(
  db: Db,
  config: AppConfig,
  items: AzureWorkItem[],
  syncRunId: string,
  extra?: {
    comments?: Record<number, AzureComment[]>;
    revisions?: Record<number, AzureRevision[]>;
  }
): void {
  const fetchedAt = nowIso();
  withTransaction(db, () => {
    for (const item of items) {
      const fields = item.fields ?? {};
      const assignee = resolveAssignee(config.team.members, fields["System.AssignedTo"]);
      const parentRel = (item.relations ?? []).find((rel) => rel.rel === "System.LinkTypes.Hierarchy-Reverse");
      const parentAzureId = parentRel ? Number(extractIdFromUrl(parentRel.url) ?? "") : NaN;
      const parentId = Number.isFinite(parentAzureId)
        ? workItemKey(config.azure.organization, config.azure.project, parentAzureId)
        : null;
      const id = workItemKey(config.azure.organization, config.azure.project, item.id);
      const original = String(fields["System.State"] ?? "Unknown");
      db.prepare(
        `INSERT INTO work_items (
          id, organization, project, azure_id, type, title, state_original, state_normalized,
          iteration_id, area_path, priority, assigned_to_id, assigned_to_name, estimate, description_html,
          acceptance_criteria, url, source_revision, fetched_at, sync_run_id, parent_id, screen, module, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          type=excluded.type,
          state_original=excluded.state_original,
          state_normalized=excluded.state_normalized,
          iteration_id=excluded.iteration_id,
          area_path=excluded.area_path,
          priority=excluded.priority,
          assigned_to_id=excluded.assigned_to_id,
          assigned_to_name=excluded.assigned_to_name,
          estimate=excluded.estimate,
          description_html=excluded.description_html,
          acceptance_criteria=excluded.acceptance_criteria,
          url=excluded.url,
          source_revision=excluded.source_revision,
          fetched_at=excluded.fetched_at,
          sync_run_id=excluded.sync_run_id,
          parent_id=excluded.parent_id,
          tags=excluded.tags`
      ).run(
        id,
        config.azure.organization,
        config.azure.project,
        item.id,
        String(fields["System.WorkItemType"] ?? "Unknown"),
        String(fields["System.Title"] ?? "(sin título)"),
        original,
        normalizeState(original, config.azure.stateMapping),
        String(fields["System.IterationPath"] ?? config.azure.iterationPath ?? ""),
        String(fields["System.AreaPath"] ?? ""),
        Number(fields[config.azure.fieldMap.priority] ?? fields["Microsoft.VSTS.Common.Priority"] ?? 2),
        assignee.memberId ?? assignee.azureId,
        assignee.displayName,
        Number(fields[config.azure.fieldMap.effort] ?? 0) || null,
        String(fields["System.Description"] ?? ""),
        String(fields[config.azure.fieldMap.acceptanceCriteria] ?? ""),
        item.url,
        item.rev,
        fetchedAt,
        syncRunId,
        parentId,
        null,
        null,
        String(fields["System.Tags"] ?? "")
      );

      for (const rel of item.relations ?? []) {
        db.prepare(
          `INSERT OR IGNORE INTO work_item_relations(work_item_id, rel_type, target_id, target_url, attributes_json)
           VALUES (?, ?, ?, ?, ?)`
        ).run(id, rel.rel, extractIdFromUrl(rel.url), rel.url, JSON.stringify(rel.attributes ?? {}));
      }

      for (const comment of extra?.comments?.[item.id] ?? []) {
        db.prepare(
          `INSERT INTO comments(id, work_item_id, author_id, author_name, created_at, text_html, source_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET text_html=excluded.text_html`
        ).run(
          `${id}/comment/${comment.id}`,
          id,
          comment.createdBy?.id ?? null,
          comment.createdBy?.displayName ?? null,
          comment.createdDate,
          comment.text,
          item.rev
        );
      }

      for (const rev of extra?.revisions?.[item.id] ?? []) {
        db.prepare(
          `INSERT OR IGNORE INTO work_item_revisions(work_item_id, revision, state_original, title, assigned_to_id, changed_at, changed_by, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          rev.rev,
          String(rev.fields["System.State"] ?? ""),
          String(rev.fields["System.Title"] ?? ""),
          null,
          String(rev.fields["System.ChangedDate"] ?? fetchedAt),
          String((rev.fields["System.ChangedBy"] as { displayName?: string } | undefined)?.displayName ?? ""),
          JSON.stringify(rev.fields)
        );
      }
    }
  });
}

function extractIdFromUrl(url: string): string | null {
  const match = url.match(/workItems\/(\d+)/i);
  return match ? match[1] : url;
}

export async function syncIteration(
  db: Db,
  config: AppConfig,
  client: AzureDevOpsClient,
  iterationPath: string
): Promise<{ syncRunId: string; coverage: CoverageMap; count: number }> {
  const syncRunId = `sync-${Date.now()}`;
  const started = nowIso();
  db.prepare(
    "INSERT INTO sync_runs(id, started_at, iteration_id, status, coverage_json) VALUES (?, ?, ?, ?, ?)"
  ).run(syncRunId, started, iterationPath, "running", JSON.stringify(emptyCoverage()));

  const coverage = emptyCoverage();
  try {
    const types = [...new Set([
      config.azure.workItemTypes.story ?? "User Story",
      config.azure.workItemTypes.task ?? "Task",
      config.azure.workItemTypes.bug ?? "Bug",
      config.azure.workItemTypes.feature ?? "Feature",
      "Product Backlog Item"
    ].filter(Boolean))];
    const typeList = types.map((t) => `'${t.replaceAll("'", "''")}'`).join(", ");
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] UNDER '${iterationPath.replaceAll("'", "''")}' AND [System.WorkItemType] IN (${typeList})`;
    const { ids } = await client.wiql(wiql);
    const { items } = await client.getWorkItems(ids);
    coverage.workItems = "OK";

    const comments: Record<number, AzureComment[]> = {};
    const revisions: Record<number, AzureRevision[]> = {};
    let commentStatus: CoverageMap["comments"] = "OK";
    let revStatus: CoverageMap["revisions"] = "OK";
    for (const item of items) {
      const c = await client.listComments(item.id);
      comments[item.id] = c.comments;
      if (c.status !== "OK") commentStatus = c.status;
      const r = await client.listRevisions(item.id);
      revisions[item.id] = r.revisions;
      if (r.status !== "OK") revStatus = r.status;
    }
    coverage.comments = items.length === 0 ? "OK" : commentStatus;
    coverage.revisions = items.length === 0 ? "OK" : revStatus;
    coverage.relations = "OK";
    coverage.attachments = "NOT_AVAILABLE";
    coverage.pullRequests = "NOT_AVAILABLE";
    coverage.builds = "NOT_AVAILABLE";
    coverage.deployments = "NOT_AVAILABLE";

    persistWorkItems(db, config, items, syncRunId, { comments, revisions });
    upsertMembers(db, config);
    if (!isPlaceholderOrg(config.azure.organization)) {
      purgeDemoDataset(db);
      markDemo(db, false);
    }
    db.prepare(
      "UPDATE sync_runs SET finished_at = ?, status = ?, coverage_json = ? WHERE id = ?"
    ).run(nowIso(), "ok", JSON.stringify(coverage), syncRunId);
    return { syncRunId, coverage, count: items.length };
  } catch (error) {
    const err = error as AzureUnavailableError;
    if (err.coverageKey) coverage[err.coverageKey] = err.status === 403 || err.status === 401 ? "UNAUTHORIZED" : "ERROR";
    db.prepare(
      "UPDATE sync_runs SET finished_at = ?, status = ?, coverage_json = ?, error = ? WHERE id = ?"
    ).run(nowIso(), "error", JSON.stringify(coverage), String(error), syncRunId);
    throw error;
  }
}
