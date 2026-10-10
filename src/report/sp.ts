import type { AppConfig } from "../config/types.ts";
import type { Db } from "../storage/db.ts";
import { get } from "../storage/db.ts";
import { lastSync } from "../storage/backup.ts";
import { escapeText } from "../domain/sanitize.ts";
import { nowIso } from "../domain/time.ts";
import { listSpDossier, type SpContractItem, type SpNameRef, type SpTrace } from "../metrics/sp-dossier.ts";
import type { SpCapture } from "../metrics/sp-code-trace.ts";

export function renderSpReport(db: Db, config: AppConfig, iterationId = config.azure.iterationPath): string {
  const dossier = listSpDossier(db, config, iterationId);
  const issued = new Intl.DateTimeFormat("es-AR", {
    timeZone: config.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date());
  const sync = lastSync(db, iterationId);
  const sprint = get<{ name: string }>(db, "SELECT name FROM iterations WHERE id = ?", iterationId);
  const pedido = tracesForHomeGaps(dossier.gaps, dossier.traces);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Informe SP · ${escapeText(sprint?.name || iterationId)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
  <button class="print" type="button" onclick="window.print()">Guardar como PDF</button>
  <header class="doc">
    <p class="kicker">TL Control · pedido a SQL</p>
    <h1>Informe de stored procedures</h1>
    <p class="lead">${escapeText(issued)}. Sprint ${escapeText(sprint?.name || iterationId)}.</p>
    <p class="meta">Última sincronización de Azure: ${escapeText(sync?.finished_at ? formatStamp(sync.finished_at, config.timezone) : "sin sync")}. Solo los ítems de Inicio → Falta definición SQL. Pedido a SQL: texto de lo que falta y SP de lectura/envío. El código es hipótesis hasta confirmar contrato.</p>
  </header>
  <section>
    <h2>Situación</h2>
    <ul class="stats">
      <li><strong>${pedido.length}</strong> pedido(s) de definición SQL</li>
    </ul>
    <p class="note">${escapeText(repoNotes(dossier.repoStatus))}</p>
  </section>
  <section>
    <h2>Falta definición SQL</h2>
    <p>Estos ítems necesitan que SQL mande o complete el contrato. El pedido, el texto de la historia/tareas con capturas, y los SP de lectura y envío.</p>
    ${pedido.length ? pedido.map((trace) => cardHtml(trace)).join("") : `<p class="empty">Ninguna historia analizada está frenada por definición SQL.</p>`}
  </section>
  <footer>
    <p>Generado ${escapeText(formatStamp(nowIso(), config.timezone))}. Aging en ${escapeText(dossier.agingUnit)}, zona ${escapeText(dossier.timezone)}. Para mandar este informe: Guardar como PDF o imprimir.</p>
  </footer>
</body>
</html>`;
}

function tracesForHomeGaps(gaps: Array<{ azureId: number }>, traces: SpTrace[]): SpTrace[] {
  const seen = new Set<string>();
  const out: SpTrace[] = [];
  for (const gap of gaps) {
    const trace = traces.find(
      (item) =>
        item.azureId === gap.azureId ||
        item.gap?.azureId === gap.azureId ||
        item.workContract?.story.azureId === gap.azureId ||
        item.workContract?.tasks.some((task) => task.azureId === gap.azureId)
    );
    if (!trace || seen.has(trace.workItemId)) continue;
    seen.add(trace.workItemId);
    out.push(trace);
  }
  return out;
}

function cardHtml(trace: SpTrace): string {
  const pedido =
    trace.gap?.copyText ||
    (trace.missingContract
      ? `Para #${trace.azureId} ${trace.title} falta la definición del contrato SP.`
      : `Contrato en evidencia para #${trace.azureId} ${trace.title}.`);
  const extras = extraCaptures(trace);
  return `<article class="card">
    <h3><span class="id">#${trace.azureId}</span> ${escapeText(trace.title)}</h3>
    <p class="progress">${escapeText(screenLabel(trace))} · ${trace.missingContract ? "falta contrato" : "contrato en evidencia"}</p>
    <p>${escapeText(pedido)}</p>
    ${contractBlock(trace)}
    ${extras.length ? `<div class="caps">${extras.map(captureFigure).join("")}</div>` : ""}
    <dl>
      <dt>SP para leer</dt><dd>${escapeText(spLine(trace.sqlReads))}</dd>
      <dt>SP para mandar</dt><dd>${escapeText(spLine(trace.sqlWrites))}</dd>
    </dl>
  </article>`;
}

function contractBlock(trace: SpTrace): string {
  const story = trace.workContract?.story;
  const tasks = trace.workContract?.tasks ?? [];
  if (!story && !tasks.length) return "";
  const parts = [
    story ? contractItemHtml(story, rootKind(story, tasks.length > 0)) : "",
    ...tasks.map((task) => contractItemHtml(task, "Subtarea"))
  ].filter(Boolean);
  return parts.length ? `<div class="contract">${parts.join("")}</div>` : "";
}

function contractItemHtml(item: SpContractItem, kind: string): string {
  const body = item.descriptionHtml?.trim();
  const ac = item.acceptanceCriteria?.trim();
  if (!body && !ac) {
    return `<section class="wi"><h4>${escapeText(kind)} <span class="id">#${item.azureId}</span> ${escapeText(item.title)}</h4><p class="note">Sin descripción en Azure.</p></section>`;
  }
  return `<section class="wi">
    <h4>${escapeText(kind)} <span class="id">#${item.azureId}</span> ${escapeText(item.title)}</h4>
    ${body ? `<div class="body">${body}</div>` : ""}
    ${ac ? `<p class="ac"><strong>AC:</strong> ${escapeText(ac)}</p>` : ""}
  </section>`;
}

function extraCaptures(trace: SpTrace): SpCapture[] {
  const html = [
    trace.workContract?.story?.descriptionHtml ?? "",
    ...(trace.workContract?.tasks ?? []).map((task) => task.descriptionHtml)
  ].join(" ").toLowerCase();
  return (trace.captures || []).filter((cap) => {
    if (!cap.url?.startsWith("/attachments/")) return false;
    if (html.includes(cap.url.toLowerCase())) return false;
    const guid = `${cap.url} ${cap.fileName} ${cap.id}`.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );
    return !(guid && html.includes(guid[0].toLowerCase()));
  });
}

function rootKind(item: SpContractItem, hasTasks: boolean): string {
  if (hasTasks) return "Historia";
  return /task/i.test(item.type) ? "Tarea" : "Historia";
}

function captureFigure(cap: SpCapture): string {
  const label = cap.inferredScreen && !/^[0-9a-f]{8,}$/i.test(cap.inferredScreen) ? cap.inferredScreen : cap.fileName;
  return `<figure><img src="${escapeText(cap.url)}" alt="${escapeText(cap.alt || cap.fileName)}"/><figcaption>${escapeText(label)}</figcaption></figure>`;
}

function screenLabel(trace: SpTrace): string {
  const raw = trace.screen || "";
  if (raw && !/^[0-9a-f]{8,}$/i.test(raw)) return raw;
  const fromCap = (trace.captures || [])
    .map((cap) => cap.inferredScreen)
    .find((name) => name && !/^[0-9a-f]{8,}$/i.test(name));
  return fromCap || "Sin pantalla";
}

function spLine(refs: SpNameRef[]): string {
  if (!refs.length) return "Ninguno en la evidencia";
  return refs
    .map((sp) => `${sp.name || "SP sin nombre"} (${sp.confirmed ? "confirmado" : sp.lifecycle || sp.status})`)
    .join(" · ");
}

function repoNotes(repos: Array<{ repoId: string; available: boolean; note: string }>): string {
  if (!repos.length) return "No hay repositorios configurados para contrastar nombres en código.";
  return repos.map((repo) => `${repo.repoId}: ${repo.note}`).join(" ");
}

function formatStamp(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(iso));
}

const REPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 980px; padding: 32px 28px 64px; color: #1c2430; background: #fff; font: 15px/1.45 "Segoe UI", system-ui, sans-serif; }
  .print { position: sticky; top: 12px; float: right; border: 0; border-radius: 8px; padding: 10px 14px; background: #1e3a5f; color: #fff; font: inherit; cursor: pointer; }
  .kicker { margin: 0; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; color: #5c6b7a; }
  h1 { margin: 4px 0 8px; font-size: 32px; letter-spacing: -0.03em; }
  h2 { margin: 28px 0 8px; padding-bottom: 6px; border-bottom: 2px solid #1e3a5f; font-size: 18px; }
  h3 { margin: 0 0 4px; font-size: 22px; color: #1e3a5f; }
  .lead { margin: 0; font-size: 17px; }
  .meta, .note, footer p, .progress { color: #5c6b7a; font-size: 13px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 0; margin: 8px 0 0; list-style: none; }
  .stats li { background: #f4f7fb; border: 1px solid #d9e2ec; border-radius: 8px; padding: 8px 12px; }
  .card { margin: 16px 0 22px; padding: 12px 0; border-bottom: 1px solid #e3e8ef; }
  .contract { margin: 10px 0 0; }
  .contract .wi { margin: 10px 0 14px; }
  .contract h4 { margin: 0 0 6px; font-size: 14px; }
  .contract .body { font-size: 14px; }
  .contract .body img, .caps img { max-width: 280px; height: auto; border: 1px solid #d9e2ec; border-radius: 6px; }
  .contract .ac { margin: 6px 0 0; }
  .caps { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0; }
  .caps figure { margin: 0; max-width: 240px; }
  .caps figcaption { font-size: 12px; color: #5c6b7a; }
  dl { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; margin: 10px 0 0; }
  dt { color: #5c6b7a; font-size: 12px; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #e3e8ef; padding: 7px 8px; }
  th { background: #f4f7fb; font-size: 12px; letter-spacing: .02em; }
  .id { font-variant-numeric: tabular-nums; color: #1e3a5f; font-weight: 650; }
  .empty { color: #5c6b7a; }
  footer { margin-top: 28px; border-top: 1px solid #d9e2ec; padding-top: 12px; }
  @media print {
    .print { display: none; }
    body { padding: 0; max-width: none; }
    h2, h3, h4 { break-after: avoid; }
    tr { break-inside: avoid; }
  }
`;
