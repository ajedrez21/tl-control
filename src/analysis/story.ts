import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../storage/db.ts";
import { all, get, run } from "../storage/db.ts";
import type { AppConfig } from "../config/types.ts";
import { resolveWorkItemArg } from "../domain/ids.ts";
import { nowIso } from "../domain/time.ts";
import { inspectRepo, searchCandidates } from "../adapters/git/repos.ts";
import { evaluateReadiness } from "../domain/readiness.ts";
import type { ContractStatus } from "../domain/readiness.ts";
import { withContextHash } from "../domain/canonical.ts";
import { validateTeamAi } from "../adapters/kit/validate.ts";
import { resolveDataDir } from "../config/load.ts";

export function analyzeStory(db: Db, config: AppConfig, rawId: string): Record<string, unknown> {
  const id = resolveWorkItemArg(rawId, config.azure.organization, config.azure.project);
  const story = get<Wi>(db, "SELECT * FROM work_items WHERE id = ?", id);
  if (!story) throw new Error(`Work Item no encontrado: ${id}`);

  const comments = all<{ id: string; text_html: string; created_at: string; author_name: string }>(db, "SELECT * FROM comments WHERE work_item_id = ?", id);
  const evidence = all(db, "SELECT * FROM evidence WHERE work_item_id = ?", id);
  const questions = all<{ id: string; question: string; blocking: number }>(db, "SELECT * FROM questions WHERE work_item_id = ?", id);
  const attachments = all(db, "SELECT * FROM attachments WHERE work_item_id = ?", id);
  const deps = all<Dep>(db, "SELECT * FROM dependencies WHERE work_item_id = ?", id);
  const contracts = all<Ctr>(db, "SELECT * FROM contracts WHERE work_item_id = ?", id);

  const repoResults = config.repositories.map((repo) => {
    const snap = inspectRepo(repo.repoId, repo.localPath, repo.baseRef);
    const needles = [story.screen ?? "", story.module ?? "", story.title.split(" ")[0] ?? ""];
    const files = snap.available ? searchCandidates(repo.localPath, needles.filter(Boolean)) : [];
    if (snap.sha) {
      run(db, "UPDATE repositories SET last_analyzed_sha = ? WHERE id = ?", snap.sha, repo.repoId);
      run(
        db,
        "UPDATE analyses SET stale = 1 WHERE work_item_id = ? AND repo_id = ? AND base_sha IS NOT NULL AND base_sha != ?",
        id,
        repo.repoId,
        snap.sha
      );
      run(
        db,
        "UPDATE context_packages SET stale = 1 WHERE work_item_id = ? AND stale = 0",
        id
      );
    }
    return {
      ...snap,
      candidateFiles: files.map((f) => ({
        path: f.path,
        verified: true,
        sha: f.sha,
        reason: "Coincidencia de texto en el árbol analizado"
      })),
      note: snap.available
        ? "Símbolos no encontrados se marcan como hipótesis, no como archivos reales."
        : "Repo inaccesible: análisis técnico parcial, contexto no validado."
    };
  });

  const sp = contracts.find((c) => c.kind === "SP");
  const readiness = evaluateReadiness({
    hasAcceptanceCriteria: Boolean(story.acceptance_criteria?.trim()),
    spContractStatus: (sp?.status ?? "NOT_APPLICABLE") as ContractStatus,
    spDeploymentStatus: "NOT_APPLICABLE",
    blockingGaps: questions.filter((q) => q.blocking === 1).length,
    contradictions: Number(
      comments.length > 0 && story.description_html.includes("NO") && comments.some((c) => c.text_html.toLowerCase().includes("sí"))
    ),
    requireConfirmedSpContract: config.readiness.requireConfirmedSpContract,
    blockOnUnknownSp: config.readiness.blockOnUnknownSp,
    requireAcceptanceCriteria: config.readiness.requireAcceptanceCriteria,
    layerNeedsSp: Boolean(sp)
  });

  const analysis = {
    workItemId: id,
    azureId: story.azure_id,
    title: story.title,
    generatedAt: nowIso(),
    functional: {
      problem: story.description_html ? "Ver descripción sanitizada" : "Sin descripción",
      currentBehavior: "UNKNOWN",
      expectedBehavior: story.acceptance_criteria || "UNKNOWN",
      screens: story.screen,
      module: story.module
    },
    evidence,
    attachments,
    comments,
    questions,
    repositories: repoResults,
    contracts,
    dependencies: deps,
    readiness,
    classificationRules: {
      CONFIRMED: "Requisito explícito o decisión del TL con evidencia",
      INFERRED: "Interpretación probable; requiere validación",
      UNKNOWN: "Falta evidencia o hay contradicción"
    }
  };

  const analysisId = `an-${story.azure_id}-${Date.now()}`;
  run(
    db,
    "INSERT INTO analyses(id, work_item_id, kind, created_at, base_sha, repo_id, payload_json, stale) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    analysisId,
    id,
    "functional",
    nowIso(),
    repoResults[0]?.sha ?? null,
    repoResults[0]?.repoId ?? null,
    JSON.stringify(analysis)
  );
  return analysis;
}

export function analyzeSp(db: Db, config: AppConfig, rawId: string): Record<string, unknown> {
  const id = resolveWorkItemArg(rawId, config.azure.organization, config.azure.project);
  const deps = all<Dep>(db, "SELECT * FROM dependencies WHERE work_item_id = ? AND kind LIKE 'SP%'", id);
  const contracts = all<Ctr>(db, "SELECT * FROM contracts WHERE work_item_id = ? AND kind = 'SP'", id);
  const intervals = all(db, "SELECT * FROM dependency_intervals WHERE dependency_id IN (SELECT id FROM dependencies WHERE work_item_id = ?)", id);
  const result = {
    workItemId: id,
    generatedAt: nowIso(),
    contracts: contracts.map((c) => ({
      ...c,
      definition: c.definition_json ? JSON.parse(c.definition_json) : null,
      invented: false,
      rule: c.status === "UNKNOWN" ? "No se inventa firma. Readiness BE/FE bloqueado." : "Contrato según evidencia."
    })),
    dependencies: deps,
    intervals,
    agingUnit: config.agingUnit,
    timezone: config.timezone
  };
  run(
    db,
    "INSERT INTO analyses(id, work_item_id, kind, created_at, base_sha, repo_id, payload_json, stale) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    `sp-${Date.now()}`,
    id,
    "sp",
    nowIso(),
    null,
    null,
    JSON.stringify(result)
  );
  return result;
}

export function prepareStory(db: Db, config: AppConfig, rawId: string, assignTo?: string): Record<string, unknown> {
  const analysis = analyzeStory(db, config, rawId);
  const id = String(analysis.workItemId);
  const story = get<Wi>(db, "SELECT * FROM work_items WHERE id = ?", id)!;
  const spUnknown = (analysis.contracts as Ctr[]).some((c) => c.kind === "SP" && c.status === "UNKNOWN");
  const versionRow = get<{ n: number }>(db, "SELECT COALESCE(MAX(context_version), 0) AS n FROM context_packages WHERE work_item_id = ?", id);
  const contextVersion = Number(versionRow?.n ?? 0) + 1;

  const drafts = [
    draftFor("BE", story, spUnknown, assignTo && memberRole(config, assignTo) === "backend" ? assignTo : null),
    draftFor("FE", story, spUnknown, assignTo && memberRole(config, assignTo) === "frontend" ? assignTo : null)
  ];
  for (const d of drafts) {
    run(
      db,
      `INSERT INTO draft_tasks(id, parent_id, title, layer, assigned_to_id, payload_json, azure_id, publish_status, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'local', ?)
       ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, assigned_to_id=excluded.assigned_to_id, title=excluded.title, idempotency_key=excluded.idempotency_key`,
      d.id,
      id,
      d.title,
      d.layer,
      d.assignedTo,
      JSON.stringify(d),
      d.idempotencyKey
    );
  }

  const pkg = withContextHash({
    schemaVersion: "team-ai/v1",
    artifactType: "work-context",
    artifactId: `ctx-${story.azure_id}-v${contextVersion}`,
    generatedAt: nowIso(),
    workItem: {
      organization: story.organization,
      project: story.project,
      id: story.azure_id,
      revision: story.source_revision ?? 1,
      url: story.url ?? ""
    },
    parentWorkItem: null,
    contextVersion,
    repositories: config.repositories.map((r) => ({
      repoId: r.repoId,
      role: r.role,
      baseRef: r.baseRef,
      baseSha: get<{ last_analyzed_sha: string | null }>(db, "SELECT last_analyzed_sha FROM repositories WHERE id = ?", r.repoId)?.last_analyzed_sha ?? "unknown"
    })),
    summary: {
      functionalGoal: story.title,
      currentBehavior: "Ver análisis; no inventar comportamiento ausente.",
      expectedBehavior: story.acceptance_criteria || "UNKNOWN"
    },
    scope: {
      included: [story.screen, story.module].filter(Boolean),
      excluded: ["Cambios de SP", "Refactors no pedidos"],
      candidateFiles: []
    },
    acceptanceCriteria: story.acceptance_criteria
      ? [{ id: "ac-1", text: story.acceptance_criteria, evidenceIds: [] }]
      : [],
    contracts: (analysis.contracts as Ctr[]).map((c) => ({
      id: c.id,
      kind: c.kind,
      version: c.version ?? "v1",
      status: c.status,
      sourceEvidenceIds: [],
      definition: c.definition_json
        ? JSON.parse(c.definition_json)
        : { inputs: [], outputs: [], errors: [], compatibilityNotes: "Contrato desconocido. No inventar firma." }
    })),
    dependencies: (analysis.dependencies as Dep[]).map((d) => ({
      id: d.id,
      kind: d.kind,
      status: d.status,
      blocks: JSON.parse(d.blocks_json || "[]"),
      evidenceIds: []
    })),
    evidence: [],
    gaps: all<{ id: string; question: string; blocking: number }>(db, "SELECT * FROM questions WHERE work_item_id = ?", id).map((q) => ({
      id: q.id,
      question: q.question,
      blocking: q.blocking === 1,
      evidenceIds: []
    })),
    testPlan: [
      { id: "t-func-1", title: "Caso feliz", kind: "functional", steps: ["Preparar datos de fixture", "Ejecutar flujo"], command: "" }
    ],
    assignedTo: assignTo
      ? {
          id: assignTo,
          displayName: config.team.members.find((m) => m.id === assignTo)?.displayName ?? assignTo,
          role: memberRole(config, assignTo) === "other" ? "backend" : memberRole(config, assignTo)
        }
      : null,
    readiness: analysis.readiness
  });

  const valid = validateTeamAi("work-context", pkg);
  if (!valid.ok) {
    throw new Error(`work-context inválido: ${valid.errors.join("; ")}`);
  }

  run(
    db,
    "INSERT INTO context_packages(id, work_item_id, context_version, context_hash, payload_json, created_at, stale) VALUES (?, ?, ?, ?, ?, ?, 0)",
    pkg.artifactId,
    id,
    contextVersion,
    pkg.contextHash,
    JSON.stringify(pkg),
    nowIso()
  );

  const dir = join(resolveDataDir(config), "exports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pkg.artifactId}.json`);
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  return { analysis, drafts, contextPackage: pkg, exportPath: file, publish: "disabled-export-only" };
}

function memberRole(config: AppConfig, id: string): "frontend" | "backend" | "other" {
  return config.team.members.find((m) => m.id === id)?.role ?? "other";
}

function draftFor(layer: "BE" | "FE", story: Wi, spUnknown: boolean, assigned: string | null) {
  return {
    id: `draft-${story.azure_id}-${layer.toLowerCase()}`,
    idempotencyKey: `story:${story.id}:layer:${layer}:v1`,
    layer,
    title: `${layer}: ${layer === "BE" ? "implementar contrato/API existente" : "implementar pantalla reutilizando patrón"} — ${story.screen ?? story.module}`,
    assignedTo: assigned,
    assignment: assigned ?? "UNASSIGNED",
    parentId: story.id,
    objetivo: `Cubrir ${story.title} en capa ${layer} sin ampliar scope.`,
    expected: story.acceptance_criteria || "UNKNOWN",
    repo: layer === "BE" ? "backend" : "frontend",
    blocked: spUnknown,
    contract: spUnknown ? "SP UNKNOWN: no Ready" : "ver paquete",
    dod: ["Criterios comprobables", "Tests del plan", "Sin secretos en el contexto"],
    estimate: { value: story.estimate, official: false, assumptions: ["Estimación sugerida, no dato oficial Azure"] }
  };
}

interface Wi {
  id: string;
  azure_id: number;
  title: string;
  organization: string;
  project: string;
  source_revision: number | null;
  url: string | null;
  acceptance_criteria: string | null;
  description_html: string;
  screen: string | null;
  module: string | null;
  estimate: number | null;
}

interface Dep {
  id: string;
  kind: string;
  status: string;
  blocks_json: string;
}

interface Ctr {
  id: string;
  kind: string;
  version: string | null;
  status: string;
  definition_json: string | null;
}
