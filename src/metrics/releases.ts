import type { Db } from "../storage/db.ts";
import { all, get } from "../storage/db.ts";

export interface ReleaseView {
  id: string;
  name: string;
  plannedAt: string | null;
  notes: string | null;
  components: Array<{ id: string; repoId: string | null; component: string | null; version: string | null; sha: string | null; buildId: string | null }>;
  workItems: Array<{ id: string; title: string; screens: string | null }>;
  deployments: Array<{
    id: string;
    environment: string;
    status: string;
    at: string;
    source: string;
    author: string | null;
    reference: string | null;
    artifactId: string | null;
  }>;
}

export function listReleases(db: Db, releaseId?: string): ReleaseView[] {
  const packs = releaseId
    ? all<PackRow>(db, "SELECT * FROM release_packages WHERE id = ?", releaseId)
    : all<PackRow>(db, "SELECT * FROM release_packages ORDER BY planned_at DESC");
  return packs.map((p) => ({
    id: p.id,
    name: p.name,
    plannedAt: p.planned_at,
    notes: p.notes,
    components: all(db, "SELECT id, repo_id AS repoId, component, version, sha, build_id AS buildId FROM release_components WHERE release_id = ?", p.id),
    workItems: all(
      db,
      `SELECT r.work_item_id AS id, w.title, r.screens
       FROM release_work_items r LEFT JOIN work_items w ON w.id = r.work_item_id
       WHERE r.release_id = ?`,
      p.id
    ),
    deployments: all(
      db,
      `SELECT id, environment, status, at, source, author, reference, artifact_id AS artifactId
       FROM deployments WHERE release_id = ? ORDER BY at DESC`,
      p.id
    )
  }));
}

export function storyReleaseStatus(db: Db, workItemId: string): {
  inPackage: boolean;
  production: boolean;
  lastDeploy: { environment: string; status: string; source: string; at: string } | null;
} {
  const inPackage = Number(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM release_work_items WHERE work_item_id = ?", workItemId)?.n ?? 0) > 0;
  const last = get<{ environment: string; status: string; source: string; at: string }>(
    db,
    "SELECT environment, status, source, at FROM deployments WHERE work_items_json LIKE ? ORDER BY at DESC LIMIT 1",
    `%"${workItemId}"%`
  );
  const prod = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM deployments
     WHERE status = 'success' AND environment IN ('PROD','production','Production') AND work_items_json LIKE ?`,
    `%"${workItemId}"%`
  );
  return {
    inPackage,
    production: Number(prod?.n ?? 0) > 0,
    lastDeploy: last ?? null
  };
}

interface PackRow {
  id: string;
  name: string;
  planned_at: string | null;
  notes: string | null;
}
