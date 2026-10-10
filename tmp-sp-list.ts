import { loadConfig, dbPath } from "./src/config/load.ts";
import { openDb, all, get } from "./src/storage/db.ts";

const config = loadConfig();
const db = openDb(dbPath(config));

const spTasks = all<{
  azure_id: number;
  id: string;
  type: string;
  state_normalized: string;
  title: string;
  parent_id: string | null;
  assigned_to_name: string | null;
  description_html: string | null;
}>(
  db,
  `SELECT id, azure_id, type, state_normalized, title, parent_id, assigned_to_name, description_html
   FROM work_items
   WHERE type = 'Task' AND (title = 'SP' OR title LIKE 'SP-%' OR title LIKE 'SP %' OR title LIKE 'SP-%')
   ORDER BY azure_id`
);

process.stdout.write("=== SP TASKS ===\n");
for (const t of spTasks) {
  const parent = t.parent_id
    ? get<{ azure_id: number; title: string; type: string; state_normalized: string; description_html: string | null; screen: string | null; module: string | null }>(
        db,
        "SELECT azure_id, title, type, state_normalized, description_html, screen, module FROM work_items WHERE id = ?",
        t.parent_id
      )
    : null;
  const siblings = t.parent_id
    ? all<{ azure_id: number; title: string; type: string; state_normalized: string }>(
        db,
        "SELECT azure_id, title, type, state_normalized FROM work_items WHERE parent_id = ? ORDER BY azure_id",
        t.parent_id
      )
    : [];
  process.stdout.write(
    JSON.stringify(
      {
        task: { id: t.azure_id, title: t.title, state: t.state_normalized, assignee: t.assigned_to_name, desc: t.description_html },
        parent,
        siblings
      },
      null,
      2
    ) + "\n---\n"
  );
}

const attachments = all(db, "SELECT * FROM sqlite_master WHERE type='table' AND name LIKE '%attach%'");
process.stdout.write("=== ATTACH TABLES ===\n" + JSON.stringify(attachments, null, 2) + "\n");

db.close();
