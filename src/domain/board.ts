import type { AppConfig } from "../config/types.ts";
import { nowIso } from "./time.ts";
import { stateLabel, type NormalizedState } from "./states.ts";
import { memberTasks } from "./members.ts";
import { all, get, run, type Db } from "../storage/db.ts";

export const BOARD_COLUMNS = [
  { id: "inicio", label: "Inicio" },
  { id: "in_progress", label: "In progress" },
  { id: "evidencia", label: "Evidencia" },
  { id: "terminando", label: "Terminando" }
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

const NOTE_MAX = 400;
const DONE_STATES = new Set(["DEV_DONE", "QA", "UAT", "PENDING_RELEASE", "PRODUCTION", "REMOVED"]);
const ACTIVE_RANK: Record<string, number> = {
  DOING: 0,
  REVIEW: 1,
  BLOCKED: 2,
  READY: 3,
  NEW: 4,
  OTHER: 5
};

export interface BoardTask {
  id: string;
  azureId: number;
  title: string;
  type: string;
  state: string;
  stateLabel: string;
}

export interface BoardMember {
  id: string;
  displayName: string;
  shortName: string;
  role: string;
  wip: number;
  active: BoardTask | null;
  assigned: BoardTask[];
  columnId: BoardColumnId;
  note: string;
  startedAt: string | null;
  workItemId: string | null;
}

export interface MemberBoard {
  columns: Array<{ id: BoardColumnId; label: string }>;
  members: BoardMember[];
}

interface BoardRow {
  member_id: string;
  work_item_id: string | null;
  column_id: string;
  note: string;
  started_at: string | null;
  updated_at: string;
}

export function isBoardColumn(value: string): value is BoardColumnId {
  return BOARD_COLUMNS.some((column) => column.id === value);
}

export function memberShortName(displayName: string): string {
  const cleaned = displayName.replace(/\s*-\s*ND\s*$/i, "").trim();
  if (cleaned.includes(",")) {
    const parts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
    return (parts[1] || parts[0]).split(/\s+/)[0] || cleaned;
  }
  return cleaned.split(/\s+/)[0] || cleaned;
}

export function inferBoardColumn(state: string | null | undefined): BoardColumnId {
  return state === "DOING" ? "in_progress" : "inicio";
}

export function resolveBoardColumn(
  savedColumn: string | null | undefined,
  taskState: string | null | undefined
): BoardColumnId {
  if (savedColumn === "evidencia" || savedColumn === "terminando") return savedColumn;
  if (taskState === "DOING") return "in_progress";
  if (savedColumn === "inicio" || savedColumn === "in_progress") return savedColumn;
  return inferBoardColumn(taskState);
}

export function pickActiveTask(tasks: BoardTask[]): BoardTask | null {
  const ranked = tasks
    .filter((task) => !DONE_STATES.has(task.state))
    .slice()
    .sort((a, b) => (ACTIVE_RANK[a.state] ?? 9) - (ACTIVE_RANK[b.state] ?? 9));
  return ranked[0] ?? null;
}

export function reconcileOrphanedBoard(db: Db, config: AppConfig, iteration: string): void {
  const rows = all<BoardRow>(db, "SELECT member_id, work_item_id, column_id, note, started_at, updated_at FROM member_board");
  const now = nowIso();
  for (const row of rows) {
    if (!row.work_item_id) continue;
    const member = config.team.members.find((item) => item.id === row.member_id);
    if (!member) {
      run(db, "DELETE FROM member_board WHERE member_id = ?", row.member_id);
      continue;
    }
    const tasks = memberTasks(db, member, iteration);
    if (tasks.some((task) => String(task.id) === row.work_item_id)) continue;
    const next = pickActiveTask(tasks.map(asTask));
    run(
      db,
      "UPDATE member_board SET work_item_id = NULL, column_id = ?, note = '', started_at = NULL, updated_at = ? WHERE member_id = ?",
      inferBoardColumn(next?.state),
      now,
      row.member_id
    );
  }
}

export function loadMemberBoard(db: Db, config: AppConfig, iteration: string): MemberBoard {
  reconcileOrphanedBoard(db, config, iteration);
  const rows = all<BoardRow>(db, "SELECT member_id, work_item_id, column_id, note, started_at, updated_at FROM member_board");
  const byMember = new Map(rows.map((row) => [row.member_id, row]));
  return {
    columns: BOARD_COLUMNS.map((column) => ({ id: column.id, label: column.label })),
    members: config.team.members.map((member) => {
      const tasks = memberTasks(db, member, iteration).map(asTask);
      const saved = byMember.get(member.id);
      const assigned = tasks.filter((task) => !DONE_STATES.has(task.state));
      const pinned = saved?.work_item_id
        ? assigned.find((task) => task.id === saved.work_item_id) ?? tasks.find((task) => task.id === saved.work_item_id) ?? null
        : null;
      if (pinned && !assigned.some((task) => task.id === pinned.id)) assigned.unshift(pinned);
      const active = pinned ?? pickActiveTask(assigned);
      const columnId = resolveBoardColumn(saved?.column_id, active?.state);
      const wip = tasks.filter((task) => task.state === "DOING" || task.state === "REVIEW").length;
      return {
        id: member.id,
        displayName: member.displayName,
        shortName: memberShortName(member.displayName),
        role: member.role,
        wip,
        active,
        assigned,
        columnId,
        note: saved?.note ?? "",
        startedAt: saved?.started_at ?? null,
        workItemId: saved?.work_item_id ?? active?.id ?? null
      };
    })
  };
}

export function saveMemberBoard(
  db: Db,
  config: AppConfig,
  iteration: string,
  input: Record<string, unknown>
): MemberBoard {
  const memberId = String(input.memberId ?? "").trim();
  const member = config.team.members.find((item) => item.id === memberId);
  if (!member) throw new Error("Miembro no encontrado.");
  const current = get<BoardRow>(
    db,
    "SELECT member_id, work_item_id, column_id, note, started_at, updated_at FROM member_board WHERE member_id = ?",
    memberId
  );
  const start = input.start === true;
  let columnId = current && isBoardColumn(current.column_id) ? current.column_id : "inicio";
  if (typeof input.columnId === "string" && isBoardColumn(input.columnId)) columnId = input.columnId;
  if (start) columnId = "in_progress";

  let workItemId = current?.work_item_id ?? null;
  if ("workItemId" in input) {
    const raw = input.workItemId == null ? "" : String(input.workItemId).trim();
    workItemId = raw || null;
  }
  if (workItemId) {
    const exists = get<{ id: string; state_normalized: string }>(db, "SELECT id, state_normalized FROM work_items WHERE id = ?", workItemId);
    if (!exists) throw new Error("La tarea no está en el sprint sincronizado.");
    if (columnId === "inicio" && exists.state_normalized === "DOING") columnId = "in_progress";
  }

  let note = current?.note ?? "";
  if ("note" in input) note = String(input.note ?? "").trim().slice(0, NOTE_MAX);

  let startedAt = current?.started_at ?? null;
  if (start) startedAt = startedAt || nowIso();

  run(
    db,
    `INSERT INTO member_board(member_id, work_item_id, column_id, note, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       work_item_id=excluded.work_item_id,
       column_id=excluded.column_id,
       note=excluded.note,
       started_at=excluded.started_at,
       updated_at=excluded.updated_at`,
    memberId,
    workItemId,
    columnId,
    note,
    startedAt,
    nowIso()
  );
  return loadMemberBoard(db, config, iteration);
}

function asTask(row: Record<string, unknown>): BoardTask {
  const state = String(row.state_normalized ?? "OTHER");
  return {
    id: String(row.id ?? ""),
    azureId: Number(row.azure_id),
    title: String(row.title ?? ""),
    type: String(row.type ?? ""),
    state,
    stateLabel: stateLabel(state as NormalizedState)
  };
}
