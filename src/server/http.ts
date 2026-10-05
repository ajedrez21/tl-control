import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/types.ts";
import { isPlaceholderOrg } from "../config/types.ts";
import { azurePat, dbPath, loadConfig, loadLocalEnv, resolveDataDir } from "../config/load.ts";
import { openDb, all, get, run, type Db, getMeta, sqlv } from "../storage/db.ts";
import { lastSync, markDemo, purgeDemoDataset } from "../storage/backup.ts";
import { computeSprintMetrics, chartStateDistribution, isInProduction, type ScopeMetrics } from "../metrics/sprint.ts";
import { idsHiddenByBlock, isBlockedWorkItem } from "../metrics/blocked.ts";
import { listSqlGaps } from "../metrics/sql-gaps.ts";
import { answerFunctionalQuestion, listFunctionalQuestions, publishFunctionalQuestions } from "../analysis/functional-questions.ts";
import { AzureDevOpsClient } from "../adapters/azure/client.ts";
import { FetchHttpClient } from "../adapters/http.ts";
import { renderDailyReport } from "../report/daily.ts";
import { refreshAlerts } from "../metrics/alerts.ts";
import { listReleases, storyReleaseStatus } from "../metrics/releases.ts";
import { calendarDaysBetween, nowIso } from "../domain/time.ts";
import { sanitizeHtml } from "../domain/sanitize.ts";
import { normalizeState, stateLabel, type NormalizedState } from "../domain/states.ts";
import { memberLabel, memberTasks, upsertMembers, isTeamAssignment, defaultOwnerMember, hasValidAzureId } from "../domain/members.ts";
import { loadMemberBoard, saveMemberBoard } from "../domain/board.ts";
import { createAutoSync, type AutoSync } from "./auto-sync.ts";
import { assertInsideDir } from "./safe-path.ts";
import { assignDraft, publishApprovedDrafts, reviewDraft, type ReviewStatus } from "../analysis/drafts.ts";

const DASHBOARD_DIR = resolve(fileURLToPath(new URL("../../dashboard/", import.meta.url)));

export interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

export function startDashboardServer(opts?: { config?: AppConfig; demo?: boolean; port?: number }): ServerHandle {
  loadLocalEnv();
  const config = opts?.config ?? loadConfig();
  const db = openDb(dbPath(config));
  const host = config.server.host || "127.0.0.1";
  const port = opts?.port ?? config.server.port;
  const dataDir = resolveDataDir(config);

  upsertMembers(db, config);
  if (!isPlaceholderOrg(config.azure.organization)) {
    purgeDemoDataset(db);
    markDemo(db, false);
  }
  hydrateLocalWorkItems(db, config);
  const autoSync = createAutoSync({ db, config });
  autoSync.start();

  const server = createServer((req, res) => {
    void handle(req, res, { config, db, dataDir, host, port, autoSync }).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: publicError(error) });
    });
  });

  server.listen(port, host);
  const url = `http://${host}:${port}/`;
  return {
    url,
    close: () =>
      new Promise((resolveClose) => {
        autoSync.stop();
        server.close(() => {
          db.close();
          resolveClose();
        });
      })
  };
}

function hydrateLocalWorkItems(db: Db, config: AppConfig): void {
  for (const row of all<{ id: string; state_original: string }>(db, "SELECT id, state_original FROM work_items")) {
    run(db, "UPDATE work_items SET state_normalized = ? WHERE id = ?", normalizeState(row.state_original, config.azure.stateMapping), row.id);
  }
  for (const rel of all<{ work_item_id: string; target_id: string | null }>(
    db,
    "SELECT work_item_id, target_id FROM work_item_relations WHERE rel_type = 'System.LinkTypes.Hierarchy-Reverse'"
  )) {
    const azureId = Number(rel.target_id);
    if (!Number.isFinite(azureId)) continue;
    const parent = get<{ id: string }>(db, "SELECT id FROM work_items WHERE azure_id = ?", azureId);
    if (parent) run(db, "UPDATE work_items SET parent_id = ? WHERE id = ? AND (parent_id IS NULL OR parent_id = '')", parent.id, rel.work_item_id);
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { config: AppConfig; db: Db; dataDir: string; host: string; port: number; autoSync: AutoSync }
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${ctx.host}:${ctx.port}`);
  if (req.method === "POST" && !isLocalWrite(req, ctx.host, ctx.port)) {
    json(res, 403, { error: "Escritura rechazada: origen no local." });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await api(req, res, url, ctx);
    return;
  }
  if (url.pathname.startsWith("/attachments/")) {
    serveAttachment(res, url.pathname.slice("/attachments/".length), ctx);
    return;
  }
  serveStatic(res, url.pathname);
}

function isLocalWrite(req: IncomingMessage, host: string, port: number): boolean {
  const origin = req.headers.origin;
  const allowed = [`http://${host}:${port}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (origin && !allowed.includes(origin)) return false;
  const header = req.headers["x-tl-control"];
  return header === "local";
}

async function api(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: AppConfig; db: Db; dataDir: string; autoSync: AutoSync }
): Promise<void> {
  const { db, config } = ctx;
  const iteration = url.searchParams.get("sprint") || config.azure.iterationPath;
  if (url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      demo: getMeta(db, "demo") === "true",
      timezone: config.timezone,
      lastSync: lastSync(db),
      bind: `${config.server.host}:${config.server.port}`,
      hasPat: Boolean(azurePat())
    });
    return;
  }
  if (url.pathname === "/api/home") {
    const asOf = nowIso();
    const metrics = computeSprintMetrics(db, iteration, asOf);
    const alerts = refreshAlerts(db, config, iteration, asOf);
    const rows = iterationItems(db, iteration);
    const hidden = idsHiddenByBlock(rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      stateNormalized: row.state_normalized,
      stateOriginal: row.state_original
    })));
    const visible = rows.filter((row) => !hidden.has(row.id));
    const roots = visible.filter((row) => !row.parent_id && row.state_normalized !== "REMOVED");
    const cards = homeCards(db, config, iteration, rows, roots);
    const byState = countStates(roots);
    const visibleStories = roots.filter((row) => row.type !== "Task").length;
    const production = cards.find((card) => card.key === "prod")?.value ?? 0;
    json(res, 200, {
      demo: getMeta(db, "demo") === "true",
      demoWarning: getMeta(db, "demo_warning"),
      iteration,
      dates: get(db, "SELECT name, start_date, finish_date FROM iterations WHERE id = ?", iteration),
      lastSync: lastSync(db, iteration),
      timezone: config.timezone,
      agingUnit: config.agingUnit,
      metrics: { ...metrics, byState, production },
      cards,
      alerts,
      charts: {
        states: chartStateDistribution(byState),
        scope: scopeWithoutBlocked(metrics.scope, visibleStories),
        production: {
          developed: (byState.DEV_DONE ?? 0) + (byState.QA ?? 0) + (byState.UAT ?? 0) + (byState.PENDING_RELEASE ?? 0) + production,
          production,
          note: "Desarrollo terminado puede incluir trabajo ya en producción; no son categorías excluyentes."
        }
      },
      sqlGaps: listSqlGaps(db, iteration),
      functionalQuestions: listFunctionalQuestions(db, iteration),
      board: loadMemberBoard(db, config, iteration),
      syncCommand: `tl-control sync --iteration "${iteration}"`,
      hasPat: Boolean(azurePat())
    });
    return;
  }
  if (url.pathname === "/api/daily-report" && req.method === "GET") {
    const htmlDoc = renderDailyReport(db, config, iteration);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(htmlDoc);
    return;
  }
  if (url.pathname === "/api/grid") {
    json(res, 200, {
      rows: gridRows(db, config, iteration, url.searchParams.get("scope") !== "all"),
      scope: url.searchParams.get("scope") === "all" ? "all" : "team"
    });
    return;
  }
  if (url.pathname.startsWith("/api/story/") && url.pathname.endsWith("/publish") && req.method === "POST") {
    const azureId = decodeURIComponent(url.pathname.slice("/api/story/".length, url.pathname.length - "/publish".length).replace(/\/$/, ""));
    readJson(req, (body) => {
      void publishApprovedDrafts(db, config, azureId, Boolean(body.confirm))
        .then((result) => json(res, 200, result))
        .catch((error) => json(res, 400, { ok: false, error: publicError(error) }));
    });
    return;
  }
  if (url.pathname.startsWith("/api/story/") && req.method === "GET") {
    const azureId = decodeURIComponent(url.pathname.slice("/api/story/".length));
    json(res, 200, storyDetail(db, config, azureId, iteration));
    return;
  }
  if (url.pathname === "/api/drafts/assign" && req.method === "POST") {
    readJson(req, (body) => {
      try {
        const memberId = body.memberId == null || body.memberId === "" ? null : String(body.memberId);
        json(res, 200, assignDraft(db, config, String(body.draftId ?? ""), memberId));
      } catch (error) {
        json(res, 400, { ok: false, error: String(error) });
      }
    });
    return;
  }
  if (url.pathname === "/api/drafts/review" && req.method === "POST") {
    readJson(req, (body) => {
      try {
        json(res, 200, reviewDraft(db, String(body.draftId ?? ""), String(body.status ?? "pending") as ReviewStatus));
      } catch (error) {
        json(res, 400, { ok: false, error: String(error) });
      }
    });
    return;
  }
  if (url.pathname === "/api/sp") {
    json(res, 200, spView(db, config));
    return;
  }
  if (url.pathname === "/api/team") {
    json(res, 200, teamView(db, config, iteration));
    return;
  }
  if (url.pathname === "/api/releases") {
    json(res, 200, { releases: listReleases(db, url.searchParams.get("id") ?? undefined) });
    return;
  }
  if (url.pathname === "/api/security") {
    json(res, 200, securityView(db));
    return;
  }
  if (url.pathname === "/api/history") {
    json(res, 200, {
      snapshots: all(db, "SELECT id, kind, iteration_id, captured_at, closed, report_path, coverage_json FROM snapshots ORDER BY captured_at DESC"),
      syncRuns: all(db, "SELECT id, started_at, finished_at, status, coverage_json, error FROM sync_runs ORDER BY started_at DESC")
    });
    return;
  }
  if (url.pathname === "/api/sync" && req.method === "GET") {
    json(res, 200, ctx.autoSync.status());
    return;
  }
  if (url.pathname === "/api/sync" && req.method === "POST") {
    const result = await ctx.autoSync.trigger();
    json(res, result.busy ? 409 : result.ok ? 200 : 400, result);
    return;
  }
  if (url.pathname === "/api/questions/answer" && req.method === "POST") {
    readJson(req, (body) => {
      const ok = answerFunctionalQuestion(db, String(body.id ?? ""));
      json(res, ok ? 200 : 404, { ok });
    });
    return;
  }
  if (url.pathname === "/api/questions/post" && req.method === "POST") {
    readJson(req, (body) => {
      const pat = azurePat();
      if (!pat) {
        json(res, 400, { ok: false, error: "Sin PAT. Copiá el texto y pegalo en la historia." });
        return;
      }
      const client = new AzureDevOpsClient(config, new FetchHttpClient(), { pat });
      void publishFunctionalQuestions(db, config, String(body.workItemId ?? ""), (azureId, text) => client.addComment(azureId, text))
        .then((result) => json(res, result.ok ? 200 : 400, result))
        .catch((error) => json(res, 400, { ok: false, error: publicError(error) }));
    });
    return;
  }
  if (url.pathname === "/api/board" && req.method === "POST") {
    readJson(req, (body) => {
      try {
        json(res, 200, { ok: true, board: saveMemberBoard(db, config, iteration, body) });
      } catch (error) {
        json(res, 400, { ok: false, error: publicError(error) });
      }
    });
    return;
  }
  if (url.pathname === "/api/notes" && req.method === "POST") {
    readJson(req, (body) => {
      run(
        db,
        "INSERT INTO tl_notes(work_item_id, note, updated_at) VALUES (?, ?, ?) ON CONFLICT(work_item_id) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at",
        sqlv(body.workItemId),
        String(body.note ?? ""),
        nowIso()
      );
      json(res, 200, { ok: true });
    });
    return;
  }
  json(res, 404, { error: "NOT_FOUND" });
}

interface IterationItem {
  id: string;
  azure_id: number;
  title: string;
  parent_id: string | null;
  type: string;
  state_normalized: string;
  state_original: string | null;
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  priority: number | null;
}

function iterationItems(db: Db, iteration: string): IterationItem[] {
  return all<IterationItem>(
    db,
    `SELECT id, azure_id, title, parent_id, type, state_normalized, state_original, assigned_to_id, assigned_to_name, priority
     FROM work_items WHERE iteration_id = ?`,
    iteration
  );
}

function createdTaskIds(db: Db, iteration: string, owner: { displayName: string; azureId: string }): Set<string> {
  const revisions = all<{ id: string; payload_json: string }>(
    db,
    `SELECT w.id, r.payload_json
     FROM work_items w
     JOIN work_item_revisions r ON r.work_item_id = w.id AND r.revision = 1
     WHERE w.iteration_id = ? AND w.type = 'Task'`,
    iteration
  );
  const ownerName = owner.displayName.trim().toLowerCase();
  const ownerAzure = owner.azureId.trim().toLowerCase();
  const ids = new Set<string>();
  for (const revision of revisions) {
    let created: unknown;
    try {
      created = (JSON.parse(revision.payload_json) as { "System.CreatedBy"?: unknown })["System.CreatedBy"];
    } catch {
      continue;
    }
    if (createdByOwner(created, ownerName, ownerAzure)) ids.add(revision.id);
  }
  return ids;
}

function createdByOwner(created: unknown, ownerName: string, ownerAzure: string): boolean {
  if (!created || !ownerName) return false;
  if (typeof created === "string") return created.trim().toLowerCase() === ownerName;
  const identity = created as { displayName?: string; id?: string };
  const display = String(identity.displayName ?? "").trim().toLowerCase();
  const id = String(identity.id ?? "").trim().toLowerCase();
  if (display === ownerName) return true;
  return Boolean(ownerAzure && id && (id === ownerAzure || id.endsWith(`/${ownerAzure}`)));
}

function countStates(rows: IterationItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.state_normalized === "REMOVED") continue;
    out[row.state_normalized] = (out[row.state_normalized] ?? 0) + 1;
  }
  return out;
}

function scopeWithoutBlocked(scope: ScopeMetrics, visibleStories: number): ScopeMetrics {
  if (scope.baselineAt) return { ...scope, current: visibleStories };
  return { ...scope, initial: visibleStories, current: visibleStories };
}

function homeCards(db: Db, config: AppConfig, iteration: string, rows: IterationItem[], roots: IterationItem[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const owner = defaultOwnerMember(config);
  const mine = createdTaskIds(db, iteration, owner);
  const devTasks = rows.filter((row) => mine.has(row.id) && row.type === "Task" && row.state_normalized !== "REMOVED" && !isBlockedWorkItem(row.state_normalized, row.state_original));
  const stories = roots.filter((row) => row.type !== "Task");
  const loose = roots.filter((row) => row.type === "Task");
  const blocked = rows.filter((row) => isBlockedWorkItem(row.state_normalized, row.state_original) && !row.parent_id);
  const todo = roots.filter((row) => row.state_normalized === "NEW" || row.state_normalized === "OTHER");
  const priority1 = roots.filter((row) => Number(row.priority) === 1);
  const doing = roots.filter((row) => row.state_normalized === "DOING" || row.state_normalized === "REVIEW");
  const assignable = roots.filter((row) => row.type === "Task" && row.state_normalized === "READY" && !row.assigned_to_id);
  const devdone = roots.filter((row) => row.type !== "Task" && row.state_normalized === "DEV_DONE");
  const production = roots.filter((row) => row.type !== "Task" && isInProduction(db, row.id));
  const card = (key: string, label: string, items: IterationItem[], tone: string) => ({
    key,
    label,
    value: items.length,
    tone,
    items: items.map((row) => cardItem(row, byId))
  });
  return [
    card("stories", "Historias", stories, stories.length ? "ok" : "muted"),
    card("tasks", "Tareas sueltas", loose, "accent"),
    card("todo", "Por hacer", todo, todo.length ? "warn" : "ok"),
    card("priority1", "Prioridad 1", priority1, priority1.length ? "warn" : "ok"),
    card("doing", "En curso", doing, doing.length ? "accent" : "muted"),
    card("blocked", "Bloqueadas", blocked, blocked.length ? "bad" : "ok"),
    card("devtasks", "Para los devs", devTasks, devTasks.length ? "accent" : "muted"),
    card("assignable", "Listas para asignar", assignable, assignable.length ? "warn" : "ok"),
    card("devdone", "Desarrollo terminado", devdone, "ok"),
    card("prod", "Producción confirmada", production, production.length ? "ok" : "muted")
  ];
}

function cardItem(row: IterationItem, byId: Map<string, IterationItem>) {
  const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
  return {
    azureId: row.azure_id,
    title: row.title,
    type: row.type,
    state: row.state_normalized,
    stateLabel: stateLabel(row.state_normalized as NormalizedState),
    assignee: row.assigned_to_name,
    parentTitle: parent ? parent.title : null,
    parentAzureId: parent?.azure_id ?? null,
    parentBlocked: parent ? isBlockedWorkItem(parent.state_normalized, parent.state_original) : false
  };
}

function typeKind(type: string): "bug" | "story" | "task" {
  const t = String(type ?? "").toLowerCase();
  if (t.includes("bug")) return "bug";
  if (t === "task" || t.includes("tarea")) return "task";
  return "story";
}

function skillTimes(db: Db, iteration: string): { analyzed: Map<string, string>; prepared: Map<string, string> } {
  const analyzed = new Map(
    all<{ work_item_id: string; created_at: string }>(
      db,
      `SELECT a.work_item_id, MAX(a.created_at) AS created_at
       FROM analyses a
       JOIN work_items w ON w.id = a.work_item_id
       WHERE w.iteration_id = ? AND a.kind = 'functional'
       GROUP BY a.work_item_id`,
      iteration
    ).map((row) => [row.work_item_id, row.created_at])
  );
  const prepared = new Map(
    all<{ work_item_id: string; created_at: string }>(
      db,
      `SELECT p.work_item_id, MAX(p.created_at) AS created_at
       FROM context_packages p
       JOIN work_items w ON w.id = p.work_item_id
       WHERE w.iteration_id = ?
       GROUP BY p.work_item_id`,
      iteration
    ).map((row) => [row.work_item_id, row.created_at])
  );
  return { analyzed, prepared };
}

function gridRows(db: Db, config: AppConfig, iteration: string, teamOnly: boolean) {
  const items = all<Record<string, unknown>>(
    db,
    "SELECT * FROM work_items WHERE iteration_id = ?",
    iteration
  );
  const times = skillTimes(db, iteration);
  const mapped = items.map((s) => {
    const id = String(s.id);
    const sp = get<{ status: string; lifecycle: string | null; name: string }>(db, "SELECT status, lifecycle, name FROM dependencies WHERE work_item_id = ? AND kind LIKE 'SP%' LIMIT 1", id);
    const rel = storyReleaseStatus(db, id);
    const owner = memberLabel(db, String(s.assigned_to_id ?? ""), String(s.assigned_to_name ?? ""));
    const inTeam = isTeamAssignment(config.team.members, String(s.assigned_to_id ?? ""), owner);
    return {
      id,
      azureId: s.azure_id,
      type: s.type,
      kind: typeKind(String(s.type)),
      title: s.title,
      parentId: s.parent_id ? String(s.parent_id) : null,
      screen: s.screen,
      module: s.module,
      priority: Number(s.priority ?? 2),
      context: !s.description_html || !s.acceptance_criteria ? "incompleto" : "ok",
      sp: sp?.lifecycle ?? sp?.status ?? "N/A",
      children: 0,
      review: s.state_normalized === "REVIEW" ? "REVIEW" : "—",
      qa: s.state_normalized,
      release: rel.inPackage ? "en paquete" : "sin paquete",
      prod: rel.production ? "PROD" : "no",
      owner,
      inTeam,
      assignedToId: s.assigned_to_id ?? null,
      state: s.state_normalized,
      stateOriginal: s.state_original,
      stateLabel: stateLabel(s.state_normalized as NormalizedState),
      analyzedAt: times.analyzed.get(id) ?? null,
      preparedAt: times.prepared.get(id) ?? null,
      depth: 0,
      group: "stories" as "bugs" | "stories" | "loose"
    };
  });
  const byId = new Map(mapped.map((r) => [r.id, r]));
  const isBlocked = (row: (typeof mapped)[0]) =>
    row.state === "BLOCKED" || String(row.stateOriginal ?? "").toLowerCase() === "blocked";

  const hasBlockedAncestor = (row: (typeof mapped)[0]) => {
    let parent = row.parentId ? byId.get(row.parentId) : undefined;
    while (parent) {
      if (isBlocked(parent)) return true;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return false;
  };

  const isHidden = (row: (typeof mapped)[0]) => isBlocked(row) || hasBlockedAncestor(row);

  for (const row of mapped) {
    row.children = mapped.filter((c) => c.parentId === row.id && !isHidden(c)).length;
  }

  const isDisplayRoot = (row: (typeof mapped)[0]) => {
    if (isHidden(row)) return false;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    const parentKept = Boolean(parent && !isHidden(parent) && (!teamOnly || parent.inTeam));
    if (parentKept) return false;
    return teamOnly ? row.inTeam : true;
  };
  const roots = mapped.filter(isDisplayRoot);

  const byPri = (a: (typeof mapped)[0], b: (typeof mapped)[0]) =>
    a.priority - b.priority || Number(a.azureId) - Number(b.azureId);

  const kidsOf = (parentId: string) =>
    mapped.filter((c) => c.parentId === parentId && !isHidden(c)).sort(byPri);

  const flatten = (nodes: typeof mapped, depth: number, group: "bugs" | "stories" | "loose"): typeof mapped => {
    const out: typeof mapped = [];
    for (const node of nodes) {
      out.push({ ...node, depth, group });
      const kids = kidsOf(node.id);
      if (kids.length) out.push(...flatten(kids, depth + 1, group));
    }
    return out;
  };

  const bugs = roots.filter((r) => r.kind === "bug").sort(byPri);
  const stories = roots.filter((r) => r.kind === "story").sort(byPri);
  const loose = roots.filter((r) => r.kind === "task").sort(byPri);
  return [...flatten(bugs, 0, "bugs"), ...flatten(stories, 0, "stories"), ...flatten(loose, 0, "loose")];
}

function storyDetail(db: Db, config: AppConfig, raw: string, iteration: string) {
  const story = get<Record<string, unknown>>(db, "SELECT * FROM work_items WHERE azure_id = ? OR id = ?", Number(raw) || -1, raw)
    ?? get<Record<string, unknown>>(db, "SELECT * FROM work_items WHERE id LIKE ?", `%/${raw}`);
  if (!story) return { error: "NOT_FOUND" };
  const id = String(story.id);
  return {
    story: { ...story, description_html: sanitizeHtml(String(story.description_html ?? "")) },
    comments: all<{ text_html: string }>(db, "SELECT * FROM comments WHERE work_item_id = ?", id).map((c) => ({
      ...c,
      text_html: sanitizeHtml(String(c.text_html ?? ""))
    })),
    evidence: all(db, "SELECT * FROM evidence WHERE work_item_id = ?", id),
    attachments: all(db, "SELECT id, file_name, content_type FROM attachments WHERE work_item_id = ?", id),
    analyses: all<{ payload_json: string }>(
      db,
      "SELECT id, kind, created_at, base_sha, repo_id, stale, payload_json FROM analyses WHERE work_item_id = ? ORDER BY created_at DESC",
      id
    ).map((a) => slimAnalysis(a)),
    contracts: all<{ definition_json: string | null }>(db, "SELECT * FROM contracts WHERE work_item_id = ?", id).map((c) => ({
      ...c,
      definition: parseJsonField(c.definition_json)
    })),
    dependencies: all(db, "SELECT * FROM dependencies WHERE work_item_id = ?", id),
    questions: all(db, "SELECT * FROM questions WHERE work_item_id = ?", id),
    drafts: all<{ payload_json: string }>(db, "SELECT * FROM draft_tasks WHERE parent_id = ?", id).map((d) => {
      const { payload_json: raw, ...rest } = d;
      return { ...rest, payload: parseJsonField(raw) };
    }),
    packages: all<{ payload_json: string }>(
      db,
      "SELECT id, context_version, context_hash, created_at, stale, payload_json FROM context_packages WHERE work_item_id = ? ORDER BY context_version DESC",
      id
    ).map((p) => {
      const { payload_json: raw, ...rest } = p;
      return { ...rest, payload: parseJsonField(raw) };
    }),
    results: all(db, "SELECT artifact_id, origin, imported_at, revision, context_hash FROM workflow_results WHERE work_item_id = ?", id),
    children: all<{ description_html: string | null }>(db, "SELECT azure_id, type, title, state_normalized, assigned_to_name, assigned_to_id, description_html, acceptance_criteria FROM work_items WHERE parent_id = ? ORDER BY azure_id", id).map((c) => ({
      ...c,
      description_html: sanitizeHtml(String(c.description_html ?? ""))
    })),
    note: get(db, "SELECT note, updated_at FROM tl_notes WHERE work_item_id = ?", id),
    release: storyReleaseStatus(db, id),
    timezone: config.timezone,
    iteration,
    team: config.team.members.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      role: m.role,
      azureIdValid: hasValidAzureId(m.azureId)
    })),
    defaultOwnerId: defaultOwnerMember(config).id,
    writesEnabled: config.azure.writes.enabled
  };
}

function spView(db: Db, config: AppConfig) {
  const deps = all<Record<string, unknown>>(
    db,
    `SELECT d.* FROM dependencies d
     JOIN work_items w ON w.id = d.work_item_id
     WHERE d.kind LIKE 'SP%' AND w.iteration_id = ?`,
    config.azure.iterationPath
  );
  const asOf = nowIso();
  return {
    timezone: config.timezone,
    agingUnit: config.agingUnit,
    items: deps.map((d) => {
      const story = get<{ title: string; azure_id: number }>(db, "SELECT title, azure_id FROM work_items WHERE id = ?", sqlv(d.work_item_id));
      const contract = d.contract_id
        ? get(db, "SELECT * FROM contracts WHERE id = ?", sqlv(d.contract_id))
        : null;
      const days = d.blocked_at ? calendarDaysBetween(String(d.blocked_at), asOf, config.timezone) : 0;
      return { ...d, story, contract, agingDays: days };
    })
  };
}

function teamView(db: Db, config: AppConfig, iteration: string) {
  return {
    members: config.team.members.map((m) => {
      const tasks = memberTasks(db, m, iteration);
      const wip = tasks.filter((t) => ["DOING", "REVIEW"].includes(String(t.state_normalized))).length;
      return { ...m, wip, tasks };
    }),
    unassigned: all(
      db,
      "SELECT id, azure_id, title, type, state_normalized FROM work_items WHERE iteration_id = ? AND (assigned_to_id IS NULL OR assigned_to_id = '')",
      iteration
    )
  };
}

function securityView(db: Db) {
  const reports = all<{ current_gate: number }>(db, "SELECT * FROM security_reports ORDER BY imported_at DESC");
  const findings = all(db, "SELECT * FROM findings");
  const current = reports.find((r) => r.current_gate === 1);
  return {
    currentGate: current ?? null,
    reports,
    findings,
    note: "El gate vigente puede diferir de la última evidencia importada."
  };
}

function serveAttachment(res: ServerResponse, id: string, ctx: { db: Db; dataDir: string }): void {
  const row = get<{ stored_path: string; content_type: string; file_name: string }>(ctx.db, "SELECT stored_path, content_type, file_name FROM attachments WHERE id = ?", id);
  if (!row) {
    json(res, 404, { error: "NOT_FOUND" });
    return;
  }
  const root = resolve(join(ctx.dataDir, "attachments"));
  let target: string;
  try {
    target = assertInsideDir(root, row.stored_path);
  } catch {
    json(res, 403, { error: "PATH_REJECTED" });
    return;
  }
  if (!existsSync(target)) {
    json(res, 404, { error: "NOT_FOUND" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": row.content_type || "application/octet-stream",
    "Content-Disposition": `inline; filename="${row.file_name.replaceAll('"', "")}"`,
    "X-Content-Type-Options": "nosniff"
  });
  createReadStream(target).pipe(res);
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(join(DASHBOARD_DIR, rel));
  if (!file.startsWith(DASHBOARD_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    const index = join(DASHBOARD_DIR, "index.html");
    if (existsSync(index)) {
      sendFile(res, index);
      return;
    }
    json(res, 404, { error: "NO_DASHBOARD" });
    return;
  }
  sendFile(res, file);
}

function sendFile(res: ServerResponse, file: string): void {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json"
  };
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}

function parseJsonField(raw: unknown): unknown {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function slimAnalysis(row: { payload_json: string } & Record<string, unknown>): Record<string, unknown> {
  const { payload_json: raw, ...rest } = row;
  const payload = parseJsonField(raw) as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return { ...rest, payload: null };
  return {
    ...rest,
    payload: {
      workItemId: payload.workItemId,
      azureId: payload.azureId,
      title: payload.title,
      generatedAt: payload.generatedAt,
      functional: payload.functional,
      readiness: payload.readiness,
      questions: payload.questions,
      evidence: payload.evidence,
      contracts: payload.contracts,
      scope: payload.scope,
      children: payload.children,
      sourceContext: payload.sourceContext
    }
  };
}

function publicError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]").slice(0, 300);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, cb: (body: Record<string, unknown>) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    cb(JSON.parse(raw) as Record<string, unknown>);
  });
} 