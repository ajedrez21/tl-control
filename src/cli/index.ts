#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, ensureLocalConfig, exampleConfigPath, dbPath, resolveDataDir, writeLocalConfig, loadLocalEnv, azurePat } from "../config/load.ts";
import { all, get, openDb, getMeta } from "../storage/db.ts";
import { backupDb, restoreDb, audit } from "../storage/backup.ts";
import { demoConfig, seedDemo } from "../demo/seed.ts";
import { runDoctor } from "./doctor.ts";
import { AzureDevOpsClient, syncIteration } from "../adapters/azure/client.ts";
import { FetchHttpClient } from "../adapters/http.ts";
import { analyzeStory, analyzeSp, prepareStory } from "../analysis/story.ts";
import { computeSprintMetrics } from "../metrics/sprint.ts";
import { refreshAlerts } from "../metrics/alerts.ts";
import { listReleases } from "../metrics/releases.ts";
import { confirmSpContract, dismissSqlGap } from "../metrics/sql-gaps.ts";
import { startDashboardServer } from "../server/http.ts";
import { importWorkResult } from "../adapters/kit/import.ts";
import { importSecurityReport } from "../adapters/security/import.ts";
import { previewPublish } from "./publish.ts";
import { publishApprovedDrafts } from "../analysis/drafts.ts";
import { writeFrozenReport } from "../report/frozen.ts";
import { nowIso } from "../domain/time.ts";

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean>; rest: string[] } {
  const cmd = argv[0] ?? "help";
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else rest.push(a);
  }
  return { cmd, flags, rest };
}

function print(data: unknown): void {
  process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  loadLocalEnv();
  const { cmd, flags, rest } = parseArgs(argv);
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      print(helpText());
      return;
    case "setup": {
      const path = ensureLocalConfig();
      print({ ok: true, config: path, example: exampleConfigPath(), hint: "Editá organización/proyecto y miembros. Credenciales sólo por env." });
      return;
    }
    case "doctor": {
      const result = runDoctor();
      print(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "demo": {
      const config = demoConfig();
      writeLocalConfig(config);
      const db = openDb(dbPath(config));
      seedDemo(db, resolveDataDir(config));
      const iteration = config.azure.iterationPath;
      computeSprintMetrics(db, iteration, nowIso());
      refreshAlerts(db, config, iteration);
      audit(db, "cli", "demo-seed", iteration, { demo: true });
      db.close();
      print({ ok: true, demo: true, db: dbPath(config), iteration, warning: "Dataset ficticio. No es un tenant Azure real." });
      return;
    }
    case "sync":
    case "sync-sprint": {
      if (flags.demo) {
        await runCli(["demo"]);
        return;
      }
      const config = loadConfig();
      const iteration = String(flags.iteration ?? rest[0] ?? config.azure.iterationPath);
      const pat = azurePat();
      if (!pat) {
        print({ ok: false, error: "Sin PAT. Usá --demo, un .env local o definí AZURE_DEVOPS_EXT_PAT. No se inventa sync." });
        process.exitCode = 1;
        return;
      }
      const db = openDb(dbPath(config));
      const client = new AzureDevOpsClient(config, new FetchHttpClient(), { pat });
      try {
        print({ ok: true, ...(await syncIteration(db, config, client, iteration)) });
      } catch (error) {
        print({ ok: false, error: String(error), hint: "Se conserva el último estado local." });
        process.exitCode = 1;
      } finally {
        db.close();
      }
      return;
    }
    case "analyze-story": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      print(analyzeStory(db, config, String(rest[0] ?? flags.id)));
      db.close();
      return;
    }
    case "analyze-sp": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      const id = String(rest[0] ?? flags.id);
      if (flags["not-needed"] || flags.dismiss) {
        const resolved = get<{ id: string }>(db, "SELECT id FROM work_items WHERE azure_id = ? OR id = ?", Number(id) || -1, id)
          ?? get<{ id: string }>(db, "SELECT id FROM work_items WHERE id LIKE ?", `%/${id}`);
        print({ ok: Boolean(resolved && dismissSqlGap(db, resolved.id)), action: "not-needed", id });
        if (resolved) print(analyzeSp(db, config, id));
        db.close();
        return;
      }
      if (flags.confirm) {
        const resolved = get<{ id: string }>(db, "SELECT id FROM work_items WHERE azure_id = ? OR id = ?", Number(id) || -1, id)
          ?? get<{ id: string }>(db, "SELECT id FROM work_items WHERE id LIKE ?", `%/${id}`);
        print({
          ok: Boolean(resolved && confirmSpContract(db, resolved.id, { name: flags.name ? String(flags.name) : undefined, notes: flags.note ? String(flags.note) : undefined })),
          action: "confirm",
          id
        });
        if (resolved) print(analyzeSp(db, config, id));
        db.close();
        return;
      }
      print(analyzeSp(db, config, id));
      db.close();
      return;
    }
    case "prepare-story": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      const id = String(rest[0] ?? flags.id);
      const prepared = prepareStory(db, config, id, flags.assign ? String(flags.assign) : undefined);
      print(flags.preview ? { preview: previewPublish(db, config, id), prepared } : prepared);
      db.close();
      return;
    }
    case "publish": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      const preview = previewPublish(db, config, String(rest[0]), flags.rev ? Number(flags.rev) : undefined);
      print(
        flags.confirm
          ? await publishApprovedDrafts(db, config, String(rest[0]), true)
          : { preview, hint: "Repetí con --confirm. Con writes.enabled crea en Azure solo las aprobadas que todavía no existen." }
      );
      db.close();
      return;
    }
    case "daily-control": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      const iteration = String(flags.iteration ?? config.azure.iterationPath);
      print({
        metrics: computeSprintMetrics(db, iteration, nowIso()),
        alerts: refreshAlerts(db, config, iteration),
        demo: getMeta(db, "demo") === "true"
      });
      db.close();
      return;
    }
    case "release-status": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      print({ releases: listReleases(db, rest[0]) });
      db.close();
      return;
    }
    case "security-status": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      if (flags.import) {
        const payload = JSON.parse(readFileSync(String(flags.import), "utf8"));
        importSecurityReport(db, payload, Boolean(flags.gate));
        print({ ok: true, imported: payload.id });
      } else {
        print({ reports: all(db, "SELECT id, source, gate_status, current_gate, checked_at FROM security_reports") });
      }
      db.close();
      return;
    }
    case "import-result": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      const file = String(rest[0] ?? flags.file);
      print(importWorkResult(db, JSON.parse(readFileSync(file, "utf8")), String(flags.origin ?? file)));
      db.close();
      return;
    }
    case "dashboard": {
      if (flags.demo) await runCli(["demo"]);
      const config = loadConfig();
      const handle = startDashboardServer({ config, port: flags.port ? Number(flags.port) : config.server.port });
      const hash = flags.story ? `#/story/${flags.story}` : flags.release ? "#/releases" : flags.sprint ? "#/grid" : "";
      print(`Dashboard: ${handle.url}${hash}`);
      print("Ctrl+C para salir. Sync automático cada 1 hora. El botón Actualizar sincroniza y recarga.");
      if (!flags["no-open"]) openBrowser(`${handle.url}${hash}`);
      await new Promise(() => undefined);
      return;
    }
    case "close-sprint": {
      const config = loadConfig();
      const db = openDb(dbPath(config));
      const iteration = String(rest[0] ?? flags.iteration ?? config.azure.iterationPath);
      print({ ok: true, report: writeFrozenReport(db, config, iteration) });
      db.close();
      return;
    }
    case "backup": {
      const config = loadConfig();
      print({ ok: true, backup: backupDb(dbPath(config), join(resolveDataDir(config), "backups")) });
      return;
    }
    case "restore": {
      const config = loadConfig();
      restoreDb(String(rest[0]), dbPath(config));
      print({ ok: true, restored: dbPath(config) });
      return;
    }
    default:
      print(`Comando desconocido: ${cmd}\n${helpText()}`);
      process.exitCode = 1;
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const cliArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, cliArgs, { detached: true, stdio: "ignore" }).unref();
}

function helpText(): string {
  return `tl-control — control local del TL

  setup                         Copia config de ejemplo
  doctor                        Diagnóstico
  demo                          Dataset ficticio identificado
  sync --iteration <path>       Ingesta Azure (requiere PAT)
  analyze-story <id>
  analyze-sp <id> [--not-needed] [--confirm --name SP --note texto]
  prepare-story <id> [--assign id] [--preview]
  publish <id> [--rev N] [--confirm]
  daily-control
  release-status [id]
  security-status [--import file --gate]
  import-result <file.json>
  dashboard [--demo] [--story id|--release|--sprint] [--no-open]
  close-sprint <iteration>
  backup | restore <file.sqlite>

Credenciales: AZURE_DEVOPS_EXT_PAT o AZURE_DEVOPS_PAT. Nunca en Git ni en el dashboard.`;
}

const isEntry = process.argv[1]?.replaceAll("\\", "/").endsWith("/cli/index.ts")
  || process.argv[1]?.replaceAll("\\", "/").endsWith("/cli/index.js");
if (isEntry) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
