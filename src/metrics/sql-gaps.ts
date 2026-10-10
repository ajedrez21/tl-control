import type { Db } from "../storage/db.ts";
import { all, get, run } from "../storage/db.ts";
import { nowIso } from "../domain/time.ts";

export type SqlChange = "NEW" | "ADD" | "UPDATE";

export interface SqlGap {
  workItemId: string;
  azureId: number;
  title: string;
  type: string;
  screen: string | null;
  spName: string | null;
  change: SqlChange;
  usage: "consulta" | "alta" | null;
  missing: string[];
  copyText: string;
}

const CLOSED = new Set(["CONFIRMED", "CONTRACT_CONFIRMED", "AVAILABLE", "VALIDATED", "NOT_APPLICABLE", "SATISFIED"]);

interface WorkRef {
  id: string;
  azure_id: number;
  title: string;
  type: string;
  screen: string | null;
  module: string | null;
}

interface GapDraft {
  workItemId: string;
  spName: string | null;
  status: string;
  lifecycle: string | null;
  definition: Record<string, unknown> | null;
}

export function listSqlGaps(db: Db, iterationId: string): SqlGap[] {
  const items = all<WorkRef>(
    db,
    "SELECT id, azure_id, title, type, screen, module FROM work_items WHERE iteration_id = ?",
    iterationId
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  const drafts = new Map<string, GapDraft>();

  const remember = (draft: GapDraft) => {
    if (!byId.has(draft.workItemId)) return;
    if (isClosed(draft.status, draft.lifecycle)) return;
    const key = `${draft.workItemId}::${(draft.spName ?? "").toLowerCase()}`;
    const prev = drafts.get(key);
    if (!prev || (!prev.definition && draft.definition)) drafts.set(key, draft);
  };

  for (const row of all<{ work_item_id: string; name: string | null; status: string; definition_json: string | null }>(
    db,
    `SELECT c.work_item_id, c.name, c.status, c.definition_json
     FROM contracts c
     JOIN work_items w ON w.id = c.work_item_id
     WHERE w.iteration_id = ? AND c.kind = 'SP'`,
    iterationId
  )) {
    remember({
      workItemId: row.work_item_id,
      spName: row.name,
      status: row.status,
      lifecycle: null,
      definition: parseObject(row.definition_json)
    });
  }

  for (const row of all<{ work_item_id: string; name: string | null; status: string; lifecycle: string | null }>(
    db,
    `SELECT d.work_item_id, d.name, d.status, d.lifecycle
     FROM dependencies d
     JOIN work_items w ON w.id = d.work_item_id
     WHERE w.iteration_id = ? AND d.kind = 'SP_CONTRACT'`,
    iterationId
  )) {
    remember({
      workItemId: row.work_item_id,
      spName: row.name,
      status: row.status,
      lifecycle: row.lifecycle,
      definition: null
    });
  }

  const dismissedItems = dismissedWorkItems(db, iterationId, drafts);

  const seenAnalysis = new Set<string>();
  for (const row of all<{ work_item_id: string; payload_json: string }>(
    db,
    `SELECT a.work_item_id, a.payload_json
     FROM analyses a
     JOIN work_items w ON w.id = a.work_item_id
     WHERE w.iteration_id = ? AND a.kind IN ('functional', 'sp')
     ORDER BY a.created_at DESC`,
    iterationId
  )) {
    if (seenAnalysis.has(row.work_item_id)) continue;
    seenAnalysis.add(row.work_item_id);
    if (dismissedItems.has(row.work_item_id)) continue;
    const payload = parseObject(row.payload_json);
    if (!payload) continue;
    for (const contract of asArray(payload.contracts)) {
      const kind = String(contract.kind ?? "");
      if (kind !== "SP") continue;
      remember({
        workItemId: row.work_item_id,
        spName: text(contract.name),
        status: String(contract.status ?? "UNKNOWN"),
        lifecycle: text(contract.lifecycle),
        definition: parseObject(contract.definition ?? contract.definition_json)
      });
    }
  }

  return [...drafts.values()]
    .map((draft) => toGap(draft, byId.get(draft.workItemId)!))
    .sort((a, b) => a.azureId - b.azureId);
}

export function sqlGapCopy(input: {
  azureId: number;
  title: string;
  screen: string | null;
  spName: string | null;
  change: SqlChange;
  usage: "consulta" | "alta" | null;
  missing: string[];
}): string {
  const where = input.screen ? `pantalla ${input.screen}` : input.title;
  const item = `#${input.azureId} ${input.title}`;
  const missing = input.missing.length ? input.missing.join(", ") : "la definición de los campos";
  if (input.change === "NEW" || !input.spName) {
    const named = input.spName ? ` (${input.spName})` : "";
    return `Para ${item}${input.screen ? ` (${where})` : ""} necesitamos la definición de un SP nuevo${named}. Todavía no podemos pedir campos ni de dónde sale cada dato: hasta que SQL nos mande el contrato (nombre del SP, si es consulta o alta, y entradas/salidas) queda el pedido de esa definición.`;
  }
  if (input.change === "ADD") {
    return `Para ${where} (${item}) hay que agregar datos en el SP ${input.spName}. Falta: ${missing}. Cuando pregunten de dónde sale o qué SP es el de esta pantalla: ${input.spName}${input.screen ? ` en ${input.screen}` : ""}.`;
  }
  const uso = input.usage === "alta" ? "alta" : "consulta";
  return `Para ${where} (${item}) hay que actualizar el SP de ${uso} ${input.spName}. Falta: ${missing}. Cuando pregunten de dónde sale o qué SP es el de esta pantalla: ${input.spName}${input.screen ? ` en ${input.screen}` : ""}.`;
}

function toGap(draft: GapDraft, item: WorkRef): SqlGap {
  const definition = draft.definition;
  const change = classifyChange(draft);
  const usage = classifyUsage(definition);
  const missing = missingFields(definition);
  const screen = item.screen || item.module || null;
  const spName = draft.spName?.trim() || null;
  return {
    workItemId: item.id,
    azureId: item.azure_id,
    title: item.title,
    type: item.type,
    screen,
    spName,
    change,
    usage,
    missing,
    copyText: sqlGapCopy({ azureId: item.azure_id, title: item.title, screen, spName, change, usage, missing })
  };
}

function classifyChange(draft: GapDraft): SqlChange {
  const raw = String(draft.definition?.change ?? draft.definition?.operation ?? "").toUpperCase();
  if (raw === "NEW" || raw === "ADD" || raw === "UPDATE") return raw;
  const notes = notesOf(draft.definition);
  if (/\b(alta|insert|agregar)\b/.test(notes)) return "ADD";
  if (/\b(update|actualizar|consulta|select)\b/.test(notes) && draft.spName) return "UPDATE";
  if (!draft.definition || draft.status === "UNKNOWN" || draft.lifecycle === "REQUESTED" || draft.lifecycle === "UNKNOWN") return "NEW";
  return draft.spName ? "UPDATE" : "NEW";
}

function classifyUsage(definition: Record<string, unknown> | null): "consulta" | "alta" | null {
  const explicit = String(definition?.usage ?? "").toLowerCase();
  if (explicit === "consulta" || explicit === "alta") return explicit;
  const notes = notesOf(definition);
  if (/\b(alta|insert|agregar)\b/.test(notes)) return "alta";
  if (/\b(consulta|select|listar)\b/.test(notes)) return "consulta";
  return null;
}

function missingFields(definition: Record<string, unknown> | null): string[] {
  const listed = definition?.missing;
  if (Array.isArray(listed)) return listed.map((item) => String(item)).filter(Boolean);
  const inputs = definition?.inputs;
  if (!Array.isArray(inputs)) return [];
  return inputs
    .map((input) => {
      if (typeof input === "string") return input;
      if (input && typeof input === "object" && "name" in input) return String((input as { name?: unknown }).name ?? "");
      return "";
    })
    .filter(Boolean);
}

function notesOf(definition: Record<string, unknown> | null): string {
  if (!definition) return "";
  return `${definition.compatibilityNotes ?? ""} ${definition.usage ?? ""} ${definition.change ?? ""}`.toLowerCase();
}

export function dismissSqlGap(db: Db, workItemId: string): boolean {
  const item = get<{ id: string }>(db, "SELECT id FROM work_items WHERE id = ?", workItemId);
  if (!item) return false;
  const contracts = all<{ id: string; status: string }>(
    db,
    "SELECT id, status FROM contracts WHERE work_item_id = ? AND kind = 'SP'",
    workItemId
  );
  const deps = all<{ id: string; status: string; lifecycle: string | null }>(
    db,
    "SELECT id, status, lifecycle FROM dependencies WHERE work_item_id = ? AND kind = 'SP_CONTRACT'",
    workItemId
  );
  const note = JSON.stringify({
    change: "NEW",
    compatibilityNotes: "El TL marcó que no hace falta contrato SP."
  });
  let changed = false;
  for (const contract of contracts) {
    if (isClosed(contract.status, null)) continue;
    run(db, "UPDATE contracts SET status = 'NOT_APPLICABLE', definition_json = ? WHERE id = ?", note, contract.id);
    changed = true;
  }
  for (const dep of deps) {
    if (isClosed(dep.status, dep.lifecycle)) continue;
    run(
      db,
      "UPDATE dependencies SET status = 'NOT_APPLICABLE', lifecycle = 'NOT_APPLICABLE', unblocked_at = ? WHERE id = ?",
      nowIso(),
      dep.id
    );
    changed = true;
  }
  if (!contracts.length) {
    run(
      db,
      "INSERT INTO contracts(id, work_item_id, kind, name, version, status, definition_json, source_evidence_ids, environment) VALUES (?, ?, 'SP', NULL, 'v1', 'NOT_APPLICABLE', ?, '[]', NULL)",
      `ctr-sp-na-${workItemId.replaceAll("/", "-")}`,
      workItemId,
      note
    );
    changed = true;
  }
  return changed || Boolean(item);
}

export function confirmSpContract(
  db: Db,
  workItemId: string,
  input: { name?: string; notes?: string }
): boolean {
  const item = get<{ id: string }>(db, "SELECT id FROM work_items WHERE id = ?", workItemId);
  if (!item) return false;
  const name = input.name?.trim() || null;
  const definition = JSON.stringify({
    change: name ? "UPDATE" : "NEW",
    compatibilityNotes: input.notes?.trim() || "Contrato cargado por el TL desde la evidencia.",
    inputs: [],
    outputs: [],
    errors: []
  });
  const existing = get<{ id: string }>(
    db,
    "SELECT id FROM contracts WHERE work_item_id = ? AND kind = 'SP' ORDER BY id LIMIT 1",
    workItemId
  );
  if (existing) {
    run(
      db,
      "UPDATE contracts SET status = 'CONFIRMED', name = COALESCE(?, name), definition_json = ? WHERE id = ?",
      name,
      definition,
      existing.id
    );
  } else {
    run(
      db,
      "INSERT INTO contracts(id, work_item_id, kind, name, version, status, definition_json, source_evidence_ids, environment) VALUES (?, ?, 'SP', ?, 'v1', 'CONFIRMED', ?, '[]', NULL)",
      `ctr-sp-${workItemId.replaceAll("/", "-")}`,
      workItemId,
      name,
      definition
    );
  }
  run(
    db,
    "UPDATE dependencies SET status = 'SATISFIED', lifecycle = 'CONTRACT_CONFIRMED', unblocked_at = COALESCE(unblocked_at, ?) WHERE work_item_id = ? AND kind = 'SP_CONTRACT'",
    nowIso(),
    workItemId
  );
  return true;
}

function dismissedWorkItems(db: Db, iterationId: string, open: Map<string, GapDraft>): Set<string> {
  const openItems = new Set([...open.values()].map((draft) => draft.workItemId));
  const out = new Set<string>();
  for (const row of all<{ work_item_id: string; status: string }>(
    db,
    `SELECT c.work_item_id, c.status
     FROM contracts c
     JOIN work_items w ON w.id = c.work_item_id
     WHERE w.iteration_id = ? AND c.kind = 'SP'`,
    iterationId
  )) {
    if (isClosed(row.status, null) && !openItems.has(row.work_item_id)) out.add(row.work_item_id);
  }
  for (const row of all<{ work_item_id: string; status: string; lifecycle: string | null }>(
    db,
    `SELECT d.work_item_id, d.status, d.lifecycle
     FROM dependencies d
     JOIN work_items w ON w.id = d.work_item_id
     WHERE w.iteration_id = ? AND d.kind = 'SP_CONTRACT'`,
    iterationId
  )) {
    if (isClosed(row.status, row.lifecycle) && !openItems.has(row.work_item_id)) out.add(row.work_item_id);
  }
  return out;
}

function isClosed(status: string, lifecycle: string | null): boolean {
  if (CLOSED.has(status)) return true;
  return Boolean(lifecycle && CLOSED.has(lifecycle));
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
