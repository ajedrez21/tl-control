export function isBlockedWorkItem(stateNormalized: string, stateOriginal: string | null | undefined): boolean {
  return stateNormalized === "BLOCKED" || String(stateOriginal ?? "").toLowerCase() === "blocked";
}

export interface BlockTreeItem {
  id: string;
  parentId: string | null;
  stateNormalized: string;
  stateOriginal: string | null;
}

/** Ítem bloqueado, o con un ancestro bloqueado. No entra en las estadísticas del inicio. */
export function idsHiddenByBlock(items: BlockTreeItem[]): Set<string> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const memo = new Map<string, boolean>();

  const hidden = (id: string, trail: Set<string>): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const item = byId.get(id);
    if (!item || trail.has(id)) return false;
    trail.add(id);
    const value = isBlockedWorkItem(item.stateNormalized, item.stateOriginal)
      || (item.parentId ? hidden(item.parentId, trail) : false);
    memo.set(id, value);
    return value;
  };

  const ids = new Set<string>();
  for (const item of items) {
    if (hidden(item.id, new Set())) ids.add(item.id);
  }
  return ids;
}
