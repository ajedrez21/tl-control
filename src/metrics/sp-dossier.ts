import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AppConfig } from "../config/types.ts";
import type { Db } from "../storage/db.ts";
import { all, get } from "../storage/db.ts";
import { htmlToText, sanitizeHtml } from "../domain/sanitize.ts";
import { rewriteAzureAttachmentUrls } from "../domain/azure-images.ts";
import { calendarDaysBetween, nowIso } from "../domain/time.ts";
import { inspectRepo } from "../adapters/git/repos.ts";
import { listSqlGaps, type SqlGap } from "./sql-gaps.ts";
import {
  buildCodeTrace,
  extractLegacySpNames,
  extractProductSpNames,
  type SpApiTrace,
  type SpCapture,
  type SpCodeTrace
} from "./sp-code-trace.ts";

export type SpUsageKind = "lectura" | "envio" | "desconocido";

export interface SpLayerItem {
  azureId: number | null;
  title: string;
  assignee: string | null;
  source: "azure" | "draft";
}

export interface SpNameRef {
  name: string | null;
  usage: SpUsageKind;
  status: string;
  lifecycle: string | null;
  source: "contract" | "dependency" | "analysis" | "text" | "task" | "repo";
  confirmed: boolean;
}

export interface SpContractItem {
  azureId: number;
  title: string;
  type: string;
  descriptionHtml: string;
  acceptanceCriteria: string | null;
}

export interface SpWorkContract {
  story: SpContractItem;
  tasks: SpContractItem[];
}

export interface SpTrace {
  workItemId: string;
  azureId: number;
  title: string;
  type: string;
  screen: string | null;
  module: string | null;
  frontend: SpLayerItem[];
  backend: SpLayerItem[];
  filesFe: string[];
  filesBe: string[];
  repoNote: string | null;
  sps: SpNameRef[];
  reads: SpNameRef[];
  writes: SpNameRef[];
  unknown: SpNameRef[];
  sqlReads: SpNameRef[];
  sqlWrites: SpNameRef[];
  workContract: SpWorkContract;
  gap: SqlGap | null;
  missingContract: boolean;
  explanation: string;
  captures: SpCapture[];
  screenInferred: string | null;
  screenSource: string | null;
  frontendPages: string[];
  apis: SpApiTrace[];
  codeNote: string | null;
}

export type { SpCapture, SpApiTrace, SpCodeTrace };

export interface SpDepView {
  id: string;
  name: string | null;
  kind: string;
  status: string;
  lifecycle: string | null;
  responsible_team: string | null;
  agingDays: number;
  story: { azure_id: number; title: string } | null;
}

export interface SpRepoStatus {
  repoId: string;
  role: string;
  available: boolean;
  note: string;
}

export interface SpDossier {
  timezone: string;
  agingUnit: string;
  iteration: string;
  repoStatus: SpRepoStatus[];
  gaps: SqlGap[];
  items: SpDepView[];
  traces: SpTrace[];
}

const CONFIRMED = new Set(["CONFIRMED", "CONTRACT_CONFIRMED", "AVAILABLE", "VALIDATED", "SATISFIED"]);
const READ_HINT = /\b(consulta|listar|select|get|read|exportar|buscar|obtener|grilla|listado)\b/i;
const WRITE_HINT = /\b(alta|insert|update|post|save|enviar|mandar|grabar|persistir|guardar|escribir)\b/i;

interface WorkRow {
  id: string;
  azure_id: number;
  title: string;
  type: string;
  parent_id: string | null;
  screen: string | null;
  module: string | null;
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  description_html: string | null;
  acceptance_criteria: string | null;
}

interface RepoHit {
  repoId: string;
  role: string;
  path: string;
  names: string[];
}

export function listSpDossier(db: Db, config: AppConfig, iterationId = config.azure.iterationPath): SpDossier {
  const gaps = listSqlGaps(db, iterationId);
  const items = listSpDeps(db, config, iterationId);
  const workItems = all<WorkRow>(
    db,
    `SELECT id, azure_id, title, type, parent_id, screen, module, assigned_to_id, assigned_to_name, description_html, acceptance_criteria
     FROM work_items WHERE iteration_id = ?`,
    iterationId
  );
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const childrenByParent = new Map<string, WorkRow[]>();
  for (const item of workItems) {
    if (!item.parent_id) continue;
    const list = childrenByParent.get(item.parent_id) ?? [];
    list.push(item);
    childrenByParent.set(item.parent_id, list);
  }

  const roots = new Map<string, WorkRow>();
  const remember = (id: string | null | undefined) => {
    if (!id) return;
    const row = byId.get(id);
    if (!row) return;
    const root = row.parent_id && byId.get(row.parent_id) ? byId.get(row.parent_id)! : row;
    roots.set(root.id, root);
  };

  const gapAzureIds = new Set(gaps.map((gap) => gap.azureId));
  const gapItemIds = new Set(workItems.filter((item) => gapAzureIds.has(item.azure_id)).map((item) => item.id));
  for (const gap of gaps) {
    const row = workItems.find((item) => item.azure_id === gap.azureId);
    remember(row?.id);
  }

  const repoScan = scanConfiguredRepos(config);
  const traces = [...roots.values()]
    .sort((a, b) => a.azure_id - b.azure_id)
    .map((root) =>
      buildTrace(db, config, root, childrenByParent.get(root.id) ?? [], gaps, repoScan.hits)
    );

  const allowedDepIds = new Set<string>(gapItemIds);
  for (const root of roots.values()) {
    allowedDepIds.add(root.id);
    for (const child of childrenByParent.get(root.id) ?? []) allowedDepIds.add(child.id);
  }

  return {
    timezone: config.timezone,
    agingUnit: config.agingUnit,
    iteration: iterationId,
    repoStatus: repoScan.status,
    gaps,
    items: items.filter((item) => allowedDepIds.has(item.work_item_id) || (item.story != null && gapAzureIds.has(item.story.azure_id))),
    traces
  };
}

function listSpDeps(db: Db, config: AppConfig, iterationId: string): SpDepView[] {
  const deps = all<{
    id: string;
    work_item_id: string;
    name: string | null;
    kind: string;
    status: string;
    lifecycle: string | null;
    responsible_team: string | null;
    blocked_at: string | null;
  }>(
    db,
    `SELECT d.id, d.work_item_id, d.name, d.kind, d.status, d.lifecycle, d.responsible_team, d.blocked_at
     FROM dependencies d
     JOIN work_items w ON w.id = d.work_item_id
     WHERE d.kind LIKE 'SP%' AND w.iteration_id = ?`,
    iterationId
  );
  const asOf = nowIso();
  return deps.map((dep) => {
    const story = get<{ title: string; azure_id: number }>(db, "SELECT title, azure_id FROM work_items WHERE id = ?", dep.work_item_id);
    const days = dep.blocked_at ? calendarDaysBetween(dep.blocked_at, asOf, config.timezone) : 0;
    return {
      id: dep.id,
      name: dep.name,
      kind: dep.kind,
      status: dep.status,
      lifecycle: dep.lifecycle,
      responsible_team: dep.responsible_team,
      agingDays: days,
      story: story ?? null
    };
  });
}

function buildTrace(
  db: Db,
  config: AppConfig,
  root: WorkRow,
  children: WorkRow[],
  gaps: SqlGap[],
  repoHits: RepoHit[]
): SpTrace {
  const blob = textBlob(root, children);
  const frontend: SpLayerItem[] = [];
  const backend: SpLayerItem[] = [];
  const pushLayer = (layer: "FE" | "BE" | null, item: SpLayerItem) => {
    if (layer === "FE") frontend.push(item);
    if (layer === "BE") backend.push(item);
  };

  for (const child of children) {
    pushLayer(detectLayer(child.title, child.assigned_to_id, config), {
      azureId: child.azure_id,
      title: child.title,
      assignee: child.assigned_to_name,
      source: "azure"
    });
  }

  for (const draft of all<{ title: string; layer: string; assigned_to_id: string | null }>(
    db,
    "SELECT title, layer, assigned_to_id FROM draft_tasks WHERE parent_id = ?",
    root.id
  )) {
    const layer = draft.layer === "FE" || draft.layer === "BE" ? draft.layer : detectLayer(draft.title, draft.assigned_to_id, config);
    pushLayer(layer, {
      azureId: null,
      title: draft.title,
      assignee: draft.assigned_to_id,
      source: "draft"
    });
  }

  const sps = collectSps(db, root, children, blob);
  const needles = distinctiveNeedles(root);
  attachRepoHits(sps, repoHits, needles, blob);
  const named = sps.map((sp) => sp.name).filter((name): name is string => Boolean(name));
  const analysisFiles = latestAnalysisFiles(db, root.id, needles, named);
  const filesFe = unique([
    ...analysisFiles.fe,
    ...repoHits.filter((hit) => hit.role === "frontend" && fileRelevant(hit.path, needles, named)).map((hit) => hit.path)
  ]);
  const filesBe = unique([
    ...analysisFiles.be,
    ...repoHits.filter((hit) => hit.role === "backend" && fileRelevant(hit.path, needles, named)).map((hit) => hit.path)
  ]);

  const relatedIds = new Set([root.azure_id, ...children.map((child) => child.azure_id)]);
  const gap = gaps.find((item) => relatedIds.has(item.azureId)) ?? null;
  const repoNote =
    filesFe.length || filesBe.length
      ? "Archivos por coincidencia de texto en el repo local. El nombre no confirma el contrato."
      : analysisFiles.note;

  const code = buildCodeTrace(db, config, root, children, filesFe, filesBe, root.screen || root.module);
  mergeApiSps(sps, code.apis);
  const reads = sps.filter((sp) => sp.usage === "lectura");
  const writes = sps.filter((sp) => sp.usage === "envio");
  const unknown = sps.filter((sp) => sp.usage === "desconocido");
  const sqlSps = spsForSqlRequest({ gap, sps, reads, writes, unknown });
  const missingContract = Boolean(gap) || (sps.length > 0 && !sps.some((sp) => sp.confirmed));
  const screen =
    code.screenInferred || root.screen || root.module;
  const filesFeResolved = unique([...code.frontendPages, ...code.apis.flatMap((api) => api.feFiles), ...filesFe]);
  const filesBeResolved = unique([...code.apis.flatMap((api) => api.beFiles), ...filesBe]);

  return {
    workItemId: root.id,
    azureId: root.azure_id,
    title: root.title,
    type: root.type,
    screen,
    module: root.module,
    frontend,
    backend,
    filesFe: filesFeResolved,
    filesBe: filesBeResolved,
    repoNote,
    sps,
    reads,
    writes,
    unknown,
    sqlReads: sqlSps.reads,
    sqlWrites: sqlSps.writes,
    workContract: {
      story: toContractItem(root),
      tasks: children.map(toContractItem)
    },
    gap,
    missingContract,
    captures: code.captures,
    screenInferred: code.screenInferred,
    screenSource: code.screenSource,
    frontendPages: code.frontendPages,
    apis: code.apis,
    codeNote: code.codeNote,
    explanation: explainTrace({
      azureId: root.azure_id,
      title: root.title,
      screen,
      screenSource: code.screenSource,
      captures: code.captures,
      frontendPages: code.frontendPages,
      apis: code.apis,
      frontend,
      backend,
      filesFe: filesFeResolved,
      filesBe: filesBeResolved,
      reads,
      writes,
      unknown,
      gap,
      missingContract,
      codeNote: code.codeNote
    })
  };
}

function collectSps(db: Db, root: WorkRow, children: WorkRow[], blob: string): SpNameRef[] {
  const byKey = new Map<string, SpNameRef>();
  const remember = (ref: SpNameRef) => {
    const key = `${(ref.name ?? "").toLowerCase()}::${ref.usage}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, ref);
      return;
    }
    if (rank(ref) > rank(prev)) byKey.set(key, { ...prev, ...ref, usage: ref.usage === "desconocido" ? prev.usage : ref.usage });
  };

  for (const row of all<{ name: string | null; status: string; definition_json: string | null }>(
    db,
    "SELECT name, status, definition_json FROM contracts WHERE work_item_id = ? AND kind = 'SP'",
    root.id
  )) {
    const definition = parseObject(row.definition_json);
    remember({
      name: text(row.name),
      usage: classifyUsage(`${row.name ?? ""} ${JSON.stringify(definition ?? {})} ${blob}`, definition),
      status: row.status,
      lifecycle: null,
      source: "contract",
      confirmed: CONFIRMED.has(row.status)
    });
  }

  for (const row of all<{ name: string | null; status: string; lifecycle: string | null }>(
    db,
    "SELECT name, status, lifecycle FROM dependencies WHERE work_item_id = ? AND kind LIKE 'SP%'",
    root.id
  )) {
    remember({
      name: text(row.name)?.replace(/@.*$/, "") ?? null,
      usage: classifyUsage(`${row.name ?? ""} ${blob}`, null),
      status: row.status,
      lifecycle: row.lifecycle,
      source: "dependency",
      confirmed: CONFIRMED.has(row.status) || CONFIRMED.has(row.lifecycle ?? "")
    });
  }

  const seenAnalysis = new Set<string>();
  for (const row of all<{ payload_json: string }>(
    db,
    "SELECT payload_json FROM analyses WHERE work_item_id = ? AND kind IN ('functional', 'sp') ORDER BY created_at DESC",
    root.id
  )) {
    if (seenAnalysis.has(root.id)) break;
    seenAnalysis.add(root.id);
    const payload = parseObject(row.payload_json);
    for (const contract of asArray(payload?.contracts)) {
      if (String(contract.kind ?? "") !== "SP") continue;
      remember({
        name: text(contract.name),
        usage: classifyUsage(`${contract.name ?? ""} ${JSON.stringify(contract.definition ?? {})} ${blob}`, parseObject(contract.definition)),
        status: String(contract.status ?? "UNKNOWN"),
        lifecycle: text(contract.lifecycle),
        source: "analysis",
        confirmed: CONFIRMED.has(String(contract.status ?? ""))
      });
    }
  }

  for (const name of unique([...extractSpNames(blob), ...extractProductSpNames(blob)])) {
    remember({
      name,
      usage: classifyUsage(blob, null, name),
      status: "UNKNOWN",
      lifecycle: null,
      source: "text",
      confirmed: false
    });
  }

  for (const child of children) {
    for (const name of unique([...extractSpNames(child.title), ...extractProductSpNames(child.title)])) {
      remember({
        name,
        usage: classifyUsage(`${child.title} ${blob}`, null, name),
        status: "UNKNOWN",
        lifecycle: null,
        source: "task",
        confirmed: false
      });
    }
  }

  return [...byKey.values()].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
}

function attachRepoHits(sps: SpNameRef[], hits: RepoHit[], needles: string[], blob: string): void {
  const known = new Set(sps.map((sp) => (sp.name ?? "").toLowerCase()).filter(Boolean));
  const named = [...known];
  const mentioned = new Set(extractSpNames(blob).map((name) => name.toLowerCase()));
  for (const hit of hits) {
    if (!fileRelevant(hit.path, needles, named)) continue;
    for (const name of hit.names) {
      if (known.has(name.toLowerCase())) continue;
      if (!mentioned.has(name.toLowerCase())) continue;
      known.add(name.toLowerCase());
      sps.push({
        name,
        usage: classifyUsage(`${blob} ${name}`, null, name),
        status: "UNKNOWN",
        lifecycle: null,
        source: "repo",
        confirmed: false
      });
    }
  }
}

function distinctiveNeedles(root: WorkRow): string[] {
  const fromFields = [root.screen, root.module]
    .flatMap((value) => (value ?? "").split(/[^A-Za-z0-9+]+/))
    .map((value) => value.trim())
    .filter((value) => value.length >= 5);
  const fromTitle = root.title
    .split(/[^A-Za-z0-9+]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
  return unique([...fromFields, ...fromTitle]);
}

function fileRelevant(path: string, needles: string[], spNames: string[]): boolean {
  if (!path) return false;
  if (/(^|\/)(\.cursor|audit-output|node_modules|dist|bin|obj)(\/|$)/i.test(path.replaceAll("\\", "/"))) return false;
  if (!/\.(ts|tsx|js|jsx|cs|sql)$/i.test(path)) return false;
  const hay = path.toLowerCase().replaceAll("\\", "/");
  if (needles.some((needle) => hay.includes(needle.toLowerCase()))) return true;
  return spNames.some((name) => hay.includes(name.replace(/^dbo\./i, "").toLowerCase()));
}

function latestAnalysisFiles(
  db: Db,
  workItemId: string,
  needles: string[],
  spNames: string[]
): { fe: string[]; be: string[]; note: string | null } {
  const row = get<{ payload_json: string }>(
    db,
    "SELECT payload_json FROM analyses WHERE work_item_id = ? AND kind = 'functional' ORDER BY created_at DESC LIMIT 1",
    workItemId
  );
  if (!row) return { fe: [], be: [], note: null };
  const payload = parseObject(row.payload_json);
  const repos = asArray(payload?.repositories);
  const fe: string[] = [];
  const be: string[] = [];
  for (const repo of repos) {
    const role = String(repo.role ?? repo.repoId ?? "");
    const files = asArray(repo.candidateFiles)
      .filter((file) => file.verified !== false)
      .map((file) => String(file.path ?? ""))
      .filter((path) => fileRelevant(path, needles, spNames));
    if (/front/i.test(role)) fe.push(...files);
    else if (/back/i.test(role)) be.push(...files);
  }
  return { fe: unique(fe), be: unique(be), note: repos.length ? "Archivos del último analyze-story, filtrados por pantalla/módulo." : null };
}

function scanConfiguredRepos(config: AppConfig): { status: SpRepoStatus[]; hits: RepoHit[] } {
  const status: SpRepoStatus[] = [];
  const hits: RepoHit[] = [];
  for (const repo of config.repositories) {
    const snap = inspectRepo(repo.repoId, repo.localPath, repo.baseRef);
    status.push({
      repoId: repo.repoId,
      role: repo.role,
      available: snap.available,
      note: snap.available
        ? `Repo ${repo.repoId} leído en ${repo.baseRef}. Los nombres de SP en código son hipótesis, no contrato.`
        : snap.error ?? "Ruta no configurada o inaccesible"
    });
    if (!snap.available) continue;
    for (const file of scanRepoSpFiles(repo.localPath)) {
      hits.push({ repoId: repo.repoId, role: repo.role, path: file.path, names: file.names });
    }
  }
  return { status, hits };
}

function scanRepoSpFiles(localPath: string, maxFiles = 40): Array<{ path: string; names: string[] }> {
  if (!localPath || !existsSync(localPath)) return [];
  const hits: Array<{ path: string; names: string[] }> = [];
  walk(localPath, localPath, (abs, rel) => {
    if (hits.length >= maxFiles) return;
    if (!/\.(ts|tsx|js|jsx|cs|sql)$/i.test(rel)) return;
    let text = "";
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    const names = unique([...extractSpNames(text), ...extractProductSpNames(text)]);
    if (!names.length) return;
    hits.push({ path: rel.replaceAll("\\", "/"), names });
  });
  return hits;
}

function walk(root: string, dir: string, visit: (abs: string, rel: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "dist" ||
      entry.name === "bin" ||
      entry.name === "obj" ||
      entry.name === ".cursor" ||
      entry.name === "audit-output"
    ) {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, visit);
    else if (entry.isFile()) {
      try {
        if (statSync(abs).size > 800_000) continue;
      } catch {
        continue;
      }
      visit(abs, relative(root, abs));
    }
  }
}

function detectLayer(title: string, assignedToId: string | null, config: AppConfig): "FE" | "BE" | null {
  if (/^\s*FE\b|^frontend\b/i.test(title)) return "FE";
  if (/^\s*BE\b|^backend\b/i.test(title)) return "BE";
  const member = config.team.members.find((item) => item.id === assignedToId);
  if (member?.role === "frontend") return "FE";
  if (member?.role === "backend") return "BE";
  return null;
}

export function extractSpNames(text: string): string[] {
  return extractLegacySpNames(text);
}

export function spsForSqlRequest(input: {
  gap: SqlGap | null;
  sps: SpNameRef[];
  reads: SpNameRef[];
  writes: SpNameRef[];
  unknown: SpNameRef[];
}): { reads: SpNameRef[]; writes: SpNameRef[] } {
  const change = input.gap?.change;
  if (change === "ADD" || change === "UPDATE") {
    return {
      reads: uniqueSps(input.sps.filter((sp) => sp.usage !== "envio")),
      writes: uniqueSps(input.sps.filter((sp) => sp.usage === "envio"))
    };
  }
  return {
    reads: uniqueSps(input.reads),
    writes: uniqueSps(input.writes)
  };
}

function uniqueSps(refs: SpNameRef[]): SpNameRef[] {
  const byKey = new Map<string, SpNameRef>();
  for (const ref of refs) {
    const key = `${(ref.name ?? "").toLowerCase()}::${ref.usage}`;
    const prev = byKey.get(key);
    if (!prev || rank(ref) > rank(prev)) byKey.set(key, ref);
  }
  return [...byKey.values()].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
}

function mergeApiSps(sps: SpNameRef[], apis: SpApiTrace[]): void {
  const known = new Set(sps.map((sp) => (sp.name ?? "").toLowerCase()).filter(Boolean));
  for (const api of apis) {
    for (const name of api.sps) {
      const usage = api.usage === "desconocido" ? classifyUsage(`${api.method ?? ""} ${api.path}`, null, name) : api.usage;
      const existing = sps.find((sp) => (sp.name ?? "").toLowerCase() === name.toLowerCase() && (sp.usage === usage || sp.usage === "desconocido"));
      if (existing) {
        if (existing.usage === "desconocido") existing.usage = usage;
        continue;
      }
      if (known.has(name.toLowerCase()) && sps.some((sp) => (sp.name ?? "").toLowerCase() === name.toLowerCase() && sp.usage === usage)) {
        continue;
      }
      known.add(name.toLowerCase());
      sps.push({
        name,
        usage,
        status: "UNKNOWN",
        lifecycle: null,
        source: "repo",
        confirmed: false
      });
    }
  }
}

function classifyUsage(text: string, definition: Record<string, unknown> | null, name?: string): SpUsageKind {
  const explicit = String(definition?.usage ?? "").toLowerCase();
  if (explicit === "consulta" || explicit === "lectura") return "lectura";
  if (explicit === "alta" || explicit === "envio" || explicit === "envío") return "envio";
  const target = name ?? "";
  const nameBits = target.replace(/^dbo\./i, "").split(/[._@]/).join(" ");
  const around = `${windowAround(text, target)} ${nameBits}`;
  if (WRITE_HINT.test(around)) return "envio";
  if (READ_HINT.test(around)) return "lectura";
  return "desconocido";
}

function windowAround(text: string, name: string): string {
  if (!name) return text;
  const lower = text.toLowerCase();
  const needle = name.toLowerCase().replace(/^dbo\./, "");
  const idx = lower.indexOf(needle);
  if (idx < 0) return text;
  return text.slice(Math.max(0, idx - 90), idx + needle.length + 90);
}

function explainTrace(input: {
  azureId: number;
  title: string;
  screen: string | null;
  screenSource: string | null;
  captures: SpCapture[];
  frontendPages: string[];
  apis: SpApiTrace[];
  frontend: SpLayerItem[];
  backend: SpLayerItem[];
  filesFe: string[];
  filesBe: string[];
  reads: SpNameRef[];
  writes: SpNameRef[];
  unknown: SpNameRef[];
  gap: SqlGap | null;
  missingContract: boolean;
  codeNote: string | null;
}): string {
  const parts: string[] = [`#${input.azureId} ${input.title}.`];
  if (input.screen) {
    parts.push(
      `Pantalla: ${input.screen}${input.screenSource ? ` (desde ${input.screenSource})` : ""}.`
    );
  } else {
    parts.push("Sin pantalla confirmada; revisar capturas de la historia.");
  }
  if (input.captures.length) {
    parts.push(
      `Capturas: ${input.captures.length} imagen(es) en la historia/subtareas${input.captures.some((c) => c.inferredScreen) ? `; sugieren «${input.captures.map((c) => c.inferredScreen).filter(Boolean).join(", ")}»` : ""}.`
    );
  }
  if (input.frontendPages.length) {
    parts.push(`Pantalla FE candidata: ${input.frontendPages.join(", ")}.`);
  }
  if (input.apis.length) {
    const load = input.apis.filter((api) => api.usage === "lectura");
    const save = input.apis.filter((api) => api.usage === "envio");
    const other = input.apis.filter((api) => api.usage === "desconocido");
    if (load.length) parts.push(`API para mostrar: ${load.map(apiPhrase).join("; ")}.`);
    if (save.length) parts.push(`API al guardar: ${save.map(apiPhrase).join("; ")}.`);
    if (other.length) parts.push(`Otras APIs: ${other.map(apiPhrase).join("; ")}.`);
  } else if (input.codeNote) {
    parts.push(input.codeNote);
  }
  parts.push(layerPhrase("Frontend", input.frontend, input.filesFe));
  parts.push(layerPhrase("Backend", input.backend, input.filesBe));
  parts.push(spPhrase("Para leer", input.reads, "no hay un SP de consulta con nombre en la evidencia"));
  parts.push(spPhrase("Para mandar o dar de alta", input.writes, "no aparece un SP de escritura/envío"));
  if (input.unknown.length) {
    parts.push(
      `Hay SP sin uso claro (lectura vs envío): ${input.unknown.map((sp) => sp.name || "sin nombre").join(", ")}. No se inventa el uso.`
    );
  }
  if (input.missingContract) {
    parts.push("El contrato no está confirmado: no se inventa la firma ni se marca Ready FE/BE.");
  }
  if (input.gap?.copyText) parts.push(input.gap.copyText);
  return parts.join(" ");
}

function apiPhrase(api: SpApiTrace): string {
  const sps =
    api.sps.length
      ? ` → SP ${api.sps.join(", ")}`
      : api.via === "http"
        ? " → no llama SP en NWEB (HTTP a middleware/NCSL)"
        : api.via === "ef"
          ? " → EF, sin SP"
          : "";
  const model = api.models[0] ? ` · model ${api.models[0]}` : "";
  const ctrl = api.controller ? ` · ${api.controller}` : "";
  return `${api.method ? api.method + " " : ""}${api.path}${ctrl}${model}${sps}`;
}

function layerPhrase(label: string, items: SpLayerItem[], files: string[]): string {
  if (!items.length && !files.length) return `${label}: no hay subtarea ni archivo indexado.`;
  const tasks = items.map((item) => {
    const id = item.azureId ? `#${item.azureId} ` : item.source === "draft" ? "(borrador) " : "";
    const who = item.assignee ? ` · ${item.assignee}` : "";
    return `${id}${item.title}${who}`;
  });
  const fileBit = files.length ? ` Archivos: ${files.join(", ")}.` : "";
  return `${label}: ${tasks.join("; ") || "sin subtarea"}.${fileBit}`;
}

function spPhrase(label: string, refs: SpNameRef[], empty: string): string {
  if (!refs.length) return `${label}: ${empty}.`;
  return `${label}: ${refs
    .map((sp) => {
      const name = sp.name || "SP sin nombre";
      const state = sp.confirmed ? "contrato confirmado" : `estado ${sp.lifecycle || sp.status}`;
      return `${name} (${state})`;
    })
    .join("; ")}.`;
}

function rank(ref: SpNameRef): number {
  if (ref.source === "contract") return 5;
  if (ref.source === "dependency") return 4;
  if (ref.source === "analysis") return 3;
  if (ref.source === "task") return 2;
  if (ref.source === "repo") return 1;
  return 0;
}

function textBlob(root: WorkRow, children: WorkRow[]): string {
  return [root, ...children]
    .map((item) => `${item.title}\n${htmlToText(item.description_html)}\n${item.acceptance_criteria ?? ""}`)
    .join("\n");
}

function toContractItem(item: WorkRow): SpContractItem {
  const ac = item.acceptance_criteria?.trim() || null;
  return {
    azureId: item.azure_id,
    title: item.title,
    type: item.type,
    descriptionHtml: rewriteAzureAttachmentUrls(sanitizeHtml(item.description_html)),
    acceptanceCriteria: ac
  };
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return parseObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function asArray(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
}

function text(value: unknown): string | null {
  const out = String(value ?? "").trim();
  return out || null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
