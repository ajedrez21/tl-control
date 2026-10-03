import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig, localConfigPath, exampleConfigPath, dbPath, projectRoot } from "../config/load.ts";
import { isPlaceholderOrg } from "../config/types.ts";
import { dbExists } from "../storage/db.ts";

export type DoctorStatus = "installed" | "authenticated" | "authorized" | "unconfigured" | "unavailable";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
}

export function runDoctor(): { ok: boolean; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = [];
  checks.push({
    id: "node",
    status: "installed",
    detail: `Node ${process.version}`
  });

  const hasLocal = existsSync(localConfigPath());
  checks.push({
    id: "config",
    status: hasLocal ? "installed" : "unconfigured",
    detail: hasLocal ? localConfigPath() : `Usando ejemplo ${exampleConfigPath()}. Ejecutá setup.`
  });

  let config;
  try {
    config = loadConfig();
    checks.push({
      id: "config-valid",
      status: "installed",
      detail: `timezone=${config.timezone} process=${config.azure.process}`
    });
  } catch (error) {
    checks.push({ id: "config-valid", status: "unconfigured", detail: String(error) });
    return { ok: false, checks };
  }

  if (isPlaceholderOrg(config.azure.organization) || config.azure.organization === "YOUR_ORG") {
    checks.push({
      id: "azure-org",
      status: "unconfigured",
      detail: "organización/proyecto de ejemplo o placeholder. Completá config/tl-control.json"
    });
  } else {
    checks.push({
      id: "azure-org",
      status: "installed",
      detail: `${config.azure.organization}/${config.azure.project}`
    });
  }

  const pat = process.env.AZURE_DEVOPS_EXT_PAT || process.env.AZURE_DEVOPS_PAT;
  checks.push({
    id: "azure-auth",
    status: pat ? "authenticated" : "unconfigured",
    detail: pat
      ? "PAT presente en entorno (no se muestra)."
      : "Sin AZURE_DEVOPS_EXT_PAT ni AZURE_DEVOPS_PAT. El modo demo no lo requiere."
  });

  checks.push({
    id: "azure-authorize",
    status: pat ? "unconfigured" : "unavailable",
    detail: pat
      ? "No se llama a Azure desde doctor. Usá `tl-control sync --iteration ...` para comprobar autorización (200 vs 401/403)."
      : "Sin credencial no hay comprobación de autorización."
  });

  const db = dbPath(config);
  checks.push({
    id: "sqlite",
    status: "installed",
    detail: dbExists(db) ? `base en ${db}` : `aún no hay base; se crea en demo/sync (${db})`
  });

  for (const repo of config.repositories) {
    if (!repo.localPath) {
      checks.push({ id: `repo-${repo.repoId}`, status: "unconfigured", detail: `${repo.repoId}: localPath vacío` });
      continue;
    }
    if (!existsSync(repo.localPath)) {
      checks.push({ id: `repo-${repo.repoId}`, status: "unavailable", detail: `${repo.repoId}: ruta inexistente` });
      continue;
    }
    try {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.localPath, encoding: "utf8" }).trim();
      checks.push({ id: `repo-${repo.repoId}`, status: "installed", detail: `${repo.repoId} @ ${sha.slice(0, 8)}` });
    } catch {
      checks.push({ id: `repo-${repo.repoId}`, status: "unavailable", detail: `${repo.repoId}: no es un repo git` });
    }
  }

  checks.push({
    id: "azure-mcp",
    status: "unavailable",
    detail: "El CLI no invoca MCP. Skills del host pueden usar @azure-devops/mcp (work items, comments, revisions, attachments, PRs, pipelines). Deployments de release pueden ser NOT_AVAILABLE."
  });

  checks.push({
    id: "writes",
    status: config.azure.writes.enabled ? "installed" : "unconfigured",
    detail: config.azure.writes.enabled
      ? "Escrituras Azure habilitadas: sólo con preview + operación explícita."
      : "Escrituras deshabilitadas. prepare-story exporta borrador."
  });

  checks.push({
    id: "project",
    status: "installed",
    detail: projectRoot()
  });

  const blocking = checks.filter((c) => c.id === "config-valid" && c.status === "unconfigured");
  return { ok: blocking.length === 0, checks };
}
