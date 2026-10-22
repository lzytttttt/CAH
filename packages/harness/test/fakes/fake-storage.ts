/**
 * In-memory StoragePort for deterministic kernel tests. Mirrors the semantics of
 * the real SQLite storage closely enough to be meaningful:
 * - transactions are savepoints (nested rollback supported),
 * - commitAcceptance enforces revision/base-version guards and bumps task revision,
 * - every appended event payload is validated against the contracts schema.
 */
import {
  EVENT_CATEGORY_BY_TYPE,
  EVENT_SCHEMA_VERSION,
  newEventId,
  parseEventPayload,
  type Artifact,
  type ArtifactModule,
  type ArtifactVersion,
  type Blocker,
  type ContextSnapshot,
  type Decision,
  type EngineMode,
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
import type {
  CommitAcceptanceInput,
  CommitAcceptanceResult,
  EventDraft as StorageEventDraft,
  ObjectStorePort,
  SourceSearchCandidate,
  SourceWithContent,
  StoragePort,
  TaskAggregate,
} from '@ca/storage';
import { contentHash } from '../../src/hashing';

class FakeStorageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code === 'revision_conflict' ? 'RevisionConflictError' : code === 'version_conflict' ? 'VersionConflictError' : 'StorageError';
    this.code = code;
  }
}

export class TestClock {
  private t = Date.parse('2026-01-01T00:00:00.000Z');
  private mono = 0;
  now(): string {
    this.t += 1;
    this.mono += 1;
    return new Date(this.t).toISOString();
  }
  monotonicMs(): number {
    return this.mono;
  }
  advance(ms: number): void {
    this.t += ms;
    this.mono += ms;
  }
}

interface SourceRecord {
  source: SourceItem;
  bytes: Uint8Array;
}

export class FakeObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  async put(bytes: Uint8Array, mime: string): Promise<{ hash: string; sizeBytes: number; mime: string }> {
    const hash = contentHash(Array.from(bytes));
    this.objects.set(hash, { bytes, mime });
    return { hash, sizeBytes: bytes.byteLength, mime };
  }
  async get(hash: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    return this.objects.get(hash) ?? null;
  }
  async has(hash: string): Promise<boolean> {
    return this.objects.has(hash);
  }
  pathFor(): string | null {
    return null;
  }
}

export class FakeStorage implements StoragePort {
  readonly mode: EngineMode = 'demo';
  readonly objects = new FakeObjectStore();
  readonly clock: TestClock;
  workspace: Workspace | null = null;
  readonly tasks = new Map<string, Task>();
  readonly artifacts = new Map<string, Artifact>();
  readonly modules = new Map<string, ArtifactModule>();
  readonly sources = new Map<string, SourceRecord[]>();
  readonly spans = new Map<string, SourceSpan[]>();
  readonly versions = new Map<string, ArtifactVersion>();
  readonly runs = new Map<string, Run>();
  readonly steps = new Map<string, Step[]>();
  readonly checkpoints = new Map<string, RunCheckpoint>();
  readonly blockers = new Map<string, Blocker>();
  readonly decisions = new Map<string, Decision>();
  readonly patches = new Map<string, PatchProposal>();
  readonly reports = new Map<string, ValidationReport>();
  readonly snapshots = new Map<string, ContextSnapshot>();
  readonly invocations = new Map<string, ToolInvocationRecord>();
  readonly recipes = new Map<string, Recipe>();
  readonly events = new Map<string, HarnessEvent[]>();
  readonly seqs = new Map<string, number>();
  readonly commandResults = new Map<string, { commandType: string; taskId: string | null; response: Record<string, unknown> }>();
  readonly leases = new Map<string, { owner: string; expiresAt: number }>();
  readonly providerProfiles = new Map<string, ProviderProfile>();
  /** Assertion log (read-only for tests). */
  readonly callLog: string[] = [];
  readonly checkpointKinds: string[] = [];
  transactionDepth = 0;

  constructor(clock: TestClock) {
    this.clock = clock;
  }

  private log(name: string): void {
    this.callLog.push(name);
  }

  /* ------------------------------ transactions ----------------------------- */

  private snapshotState(): unknown {
    return structuredClone({
      workspace: this.workspace,
      tasks: this.tasks,
      artifacts: this.artifacts,
      modules: this.modules,
      sources: this.sources,
      spans: this.spans,
      versions: this.versions,
      runs: this.runs,
      steps: this.steps,
      checkpoints: this.checkpoints,
      blockers: this.blockers,
      decisions: this.decisions,
      patches: this.patches,
      reports: this.reports,
      snapshots: this.snapshots,
      invocations: this.invocations,
      recipes: this.recipes,
      events: this.events,
      seqs: this.seqs,
      leases: this.leases,
      providerProfiles: this.providerProfiles,
    });
  }

  private restoreState(state: unknown): void {
    const value = state as Record<string, Map<string, unknown>> & { workspace: Workspace | null };
    this.workspace = value.workspace;
    const restoreMap = <V>(target: Map<string, V>, source: Map<string, V>): void => {
      target.clear();
      for (const [key, entry] of source) target.set(key, entry);
    };
    restoreMap(this.tasks, value.tasks as Map<string, Task>);
    restoreMap(this.artifacts, value.artifacts as Map<string, Artifact>);
    restoreMap(this.modules, value.modules as Map<string, ArtifactModule>);
    restoreMap(this.sources, value.sources as Map<string, SourceRecord[]>);
    restoreMap(this.spans, value.spans as Map<string, SourceSpan[]>);
    restoreMap(this.versions, value.versions as Map<string, ArtifactVersion>);
    restoreMap(this.runs, value.runs as Map<string, Run>);
    restoreMap(this.steps, value.steps as Map<string, Step[]>);
    restoreMap(this.checkpoints, value.checkpoints as Map<string, RunCheckpoint>);
    restoreMap(this.blockers, value.blockers as Map<string, Blocker>);
    restoreMap(this.decisions, value.decisions as Map<string, Decision>);
    restoreMap(this.patches, value.patches as Map<string, PatchProposal>);
    restoreMap(this.reports, value.reports as Map<string, ValidationReport>);
    restoreMap(this.snapshots, value.snapshots as Map<string, ContextSnapshot>);
    restoreMap(this.invocations, value.invocations as Map<string, ToolInvocationRecord>);
    restoreMap(this.recipes, value.recipes as Map<string, Recipe>);
    restoreMap(this.events, value.events as Map<string, HarnessEvent[]>);
    restoreMap(this.seqs, value.seqs as Map<string, number>);
    restoreMap(this.leases, value.leases as Map<string, { owner: string; expiresAt: number }>);
    restoreMap(this.providerProfiles, value.providerProfiles as Map<string, ProviderProfile>);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.transactionDepth += 1;
    const snapshot = this.snapshotState();
    try {
      const result = await fn();
      return result;
    } catch (error) {
      this.restoreState(snapshot);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  /* ------------------------------- workspace ------------------------------- */

  async getWorkspace(): Promise<Workspace> {
    if (!this.workspace) throw new FakeStorageError('not_found', 'workspace missing');
    return structuredClone(this.workspace);
  }

  async ensureWorkspace(seed: { name: string; settings: WorkspaceSettings }): Promise<Workspace> {
    if (this.workspace) return structuredClone(this.workspace);
    const now = this.clock.now();
    this.workspace = {
      id: '00000000-0000-4000-8000-000000000001' as never,
      mode: this.mode,
      name: seed.name,
      settings: seed.settings,
      policyVersion: 'p0-policy-1',
      createdAt: now,
      updatedAt: now,
    };
    return structuredClone(this.workspace);
  }

  async updateWorkspaceSettings(settings: Partial<WorkspaceSettings>): Promise<Workspace> {
    const workspace = await this.getWorkspace();
    this.workspace = { ...workspace, settings: { ...workspace.settings, ...settings }, updatedAt: this.clock.now() };
    return structuredClone(this.workspace);
  }

  /* --------------------------------- tasks --------------------------------- */

  async insertTaskBundle(input: { task: Task; artifact: Artifact; modules: ArtifactModule[] }): Promise<void> {
    this.tasks.set(input.task.id, structuredClone(input.task));
    this.artifacts.set(input.artifact.id, structuredClone(input.artifact));
    for (const module of input.modules) this.modules.set(module.id, structuredClone(module));
    if (!this.events.has(input.task.id)) {
      this.events.set(input.task.id, []);
      this.seqs.set(input.task.id, 0);
    }
  }

  async getTask(taskId: TaskId): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }

  async getTaskAggregate(taskId: TaskId): Promise<TaskAggregate | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const artifact = this.artifacts.get(task.artifactId);
    if (!artifact) return null;
    return {
      task: structuredClone(task),
      artifact: structuredClone(artifact),
      modules: artifact.moduleIds
        .map((id) => this.modules.get(id))
        .filter((module): module is ArtifactModule => Boolean(module))
        .map((module) => structuredClone(module)),
    };
  }

  async updateTask(task: Task): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async bumpTaskRevision(taskId: TaskId, expectedRevision: number): Promise<Task> {
    this.log('bumpTaskRevision');
    const task = this.tasks.get(taskId);
    if (!task) throw new FakeStorageError('not_found', 'task missing');
    if (task.revision !== expectedRevision) {
      throw new FakeStorageError('revision_conflict', `expected revision ${expectedRevision} but found ${task.revision}`);
    }
    const next: Task = { ...task, revision: task.revision + 1, updatedAt: this.clock.now() };
    this.tasks.set(taskId, next);
    return structuredClone(next);
  }

  async updateModules(modules: readonly ArtifactModule[]): Promise<void> {
    for (const module of modules) this.modules.set(module.id, structuredClone(module));
  }

  async getArtifact(artifactId: string): Promise<Artifact | null> {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? structuredClone(artifact) : null;
  }

  async listModules(artifactId: string): Promise<ArtifactModule[]> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return [];
    return artifact.moduleIds
      .map((id) => this.modules.get(id))
      .filter((module): module is ArtifactModule => Boolean(module))
      .map((module) => structuredClone(module));
  }

  async getModule(moduleId: string): Promise<ArtifactModule | null> {
    const module = this.modules.get(moduleId);
    return module ? structuredClone(module) : null;
  }

  /* -------------------------------- sources -------------------------------- */

  async insertSource(source: SourceItem, content: Uint8Array): Promise<void> {
    const list = this.sources.get(source.taskId) ?? [];
    const filtered = list.filter((record) => record.source.id !== source.id);
    filtered.push({ source: structuredClone(source), bytes: content.slice() });
    this.sources.set(source.taskId, filtered);
  }

  async getSource(taskId: TaskId, sourceId: SourceId, version?: number): Promise<SourceWithContent | null> {
    const record = (this.sources.get(taskId) ?? []).find(
      (entry) => entry.source.id === sourceId && (version === undefined || entry.source.version === version),
    );
    if (!record) return null;
    return { source: structuredClone(record.source), content: record.bytes.slice() };
  }

  async listSources(taskId: TaskId): Promise<SourceItem[]> {
    return (this.sources.get(taskId) ?? []).map((record) => structuredClone(record.source));
  }

  async listLatestSourceContents(taskId: TaskId): Promise<SourceSearchCandidate[]> {
    return (this.sources.get(taskId) ?? []).map((record) => ({
      source: structuredClone(record.source),
      bytes: record.bytes.slice(),
    }));
  }

  async insertSpans(spans: readonly SourceSpan[]): Promise<void> {
    for (const span of spans) {
      const list = this.spans.get(span.sourceId) ?? [];
      const next = list.filter((entry) => entry.id !== span.id);
      next.push(structuredClone(span));
      this.spans.set(span.sourceId, next);
      // Also index by task for listSpans.
      const byTask = this.spans.get('__all__') ?? [];
      const filtered = byTask.filter((entry) => entry.id !== span.id);
      filtered.push(structuredClone(span));
      this.spans.set('__all__', filtered);
    }
  }

  async listSpans(taskId: TaskId, limit?: number): Promise<SourceSpan[]> {
    void taskId;
    const all = this.spans.get('__all__') ?? [];
    return all.slice(0, limit ?? all.length).map((span) => structuredClone(span));
  }

  async markSourcesMissing(sourceIds: readonly string[]): Promise<void> {
    for (const [taskId, records] of this.sources) {
      this.sources.set(
        taskId,
        records.map((record) =>
          sourceIds.includes(record.source.id)
            ? { ...record, source: { ...record.source, availability: 'missing' as const } }
            : record,
        ),
      );
    }
  }

  /* ----------------------------- artifact versions ------------------------- */

  async insertVersion(version: ArtifactVersion): Promise<void> {
    this.versions.set(version.id, structuredClone(version));
    const module = this.modules.get(version.moduleId);
    if (module) {
      this.modules.set(module.id, {
        ...module,
        status: 'accepted',
        acceptedVersionId: version.id,
        updatedAt: version.acceptedAt,
      });
    }
    const artifact = module ? this.artifacts.get(module.artifactId) : null;
    if (artifact) this.artifacts.set(artifact.id, { ...artifact, acceptedVersionId: version.id });
  }

  async getVersion(versionId: string): Promise<ArtifactVersion | null> {
    const version = this.versions.get(versionId);
    return version ? structuredClone(version) : null;
  }

  async getAcceptedVersion(moduleId: string): Promise<ArtifactVersion | null> {
    const module = this.modules.get(moduleId);
    if (!module?.acceptedVersionId) return null;
    return this.getVersion(module.acceptedVersionId);
  }

  async listVersions(moduleId: string): Promise<ArtifactVersion[]> {
    return [...this.versions.values()]
      .filter((version) => version.moduleId === moduleId)
      .sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : 1))
      .map((version) => structuredClone(version));
  }

  /* --------------------------------- runs ---------------------------------- */

  async insertRun(run: Run): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
    if (!this.steps.has(run.id)) this.steps.set(run.id, []);
  }

  async getRun(runId: string): Promise<Run | null> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async updateRun(run: Run, expectedRevision?: number): Promise<Run> {
    const existing = this.runs.get(run.id);
    if (!existing) throw new FakeStorageError('not_found', `run missing: ${run.id}`);
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw new FakeStorageError('revision_conflict', `run expected revision ${expectedRevision} but found ${existing.revision}`);
    }
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async listRuns(taskId: TaskId): Promise<Run[]> {
    return [...this.runs.values()].filter((run) => run.taskId === taskId).map((run) => structuredClone(run));
  }

  async findActiveRunId(taskId: TaskId): Promise<string | null> {
    const terminal = new Set(['COMPLETED', 'CANCELLED', 'FAILED', 'INTERRUPTED']);
    const active = [...this.runs.values()].find((run) => run.taskId === taskId && !terminal.has(run.state));
    return active?.id ?? null;
  }

  async countActiveRuns(): Promise<number> {
    const terminal = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
    return [...this.runs.values()].filter((run) => !terminal.has(run.state)).length;
  }

  async listQueuedRuns(): Promise<Run[]> {
    return [];
  }

  async updateRunStateIfRevision(runId: string, expectedRevision: number, next: Run): Promise<Run> {
    return this.updateRun(next, expectedRevision);
  }

  async insertStep(step: Step): Promise<void> {
    const list = this.steps.get(step.runId) ?? [];
    list.push(structuredClone(step));
    this.steps.set(step.runId, list);
  }

  async updateStep(step: Step): Promise<void> {
    const list = this.steps.get(step.runId) ?? [];
    this.steps.set(
      step.runId,
      list.map((entry) => (entry.id === step.id ? structuredClone(step) : entry)),
    );
  }

  async listSteps(runId: string): Promise<Step[]> {
    return (this.steps.get(runId) ?? []).map((step) => structuredClone(step));
  }

  /* ------------------------------ checkpoints ------------------------------ */

  async insertCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, structuredClone(checkpoint));
    this.checkpointKinds.push(checkpoint.kind);
  }

  async getCheckpoint(checkpointId: string): Promise<RunCheckpoint | null> {
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async latestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const list = [...this.checkpoints.values()].filter((checkpoint) => checkpoint.runId === runId);
    const last = list[list.length - 1];
    return last ? structuredClone(last) : null;
  }

  /* ---------------------------- blockers/decisions ------------------------- */

  async insertBlocker(blocker: Blocker): Promise<void> {
    this.blockers.set(blocker.id, structuredClone(blocker));
  }

  async updateBlocker(blocker: Blocker): Promise<void> {
    this.blockers.set(blocker.id, structuredClone(blocker));
  }

  async getBlocker(blockerId: string): Promise<Blocker | null> {
    const blocker = this.blockers.get(blockerId);
    return blocker ? structuredClone(blocker) : null;
  }

  async listBlockers(taskId: TaskId): Promise<Blocker[]> {
    return [...this.blockers.values()].filter((blocker) => blocker.taskId === taskId).map((blocker) => structuredClone(blocker));
  }

  async insertDecision(decision: Decision): Promise<void> {
    this.decisions.set(decision.id, structuredClone(decision));
  }

  async listDecisions(taskId: TaskId): Promise<Decision[]> {
    return [...this.decisions.values()].filter((decision) => decision.taskId === taskId).map((decision) => structuredClone(decision));
  }

  /* ------------------------------ patches/reports -------------------------- */

  async insertPatch(patch: PatchProposal): Promise<void> {
    this.patches.set(patch.id, structuredClone(patch));
  }

  async getPatch(patchId: string): Promise<PatchProposal | null> {
    const patch = this.patches.get(patchId);
    return patch ? structuredClone(patch) : null;
  }

  async updatePatch(patch: PatchProposal): Promise<void> {
    this.patches.set(patch.id, structuredClone(patch));
  }

  async listPatches(taskId: TaskId): Promise<PatchProposal[]> {
    return [...this.patches.values()].filter((patch) => patch.taskId === taskId).map((patch) => structuredClone(patch));
  }

  async insertValidationReport(report: ValidationReport): Promise<void> {
    this.reports.set(report.id, structuredClone(report));
  }

  async getValidationReport(reportId: string): Promise<ValidationReport | null> {
    const report = this.reports.get(reportId);
    return report ? structuredClone(report) : null;
  }

  async listValidationReports(taskId: TaskId): Promise<ValidationReport[]> {
    return [...this.reports.values()].filter((report) => report.taskId === taskId).map((report) => structuredClone(report));
  }

  /* ---------------------------- context snapshots -------------------------- */

  async insertContextSnapshot(snapshot: ContextSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }

  async getContextSnapshot(id: string): Promise<ContextSnapshot | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot ? structuredClone(snapshot) : null;
  }

  /* ---------------------------- tool invocations --------------------------- */

  async insertToolInvocation(record: ToolInvocationRecord): Promise<void> {
    this.invocations.set(record.toolCallId, structuredClone(record));
  }

  async updateToolInvocation(record: ToolInvocationRecord): Promise<void> {
    this.invocations.set(record.toolCallId, structuredClone(record));
  }

  async listToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    return [...this.invocations.values()]
      .filter((record) => record.runId === runId)
      .map((record) => structuredClone(record));
  }

  async findUnclearToolInvocations(runId: string): Promise<ToolInvocationRecord[]> {
    return [...this.invocations.values()]
      .filter((record) => record.runId === runId && (record.status === 'authorized' || record.status === 'started'))
      .map((record) => structuredClone(record));
  }

  /* ---------------------------- provider profiles -------------------------- */

  async listProviderProfiles(): Promise<ProviderProfile[]> {
    return [...this.providerProfiles.values()].map((profile) => structuredClone(profile));
  }

  async getProviderProfile(id: string): Promise<ProviderProfile | null> {
    const profile = this.providerProfiles.get(id);
    return profile ? structuredClone(profile) : null;
  }

  async upsertProviderProfile(profile: ProviderProfile): Promise<void> {
    this.providerProfiles.set(profile.id, structuredClone(profile));
  }

  async deleteProviderProfile(id: string): Promise<void> {
    this.providerProfiles.delete(id);
  }

  /* --------------------------------- recipes ------------------------------- */

  async insertRecipe(recipe: Recipe): Promise<void> {
    this.recipes.set(recipe.id, structuredClone(recipe));
  }

  async getRecipe(recipeId: string): Promise<Recipe | null> {
    const recipe = this.recipes.get(recipeId);
    return recipe ? structuredClone(recipe) : null;
  }

  async listRecipes(taskId?: TaskId): Promise<Recipe[]> {
    const all = [...this.recipes.values()];
    return all.filter((recipe) => (taskId ? recipe.sourceTaskId === taskId : true)).map((recipe) => structuredClone(recipe));
  }

  async nextRecipeVersion(recipeId: string): Promise<number> {
    const versions = [...this.recipes.values()].filter((recipe) => recipe.id === recipeId);
    return versions.length + 1;
  }

  async updateRecipe(recipe: Recipe): Promise<void> {
    this.recipes.set(recipe.id, structuredClone(recipe));
  }

  /* ------------------------------ event stream ----------------------------- */

  async appendEvents(taskId: TaskId, drafts: readonly StorageEventDraft[]): Promise<HarnessEvent[]> {
    const list = this.events.get(taskId) ?? [];
    let seq = this.seqs.get(taskId) ?? 0;
    const created: HarnessEvent[] = [];
    for (const draft of drafts) {
      seq += 1;
      const payload = parseEventPayload(draft.type as EventType, draft.payload);
      const event = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: newEventId(),
        taskId,
        runId: draft.runId as never,
        stepId: (draft.stepId ?? null) as never,
        seq,
        causationId: draft.causationId ?? null,
        type: draft.type,
        category: EVENT_CATEGORY_BY_TYPE[draft.type as EventType],
        payload,
        timestamp: draft.timestamp ?? this.clock.now(),
      } as unknown as HarnessEvent;
      created.push(event);
      list.push(event);
    }
    this.events.set(taskId, list);
    this.seqs.set(taskId, seq);
    return created;
  }

  async eventsAfter(taskId: TaskId, seq: number, limit?: number): Promise<HarnessEvent[]> {
    const list = this.events.get(taskId) ?? [];
    return list.filter((event) => event.seq > seq).slice(0, limit ?? list.length).map((event) => structuredClone(event));
  }

  async latestSeq(taskId: TaskId): Promise<number> {
    return this.seqs.get(taskId) ?? 0;
  }

  async eventCount(taskId: TaskId): Promise<number> {
    return (this.events.get(taskId) ?? []).length;
  }

  /* ------------------------------- idempotency ----------------------------- */

  async getCommandResult(commandId: string): Promise<Record<string, unknown> | null> {
    return this.commandResults.get(commandId)?.response ?? null;
  }

  async saveCommandResult(commandId: string, commandType: string, taskId: TaskId | null, response: Record<string, unknown>): Promise<void> {
    this.commandResults.set(commandId, { commandType, taskId: taskId ?? null, response: structuredClone(response) });
  }

  /* -------------------------- acceptance transaction ----------------------- */

  async commitAcceptance(input: CommitAcceptanceInput): Promise<CommitAcceptanceResult> {
    this.log('commitAcceptance');
    const task = this.tasks.get(input.taskId);
    if (!task) throw new FakeStorageError('not_found', 'task missing');
    if (task.revision !== input.expectedTaskRevision) {
      throw new FakeStorageError('revision_conflict', `task revision ${task.revision} != ${input.expectedTaskRevision}`);
    }
    const module = this.modules.get(input.version.moduleId);
    if (!module) throw new FakeStorageError('not_found', 'module missing');
    const currentAcceptedId = module.acceptedVersionId ?? null;
    if ((input.version.baseVersionId ?? null) !== currentAcceptedId) {
      throw new FakeStorageError(
        'version_conflict',
        `base version ${input.version.baseVersionId ?? 'null'} does not match current accepted ${currentAcceptedId ?? 'null'}`,
      );
    }
    const artifact = this.artifacts.get(input.artifact.id);
    if (!artifact || artifact.taskId !== input.taskId) throw new FakeStorageError('not_found', 'artifact missing');
    if (input.version.artifactId !== artifact.id) throw new FakeStorageError('version_conflict', 'version artifact mismatch');
    const patch = this.patches.get(input.patchId);
    if (patch) {
      if (patch.moduleId !== input.version.moduleId) throw new FakeStorageError('version_conflict', 'patch module mismatch');
      if (patch.status !== 'proposed') throw new FakeStorageError('state_not_allowed', 'patch is not proposed');
    }
    this.versions.set(input.version.id, structuredClone(input.version));
    for (const updated of input.updatedModules) this.modules.set(updated.id, structuredClone(updated));
    if (!input.updatedModules.some((updated) => updated.id === module.id)) {
      this.modules.set(module.id, { ...module, status: 'accepted', acceptedVersionId: input.version.id, updatedAt: input.version.acceptedAt });
    }
    const nextArtifact: Artifact = {
      ...input.artifact,
      acceptedVersionId: input.version.id,
    };
    this.artifacts.set(artifact.id, structuredClone(nextArtifact));
    if (patch) {
      this.patches.set(patch.id, { ...patch, status: 'accepted', acceptedVersionId: input.version.id });
    }
    const nextTask: Task = { ...task, revision: task.revision + 1, updatedAt: this.clock.now() };
    this.tasks.set(task.id, nextTask);
    const events = await this.appendEvents(input.taskId, input.events as StorageEventDraft[]);
    return {
      version: structuredClone(input.version),
      artifact: structuredClone(nextArtifact),
      taskRevision: nextTask.revision,
      events,
    };
  }

  /* --------------------------------- recovery ------------------------------- */

  async acquireRunLease(runId: string, owner: string, ttlMs: number): Promise<boolean> {
    const existing = this.leases.get(runId);
    const now = Date.now();
    if (existing && existing.expiresAt > now && existing.owner !== owner) return false;
    this.leases.set(runId, { owner, expiresAt: now + ttlMs });
    return true;
  }

  async renewRunLease(runId: string, owner: string, ttlMs: number): Promise<boolean> {
    const existing = this.leases.get(runId);
    if (!existing || existing.owner !== owner) return false;
    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async releaseRunLease(runId: string, owner: string): Promise<void> {
    const existing = this.leases.get(runId);
    if (existing?.owner === owner) this.leases.delete(runId);
  }

  async listLeaseOwner(runId: string): Promise<string | null> {
    const existing = this.leases.get(runId);
    if (!existing) return null;
    return existing.expiresAt > Date.now() ? existing.owner : null;
  }

  /* -------------------------------- maintenance ---------------------------- */

  async resetDemoData(): Promise<void> {
    this.tasks.clear();
    this.artifacts.clear();
    this.modules.clear();
    this.sources.clear();
    this.spans.clear();
    this.versions.clear();
    this.runs.clear();
    this.steps.clear();
    this.checkpoints.clear();
    this.blockers.clear();
    this.decisions.clear();
    this.patches.clear();
    this.reports.clear();
    this.snapshots.clear();
    this.invocations.clear();
    this.recipes.clear();
    this.events.clear();
    this.seqs.clear();
    this.commandResults.clear();
    this.leases.clear();
  }

  async backupTo(destinationDir: string): Promise<string> {
    return `${destinationDir}/fake-backup.db`;
  }

  async close(): Promise<void> {
    /* no-op */
  }

  /* ------------------------------ test helpers ----------------------------- */

  eventsFor(taskId: string): HarnessEvent[] {
    return (this.events.get(taskId) ?? []).map((event) => structuredClone(event));
  }

  eventTypes(taskId: string): string[] {
    return this.eventsFor(taskId).map((event) => event.type);
  }

  seedAcceptedVersion(version: ArtifactVersion): void {
    this.versions.set(version.id, structuredClone(version));
    const module = this.modules.get(version.moduleId);
    if (module) this.modules.set(module.id, { ...module, status: 'accepted', acceptedVersionId: version.id });
  }

  seedUnclearToolInvocation(record: ToolInvocationRecord): void {
    this.invocations.set(record.toolCallId, structuredClone(record));
  }
}

export { FakeStorageError };
export type { StorageEventDraft };
