import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./types.ts";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export function projectRoot(): string {
  return ROOT;
}

export function exampleConfigPath(): string {
  return join(ROOT, "config", "tl-control.example.json");
}

export function localConfigPath(): string {
  return join(ROOT, "config", "tl-control.json");
}

export function loadConfig(configPath = localConfigPath()): AppConfig {
  const path = existsSync(configPath) ? configPath : exampleConfigPath();
  const raw = JSON.parse(readFileSync(path, "utf8")) as AppConfig;
  validateConfig(raw);
  return raw;
}

export function validateConfig(config: AppConfig): void {
  if (!config.timezone) throw new Error("config.timezone es obligatorio");
  if (!config.azure?.stateMapping || Object.keys(config.azure.stateMapping).length === 0) {
    throw new Error("config.azure.stateMapping es obligatorio");
  }
  if (!config.team?.members?.length) throw new Error("config.team.members es obligatorio");
  const fe = config.team.members.filter((m) => m.role === "frontend").length;
  const be = config.team.members.filter((m) => m.role === "backend").length;
  if (fe < 1 || be < 1) {
    throw new Error("El equipo debe declarar al menos un frontend y un backend (composición configurable).");
  }
  const ownerId = config.team.defaultOwnerId?.trim();
  if (ownerId && !config.team.members.some((m) => m.id === ownerId)) {
    throw new Error(`config.team.defaultOwnerId no existe en members: ${ownerId}`);
  }
}

export function ensureLocalConfig(): string {
  const dest = localConfigPath();
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(exampleConfigPath(), dest);
  }
  return dest;
}

export function writeLocalConfig(config: AppConfig): void {
  validateConfig(config);
  mkdirSync(dirname(localConfigPath()), { recursive: true });
  writeFileSync(localConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveDataDir(config: AppConfig): string {
  const dir = isAbsolute(config.paths.dataDir)
    ? config.paths.dataDir
    : join(ROOT, config.paths.dataDir);
  mkdirSync(join(dir, "attachments"), { recursive: true });
  mkdirSync(join(dir, "exports"), { recursive: true });
  mkdirSync(join(dir, "backups"), { recursive: true });
  return dir;
}

export function resolveReportsDir(config: AppConfig): string {
  const dir = isAbsolute(config.paths.reportsDir)
    ? config.paths.reportsDir
    : join(ROOT, config.paths.reportsDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(config: AppConfig): string {
  return join(resolveDataDir(config), "tl-control.sqlite");
}

let envLoaded = false;

export function loadLocalEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function azurePat(): string | undefined {
  loadLocalEnv();
  const value = process.env.AZURE_DEVOPS_EXT_PAT || process.env.AZURE_DEVOPS_PAT;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
