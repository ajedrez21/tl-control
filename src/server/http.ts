import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/types.ts";
import { dbPath, loadConfig, resolveDataDir } from "../config/load.ts";
import { openDb, all, get, run, type Db, getMeta, sqlv } from "../storage/db.ts";
import { lastSync } from "../storage/backup.ts";
import { computeSprintMetrics, chartStateDistribution } from "../metrics/sprint.ts";
import { refreshAlerts } from "../metrics/alerts.ts";
import { listReleases, storyReleaseStatus } from "../metrics/releases.ts";
import { calendarDaysBetween, nowIso } from "../domain/time.ts";
import { sanitizeHtml } from "../domain/sanitize.ts";
import { stateLabel, type NormalizedState } from "../domain/states.ts";
import { assertInsideDir } from "./safe-path.ts";

const DASHBOARD_DIR = resolve(fileURLToPath(new URL("../../dashboard/", import.meta.url)));

export interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

export function startDashboardServer(opts?: { config?: AppConfig; demo?: boolean; port?: number }): ServerHandle {
  const config = opts?.config ?? loadConfig();
  const db = openDb(dbPath(config));
  const host = config.server.host || "127.0.0.1";
  const port = opts?.port ?? config.server.port;
  const dataDir = resolveDataDir(config);

  const server = createServer((req, res) => {
    try {
      handle(req, res, { config, db, dataDir, host, port });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });

  server.listen(port, host);
  const url = `http://${host}:${port}/`;
  return {
    url,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => {
          db.close();
          resolveClose();
        });
      })
  };
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { config: AppConfig; db: Db; dataDir: string; host: string; port: number }
): void {
  const url = new URL(req.url ?? "/", `http://${ctx.host}:${ctx.port}`);
  if (req.method === "POST" && !isLocalWrite(req, ctx.host, ctx.port)) {
    json(res, 403, { error: "Escritura rechazada: origen no local." });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    api(req, res, url, ctx);
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

function api(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: AppConfig; db: Db; dataDir: string }
): void {
  const { db, config } = ctx;
  const iteration = url.searchParams.get("sprint") || config.azure.iterationPath;
  if (url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      demo: getMeta(db, "demo") === "true",
      timezone: config.timezone,
      lastSync: lastSync(db),
      bind: `${config.server.host}:${config.server.port}`
    });
    return;
  }
  if (url.pathname === "/api/home") {
    const asOf = nowIso();
    const metrics = computeSprintMetrics(db, iteration, asOf);
    const alerts = refreshAlerts(db, config, iteration, asOf);
    const cards = homeCards(db, iteration, metrics);
    json(res, 200, {
      demo: getMeta(db, "demo") === "true",
      demoWarning: getMeta(db, "demo_warning"),
      iteration,
      dates: get(db, "SELECT name, start_date, finish_date FROM iterations WHERE id = ?", iteration),
      lastSync: lastSync(db),
      timezone: config.timezone,
      agingUnit: config.agingUnit,
      metrics,
      cards,
      alerts,
      charts: {
        states: chartStateDistribution(metrics.byState),
        scope: metrics.scope,
        production: {
          developed: (metrics.byState.DEV_DONE ?? 0) + (metrics.byState.QA ?? 0) + (metrics.byState.UAT ?? 0) + (metrics.byState.PENDING_RELEASE ?? 0) + metrics.production,
          production: metrics.production,
          note: "Desarrollo terminado puede incluir trabajo ya en producción; no son categorías excluyentes."
        }
      },
      syncCommand: `tl-control sync --iteration "${iteration}"`
    });
    return;
  }
  if (url.pathname === "/api/grid") {
    json(res, 200, { rows: gridRows(db, iteration) });
    return;
  }
  if (url.pathname.startsWith("/api/story/")) {
    const azureId = decodeURIComponent(url.pathname.slice("/api/story/".length));
    json(res, 200, storyDetail(db, config, azureId, iteration));
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

function homeCards(db: Db, iteration: string, metrics: ReturnType<typeof computeSprintMetrics>) {
  const count = (sql: string, ...p: import("node:sqlite").SQLInputValue[]) => Number(get<{ n: number }>(db, sql, ...p)?.n ?? 0);
  return [
    { key: "stories", label: "Historias", value: count("SELECT COUNT(*) AS n FROM work_items WHERE iteration_id = ? AND type != 'Task' AND state_normalized != 'REMOVED'", iteration), unit: "historias", source: "work_items" },
    { key: "tasks", label: "Tareas", value: count("SELECT COUNT(*) AS n FROM work_items WHERE iteration_id = ? AND type = 'Task'", iteration), unit: "tareas", source: "work_items" },
    { key: "blocked", label: "Bloqueadas", value: metrics.blocked, unit: "historias", source: "state_normalized=BLOCKED" },
    { key: "assignable", label: "Listas para asignar", value: metrics.unassignedReady, unit: "tareas", source: "Task READY sin asignar" },
    { key: "devdone", label: "Desarrollo terminado", value: metrics.byState.DEV_DONE ?? 0, unit: "historias", source: "DEV_DONE" },
    { key: "release", label: "Pendientes de release", value: metrics.pendingRelease, unit: "historias", source: "PENDING_RELEASE" },
    { key: "prod", label: "Producción confirmada", value: metrics.production, unit: "historias", source: "deployments success PROD" }
  ];
}

function gridRows(db: Db, iteration: string) {
  const stories = all<Record<string, unknown>>(
    db,
    "SELECT * FROM work_items WHERE iteration_id = ? AND type != 'Task' ORDER BY priority, azure_id",
    iteration
  );
  return stories.map((s) => {
    const id = String(s.id);
    const sp = get<{ status: string; lifecycle: string | null; name: string }>(db, "SELECT status, lifecycle, name FROM dependencies WHERE work_item_id = ? AND kind LIKE 'SP%' LIMIT 1", id);
    const be = get<{ state_normalized: string }>(db, "SELECT state_normalized FROM work_items WHERE parent_id = ? AND (module = 'backend' OR title LIKE 'BE:%') LIMIT 1", id);
    const fe = get<{ state_normalized: string }>(db, "SELECT state_normalized FROM work_items WHERE parent_id = ? AND (module = 'frontend' OR title LIKE 'FE:%') LIMIT 1", id);
    const rel = storyReleaseStatus(db, id);
    const ctx = !s.description_html || !s.acceptance_criteria ? "incompleto" : "ok";
    const member = s.assigned_to_id
      ? get<{ display_name: string }>(db, "SELECT display_name FROM members WHERE id = ?", sqlv(s.assigned_to_id))
      : null;
    return {
      id,
      azureId: s.azure_id,
      title: s.title,
      screen: s.screen,
      module: s.module,
      priority: s.priority,
      context: ctx,
      sp: sp?.lifecycle ?? sp?.status ?? "N/A",
      be: be?.state_normalized ?? "—",
      fe: fe?.state_normalized ?? "—",
      review: s.state_normalized === "REVIEW" ? "REVIEW" : "—",
      qa: s.state_normalized,
      release: rel.inPackage ? "en paquete" : "sin paquete",
      prod: rel.production ? "PROD" : "no",
      owner: member?.display_name ?? "Sin asignar",
      state: s.state_normalized,
      stateLabel: stateLabel(s.state_normalized as NormalizedState)
    };
  });
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
    analyses: all(db, "SELECT id, kind, created_at, base_sha, repo_id, stale, payload_json FROM analyses WHERE work_item_id = ? ORDER BY created_at DESC", id),
    contracts: all(db, "SELECT * FROM contracts WHERE work_item_id = ?", id),
    dependencies: all(db, "SELECT * FROM dependencies WHERE work_item_id = ?", id),
    questions: all(db, "SELECT * FROM questions WHERE work_item_id = ?", id),
    drafts: all(db, "SELECT * FROM draft_tasks WHERE parent_id = ?", id),
    packages: all(db, "SELECT id, context_version, context_hash, created_at, stale FROM context_packages WHERE work_item_id = ? ORDER BY context_version DESC", id),
    results: all(db, "SELECT artifact_id, origin, imported_at, revision, context_hash FROM workflow_results WHERE work_item_id = ?", id),
    note: get(db, "SELECT note, updated_at FROM tl_notes WHERE work_item_id = ?", id),
    release: storyReleaseStatus(db, id),
    timezone: config.timezone,
    iteration
  };
}

function spView(db: Db, config: AppConfig) {
  const deps = all<Record<string, unknown>>(db, "SELECT * FROM dependencies WHERE kind LIKE 'SP%'");
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
      const tasks = all<{ state_normalized: string }>(db, "SELECT id, azure_id, title, state_normalized, type FROM work_items WHERE assigned_to_id = ? AND iteration_id = ?", m.id, iteration);
      const wip = tasks.filter((t) => ["DOING", "REVIEW"].includes(t.state_normalized)).length;
      return { ...m, wip, tasks };
    }),
    unassigned: all(db, "SELECT id, azure_id, title, type, state_normalized FROM work_items WHERE iteration_id = ? AND (assigned_to_id IS NULL OR assigned_to_id = '')", iteration)
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