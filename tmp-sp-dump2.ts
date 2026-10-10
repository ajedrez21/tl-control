import { loadConfig, dbPath } from "./src/config/load.ts";
import { openDb, all } from "./src/storage/db.ts";
import { listSpDossier } from "./src/metrics/sp-dossier.ts";

const TARGETS = new Set([6343, 6445, 6573, 6588, 6591, 6595]);

const config = loadConfig();
const db = openDb(dbPath(config));
const dossier = listSpDossier(db, config);

const traces = dossier.traces.filter((t) => TARGETS.has(t.azureId));
process.stdout.write("TRACE IDS: " + dossier.traces.map((t) => t.azureId).join(", ") + "\n");
process.stdout.write("MATCHED: " + traces.map((t) => t.azureId).join(", ") + "\n");

for (const t of traces) {
  const slim = {
    azureId: t.azureId,
    title: t.title,
    screen: t.screen,
    screenInferred: t.screenInferred,
    screenSource: t.screenSource,
    frontend: t.frontend,
    backend: t.backend,
    spsConfirmed: t.sps.filter((s) => s.confirmed || s.source === "contract" || s.source === "dependency"),
    spsRepo: t.sps.filter((s) => s.source === "repo" || s.source === "task" || s.source === "text").map((s) => `${s.usage}:${s.name}`),
    reads: t.reads.map((s) => s.name),
    writes: t.writes.map((s) => s.name),
    unknown: t.unknown.map((s) => s.name),
    frontendPages: t.frontendPages,
    apis: t.apis,
    captures: t.captures?.map((c) => ({ azureId: c.azureId, fileName: c.fileName, url: c.url, inferredScreen: c.inferredScreen, note: c.note })),
    explanation: t.explanation,
    codeNote: t.codeNote,
    filesFe: t.filesFe,
    filesBe: t.filesBe,
    missingContract: t.missingContract
  };
  process.stdout.write("\n========== " + t.azureId + " ==========\n");
  process.stdout.write(JSON.stringify(slim, null, 2) + "\n");
}

const attachments = all(
  db,
  `SELECT a.file_name, a.stored_path, w.azure_id, w.title
   FROM attachments a
   LEFT JOIN work_items w ON w.id = a.work_item_id
   WHERE w.azure_id IN (6343,6444,6445,6446,6573,6574,6588,6589,6591,6592,6595,6596)
   ORDER BY w.azure_id`
);
process.stdout.write("\n=== ATTACHMENTS ===\n" + JSON.stringify(attachments, null, 2) + "\n");
db.close();
