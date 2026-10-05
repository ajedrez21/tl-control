import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { AppConfig } from "../config/types.ts";
import type { Db } from "../storage/db.ts";
import { all, get } from "../storage/db.ts";
import { lastSync } from "../storage/backup.ts";
import { escapeText } from "../domain/sanitize.ts";
import { nowIso } from "../domain/time.ts";
import { stateLabel, type NormalizedState } from "../domain/states.ts";
import { defaultOwnerMember } from "../domain/members.ts";
import { idsHiddenByBlock, isBlockedWorkItem } from "../metrics/blocked.ts";

const DONE_STATES = new Set(["DEV_DONE", "QA", "UAT", "PENDING_RELEASE", "PRODUCTION"]);
const ACTIVE_RANK: Record<string, number> = {
  DOING: 0,
  REVIEW: 1,
  QA: 2,
  UAT: 3,
  DEV_DONE: 4,
  PENDING_RELEASE: 5,
  PRODUCTION: 6,
  READY: 7,
  NEW: 8,
  OTHER: 9
};

export interface SandboxHit {
  repoId: string;
  subject: string;
}

export interface RepoScan {
  repoId: string;
  baseRef: string;
  commits: number;
  error: string | null;
}

export interface DailyEvidence {
  mentions: Map<number, SandboxHit>;
  repos: RepoScan[];
}

interface ReportItem {
  id: string;
  azureId: number;
  title: string;
  type: string;
  state: string;
  stateOriginal: string;
  assignee: string;
  parentId: string | null;
  parentTitle: string | null;
  parentAzureId: number | null;
  parentBlocked: boolean;
}

export function findSandboxMentions(
  logs: Array<{ repoId: string; subjects: string[] }>,
  ids: Iterable<number>
): Map<number, SandboxHit> {
  const pending = new Set(ids);
  const hits = new Map<number, SandboxHit>();
  for (const log of logs) {
    if (!pending.size) break;
    for (const subject of log.subjects) {
      if (!pending.size) break;
      const tokens = subject.match(/\d{4,7}/g) ?? [];
      for (const token of tokens) {
        const id = Number(token);
        if (!pending.has(id)) continue;
        hits.set(id, { repoId: log.repoId, subject: subject.slice(0, 180) });
        pending.delete(id);
      }
    }
  }
  return hits;
}

export function readRepoSubjects(localPath: string, baseRef: string, max = 1500): { subjects: string[]; error: string | null } {
  if (!localPath || !existsSync(localPath)) {
    return { subjects: [], error: "Ruta local no disponible" };
  }
  try {
    const out = execFileSync("git", ["log", baseRef, `--max-count=${max}`, "--pretty=format:%s"], {
      cwd: localPath,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4_000_000,
      windowsHide: true
    });
    return { subjects: out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), error: null };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/unknown revision|bad revision|ambiguous argument/i.test(text)) {
      return { subjects: [], error: `La rama ${baseRef} no existe en el repo local` };
    }
    return { subjects: [], error: "No se pudo leer la rama" };
  }
}

export function scanSandbox(config: AppConfig, ids: Iterable<number>): DailyEvidence {
  const repos: RepoScan[] = [];
  const logs: Array<{ repoId: string; subjects: string[] }> = [];
  for (const repo of config.repositories) {
    const read = readRepoSubjects(repo.localPath, repo.baseRef);
    repos.push({ repoId: repo.repoId, baseRef: repo.baseRef, commits: read.subjects.length, error: read.error });
    if (!read.error) logs.push({ repoId: repo.repoId, subjects: read.subjects });
  }
  return { mentions: findSandboxMentions(logs, ids), repos };
}

export function renderDailyReport(db: Db, config: AppConfig, iterationId: string, evidence?: DailyEvidence): string {
  const items = loadItems(db, iterationId);
  const hidden = idsHiddenByBlock(items.map((item) => ({
    id: item.id,
    parentId: item.parentId,
    stateNormalized: item.state,
    stateOriginal: item.stateOriginal
  })));
  const owner = defaultOwnerMember(config);
  const created = createdTasks(db, iterationId, owner.displayName, owner.azureId, items);
  const used = evidence ?? scanSandbox(config, created.map((item) => item.azureId));
  const active = items.filter((item) => item.state !== "REMOVED" && !hidden.has(item.id));
  const blocked = items.filter((item) => isBlockedWorkItem(item.state, item.stateOriginal) && !item.parentId);
  const issued = new Intl.DateTimeFormat("es-AR", {
    timeZone: config.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date());
  const sync = lastSync(db, iterationId);
  const sprint = get<{ name: string }>(db, "SELECT name FROM iterations WHERE id = ?", iterationId);
  const byPerson = groupByPerson(active);
  const doneCount = created.filter((item) => isDone(item.state)).length;
  const sandboxCount = created.filter((item) => used.mentions.has(item.azureId)).length;
  const both = created.filter((item) => isDone(item.state) && used.mentions.has(item.azureId)).length;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Informe de daily · ${escapeText(sprint?.name || iterationId)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
  <button class="print" type="button" onclick="window.print()">Guardar como PDF</button>
  <header class="doc">
    <p class="kicker">TL Control · seguimiento de sprint</p>
    <h1>Informe de daily</h1>
    <p class="lead">${escapeText(issued)}. Sprint ${escapeText(sprint?.name || iterationId)}.</p>
    <p class="meta">Última sincronización de Azure: ${escapeText(sync?.finished_at ? formatStamp(sync.finished_at, config.timezone) : "sin sync")}. Pensado para la daily de lunes, miércoles y viernes.</p>
  </header>
  <section>
    <h2>Situación</h2>
    <ul class="stats">
      <li><strong>${active.filter((item) => item.type !== "Task" && !item.parentId).length}</strong> historias activas</li>
      <li><strong>${active.filter((item) => item.state === "DOING" || item.state === "REVIEW").length}</strong> en curso</li>
      <li><strong>${active.filter((item) => isDone(item.state)).length}</strong> con desarrollo terminado o más adelante</li>
      <li><strong>${blocked.length}</strong> historias bloqueadas por estado</li>
    </ul>
  </section>
  <section>
    <h2>Quién está con qué</h2>
    <p>Ítems del sprint que no están bloqueados ni cuelgan de una historia bloqueada. El estado es el de Azure.</p>
    ${byPerson.length ? byPerson.map((group) => personHtml(group)).join("") : `<p class="empty">No hay trabajo activo fuera de los bloqueos.</p>`}
  </section>
  <section>
    <h2>Tareas creadas para el equipo</h2>
    <p>Tareas creadas por ${escapeText(owner.displayName)}. Se mira si Azure las da por hechas y si el número aparece en un commit de la rama de cada repo configurado (${escapeText(used.repos.map((repo) => `${repo.repoId}/${repo.baseRef}`).join(", ") || "sin repos")}).</p>
    <ul class="stats">
      <li><strong>${created.length}</strong> creadas</li>
      <li><strong>${doneCount}</strong> hechas en Azure</li>
      <li><strong>${sandboxCount}</strong> con evidencia en sandbox</li>
      <li><strong>${both}</strong> hechas y en sandbox</li>
    </ul>
    ${createdTable(created, used.mentions)}
    <p class="note">${repoNotes(used.repos)}</p>
  </section>
  <section>
    <h2>Bloqueos de estado</h2>
    <p>Estas historias están en estado Bloqueado. No entran en el reparto de arriba.</p>
    ${blocked.length ? `<table>
      <thead><tr><th>Ítem</th><th>Responsable</th></tr></thead>
      <tbody>${blocked.map((item) => `<tr><td>${itemCell(item)}</td><td>${escapeText(item.assignee || "Sin asignar")}</td></tr>`).join("")}</tbody>
    </table>` : `<p class="empty">Ninguna historia está en estado Bloqueado.</p>`}
  </section>
  <footer>
    <p>Generado ${escapeText(formatStamp(nowIso(), config.timezone))}. Hecha significa estado de desarrollo terminado, QA, UAT, release o producción. En sandbox significa que el número de la tarea figura en el asunto de un commit de la rama configurada. No confirma un deploy a producción.</p>
  </footer>
</body>
</html>`;
}

function personHtml(group: { name: string; items: ReportItem[] }): string {
  const rows = [...group.items].sort((a, b) => (ACTIVE_RANK[a.state] ?? 20) - (ACTIVE_RANK[b.state] ?? 20) || a.azureId - b.azureId);
  return `<article class="person">
    <h3>${escapeText(group.name)}</h3>
    <p class="progress">${escapeText(progressPhrase(rows))}</p>
    <table>
      <thead><tr><th>Tipo</th><th>Ítem</th><th>Estado</th><th>Historia</th></tr></thead>
      <tbody>${rows.map((item) => `<tr>
        <td>${escapeText(typeLabel(item.type))}</td>
        <td>${itemCell(item)}</td>
        <td>${escapeText(item.stateOriginal || stateLabel(item.state as NormalizedState))}</td>
        <td>${item.parentAzureId ? `#${item.parentAzureId} ${escapeText(item.parentTitle || "")}` : "—"}</td>
      </tr>`).join("")}</tbody>
    </table>
  </article>`;
}

function createdTable(items: ReportItem[], mentions: Map<number, SandboxHit>): string {
  if (!items.length) return `<p class="empty">No hay tareas creadas por esa persona en este sprint.</p>`;
  const rows = [...items].sort((a, b) => Number(isDone(b.state)) - Number(isDone(a.state)) || a.azureId - b.azureId);
  return `<table>
    <thead><tr><th>Tarea</th><th>Historia</th><th>Responsable</th><th>Estado</th><th>Seguimiento</th><th>Sandbox</th></tr></thead>
    <tbody>${rows.map((item) => {
      const hit = mentions.get(item.azureId);
      const done = isDone(item.state);
      return `<tr>
        <td>${itemCell(item)}</td>
        <td>${item.parentAzureId ? `#${item.parentAzureId} ${escapeText(item.parentTitle || "")}` : "—"}${item.parentBlocked ? " · padre bloqueado" : ""}</td>
        <td>${escapeText(item.assignee || "Sin asignar")}</td>
        <td>${escapeText(item.stateOriginal || stateLabel(item.state as NormalizedState))}</td>
        <td>${escapeText(verdict(done, Boolean(hit)))}</td>
        <td>${hit ? `${escapeText(hit.repoId)} · ${escapeText(hit.subject)}` : "Sin evidencia"}</td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
}

export function verdict(done: boolean, inSandbox: boolean): string {
  if (done && inSandbox) return "Terminada y en sandbox";
  if (done) return "Terminada en Azure, sin evidencia en sandbox";
  if (inSandbox) return "En sandbox; Azure sigue abierta";
  return "Pendiente";
}

function progressPhrase(items: ReportItem[]): string {
  const doing = items.filter((item) => item.state === "DOING" || item.state === "REVIEW").length;
  const done = items.filter((item) => isDone(item.state)).length;
  const pending = items.length - doing - done;
  const parts: string[] = [];
  if (doing) parts.push(countLabel(doing, "en curso", "en curso"));
  if (pending) parts.push(countLabel(pending, "pendiente", "pendientes"));
  if (done) parts.push(countLabel(done, "terminada", "terminadas"));
  return parts.join(" · ") || "Sin ítems";
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function isDone(state: string): boolean {
  return DONE_STATES.has(state);
}

function typeLabel(type: string): string {
  const value = type.toLowerCase();
  if (value === "task") return "Tarea";
  if (value.includes("bug")) return "Bug";
  return "Historia";
}

function itemCell(item: ReportItem): string {
  return `<span class="id">#${item.azureId}</span> ${escapeText(item.title)}`;
}

function groupByPerson(items: ReportItem[]): Array<{ name: string; items: ReportItem[] }> {
  const groups = new Map<string, ReportItem[]>();
  for (const item of items) {
    const name = item.assignee || "Sin asignar";
    const list = groups.get(name) ?? [];
    list.push(item);
    groups.set(name, list);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      if (a[0] === "Sin asignar") return 1;
      if (b[0] === "Sin asignar") return -1;
      const doingA = a[1].some((item) => item.state === "DOING" || item.state === "REVIEW") ? 0 : 1;
      const doingB = b[1].some((item) => item.state === "DOING" || item.state === "REVIEW") ? 0 : 1;
      return doingA - doingB || a[0].localeCompare(b[0], "es");
    })
    .map(([name, list]) => ({ name, items: list }));
}

function repoNotes(repos: RepoScan[]): string {
  if (!repos.length) return "No hay repositorios configurados para revisar sandbox.";
  return repos.map((repo) => {
    if (repo.error) return `${repo.repoId} (${repo.baseRef}): ${repo.error}.`;
    return `${repo.repoId}: se revisaron ${repo.commits} commits de ${repo.baseRef}.`;
  }).join(" ");
}

function formatStamp(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(iso));
}

function loadItems(db: Db, iterationId: string): ReportItem[] {
  const rows = all<{
    id: string;
    azure_id: number;
    title: string;
    parent_id: string | null;
    type: string;
    state_normalized: string;
    state_original: string | null;
    assigned_to_name: string | null;
  }>(
    db,
    `SELECT id, azure_id, title, parent_id, type, state_normalized, state_original, assigned_to_name
     FROM work_items WHERE iteration_id = ?`,
    iterationId
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.map((row) => {
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    return {
      id: row.id,
      azureId: row.azure_id,
      title: row.title,
      type: row.type,
      state: row.state_normalized,
      stateOriginal: row.state_original ?? "",
      assignee: row.assigned_to_name?.trim() || "",
      parentId: row.parent_id,
      parentTitle: parent?.title ?? null,
      parentAzureId: parent?.azure_id ?? null,
      parentBlocked: parent ? isBlockedWorkItem(parent.state_normalized, parent.state_original) : false
    };
  });
}

function createdTasks(
  db: Db,
  iterationId: string,
  ownerName: string,
  ownerAzure: string,
  items: ReportItem[]
): ReportItem[] {
  const revisions = all<{ id: string; payload_json: string }>(
    db,
    `SELECT w.id, r.payload_json
     FROM work_items w
     JOIN work_item_revisions r ON r.work_item_id = w.id AND r.revision = 1
     WHERE w.iteration_id = ? AND w.type = 'Task'`,
    iterationId
  );
  const ids = new Set<string>();
  const name = ownerName.trim().toLowerCase();
  const azure = ownerAzure.trim().toLowerCase();
  for (const revision of revisions) {
    let created: unknown;
    try {
      created = (JSON.parse(revision.payload_json) as { "System.CreatedBy"?: unknown })["System.CreatedBy"];
    } catch {
      continue;
    }
    if (createdBy(created, name, azure)) ids.add(revision.id);
  }
  return items.filter((item) => ids.has(item.id) && item.type === "Task" && item.state !== "REMOVED");
}

function createdBy(created: unknown, ownerName: string, ownerAzure: string): boolean {
  if (!created || !ownerName) return false;
  if (typeof created === "string") return created.trim().toLowerCase() === ownerName;
  const identity = created as { displayName?: string; id?: string };
  const display = String(identity.displayName ?? "").trim().toLowerCase();
  const id = String(identity.id ?? "").trim().toLowerCase();
  if (display === ownerName) return true;
  return Boolean(ownerAzure && id && (id === ownerAzure || id.endsWith(`/${ownerAzure}`)));
}

const REPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 980px; padding: 32px 28px 64px; color: #1c2430; background: #fff; font: 15px/1.45 "Segoe UI", system-ui, sans-serif; }
  .print { position: sticky; top: 12px; float: right; border: 0; border-radius: 8px; padding: 10px 14px; background: #1e3a5f; color: #fff; font: inherit; cursor: pointer; }
  .kicker { margin: 0; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; color: #5c6b7a; }
  h1 { margin: 4px 0 8px; font-size: 32px; letter-spacing: -0.03em; }
  h2 { margin: 28px 0 8px; padding-bottom: 6px; border-bottom: 2px solid #1e3a5f; font-size: 18px; }
  h3 { margin: 0 0 4px; font-size: 16px; }
  .lead { margin: 0; font-size: 17px; }
  .meta, .note, footer p { color: #5c6b7a; font-size: 13px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 0; margin: 8px 0 0; list-style: none; }
  .stats li { background: #f4f7fb; border: 1px solid #d9e2ec; border-radius: 8px; padding: 8px 12px; }
  .person { break-inside: avoid; margin: 16px 0 22px; }
  .progress { margin: 0 0 8px; color: #3d4d5c; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #e3e8ef; padding: 7px 8px; }
  th { background: #f4f7fb; font-size: 12px; letter-spacing: .02em; }
  .id { font-variant-numeric: tabular-nums; color: #1e3a5f; font-weight: 650; }
  .empty { color: #5c6b7a; }
  footer { margin-top: 28px; border-top: 1px solid #d9e2ec; padding-top: 12px; }
  @media print {
    .print { display: none; }
    body { padding: 0; max-width: none; }
    h2 { break-after: avoid; }
    tr, .person { break-inside: avoid; }
  }
`;
