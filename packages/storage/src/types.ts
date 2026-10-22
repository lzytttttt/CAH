/**
 * Storage port: the only component allowed to talk to SQLite and the
 * content-addressed object directory. All state changes that emit business
 * events MUST happen inside `transaction()` so both commit together.
 *
 * Implementations live in `storage.ts`. This file is the stable contract shared
 * by the harness and the server. Do not change method signatures without
 * coordinating with the Lead: other packages are written against them.
 */
import type {
  Artifact,
  ArtifactModule,
  ArtifactVersion,
  Blocker,
  CommandId,
  ContextSnapshot,
  Decision,
  EngineMode,
  EventPayloads,
  EventType,
  HarnessEvent,
  PatchProposal,
  Recipe,
  Run,
  RunCheckpoint,
  SourceId,
  SourceItem,
  SourceSpan,
  Step,
  Task,
  TaskId,
  ToolInvocationRecord,
  ValidationReport,
  Workspace,
  WorkspaceSettings,
} from '@ca/contracts';

/** Draft event before the store allocates a task-local sequence number. */
export interface EventDraft<T extends EventType = EventType> {
  runId: string | null;
  stepId: string | null;
  causationId: string | null;
  type: T;
  payload: EventPayloads[T];
  /** Injected in tests only; the store otherwise sets its own timestamp. */
  timestamp?: string;
}

export interface ContentObjectRef {
  hash: string;
  sizeBytes: number;
  mime: string;
}

export interface ObjectStorePort {
  /** Write bytes atomically (temp file + rename) and return the sha256 address. */
  put(bytes: Uint8Array, mime: string): Promise<ContentObjectRef>;
  get(hash: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  has(hash: string): Promise<boolean>;
  /** Absolute path for debugging/export; may be null for remote stores. */
  pathFor(hash: string): string | null;
}

export interface SourceWithContent {
  source: SourceItem;
  content: Uint8Array;
}

export interface SourceSearchCandidate {
  source: SourceItem;
  bytes: Uint8Array;
}

export interface RunWithSteps extends Run {
  steps: Step[];
}

export interface TaskAggregate {
  task: Task;
  artifact: Artifact;
  modules: ArtifactModule[];
}

export interface CommitAcceptanceInput {
  taskId: TaskId;
  patchId: string;
  version: ArtifactVersion;
  /** Task revision expected by the client; the store re-checks under transaction. */
  expectedTaskRevision: number;
  updatedModules: ArtifactModule[];
  artifact: Artifact;
  events: EventDraft[];
}

export interface CommitAcceptanceResult {
  version: ArtifactVersion;
  artifact: Artifact;
  taskRevision: number;
  events: HarnessEvent[];
}

export interface StoragePort {
  readonly mode: EngineMode;
  readonly objects: ObjectStorePort;

  /* workspace */
  getWorkspace(): Promise<Workspace>;
  ensureWorkspace(seed: { name: string; settings: WorkspaceSettings }): Promise<Workspace>;
  updateWorkspaceSettings(settings: Partial<WorkspaceSettings>, expectedTaskRevision?: number): Promise<Workspace>;

  /* tasks + artifact skeleton */
  insertTaskBundle(input: { task: Task; artifact: Artifact; modules: ArtifactModule[] }): Promise<void>;
  getTask(taskId: TaskId): Promise<Task | null>;
  listTasks(): Promise<Task[]>;
  getTaskAggregate(taskId: TaskId): Promise<TaskAggregate | null>;
  updateTask(task: Task): Promise<void>;
  /**
   * Atomically bump the task revision from `expectedRevision` to expected+1 and
   * persist the callback's changes. Throws RevisionConflict when stale.
   */
  bumpTaskRevision(taskId: TaskId, expectedRevision: number): Promise<Task>;
  updateModules(modules: readonly ArtifactModule[]): Promise<void>;
  getArtifact(artifactId: string): Promise<Artifact | null>;
  listModules(artifactId: string): Promise<ArtifactModule[]>;
  getModule(moduleId: string): Promise<ArtifactModule | null>;

  /* sources */
  insertSource(source: SourceItem, content: Uint8Array): Promise<void>;
  getSource(taskId: TaskId, sourceId: SourceId, version?: number): Promise<SourceWithContent | null>;
  listSources(taskId: TaskId): Promise<SourceItem[]>;
  listLatestSourceContents(taskId: TaskId): Promise<SourceSearchCandidate[]>;
  insertSpans(spans: readonly SourceSpan[]): Promise<void>;
  listSpans(taskId: TaskId, limit?: number): Promise<SourceSpan[]>;
  markSourcesMissing(sourceIds: readonly string[]): Promise<void>;

  /* artifact versions */
  insertVersion(version: ArtifactVersion): Promise<void>;
  getVersion(versionId: string): Promise<ArtifactVersion | null>;
  getAcceptedVersion(moduleId: string): Promise<ArtifactVersion | null>;
  listVersions(moduleId: string): Promise<ArtifactVersion[]>;

  /* runs + steps */
  insertRun(run: Run): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  updateRun(run: Run, expectedRevision?: number): Promise<Run>;
  listRuns(taskId: TaskId): Promise<Run[]>;
  findActiveRunId(taskId: TaskId): Promise<string | null>;
  countActiveRuns(): Promise<number>;
  listQueuedRuns(): Promise<Run[]>;
  updateRunStateIfRevision(runId: string, expectedRevision: number, next: Run): Promise<Run>;
  insertStep(step: Step): Promise<void>;
  updateStep(step: Step): Promise<void>;
  listSteps(runId: string): Promise<Step[]>;

  /* checkpoints */
  insertCheckpoint(checkpoint: RunCheckpoint): Promise<void>;
  getCheckpoint(checkpointId: string): Promise<RunCheckpoint | null>;
  latestCheckpoint(runId: string): Promise<RunCheckpoint | null>;

  /* blockers + decisions */
  insertBlocker(blocker: Blocker): Promise<void>;
  updateBlocker(blocker: Blocker): Promise<void>;
  getBlocker(blockerId: string): Promise<Blocker | null>;
  listBlockers(taskId: TaskId): Promise<Blocker[]>;
  insertDecision(decision: Decision): Promise<void>;
  listDecisions(taskId: TaskId): Promise<Decision[]>;

  /* patches + validation */
  insertPatch(patch: PatchProposal): Promise<void>;
  getPatch(patchId: string): Promise<PatchProposal | null>;
  updatePatch(patch: PatchProposal): Promise<void>;
  listPatches(taskId: TaskId): Promise<PatchProposal[]>;
  insertValidationReport(report: ValidationReport): Promise<void>;
  getValidationReport(reportId: string): Promise<ValidationReport | null>;
  listValidationReports(taskId: TaskId): Promise<ValidationReport[]>;

  /* context snapshots */
  insertContextSnapshot(snapshot: ContextSnapshot): Promise<void>;
  getContextSnapshot(id: string): Promise<ContextSnapshot | null>;

  /* tool invocations */
  insertToolInvocation(record: ToolInvocationRecord): Promise<void>;
  updateToolInvocation(record: ToolInvocationRecord): Promise<void>;
  listToolInvocations(runId: string): Promise<ToolInvocationRecord[]>;
  findUnclearToolInvocations(runId: string): Promise<ToolInvocationRecord[]>;

  /* recipes */
  insertRecipe(recipe: Recipe): Promise<void>;
  getRecipe(recipeId: string): Promise<Recipe | null>;
  listRecipes(taskId?: TaskId): Promise<Recipe[]>;
  nextRecipeVersion(recipeId: string): Promise<number>;
  updateRecipe(recipe: Recipe): Promise<void>;

  /* event stream */
  appendEvents(taskId: TaskId, drafts: readonly EventDraft[]): Promise<HarnessEvent[]>;
  eventsAfter(taskId: TaskId, seq: number, limit?: number): Promise<HarnessEvent[]>;
  latestSeq(taskId: TaskId): Promise<number>;
  eventCount(taskId: TaskId): Promise<number>;

  /* idempotency */
  getCommandResult(commandId: CommandId): Promise<Record<string, unknown> | null>;
  saveCommandResult(commandId: CommandId, commandType: string, taskId: TaskId | null, response: Record<string, unknown>): Promise<void>;

  /* atomic commit of an accepted artifact version + its events */
  commitAcceptance(input: CommitAcceptanceInput): Promise<CommitAcceptanceResult>;

  /* recovery */
  acquireRunLease(runId: string, owner: string, ttlMs: number): Promise<boolean>;
  renewRunLease(runId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseRunLease(runId: string, owner: string): Promise<void>;
  listLeaseOwner(runId: string): Promise<string | null>;

  /* maintenance */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  resetDemoData(): Promise<void>;
  /** Consistent SQLite snapshot for backups (WAL checkpoint + copy). */
  backupTo(destinationDir: string): Promise<string>;
  close(): Promise<void>;
}

export class StorageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export class RevisionConflictError extends StorageError {
  constructor(expected: number, actual: number) {
    super('revision_conflict', `expected revision ${expected} but found ${actual}`);
    this.name = 'RevisionConflictError';
  }
}

export class VersionConflictError extends StorageError {
  constructor(message: string) {
    super('version_conflict', message);
    this.name = 'VersionConflictError';
  }
}

export class StateNotAllowedError extends StorageError {
  constructor(message: string) {
    super('state_not_allowed', message);
    this.name = 'StateNotAllowedError';
  }
}
