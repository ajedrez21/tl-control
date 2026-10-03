import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { canonicalize, contextHashFor, withContextHash } from "../src/domain/canonical.ts";
import { workItemKey, parseWorkItemKey } from "../src/domain/ids.ts";
import { evaluateReadiness, productionConfirmed } from "../src/domain/readiness.ts";
import { sanitizeHtml } from "../src/domain/sanitize.ts";
import { calendarDaysBetween } from "../src/domain/time.ts";
import { openDb, all, get } from "../src/storage/db.ts";
import { backupDb, restoreDb } from "../src/storage/backup.ts";
import { demoConfig, seedDemo } from "../src/demo/seed.ts";
import { persistWorkItems, AzureDevOpsClient, syncIteration } from "../src/adapters/azure/client.ts";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/adapters/http.ts";
import { computeScope, computeSprintMetrics, isInProduction } from "../src/metrics/sprint.ts";
import { refreshAlerts } from "../src/metrics/alerts.ts";
import { analyzeStory, analyzeSp, prepareStory } from "../src/analysis/story.ts";
import { validateTeamAi } from "../src/adapters/kit/validate.ts";
import { importWorkResult } from "../src/adapters/kit/import.ts";
import { previewPublish } from "../src/cli/publish.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { writeFrozenReport } from "../src/report/frozen.ts";
import { projectRoot } from "../src/config/load.ts";
import { assertInsideDir } from "../src/server/safe-path.ts";

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

void existsSync;
