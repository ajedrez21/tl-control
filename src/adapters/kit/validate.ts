import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { projectRoot } from "../../config/load.ts";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020") as new (opts: object) => {
  compile: (schema: object) => ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> };
};
const addFormats = require("ajv-formats") as (ajv: InstanceType<typeof Ajv>) => void;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function compile(rel: string) {
  const schema = JSON.parse(readFileSync(join(projectRoot(), rel), "utf8")) as object;
  return ajv.compile(schema);
}

const validateContext = compile("contracts/team-ai/v1/work-context.schema.json");
const validateResult = compile("contracts/team-ai/v1/work-result.schema.json");

export type ArtifactKind = "work-context" | "work-result";

export function validateTeamAi(kind: ArtifactKind, payload: unknown): { ok: true } | { ok: false; errors: string[] } {
  const validator = kind === "work-context" ? validateContext : validateResult;
  const obj = payload as { schemaVersion?: string };
  if (obj?.schemaVersion && obj.schemaVersion !== "team-ai/v1") {
    return { ok: false, errors: [`Versión desconocida: ${obj.schemaVersion}`] };
  }
  const ok = validator(payload);
  if (ok) return { ok: true };
  const errors = (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
  return { ok: false, errors };
}
