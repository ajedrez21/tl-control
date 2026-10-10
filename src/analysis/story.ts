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
import { htmlToText, sanitizeHtml } from "../domain/sanitize.ts";
import { syncFunctionalQuestions } from "./functional-questions.ts";
import { listSpDossier } from "../metrics/sp-dossier.ts";

export type ScopeMode = "story-and-children" | "story-only" | "task-only";

export interface SourceAttachment {
  id: string;
  fileName: string;
  contentType: string | null;
  storedPath: string;
  sourceUrl: string | null;
  image: boolean;
}

export interface SourceContextItem {
  azureId: number;
  type: string;
  title: string;
  descriptionHtml: string;
  descriptionText: string;
  acceptanceCriteria: string | null;
  comments: Array<{ author: string; at: string; html: string }>;
  attachments: SourceAttachment[];
}

export function analyzeStory(db: Db, config: AppConfig, rawId: string): Record<string, unknown> {
  const id = resolveWorkItemArg(rawId, config.azure.organization, config.azure.project);
  const story = get<Wi>(db, "SELECT * FROM work_items WHERE id = ?", id);
  if (!story) throw new Error(`Work Item no encontrado: ${id}`);

  const scoped = loadScopedWorkItems(db, config, story);
  const items = scoped.workItems.map((wi) => collectItemBundle(db, wi));
  syncFunctionalQuestions(db, id, items);
  items[0]!.questions = all<{ id: string; question: string; blocking: number; status: string | null }>(
    db,
    "SELECT * FROM questions WHERE work_item_id = ?",
    id
  );
  const root = items[0]!;
  const children = items.slice(1);
  const allQuestions = items.flatMap((item) => item.questions);
  const allEvidence = items.flatMap((item) => item.evidence);
  const allAttachments = items.flatMap((item) => item.attachments);
  const allComments = items.flatMap((item) => item.comments);
  const deps = all<Dep>(db, "SELECT * FROM dependencies WHERE work_item_id = ?", id);
  const contracts = ensureRequestedSpContract(db, id, items);

  const needles = [
    story.screen ?? "",
    story.module ?? "",
    story.title.split(" ")[0] ?? "",
    ...children.map((c) => c.title.split(" ")[0] ?? "")
  ];
  const repoResults = config.repositories.map((repo) => {
    const snap = inspectRepo(repo.repoId, repo.localPath, repo.baseRef);
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
    hasAcceptanceCriteria: items.some((item) => Boolean(item.acceptanceCriteria?.trim())),
    spContractStatus: (sp?.status ?? "NOT_APPLICABLE") as ContractStatus,
    spDeploymentStatus: "NOT_APPLICABLE",
    blockingGaps: allQuestions.filter((q) => q.blocking === 1 && (q.status ?? "pending") !== "answered").length,
    contradictions: Number(hasTextContradiction(items)),
    requireConfirmedSpContract: config.readiness.requireConfirmedSpContract,
    blockOnUnknownSp: config.readiness.blockOnUnknownSp,
    requireAcceptanceCriteria: config.readiness.requireAcceptanceCriteria,
    layerNeedsSp: Boolean(sp)
  });

  const analysis = {
    workItemId: id,
    azureId: story.azure_id,
    title: story.title,
    type: story.type,
    generatedAt: nowIso(),
    scope: {
      mode: scoped.mode,
      reviewedWorkItemIds: items.map((item) => item.azureId),
      childrenCount: children.length
    },
    functional: {
      problem: root.descriptionText || "Sin descripción",
      descriptionHtml: root.descriptionHtml,
      currentBehavior: "UNKNOWN",
      expectedBehavior: root.acceptanceCriteria || "UNKNOWN",
      screens: story.screen,
      module: story.module
    },
    items,
    children,
    evidence: allEvidence,
    attachments: allAttachments,
    comments: allComments,
    questions: allQuestions,
    repositories: repoResults,
    contracts,
    dependencies: deps,
    readiness,
    sourceContext: toSourceContext(items),
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
  const wi = get<{ azure_id: number }>(db, "SELECT azure_id FROM work_items WHERE id = ?", id);
  const dossier = listSpDossier(db, config);
  const trace = dossier.traces.find((item) => item.workItemId === id || item.azureId === wi?.azure_id) ?? null;
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
    trace,
    chain: trace
      ? {
          screen: trace.screen,
          captures: trace.captures,
          frontendPages: trace.frontendPages,
          loadApis: trace.apis.filter((api) => api.usage === "lectura"),
          saveApis: trace.apis.filter((api) => api.usage === "envio"),
          reads: trace.reads,
          writes: trace.writes,
          explanation: trace.explanation
        }
      : null,
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
  const sourceContext = (analysis.sourceContext as SourceContextItem[]) ?? [];
  const generatedAt = nowIso();

  const drafts = [
    draftFor("BE", story, spUnknown, assignTo && memberRole(config, assignTo) === "backend" ? assignTo : null, sourceContext),
    draftFor("FE", story, spUnknown, assignTo && memberRole(config, assignTo) === "frontend" ? assignTo : null, sourceContext)
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
    generatedAt,
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
      included: [
        ...[story.screen, story.module].filter(Boolean),
        ...sourceContext.filter((item) => item.azureId !== story.azure_id).map((item) => `#${item.azureId} ${item.title}`)
      ],
      excluded: ["Cambios de SP", "Refactors no pedidos"],
      candidateFiles: []
    },
    acceptanceCriteria: sourceContext
      .filter((item) => item.acceptanceCriteria?.trim())
      .map((item) => ({
        id: `ac-${item.azureId}`,
        text: item.acceptanceCriteria as string,
        evidenceIds: []
      })),
    contracts: (analysis.contracts as Ctr[]).map((c) => ({
      id: c.id,
      kind: c.kind,
      version: c.version ?? "v1",
      status: c.status,
      sourceEvidenceIds: [],
      definition: contractDefinitionForWorkContext(c.definition_json)
    })),
    dependencies: (analysis.dependencies as Dep[]).map((d) => ({
      id: d.id,
      kind: d.kind,
      status: d.status,
      blocks: JSON.parse(d.blocks_json || "[]"),
      evidenceIds: []
    })),
    evidence: packageEvidence(sourceContext, generatedAt),
    gaps: ((analysis.questions as Array<{ id: string; question: string; blocking: number }>) ?? []).map((q) => ({
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

function draftFor(
  layer: "BE" | "FE",
  story: Wi,
  spUnknown: boolean,
  assigned: string | null,
  sourceContext: SourceContextItem[]
) {
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
    estimate: { value: story.estimate, official: false, assumptions: ["Estimación sugerida, no dato oficial Azure"] },
    sourceContext
  };
}

export function azureDescriptionFromPayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const objetivo = text(payload.objetivo);
  const expected = text(payload.expected);
  const contract = text(payload.contract);
  const repo = repoLine(payload);
  if (objetivo) parts.push(`<p><strong>Objetivo.</strong> ${escapeHtml(objetivo)}</p>`);
  if (expected && expected !== "UNKNOWN") parts.push(`<p><strong>Esperado.</strong> ${escapeHtml(expected)}</p>`);
  if (payload.blocked === true) parts.push("<p><strong>Estado.</strong> No iniciar hasta el handoff.</p>");
  if (repo) parts.push(`<p><strong>Repo.</strong> ${escapeHtml(repo)}</p>`);
  if (contract) parts.push(`<p><strong>Contrato.</strong> ${escapeHtml(contract)}</p>`);
  const ctx = Array.isArray(payload.sourceContext) ? (payload.sourceContext as SourceContextItem[]) : [];
  if (ctx.length) {
    parts.push("<h3>Más info (historia y subtareas)</h3>");
    for (const item of ctx) {
      parts.push(`<h4>#${item.azureId} ${escapeHtml(item.title)} (${escapeHtml(item.type)})</h4>`);
      if (item.descriptionHtml) parts.push(item.descriptionHtml);
      if (item.acceptanceCriteria?.trim()) {
        parts.push(`<p><strong>AC.</strong> ${escapeHtml(item.acceptanceCriteria)}</p>`);
      }
      for (const comment of item.comments ?? []) {
        parts.push(`<p><strong>Comentario ${escapeHtml(comment.author || "")}.</strong></p>${comment.html}`);
      }
      for (const att of item.attachments ?? []) {
        const kind = att.image ? "Imagen" : "Adjunto";
        if (att.image && att.sourceUrl) {
          parts.push(`<p>${kind}: ${escapeHtml(att.fileName)}</p><p><img src="${escapeHtml(att.sourceUrl)}" alt="${escapeHtml(att.fileName)}"/></p>`);
        } else {
          parts.push(`<p>${kind}: ${escapeHtml(att.fileName)}${att.sourceUrl ? ` — ${escapeHtml(att.sourceUrl)}` : ""}</p>`);
        }
      }
    }
  }
  const pasos = textList(payload.pasos);
  const fromFiles = textList(payload.files);
  const files = fromFiles.length ? fromFiles : textList(payload.archivosReferencia);
  const dod = textList(payload.dod);
  if (pasos.length) parts.push(`<h3>Pasos</h3><ol>${pasos.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`);
  if (files.length) parts.push(`<h3>Archivos</h3><ul>${files.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>`);
  if (dod.length) parts.push(`<h3>Definición de hecho</h3><ul>${dod.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
  parts.push(`<p><em>Borrador TL Control ${nowIso()}</em></p>`);
  return parts.join("\n");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && "path" in item) return text((item as { path: unknown }).path);
      return "";
    })
    .filter(Boolean);
}

function repoLine(payload: Record<string, unknown>): string {
  const base = payload.base;
  if (base && typeof base === "object") {
    const row = base as { repo?: unknown; ref?: unknown; sha?: unknown };
    const repo = text(row.repo);
    const ref = text(row.ref);
    const sha = text(row.sha).slice(0, 8);
    if (repo) return [repo, ref ? `@ ${ref}` : "", sha ? `(${sha})` : ""].filter(Boolean).join(" ");
  }
  return text(payload.repo);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isTaskWorkItem(type: string, config: AppConfig): boolean {
  const taskType = (config.azure.workItemTypes.task ?? "Task").toLowerCase();
  return type.toLowerCase() === taskType;
}

function loadScopedWorkItems(db: Db, config: AppConfig, root: Wi): { mode: ScopeMode; workItems: Wi[] } {
  if (isTaskWorkItem(root.type, config)) {
    return { mode: "task-only", workItems: [root] };
  }
  const children = all<Wi>(db, "SELECT * FROM work_items WHERE parent_id = ? ORDER BY azure_id", root.id);
  return {
    mode: children.length ? "story-and-children" : "story-only",
    workItems: [root, ...children]
  };
}

function collectItemBundle(db: Db, wi: Wi): ItemBundle {
  const descriptionHtml = sanitizeHtml(wi.description_html);
  const stored = all<AttachmentRow>(db, "SELECT * FROM attachments WHERE work_item_id = ?", wi.id).map((att) => ({
    id: att.id,
    fileName: att.file_name,
    contentType: att.content_type,
    storedPath: att.stored_path,
    sourceUrl: att.source_url,
    image: isImageAttachment(att.content_type, att.file_name)
  }));
  const attachments = mergeRelationAttachments(db, wi, stored);
  return {
    id: wi.id,
    azureId: wi.azure_id,
    type: wi.type,
    title: wi.title,
    state: wi.state_normalized,
    assignedTo: wi.assigned_to_name ?? null,
    descriptionHtml,
    descriptionText: htmlToText(wi.description_html),
    acceptanceCriteria: wi.acceptance_criteria,
    comments: all<{ id: string; text_html: string; created_at: string; author_name: string }>(
      db,
      "SELECT * FROM comments WHERE work_item_id = ?",
      wi.id
    ).map((c) => ({
      ...c,
      text_html: sanitizeHtml(c.text_html)
    })),
    attachments,
    evidence: all(db, "SELECT * FROM evidence WHERE work_item_id = ?", wi.id),
    questions: all<{ id: string; question: string; blocking: number }>(db, "SELECT * FROM questions WHERE work_item_id = ?", wi.id)
  };
}

function toSourceContext(items: ItemBundle[]): SourceContextItem[] {
  return items
    .filter((item) =>
      Boolean(
        item.descriptionText ||
          item.acceptanceCriteria?.trim() ||
          item.attachments.length ||
          item.comments.length
      )
    )
    .map((item) => ({
      azureId: item.azureId,
      type: item.type,
      title: item.title,
      descriptionHtml: item.descriptionHtml,
      descriptionText: item.descriptionText,
      acceptanceCriteria: item.acceptanceCriteria,
      comments: item.comments.map((c) => ({
        author: c.author_name,
        at: c.created_at,
        html: c.text_html
      })),
      attachments: item.attachments
    }));
}

function packageEvidence(items: SourceContextItem[], generatedAt: string) {
  const evidence: Array<{
    id: string;
    kind: "work-item" | "comment" | "attachment";
    source: string;
    classification: "CONFIRMED" | "INFERRED" | "UNKNOWN";
    observedAt: string;
    summary: string;
  }> = [];
  for (const item of items) {
    if (item.descriptionText) {
      evidence.push({
        id: `ev-desc-${item.azureId}`,
        kind: "work-item",
        source: `#${item.azureId}#description`,
        classification: "CONFIRMED",
        observedAt: generatedAt,
        summary: `Descripción de #${item.azureId} ${item.title}: ${item.descriptionText.slice(0, 240)}`
      });
    }
    if (item.acceptanceCriteria?.trim()) {
      evidence.push({
        id: `ev-ac-${item.azureId}`,
        kind: "work-item",
        source: `#${item.azureId}#ac`,
        classification: "CONFIRMED",
        observedAt: generatedAt,
        summary: `AC de #${item.azureId}: ${item.acceptanceCriteria.slice(0, 240)}`
      });
    }
    for (const comment of item.comments) {
      const text = htmlToText(comment.html);
      if (!text) continue;
      evidence.push({
        id: `ev-cmt-${item.azureId}-${comment.at}`,
        kind: "comment",
        source: `#${item.azureId}#comment`,
        classification: "CONFIRMED",
        observedAt: comment.at || generatedAt,
        summary: `Comentario en #${item.azureId} (${comment.author}): ${text.slice(0, 240)}`
      });
    }
    for (const att of item.attachments) {
      evidence.push({
        id: `ev-att-${att.id}`,
        kind: "attachment",
        source: `attachment:${att.id}`,
        classification: att.image ? "INFERRED" : "CONFIRMED",
        observedAt: generatedAt,
        summary: `${att.image ? "Imagen" : "Adjunto"} ${att.fileName} de #${item.azureId}`
      });
    }
  }
  return evidence;
}

function textAsksForSp(items: ItemBundle[]): boolean {
  const blob = items
    .map((item) => `${item.title}\n${item.descriptionText}\n${item.acceptanceCriteria ?? ""}`)
    .join("\n");
  return /\b(sp|stored procedure|procedimiento almacenado)\b/i.test(blob);
}

function contractDefinitionForWorkContext(definitionJson: string | null): {
  inputs: unknown[];
  outputs: unknown[];
  errors: string[];
  compatibilityNotes: string;
} {
  const fallback = {
    inputs: [] as unknown[],
    outputs: [] as unknown[],
    errors: [] as string[],
    compatibilityNotes: "Contrato desconocido. No inventar firma."
  };
  if (!definitionJson?.trim()) return fallback;
  try {
    const raw = JSON.parse(definitionJson) as Record<string, unknown>;
    if (Array.isArray(raw.inputs) && Array.isArray(raw.outputs) && Array.isArray(raw.errors)) {
      const notes = typeof raw.compatibilityNotes === "string" ? raw.compatibilityNotes : fallback.compatibilityNotes;
      return {
        inputs: raw.inputs,
        outputs: raw.outputs,
        errors: raw.errors.map(String),
        compatibilityNotes: notes
      };
    }
    const parts: string[] = [];
    if (typeof raw.change === "string") parts.push(`change: ${raw.change}`);
    if (typeof raw.compatibilityNotes === "string") parts.push(raw.compatibilityNotes);
    return {
      ...fallback,
      compatibilityNotes: parts.length ? parts.join(" — ") : fallback.compatibilityNotes
    };
  } catch {
    return fallback;
  }
}

function ensureRequestedSpContract(db: Db, workItemId: string, items: ItemBundle[]): Ctr[] {
  const existing = all<Ctr>(db, "SELECT * FROM contracts WHERE work_item_id = ?", workItemId);
  if (existing.some((contract) => contract.kind === "SP")) return existing;
  if (!textAsksForSp(items)) return existing;
  run(
    db,
    "INSERT INTO contracts(id, work_item_id, kind, name, version, status, definition_json, source_evidence_ids, environment) VALUES (?, ?, 'SP', NULL, 'v1', 'UNKNOWN', ?, '[]', NULL)",
    `ctr-sp-req-${workItemId.replaceAll("/", "-")}`,
    workItemId,
    JSON.stringify({
      change: "NEW",
      compatibilityNotes: "El texto pide un SP y no hay contrato."
    })
  );
  return all<Ctr>(db, "SELECT * FROM contracts WHERE work_item_id = ?", workItemId);
}

function mergeRelationAttachments(db: Db, wi: Wi, stored: SourceAttachment[]): SourceAttachment[] {
  const seen = new Set(stored.map((att) => att.sourceUrl || att.id));
  const rels = all<{ rel_type: string; target_url: string | null; attributes_json: string | null }>(
    db,
    "SELECT rel_type, target_url, attributes_json FROM work_item_relations WHERE work_item_id = ?",
    wi.id
  );
  const extra: SourceAttachment[] = [];
  for (const rel of rels) {
    if (!/attachedfile/i.test(rel.rel_type || "")) continue;
    const url = rel.target_url || "";
    if (!url || seen.has(url)) continue;
    let name = url.split("/").pop() || "adjunto";
    try {
      const attrs = rel.attributes_json ? (JSON.parse(rel.attributes_json) as { name?: string }) : {};
      if (attrs.name) name = attrs.name;
    } catch {
      /* ignore malformed attributes */
    }
    seen.add(url);
    extra.push({
      id: `rel-${wi.azure_id}-${extra.length + stored.length + 1}`,
      fileName: name,
      contentType: isImageAttachment(null, name) ? "image/*" : null,
      storedPath: "",
      sourceUrl: url,
      image: isImageAttachment(null, name)
    });
  }
  return [...stored, ...extra];
}

function isImageAttachment(contentType: string | null, fileName: string): boolean {
  if (contentType && contentType.toLowerCase().startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName);
}

function hasTextContradiction(items: ItemBundle[]): boolean {
  return items.some((item) => {
    const desc = item.descriptionText.toLowerCase();
    if (!desc.includes("no")) return false;
    return item.comments.some((c) => htmlToText(c.text_html).toLowerCase().includes("sí"));
  });
}

interface ItemBundle {
  id: string;
  azureId: number;
  type: string;
  title: string;
  state: string;
  assignedTo: string | null;
  descriptionHtml: string;
  descriptionText: string;
  acceptanceCriteria: string | null;
  comments: Array<{ id: string; text_html: string; created_at: string; author_name: string }>;
  attachments: SourceAttachment[];
  evidence: unknown[];
  questions: Array<{ id: string; question: string; blocking: number }>;
}

interface AttachmentRow {
  id: string;
  file_name: string;
  content_type: string | null;
  stored_path: string;
  source_url: string | null;
}

interface Wi {
  id: string;
  azure_id: number;
  type: string;
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
  assigned_to_name?: string | null;
  state_normalized: string;
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
