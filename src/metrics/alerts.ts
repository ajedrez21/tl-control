import type { Db } from "../storage/db.ts";
import { all, get, run } from "../storage/db.ts";
import type { AppConfig } from "../config/types.ts";
import { calendarDaysBetween, nowIso } from "../domain/time.ts";
import { isInProduction } from "./sprint.ts";

export interface Alert {
  id: string;
  ruleId: string;
  workItemId: string | null;
  severity: string;
  title: string;
  explanation: string;
  data: Record<string, unknown>;
}

export function refreshAlerts(db: Db, config: AppConfig, iterationId: string, asOf = nowIso()): Alert[] {
  run(db, "DELETE FROM alerts");
  const alerts: Alert[] = [];
  const stories = all<StoryRow>(
    db,
    "SELECT * FROM work_items WHERE iteration_id = ? AND type != 'Task'",
    iterationId
  );

  for (const dep of all<DepRow>(db, "SELECT * FROM dependencies WHERE status IN ('PENDING','UNKNOWN') AND blocked_at IS NOT NULL")) {
    const owner = get<{ iteration_id: string }>(db, "SELECT iteration_id FROM work_items WHERE id = ?", dep.work_item_id);
    if (!owner || owner.iteration_id !== iterationId) continue;
    const days = calendarDaysBetween(dep.blocked_at, asOf, config.timezone);
    if (days >= config.alerts.spPendingDays && (dep.kind === "SP_CONTRACT" || dep.kind === "SP_DEPLOYMENT")) {
      alerts.push(make(
        `sp-${dep.id}`,
        "sp-pending",
        dep.work_item_id,
        "alta",
        `SP pendiente ${days} días corridos`,
        `Regla: dependencia SP en espera ≥ ${config.alerts.spPendingDays} días corridos (zona ${config.timezone}). Dato: ${dep.name} desde ${dep.blocked_at}. Acción: pedir contrato o desbloqueo a DB.`,
        { days, unit: "días corridos", name: dep.name }
      ));
    }
  }

  for (const s of stories) {
    const gaps = Number(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM questions WHERE work_item_id = ? AND blocking = 1", s.id)?.n ?? 0);
    const hasDesc = Boolean(s.description_html && s.description_html.replace(/<[^>]+>/g, "").trim());
    const hasAc = Boolean(s.acceptance_criteria && s.acceptance_criteria.trim());
    if (gaps > 0 || !hasDesc || !hasAc) {
      alerts.push(make(
        `ctx-${s.azure_id}`,
        "incomplete-context",
        s.id,
        "media",
        `Contexto incompleto o contradictorio: ${s.title}`,
        `Regla: descripción, AC o preguntas bloqueantes. Fuente: Work Item ${s.id}. Acción: /analyze-story ${s.azure_id}.`,
        { gaps, hasDesc, hasAc }
      ));
    }
  }

  const unassigned = all<StoryRow>(
    db,
    "SELECT * FROM work_items WHERE iteration_id = ? AND type = 'Task' AND state_normalized = 'READY' AND (assigned_to_id IS NULL OR assigned_to_id = '')",
    iterationId
  );
  for (const t of unassigned) {
    alerts.push(make(
      `ua-${t.azure_id}`,
      "ready-unassigned",
      t.id,
      "media",
      `Tarea Ready sin asignar: ${t.title}`,
      `Regla: Task READY sin assigned_to. Asignación sólo manual. Acción: abrir Equipo y elegir developer.`,
      { taskId: t.id }
    ));
  }

  const wip = all<{ assigned_to_id: string; n: number }>(
    db,
    "SELECT assigned_to_id, COUNT(*) AS n FROM work_items WHERE iteration_id = ? AND type = 'Task' AND state_normalized IN ('DOING','REVIEW') AND assigned_to_id IS NOT NULL GROUP BY assigned_to_id",
    iterationId
  );
  for (const row of wip) {
    if (Number(row.n) > config.alerts.wipLimit) {
      alerts.push(make(
        `wip-${row.assigned_to_id}`,
        "wip-high",
        null,
        "media",
        `WIP elevado para ${row.assigned_to_id}`,
        `Regla: tareas DOING/REVIEW > ${config.alerts.wipLimit}. Dato: ${row.n}. No es ranking de productividad.`,
        { member: row.assigned_to_id, wip: Number(row.n) }
      ));
    }
  }

  const prSource = get<{ coverage_json: string }>(db, "SELECT coverage_json FROM sync_runs ORDER BY started_at DESC LIMIT 1");
  const coverage = prSource ? (JSON.parse(prSource.coverage_json) as Record<string, string>) : {};
  if (coverage.pullRequests === "OK") {
    const prs = all<{ id: string; work_item_id: string | null; created_at: string; title: string }>(
      db,
      "SELECT id, work_item_id, created_at, title FROM pull_requests WHERE status = 'active'"
    );
    for (const pr of prs) {
      const days = calendarDaysBetween(pr.created_at, asOf, config.timezone);
      if (days >= config.alerts.prOpenDays) {
        alerts.push(make(
          `pr-${pr.id}`,
          "pr-aging",
          pr.work_item_id,
          "media",
          `PR abierto ${days} días: ${pr.title}`,
          `Regla: PR active ≥ ${config.alerts.prOpenDays} días corridos. Fuente: pull_requests. Acción: revisar o escalar.`,
          { days, pr: pr.id }
        ));
      }
    }
  }

  for (const s of stories) {
    if (s.state_normalized === "DEV_DONE") {
      const inRelease = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM release_work_items WHERE work_item_id = ?", s.id);
      if (!Number(inRelease?.n) && !isInProduction(db, s.id)) {
        alerts.push(make(
          `rel-${s.azure_id}`,
          "devdone-no-release",
          s.id,
          "alta",
          `Desarrollo terminado sin paquete/release: ${s.title}`,
          `Regla: DEV_DONE sin fila en release_work_items ni deploy PROD. Done/merge no equivalen a producción.`,
          { state: s.state_original }
        ));
      }
    }
  }

  const currentGate = get<{ id: string; gate_status: string; checked_at: string | null }>(
    db,
    "SELECT id, gate_status, checked_at FROM security_reports WHERE current_gate = 1 LIMIT 1"
  );
  if (currentGate && (currentGate.gate_status === "FAIL" || currentGate.gate_status === "STALE")) {
    alerts.push(make(
      `sec-${currentGate.id}`,
      "security-gate",
      null,
      "alta",
      `Gate de seguridad ${currentGate.gate_status}`,
      `Regla: gate vigente FAIL o STALE. Fuente: security_reports ${currentGate.id} @ ${currentGate.checked_at ?? "sin fecha"}. El auditor no se modifica desde TL Control.`,
      { reportId: currentGate.id, status: currentGate.gate_status }
    ));
  }

  const added = all<{ work_item_id: string }>(db, "SELECT work_item_id FROM scope_events WHERE iteration_id = ? AND event_type = 'added'", iterationId);
  for (const ev of added) {
    alerts.push(make(
      `scope-add-${ev.work_item_id}`,
      "scope-added",
      ev.work_item_id,
      "baja",
      "Historia agregada durante el sprint",
      "Regla: evento scope added posterior al baseline. El baseline no se recalcula.",
      { iterationId }
    ));
  }
  const carry = all<{ work_item_id: string; reason: string | null }>(db, "SELECT work_item_id, reason FROM scope_events WHERE iteration_id = ? AND event_type = 'carry_over'", iterationId);
  for (const ev of carry) {
    alerts.push(make(
      `carry-${ev.work_item_id}`,
      "carry-over",
      ev.work_item_id,
      "baja",
      "Carry-over desde iteración previa",
      `Regla: evento carry_over. Motivo: ${ev.reason ?? "no informado"}.`,
      { reason: ev.reason }
    ));
  }

  for (const a of alerts) {
    run(
      db,
      "INSERT INTO alerts(id, rule_id, work_item_id, severity, title, explanation, data_json, created_at, acknowledged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      a.id, a.ruleId, a.workItemId, a.severity, a.title, a.explanation, JSON.stringify(a.data), asOf
    );
  }
  return alerts;
}

function make(
  id: string,
  ruleId: string,
  workItemId: string | null,
  severity: string,
  title: string,
  explanation: string,
  data: Record<string, unknown>
): Alert {
  return { id, ruleId, workItemId, severity, title, explanation, data };
}

interface StoryRow {
  id: string;
  azure_id: number;
  title: string;
  description_html: string | null;
  acceptance_criteria: string | null;
  state_normalized: string;
  state_original: string;
}

interface DepRow {
  id: string;
  work_item_id: string;
  kind: string;
  status: string;
  name: string;
  blocked_at: string;
}
