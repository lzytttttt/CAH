/**
 * SQLite (WAL) implementation of the storage port.
 *
 * Design constraints implemented here (design document sections 18.2, 19.1-19.3,
 * 4.1, 5.2, 9.2):
 *
 * - one database per engine mode (`<dataDir>/<mode>/cognitive-atrium.db`) and one
 *   content-addressed object directory (`<dataDir>/<mode>/objects`); demo and live
 *   data are physically isolated and never share a file.
 * - every state change that emits a business event happens inside ONE SQLite
 *   transaction (`transaction()` uses BEGIN IMMEDIATE; nested calls use
 *   SAVEPOINT). Business methods validate payloads before committing.
 * - per-task event `seq` is allocated inside the same transaction as the state
 *   change; a UNIQUE(task_id, seq) index backs monotonicity even if two storage
 *   instances ever share the file.
 * - accepted artifact versions are immutable (DB triggers reject UPDATE/DELETE),
 *   revisions use compare-and-set guards, commands are idempotent by commandId,
 *   run leases carry a monotonic fencing token, and backups are consistent
 *   SQLite snapshots plus their referenced objects.
 * - all reads re-validate rows via the `@ca/contracts` zod schemas so corrupted
 *   data cannot silently enter the harness.
 *
 * The synchronous `node:sqlite` API is wrapped in promises and serialized through
 * an async mutex. Transactions are re-entrant per async call-chain thanks to
 * AsyncLocalStorage, so a caller may compose storage calls inside `transaction()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ArtifactModuleSchema,
  ArtifactSchema,
  ArtifactVersionSchema,
  BlockerSchema,
  ContextSnapshotSchema,
  DecisionSchema,
  EVENT_CATEGORY_BY_TYPE,
  EVENT_SCHEMA_VERSION,
  LIMITS,
  PatchProposalSchema,
  ProviderProfileSchema,
  RecipeSchema,
  RunCheckpointSchema,
  RunSchema,
  SourceItemSchema,
  SourceSpanSchema,
  StepSchema,
  TaskSchema,
  ToolInvocationRecordSchema,
  ValidationReportSchema,
  WorkspaceSchema,
  WorkspaceSettingsSchema,
  newEventId,
  newUuid,
  parseEventPayload,
  parseHarnessEvent,
  utcNow,
  type Artifact,
  type ArtifactModule,
  type ArtifactVersion,
  type Blocker,
  type CommandId,
  type ContextSnapshot,
  type Decision,
  type EngineMode,
  type EventPayloads,
  type EventType,
  type HarnessEvent,
  type PatchProposal,
  type ProviderProfile,
  type Recipe,
  type Run,
  type RunCheckpoint,
  type SourceId,
  type SourceItem,
  type SourceSpan,
  type Step,
  type Task,
  type TaskId,
  type ToolInvocationRecord,
  type ValidationReport,
  type Workspace,
  type WorkspaceSettings,
} from '@ca/contracts';
import { currentSchemaVersion, runMigrations } from './migrate';
import { FileObjectStore } from './object-store';
import { sha256Hex } from './hash';
import { DatabaseSyncCtor } from './sqlite-driver';
import {
  artifactFromRow,
  artifactToRow,
  blockerFromRow,
  blockerToRow,
  checkpointFromRow,
  checkpointToRow,
  contextSnapshotFromRow,
  contextSnapshotToRow,
  decisionFromRow,
  decisionToRow,
  eventFromRow,
  eventToRow,
  moduleFromRow,
  moduleToRow,
  nowIso,
  patchFromRow,
  patchToRow,
  providerProfileFromRow,
  providerProfileToRow,
  recipeFromRow,
  recipeToRow,
  rowNumber,
  rowNullableNumber,
  rowString,
  runFromRow,
  runToRow,
  sourceFromRow,
  sourceToRow,
  spanFromRow,
  spanToRow,
  stepFromRow,
  stepToRow,
  taskFromRow,
  taskToRow,
  toolInvocationFromRow,
  toolInvocationToRow,
  validationReportFromRow,
  validationReportToRow,
  versionFromRow,
  versionToRow,
  workspaceFromRow,
  workspaceToRow,
  type DbRow,
  type SqlRow,
  type SqlValue,
} from './serialize';
import {
  RevisionConflictError,
  StateNotAllowedError,
  StorageError,
  VersionConflictError,
  type CommitAcceptanceInput,
  type CommitAcceptanceResult,
  type EventDraft,
  type ObjectStorePort,
  type SourceSearchCandidate,
  type SourceWithContent,
  type StoragePort,
  type TaskAggregate,
} from './types';

/* ------------------------------------------------------------------ */
/* public option / helper types                                        */
/* ------------------------------------------------------------------ */

export interface OpenStorageOptions {
  /** Directory that contains the per-mode subdirectories (`demo/`, `live/`). */
  dataDir: string;
  mode: EngineMode;
  workspaceName: string;
  settings?: Partial<WorkspaceSettings>;
}

export interface StorageDiagnostics {
  mode: EngineMode;
  dataDir: string;
  modeDir: string;
  dbPath: string;
  objectsDir: string;
  schemaVersion: number;
  open: boolean;
}

export interface RunLeaseRecord {
  runId: string;
  owner: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: number;
}

const TERMINAL_RUN_STATES = ['COMPLETED', 'CANCELLED', 'FAILED'] as const;
/** CREATED runs are queued, not yet executing: they do not count as active. */
const NON_ACTIVE_RUN_STATES = ['CREATED', ...TERMINAL_RUN_STATES] as const;
const DEFAULT_EVENT_PAGE_SIZE = 200;
/**
 * Hard safety bound for a single `eventsAfter` read. The transport/API layer
 * enforces the public page size (LIMITS.maxEventPageSize = 500); storage allows
 * larger internal reads because snapshot/export projections legitimately stream
 * a whole task event log in one call, and silently truncating it would corrupt a
 * projection. Callers above this bound must paginate.
 */
const MAX_EVENT_READ = 50_000;
/** Hard bound for a single tool-invocation/span listing read. */
const MAX_LIST_READ = 2_000;

/* ------------------------------------------------------------------ */
/* tiny SQL helpers                                                    */
/* ------------------------------------------------------------------ */

function assertIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new StorageError('internal_error', `unsafe SQL identifier: ${identifier}`);
  }
  return identifier;
}

function sqlAll(db: DatabaseSync, sql: string, params: SqlValue[] = []): SqlRow[] {
  return db.prepare(sql).all(...params) as unknown as SqlRow[];
}

function sqlGet(db: DatabaseSync, sql: string, params: SqlValue[] = []): SqlRow | undefined {
  return db.prepare(sql).get(...params) as unknown as SqlRow | undefined;
}

function sqlRun(db: DatabaseSync, sql: string, params: SqlValue[] = []): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.changes ?? 0);
}

function insertRow(db: DatabaseSync, table: string, row: DbRow): void {
  const columns = Object.keys(row);
  const sql = `INSERT INTO ${assertIdentifier(table)} (${columns
    .map(assertIdentifier)
    .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  sqlRun(
    db,
    sql,
    columns.map((column) => row[column] ?? null),
  );
}

function updateRow(db: DatabaseSync, table: string, key: DbRow, values: DbRow): number {
  const keyColumns = Object.keys(key);
  const valueColumns = Object.keys(values);
  if (valueColumns.length === 0) return 0;
  const sql =
    `UPDATE ${assertIdentifier(table)} SET ${valueColumns
      .map((column) => `${assertIdentifier(column)} = ?`)
      .join(', ')} WHERE ${keyColumns.map((column) => `${assertIdentifier(column)} = ?`).join(' AND ')}`;
  return sqlRun(db, sql, [
    ...valueColumns.map((column) => values[column] ?? null),
    ...keyColumns.map((column) => key[column] ?? null),
  ]);
}

function normalizeError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  if (error instanceof Error && error.name === 'ZodError') {
    const wrapped = new StorageError('schema_invalid', `contract validation failed: ${error.message}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && code.startsWith('SQLITE_')) {
    if (code === 'SQLITE_FULL' || code === 'SQLITE_IOERR') {
      throw new StorageError('disk_full', `database write failed: ${message}`);
    }
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      throw new StorageError('busy', `database is busy: ${message}`);
    }
    if (code === 'SQLITE_READONLY') {
      throw new StorageError('readonly', `database is read-only: ${message}`);
    }
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
      throw new StorageError('corrupt_db', `database is corrupt: ${message}`);
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      throw new StorageError('conflict', `database constraint rejected the write: ${message}`);
    }
    throw new StorageError('storage_error', `database error ${code}: ${message}`);
  }
  throw error;
}

/* ------------------------------------------------------------------ */
/* transaction context                                                 */
/* ------------------------------------------------------------------ */

interface TransactionContext {
  depth: number;
  savepoint: string;
}

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

export class SqliteStorage implements StoragePort {
  readonly mode: EngineMode;
  readonly objects: FileObjectStore;
  readonly dataDir: string;
  readonly modeDir: string;
  readonly dbPath: string;

  private db: DatabaseSync;
  private readonly workspaceName: string;
  private readonly seedSettings: WorkspaceSettings;
  private readonly txContext = new AsyncLocalStorage<TransactionContext>();
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: OpenStorageOptions) {
    if (options === null || typeof options !== 'object') {
      throw new StorageError('invalid_options', 'openStorage requires an options object');
    }
    if (options.mode !== 'demo' && options.mode !== 'live') {
      throw new StorageError('invalid_options', `unknown storage mode: ${String(options.mode)}`);
    }
    if (typeof options.dataDir !== 'string' || options.dataDir.trim() === '') {
      throw new StorageError('invalid_options', 'openStorage requires a non-empty dataDir');
    }
    if (typeof options.workspaceName !== 'string' || options.workspaceName.trim() === '') {
      throw new StorageError('invalid_options', 'openStorage requires a non-empty workspaceName');
    }
    this.mode = options.mode;
    this.dataDir = path.resolve(options.dataDir);
    this.modeDir = path.join(this.dataDir, this.mode);
    this.workspaceName = options.workspaceName;
    this.seedSettings = WorkspaceSettingsSchema.parse(options.settings ?? {});
    mkdirSync(path.join(this.modeDir, 'objects'), { recursive: true });
    this.dbPath = path.join(this.modeDir, 'cognitive-atrium.db');
    this.db = this.openDatabase();
    runMigrations(this.db);
    this.ensureWorkspaceRowSync();
    this.objects = new FileObjectStore(path.join(this.modeDir, 'objects'));
    // Synchronous startup sweep: reclaim temp files left by a crashed write.
    // Runs before any put/get this instance performs, so it cannot race them.
    this.objects.sweepTempFilesSync();
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle / diagnostics helpers (not part of StoragePort)           */
  /* ------------------------------------------------------------------ */

  /** Schema version currently recorded in the database. */
  schemaVersion(): number {
    this.assertOpen();
    return currentSchemaVersion(this.db);
  }

  diagnostics(): StorageDiagnostics {
    this.assertOpen();
    return {
      mode: this.mode,
      dataDir: this.dataDir,
      modeDir: this.modeDir,
      dbPath: this.dbPath,
      objectsDir: this.objects.root,
      schemaVersion: currentSchemaVersion(this.db),
      open: !this.closed,
    };
  }

  /** Read-only raw SQL escape hatch used by tests/diagnostics. Never used for writes. */
  rawQuery(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    this.assertOpen();
    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith('select') && !trimmed.startsWith('pragma')) {
      throw new StorageError('internal_error', 'rawQuery only supports SELECT and PRAGMA statements');
    }
    return sqlAll(this.db, sql, [...params]);
  }

  /** Current fencing token for a run lease, or null when no lease row exists. */
  fencingToken(runId: string): number | null {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT fencing_token FROM run_leases WHERE run_id = ?', [runId]);
    return row ? rowNumber(row, 'fencing_token') : null;
  }

  /** Full lease record, including expired leases (tests / recovery diagnostics). */
  leaseRecord(runId: string): RunLeaseRecord | null {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT * FROM run_leases WHERE run_id = ?', [runId]);
    if (!row) return null;
    return {
      runId: rowString(row, 'run_id'),
      owner: rowString(row, 'owner'),
      fencingToken: rowNumber(row, 'fencing_token'),
      acquiredAt: rowString(row, 'acquired_at'),
      expiresAt: rowNumber(row, 'expires_at'),
    };
  }

  /* ------------------------------------------------------------------ */
  /* workspace                                                           */
  /* ------------------------------------------------------------------ */

  async getWorkspace(): Promise<Workspace> {
    this.assertOpen();
    return this.requireWorkspace();
  }

  async ensureWorkspace(seed: { name: string; settings: WorkspaceSettings }): Promise<Workspace> {
    this.assertOpen();
    return this.transaction(async () => {
      const existing = this.workspaceRowSync();
      if (existing) return workspaceFromRow(existing);
      const settings = WorkspaceSettingsSchema.parse(seed.settings ?? {});
      const now = nowIso();
      const workspace = WorkspaceSchema.parse({
        id: newUuid(),
        mode: this.mode,
        name: seed.name,
        settings,
        createdAt: now,
        updatedAt: now,
      });
      insertRow(this.db, 'workspace', workspaceToRow(workspace, 0));
      return workspace;
    });
  }

  async updateWorkspaceSettings(
    settings: Partial<WorkspaceSettings>,
    expectedWorkspaceRevision?: number,
  ): Promise<Workspace> {
    this.assertOpen();
    return this.transaction(async () => {
      const row = this.requireWorkspaceRowSync();
      const currentRevision = rowNumber(row, 'revision');
      if (expectedWorkspaceRevision !== undefined && expectedWorkspaceRevision !== currentRevision) {
        throw new RevisionConflictError(expectedWorkspaceRevision, currentRevision);
      }
      const current = workspaceFromRow(row);
      const merged = WorkspaceSettingsSchema.parse({ ...current.settings, ...settings });
      const updated = WorkspaceSchema.parse({ ...current, settings: merged, updatedAt: nowIso() });
      updateRow(
        this.db,
        'workspace',
        { id: current.id },
        {
          name: updated.name,
          settings_json: JSON.stringify(updated.settings),
          policy_version: updated.policyVersion,
          revision: currentRevision + 1,
          updated_at: updated.updatedAt,
        },
      );
      return updated;
    });
  }

  /* ------------------------------------------------------------------ */
  /* tasks + artifact skeleton                                           */
  /* ------------------------------------------------------------------ */

  async insertTaskBundle(input: { task: Task; artifact: Artifact; modules: ArtifactModule[] }): Promise<void> {
    this.assertOpen();
    const task = TaskSchema.parse(input.task);
    const artifact = ArtifactSchema.parse(input.artifact);
    const modules = input.modules.map((module) => ArtifactModuleSchema.parse(module));
    if (task.artifactId !== artifact.id) {
      throw new StateNotAllowedError(`task ${task.id} references artifact ${task.artifactId} but bundle has ${artifact.id}`);
    }
    if (artifact.taskId !== task.id) {
      throw new StateNotAllowedError(`artifact ${artifact.id} belongs to task ${artifact.taskId}, not ${task.id}`);
    }
    if (modules.length !== artifact.moduleIds.length) {
      throw new StateNotAllowedError('task bundle must contain exactly one module per artifact.moduleIds entry');
    }
    if (new Set(artifact.moduleIds).size !== artifact.moduleIds.length) {
      throw new StateNotAllowedError('artifact.moduleIds must not contain duplicates');
    }
    const moduleIds = new Set(modules.map((module) => module.id));
    if (moduleIds.size !== modules.length) {
      throw new StateNotAllowedError('task bundle contains duplicate module ids');
    }
    for (const moduleId of artifact.moduleIds) {
      if (!moduleIds.has(moduleId)) {
        throw new StateNotAllowedError(`task bundle is missing module ${moduleId}`);
      }
    }
    for (const module of modules) {
      if (module.artifactId !== artifact.id) {
        throw new StateNotAllowedError(`module ${module.id} belongs to artifact ${module.artifactId}, not ${artifact.id}`);
      }
    }
    return this.transaction(async () => {
      const workspace = this.requireWorkspaceRowSync();
      if (task.workspaceId !== workspaceFromRow(workspace).id) {
        throw new StateNotAllowedError(`task ${task.id} belongs to a different workspace`);
      }
      insertRow(this.db, 'tasks', taskToRow(task));
      insertRow(this.db, 'artifacts', artifactToRow(artifact));
      for (const module of modules) insertRow(this.db, 'artifact_modules', moduleToRow(module));
    });
  }

  async getTask(taskId: TaskId): Promise<Task | null> {
    this.assertOpen();
    const row = this.taskRowSync(taskId);
    return row ? taskFromRow(row) : null;
  }

  async listTasks(): Promise<Task[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC').map(taskFromRow);
  }

  async getTaskAggregate(taskId: TaskId): Promise<TaskAggregate | null> {
    this.assertOpen();
    return this.transaction(async () => {
      const taskRow = this.taskRowSync(taskId);
      if (!taskRow) return null;
      const task = taskFromRow(taskRow);
      const artifactRow = this.artifactRowSync(task.artifactId);
      if (!artifactRow) {
        throw new StorageError('corrupt_row', `task ${taskId} references missing artifact ${task.artifactId}`);
      }
      const artifact = artifactFromRow(artifactRow);
      const modules = this.moduleRowsSync(artifact.id).map(moduleFromRow);
      return { task, artifact, modules };
    });
  }

  async updateTask(task: Task): Promise<void> {
    this.assertOpen();
    const normalized = TaskSchema.parse(task);
    return this.transaction(async () => {
      const changes = updateRow(this.db, 'tasks', { id: normalized.id }, taskToRow(normalized));
      if (changes === 0) throw new StorageError('not_found', `task ${normalized.id} does not exist`);
    });
  }

  async bumpTaskRevision(taskId: TaskId, expectedRevision: number): Promise<Task> {
    this.assertOpen();
    return this.transaction(async () => {
      const row = this.taskRowSync(taskId);
      if (!row) throw new StorageError('not_found', `task ${taskId} does not exist`);
      const current = taskFromRow(row);
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, current.revision);
      }
      const updated = TaskSchema.parse({ ...current, revision: expectedRevision + 1, updatedAt: nowIso() });
      updateRow(this.db, 'tasks', { id: taskId }, taskToRow(updated));
      return updated;
    });
  }

  async updateModules(modules: readonly ArtifactModule[]): Promise<void> {
    this.assertOpen();
    const normalized = modules.map((module) => ArtifactModuleSchema.parse(module));
    return this.transaction(async () => {
      for (const module of normalized) {
        const existing = this.moduleRowSync(module.id);
        if (existing) {
          if (rowString(existing, 'artifact_id') !== module.artifactId) {
            throw new StateNotAllowedError(
              `module ${module.id} belongs to artifact ${rowString(existing, 'artifact_id')} and cannot be moved to ${module.artifactId}`,
            );
          }
          updateRow(this.db, 'artifact_modules', { id: module.id }, moduleToRow(module));
        } else {
          const artifactRow = this.artifactRowSync(module.artifactId);
          if (!artifactRow) {
            throw new StorageError('not_found', `artifact ${module.artifactId} does not exist for module ${module.id}`);
          }
          insertRow(this.db, 'artifact_modules', moduleToRow(module));
        }
      }
    });
  }

  async getArtifact(artifactId: string): Promise<Artifact | null> {
    this.assertOpen();
    const row = this.artifactRowSync(artifactId);
    return row ? artifactFromRow(row) : null;
  }

  async listModules(artifactId: string): Promise<ArtifactModule[]> {
    this.assertOpen();
    return this.moduleRowsSync(artifactId).map(moduleFromRow);
  }

  async getModule(moduleId: string): Promise<ArtifactModule | null> {
    this.assertOpen();
    const row = this.moduleRowSync(moduleId);
    return row ? moduleFromRow(row) : null;
  }

  /* ------------------------------------------------------------------ */
  /* sources                                                             */
  /* ------------------------------------------------------------------ */

  async insertSource(source: SourceItem, content: Uint8Array): Promise<void> {
    this.assertOpen();
    const normalized = SourceItemSchema.parse(source);
    if (!(content instanceof Uint8Array)) {
      throw new StorageError('invalid_content', 'source content must be a Uint8Array');
    }
    if (content.byteLength > LIMITS.maxSourceFileBytes) {
      throw new StorageError(
        'payload_too_large',
        `source ${normalized.id} is ${content.byteLength} bytes which exceeds the ${LIMITS.maxSourceFileBytes} byte limit`,
      );
    }
    const actualHash = sha256Hex(content);
    if (actualHash !== normalized.hash) {
      throw new StorageError(
        'content_hash_mismatch',
        `source ${normalized.id} declares hash ${normalized.hash} but content hashes to ${actualHash}`,
      );
    }
    if (normalized.sizeBytes !== content.byteLength) {
      throw new StorageError(
        'content_hash_mismatch',
        `source ${normalized.id} declares ${normalized.sizeBytes} bytes but content has ${content.byteLength}`,
      );
    }
    // Object is written (atomically) before the DB row that references it.
    const ref = await this.objects.put(content, normalized.mime);
    if (ref.hash !== actualHash) {
      throw new StorageError('object_corrupt', 'object store returned a different content address');
    }
    return this.transaction(async () => {
      const taskRow = this.taskRowSync(normalized.taskId);
      if (!taskRow) throw new StorageError('not_found', `task ${normalized.taskId} does not exist`);
      const existing = sqlGet(this.db, 'SELECT * FROM sources WHERE id = ? AND version = ?', [
        normalized.id,
        normalized.version,
      ]);
      if (existing) {
        if (rowString(existing, 'hash') === normalized.hash && rowNumber(existing, 'size_bytes') === normalized.sizeBytes) {
          return; // idempotent replay; evidence is never overwritten
        }
        throw new StorageError(
          'conflict',
          `source ${normalized.id} version ${normalized.version} already exists with different content; create a new version`,
        );
      }
      const distinct = sqlGet(
        this.db,
        'SELECT COUNT(DISTINCT id) AS n FROM sources WHERE task_id = ?',
        [normalized.taskId],
      );
      const count = distinct ? rowNumber(distinct, 'n') : 0;
      if (count >= LIMITS.maxSourcesPerTask && existing === undefined) {
        const hasAnyVersion = sqlGet(this.db, 'SELECT id FROM sources WHERE id = ? LIMIT 1', [normalized.id]);
        if (!hasAnyVersion) {
          throw new StorageError(
            'payload_too_large',
            `task ${normalized.taskId} already has ${count} sources (limit ${LIMITS.maxSourcesPerTask})`,
          );
        }
      }
      insertRow(this.db, 'sources', sourceToRow(normalized));
    });
  }

  async getSource(taskId: TaskId, sourceId: SourceId, version?: number): Promise<SourceWithContent | null> {
    this.assertOpen();
    const row = this.sourceRowSync(taskId, sourceId, version);
    if (!row) return null;
    const source = sourceFromRow(row);
    const object = await this.objects.get(source.hash);
    if (!object) {
      throw new StorageError(
        'object_missing',
        `source ${source.id} version ${source.version} references object ${source.hash} which is missing from the store`,
      );
    }
    if (sha256Hex(object.bytes) !== source.hash) {
      throw new StorageError(
        'object_corrupt',
        `source ${source.id} version ${source.version} object content does not match its recorded hash`,
      );
    }
    return { source, content: object.bytes };
  }

  async listSources(taskId: TaskId): Promise<SourceItem[]> {
    this.assertOpen();
    return sqlAll(
      this.db,
      `SELECT s.* FROM sources s
       WHERE s.task_id = ?
         AND s.version = (SELECT MAX(s2.version) FROM sources s2 WHERE s2.id = s.id AND s2.task_id = s.task_id)
       ORDER BY s.name, s.id`,
      [taskId],
    ).map(sourceFromRow);
  }

  async listLatestSourceContents(taskId: TaskId): Promise<SourceSearchCandidate[]> {
    this.assertOpen();
    const rows = sqlAll(
      this.db,
      `SELECT s.* FROM sources s
       WHERE s.task_id = ?
         AND s.availability = 'available'
         AND s.version = (SELECT MAX(s2.version) FROM sources s2 WHERE s2.id = s.id AND s2.task_id = s.task_id)
       ORDER BY s.name, s.id`,
      [taskId],
    );
    const candidates: SourceSearchCandidate[] = [];
    for (const row of rows) {
      const source = sourceFromRow(row);
      const object = await this.objects.get(source.hash);
      if (object) candidates.push({ source, bytes: object.bytes });
    }
    return candidates;
  }

  async insertSpans(spans: readonly SourceSpan[]): Promise<void> {
    this.assertOpen();
    const normalized = spans.map((span) => SourceSpanSchema.parse(span));
    return this.transaction(async () => {
      for (const span of normalized) {
        const sourceRow = sqlGet(this.db, 'SELECT id FROM sources WHERE id = ? AND version = ? LIMIT 1', [
          span.sourceId,
          span.version,
        ]);
        if (!sourceRow) {
          throw new StorageError(
            'not_found',
            `source ${span.sourceId} version ${span.version} does not exist for span ${span.id}`,
          );
        }
        const existing = sqlGet(this.db, 'SELECT * FROM source_spans WHERE id = ?', [span.id]);
        if (existing) {
          // Idempotent upsert by span id: `source.search` retries use deterministic
          // span ids, so a replay must not fail with a UNIQUE constraint. The
          // original created_at is preserved for stable event/diff ordering.
          const row = spanToRow(span);
          row['created_at'] = rowString(existing, 'created_at');
          updateRow(this.db, 'source_spans', { id: span.id }, row);
          continue;
        }
        insertRow(this.db, 'source_spans', spanToRow(span));
      }
    });
  }

  async listSpans(taskId: TaskId, limit = 500): Promise<SourceSpan[]> {
    this.assertOpen();
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), MAX_LIST_READ)) : 500;
    return sqlAll(
      this.db,
      `SELECT sp.* FROM source_spans sp
       JOIN sources s ON s.id = sp.source_id AND s.version = sp.version
       WHERE s.task_id = ?
       ORDER BY sp.created_at ASC, sp.id ASC
       LIMIT ?`,
      [taskId, bounded],
    ).map(spanFromRow);
  }

  async markSourcesMissing(sourceIds: readonly string[]): Promise<void> {
    this.assertOpen();
    if (sourceIds.length === 0) return;
    return this.transaction(async () => {
      for (const sourceId of sourceIds) {
        sqlRun(this.db, "UPDATE sources SET availability = 'missing' WHERE id = ?", [sourceId]);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* artifact versions                                                   */
  /* ------------------------------------------------------------------ */

  async insertVersion(version: ArtifactVersion): Promise<void> {
    this.assertOpen();
    const normalized = ArtifactVersionSchema.parse(version);
    return this.transaction(async () => {
      this.guardVersionInsertSync(normalized);
    });
  }

  async getVersion(versionId: string): Promise<ArtifactVersion | null> {
    this.assertOpen();
    const row = this.versionRowSync(versionId);
    return row ? versionFromRow(row) : null;
  }

  async getAcceptedVersion(moduleId: string): Promise<ArtifactVersion | null> {
    this.assertOpen();
    const moduleRow = this.moduleRowSync(moduleId);
    if (!moduleRow) return null;
    const acceptedVersionId = moduleRow['accepted_version_id'];
    if (typeof acceptedVersionId !== 'string') return null;
    const row = this.versionRowSync(acceptedVersionId);
    return row ? versionFromRow(row) : null;
  }

  async listVersions(moduleId: string): Promise<ArtifactVersion[]> {
    this.assertOpen();
    return sqlAll(
      this.db,
      'SELECT * FROM artifact_versions WHERE module_id = ? ORDER BY accepted_at ASC, rowid ASC',
      [moduleId],
    ).map(versionFromRow);
  }

  /* ------------------------------------------------------------------ */
  /* runs + steps                                                        */
  /* ------------------------------------------------------------------ */

  async insertRun(run: Run): Promise<void> {
    this.assertOpen();
    const normalized = RunSchema.parse(run);
    if (normalized.mode !== this.mode) {
      throw new StateNotAllowedError(
        `run ${normalized.id} belongs to ${normalized.mode} mode but this database is ${this.mode}; demo and live runs never mix`,
      );
    }
    return this.transaction(async () => {
      const taskRow = this.taskRowSync(normalized.taskId);
      if (!taskRow) {
        throw new StorageError('not_found', `task ${normalized.taskId} does not exist for run ${normalized.id}`);
      }
      const task = taskFromRow(taskRow);
      const moduleRow = this.moduleRowSync(normalized.moduleId);
      if (!moduleRow) {
        throw new StorageError('not_found', `module ${normalized.moduleId} does not exist for run ${normalized.id}`);
      }
      if (rowString(moduleRow, 'artifact_id') !== task.artifactId) {
        throw new StateNotAllowedError(
          `run ${normalized.id} targets module ${normalized.moduleId} which is not part of task ${task.id}`,
        );
      }
      insertRow(this.db, 'runs', runToRow(normalized));
    });
  }

  async getRun(runId: string): Promise<Run | null> {
    this.assertOpen();
    const row = this.runRowSync(runId);
    return row ? runFromRow(row) : null;
  }

  async updateRun(run: Run, expectedRevision?: number): Promise<Run> {
    this.assertOpen();
    const normalized = RunSchema.parse(run);
    if (normalized.mode !== this.mode) {
      throw new StateNotAllowedError(
        `run ${normalized.id} belongs to ${normalized.mode} mode but this database is ${this.mode}`,
      );
    }
    return this.transaction(async () => {
      const existing = this.runRowSync(normalized.id);
      if (!existing) throw new StorageError('not_found', `run ${normalized.id} does not exist`);
      let persisted = normalized;
      if (expectedRevision !== undefined) {
        const actual = rowNumber(existing, 'revision');
        if (actual !== expectedRevision) throw new RevisionConflictError(expectedRevision, actual);
        persisted = RunSchema.parse({ ...normalized, revision: expectedRevision + 1 });
      }
      updateRow(this.db, 'runs', { id: persisted.id }, runToRow(persisted));
      return persisted;
    });
  }

  async listRuns(taskId: TaskId): Promise<Run[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', [taskId]).map(
      runFromRow,
    );
  }

  async findActiveRunId(taskId: TaskId): Promise<string | null> {
    this.assertOpen();
    const row = sqlGet(
      this.db,
      `SELECT id FROM runs WHERE task_id = ? AND state NOT IN (${NON_ACTIVE_RUN_STATES.map(() => '?').join(', ')})
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      [taskId, ...NON_ACTIVE_RUN_STATES],
    );
    return row ? rowString(row, 'id') : null;
  }

  async countActiveRuns(): Promise<number> {
    this.assertOpen();
    const row = sqlGet(
      this.db,
      `SELECT COUNT(*) AS n FROM runs WHERE state NOT IN (${NON_ACTIVE_RUN_STATES.map(() => '?').join(', ')})`,
      [...NON_ACTIVE_RUN_STATES],
    );
    return row ? rowNumber(row, 'n') : 0;
  }

  async listQueuedRuns(): Promise<Run[]> {
    this.assertOpen();
    // A queued run is any non-terminal run carrying a visible queue position; it
    // may be CREATED (plan not finished) or READY (plan committed, waiting for
    // global capacity). The server scheduler only launches READY entries.
    return sqlAll(
      this.db,
      `SELECT * FROM runs WHERE queue_position IS NOT NULL
         AND state NOT IN (${TERMINAL_RUN_STATES.map(() => '?').join(', ')})
       ORDER BY queue_position ASC, created_at ASC, rowid ASC`,
      [...TERMINAL_RUN_STATES],
    ).map(runFromRow);
  }

  async updateRunStateIfRevision(runId: string, expectedRevision: number, next: Run): Promise<Run> {
    this.assertOpen();
    const normalized = RunSchema.parse(next);
    if (normalized.mode !== this.mode) {
      throw new StateNotAllowedError(
        `run ${normalized.id} belongs to ${normalized.mode} mode but this database is ${this.mode}`,
      );
    }
    return this.transaction(async () => {
      const existing = this.runRowSync(runId);
      if (!existing) throw new StorageError('not_found', `run ${runId} does not exist`);
      const actual = rowNumber(existing, 'revision');
      if (actual !== expectedRevision) throw new RevisionConflictError(expectedRevision, actual);
      if (normalized.id !== runId) {
        throw new StateNotAllowedError(`updateRunStateIfRevision: run id mismatch (${normalized.id} vs ${runId})`);
      }
      const persisted = RunSchema.parse({ ...normalized, revision: expectedRevision + 1 });
      updateRow(this.db, 'runs', { id: runId }, runToRow(persisted));
      return persisted;
    });
  }

  async insertStep(step: Step): Promise<void> {
    this.assertOpen();
    const normalized = StepSchema.parse(step);
    return this.transaction(async () => {
      if (!this.runRowSync(normalized.runId)) {
        throw new StorageError('not_found', `run ${normalized.runId} does not exist for step ${normalized.id}`);
      }
      insertRow(this.db, 'steps', stepToRow(normalized));
    });
  }

  async updateStep(step: Step): Promise<void> {
    this.assertOpen();
    const normalized = StepSchema.parse(step);
    return this.transaction(async () => {
      const changes = updateRow(this.db, 'steps', { id: normalized.id }, stepToRow(normalized));
      if (changes === 0) throw new StorageError('not_found', `step ${normalized.id} does not exist`);
    });
  }

  async listSteps(runId: string): Promise<Step[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM steps WHERE run_id = ? ORDER BY rowid ASC', [runId]).map(stepFromRow);
  }

  /* ------------------------------------------------------------------ */
  /* checkpoints                                                         */
  /* ------------------------------------------------------------------ */

  async insertCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    this.assertOpen();
    const normalized = RunCheckpointSchema.parse(checkpoint);
    return this.transaction(async () => {
      if (!this.runRowSync(normalized.runId)) {
        throw new StorageError('not_found', `run ${normalized.runId} does not exist for checkpoint ${normalized.id}`);
      }
      const existing = sqlGet(this.db, 'SELECT * FROM run_checkpoints WHERE id = ?', [normalized.id]);
      if (existing) {
        const same =
          rowString(existing, 'run_id') === normalized.runId &&
          rowString(existing, 'kind') === normalized.kind &&
          rowNumber(existing, 'seq_at_checkpoint') === normalized.seqAtCheckpoint &&
          rowString(existing, 'data_json') === normalized.dataJson;
        if (same) return;
        throw new StorageError('conflict', `checkpoint ${normalized.id} already exists with different content`);
      }
      insertRow(this.db, 'run_checkpoints', checkpointToRow(normalized));
    });
  }

  async getCheckpoint(checkpointId: string): Promise<RunCheckpoint | null> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT * FROM run_checkpoints WHERE id = ?', [checkpointId]);
    return row ? checkpointFromRow(row) : null;
  }

  async latestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    this.assertOpen();
    const row = sqlGet(
      this.db,
      'SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY seq_at_checkpoint DESC, rowid DESC LIMIT 1',
      [runId],
    );
    return row ? checkpointFromRow(row) : null;
  }

  /* ------------------------------------------------------------------ */
  /* blockers + decisions                                                */
  /* ------------------------------------------------------------------ */

  async insertBlocker(blocker: Blocker): Promise<void> {
    this.assertOpen();
    const normalized = BlockerSchema.parse(blocker);
    return this.transaction(async () => {
      if (!this.taskRowSync(normalized.taskId)) {
        throw new StorageError('not_found', `task ${normalized.taskId} does not exist for blocker ${normalized.id}`);
      }
      this.requireRunForTaskSync(normalized.runId, normalized.taskId);
      insertRow(this.db, 'blockers', blockerToRow(normalized));
    });
  }

  async updateBlocker(blocker: Blocker): Promise<void> {
    this.assertOpen();
    const normalized = BlockerSchema.parse(blocker);
    return this.transaction(async () => {
      const changes = updateRow(this.db, 'blockers', { id: normalized.id }, blockerToRow(normalized));
      if (changes === 0) throw new StorageError('not_found', `blocker ${normalized.id} does not exist`);
    });
  }

  async getBlocker(blockerId: string): Promise<Blocker | null> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT * FROM blockers WHERE id = ?', [blockerId]);
    return row ? blockerFromRow(row) : null;
  }

  async listBlockers(taskId: TaskId): Promise<Blocker[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM blockers WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', [
      taskId,
    ]).map(blockerFromRow);
  }

  async insertDecision(decision: Decision): Promise<void> {
    this.assertOpen();
    const normalized = DecisionSchema.parse(decision);
    return this.transaction(async () => {
      if (!this.taskRowSync(normalized.taskId)) {
        throw new StorageError('not_found', `task ${normalized.taskId} does not exist for decision ${normalized.id}`);
      }
      this.requireRunForTaskSync(normalized.runId, normalized.taskId);
      insertRow(this.db, 'decisions', decisionToRow(normalized));
    });
  }

  async listDecisions(taskId: TaskId): Promise<Decision[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', [
      taskId,
    ]).map(decisionFromRow);
  }

  /* ------------------------------------------------------------------ */
  /* patches + validation                                                */
  /* ------------------------------------------------------------------ */

  async insertPatch(patch: PatchProposal): Promise<void> {
    this.assertOpen();
    const normalized = PatchProposalSchema.parse(patch);
    return this.transaction(async () => {
      if (!this.taskRowSync(normalized.taskId)) {
        throw new StorageError('not_found', `task ${normalized.taskId} does not exist for patch ${normalized.id}`);
      }
      this.requireRunForTaskSync(normalized.runId, normalized.taskId);
      insertRow(this.db, 'patches', patchToRow(normalized));
    });
  }

  async getPatch(patchId: string): Promise<PatchProposal | null> {
    this.assertOpen();
    const row = this.patchRowSync(patchId);
    return row ? patchFromRow(row) : null;
  }

  async updatePatch(patch: PatchProposal): Promise<void> {
    this.assertOpen();
    const normalized = PatchProposalSchema.parse(patch);
    return this.transaction(async () => {
      const changes = updateRow(this.db, 'patches', { id: normalized.id }, patchToRow(normalized));
      if (changes === 0) throw new StorageError('not_found', `patch ${normalized.id} does not exist`);
    });
  }

  async listPatches(taskId: TaskId): Promise<PatchProposal[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM patches WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', [
      taskId,
    ]).map(patchFromRow);
  }

  async insertValidationReport(report: ValidationReport): Promise<void> {
    this.assertOpen();
    const normalized = ValidationReportSchema.parse(report);
    return this.transaction(async () => {
      if (!this.taskRowSync(normalized.taskId)) {
        throw new StorageError('not_found', `task ${normalized.taskId} does not exist for validation report ${normalized.id}`);
      }
      this.requireRunForTaskSync(normalized.runId, normalized.taskId);
      insertRow(this.db, 'validation_reports', validationReportToRow(normalized));
    });
  }

  async getValidationReport(reportId: string): Promise<ValidationReport | null> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT * FROM validation_reports WHERE id = ?', [reportId]);
    return row ? validationReportFromRow(row) : null;
  }

  async listValidationReports(taskId: TaskId): Promise<ValidationReport[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM validation_reports WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', [
      taskId,
    ]).map(validationReportFromRow);
  }

  /* ------------------------------------------------------------------ */
  /* context snapshots                                                   */
  /* ------------------------------------------------------------------ */

  async insertContextSnapshot(snapshot: ContextSnapshot): Promise<void> {
    this.assertOpen();
    const normalized = ContextSnapshotSchema.parse(snapshot);
    return this.transaction(async () => {
      if (!this.taskRowSync(normalized.taskId)) {
        throw new StorageError('not_found', `task ${normalized.taskId} does not exist for context snapshot ${normalized.id}`);
      }
      this.requireRunForTaskSync(normalized.runId, normalized.taskId);
      insertRow(this.db, 'context_snapshots', contextSnapshotToRow(normalized));
    });
  }

  async getContextSnapshot(id: string): Promise<ContextSnapshot | null> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT * FROM context_snapshots WHERE id = ?', [id]);
    return row ? contextSnapshotFromRow(row) : null;
  }

  /* ------------------------------------------------------------------ */
  /* tool invocations                                                    */
  /* ------------------------------------------------------------------ */

  async insertToolInvocation(record: ToolInvocationRecord): Promise<void> {
    this.assertOpen();
    const normalized = ToolInvocationRecordSchema.parse(record);
    return this.transaction(async () => {
      if (!this.runRowSync(normalized.runId)) {
        throw new StorageError('not_found', `run ${normalized.runId} does not exist for tool invocation ${normalized.toolCallId}`);
      }
      insertRow(this.db, 'tool_invocations', toolInvocationToRow(normalized));
    });
  }

  async updateToolInvocation(record: ToolInvocationRecord): Promise<void> {
    this.assertOpen();
    const normalized = ToolInvocationRecordSchema.parse(record);
    return this.transaction(async () => {
      const changes = updateRow(this.db, 'tool_invocations', { tool_call_id: normalized.toolCallId }, toolInvocationToRow(normalized));
      if (changes === 0) throw new StorageError('not_found', `tool invocation ${normalized.toolCallId} does not exist`);
    });
  }

  async listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY planned_at ASC, rowid ASC', [
      runId,
    ]).map(toolInvocationFromRow);
  }

  async findUnclearToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    this.assertOpen();
    return sqlAll(
      this.db,
      `SELECT * FROM tool_invocations
       WHERE run_id = ? AND (status = 'started' OR status = 'outcome_unknown')
       ORDER BY planned_at ASC, rowid ASC`,
      [runId],
    ).map(toolInvocationFromRow);
  }

  /* ------------------------------------------------------------------ */
  /* recipes                                                             */
  /* ------------------------------------------------------------------ */

  async insertRecipe(recipe: Recipe): Promise<void> {
    this.assertOpen();
    const normalized = RecipeSchema.parse(recipe);
    return this.transaction(async () => {
      if (!this.taskRowSync(normalized.sourceTaskId)) {
        throw new StorageError('not_found', `source task ${normalized.sourceTaskId} does not exist for recipe ${normalized.id}`);
      }
      const existing = sqlGet(this.db, 'SELECT id FROM recipes WHERE id = ? AND version = ?', [
        normalized.id,
        normalized.version,
      ]);
      if (existing) {
        throw new StorageError('conflict', `recipe ${normalized.id} version ${normalized.version} already exists`);
      }
      insertRow(this.db, 'recipes', recipeToRow(normalized));
    });
  }

  async getRecipe(recipeId: string): Promise<Recipe | null> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT * FROM recipes WHERE id = ? ORDER BY version DESC LIMIT 1', [recipeId]);
    return row ? recipeFromRow(row) : null;
  }

  async listRecipes(taskId?: TaskId): Promise<Recipe[]> {
    this.assertOpen();
    const sql = `SELECT r.* FROM recipes r
      WHERE r.version = (SELECT MAX(r2.version) FROM recipes r2 WHERE r2.id = r.id)
      ${taskId === undefined ? '' : 'AND r.source_task_id = ?'}
      ORDER BY r.updated_at DESC, r.id ASC`;
    return sqlAll(this.db, sql, taskId === undefined ? [] : [taskId]).map(recipeFromRow);
  }

  async nextRecipeVersion(recipeId: string): Promise<number> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT COALESCE(MAX(version), 0) AS v FROM recipes WHERE id = ?', [recipeId]);
    return (row ? rowNumber(row, 'v') : 0) + 1;
  }

  async updateRecipe(recipe: Recipe): Promise<void> {
    this.assertOpen();
    const normalized = RecipeSchema.parse(recipe);
    return this.transaction(async () => {
      const changes = updateRow(this.db, 'recipes', { id: normalized.id, version: normalized.version }, recipeToRow(normalized));
      if (changes === 0) {
        throw new StorageError('not_found', `recipe ${normalized.id} version ${normalized.version} does not exist`);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* provider profiles                                                   */
  /* ------------------------------------------------------------------ */

  async listProviderProfiles(): Promise<ProviderProfile[]> {
    this.assertOpen();
    return sqlAll(this.db, 'SELECT * FROM provider_profiles ORDER BY profile_name ASC, id ASC').map(providerProfileFromRow);
  }

  async getProviderProfile(id: string): Promise<ProviderProfile | null> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT * FROM provider_profiles WHERE id = ?', [id]);
    return row ? providerProfileFromRow(row) : null;
  }

  async upsertProviderProfile(profile: ProviderProfile): Promise<void> {
    this.assertOpen();
    const normalized = ProviderProfileSchema.parse(profile);
    return this.transaction(async () => {
      const existing = sqlGet(this.db, 'SELECT * FROM provider_profiles WHERE id = ?', [normalized.id]);
      const row = providerProfileToRow(normalized);
      if (existing) {
        // created_at is immutable for a profile row; the caller only owns the update fields.
        row['created_at'] = rowString(existing, 'created_at');
        updateRow(this.db, 'provider_profiles', { id: normalized.id }, row);
      } else {
        insertRow(this.db, 'provider_profiles', row);
      }
    });
  }

  async deleteProviderProfile(id: string): Promise<void> {
    this.assertOpen();
    return this.transaction(async () => {
      sqlRun(this.db, 'DELETE FROM provider_profiles WHERE id = ?', [id]);
    });
  }

  /* ------------------------------------------------------------------ */
  /* event stream                                                        */
  /* ------------------------------------------------------------------ */

  async appendEvents(taskId: TaskId, drafts: readonly EventDraft[]): Promise<HarnessEvent[]> {
    this.assertOpen();
    if (!Array.isArray(drafts) || drafts.length === 0) return [];
    return this.transaction(async () => this.appendEventsSync(taskId, drafts));
  }

  async eventsAfter(taskId: TaskId, seq: number, limit?: number): Promise<HarnessEvent[]> {
    this.assertOpen();
    const after = Number.isFinite(seq) ? Math.max(0, Math.trunc(seq)) : 0;
    const requested = limit ?? DEFAULT_EVENT_PAGE_SIZE;
    const pageSize = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.trunc(requested), MAX_EVENT_READ))
      : DEFAULT_EVENT_PAGE_SIZE;
    return sqlAll(
      this.db,
      'SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      [taskId, after, pageSize],
    ).map(eventFromRow);
  }

  async latestSeq(taskId: TaskId): Promise<number> {
    this.assertOpen();
    return this.latestSeqSync(taskId);
  }

  async eventCount(taskId: TaskId): Promise<number> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT COUNT(*) AS n FROM events WHERE task_id = ?', [taskId]);
    return row ? rowNumber(row, 'n') : 0;
  }

  /* ------------------------------------------------------------------ */
  /* idempotency                                                         */
  /* ------------------------------------------------------------------ */

  async getCommandResult(commandId: CommandId): Promise<Record<string, unknown> | null> {
    this.assertOpen();
    const row = sqlGet(this.db, 'SELECT response_json FROM command_results WHERE command_id = ?', [commandId]);
    if (!row) return null;
    const raw = rowString(row, 'response_json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StorageError('corrupt_row', `command result ${commandId} is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new StorageError('corrupt_row', `command result ${commandId} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }

  async saveCommandResult(
    commandId: CommandId,
    commandType: string,
    taskId: TaskId | null,
    response: Record<string, unknown>,
  ): Promise<void> {
    this.assertOpen();
    return this.transaction(async () => {
      const existing = sqlGet(this.db, 'SELECT command_id FROM command_results WHERE command_id = ?', [commandId]);
      if (existing) return; // idempotent: the first committed response wins
      let responseJson: string;
      try {
        responseJson = JSON.stringify(response);
      } catch (error) {
        throw new StorageError('invalid_response', `command response is not JSON serializable: ${(error as Error).message}`);
      }
      if (typeof responseJson !== 'string') {
        throw new StorageError('invalid_response', 'command response is not JSON serializable');
      }
      const parsed: unknown = JSON.parse(responseJson);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new StorageError('invalid_response', 'command response must be a JSON object');
      }
      const now = nowIso();
      insertRow(this.db, 'command_results', {
        command_id: commandId,
        command_type: commandType,
        task_id: taskId,
        response_json: responseJson,
        created_at: now,
        updated_at: now,
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* atomic acceptance commit                                            */
  /* ------------------------------------------------------------------ */

  async commitAcceptance(input: CommitAcceptanceInput): Promise<CommitAcceptanceResult> {
    this.assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new StorageError('invalid_options', 'commitAcceptance requires an input object');
    }
    const version = ArtifactVersionSchema.parse(input.version);
    const updatedModules = (input.updatedModules ?? []).map((module) => ArtifactModuleSchema.parse(module));
    return this.transaction(async () => {
      const taskRow = this.taskRowSync(input.taskId);
      if (!taskRow) throw new StorageError('not_found', `task ${input.taskId} does not exist`);
      const task = taskFromRow(taskRow);
      if (task.revision !== input.expectedTaskRevision) {
        throw new RevisionConflictError(input.expectedTaskRevision, task.revision);
      }
      const artifactRow = this.artifactRowSync(input.artifact.id);
      if (!artifactRow) {
        throw new StorageError('not_found', `artifact ${input.artifact.id} does not exist`);
      }
      if (rowString(artifactRow, 'task_id') !== task.id) {
        throw new StateNotAllowedError(`artifact ${input.artifact.id} does not belong to task ${task.id}`);
      }
      if (version.artifactId !== input.artifact.id) {
        throw new StateNotAllowedError(`version ${version.id} targets artifact ${version.artifactId}, not ${input.artifact.id}`);
      }
      const moduleRow = this.moduleRowSync(version.moduleId);
      if (!moduleRow) {
        throw new StateNotAllowedError(`module ${version.moduleId} does not exist`);
      }
      if (rowString(moduleRow, 'artifact_id') !== input.artifact.id) {
        throw new StateNotAllowedError(`module ${version.moduleId} does not belong to artifact ${input.artifact.id}`);
      }
      const currentAccepted = moduleRow['accepted_version_id'];
      const expectedBase = version.baseVersionId;
      if ((currentAccepted ?? null) !== (expectedBase ?? null)) {
        throw new VersionConflictError(
          `module ${version.moduleId} accepted version is ${String(currentAccepted)} but the change was generated against ${String(expectedBase)}; regenerate the diff or merge manually`,
        );
      }
      if (expectedBase !== null) {
        const baseRow = this.versionRowSync(expectedBase);
        if (!baseRow) {
          throw new VersionConflictError(`base version ${expectedBase} does not exist`);
        }
      }
      if (this.versionRowSync(version.id)) {
        throw new VersionConflictError(`version ${version.id} already exists; accepted versions are immutable`);
      }
      const patchRow = input.patchId ? this.patchRowSync(input.patchId) : undefined;
      const patch = patchRow ? patchFromRow(patchRow) : null;
      if (patch) {
        if (patch.moduleId !== version.moduleId) {
          throw new StateNotAllowedError(`patch ${patch.id} targets module ${patch.moduleId}, not ${version.moduleId}`);
        }
        if (patch.status !== 'proposed') {
          throw new StateNotAllowedError(`patch ${patch.id} is ${patch.status} and can no longer be accepted`);
        }
      }
      for (const module of updatedModules) {
        if (module.artifactId !== input.artifact.id) {
          throw new StateNotAllowedError(`module ${module.id} does not belong to artifact ${input.artifact.id}`);
        }
      }

      const now = nowIso();
      // 1. immutable version
      insertRow(this.db, 'artifact_versions', versionToRow(version));
      // 2. artifact pointer
      const artifact = ArtifactSchema.parse({
        ...input.artifact,
        taskId: task.id,
        acceptedVersionId: version.id,
        updatedAt: now,
      });
      if (!artifact.moduleIds.includes(version.moduleId)) {
        throw new StateNotAllowedError(`artifact ${artifact.id} does not list module ${version.moduleId}`);
      }
      updateRow(this.db, 'artifacts', { id: artifact.id }, artifactToRow(artifact));
      // 3. module states; the accepted module is always updated even if the caller omitted it
      const byId = new Map(updatedModules.map((module) => [module.id, module]));
      const acceptedModule = ArtifactModuleSchema.parse({
        ...(byId.get(version.moduleId) ?? moduleFromRow(moduleRow)),
        acceptedVersionId: version.id,
        status: 'accepted',
        updatedAt: now,
      });
      byId.set(acceptedModule.id, acceptedModule);
      for (const module of byId.values()) {
        const existing = this.moduleRowSync(module.id);
        if (existing) updateRow(this.db, 'artifact_modules', { id: module.id }, moduleToRow(module));
        else insertRow(this.db, 'artifact_modules', moduleToRow(module));
      }
      // 4. patch bookkeeping (tolerant when the caller has no patch row, e.g. restore)
      if (patch) {
        const acceptedPatch = PatchProposalSchema.parse({
          ...patch,
          status: 'accepted',
          acceptedVersionId: version.id,
        });
        updateRow(this.db, 'patches', { id: acceptedPatch.id }, patchToRow(acceptedPatch));
      }
      // 5. task revision bump (CAS re-checked above)
      const nextTask = TaskSchema.parse({ ...task, revision: input.expectedTaskRevision + 1, updatedAt: now });
      updateRow(this.db, 'tasks', { id: nextTask.id }, taskToRow(nextTask));
      // 6. business events, in the same transaction as all of the above
      const events = this.appendEventsSync(input.taskId, input.events ?? []);
      return {
        version: versionFromRow(this.requireVersionRowSync(version.id)),
        artifact: artifactFromRow(this.requireArtifactRowSync(artifact.id)),
        taskRevision: nextTask.revision,
        events,
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* recovery: run leases                                                */
  /* ------------------------------------------------------------------ */

  async acquireRunLease(runId: string, owner: string, ttlMs: number): Promise<boolean> {
    this.assertOpen();
    if (typeof owner !== 'string' || owner.trim() === '') {
      throw new StorageError('invalid_options', 'acquireRunLease requires a non-empty owner');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new StorageError('invalid_options', 'acquireRunLease requires a positive ttl');
    }
    return this.transaction(async () => {
      const now = Date.now();
      const nowText = new Date(now).toISOString();
      const existing = this.leaseRowSync(runId);
      if (!existing) {
        insertRow(this.db, 'run_leases', {
          run_id: runId,
          owner,
          fencing_token: 1,
          acquired_at: nowText,
          expires_at: now + Math.trunc(ttlMs),
          updated_at: nowText,
        });
        return true;
      }
      const expiresAt = rowNumber(existing, 'expires_at');
      const currentOwner = rowString(existing, 'owner');
      const fencingToken = rowNumber(existing, 'fencing_token');
      if (expiresAt <= now) {
        // Previous holder is gone: hand ownership to the new owner with a new fence.
        updateRow(
          this.db,
          'run_leases',
          { run_id: runId },
          {
            owner,
            fencing_token: fencingToken + 1,
            acquired_at: nowText,
            expires_at: now + Math.trunc(ttlMs),
            updated_at: nowText,
          },
        );
        return true;
      }
      if (currentOwner === owner) {
        // Re-acquire by the holder extends the lease but keeps the same fence.
        updateRow(this.db, 'run_leases', { run_id: runId }, { expires_at: now + Math.trunc(ttlMs), updated_at: nowText });
        return true;
      }
      return false;
    });
  }

  async renewRunLease(runId: string, owner: string, ttlMs: number): Promise<boolean> {
    this.assertOpen();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new StorageError('invalid_options', 'renewRunLease requires a positive ttl');
    }
    return this.transaction(async () => {
      const existing = this.leaseRowSync(runId);
      if (!existing) return false;
      const now = Date.now();
      if (rowString(existing, 'owner') !== owner) return false;
      if (rowNumber(existing, 'expires_at') <= now) return false;
      updateRow(
        this.db,
        'run_leases',
        { run_id: runId },
        { expires_at: now + Math.trunc(ttlMs), updated_at: new Date(now).toISOString() },
      );
      return true;
    });
  }

  async releaseRunLease(runId: string, owner: string): Promise<void> {
    this.assertOpen();
    return this.transaction(async () => {
      // Keep a tombstone row (expires_at = 0) instead of DELETE so the fencing
      // token stays monotonic for the lifetime of the database; a released lease
      // is simply expired and the next owner receives token + 1.
      sqlRun(
        this.db,
        'UPDATE run_leases SET expires_at = 0, updated_at = ? WHERE run_id = ? AND owner = ?',
        [new Date().toISOString(), runId, owner],
      );
    });
  }

  async listLeaseOwner(runId: string): Promise<string | null> {
    this.assertOpen();
    const existing = this.leaseRowSync(runId);
    if (!existing) return null;
    if (rowNumber(existing, 'expires_at') <= Date.now()) return null;
    return rowString(existing, 'owner');
  }

  /* ------------------------------------------------------------------ */
  /* maintenance                                                         */
  /* ------------------------------------------------------------------ */

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (typeof fn !== 'function') {
      throw new StorageError('invalid_options', 'transaction requires a callback');
    }
    const context = this.txContext.getStore();
    if (context) return this.nestedTransaction(context, fn);
    return this.withWriteLock(() => this.outerTransaction(fn));
  }

  async resetDemoData(): Promise<void> {
    this.assertOpen();
    this.assertNotInTransaction('resetDemoData');
    if (this.mode !== 'demo') {
      throw new StateNotAllowedError('resetDemoData is only allowed for the demo database; live data is never reset');
    }
    await this.withWriteLock(async () => {
      // Preserve the workspace identity/settings across the reset: callers (the
      // demo seeder, an open UI session) hold the workspace id and a reset must
      // not invalidate it. Only business data, events, leases and objects go.
      const workspaceRow = this.requireWorkspaceRowSync();
      const workspace = workspaceFromRow(workspaceRow);
      const workspaceRevision = rowNumber(workspaceRow, 'revision');
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort before closing */
      }
      this.db.close();
      for (const suffix of ['', '-wal', '-shm']) {
        await fs.rm(`${this.dbPath}${suffix}`, { force: true });
      }
      await fs.rm(path.join(this.modeDir, 'objects'), { recursive: true, force: true });
      mkdirSync(path.join(this.modeDir, 'objects'), { recursive: true });
      this.db = this.openDatabase();
      runMigrations(this.db);
      insertRow(this.db, 'workspace', workspaceToRow(workspace, workspaceRevision));
    });
  }

  async backupTo(destinationDir: string): Promise<string> {
    this.assertOpen();
    this.assertNotInTransaction('backupTo');
    if (typeof destinationDir !== 'string' || destinationDir.trim() === '') {
      throw new StorageError('invalid_options', 'backupTo requires a destination directory');
    }
    return this.withWriteLock(async () => {
      const destination = path.resolve(destinationDir);
      const relativeToMode = path.relative(this.modeDir, destination);
      if (
        relativeToMode === '' ||
        (!relativeToMode.startsWith('..') && !path.isAbsolute(relativeToMode))
      ) {
        throw new StorageError(
          'invalid_path',
          'backup destination must be outside the live mode directory (never overwrite the running database)',
        );
      }
      await fs.mkdir(destination, { recursive: true });
      // Flush the WAL so the main database file is a complete snapshot. We hold
      // the write lock, so no concurrent storage call can add frames mid-copy.
      const checkpoint = sqlGet(this.db, 'PRAGMA wal_checkpoint(TRUNCATE)');
      if (checkpoint && rowNumber(checkpoint, 'busy') !== 0) {
        throw new StorageError('backup_failed', 'could not complete WAL checkpoint; database is busy');
      }
      const dbCopyName = 'cognitive-atrium.db';
      const dbCopyPath = path.join(destination, dbCopyName);
      await fs.copyFile(this.dbPath, dbCopyPath);
      for (const suffix of ['-wal', '-shm']) {
        const sourcePath = `${this.dbPath}${suffix}`;
        const stat = await fs.stat(sourcePath).catch(() => null);
        if (stat && stat.size > 0) {
          await fs.copyFile(sourcePath, path.join(destination, `${dbCopyName}${suffix}`));
        }
      }
      const dbBytes = await fs.readFile(dbCopyPath);
      const dbSha256 = createHash('sha256').update(dbBytes).digest('hex');

      const objects = await this.objects.listObjects();
      const objectsRoot = path.join(destination, 'objects');
      await fs.mkdir(objectsRoot, { recursive: true });
      const manifestObjects: Array<{ hash: string; sizeBytes: number; mime: string; file: string }> = [];
      for (const object of objects) {
        const relative = path.relative(this.objects.root, object.path);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new StorageError('internal_error', 'object path escaped the store root during backup');
        }
        const target = path.join(objectsRoot, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(object.path, target);
        const sidecarSource = `${object.path}.meta.json`;
        const sidecarStat = await fs.stat(sidecarSource).catch(() => null);
        if (sidecarStat && sidecarStat.isFile()) {
          await fs.copyFile(sidecarSource, `${target}.meta.json`);
        }
        manifestObjects.push({
          hash: object.hash,
          sizeBytes: object.sizeBytes,
          mime: object.mime,
          file: path.posix.join('objects', relative.split(path.sep).join('/')),
        });
      }
      const manifest = {
        kind: 'cognitive-atrium-backup',
        formatVersion: 1,
        createdAt: nowIso(),
        mode: this.mode,
        policyVersion: this.requireWorkspace().policyVersion,
        schemaVersion: currentSchemaVersion(this.db),
        database: {
          file: dbCopyName,
          sizeBytes: dbBytes.byteLength,
          sha256: dbSha256,
        },
        objects: {
          count: manifestObjects.length,
          totalBytes: manifestObjects.reduce((sum, object) => sum + object.sizeBytes, 0),
          entries: manifestObjects,
        },
      };
      const manifestPath = path.join(destination, 'manifest.json');
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const manifestHandle = await fs.open(manifestPath, 'r+');
      try {
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
      return manifestPath;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.assertNotInTransaction('close');
    await this.withWriteLock(async () => {
      if (this.closed) return;
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort; close anyway */
      }
      this.db.close();
      this.closed = true;
    });
  }

  /* ------------------------------------------------------------------ */
  /* internals: lifecycle                                                */
  /* ------------------------------------------------------------------ */

  private openDatabase(): DatabaseSync {
    const db = new DatabaseSyncCtor(this.dbPath, { enableForeignKeyConstraints: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    return db;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', 'storage has been closed');
    }
  }

  private assertNotInTransaction(operation: string): void {
    if (this.txContext.getStore()) {
      throw new StateNotAllowedError(
        `${operation} cannot run inside a storage transaction; commit or roll back first`,
      );
    }
  }

  private async withWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async outerTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.txContext.run({ depth: 0, savepoint: '' }, async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* the transaction may already have been rolled back by SQLite */
        }
        normalizeError(error);
      }
    });
  }

  private async nestedTransaction<T>(parent: TransactionContext, fn: () => Promise<T>): Promise<T> {
    const depth = parent.depth + 1;
    const savepoint = `ca_sp_${depth}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    return this.txContext.run({ depth, savepoint }, async () => {
      try {
        const result = await fn();
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } catch {
          /* outer transaction will roll back */
        }
        normalizeError(error);
      }
    });
  }

  private requireWorkspaceRowSync(): SqlRow {
    const row = this.workspaceRowSync();
    if (!row) throw new StorageError('not_found', 'workspace is not initialized');
    return row;
  }

  private workspaceRowSync(): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM workspace LIMIT 1');
  }

  private requireWorkspace(): Workspace {
    return workspaceFromRow(this.requireWorkspaceRowSync());
  }

  private ensureWorkspaceRowSync(): Workspace {
    const existing = this.workspaceRowSync();
    if (existing) return workspaceFromRow(existing);
    const now = nowIso();
    const workspace = WorkspaceSchema.parse({
      id: newUuid(),
      mode: this.mode,
      name: this.workspaceName,
      settings: this.seedSettings,
      createdAt: now,
      updatedAt: now,
    });
    insertRow(this.db, 'workspace', workspaceToRow(workspace, 0));
    return workspace;
  }

  /* ------------------------------------------------------------------ */
  /* internals: row accessors                                            */
  /* ------------------------------------------------------------------ */

  private taskRowSync(taskId: string): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM tasks WHERE id = ?', [taskId]);
  }

  private artifactRowSync(artifactId: string): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM artifacts WHERE id = ?', [artifactId]);
  }

  private requireArtifactRowSync(artifactId: string): SqlRow {
    const row = this.artifactRowSync(artifactId);
    if (!row) throw new StorageError('not_found', `artifact ${artifactId} does not exist`);
    return row;
  }

  private moduleRowSync(moduleId: string): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM artifact_modules WHERE id = ?', [moduleId]);
  }

  private moduleRowsSync(artifactId: string): SqlRow[] {
    return sqlAll(this.db, 'SELECT * FROM artifact_modules WHERE artifact_id = ? ORDER BY order_index ASC, rowid ASC', [
      artifactId,
    ]);
  }

  private versionRowSync(versionId: string): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM artifact_versions WHERE id = ?', [versionId]);
  }

  private requireVersionRowSync(versionId: string): SqlRow {
    const row = this.versionRowSync(versionId);
    if (!row) throw new StorageError('not_found', `artifact version ${versionId} does not exist`);
    return row;
  }

  private guardVersionInsertSync(version: ArtifactVersion): void {
    const artifactRow = this.artifactRowSync(version.artifactId);
    if (!artifactRow) {
      throw new StorageError('not_found', `artifact ${version.artifactId} does not exist`);
    }
    const moduleRow = this.moduleRowSync(version.moduleId);
    if (!moduleRow) {
      throw new StorageError('not_found', `module ${version.moduleId} does not exist`);
    }
    if (rowString(moduleRow, 'artifact_id') !== version.artifactId) {
      throw new StateNotAllowedError(`module ${version.moduleId} does not belong to artifact ${version.artifactId}`);
    }
    if (this.versionRowSync(version.id)) {
      throw new StorageError('conflict', `artifact version ${version.id} already exists; accepted versions are immutable`);
    }
    insertRow(this.db, 'artifact_versions', versionToRow(version));
  }

  private sourceRowSync(taskId: string, sourceId: string, version?: number): SqlRow | undefined {
    if (version === undefined) {
      return sqlGet(
        this.db,
        'SELECT * FROM sources WHERE task_id = ? AND id = ? ORDER BY version DESC LIMIT 1',
        [taskId, sourceId],
      );
    }
    return sqlGet(this.db, 'SELECT * FROM sources WHERE task_id = ? AND id = ? AND version = ?', [
      taskId,
      sourceId,
      version,
    ]);
  }

  private runRowSync(runId: string): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM runs WHERE id = ?', [runId]);
  }

  private patchRowSync(patchId: string): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM patches WHERE id = ?', [patchId]);
  }

  /** A run may only reference objects of the task that owns it. */
  private requireRunForTaskSync(runId: string, taskId: string): void {
    const row = this.runRowSync(runId);
    if (!row) throw new StorageError('not_found', `run ${runId} does not exist`);
    const owner = rowString(row, 'task_id');
    if (owner !== taskId) {
      throw new StateNotAllowedError(`run ${runId} belongs to task ${owner}, not ${taskId}`);
    }
  }

  private leaseRowSync(runId: string): SqlRow | undefined {
    return sqlGet(this.db, 'SELECT * FROM run_leases WHERE run_id = ?', [runId]);
  }

  private latestSeqSync(taskId: string): number {
    const row = sqlGet(this.db, 'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?', [taskId]);
    return row ? rowNumber(row, 'seq') : 0;
  }

  /* ------------------------------------------------------------------ */
  /* internals: event append                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Allocate per-task sequence numbers and insert events. MUST be called inside
   * an open transaction (BEGIN IMMEDIATE): the MAX(seq) read and the inserts then
   * share the database write lock, and UNIQUE(task_id, seq) is the backstop.
   *
   * All payloads are validated before the first insert so a bad batch leaves no
   * partial event rows behind even outside an outer transaction.
   */
  private appendEventsSync(taskId: string, drafts: readonly EventDraft[]): HarnessEvent[] {
    if (drafts.length === 0) return [];
    if (!this.taskRowSync(taskId)) {
      throw new StorageError('not_found', `task ${taskId} does not exist; cannot append events`);
    }
    const prepared: HarnessEvent[] = [];
    let seq = this.latestSeqSync(taskId);
    for (const draft of drafts) {
      if (draft === null || typeof draft !== 'object') {
        throw new StorageError('invalid_event', 'event draft must be an object');
      }
      const type = draft.type as EventType;
      if (!(type in EVENT_CATEGORY_BY_TYPE)) {
        throw new StorageError('invalid_event', `unknown event type: ${String(type)}`);
      }
      const payload = parseEventPayload(type, draft.payload) as EventPayloads[typeof type];
      seq += 1;
      const event = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: newEventId(),
        taskId: taskId as TaskId,
        runId: (draft.runId ?? null) as HarnessEvent['runId'],
        stepId: (draft.stepId ?? null) as HarnessEvent['stepId'],
        seq,
        causationId: (draft.causationId ?? null) as HarnessEvent['causationId'],
        type,
        category: EVENT_CATEGORY_BY_TYPE[type],
        payload,
        timestamp: draft.timestamp ?? nowIso(),
      };
      prepared.push(parseHarnessEvent(event));
    }
    for (const event of prepared) {
      insertRow(this.db, 'events', eventToRow(event));
    }
    return prepared;
  }
}

/* ------------------------------------------------------------------ */
/* factory                                                             */
/* ------------------------------------------------------------------ */

/**
 * Open (or create) the persistence layer for one engine mode.
 *
 * Data layout: `<dataDir>/<mode>/cognitive-atrium.db` and
 * `<dataDir>/<mode>/objects/<hash[0..2]>/<hash>`. Demo and live mode therefore
 * never share a file, a WAL or an object directory.
 */
export function openStorage(options: OpenStorageOptions): StoragePort {
  return new SqliteStorage(options);
}

/** Typed factory for tests/diagnostics that need the extra helper methods. */
export function openStorageWithDiagnostics(options: OpenStorageOptions): SqliteStorage {
  return new SqliteStorage(options);
}
