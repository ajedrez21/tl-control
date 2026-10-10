import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/types.ts";
import { resolveDataDir } from "../config/load.ts";
import { rewriteAzureAttachmentUrl } from "../domain/azure-images.ts";
import type { Db } from "../storage/db.ts";
import { all } from "../storage/db.ts";

const LEGACY_SP = /\b(?:dbo\.)?(?:usp|sp)_[A-Za-z][A-Za-z0-9_]*\b/gi;
const PRODUCT_SP = /\b(?:\[dbo\]\.)?(?:dbo\.)?(?:NWEB_|nweb_|simba_|programacion_|usp_|sp_)[A-Za-z][A-Za-z0-9_]*\b/g;
const STORED_PROC_ASSIGN = /currentStoredProc\s*=\s*"([^"]+)"/g;
const SP_LOG_ASSIGN = /\bsp\s*=\s*"([^"]+)"/g;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "bin",
  "obj",
  ".cursor",
  ".ai",
  "audit-output",
  ".vs"
]);

export interface SpCapture {
  id: string;
  azureId: number;
  fileName: string;
  url: string;
  alt: string | null;
  inferredScreen: string | null;
  note: string;
}

export type SpApiUsage = "lectura" | "envio" | "desconocido";
export type SpApiVia = "sp" | "ef" | "http" | "unknown";

export interface SpApiTrace {
  path: string;
  method: string | null;
  usage: SpApiUsage;
  via: SpApiVia;
  feFiles: string[];
  beFiles: string[];
  models: string[];
  controller: string | null;
  sps: string[];
  status: string;
  source: "contract" | "frontend" | "backend" | "hipótesis";
}

export interface SpCodeTrace {
  captures: SpCapture[];
  screenInferred: string | null;
  screenSource: string | null;
  frontendPages: string[];
  apis: SpApiTrace[];
  codeNote: string | null;
}

interface WiLite {
  id: string;
  azure_id: number;
  title: string;
  screen: string | null;
  module: string | null;
  description_html: string | null;
}

interface BeMethod {
  name: string;
  className: string;
  file: string;
  sps: string[];
  via: SpApiVia;
}

interface BeRoute {
  path: string;
  method: string;
  action: string;
  controller: string;
  file: string;
  callees: string[];
  types: string[];
}

interface BeIndex {
  routes: BeRoute[];
  methods: Map<string, BeMethod[]>;
}

interface FeHit {
  path: string;
  method: string | null;
  file: string;
}

const SCREEN_ALIASES: Array<{ test: RegExp; folders: string[] }> = [
  { test: /production\s*log|\blogs\b/i, folders: ["ProductionLog", "RutinaProduction", "Logs"] },
  { test: /program(?:ming)?\s*change|programchange/i, folders: ["ProgramChange"] },
  { test: /reactivate/i, folders: ["ProgramChange"] },
  { test: /reconcil/i, folders: ["reconciliation", "Conciliation"] },
  { test: /spot\s*information|added/i, folders: ["Conciliation", "InformationForm", "SpotControl"] },
  { test: /conciliaci[oó]n|conciliation/i, folders: ["Conciliation"] },
  { test: /reload|no\s*run/i, folders: ["Conciliation", "reconciliation"] },
  { test: /sponsor|patrocin/i, folders: ["BrandLogos"] },
  { test: /spot\s*control/i, folders: ["SpotControl"] }
];

export function buildCodeTrace(
  db: Db,
  config: AppConfig,
  root: WiLite,
  children: WiLite[],
  feFiles: string[],
  beFiles: string[],
  screenField: string | null
): SpCodeTrace {
  const captures = collectCaptures(db, config, [root, ...children]);
  const screenGuess = resolveScreen(root, children, captures, screenField);
  const apiContracts = loadApiContracts(db, root.id);
  const feRepo = config.repositories.find((r) => r.role === "frontend");
  const beRepo = config.repositories.find((r) => r.role === "backend");
  const needles = screenNeedles(root, children, screenGuess.screen);
  const frontendPages = findFrontendPages(feRepo?.localPath ?? "", feFiles, needles, screenGuess.screen, root.title);
  const pageSet = frontendPages.length ? frontendPages : feFiles.filter((p) => isFrontendSource(p)).slice(0, 8);
  const apisFromFe = extractApisFromFrontend(feRepo?.localPath ?? "", pageSet);
  const beIndex = beRepo?.localPath ? indexBackend(beRepo.localPath) : emptyIndex();
  const apis = mergeApiTraces(apiContracts, apisFromFe, beIndex, beFiles);

  let codeNote: string | null = null;
  if (!feRepo?.localPath || !existsSync(feRepo.localPath)) {
    codeNote = "Frontend sin ruta local: no se pueden rastrear APIs en código. Configurá repositories.frontend.localPath.";
  } else if (!beRepo?.localPath || !existsSync(beRepo.localPath)) {
    codeNote = "Backend sin ruta local: se vieron APIs de FE pero no se puede bajar a models/SP.";
  } else if (!apis.length && !frontendPages.length) {
    codeNote = "No se encontraron APIs en archivos FE candidatos para esta pantalla.";
  }

  return {
    captures,
    screenInferred: screenGuess.screen,
    screenSource: screenGuess.source,
    frontendPages,
    apis,
    codeNote
  };
}

function collectCaptures(db: Db, config: AppConfig, items: WiLite[]): SpCapture[] {
  const out: SpCapture[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const att of all<{ id: string; file_name: string; content_type: string | null }>(
      db,
      "SELECT id, file_name, content_type FROM attachments WHERE work_item_id = ?",
      item.id
    )) {
      if (!isImage(att.content_type, att.file_name)) continue;
      if (seen.has(att.id)) continue;
      seen.add(att.id);
      const inferred = inferScreenFromText(att.file_name);
      out.push({
        id: att.id,
        azureId: item.azure_id,
        fileName: att.file_name,
        url: `/attachments/${att.id}`,
        alt: null,
        inferredScreen: inferred,
        note: inferred ? `Nombre de archivo sugiere pantalla «${inferred}».` : "Revisar captura para confirmar pantalla."
      });
    }
    const html = item.description_html ?? "";
    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const alt = attr(tag, "alt");
      const src = attr(tag, "src");
      const key = `${item.azure_id}::${src ?? alt ?? "img"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inferred = inferScreenFromText(alt ?? "") ?? inferScreenFromTitle(item.title);
      out.push({
        id: key,
        azureId: item.azure_id,
        fileName: alt || "imagen embebida",
        url: src ? rewriteAzureAttachmentUrl(src) : "",
        alt,
        inferredScreen: inferred,
        note: alt ? `Alt de la imagen: «${alt}».` : "Imagen en la descripción sin alt; pantalla inferida por título."
      });
    }
  }
  const dir = join(resolveDataDir(config), "attachments");
  if (existsSync(dir)) {
    for (const item of items) {
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        files = [];
      }
      for (const name of files) {
        if (!isImage(null, name)) continue;
        if (!name.startsWith(`${item.azure_id}-`) && !name.startsWith(`${item.azure_id}_`)) continue;
        const key = `disk:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const inferred = inferScreenFromText(name) ?? inferScreenFromTitle(item.title);
        out.push({
          id: key,
          azureId: item.azure_id,
          fileName: name,
          url: `/attachments/file/${encodeURIComponent(name)}`,
          alt: null,
          inferredScreen: inferred,
          note: inferred
            ? `Captura local sugiere pantalla «${inferred}». Confirmar mirando la imagen.`
            : "Captura local en data/attachments. Mirar la imagen para confirmar la pantalla."
        });
      }
    }
  }
  return out;
}

function resolveScreen(
  root: WiLite,
  children: WiLite[],
  captures: SpCapture[],
  screenField: string | null
): { screen: string | null; source: string | null } {
  if (screenField?.trim()) {
    return { screen: screenField.trim(), source: "campo pantalla/módulo en Azure" };
  }
  const fromCapture = captures.map((c) => c.inferredScreen).find(Boolean);
  if (fromCapture) {
    return { screen: fromCapture!, source: "captura o evidencia de imagen" };
  }
  const fromTitle = inferScreenFromTitle(root.title);
  if (fromTitle) return { screen: fromTitle, source: "título de la historia" };
  for (const child of children) {
    const childScreen = inferScreenFromTitle(child.title);
    if (childScreen) return { screen: childScreen, source: `título de subtarea #${child.azure_id}` };
  }
  return { screen: null, source: null };
}

export function inferScreenFromTitle(title: string): string | null {
  const nweb = title.match(/\bNWEB\s*-\s*([^-]+?)\s*-/i);
  if (nweb?.[1]) return nweb[1].trim();
  const parts = title.split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3 && /^nweb$/i.test(parts[0])) return parts[1];
  if (parts.length >= 2 && /^nweb$/i.test(parts[0])) return parts.slice(1).join(" - ");
  if (parts.length >= 2 && parts[0].length <= 12) return parts[parts.length - 1];
  const de = title.match(/\bde\s+([A-Za-z][A-Za-z\s]{2,})$/i);
  if (de?.[1]) return de[1].trim();
  return null;
}

function inferScreenFromText(text: string): string | null {
  const clean = text.replace(/[_]+/g, " ").replace(/\.(png|jpe?g|gif|webp)$/i, "").trim();
  if (!clean) return null;
  if (/^captura(\s+de\s+pantalla)?\b/i.test(clean) || /^(image|imagen)(\s+embebida)?$/i.test(clean)) return null;
  const fromTitle = inferScreenFromTitle(clean);
  if (fromTitle && !/^captura\b/i.test(fromTitle) && fromTitle.toLowerCase() !== "image") return fromTitle;
  if (/\b(production log|reconciliation|conciliation|program change|programming|spot information)\b/i.test(clean)) {
    const m = clean.match(/\b(Production Log|Reconciliation|Conciliation|Program Change|Programming|Spot Information)[^,.]*/i);
    if (m?.[0]) return m[0].trim();
  }
  const stripped = clean.replace(/^\d+[-\s]*/, "").trim();
  if (/^(image|imagen|captura)$/i.test(stripped)) return null;
  return null;
}

function screenNeedles(root: WiLite, children: WiLite[], screen: string | null): string[] {
  const raw = [
    screen,
    root.screen,
    root.module,
    inferScreenFromTitle(root.title),
    ...children.map((c) => inferScreenFromTitle(c.title))
  ]
    .flatMap((value) => (value ?? "").split(/[^A-Za-z0-9+]+/))
    .map((p) => p.trim())
    .filter((p) => p.length >= 5 && !STOP.has(p.toLowerCase()));
  const aliases = SCREEN_ALIASES.filter((row) =>
    row.test.test(`${root.title} ${screen ?? ""}`)
  ).flatMap((row) => row.folders);
  return [...new Set([...raw, ...aliases])];
}

const STOP = new Set([
  "nweb",
  "ncsl",
  "ajuste",
  "ajustes",
  "cambio",
  "cambios",
  "nuevo",
  "nueva",
  "pantalla",
  "implementar",
  "contrato",
  "historia",
  "subtarea",
  "null"
]);

function findFrontendPages(
  localPath: string,
  feFiles: string[],
  needles: string[],
  screen: string | null,
  title: string
): string[] {
  if (!localPath || !existsSync(localPath)) return [];
  const scored: Array<{ path: string; score: number }> = [];
  const wanted = needles.map((n) => n.toLowerCase()).filter((n) => n.length >= 4 && !STOP.has(n));
  const aliases = SCREEN_ALIASES.filter((row) => row.test.test(`${title} ${screen ?? ""}`)).flatMap((row) =>
    row.folders.map((f) => f.toLowerCase())
  );
  walkFiles(join(localPath, "src"), localPath, (_abs, rel) => {
    if (!isFrontendSource(rel)) return;
    const hay = rel.toLowerCase().replaceAll("\\", "/");
    if (!/(pages?|components?|pop-up-forms?)/i.test(hay)) return;
    if (/\b(style|styles|config)\.(js|ts)x?$/i.test(hay)) return;
    let score = 0;
    for (const alias of aliases) {
      if (hay.includes(`/${alias.toLowerCase()}/`) || hay.includes(`/${alias.toLowerCase()}.`)) score += 8;
    }
    for (const needle of wanted) {
      if (hay.includes(needle)) score += 4;
    }
    if (/index\.(js|tsx|jsx)$/i.test(rel)) score += 1;
    if (score > 0) scored.push({ path: rel.replaceAll("\\", "/"), score });
  });
  for (const path of feFiles) {
    if (!isFrontendSource(path)) continue;
    if (scored.some((row) => row.path === path)) continue;
    const hay = path.toLowerCase().replaceAll("\\", "/");
    let score = 0;
    for (const alias of aliases) {
      if (hay.includes(alias)) score += 6;
    }
    for (const needle of wanted) {
      if (hay.includes(needle)) score += 2;
    }
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return unique(scored.filter((row) => row.score >= 4).slice(0, 8).map((row) => row.path));
}

function extractApisFromFrontend(localPath: string, feFiles: string[]): FeHit[] {
  const hits: FeHit[] = [];
  const seen = new Set<string>();
  const files = new Set(feFiles.slice(0, 12));
  for (const rel of [...files]) {
    const extra = localImports(localPath, rel);
    for (const item of extra) files.add(item);
  }
  for (const rel of files) {
    const abs = localPath ? join(localPath, rel) : rel;
    if (!localPath || !existsSync(abs)) continue;
    let text = "";
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    rememberApiHits(text, rel.replaceAll("\\", "/"), hits, seen);
  }
  return hits;
}

function localImports(localPath: string, rel: string): string[] {
  if (!localPath) return [];
  const abs = join(localPath, rel);
  if (!existsSync(abs)) return [];
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const dir = rel.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const out: string[] = [];
  for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const spec = match[1];
    const resolved = resolveImport(dir, spec);
    if (resolved) out.push(resolved);
  }
  return out.slice(0, 8);
}

function resolveImport(dir: string, spec: string): string | null {
  const raw = spec.replace(/\/$/, "");
  const base = join(dir, raw).replaceAll("\\", "/");
  const candidates = [
    `${base}.js`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`
  ];
  return candidates.find((p) => !p.includes("node_modules")) ?? `${base}.js`;
}

const API_CALL =
  /\b(?:api|axios)\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/gi;
const API_TEMPLATE = /\b(?:api|axios)\.(get|post|put|patch|delete)\s*\(\s*`([^`]+)`/gi;
const URL_CONST = /(?:const|let)\s+url\s*=\s*(['"`])([^'"`]+)\1/gi;

function rememberApiHits(text: string, file: string, hits: FeHit[], seen: Set<string>): void {
  const add = (method: string | null, rawPath: string) => {
    for (const expanded of expandTemplate(rawPath)) {
      const path = normalizeApiPath(expanded);
      if (!path) continue;
      const key = `${method ?? ""}::${path}::${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        path,
        method: method ? method.toUpperCase() : guessMethod(text, text.indexOf(rawPath)) ?? guessMethodFromPath(path),
        file
      });
    }
  };
  for (const match of text.matchAll(API_CALL)) add(match[1], match[3]);
  for (const match of text.matchAll(API_TEMPLATE)) add(match[1], match[2]);
  for (const match of text.matchAll(URL_CONST)) add(null, match[2]);
}

export function expandTemplate(raw: string): string[] {
  const ternary = raw.match(/\$\{[^}]*\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\s*\}/);
  if (ternary) {
    return [raw.replace(ternary[0], ternary[1]), raw.replace(ternary[0], ternary[2])].map(stripInterp);
  }
  return [stripInterp(raw)];
}

function stripInterp(raw: string): string {
  return raw.replace(/\$\{[^}]+\}/g, "*").replace(/\/{2,}/g, "/");
}

function mergeApiTraces(
  contracts: Array<{ name: string | null; status: string; definition: Record<string, unknown> | null }>,
  fromFe: FeHit[],
  beIndex: BeIndex,
  beSeedFiles: string[]
): SpApiTrace[] {
  const map = new Map<string, SpApiTrace>();
  const remember = (trace: SpApiTrace) => {
    const key = `${trace.method ?? ""}::${trace.path}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, trace);
      return;
    }
    map.set(key, {
      ...prev,
      method: prev.method ?? trace.method,
      usage: prev.usage === "desconocido" ? trace.usage : prev.usage,
      via: prev.via === "unknown" ? trace.via : prev.via,
      feFiles: unique([...prev.feFiles, ...trace.feFiles]),
      beFiles: unique([...prev.beFiles, ...trace.beFiles]),
      models: unique([...prev.models, ...trace.models]),
      controller: prev.controller ?? trace.controller,
      sps: unique([...prev.sps, ...trace.sps]),
      status: prev.status === "CONFIRMED" ? prev.status : trace.status,
      source: prev.source === "contract" ? prev.source : trace.source
    });
  };

  for (const c of contracts) {
    const path = normalizeApiPath(c.name ?? "");
    if (!path) continue;
    const def = c.definition ?? {};
    const sps = extractProductSpNames(`${JSON.stringify(def)} ${def.compatibilityNotes ?? ""}`);
    const method = text(def.method) ?? guessMethodFromContract(c.name ?? "");
    remember({
      path,
      method,
      usage: usageFromMethod(method),
      via: sps.length ? "sp" : "unknown",
      feFiles: [],
      beFiles: [],
      models: [],
      controller: null,
      sps,
      status: c.status,
      source: "contract"
    });
  }

  for (const hit of fromFe) {
    const linked = linkBackend(hit.path, hit.method, beIndex, beSeedFiles);
    remember({
      path: hit.path,
      method: hit.method,
      usage: usageFromMethod(hit.method, hit.path),
      via: linked.via,
      feFiles: [hit.file],
      beFiles: linked.files,
      models: linked.models,
      controller: linked.controller,
      sps: linked.sps,
      status: linked.files.length ? "hipótesis en código" : "solo FE",
      source: "frontend"
    });
  }

  return [...map.values()].sort((a, b) => {
    const order = (u: SpApiUsage) => (u === "lectura" ? 0 : u === "envio" ? 1 : 2);
    const cmp = order(a.usage) - order(b.usage);
    return cmp !== 0 ? cmp : a.path.localeCompare(b.path);
  });
}

function linkBackend(
  apiPath: string,
  method: string | null,
  index: BeIndex,
  seeds: string[]
): { files: string[]; models: string[]; controller: string | null; sps: string[]; via: SpApiVia } {
  const route = index.routes.find((row) => pathsMatch(row.path, apiPath) && (!method || row.method === method));
  const fallback = route ? null : index.routes.find((row) => pathsMatch(row.path, apiPath));
  const found = route ?? fallback;
  if (!found) {
    const token = apiPath.split("/").filter((p) => p && p !== "api" && p !== "*").pop() ?? "";
    const seedHit = seeds.filter((file) => file.toLowerCase().includes(token.toLowerCase())).slice(0, 4);
    return { files: seedHit, models: [], controller: null, sps: [], via: "unknown" };
  }
  const methods = [
    found.action,
    ...found.callees
  ].flatMap((name) => index.methods.get(name.toLowerCase()) ?? []);
  const sps = unique(methods.flatMap((m) => m.sps));
  const models = unique(methods.map((m) => m.className).concat(found.types)).filter((name) => !NOISE_TYPE.has(name));
  const files = unique([found.file, ...methods.map((m) => m.file)]);
  const via: SpApiVia = sps.length ? "sp" : methods.some((m) => m.via === "http") ? "http" : methods.some((m) => m.via === "ef") ? "ef" : "unknown";
  return { files, models, controller: `${found.controller}.${found.action}`, sps, via };
}

function pathsMatch(route: string, api: string): boolean {
  const a = tokenize(route);
  const b = tokenize(api);
  if (a.length !== b.length) return false;
  return a.every((part, i) => part === "*" || b[i] === "*" || part === b[i]);
}

function tokenize(path: string): string[] {
  return normalizeApiPath(path)
    ?.replace(/\{[^}]+\}/g, "*")
    .split("/")
    .filter(Boolean)
    .map((p) => p.toLowerCase()) ?? [];
}

function indexBackend(root: string): BeIndex {
  if (!root || !existsSync(root)) return emptyIndex();
  const methods = new Map<string, BeMethod[]>();
  const routes: BeRoute[] = [];
  const folders = ["Controllers", "Models", join("Models", "Repository")];
  for (const folder of folders) {
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    walkFiles(dir, root, (abs, rel) => {
      if (!/\.cs$/i.test(rel)) return;
      const text = safeRead(abs);
      if (!text) return;
      indexCsMethods(rel.replaceAll("\\", "/"), text, methods);
      if (/Controllers/i.test(rel)) indexCsRoutes(rel.replaceAll("\\", "/"), text, routes);
    });
  }
  return { routes, methods };
}

function emptyIndex(): BeIndex {
  return { routes: [], methods: new Map() };
}

function indexCsMethods(file: string, text: string, methods: Map<string, BeMethod[]>): void {
  const className = file.split("/").pop()?.replace(/\.cs$/i, "") ?? file;
  const blocks = text.split(/(?=public\s+(?:async\s+)?(?:static\s+|virtual\s+|override\s+)*[\w.<>,\[\]?]+\s+[A-Za-z]\w+\s*\()/);
  for (const block of blocks) {
    const m = block.match(/public\s+(?:async\s+)?(?:static\s+|virtual\s+|override\s+)*[\w.<>,\[\]?]+\s+([A-Za-z]\w+)\s*\(/);
    if (!m) continue;
    const name = m[1];
    const sps = extractProductSpNames(block.slice(0, 2500));
    const via: SpApiVia = sps.length
      ? "sp"
      : /HttpClient|PostAsync|GetAddOrUpdate|requestUri/i.test(block)
        ? "http"
        : /_context\./.test(block)
          ? "ef"
          : "unknown";
    const row: BeMethod = { name, className, file, sps, via };
    const key = name.toLowerCase();
    const list = methods.get(key) ?? [];
    list.push(row);
    methods.set(key, list);
  }
}

function indexCsRoutes(file: string, text: string, routes: BeRoute[]): void {
  const controller = file.split("/").pop()?.replace(/\.cs$/i, "") ?? file;
  const types = [...text.matchAll(/private\s+readonly\s+(\w+)/g)].map((m) => m[1]);
  const re =
    /\[Http(Get|Post|Put|Patch|Delete)\][\s\S]{0,240}?\[Route\("([^"]+)"\)\][\s\S]{0,120}?public[\s\S]{0,180}?(\w+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index;
    const next = text.indexOf("[Http", start + 6);
    const body = text.slice(start, next > 0 ? next : start + 1800);
    const callees = [...body.matchAll(/_\w+\.(\w+)\s*\(/g)].map((m) => m[1]);
    routes.push({
      path: normalizeApiPath(match[2]) ?? match[2],
      method: match[1].toUpperCase(),
      action: match[3],
      controller,
      file,
      callees,
      types
    });
  }
}

function loadApiContracts(
  db: Db,
  workItemId: string
): Array<{ name: string | null; status: string; definition: Record<string, unknown> | null }> {
  return all<{ name: string | null; status: string; definition_json: string | null }>(
    db,
    "SELECT name, status, definition_json FROM contracts WHERE work_item_id = ? AND kind = 'API'",
    workItemId
  ).map((row) => ({
    name: row.name,
    status: row.status,
    definition: parseObject(row.definition_json)
  }));
}

export function normalizeApiPath(raw: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, "").trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      trimmed = u.pathname;
    } catch {
      return null;
    }
  }
  trimmed = trimmed.split("?")[0].replace(/\$\{[^}]+\}/g, "*").replace(/\{[^}]+\}/g, "*").replace(/\/{2,}/g, "/");
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return null;
  if (!trimmed.startsWith("/")) trimmed = `/${trimmed}`;
  if (!/^\/api\//i.test(trimmed)) {
    if (
      /\/(programChange|simba|combos|reconciliation|conciliation|production|grilla|playlist|rutina|proxy-download|programacion)\b/i.test(
        trimmed
      )
    ) {
      trimmed = `/api${trimmed}`;
    } else if (!trimmed.includes("Controller")) {
      return null;
    }
  }
  return trimmed;
}

const NOISE_TYPE = new Set([
  "ILogger",
  "ICloudStorageUploader",
  "IAiImageService",
  "IStatusControlService",
  "IConfiguration",
  "NCSLiteContext"
]);

function usageFromMethod(method: string | null, path = ""): SpApiUsage {
  const m = (method ?? "").toUpperCase();
  if (m === "GET") return "lectura";
  if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
    if (/\b(combo|lista|list|get|consul|search|detalle)\b/i.test(path) && m === "POST") return "lectura";
    return "envio";
  }
  if (/\b(send|update|save|graba|alta|delete|merge)\b/i.test(path)) return "envio";
  if (/(_log\b|\/logs?\b|lista|combo|consul|detalle)/i.test(path)) return "lectura";
  return "desconocido";
}

function guessMethodFromPath(path: string): string | null {
  if (/(_log\b|\/logs?\b|lista|combo|consul|detalle)/i.test(path)) return "GET";
  if (/\b(send|update|graba|save|delete|merge)\b/i.test(path)) return "POST";
  return null;
}

function guessMethod(text: string, index: number): string | null {
  const window = text.slice(Math.max(0, index - 40), index + 40).toLowerCase();
  if (/\bpost\b/.test(window)) return "POST";
  if (/\bput\b/.test(window)) return "PUT";
  if (/\bpatch\b/.test(window)) return "PATCH";
  if (/\bdelete\b/.test(window)) return "DELETE";
  if (/\bget\b/.test(window)) return "GET";
  return null;
}

function guessMethodFromContract(name: string): string | null {
  if (/^POST\b/i.test(name)) return "POST";
  if (/^GET\b/i.test(name)) return "GET";
  if (/^PUT\b/i.test(name)) return "PUT";
  if (/^DELETE\b/i.test(name)) return "DELETE";
  return null;
}

export function extractProductSpNames(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of [STORED_PROC_ASSIGN, SP_LOG_ASSIGN, PRODUCT_SP, LEGACY_SP]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[0]).replace(/^\[dbo\]\./i, "");
      if (!raw || raw.length < 4) continue;
      names.add(canonSpName(raw));
    }
  }
  return [...names];
}

export function extractLegacySpNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(LEGACY_SP)) {
    names.add(canonSpName(match[0]));
  }
  return [...names];
}

function canonSpName(raw: string): string {
  const name = raw.replace(/^dbo\./i, "");
  if (/^(usp|sp)_/i.test(name)) return `dbo.${name}`;
  return name;
}

function isFrontendSource(path: string): boolean {
  const hay = path.replaceAll("\\", "/");
  if (/(^|\/)(audit-output|node_modules|dist|build|bin|\.cursor|\.ai)(\/|$)/i.test(hay)) return false;
  return /\.(ts|tsx|js|jsx)$/i.test(hay);
}

function isImage(contentType: string | null, fileName: string): boolean {
  if (contentType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(fileName);
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m?.[1]?.trim() || null;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  const out = String(value ?? "").trim();
  return out || null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeRead(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

function walkFiles(dir: string, root: string, visit: (abs: string, rel: string) => void): void {
  if (!existsSync(dir)) return;
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < 8000) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (statSync(abs).size > 800_000) continue;
      } catch {
        continue;
      }
      seen += 1;
      const rel = abs.slice(root.length).replace(/^[\\/]/, "").replaceAll("\\", "/");
      visit(abs, rel);
    }
  }
}
