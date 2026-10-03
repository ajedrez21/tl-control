import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../storage/db.ts";
import { all, run } from "../storage/db.ts";
import type { AppConfig } from "../config/types.ts";
import { resolveReportsDir, projectRoot } from "../config/load.ts";
import { computeSprintMetrics } from "../metrics/sprint.ts";
import { refreshAlerts } from "../metrics/alerts.ts";
import { lastSync } from "../storage/backup.ts";
import { nowIso } from "../domain/time.ts";
import { escapeText } from "../domain/sanitize.ts";
import { chartStateDistribution } from "../metrics/sprint.ts";

export function writeFrozenReport(db: Db, config: AppConfig, iterationId: string): string {
  const asOf = nowIso();
  const metrics = computeSprintMetrics(db, iterationId, asOf);
  const alerts = refreshAlerts(db, config, iterationId, asOf);
  const stories = all<Record<string, unknown>>(
    db,
    "SELECT azure_id, title, state_normalized, screen, assigned_to_id FROM work_items WHERE iteration_id = ? AND type != 'Task' ORDER BY azure_id",
    iterationId
  );
  const css = readFileSync(join(projectRoot(), "dashboard/styles.css"), "utf8");
  const stamp = asOf.replaceAll(":", "").replaceAll(".", "");
  const fileName = `sprint-${slug(iterationId)}-${stamp}.html`;
  const dir = resolveReportsDir(config);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Cierre ${escapeText(iterationId)}</title>
<style>${css}</style>
</head>
<body>
<main class="page frozen">
  <p class="banner">Reporte congelado · snapshot ${escapeText(asOf)} · no es live sync · zona ${escapeText(config.timezone)} · unidad ${escapeText(config.agingUnit)}</p>
  <h1>Cierre de sprint</h1>
  <p>${escapeText(iterationId)}</p>
  <section class="cards">
    <article><h2>Scope inicial</h2><p>${metrics.scope.initial} ${metrics.scope.unit}</p></article>
    <article><h2>Altas</h2><p>${metrics.scope.added}</p></article>
    <article><h2>Bajas</h2><p>${metrics.scope.removed}</p></article>
    <article><h2>Scope actual</h2><p>${metrics.scope.current}</p></article>
  </section>
  <p class="hint">${escapeText(metrics.scope.formula)} · fuente ${escapeText(metrics.scope.source)}</p>
  <h2>Estados</h2>
  <ul>${chartStateDistribution(metrics.byState).map((s) => `<li>${escapeText(s.label)}: ${s.value}</li>`).join("")}</ul>
  <h2>Historias</h2>
  <table>
    <thead><tr><th>ID</th><th>Título</th><th>Estado</th><th>Pantalla</th></tr></thead>
    <tbody>
      ${stories.map((s) => `<tr><td>${s.azure_id}</td><td>${escapeText(String(s.title))}</td><td>${escapeText(String(s.state_normalized))}</td><td>${escapeText(String(s.screen ?? ""))}</td></tr>`).join("")}
    </tbody>
  </table>
  <h2>Alertas al cierre</h2>
  <ul>${alerts.map((a) => `<li><strong>${escapeText(a.title)}</strong> — ${escapeText(a.explanation)}</li>`).join("")}</ul>
</main>
</body>
</html>`;
  writeFileSync(path, html, "utf8");
  const coverage = lastSync(db)?.coverage_json ?? "{}";
  run(
    db,
    "INSERT INTO snapshots(id, kind, iteration_id, captured_at, coverage_json, config_json, metrics_json, closed, report_path) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
    `close-${stamp}`,
    "close",
    iterationId,
    asOf,
    coverage,
    JSON.stringify({ timezone: config.timezone, iterationId }),
    JSON.stringify(metrics),
    path
  );
  return path;
}

function slug(value: string): string {
  return value.replaceAll(/[^\w.-]+/g, "-").replaceAll(/^-|-$/g, "");
}
