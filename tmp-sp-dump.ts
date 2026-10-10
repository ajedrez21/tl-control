import { loadConfig, dbPath } from "./src/config/load.ts";
import { openDb, all } from "./src/storage/db.ts";
import { listSpDossier } from "./src/metrics/sp-dossier.ts";

const config = loadConfig();
const db = openDb(dbPath(config));
const dossier = listSpDossier(db, config);

const slim = {
  repoStatus: dossier.repoStatus,
  items: dossier.items,
  traces: dossier.traces.map((t) => ({
    azureId: t.azureId,
    title: t.title,
    type: t.type,
    screen: t.screen,
    screenInferred: t.screenInferred,
    module: t.module,
    frontend: t.frontend,
    backend: t.backend,
    sps: t.sps,
    reads: t.reads,
    writes: t.writes,
    unknown: t.unknown,
    frontendPages: t.frontendPages,
    apis: t.apis,
    captures: t.captures?.map((c) => ({ fileName: c.fileName, url: c.url, inferredScreen: c.inferredScreen, note: c.note })),
    explanation: t.explanation,
    codeNote: t.codeNote,
    filesFe: t.filesFe,
    filesBe: t.filesBe,
    missingContract: t.missingContract
  }))
};

process.stdout.write(JSON.stringify(slim, null, 2) + "\n");

const attachments = all(
  db,
  `SELECT a.work_item_id, a.file_name, a.stored_path, w.azure_id, w.title
   FROM attachments a
   LEFT JOIN work_items w ON w.id = a.work_item_id
   ORDER BY w.azure_id`
);
process.stdout.write("=== ATTACHMENTS ===\n" + JSON.stringify(attachments, null, 2) + "\n");
db.close();
