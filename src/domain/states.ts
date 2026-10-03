export type NormalizedState =
  | "NEW"
  | "READY"
  | "DOING"
  | "REVIEW"
  | "BLOCKED"
  | "DEV_DONE"
  | "QA"
  | "UAT"
  | "PENDING_RELEASE"
  | "PRODUCTION"
  | "REMOVED"
  | "OTHER";

export const NORMALIZED_STATES: NormalizedState[] = [
  "NEW",
  "READY",
  "DOING",
  "REVIEW",
  "BLOCKED",
  "DEV_DONE",
  "QA",
  "UAT",
  "PENDING_RELEASE",
  "PRODUCTION",
  "REMOVED",
  "OTHER"
];

export function normalizeState(
  original: string,
  mapping: Record<string, string>
): NormalizedState {
  const mapped = mapping[original];
  if (mapped && NORMALIZED_STATES.includes(mapped as NormalizedState)) {
    return mapped as NormalizedState;
  }
  const lower = original.trim().toLowerCase();
  for (const [key, value] of Object.entries(mapping)) {
    if (key.toLowerCase() === lower && NORMALIZED_STATES.includes(value as NormalizedState)) {
      return value as NormalizedState;
    }
  }
  return "OTHER";
}

export function stateLabel(state: NormalizedState): string {
  const labels: Record<NormalizedState, string> = {
    NEW: "Nueva",
    READY: "Lista",
    DOING: "En desarrollo",
    REVIEW: "Review",
    BLOCKED: "Bloqueada",
    DEV_DONE: "Desarrollo terminado",
    QA: "QA",
    UAT: "UAT",
    PENDING_RELEASE: "Pendiente de release",
    PRODUCTION: "Producción",
    REMOVED: "Fuera de scope",
    OTHER: "Otro"
  };
  return labels[state];
}
