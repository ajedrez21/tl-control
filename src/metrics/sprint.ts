import type { Db } from "../storage/db.ts";
import { all, get } from "../storage/db.ts";
import { calendarDaysBetween } from "../domain/time.ts";
import type { NormalizedState } from "../domain/states.ts";
import { stateLabel } from "../domain/states.ts";

export interface ScopeMetrics {
  unit: "historias";
  source: string;
  baselineAt: string | null;
  initial: number;
  added: number;
  removed: number;
  current: number;
  carryOver: number;
  netGrowth: number | null;
  formula: string;
  coverage: "full" | "partial";
}

export interface SprintSnapshotMetrics {
  iterationId: string;
  scope: ScopeMetrics;
  byState: Record<string, number>;
  unassignedReady: number;
  blocked: number;
  pendingRelease: number;
  production: number;
  capturedAt: string;
}

export function computeScope(db: Db, iterationId: string, asOf: string): ScopeMetrics {
  const baseline = get<{ captured_at: string; work_item_ids_json: string }>(
    db,
    "SELECT captured_at, work_item_ids_json FROM sprint_baselines WHERE iteration_id = ?",
    iterationId
  );
  const events = all<{ work_item_id: string; event_type: string; at: string }>(
    db,
    "SELECT work_item_id, event_type, at FROM scope_events WHERE iteration_id = ? AND at <= ?",
    iterationId,
    asOf
  );
  if (!baseline) {
    const currentIds = currentStoryIds(db, iterationId);
    return {
      unit: "historias",
      source: "primera captura observada (sin baseline histórico Azure)",
      baselineAt: null,
      initial: currentIds.length,
      added: 0,
      removed: 0,
      current: currentIds.length,
      carryOver: events.filter((e) => e.event_type === "carry_over").length,
      netGrowth: null,
      formula: "baseline ausente: scope actual observado; crecimiento neto N/A",
      coverage: "partial"
    };
  }
  const initialIds = new Set(JSON.parse(baseline.work_item_ids_json) as string[]);
  const added = new Set(events.filter((e) => e.event_type === "added").map((e) => e.work_item_id));
  const removed = new Set(events.filter((e) => e.event_type === "removed").map((e) => e.work_item_id));
  const current = new Set(initialIds);
  for (const id of added) current.add(id);
  for (const id of removed) current.delete(id);
  const initial = initialIds.size;
  const net = initial === 0 ? null : (current.size - initial) / initial;
  return {
    unit: "historias",
    source: "sprint_baselines + scope_events",
    baselineAt: baseline.captured_at,
    initial,
    added: added.size,
    removed: removed.size,
    current: current.size,
    carryOver: events.filter((e) => e.event_type === "carry_over").length,
    netGrowth: net,
    formula: "(scope actual - scope inicial) / scope inicial; baseline cero ⇒ N/A",
    coverage: "full"
  };
}

export function currentStoryIds(db: Db, iterationId: string): string[] {
  return all<{ id: string }>(
    db,
    "SELECT id FROM work_items WHERE iteration_id = ? AND type != 'Task' AND state_normalized != 'REMOVED'",
    iterationId
  ).map((r) => r.id);
}

export function countByState(db: Db, iterationId: string): Record<string, number> {
  const rows = all<{ state_normalized: NormalizedState; n: number }>(
    db,
    "SELECT state_normalized, COUNT(*) AS n FROM work_items WHERE iteration_id = ? AND type != 'Task' GROUP BY state_normalized",
    iterationId
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.state_normalized] = Number(row.n);
  return out;
}

export function computeSprintMetrics(db: Db, iterationId: string, asOf: string): SprintSnapshotMetrics {
  const byState = countByState(db, iterationId);
  const unassignedReady = Number(
    get<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM work_items WHERE iteration_id = ? AND type = 'Task' AND state_normalized = 'READY' AND (assigned_to_id IS NULL OR assigned_to_id = '')",
      iterationId
    )?.n ?? 0
  );
  return {
    iterationId,
    scope: computeScope(db, iterationId, asOf),
    byState,
    unassignedReady,
    blocked: byState.BLOCKED ?? 0,
    pendingRelease: byState.PENDING_RELEASE ?? 0,
    production: countProduction(db, iterationId),
    capturedAt: asOf
  };
}

export function countProduction(db: Db, iterationId: string): number {
  const stories = all<{ id: string }>(
    db,
    "SELECT id FROM work_items WHERE iteration_id = ? AND type != 'Task'",
    iterationId
  );
  let n = 0;
  for (const s of stories) {
    if (isInProduction(db, s.id)) n += 1;
  }
  return n;
}

export function isInProduction(db: Db, workItemId: string): boolean {
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM deployments
     WHERE status = 'success'
       AND (environment IN ('PROD', 'production', 'Production'))
       AND work_items_json LIKE ?`,
    `%"${workItemId}"%`
  );
  return Number(row?.n ?? 0) > 0;
}

export function agingDays(fromIso: string, toIso: string, timezone: string): number {
  return calendarDaysBetween(fromIso, toIso, timezone);
}

export function chartStateDistribution(byState: Record<string, number>): Array<{ key: string; label: string; value: number }> {
  return Object.entries(byState).map(([key, value]) => ({
    key,
    label: stateLabel(key as NormalizedState),
    value
  }));
}
