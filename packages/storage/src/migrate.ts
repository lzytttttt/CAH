/**
 * Versioned SQLite migrations for the Cognitive Atrium persistence layer.
 *
 * Rules (design document section 19.1):
 * - `schema_migrations` records the applied versions; running the migrator twice
 *   is a no-op and always safe.
 * - Every migration runs inside one `BEGIN IMMEDIATE ... COMMIT` block. SQLite
 *   DDL is transactional, so a crash mid-migration leaves the previous schema.
 * - Migration SQL uses `IF NOT EXISTS` so a partially applied file can be
 *   re-run without manual repair.
 * - All timestamps are ISO-8601 UTC strings; all JSON payloads are TEXT columns
 *   parsed and schema-validated by the storage row mappers on the read boundary.
 *
 * Schema version history:
 *   v1 — initial schema: workspace, tasks, artifacts, artifact_modules,
 *        artifact_versions (immutable), sources, source_spans, runs, steps,
 *        run_checkpoints, blockers, decisions, patches, validation_reports,
 *        context_snapshots, tool_invocations, recipes, events, command_results,
 *        run_leases, provider_profiles.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const SCHEMA_VERSION = 1;

const V1_SCHEMA = `
/* ------------------------------------------------------------------ */
/* workspace (singleton)                                               */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  /** Internal optimistic-concurrency counter, not part of the Workspace wire entity. */
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

/* ------------------------------------------------------------------ */
/* tasks + artifact skeleton                                           */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  template_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  module_ids_json TEXT NOT NULL,
  accepted_version_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS artifact_modules (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  order_index INTEGER NOT NULL CHECK (order_index >= 0),
  dependencies_json TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  status TEXT NOT NULL,
  blocked_from TEXT,
  accepted_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_artifact_order ON artifact_modules(artifact_id, order_index);

/* ------------------------------------------------------------------ */
/* immutable artifact versions                                         */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  module_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  parent_id TEXT,
  base_version_id TEXT,
  source_run_id TEXT,
  patch_id TEXT,
  validation_report_id TEXT,
  accepted_by TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  restored_from_version_id TEXT,
  /** Insertion time (accepted_at is caller supplied and could be equal across versions). */
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_module ON artifact_versions(module_id, accepted_at);
CREATE INDEX IF NOT EXISTS idx_versions_artifact ON artifact_versions(artifact_id);
CREATE INDEX IF NOT EXISTS idx_versions_patch ON artifact_versions(patch_id);
CREATE INDEX IF NOT EXISTS idx_versions_hash ON artifact_versions(content_hash);

CREATE TRIGGER IF NOT EXISTS trg_artifact_versions_no_update
BEFORE UPDATE ON artifact_versions
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_versions_no_delete
BEFORE DELETE ON artifact_versions
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions are immutable');
END;

/* ------------------------------------------------------------------ */
/* sources (versioned, content in the object store)                    */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS sources (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  availability TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  parse_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_sources_task ON sources(task_id, id, version);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(hash);

CREATE TABLE IF NOT EXISTS source_spans (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  locator_json TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spans_source ON source_spans(source_id, version);

/* ------------------------------------------------------------------ */
/* runs + steps + checkpoints                                          */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 0),
  context_snapshot_id TEXT,
  budget_policy_json TEXT NOT NULL,
  budget_usage_json TEXT NOT NULL,
  base_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  return_state TEXT,
  interrupted_json TEXT,
  error_json TEXT,
  checkpoint_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  auto_accept_policy_applied INTEGER NOT NULL DEFAULT 0,
  queue_position INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS idx_runs_task_state ON runs(task_id, state);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  output_refs_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  model_call_id TEXT,
  tool_call_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  error_json TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, started_at);

CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  step_id TEXT,
  seq_at_checkpoint INTEGER NOT NULL CHECK (seq_at_checkpoint >= 0),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON run_checkpoints(run_id, seq_at_checkpoint, created_at);

/* ------------------------------------------------------------------ */
/* blockers + decisions                                                */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS blockers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  affected_steps_json TEXT NOT NULL,
  affected_module_ids_json TEXT NOT NULL,
  resolutions_json TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution_json TEXT,
  return_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_blockers_task ON blockers(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_blockers_run ON blockers(run_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  blocker_id TEXT,
  plan_version INTEGER,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id, created_at);

/* ------------------------------------------------------------------ */
/* patches + validation reports                                        */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS patches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  module_kind TEXT NOT NULL,
  base_version_id TEXT,
  operations_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  validation_report_id TEXT,
  candidate_hash TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  change_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_version_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_patches_task ON patches(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_patches_module ON patches(module_id);

CREATE TABLE IF NOT EXISTS validation_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  base_version_id TEXT,
  candidate_hash TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  validator_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_validation_reports_task ON validation_reports(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_validation_reports_module ON validation_reports(module_id);

/* ------------------------------------------------------------------ */
/* context snapshots                                                   */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  step_id TEXT,
  prompt_bundle_version TEXT NOT NULL,
  prompt_template_hashes_json TEXT NOT NULL,
  fragments_json TEXT NOT NULL,
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  omitted_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_task ON context_snapshots(task_id, created_at);

/* ------------------------------------------------------------------ */
/* tool invocations                                                    */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS tool_invocations (
  tool_call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  result_summary TEXT,
  result_object_hash TEXT,
  result_bytes INTEGER,
  error_json TEXT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  planned_at TEXT NOT NULL,
  authorized_at TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_run ON tool_invocations(run_id, planned_at);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_status ON tool_invocations(run_id, status);

/* ------------------------------------------------------------------ */
/* recipes (id+version is the key; reads resolve the latest version)   */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  dsl_version TEXT NOT NULL,
  input_parameters_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  output_artifact_kind TEXT NOT NULL,
  validators_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  test_cases_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fingerprint_inputs_json TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  source_module_id TEXT,
  applicability TEXT NOT NULL DEFAULT '',
  stale_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_recipes_task ON recipes(source_task_id, version);

/* ------------------------------------------------------------------ */
/* business event stream (append only, per-task monotonic seq)         */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  step_id TEXT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  causation_id TEXT,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  /** Wall-clock insertion time, used for diagnostics only. */
  recorded_at TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_task_type ON events(task_id, type);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);

/* ------------------------------------------------------------------ */
/* command idempotency                                                 */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS command_results (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  task_id TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_results_task ON command_results(task_id);

/* ------------------------------------------------------------------ */
/* run leases (crash recovery / execution fencing)                     */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS run_leases (
  run_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  /** Monotonic fence token: incremented every time ownership changes hands. */
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acquired_at TEXT NOT NULL,
  /** Epoch milliseconds; compared against Date.now(). */
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_leases_expiry ON run_leases(expires_at);

/* ------------------------------------------------------------------ */
/* provider profiles (public configuration only, no credentials)       */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  /** Logical credential reference (env var / key-file name). Never a secret. */
  credential_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  timeouts_json TEXT NOT NULL,
  context_window_override INTEGER,
  price_table_json TEXT,
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: V1_SCHEMA,
  },
];

export interface MigrationResult {
  /** Versions applied by this invocation (empty when the schema was current). */
  applied: number[];
  schemaVersion: number;
}

/** Read the current schema version of an open database (0 when uninitialized). */
export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get();
  if (!row) return 0;
  const version = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get();
  const value = version?.['version'];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Apply every migration newer than the recorded schema version.
 *
 * The caller must own the database connection and must not be inside an open
 * transaction (openStorage runs this immediately after opening, before serving
 * any request).
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const current = currentSchemaVersion(db);
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure; the original error is more useful */
      }
      throw error;
    }
  }
  return { applied, schemaVersion: currentSchemaVersion(db) };
}

/** All known migration versions, in order. Used by tests and diagnostics. */
export function knownSchemaVersion(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
}
