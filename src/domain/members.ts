import type { AppConfig } from "../config/types.ts";
import type { Db } from "../storage/db.ts";
import { all, get } from "../storage/db.ts";

export interface AssignedIdentity {
  id?: string;
  displayName?: string;
  uniqueName?: string;
}

export interface ResolvedAssignee {
  memberId: string | null;
  azureId: string | null;
  displayName: string | null;
}

const AZURE_ID_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hasValidAzureId(azureId: string | null | undefined): boolean {
  return AZURE_ID_GUID.test(String(azureId ?? "").trim());
}

export function defaultOwnerMember(config: AppConfig): AppConfig["team"]["members"][0] {
  const ownerId = config.team.defaultOwnerId?.trim();
  if (ownerId) {
    const hit = config.team.members.find((m) => m.id === ownerId);
    if (hit) return hit;
  }
  return config.team.members.find((m) => hasValidAzureId(m.azureId)) ?? config.team.members[0];
}

export interface AssignmentResolution {
  assignedTo: string | null;
  requestedId: string | null;
  fallback: boolean;
  reason: string | null;
}

export function resolveAssignment(config: AppConfig, memberId: string | null | undefined): AssignmentResolution {
  const requested = memberId?.trim() ? memberId.trim() : null;
  if (!requested) {
    return { assignedTo: null, requestedId: null, fallback: false, reason: null };
  }
  const member = config.team.members.find((m) => m.id === requested);
  if (!member) throw new Error(`Miembro no encontrado: ${requested}`);
  if (hasValidAzureId(member.azureId)) {
    return { assignedTo: member.id, requestedId: member.id, fallback: false, reason: null };
  }
  const owner = defaultOwnerMember(config);
  if (owner.id === member.id) {
    return { assignedTo: member.id, requestedId: member.id, fallback: false, reason: null };
  }
  return {
    assignedTo: owner.id,
    requestedId: member.id,
    fallback: true,
    reason: `ID Azure inválido (${member.azureId || "vacío"}). Asignado a ${owner.displayName}.`
  };
}

export function parseAssigned(assigned: unknown): AssignedIdentity | string | null {
  if (!assigned) return null;
  if (typeof assigned === "string") return assigned;
  if (typeof assigned === "object") return assigned as AssignedIdentity;
  return null;
}

export function resolveAssignee(
  members: AppConfig["team"]["members"],
  assigned: unknown
): ResolvedAssignee {
  const parsed = parseAssigned(assigned);
  if (!parsed) return { memberId: null, azureId: null, displayName: null };
  const azureId = typeof parsed === "string" ? parsed : parsed.id ?? parsed.uniqueName ?? null;
  const displayName = typeof parsed === "string" ? parsed : parsed.displayName ?? null;
  const uniqueName = typeof parsed === "object" ? parsed.uniqueName ?? null : null;
  const needle = [azureId, displayName, uniqueName].filter(Boolean).map((v) => String(v).toLowerCase());
  const hit = members.find((m) => {
    const hay = [m.id, m.azureId, m.displayName].filter(Boolean).map((v) => String(v).toLowerCase());
    return needle.some((n) => hay.includes(n));
  });
  return {
    memberId: hit?.id ?? null,
    azureId: azureId,
    displayName: hit?.displayName ?? displayName
  };
}

export function upsertMembers(db: Db, config: AppConfig): void {
  for (const m of config.team.members) {
    db.prepare(
      `INSERT INTO members(id, azure_id, display_name, role) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET azure_id=excluded.azure_id, display_name=excluded.display_name, role=excluded.role`
    ).run(m.id, m.azureId, m.displayName, m.role);
  }
}

export function isTeamAssignment(
  members: AppConfig["team"]["members"],
  assignedToId: string | null | undefined,
  assignedToName?: string | null
): boolean {
  const id = String(assignedToId ?? "").trim().toLowerCase();
  const name = String(assignedToName ?? "").trim().toLowerCase();
  if (!id && !name) return false;
  return members.some((m) => {
    const memberId = m.id.toLowerCase();
    const azureId = String(m.azureId ?? "").toLowerCase();
    const display = m.displayName.toLowerCase();
    if (id && (id === memberId || (azureId && id === azureId) || id === display)) return true;
    if (name && (name === display || name.includes(display) || display.includes(name))) return true;
    const surname = display.split(",")[0]?.trim() ?? "";
    if (surname.length >= 4 && name.includes(surname)) return true;
    return false;
  });
}

export function memberLabel(
  db: Db,
  assignedToId: string | null | undefined,
  assignedToName?: string | null
): string {
  if (assignedToId) {
    const row = get<{ display_name: string }>(
      db,
      "SELECT display_name FROM members WHERE id = ? OR azure_id = ? OR display_name = ?",
      assignedToId,
      assignedToId,
      assignedToId
    );
    if (row?.display_name) return row.display_name;
  }
  if (assignedToName && assignedToName.trim()) return assignedToName;
  return "Sin asignar";
}

export function memberTasks(db: Db, member: AppConfig["team"]["members"][0], iteration: string) {
  return all<Record<string, unknown>>(
    db,
    `SELECT id, azure_id, title, state_normalized, type FROM work_items
     WHERE iteration_id = ?
       AND (assigned_to_id = ? OR assigned_to_id = ? OR assigned_to_id = ? OR assigned_to_name = ?)`,
    iteration,
    member.id,
    member.azureId,
    member.displayName,
    member.displayName
  );
}
