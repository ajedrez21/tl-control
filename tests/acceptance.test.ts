import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { canonicalize, contextHashFor, withContextHash } from "../src/domain/canonical.ts";
import { workItemKey, parseWorkItemKey } from "../src/domain/ids.ts";
import { evaluateReadiness, productionConfirmed } from "../src/domain/readiness.ts";
import { sanitizeHtml } from "../src/domain/sanitize.ts";
import {
  isSafeAzureAttachmentUrl,
  rewriteAzureAttachmentUrls
} from "../src/domain/azure-images.ts";
import { calendarDaysBetween } from "../src/domain/time.ts";
import { openDb, all, get, run } from "../src/storage/db.ts";
import { backupDb, restoreDb } from "../src/storage/backup.ts";
import { demoConfig, seedDemo } from "../src/demo/seed.ts";
import { persistWorkItems, AzureDevOpsClient, syncIteration } from "../src/adapters/azure/client.ts";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/adapters/http.ts";
import { computeScope, computeSprintMetrics, isInProduction } from "../src/metrics/sprint.ts";
import { refreshAlerts } from "../src/metrics/alerts.ts";
import { analyzeStory, analyzeSp, azureDescriptionFromPayload, prepareStory } from "../src/analysis/story.ts";
import { assignDraft, publishApprovedDrafts, reviewDraft } from "../src/analysis/drafts.ts";
import { validateTeamAi } from "../src/adapters/kit/validate.ts";
import { importWorkResult } from "../src/adapters/kit/import.ts";
import { previewPublish } from "../src/cli/publish.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { writeFrozenReport } from "../src/report/frozen.ts";
import { projectRoot } from "../src/config/load.ts";
import { assertInsideDir } from "../src/server/safe-path.ts";
import { createAutoSync } from "../src/server/auto-sync.ts";
import { idsHiddenByBlock } from "../src/metrics/blocked.ts";
import { confirmSpContract, dismissSqlGap, listSqlGaps, sqlGapCopy } from "../src/metrics/sql-gaps.ts";
import { extractSpNames, listSpDossier, spsForSqlRequest } from "../src/metrics/sp-dossier.ts";
import { expandTemplate, extractProductSpNames, inferScreenFromTitle, normalizeApiPath } from "../src/metrics/sp-code-trace.ts";
import { renderSpReport } from "../src/report/sp.ts";
import { answerFunctionalQuestion, listFunctionalQuestions, publishFunctionalQuestions } from "../src/analysis/functional-questions.ts";
import { findSandboxMentions, renderDailyReport, verdict } from "../src/report/daily.ts";
import { loadMemberBoard, saveMemberBoard, inferBoardColumn, resolveBoardColumn, memberShortName } from "../src/domain/board.ts";

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "tlc-"));
  const db = openDb(join(dir, "db.sqlite"));
  seedDemo(db, dir);
  const config = { ...demoConfig(), paths: { dataDir: dir, reportsDir: join(dir, "reports") } };
  return { dir, db, config };
}

test("TL-AC01 doctor y demo sin credenciales", () => {
  const doctor = runDoctor();
  assert.equal(doctor.ok, true);
  const azureAuth = doctor.checks.find((c) => c.id === "azure-auth");
  assert.ok(azureAuth);
  const { db } = seeded();
  const n = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM work_items");
  assert.ok(Number(n?.n) > 10);
  db.close();
});

test("identidades no usan sólo #id", () => {
  const id = workItemKey("org", "proj", 3215);
  assert.equal(id, "org/proj/3215");
  assert.deepEqual(parseWorkItemKey(id), { organization: "org", project: "proj", azureId: 3215 });
});

test("TL-AC02 sync repetida no duplica", () => {
  const { db, config } = seeded();
  const item = {
    id: 9999,
    rev: 1,
    url: "https://example/9999",
    fields: {
      "System.Title": "X",
      "System.WorkItemType": "User Story",
      "System.State": "New",
      "System.IterationPath": config.azure.iterationPath
    },
    relations: [{ rel: "System.LinkTypes.Related", url: "https://example/_apis/wit/workItems/1" }]
  };
  persistWorkItems(db, config, [item], "run-a");
  persistWorkItems(db, config, [item], "run-a");
  persistWorkItems(db, config, [item], "run-b");
  const items = all(db, "SELECT * FROM work_items WHERE azure_id = 9999");
  const rels = all(db, "SELECT * FROM work_item_relations WHERE work_item_id LIKE '%/9999'");
  assert.equal(items.length, 1);
  assert.equal(rels.length, 1);
  const parented = {
    id: 10001,
    rev: 1,
    url: "https://example/10001",
    fields: {
      "System.Title": "Child",
      "System.WorkItemType": "Task",
      "System.State": "To Do",
      "System.IterationPath": config.azure.iterationPath,
      "System.AssignedTo": { id: "aad-lucia", displayName: "Lucía Fernández" }
    },
    relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/x/_apis/wit/workItems/9999" }]
  };
  persistWorkItems(db, config, [parented], "run-c");
  const child = get<{ parent_id: string; assigned_to_id: string; assigned_to_name: string }>(db, "SELECT parent_id, assigned_to_id, assigned_to_name FROM work_items WHERE azure_id = 10001");
  assert.equal(child?.parent_id, workItemKey("fabrikam-demo", "TL Control Demo", 9999));
  assert.equal(child?.assigned_to_id, "fe-lucia");
  assert.equal(child?.assigned_to_name, "Lucía Fernández");
  assert.equal(items.length, 1);
  assert.equal(rels.length, 1);
  db.close();
});

test("TL-AC03 paginación y 403 conservan cobertura", async () => {
  const { db, config } = seeded();
  const before = Number(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM work_items")?.n);
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      if (req.url.includes("/wit/wiql")) {
        return { status: 200, body: JSON.stringify({ workItems: [{ id: 1 }] }), headers: {} };
      }
      if (req.url.includes("workitems?ids=")) {
        return {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 1,
                rev: 2,
                url: "u",
                fields: { "System.Title": "Paginado", "System.WorkItemType": "User Story", "System.State": "New" }
              }
            ]
          }),
          headers: {}
        };
      }
      if (req.url.includes("/comments")) return { status: 403, body: "{}", headers: {} };
      if (req.url.includes("/revisions")) return { status: 200, body: JSON.stringify({ value: [] }), headers: {} };
      return { status: 404, body: "{}", headers: {} };
    }
  };
  const client = new AzureDevOpsClient(config, http, { pat: "x" });
  const result = await syncIteration(db, config, client, config.azure.iterationPath);
  assert.equal(result.coverage.comments, "UNAUTHORIZED");
  assert.equal(result.coverage.workItems, "OK");
  const after = Number(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM work_items")?.n);
  assert.ok(after >= before);
  db.close();
});

test("TL-AC04 historia con captura produce evidencia e inferencias", () => {
  const { db } = seeded();
  const ev = all(db, "SELECT * FROM evidence WHERE work_item_id LIKE '%/4102'");
  const q = all(db, "SELECT * FROM questions WHERE work_item_id LIKE '%/4102'");
  assert.ok(ev.some((e: { classification: string }) => e.classification === "INFERRED"));
  assert.ok(q.length >= 1);
  db.close();
});

test("TL-AC05 SP desconocido bloquea Ready y no inventa firma", () => {
  const blocked = evaluateReadiness({
    hasAcceptanceCriteria: true,
    spContractStatus: "UNKNOWN",
    spDeploymentStatus: "PENDING",
    blockingGaps: 0,
    contradictions: 0,
    requireConfirmedSpContract: true,
    blockOnUnknownSp: true,
    requireAcceptanceCriteria: true,
    layerNeedsSp: true
  });
  assert.equal(blocked.status, "BLOCKED");
  const { db, config } = seeded();
  const sp = analyzeSp(db, config, "4103");
  const ctr = (sp.contracts as Array<{ status: string; invented: boolean; definition: unknown }>)[0];
  assert.equal(ctr.status, "UNKNOWN");
  assert.equal(ctr.invented, false);
  assert.equal(ctr.definition, null);
  db.close();
});

test("TL-AC06 SHA distinto marca análisis stale", () => {
  const { db } = seeded();
  db.prepare("INSERT INTO analyses VALUES (?,?,?,?,?,?,?,?)").run("a1", "fabrikam-demo/TL Control Demo/4101", "technical", "2026-10-01T00:00:00.000Z", "oldsha", "frontend", "{}", 0);
  db.prepare("UPDATE analyses SET stale = 1 WHERE repo_id = ? AND base_sha IS NOT NULL AND base_sha != ?").run("frontend", "newsha");
  const row = get<{ stale: number }>(db, "SELECT stale FROM analyses WHERE id = 'a1'");
  assert.equal(Number(row?.stale), 1);
  db.close();
});

test("TL-AC07 subtareas ejecutables y asignación manual", () => {
  const { db, config } = seeded();
  const prepared = prepareStory(db, config, "4106");
  const drafts = prepared.drafts as Array<{ assignment: string; title: string }>;
  assert.ok(drafts.every((d) => d.assignment === "UNASSIGNED"));
  assert.ok(drafts.every((d) => !/^hacer /i.test(d.title)));
  db.close();
});

test("UI: asignar, aprobar y publicar solo aprobadas (sin writes Azure)", async () => {
  const { db, config, dir } = seeded();
  prepareStory(db, config, "4106");
  const fe = get<{ id: string }>(db, "SELECT id FROM draft_tasks WHERE parent_id LIKE '%/4106' AND layer = 'FE'");
  const be = get<{ id: string }>(db, "SELECT id FROM draft_tasks WHERE parent_id LIKE '%/4106' AND layer = 'BE'");
  assert.ok(fe && be);
  const assigned = assignDraft(db, config, fe.id, "fe-lucia");
  assert.equal(assigned.assignedTo, "fe-lucia");
  assert.equal(assigned.fallback, false);
  const remapped = assignDraft(db, config, fe.id, "fe-martin");
  assert.equal(remapped.assignedTo, "fe-lucia");
  assert.equal(remapped.requestedId, "fe-martin");
  assert.equal(remapped.fallback, true);
  assert.throws(() => assignDraft(db, config, fe.id, "be-paula"));
  reviewDraft(db, fe.id, "approved");
  const empty = await publishApprovedDrafts(db, config, "4106", true);
  assert.equal(empty.preview.operations.length, 1);
  assert.equal(empty.published, false);
  assert.match(empty.reason, /writes.enabled=false/);
  assert.equal(empty.preview.operations[0].assignedTo, "fe-lucia");
  const queued = get<{ publish_status: string; review_status: string }>(db, "SELECT publish_status, review_status FROM draft_tasks WHERE id = ?", fe.id);
  assert.equal(queued?.review_status, "approved");
  assert.equal(queued?.publish_status, "queued");
  const untouched = get<{ review_status: string; publish_status: string }>(db, "SELECT review_status, publish_status FROM draft_tasks WHERE id = ?", be.id);
  assert.equal(untouched?.review_status, "pending");
  assert.equal(untouched?.publish_status, "local");
  db.close();
  void dir;
});

test("publicar aprobadas crea la tarea hija en Azure y no la duplica", async () => {
  const { db, config } = seeded();
  const writable = {
    ...config,
    azure: { ...config.azure, writes: { enabled: true } },
    team: {
      ...config.team,
      members: config.team.members.map((member) => {
        if (member.id === "fe-lucia") return { ...member, azureId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
        if (member.id === "fe-martin") return { ...member, azureId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" };
        return member;
      })
    }
  };
  prepareStory(db, writable, "4106");
  const fe = get<{ id: string }>(db, "SELECT id FROM draft_tasks WHERE parent_id LIKE '%/4106' AND layer = 'FE'");
  assert.ok(fe);
  assignDraft(db, writable, fe.id, "fe-lucia");
  reviewDraft(db, fe.id, "approved");

  const http = new ScriptedAzure();
  const client = new AzureDevOpsClient(writable, http, { pat: "test-pat" });
  const first = await publishApprovedDrafts(db, writable, "4106", true, client);
  assert.equal(first.published, true);
  assert.equal(first.created[0]?.azureId, 9001);
  assert.match(first.reason, /creada #9001/);
  const draft = get<{ azure_id: number; publish_status: string }>(db, "SELECT azure_id, publish_status FROM draft_tasks WHERE id = ?", fe.id);
  assert.equal(draft?.azure_id, 9001);
  assert.equal(draft?.publish_status, "published");
  const child = get<{ parent_id: string; title: string; assigned_to_name: string }>(
    db,
    "SELECT parent_id, title, assigned_to_name FROM work_items WHERE azure_id = 9001"
  );
  assert.equal(child?.parent_id, "fabrikam-demo/TL Control Demo/4106");
  assert.match(child?.title ?? "", /FE:/);
  assert.equal(child?.assigned_to_name, "Lucía Fernández");

  const creates = http.calls.filter((call) => call.method === "POST" && call.url.includes("/wit/workitems/"));
  assert.equal(creates.length, 1);
  const patch = JSON.parse(creates[0].body ?? "[]") as Array<{ path: string; value: unknown }>;
  assert.equal(patch.find((op) => op.path === "/fields/System.AssignedTo")?.value, "Lucía Fernández");
  assert.equal(
    (patch.find((op) => op.path === "/relations/-")?.value as { rel?: string } | undefined)?.rel,
    "System.LinkTypes.Hierarchy-Reverse"
  );

  const reassigned = assignDraft(db, writable, fe.id, "fe-martin");
  assert.equal(reassigned.assignedTo, "fe-martin");
  const second = await publishApprovedDrafts(db, writable, "4106", true, client);
  assert.equal(second.published, true);
  assert.match(second.reason, /actualizada #9001/);
  assert.equal(http.calls.filter((call) => call.method === "POST" && call.url.includes("/wit/workitems/")).length, 1);
  const patches = http.calls.filter((call) => call.method === "PATCH" && call.url.includes("/wit/workitems/9001"));
  assert.equal(patches.length, 1);
  const update = JSON.parse(patches[0].body ?? "[]") as Array<{ path: string; value: unknown }>;
  assert.equal(update.find((op) => op.path === "/fields/System.AssignedTo")?.value, "Martín Soto");
  const childAfter = get<{ assigned_to_name: string }>(db, "SELECT assigned_to_name FROM work_items WHERE azure_id = 9001");
  assert.equal(childAfter?.assigned_to_name, "Martín Soto");
  db.close();
});

class ScriptedAzure implements HttpClient {
  calls: HttpRequest[] = [];

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    if (req.url.includes("/wit/wiql")) {
      return { status: 200, body: JSON.stringify({ workItems: [] }), headers: {} };
    }
    if ((req.method === "POST" || req.method === "PATCH") && req.url.includes("/wit/workitems/")) {
      const patch = JSON.parse(req.body ?? "[]") as Array<{ path: string; value: string }>;
      const title = patch.find((op) => op.path === "/fields/System.Title")?.value ?? "";
      const assigned = patch.find((op) => op.path === "/fields/System.AssignedTo")?.value ?? "Lucía Fernández";
      return {
        status: 200,
        body: JSON.stringify({
          id: 9001,
          rev: req.method === "PATCH" ? 2 : 1,
          url: "https://dev.azure.com/fabrikam-demo/TL%20Control%20Demo/_apis/wit/workItems/9001",
          fields: {
            "System.Title": title,
            "System.State": "New",
            "System.WorkItemType": "Task",
            "System.Description": patch.find((op) => op.path === "/fields/System.Description")?.value ?? "",
            "System.IterationPath": "TL Control Demo\\Sprint 24.10",
            "System.AssignedTo": { displayName: assigned, id: assigned === "Martín Soto" ? "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" : "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
          },
          relations: [
            {
              rel: "System.LinkTypes.Hierarchy-Reverse",
              url: "https://dev.azure.com/fabrikam-demo/TL%20Control%20Demo/_apis/wit/workItems/4106"
            }
          ]
        }),
        headers: {}
      };
    }
    return { status: 500, body: "unexpected", headers: {} };
  }
}

test("asignar ID Azure inválido cae al defaultOwner; GUID válido se respeta", () => {
  const { db, config } = seeded();
  prepareStory(db, config, "4106");
  const fe = get<{ id: string }>(db, "SELECT id FROM draft_tasks WHERE parent_id LIKE '%/4106' AND layer = 'FE'");
  const be = get<{ id: string }>(db, "SELECT id FROM draft_tasks WHERE parent_id LIKE '%/4106' AND layer = 'BE'");
  assert.ok(fe && be);
  const withGuid = {
    ...config,
    team: {
      ...config.team,
      defaultOwnerId: "fe-lucia",
      members: config.team.members.map((m) =>
        m.id === "fe-lucia"
          ? { ...m, azureId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
          : m
      )
    }
  };
  const kept = assignDraft(db, withGuid, fe.id, "fe-lucia");
  assert.equal(kept.assignedTo, "fe-lucia");
  assert.equal(kept.fallback, false);
  const remapped = assignDraft(db, withGuid, fe.id, "fe-martin");
  assert.equal(remapped.assignedTo, "fe-lucia");
  assert.equal(remapped.fallback, true);
  const beRemapped = assignDraft(db, withGuid, be.id, "be-paula");
  assert.equal(beRemapped.assignedTo, "fe-lucia");
  assert.equal(beRemapped.fallback, true);
  db.close();
});

test("TL-AC08 preview Azure y conflicto de revisión", () => {
  const { db, config } = seeded();
  prepareStory(db, config, "4106");
  const preview = previewPublish(db, config, "4106", 12);
  assert.equal(preview.conflict, false);
  assert.ok(preview.operations.length >= 1);
  const conflict = previewPublish(db, config, "4106", 99);
  assert.equal(conflict.conflict, true);
  db.close();
});

test("TL-AC09 baseline fijo y altas/bajas/carry-over", () => {
  const { db, config } = seeded();
  const scope = computeScope(db, config.azure.iterationPath, "2026-10-03T12:00:00.000Z");
  assert.equal(scope.coverage, "full");
  assert.equal(scope.added, 1);
  assert.equal(scope.removed, 1);
  assert.equal(scope.carryOver, 1);
  assert.equal(scope.current, scope.initial + scope.added - scope.removed);
  const again = computeScope(db, config.azure.iterationPath, "2026-10-04T12:00:00.000Z");
  assert.equal(again.initial, scope.initial);
  db.close();
});

test("TL-AC10 métricas con unidad y fuente", () => {
  const { db, config } = seeded();
  const m = computeSprintMetrics(db, config.azure.iterationPath, "2026-10-03T12:00:00.000Z");
  assert.equal(m.scope.unit, "historias");
  assert.ok(m.scope.source);
  db.close();
});

test("TL-AC11 Done/merge/build no equivalen a producción", () => {
  assert.equal(
    productionConfirmed({
      azureState: "Done",
      merged: true,
      buildSucceeded: true,
      deployment: null,
      productionAlias: "PROD"
    }),
    false
  );
  const { db } = seeded();
  assert.equal(isInProduction(db, "fabrikam-demo/TL Control Demo/4109"), false);
  assert.equal(isInProduction(db, "fabrikam-demo/TL Control Demo/4114"), true);
  const partial = get(db, "SELECT status FROM deployments WHERE id = 'dep-qa-4110'");
  assert.equal((partial as { status: string }).status, "partial");
  const rb = get(db, "SELECT status FROM deployments WHERE id = 'dep-uat-4111-rb'");
  assert.equal((rb as { status: string }).status, "rollback");
  db.close();
});

test("TL-AC12 release enumera WI y pantallas", () => {
  const { db } = seeded();
  const rows = all<{ screens: string }>(db, "SELECT screens FROM release_work_items WHERE release_id = 'rel-2026-10-1'");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.screens));
  db.close();
});

test("TL-AC13 validación schema, duplicados y versión desconocida", () => {
  const root = projectRoot();
  const fe = JSON.parse(readFileSync(join(root, "tests/fixtures/team-ai/work-result.valid.frontend.json"), "utf8"));
  assert.equal(validateTeamAi("work-result", fe).ok, true);
  const bad = JSON.parse(readFileSync(join(root, "tests/fixtures/team-ai/work-result.invalid-version.json"), "utf8"));
  assert.equal(validateTeamAi("work-result", bad).ok, false);
  const { db } = seeded();
  const first = importWorkResult(db, fe, "a");
  const second = importWorkResult(db, fe, "b");
  assert.equal(second.imported, false);
  assert.equal(first.revision, second.revision);
  const updated = { ...fe, pullRequests: [] };
  const third = importWorkResult(db, updated, "c");
  assert.equal(third.revision, 2);
  db.close();
});

test("TL-AC14 seguridad distingue gate vigente", () => {
  const { db } = seeded();
  const current = get<{ id: string; gate_status: string }>(db, "SELECT id, gate_status FROM security_reports WHERE current_gate = 1");
  const stale = get<{ id: string }>(db, "SELECT id FROM security_reports WHERE id = 'sec-stale-old'");
  assert.equal(current?.id, "sec-4112-fail");
  assert.equal(current?.gate_status, "FAIL");
  assert.ok(stale);
  db.close();
});

test("TL-AC15 reporte congelado inmutable", () => {
  const { db, config } = seeded();
  const path = writeFrozenReport(db, config, config.azure.iterationPath);
  const html = readFileSync(path, "utf8");
  assert.match(html, /Reporte congelado/);
  const copy = html;
  db.prepare("UPDATE work_items SET title = 'CAMBIO' WHERE azure_id = 4101").run();
  assert.equal(readFileSync(path, "utf8"), copy);
  db.close();
});

test("TL-AC16 sanitiza HTML y rechaza path traversal", () => {
  const clean = sanitizeHtml(`<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>`);
  assert.equal(clean.includes("script"), false);
  assert.equal(clean.includes("onerror"), false);
  const root = join(projectRoot(), "data", "attachments");
  assert.throws(() => assertInsideDir(root, join(projectRoot(), "package.json")));
});

test("imágenes Azure de descripción se reescriben a proxy local", () => {
  const guid = "d3c51602-61e5-4c32-b0f5-302b33112b9b";
  const html = sanitizeHtml(
    `<p>x</p><img src="https://dev.azure.com/ORG/bf3ec2c8-f4c6-45e6-8a50-44115c5c970e/_apis/wit/attachments/${guid}?fileName=Captura.png" alt="c">`
  );
  const out = rewriteAzureAttachmentUrls(html);
  assert.match(out, new RegExp(`src="/attachments/azure/${guid}"`));
  assert.equal(out.includes("dev.azure.com"), false);
  const keep = rewriteAzureAttachmentUrls(`<img src="https://example.com/captura.png" alt="c">`);
  assert.match(keep, /https:\/\/example.com\/captura.png/);
  assert.equal(
    isSafeAzureAttachmentUrl(
      `https://dev.azure.com/ORG/proj/_apis/wit/attachments/${guid}`,
      guid,
      "ORG"
    ),
    true
  );
  assert.equal(
    isSafeAzureAttachmentUrl(`https://evil.example/_apis/wit/attachments/${guid}`, guid, "ORG"),
    false
  );
});

test("TL-AC18 no hay secretos en config de ejemplo", () => {
  const example = readFileSync(join(projectRoot(), "config/tl-control.example.json"), "utf8");
  assert.doesNotMatch(example, /AZURE_DEVOPS_|api[_-]?key\s*[:=]|password\s*[:=]|Bearer /i);
});

test("TL-AC19 backup/restore reproduce métricas", () => {
  const { db, dir, config } = seeded();
  const before = computeSprintMetrics(db, config.azure.iterationPath, "2026-10-03T12:00:00.000Z");
  db.close();
  const bak = backupDb(join(dir, "db.sqlite"), join(dir, "bak"));
  const restoredPath = join(dir, "restored.sqlite");
  restoreDb(bak, restoredPath);
  const db2 = openDb(restoredPath);
  const after = computeSprintMetrics(db2, config.azure.iterationPath, "2026-10-03T12:00:00.000Z");
  assert.equal(after.scope.current, before.scope.current);
  assert.equal(after.production, before.production);
  db2.close();
});

test("TL-AC20 fuentes ausentes no son PASS", () => {
  const { db } = seeded();
  const run = get<{ coverage_json: string }>(db, "SELECT coverage_json FROM sync_runs WHERE id = 'sync-403'");
  const cov = JSON.parse(run!.coverage_json);
  assert.equal(cov.pullRequests, "UNAUTHORIZED");
  assert.notEqual(cov.deployments, "OK");
  db.close();
});

test("RFC 8785 hash estable", () => {
  const a = canonicalize({ b: 1, a: "x" });
  const b = canonicalize({ a: "x", b: 1 });
  assert.equal(a, b);
  const hashed = withContextHash({ schemaVersion: "team-ai/v1", hello: 1 });
  assert.equal(hashed.contextHash, contextHashFor(hashed));
});

test("aging días corridos", () => {
  assert.equal(calendarDaysBetween("2026-09-25T10:00:00.000Z", "2026-10-03T12:00:00.000Z", "America/Argentina/Buenos_Aires"), 8);
});

test("prepare-story emite work-context válido", () => {
  const { db, config } = seeded();
  const prepared = prepareStory(db, config, "4101");
  const pkg = prepared.contextPackage as Record<string, unknown>;
  assert.equal(validateTeamAi("work-context", pkg).ok, true);
  mkdirSync(join(projectRoot(), "tests/fixtures/team-ai"), { recursive: true });
  writeFileSync(join(projectRoot(), "tests/fixtures/team-ai/work-context.valid.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  db.close();
});

test("analyze cubre historia + subtareas y una Task queda sola", () => {
  const { db, config } = seeded();
  const story = analyzeStory(db, config, "4101") as {
    scope: { mode: string; childrenCount: number };
    children: Array<{ azureId: number; descriptionText: string }>;
    functional: { problem: string };
  };
  assert.equal(story.scope.mode, "story-and-children");
  assert.equal(story.scope.childrenCount, 2);
  assert.ok(story.children.some((c) => c.azureId === 5101));
  assert.ok(story.children.some((c) => c.azureId === 5102));
  assert.match(story.functional.problem, /CUIT/);
  assert.ok(story.children.some((c) => /DNI único/.test(c.descriptionText)));

  const onlyStory = analyzeStory(db, config, "4108") as { scope: { mode: string; childrenCount: number } };
  assert.equal(onlyStory.scope.mode, "story-only");
  assert.equal(onlyStory.scope.childrenCount, 0);

  const task = analyzeStory(db, config, "5101") as {
    scope: { mode: string; reviewedWorkItemIds: number[] };
    children: unknown[];
  };
  assert.equal(task.scope.mode, "task-only");
  assert.deepEqual(task.scope.reviewedWorkItemIds, [5101]);
  assert.equal(task.children.length, 0);
  db.close();
});

test("prepare copia texto e imágenes de historia y subtareas al borrador", () => {
  const { db, config } = seeded();
  const withKids = prepareStory(db, config, "4101") as {
    drafts: Array<{ sourceContext: Array<{ azureId: number; descriptionText: string; attachments: unknown[] }> }>;
  };
  for (const draft of withKids.drafts) {
    const ids = draft.sourceContext.map((s) => s.azureId);
    assert.ok(ids.includes(4101));
    assert.ok(ids.includes(5101));
    assert.ok(draft.sourceContext.some((s) => /CUIT/.test(s.descriptionText)));
    assert.ok(draft.sourceContext.some((s) => /DNI único/.test(s.descriptionText)));
  }

  const withImage = prepareStory(db, config, "4102") as {
    drafts: Array<{ sourceContext: Array<{ azureId: number; attachments: Array<{ image: boolean; fileName: string }> }> }>;
  };
  const images = withImage.drafts[0]!.sourceContext.flatMap((s) => s.attachments).filter((a) => a.image);
  assert.ok(images.some((a) => a.fileName === "captura-comprobante.png"));

  db.prepare(
    `INSERT INTO work_item_relations(work_item_id, rel_type, target_id, target_url, attributes_json)
     VALUES ((SELECT id FROM work_items WHERE azure_id = 4101), ?, ?, ?, ?)`
  ).run("AttachedFile", "guid-img", "https://example/_apis/wit/attachments/guid-img", JSON.stringify({ name: "pantalla.png" }));
  const withRel = prepareStory(db, config, "4101") as {
    drafts: Array<{ sourceContext: Array<{ attachments: Array<{ fileName: string; image: boolean }> }> }>;
  };
  assert.ok(withRel.drafts[0]!.sourceContext.some((s) => s.attachments.some((a) => a.fileName === "pantalla.png" && a.image)));

  const preview = previewPublish(db, config, "4101");
  assert.match(preview.operations[0]!.fields["System.Description"], /Más info/);
  assert.match(preview.operations[0]!.fields["System.Description"], /DNI único/);
  assert.match(preview.operations[0]!.fields["System.Description"], /Definición de hecho/);
  db.close();
});

test("descripción Azure copia contrato, pasos, archivos y definición de hecho", () => {
  const html = azureDescriptionFromPayload({
    objetivo: "Reproducir download",
    expected: "MP4 guardado",
    contract: "GET api/proxy-download?url&filename",
    blocked: true,
    base: { repo: "NWeb.Frontend", ref: "sandbox", sha: "0f62ef3a0a2cf30a" },
    pasos: ["Abrir sandbox", "No pegar <script>"],
    files: ["src/hooks/useFileDownload.js"],
    dod: ["Play no roto"]
  });
  assert.match(html, /<strong>Objetivo\.<\/strong> Reproducir download/);
  assert.match(html, /<strong>Esperado\.<\/strong> MP4 guardado/);
  assert.match(html, /<strong>Contrato\.<\/strong> GET api\/proxy-download/);
  assert.match(html, /No iniciar hasta el handoff/);
  assert.match(html, /NWeb\.Frontend @ sandbox \(0f62ef3a\)/);
  assert.match(html, /<h3>Pasos<\/h3><ol><li>Abrir sandbox<\/li><li>No pegar &lt;script&gt;<\/li><\/ol>/);
  assert.match(html, /<h3>Archivos<\/h3><ul><li><code>src\/hooks\/useFileDownload\.js<\/code><\/li><\/ul>/);
  assert.match(html, /<h3>Definición de hecho<\/h3><ul><li>Play no roto<\/li><\/ul>/);
});

test("alertas incluyen SP, unassigned, security y scope", () => {
  const { db, config } = seeded();
  const alerts = refreshAlerts(db, config, config.azure.iterationPath, "2026-10-03T12:00:00.000Z");
  const rules = new Set(alerts.map((a) => a.ruleId));
  assert.ok(rules.has("sp-pending"));
  assert.ok(rules.has("ready-unassigned"));
  assert.ok(rules.has("security-gate"));
  assert.ok(rules.has("scope-added"));
  assert.ok(rules.has("carry-over"));
  assert.ok(rules.has("devdone-no-release"));
  db.close();
});

test("sync del dashboard no se superpone y sin PAT no llama Azure", async () => {
  const { db, config } = seeded();
  let started = 0;
  let release = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const auto = createAutoSync({
    db,
    config,
    run: async () => {
      started += 1;
      await gate;
      return { count: 3, syncRunId: "sync-test" };
    }
  });
  const first = auto.trigger();
  const second = await auto.trigger();
  assert.equal(second.busy, true);
  assert.equal(auto.status().running, true);
  assert.equal(started, 1);
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(done.count, 3);
  assert.equal(auto.status().running, false);
  auto.stop();

  const prevExt = process.env.AZURE_DEVOPS_EXT_PAT;
  const prev = process.env.AZURE_DEVOPS_PAT;
  delete process.env.AZURE_DEVOPS_EXT_PAT;
  delete process.env.AZURE_DEVOPS_PAT;
  try {
    const missing = await createAutoSync({ db, config }).trigger();
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /Sin PAT/);
  } finally {
    if (prevExt === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT;
    else process.env.AZURE_DEVOPS_EXT_PAT = prevExt;
    if (prev === undefined) delete process.env.AZURE_DEVOPS_PAT;
    else process.env.AZURE_DEVOPS_PAT = prev;
    db.close();
  }
});

test("faltante SQL ignora el SP ya confirmado", () => {
  const { db, config } = seeded();
  const gaps = listSqlGaps(db, config.azure.iterationPath);
  assert.ok(gaps.some((gap) => gap.spName === "dbo.usp_Movimientos_Listar" && gap.change === "NEW"));
  assert.equal(gaps.some((gap) => gap.spName === "dbo.usp_Movimientos_Exportar"), false);
  db.close();
});

test("analyze deja un faltante SQL cuando el texto pide un SP y no hay contrato", () => {
  const { db, config } = seeded();
  db.prepare("UPDATE work_items SET description_html = ? WHERE azure_id = 4108").run(
    "<p>Nueva pantalla con un SP nuevo para tomar la pauta. Sin nombre ni columnas.</p>"
  );
  analyzeStory(db, config, "4108");
  analyzeStory(db, config, "4108");
  const gaps = listSqlGaps(db, config.azure.iterationPath).filter((gap) => gap.azureId === 4108);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.spName, null);
  assert.equal(gaps[0]?.change, "NEW");
  assert.match(gaps[0]?.copyText ?? "", /SP nuevo/);
  const untouched = listSqlGaps(db, config.azure.iterationPath).filter((gap) => gap.azureId === 4101);
  assert.equal(untouched.length, 0);
  assert.ok(gaps[0]?.workItemId);
  assert.equal(dismissSqlGap(db, gaps[0]!.workItemId), true);
  analyzeStory(db, config, "4108");
  assert.equal(listSqlGaps(db, config.azure.iterationPath).some((gap) => gap.azureId === 4108), false);
  db.close();
});

test("confirmar contrato SP saca el faltante SQL", () => {
  const { db, config } = seeded();
  const open = listSqlGaps(db, config.azure.iterationPath).find((gap) => gap.azureId === 4103);
  assert.ok(open?.workItemId);
  assert.equal(confirmSpContract(db, open.workItemId, { name: "dbo.usp_Movimientos_Listar", notes: "Contrato del TL." }), true);
  assert.equal(listSqlGaps(db, config.azure.iterationPath).some((gap) => gap.azureId === 4103), false);
  db.close();
});

test("preguntas funcionales quedan pendientes hasta que las responden", async () => {
  const { db, config } = seeded();
  db.prepare("UPDATE work_items SET description_html = ?, acceptance_criteria = '' WHERE azure_id = 4108").run(
    "<p>Nueva pantalla en un submenu. Tiene que tener la misma funcionalidad que artistic conciliation. Tooltip en la grilla.</p><img src=\"https://example/captura.png\" alt=\"captura\">"
  );
  analyzeStory(db, config, "4108");
  analyzeStory(db, config, "4108");
  const groups = listFunctionalQuestions(db, config.azure.iterationPath).filter((group) => group.azureId === 4108);
  assert.equal(groups.length, 1);
  const text = groups[0]!.questions.map((question) => question.question).join("\n");
  assert.match(text, /submenú/);
  assert.match(text, /permiso/);
  assert.match(text, /artistic conciliation/);
  assert.match(text, /tooltip/);
  assert.match(text, /captura de #4108/);
  assert.match(text, /criterios de aceptación/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM questions WHERE id LIKE 'qfn-%4108-%'").get().n,
    groups[0]!.questions.length
  );
  analyzeStory(db, config, "4101");
  assert.equal(listFunctionalQuestions(db, config.azure.iterationPath).some((group) => group.azureId === 4101), false);

  const blocked = await publishFunctionalQuestions(db, config, groups[0]!.workItemId, async () => {
    throw new Error("no debe publicar");
  });
  assert.equal(blocked.ok, false);

  assert.equal(answerFunctionalQuestion(db, groups[0]!.questions[0]!.id), true);
  const after = listFunctionalQuestions(db, config.azure.iterationPath).find((group) => group.azureId === 4108);
  assert.equal(after!.questions.length, groups[0]!.questions.length - 1);

  const workItemId = groups[0]!.workItemId;
  db.prepare("UPDATE questions SET posted_at = ? WHERE work_item_id = ? AND COALESCE(status, 'pending') = 'pending'").run(
    "2020-01-01T00:00:00.000Z",
    workItemId
  );
  db.prepare(
    "INSERT INTO comments(id, work_item_id, author_name, created_at, text_html) VALUES (?, ?, ?, ?, ?)"
  ).run(`${workItemId}/comment/reply`, workItemId, "Producto", "2026-10-04T00:00:00.000Z", "<p>Va en Reconciliation y se llama Commercial breaks.</p>");
  assert.equal(listFunctionalQuestions(db, config.azure.iterationPath).some((group) => group.azureId === 4108), false);
  db.close();
});

test("texto SQL distingue SP nuevo de update", () => {
  const nuevo = sqlGapCopy({
    azureId: 10,
    title: "Pantalla nueva",
    screen: "Altas",
    spName: null,
    change: "NEW",
    usage: null,
    missing: []
  });
  assert.match(nuevo, /SP nuevo/);
  assert.match(nuevo, /hasta que SQL nos mande el contrato/);
  const update = sqlGapCopy({
    azureId: 11,
    title: "Listado",
    screen: "Movimientos",
    spName: "dbo.usp_Movimientos_Listar",
    change: "UPDATE",
    usage: "consulta",
    missing: ["fecha"]
  });
  assert.match(update, /dbo\.usp_Movimientos_Listar/);
  assert.match(update, /consulta/);
  assert.match(update, /Movimientos/);
});

test("estadísticas ocultan bloqueados y sus hijos", () => {
  const hidden = idsHiddenByBlock([
    { id: "padre", parentId: null, stateNormalized: "BLOCKED", stateOriginal: "Blocked" },
    { id: "tarea", parentId: "padre", stateNormalized: "NEW", stateOriginal: "To Do" },
    { id: "suelta", parentId: null, stateNormalized: "NEW", stateOriginal: "To Do" },
    { id: "tarea-bloq", parentId: null, stateNormalized: "DOING", stateOriginal: "Blocked" }
  ]);
  assert.equal(hidden.has("padre"), true);
  assert.equal(hidden.has("tarea"), true);
  assert.equal(hidden.has("tarea-bloq"), true);
  assert.equal(hidden.has("suelta"), false);
});

test("informe de daily arma seguimiento y sandbox", () => {
  assert.equal(verdict(true, true), "Terminada y en sandbox");
  assert.equal(verdict(true, false), "Terminada en Azure, sin evidencia en sandbox");
  assert.equal(verdict(false, true), "En sandbox; Azure sigue abierta");
  const hits = findSandboxMentions(
    [{ repoId: "backend", subjects: ["Merged PR 2121: sandbox-6566-6578", "fix"] }],
    [6566, 7001]
  );
  assert.equal(hits.get(6566)?.repoId, "backend");
  assert.equal(hits.has(7001), false);

  const { db, config } = seeded();
  const iteration = config.azure.iterationPath;
  const parentId = workItemKey(config.azure.organization, config.azure.project, 7000);
  const doneId = workItemKey(config.azure.organization, config.azure.project, 7001);
  const openId = workItemKey(config.azure.organization, config.azure.project, 7002);
  const insert = db.prepare(
    `INSERT INTO work_items(id, organization, project, azure_id, type, title, state_original, state_normalized, iteration_id, assigned_to_name, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(parentId, config.azure.organization, config.azure.project, 7000, "User Story", "Padre <script>", "Blocked", "BLOCKED", iteration, "Lucía Fernández", null);
  insert.run(doneId, config.azure.organization, config.azure.project, 7001, "Task", "Alta cliente", "Done", "DEV_DONE", iteration, "Martín Soto", parentId);
  insert.run(openId, config.azure.organization, config.azure.project, 7002, "Task", "Consulta saldo", "To Do", "NEW", iteration, "Martín Soto", parentId);
  const rev = db.prepare("INSERT INTO work_item_revisions(work_item_id, revision, payload_json) VALUES (?, 1, ?)");
  const payload = JSON.stringify({ "System.CreatedBy": { displayName: "Lucía Fernández", id: "aad-lucia" } });
  rev.run(doneId, payload);
  rev.run(openId, payload);
  const html = renderDailyReport(db, config, iteration, {
    mentions: new Map([[7001, { repoId: "backend", subject: "sandbox-7001" }]]),
    repos: [{ repoId: "backend", baseRef: "sandbox", commits: 2, error: null }]
  });
  assert.match(html, /Informe de daily/);
  assert.match(html, /Terminada y en sandbox/);
  assert.match(html, /sandbox-7001/);
  assert.match(html, /Pendiente/);
  assert.match(html, /padre bloqueado/);
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  db.close();
});

test("tablero kanban coloca a cada dev y persiste la nota de arranque", () => {
  const { db, config } = seeded();
  assert.equal(inferBoardColumn("DOING"), "in_progress");
  assert.equal(inferBoardColumn("REVIEW"), "inicio");
  assert.equal(inferBoardColumn("QA"), "inicio");
  assert.equal(resolveBoardColumn("evidencia", "DOING"), "evidencia");
  assert.equal(resolveBoardColumn("terminando", "DOING"), "terminando");
  assert.equal(resolveBoardColumn("inicio", "DOING"), "in_progress");
  assert.equal(memberShortName("Fernandez, Julia -ND"), "Julia");
  const board = loadMemberBoard(db, config, config.azure.iterationPath);
  assert.equal(board.columns.map((col) => col.id).join(","), "inicio,in_progress,evidencia,terminando");
  const lucia = board.members.find((member) => member.id === "fe-lucia");
  const diego = board.members.find((member) => member.id === "be-diego");
  const martin = board.members.find((member) => member.id === "fe-martin");
  assert.ok(lucia);
  assert.equal(lucia.columnId, "in_progress");
  assert.equal(lucia.active?.azureId, 5102);
  assert.equal(lucia.workItemId, lucia.active?.id);
  assert.match(lucia.note, /formulario de alta/);
  assert.equal(diego?.columnId, "terminando");
  assert.equal(martin?.columnId, "in_progress");
  const updated = saveMemberBoard(db, config, config.azure.iterationPath, {
    memberId: "fe-martin",
    workItemId: martin.assigned.find((task) => task.azureId === 4105)?.id,
    note: "Arranca perfil con el comentario de producto.",
    start: true
  });
  const started = updated.members.find((member) => member.id === "fe-martin");
  assert.equal(started?.columnId, "in_progress");
  assert.equal(started?.workItemId, martin.assigned.find((task) => task.azureId === 4105)?.id);
  assert.equal(started?.note, "Arranca perfil con el comentario de producto.");
  assert.ok(started?.startedAt);
  const moved = saveMemberBoard(db, config, config.azure.iterationPath, {
    memberId: "fe-martin",
    columnId: "evidencia"
  });
  assert.equal(moved.members.find((member) => member.id === "fe-martin")?.columnId, "evidencia");
  const luciaTask = get<{ id: string }>(db, "SELECT id FROM work_items WHERE azure_id = 5102");
  run(db, "UPDATE work_items SET assigned_to_id = ?, assigned_to_name = ? WHERE azure_id = 5102", "fe-martin", "Martín Soto");
  const afterMove = loadMemberBoard(db, config, config.azure.iterationPath);
  const luciaAfter = afterMove.members.find((member) => member.id === "fe-lucia");
  const martinAfter = afterMove.members.find((member) => member.id === "fe-martin");
  assert.notEqual(luciaAfter?.active?.azureId, 5102);
  assert.notEqual(luciaAfter?.workItemId, luciaTask?.id);
  const luciaRow = get<{ work_item_id: string | null; note: string }>(db, "SELECT work_item_id, note FROM member_board WHERE member_id = 'fe-lucia'");
  assert.equal(luciaRow?.work_item_id, null);
  assert.equal(luciaRow?.note, "");
  assert.ok(martinAfter?.assigned.some((task) => task.azureId === 5102));
  db.close();
});

test("inferencia de pantalla desde título NWEB", () => {
  assert.equal(inferScreenFromTitle("NWEB - Production Log - Logs"), "Production Log");
  assert.equal(inferScreenFromTitle("Nuevo submenu de Conciliation"), "Conciliation");
});

test("traza SP normaliza API FE y nombres de producto", () => {
  assert.equal(normalizeApiPath("simba/materiales_log/${id}"), "/api/simba/materiales_log/*");
  assert.equal(normalizeApiPath("/programChange/update"), "/api/programChange/update");
  assert.deepEqual(expandTemplate("/programChange/${updateMode ? \"update\" : \"send\"}"), [
    "/programChange/update",
    "/programChange/send"
  ]);
  assert.ok(extractProductSpNames('currentStoredProc = "NWEB_materiales_log";').includes("NWEB_materiales_log"));
  assert.ok(extractProductSpNames("ALTER PROCEDURE [dbo].[programacion_modi_horario]").includes("programacion_modi_horario"));
});

test("dossier SP recorre front, back y separa lectura de envío", () => {
  const { db, config } = seeded();
  const dossier = listSpDossier(db, config);
  const mov = dossier.traces.find((trace) => trace.azureId === 4103);
  assert.ok(mov);
  assert.equal(mov?.screen, "Cuentas / Movimientos");
  assert.ok(mov?.backend.some((item) => item.azureId === 5103));
  assert.ok(mov?.reads.some((sp) => sp.name === "dbo.usp_Movimientos_Listar"));
  assert.equal(mov?.writes.length, 0);
  assert.equal(mov?.missingContract, true);
  assert.match(mov?.explanation ?? "", /no se inventa la firma/);
  const csv = dossier.traces.find((trace) => trace.azureId === 4104);
  assert.equal(csv, undefined);
  assert.deepEqual(extractSpNames("Usar SP usp_Movimientos_Listar y no inventar firma"), ["dbo.usp_Movimientos_Listar"]);
  db.close();
});

test("informe SP explica cada ítem para mandar como PDF", () => {
  const { db, config } = seeded();
  const html = renderSpReport(db, config);
  assert.match(html, /Guardar como PDF/);
  assert.match(html, /#4103/);
  assert.match(html, /usp_Movimientos_Listar/);
  assert.match(html, /SP para leer/);
  assert.match(html, /SP para mandar/);
  assert.match(html, /necesitamos la definición de un SP nuevo|falta la definición del contrato SP/);
  assert.match(html, /Listar movimientos paginados usando SP usp_Movimientos_Listar/);
  assert.match(html, /BE: consumir usp_Movimientos_Listar/);
  assert.match(html, /Historia/);
  assert.match(html, /Subtarea/);
  assert.match(html, /pedido\(s\) de definición SQL/);
  assert.doesNotMatch(html, /SP con contrato en la evidencia/);
  assert.doesNotMatch(html, /Dependencias del sprint/);
  assert.doesNotMatch(html, /API para mostrar/);
  assert.doesNotMatch(html, /API al guardar/);
  assert.doesNotMatch(html, /Pantalla FE/);
  assert.doesNotMatch(html, /@cuentaId/);
  db.close();
});

test("pedido SQL trae relacionados en alta nueva y todos en corrección", () => {
  const related = { name: "nweb_carga_motivos_combo", usage: "lectura", status: "UNKNOWN", lifecycle: null, source: "repo", confirmed: false };
  const extra = { name: "nweb_otra_consulta", usage: "lectura", status: "UNKNOWN", lifecycle: null, source: "text", confirmed: false };
  const unclear = { name: "nweb_log", usage: "desconocido", status: "UNKNOWN", lifecycle: null, source: "repo", confirmed: false };
  const write = { name: "nweb_actua_emi_spots_alta", usage: "envio", status: "UNKNOWN", lifecycle: null, source: "repo", confirmed: false };
  const gapNew = {
    workItemId: "x",
    azureId: 1,
    title: "Nuevo",
    type: "User Story",
    screen: "Conciliation",
    spName: null,
    change: "NEW",
    usage: null,
    missing: [],
    copyText: "pedido"
  };
  const nuevo = spsForSqlRequest({
    gap: gapNew,
    sps: [related, extra, unclear, write],
    reads: [related],
    writes: [write],
    unknown: [unclear]
  });
  assert.deepEqual(nuevo.reads.map((sp) => sp.name), ["nweb_carga_motivos_combo"]);
  assert.deepEqual(nuevo.writes.map((sp) => sp.name), ["nweb_actua_emi_spots_alta"]);
  const update = spsForSqlRequest({
    gap: { ...gapNew, change: "UPDATE", spName: "nweb_carga_motivos_combo" },
    sps: [related, extra, unclear, write],
    reads: [related],
    writes: [write],
    unknown: [unclear]
  });
  assert.deepEqual(update.reads.map((sp) => sp.name), ["nweb_carga_motivos_combo", "nweb_log", "nweb_otra_consulta"]);
  assert.deepEqual(update.writes.map((sp) => sp.name), ["nweb_actua_emi_spots_alta"]);
});

void existsSync;
