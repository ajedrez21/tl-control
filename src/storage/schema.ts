export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization TEXT NOT NULL,
  project TEXT NOT NULL,
  process_type TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_path TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT,
  finish_date TEXT,
  timezone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  azure_id TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  local_path TEXT,
  remote_url TEXT,
  base_ref TEXT NOT NULL,
  last_analyzed_sha TEXT
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  organization TEXT NOT NULL,
  project TEXT NOT NULL,
  azure_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  state_original TEXT NOT NULL,
  state_normalized TEXT NOT NULL,
  iteration_id TEXT,
  area_path TEXT,
  priority INTEGER,
  assigned_to_id TEXT,
  estimate REAL,
  description_html TEXT,
  acceptance_criteria TEXT,
  url TEXT,
  source_revision INTEGER,
  fetched_at TEXT,
  sync_run_id TEXT,
  parent_id TEXT,
  screen TEXT,
  module TEXT,
  tags TEXT,
  UNIQUE(organization, project, azure_id)
);

CREATE TABLE IF NOT EXISTS work_item_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state_original TEXT,
  title TEXT,
  assigned_to_id TEXT,
  changed_at TEXT,
  changed_by TEXT,
  payload_json TEXT,
  UNIQUE(work_item_id, revision)
);

CREATE TABLE IF NOT EXISTS work_item_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  target_id TEXT,
  target_url TEXT,
  attributes_json TEXT,
  UNIQUE(work_item_id, rel_type, target_id, target_url)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  created_at TEXT,
  text_html TEXT,
  source_revision INTEGER
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  work_item_id TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  classification TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  explanation TEXT,
  path_or_url TEXT,
  sha TEXT,
  attachment_id TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  work_item_id TEXT,
  file_name TEXT NOT NULL,
  content_type TEXT,
  sha256 TEXT,
  stored_path TEXT NOT NULL,
  source_url TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  base_sha TEXT,
  repo_id TEXT,
  payload_json TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  work_item_id TEXT,
  kind TEXT NOT NULL,
  name TEXT,
  version TEXT,
  status TEXT NOT NULL,
  definition_json TEXT,
  source_evidence_ids TEXT,
  environment TEXT
);

CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  name TEXT,
  responsible_team TEXT,
  blocks_json TEXT,
  evidence_ids TEXT,
  contract_id TEXT,
  requested_at TEXT,
  blocked_at TEXT,
  unblocked_at TEXT,
  last_evidence_at TEXT,
  environment TEXT,
  lifecycle TEXT
);

CREATE TABLE IF NOT EXISTS dependency_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dependency_id TEXT NOT NULL,
  blocked_at TEXT NOT NULL,
  unblocked_at TEXT,
  days_elapsed REAL
);

CREATE TABLE IF NOT EXISTS draft_tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  layer TEXT NOT NULL,
  assigned_to_id TEXT,
  payload_json TEXT NOT NULL,
  azure_id INTEGER,
  publish_status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS context_packages (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  iteration_id TEXT,
  captured_at TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  report_path TEXT
);

CREATE TABLE IF NOT EXISTS scope_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT,
  snapshot_id TEXT
);

CREATE TABLE IF NOT EXISTS sprint_baselines (
  iteration_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  work_item_ids_json TEXT NOT NULL,
  snapshot_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  planned_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS release_components (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  repo_id TEXT,
  component TEXT,
  version TEXT,
  sha TEXT,
  build_id TEXT
);

CREATE TABLE IF NOT EXISTS release_work_items (
  release_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  screens TEXT,
  PRIMARY KEY (release_id, work_item_id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  release_id TEXT,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  artifact_id TEXT,
  source TEXT NOT NULL,
  author TEXT,
  reference TEXT,
  components_json TEXT,
  work_items_json TEXT
);

CREATE TABLE IF NOT EXISTS workflow_results (
  artifact_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  context_hash TEXT,
  work_item_id TEXT
);

CREATE TABLE IF NOT EXISTS security_reports (
  id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  source TEXT NOT NULL,
  gate_status TEXT NOT NULL,
  checked_at TEXT,
  fingerprint TEXT,
  payload_json TEXT NOT NULL,
  current_gate INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  work_item_id TEXT,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS tl_notes (
  work_item_id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  iteration_id TEXT,
  status TEXT NOT NULL,
  coverage_json TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  question TEXT NOT NULL,
  blocking INTEGER NOT NULL,
  evidence_ids TEXT
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  work_item_id TEXT,
  repo_id TEXT,
  title TEXT,
  status TEXT,
  url TEXT,
  created_at TEXT,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wi_iteration ON work_items(iteration_id);
CREATE INDEX IF NOT EXISTS idx_wi_assigned ON work_items(assigned_to_id);
CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule_id);
`;
