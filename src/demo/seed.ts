import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AppConfig } from "../config/types.ts";
import type { Db } from "../storage/db.ts";
import { withTransaction, setMeta, run } from "../storage/db.ts";
import { workItemKey } from "../domain/ids.ts";
import { normalizeState } from "../domain/states.ts";
import { importWorkResult } from "../adapters/kit/import.ts";
import { importSecurityReport } from "../adapters/security/import.ts";
import { projectRoot } from "../config/load.ts";

const ORG = "fabrikam-demo";
const PROJECT = "TL Control Demo";
const ITER = `${PROJECT}\\Sprint 24.10`;
const PREV = `${PROJECT}\\Sprint 24.09`;
const TZ = "America/Argentina/Buenos_Aires";

function idOf(azureId: number): string {
  return workItemKey(ORG, PROJECT, azureId);
}

function png(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
}

export function demoConfig(): AppConfig {
  return {
    timezone: TZ,
    agingUnit: "calendar-days",
    azure: {
      organization: ORG,
      project: PROJECT,
      process: "Agile",
      apiVersion: "7.1",
      areaPath: PROJECT,
      iterationPath: ITER,
      team: "Equipo Demo",
      workItemTypes: {
        story: "User Story",
        task: "Task",
        bug: "Bug",
        feature: "Feature"
      },
      fieldMap: {
        acceptanceCriteria: "Microsoft.VSTS.Common.AcceptanceCriteria",
        priority: "Microsoft.VSTS.Common.Priority",
        effort: "Microsoft.VSTS.Scheduling.StoryPoints"
      },
      stateMapping: {
        New: "NEW",
        Active: "DOING",
        Resolved: "DEV_DONE",
        Ready: "READY",
        Blocked: "BLOCKED",
        "Code Review": "REVIEW",
        QA: "QA",
        UAT: "UAT",
        Done: "DEV_DONE",
        Closed: "DEV_DONE",
        Removed: "REMOVED"
      },
      writes: { enabled: false }
    },
    team: {
      members: [
        { id: "fe-lucia", azureId: "aad-lucia", displayName: "Lucía Fernández", role: "frontend" },
        { id: "fe-martin", azureId: "aad-martin", displayName: "Martín Soto", role: "frontend" },
        { id: "be-paula", azureId: "aad-paula", displayName: "Paula Ruiz", role: "backend" },
        { id: "be-diego", azureId: "aad-diego", displayName: "Diego Álvarez", role: "backend" },
        { id: "be-sofia", azureId: "aad-sofia", displayName: "Sofía Benítez", role: "backend" }
      ]
    },
    repositories: [
      { repoId: "frontend", role: "frontend", localPath: "", baseRef: "main", analysisCommand: "" },
      { repoId: "backend", role: "backend", localPath: "", baseRef: "main", analysisCommand: "" }
    ],
    environments: {
      qa: { alias: "QA", azureEnv: "qa" },
      uat: { alias: "UAT", azureEnv: "uat" },
      production: { alias: "PROD", azureEnv: "production" }
    },
    alerts: { spPendingDays: 3, prOpenDays: 2, wipLimit: 2 },
    readiness: {
      requireConfirmedSpContract: true,
      requireAcceptanceCriteria: true,
      blockOnUnknownSp: true
    },
    server: { host: "127.0.0.1", port: 4780 },
    paths: { dataDir: "data", reportsDir: "reports" }
  };
}

export function seedDemo(db: Db, dataDir: string): void {
  const config = demoConfig();
  const now = "2026-10-03T12:00:00.000Z";
  const syncRunId = "sync-demo-001";
  mkdirSync(join(dataDir, "attachments"), { recursive: true });

  withTransaction(db, () => {
    db.exec(`
      DELETE FROM questions; DELETE FROM alerts; DELETE FROM findings;
      DELETE FROM security_reports; DELETE FROM workflow_results;
      DELETE FROM deployments; DELETE FROM release_work_items;
      DELETE FROM release_components; DELETE FROM release_packages;
      DELETE FROM dependency_intervals; DELETE FROM dependencies; DELETE FROM contracts;
      DELETE FROM draft_tasks; DELETE FROM context_packages; DELETE FROM analyses;
      DELETE FROM evidence; DELETE FROM attachments; DELETE FROM comments;
      DELETE FROM work_item_relations; DELETE FROM work_item_revisions;
      DELETE FROM scope_events; DELETE FROM sprint_baselines; DELETE FROM snapshots;
      DELETE FROM pull_requests; DELETE FROM work_items; DELETE FROM tl_notes;
      DELETE FROM sync_runs; DELETE FROM repositories; DELETE FROM members;
      DELETE FROM iterations; DELETE FROM projects; DELETE FROM audit_log;
    `);

    run(db, "INSERT INTO projects(id, organization, project, process_type, created_at) VALUES (?, ?, ?, ?, ?)", `${ORG}/${PROJECT}`, ORG, PROJECT, "Agile", now);
    run(db, "INSERT INTO iterations(id, project_id, azure_path, name, start_date, finish_date, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)", ITER, `${ORG}/${PROJECT}`, ITER, "Sprint 24.10", "2026-09-28", "2026-10-09", TZ);
    run(db, "INSERT INTO iterations(id, project_id, azure_path, name, start_date, finish_date, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)", PREV, `${ORG}/${PROJECT}`, PREV, "Sprint 24.09", "2026-09-14", "2026-09-25", TZ);

    for (const m of config.team.members) {
      run(db, "INSERT INTO members(id, azure_id, display_name, role) VALUES (?, ?, ?, ?)", m.id, m.azureId, m.displayName, m.role);
    }
    run(db, "INSERT INTO repositories(id, role, local_path, base_ref, last_analyzed_sha) VALUES (?, ?, ?, ?, ?)", "frontend", "frontend", "", "main", "aaa111fe");
    run(db, "INSERT INTO repositories(id, role, local_path, base_ref, last_analyzed_sha) VALUES (?, ?, ?, ?, ?)", "backend", "backend", "", "main", "bbb222be");

    insertStory(db, {
      azureId: 4101, title: "Alta de cliente con validación fiscal",
      state: "Active", assigned: "fe-lucia", priority: 1, estimate: 5,
      screen: "Clientes / Alta", module: "Clientes",
      description: "<p>Permitir dar de alta un cliente persona jurídica con CUIT y validación AFIP.</p>",
      ac: "Dado un CUIT válido, el sistema persiste el cliente y muestra confirmación."
    });
    insertStory(db, {
      azureId: 4102, title: "Captura de comprobante desde foto",
      state: "New", assigned: null, priority: 2, estimate: 3,
      screen: "Comprobantes / Captura", module: "Comprobantes",
      description: "", ac: ""
    });
    insertStory(db, {
      azureId: 4103, title: "Listado de movimientos con saldo",
      state: "Blocked", assigned: "be-paula", priority: 1, estimate: 8,
      screen: "Cuentas / Movimientos", module: "Cuentas",
      description: "<p>Listar movimientos paginados usando SP usp_Movimientos_Listar.</p>",
      ac: "El listado muestra fecha, concepto, importe y saldo."
    });
    insertStory(db, {
      azureId: 4104, title: "Exportación CSV de movimientos",
      state: "Ready", assigned: "be-diego", priority: 2, estimate: 3,
      screen: "Cuentas / Exportar", module: "Cuentas",
      description: "<p>Exportar el resultado del listado a CSV. El SP ya tiene contrato confirmado.</p>",
      ac: "El CSV incluye las mismas columnas que la grilla."
    });
    insertStory(db, {
      azureId: 4105, title: "Edición de perfil de usuario",
      state: "Active", assigned: "fe-martin", priority: 2, estimate: 2,
      screen: "Perfil", module: "Identidad",
      description: "<p>El email NO se puede editar.</p>",
      ac: "El usuario puede cambiar nombre visible."
    });
    insertStory(db, {
      azureId: 4106, title: "Filtro de sucursales en tesorería",
      state: "Ready", assigned: null, priority: 3, estimate: 2,
      screen: "Tesorería / Filtros", module: "Tesorería",
      description: "<p>Filtrar operaciones por sucursal activa.</p>",
      ac: "Al elegir sucursal, la grilla se recarga."
    });
    insertStory(db, {
      azureId: 4107, title: "Recálculo de intereses (carry-over)",
      state: "Active", assigned: "be-sofia", priority: 1, estimate: 5,
      screen: "Préstamos / Intereses", module: "Préstamos",
      description: "<p>Historia arrastrada desde Sprint 24.09.</p>",
      ac: "El recálculo no altera cuotas ya cobradas."
    });
    insertStory(db, {
      azureId: 4108, title: "Banner de mantenimiento programado",
      state: "New", assigned: "fe-lucia", priority: 3, estimate: 1,
      screen: "Shell / Banner", module: "Shell",
      description: "<p>Pedido agregado el 2026-10-01 durante el sprint.</p>",
      ac: "El banner se oculta al vencer la ventana."
    });
    insertStory(db, {
      azureId: 4109, title: "Notificación email de débito",
      state: "Resolved", assigned: "be-diego", priority: 2, estimate: 3,
      screen: "Notificaciones", module: "Notificaciones",
      description: "<p>Enviar email al debitar. Desarrollo terminado, sin paquete de release.</p>",
      ac: "Se envía un email por débito confirmado."
    });
    insertStory(db, {
      azureId: 4110, title: "Dashboard de saldos",
      state: "QA", assigned: "fe-martin", priority: 1, estimate: 8,
      screen: "Home / Saldos", module: "Home",
      description: "<p>BE desplegado en QA; FE todavía no está en el artefacto.</p>",
      ac: "Home muestra saldo consolidado."
    });
    insertStory(db, {
      azureId: 4111, title: "Conciliación bancaria automática",
      state: "UAT", assigned: "be-paula", priority: 1, estimate: 13,
      screen: "Tesorería / Conciliación", module: "Tesorería",
      description: "<p>Hubo rollback parcial del componente de matching.</p>",
      ac: "Los movimientos conciliados quedan auditados."
    });
    insertStory(db, {
      azureId: 4112, title: "Login SSO corporativo",
      state: "Code Review", assigned: "fe-lucia", priority: 1, estimate: 5,
      screen: "Login", module: "Identidad",
      description: "<p>Integrar SSO. Gate de seguridad fallido en el último reporte.</p>",
      ac: "El usuario entra con la cuenta corporativa."
    });
    insertStory(db, {
      azureId: 4113, title: "Widget de clima (removida del sprint)",
      state: "Removed", assigned: null, priority: 4, estimate: 1,
      screen: "Home / Widget", module: "Home",
      description: "<p>Removida el 2026-09-30.</p>", ac: ""
    });
    insertStory(db, {
      azureId: 4114, title: "Consulta de CBU alias",
      state: "Done", assigned: "be-sofia", priority: 2, estimate: 2,
      screen: "Cuentas / Alias", module: "Cuentas",
      description: "<p>Consulta de alias CBU. Deploy PROD confirmado.</p>",
      ac: "Muestra el alias si existe."
    });

    insertTask(db, 5101, 4101, "BE: endpoint POST /clientes", "Active", "be-paula", "backend");
    insertTask(db, 5102, 4101, "FE: formulario AltaClientePage", "Active", "fe-lucia", "frontend");
    insertTask(db, 5103, 4103, "BE: consumir usp_Movimientos_Listar", "Blocked", "be-paula", "backend");
    insertTask(db, 5104, 4106, "FE: filtro sucursal", "Ready", null, "frontend");
    insertTask(db, 5105, 4109, "BE: job de email", "Resolved", "be-diego", "backend");
    insertTask(db, 5106, 4112, "FE: botón SSO", "Code Review", "fe-lucia", "frontend");

    run(db, "UPDATE work_items SET iteration_id = ? WHERE azure_id = 4107", ITER);
    run(db, "INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?)", `${idOf(4105)}/comment/1`, idOf(4105), "pm-1", "Producto", "2026-09-29T15:00:00.000Z", "<p>El email SÍ debe poder editarse para correcciones.</p>", 4);
    run(db, "INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?)", `${idOf(4102)}/comment/1`, idOf(4102), "pm-1", "Producto", "2026-09-30T11:00:00.000Z", "<p>Adjunté captura. El flujo debería parecerse a eso.</p>", 1);

    const attPath = join(dataDir, "attachments", "4102-captura.png");
    writeFileSync(attPath, png());
    const sha = createHash("sha256").update(png()).digest("hex");
    run(db, "INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "att-4102", idOf(4102), "captura-comprobante.png", "image/png", sha, attPath, "azure://attachment/demo/4102", now);

    insertEvidence(db, "ev-4102-img", idOf(4102), "attachment", "attachment:att-4102", "INFERRED", now, "Captura sin texto de requisitos. No se completan campos imaginados.", attPath, sha, "att-4102");
    insertEvidence(db, "ev-4101-ac", idOf(4101), "work-item", `${idOf(4101)}#rev12`, "CONFIRMED", now, "Criterio de aceptación explícito en el Work Item.", null, null, null);
    insertEvidence(db, "ev-4105-desc", idOf(4105), "work-item", `${idOf(4105)}#description`, "CONFIRMED", now, "Descripción: el email no se edita.", null, null, null);
    insertEvidence(db, "ev-4105-cmt", idOf(4105), "comment", `${idOf(4105)}/comment/1`, "CONFIRMED", now, "Comentario: el email sí se edita.", null, null, null);

    run(db, "INSERT INTO questions VALUES (?, ?, ?, ?, ?)", "q-4102-1", idOf(4102), "¿Qué campos del comprobante son obligatorios y cuál es el OCR aceptable?", 1, JSON.stringify(["ev-4102-img"]));
    run(db, "INSERT INTO questions VALUES (?, ?, ?, ?, ?)", "q-4105-1", idOf(4105), "¿El email es editable o no? Descripción y comentario se contradicen.", 1, JSON.stringify(["ev-4105-desc", "ev-4105-cmt"]));

    insertContract(db, "ctr-sp-mov", idOf(4103), "SP", "dbo.usp_Movimientos_Listar", "UNKNOWN", null);
    insertContract(db, "ctr-sp-csv", idOf(4104), "SP", "dbo.usp_Movimientos_Exportar", "CONFIRMED", JSON.stringify({
      inputs: [{ name: "@cuentaId", type: "int", nullable: false, meaning: "Cuenta" }],
      outputs: [{ name: "Fecha", type: "date", nullable: false, meaning: "Fecha movimiento" }],
      errors: ["404 cuenta inexistente"],
      compatibilityNotes: "v1 confirmada el 2026-09-20"
    }));
    insertContract(db, "ctr-api-clientes", idOf(4101), "API", "POST /api/clientes", "CONFIRMED", JSON.stringify({
      inputs: [{ name: "cuit", type: "string", nullable: false, meaning: "CUIT" }],
      outputs: [{ name: "id", type: "string", nullable: false, meaning: "Id cliente" }],
      errors: ["400 CUIT inválido"],
      compatibilityNotes: "v1"
    }));

    insertDep(db, "dep-sp-4103", idOf(4103), "SP_CONTRACT", "PENDING", "dbo.usp_Movimientos_Listar", "DB externo", "ctr-sp-mov", "2026-09-25T10:00:00.000Z", "2026-09-25T10:00:00.000Z", null, "REQUESTED");
    insertDep(db, "dep-sp-4104-contract", idOf(4104), "SP_CONTRACT", "SATISFIED", "dbo.usp_Movimientos_Exportar", "DB externo", "ctr-sp-csv", "2026-09-20T10:00:00.000Z", null, null, "CONTRACT_CONFIRMED");
    insertDep(db, "dep-sp-4104-deploy", idOf(4104), "SP_DEPLOYMENT", "PENDING", "dbo.usp_Movimientos_Exportar@QA", "DB externo", "ctr-sp-csv", "2026-09-22T10:00:00.000Z", "2026-09-22T10:00:00.000Z", null, "AVAILABLE");
    run(db, "UPDATE dependencies SET environment = 'QA', lifecycle = 'CONTRACT_CONFIRMED' WHERE id = 'dep-sp-4104-deploy'");
    run(db, "UPDATE dependencies SET lifecycle = 'REQUESTED' WHERE id = 'dep-sp-4104-deploy'");
    run(db, "INSERT INTO dependency_intervals(dependency_id, blocked_at, unblocked_at, days_elapsed) VALUES (?, ?, ?, ?)", "dep-sp-4103", "2026-09-25T10:00:00.000Z", null, 8);

    run(db, "INSERT INTO pull_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "pr-88", idOf(4112), "frontend", "SSO login button", "active", "https://dev.azure.com/fabrikam-demo/demo/_git/frontend/pullrequest/88", "2026-09-28T12:00:00.000Z", "demo");
    run(db, "INSERT INTO pull_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "pr-90", idOf(4101), "backend", "POST clientes", "active", "https://dev.azure.com/fabrikam-demo/demo/_git/backend/pullrequest/90", "2026-10-02T12:00:00.000Z", "demo");

    run(db, "INSERT INTO release_packages VALUES (?, ?, ?, ?)", "rel-2026-10-1", "Release 2026.10.1", "2026-10-08T00:00:00.000Z", "Paquete quincenal");
    run(db, "INSERT INTO release_packages VALUES (?, ?, ?, ?)", "rel-2026-09-2", "Release 2026.09.2", "2026-09-25T00:00:00.000Z", "Paquete anterior");
    run(db, "INSERT INTO release_components VALUES (?, ?, ?, ?, ?, ?, ?)", "rc-1", "rel-2026-10-1", "backend", "api", "1.10.0", "bbb222be", "build-901");
    run(db, "INSERT INTO release_components VALUES (?, ?, ?, ?, ?, ?, ?)", "rc-2", "rel-2026-10-1", "frontend", "web", "1.10.0-rc", "aaa111fe", "build-902");
    run(db, "INSERT INTO release_work_items VALUES (?, ?, ?)", "rel-2026-10-1", idOf(4110), "Home / Saldos");
    run(db, "INSERT INTO release_work_items VALUES (?, ?, ?)", "rel-2026-10-1", idOf(4111), "Tesorería / Conciliación");
    run(db, "INSERT INTO release_work_items VALUES (?, ?, ?)", "rel-2026-09-2", idOf(4114), "Cuentas / Alias");

    run(db, "INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "dep-qa-4110", "rel-2026-10-1", "QA", "partial", "2026-10-02T18:00:00.000Z", "api-1.10.0", "pipeline", "system", "build-901", JSON.stringify(["backend"]), JSON.stringify([idOf(4110)]));
    run(db, "INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "dep-uat-4111-rb", "rel-2026-10-1", "UAT", "rollback", "2026-10-01T21:00:00.000Z", "matching-1.9.8", "pipeline", "system", "release-77", JSON.stringify(["matching"]), JSON.stringify([idOf(4111)]));
    run(db, "INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "dep-prod-4114", "rel-2026-09-2", "PROD", "success", "2026-09-26T11:00:00.000Z", "api-1.9.2", "pipeline", "system", "release-70", JSON.stringify(["backend", "frontend"]), JSON.stringify([idOf(4114)]));
    run(db, "INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "dep-manual-note", "rel-2026-09-2", "PROD", "success", "2026-09-26T12:00:00.000Z", "api-1.9.2", "MANUAL_CONFIRMED", "TL", "Ticket CAB-44", JSON.stringify(["backend", "frontend"]), JSON.stringify([idOf(4114)]));

    const baseline = [4101, 4102, 4103, 4104, 4105, 4106, 4107, 4109, 4110, 4111, 4112, 4113, 4114];
    run(db, "INSERT INTO sprint_baselines VALUES (?, ?, ?, ?)", ITER, "2026-09-28T10:00:00.000Z", JSON.stringify(baseline.map(idOf)), "snap-baseline");
    for (const n of baseline) {
      run(db, "INSERT INTO scope_events(iteration_id, work_item_id, event_type, at, reason, snapshot_id) VALUES (?, ?, ?, ?, ?, ?)", ITER, idOf(n), "baseline", "2026-09-28T10:00:00.000Z", n === 4107 ? "Carry-over Sprint 24.09" : null, "snap-baseline");
    }
    run(db, "INSERT INTO scope_events(iteration_id, work_item_id, event_type, at, reason, snapshot_id) VALUES (?, ?, ?, ?, ?, ?)", ITER, idOf(4107), "carry_over", "2026-09-28T10:00:00.000Z", "No terminó en 24.09", "snap-baseline");
    run(db, "INSERT INTO scope_events(iteration_id, work_item_id, event_type, at, reason, snapshot_id) VALUES (?, ?, ?, ?, ?, ?)", ITER, idOf(4108), "added", "2026-10-01T09:00:00.000Z", "Pedido de negocio durante sprint", "snap-mid");
    run(db, "INSERT INTO scope_events(iteration_id, work_item_id, event_type, at, reason, snapshot_id) VALUES (?, ?, ?, ?, ?, ?)", ITER, idOf(4113), "removed", "2026-09-30T16:00:00.000Z", "Fuera de alcance", "snap-mid");

    run(
      db,
      "INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "snap-baseline",
      "sprint",
      ITER,
      "2026-09-28T10:00:00.000Z",
      JSON.stringify({ workItems: "OK", deployments: "NOT_AVAILABLE" }),
      JSON.stringify({ timezone: TZ }),
      JSON.stringify({ stories: baseline.length }),
      0,
      null
    );

    run(db, "INSERT INTO sync_runs VALUES (?, ?, ?, ?, ?, ?, ?)", syncRunId, now, now, ITER, "ok", JSON.stringify({
      workItems: "OK", comments: "OK", revisions: "PARTIAL", relations: "OK",
      attachments: "OK", pullRequests: "OK", builds: "NOT_AVAILABLE", deployments: "OK"
    }), null);
    run(db, "INSERT INTO sync_runs VALUES (?, ?, ?, ?, ?, ?, ?)", "sync-403", "2026-10-02T09:00:00.000Z", "2026-10-02T09:00:01.000Z", ITER, "error", JSON.stringify({
      workItems: "OK", comments: "OK", revisions: "OK", relations: "OK",
      attachments: "OK", pullRequests: "UNAUTHORIZED", builds: "UNAUTHORIZED", deployments: "UNAUTHORIZED"
    }), "Azure 403 en pipelines y PRs de un proyecto secundario");

    run(db, "INSERT INTO analyses VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "an-4101", idOf(4101), "technical", now, "aaa111fe", "frontend", JSON.stringify({
      classification: "CONFIRMED",
      notes: "AltaClientePage y ClienteService existen en el fixture de análisis.",
      files: ["src/pages/AltaClientePage.tsx", "src/services/clienteService.ts"]
    }), 0);
    run(db, "INSERT INTO analyses VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "an-4102", idOf(4102), "functional", now, null, null, JSON.stringify({
      classification: "INFERRED",
      notes: "Sólo hay captura. Preguntas abiertas."
    }), 0);
    run(db, "INSERT INTO tl_notes VALUES (?, ?, ?)", idOf(4103), "Hablar con el equipo de DB el lunes; no adelantar firma del SP.", now);

    insertDraft(db, "draft-4106-fe", idOf(4106), "FE: combo sucursal reutilizando BranchSelect", "FE", null);
    insertDraft(db, "draft-4103-be", idOf(4103), "BE: endpoint movimientos (bloqueado por SP)", "BE", "be-paula");
  });

  const root = projectRoot();
  const resultFePath = join(root, "tests/fixtures/team-ai/work-result.valid.frontend.json");
  const resultBePath = join(root, "tests/fixtures/team-ai/work-result.valid.backend.json");
  if (existsSync(resultFePath) && existsSync(resultBePath)) {
    importWorkResult(db, JSON.parse(readFileSync(resultFePath, "utf8")), "fixtures/frontend");
    importWorkResult(db, JSON.parse(readFileSync(resultBePath, "utf8")), "fixtures/backend");
  }
  const failPath = join(root, "tests/fixtures/security/report-fail.json");
  const stalePath = join(root, "tests/fixtures/security/report-stale.json");
  if (existsSync(failPath)) {
    importSecurityReport(db, JSON.parse(readFileSync(failPath, "utf8")), true);
  }
  if (existsSync(stalePath)) {
    importSecurityReport(db, JSON.parse(readFileSync(stalePath, "utf8")), false);
  }

  setMeta(db, "demo", "true");
  setMeta(db, "demo_warning", "Dataset ficticio identificado. No es un tenant Azure real.");
}

function insertStory(db: Db, s: {
  azureId: number; title: string; state: string; assigned: string | null;
  priority: number; estimate: number; screen: string; module: string;
  description: string; ac: string;
}): void {
  const config = demoConfig();
  const id = idOf(s.azureId);
  run(
    db,
    `INSERT INTO work_items (
      id, organization, project, azure_id, type, title, state_original, state_normalized,
      iteration_id, area_path, priority, assigned_to_id, estimate, description_html,
      acceptance_criteria, url, source_revision, fetched_at, sync_run_id, parent_id, screen, module, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ORG, PROJECT, s.azureId, "User Story", s.title, s.state,
    normalizeState(s.state, config.azure.stateMapping),
    ITER, PROJECT, s.priority, s.assigned, s.estimate, s.description, s.ac,
    `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT)}/_workitems/edit/${s.azureId}`,
    12, "2026-10-03T12:00:00.000Z", "sync-demo-001", null, s.screen, s.module, "demo"
  );
}

function insertTask(db: Db, azureId: number, parent: number, title: string, state: string, assigned: string | null, layer: string): void {
  const config = demoConfig();
  const id = idOf(azureId);
  run(
    db,
    `INSERT INTO work_items (
      id, organization, project, azure_id, type, title, state_original, state_normalized,
      iteration_id, area_path, priority, assigned_to_id, estimate, description_html,
      acceptance_criteria, url, source_revision, fetched_at, sync_run_id, parent_id, screen, module, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ORG, PROJECT, azureId, "Task", title, state,
    normalizeState(state, config.azure.stateMapping),
    ITER, PROJECT, 2, assigned, 1, "", "",
    `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT)}/_workitems/edit/${azureId}`,
    3, "2026-10-03T12:00:00.000Z", "sync-demo-001", idOf(parent), null, layer, "demo"
  );
  run(db, "INSERT INTO work_item_relations(work_item_id, rel_type, target_id, target_url, attributes_json) VALUES (?, ?, ?, ?, ?)",
    id, "System.LinkTypes.Hierarchy-Reverse", String(parent), `workItems/${parent}`, "{}");
}

function insertEvidence(db: Db, id: string, wi: string, kind: string, source: string, cls: string, at: string, summary: string, path: string | null, sha: string | null, att: string | null): void {
  run(db, "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, wi, kind, source, cls, at, summary, summary, path, sha, att);
}

function insertContract(db: Db, id: string, wi: string, kind: string, name: string, status: string, def: string | null): void {
  run(db, "INSERT INTO contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, wi, kind, name, "v1", status, def, "[]", null);
}

function insertDep(db: Db, id: string, wi: string, kind: string, status: string, name: string, team: string, contractId: string, requested: string, blocked: string | null, unblocked: string | null, lifecycle: string): void {
  run(db, "INSERT INTO dependencies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, wi, kind, status, name, team, JSON.stringify(["BE", "FE"]), "[]", contractId, requested, blocked, unblocked, requested, null, lifecycle);
}

function insertDraft(db: Db, id: string, parent: string, title: string, layer: string, assigned: string | null): void {
  run(db, "INSERT INTO draft_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, parent, title, layer, assigned, JSON.stringify({ objetivo: title, assigned: assigned ?? "UNASSIGNED" }), null, "local", id);
}
