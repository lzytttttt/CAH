/**
 * Runtime plumbing shared by the planner, executor and command handlers:
 * atomic transactions, run/step/checkpoint/blocker persistence, usage accounting,
 * context snapshot persistence and provider selection.
 *
 * No policy decisions live here — those are explicit in planner/executor/engine.
 */
import {
  DEFAULT_BUDGET_POLICY,
  checkBudget,
  budgetWarning,
  createBudgetUsage,
  newBlockerId,
  newCheckpointId,
  newToolCallId,
  type ArtifactModule,
  type ArtifactVersion,
  type Blocker,
  type BudgetCheck,
  type BudgetPolicy,
  type BudgetResource,
  type BudgetUsage,
  type ContextSnapshot,
  type Decision,
  type EvidenceRef,
  type HarnessEvent,
  type ModuleId,
  type Plan,
  type ProviderCapabilities,
  type ProviderProfile,
  type Run,
  type RunCheckpoint,
  type RunError,
  type RunId,
  type RunState,
  type SourceItem,
  type SourceSpan,
  type Step,
  type StepId,
  type Task,
  type TaskId,
  type ToolDescriptor,
  type ToolId,
  type ToolInvocationRecord,
  type ToolScope,
  type Workspace,
} from '@ca/contracts';
import type { EventDraft, StoragePort, TaskAggregate } from '@ca/storage';
import type { ToolContext, ToolRuntime, ValidatorPort } from '@ca/tools';
import type { Clock, HarnessConfig, ProviderGateway, ToolContextFactoryInput } from './types';
import { EventTx, loadLatestPlanFromEvents, readAllEvents, runInTransaction, transitionRun } from './events-tx';
import { buildContext, type ContextBuildOptions } from './context';
import { estimateTokens } from './hashing';
import { kernelError } from './errors';
import type { ModelCallOutcome, ModelCallParams } from './model-call';
import { streamModel } from './model-call';
import type { ToolExecutionOutcome, ToolExecutionParams } from './tool-exec';
import { runToolExecution } from './tool-exec';

/** Control flags shared between the engine (commands) and a running loop. */
export interface RunControl {
  abort: AbortController;
  pauseRequested: boolean;
  cancelRequested: boolean;
  note: string;
  kind: 'planning' | 'loop';
}

export interface RuntimeDeps {
  storage: StoragePort;
  providers: ProviderGateway;
  tools: ToolRuntime;
  config: HarnessConfig;
  clock: Clock;
  validator: ValidatorPort;
  toolContextFactory: (input: ToolContextFactoryInput) => Promise<ToolContext>;
  onModelDelta?: (event: import('@ca/contracts').ModelEvent) => void;
  onRunFinished?: (runId: RunId, state: RunState) => void | Promise<void>;
}

export interface BuildSnapshotParams {
  task: Task;
  run: Run;
  module: ArtifactModule;
  plan: Plan | null;
  stepId: StepId | null;
  stepGoal: string;
  purpose: 'planner' | 'executor' | 'repair';
  systemPrompt: string;
  instruction: string;
  decisions: readonly Decision[];
  sourceItems: readonly SourceItem[];
  evidenceRefs: readonly EvidenceRef[];
  recentToolResults: ReadonlyArray<{ toolId: string; summary: string }>;
  acceptedVersion: ArtifactVersion | null;
  acceptedUpstream: ReadonlyArray<{ module: ArtifactModule; version: ArtifactVersion }>;
  budgetSummary?: string;
  completedStepSummaries?: readonly string[];
  toolDefinitionTokens?: number;
  /** When true, `run.contextSnapshotId` is bound to this snapshot (plan snapshot). */
  bindToRun: boolean;
}

export interface BlockerSpec {
  type: Blocker['type'];
  severity: Blocker['severity'];
  title: string;
  detail: string;
  evidenceRefs?: EvidenceRef[];
  affectedSteps?: StepId[];
  affectedModuleIds?: ModuleId[];
  resolutions: Blocker['resolutions'];
  returnState: RunState;
  /** Transition the run to AWAITING_INPUT (default true). */
  requestInput?: boolean;
}

export interface CreateBlockerResult {
  blocker: Blocker;
  run: Run;
}

const RUN_TERMINAL: readonly RunState[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

export class Runtime {
  readonly storage: StoragePort;
  readonly providers: ProviderGateway;
  readonly tools: ToolRuntime;
  readonly config: HarnessConfig;
  readonly clock: Clock;
  readonly validator: ValidatorPort;
  readonly toolContextFactory: (input: ToolContextFactoryInput) => Promise<ToolContext>;
  readonly onModelDelta?: (event: import('@ca/contracts').ModelEvent) => void;
  readonly onRunFinished?: (runId: RunId, state: RunState) => void | Promise<void>;

  /** In-memory control for currently executing runs (single-process kernel). */
  readonly controls = new Map<string, RunControl>();
  private descriptorCache: Promise<Map<ToolId, ToolDescriptor>> | null = null;
  private readonly finishedNotified = new Set<string>();

  constructor(deps: RuntimeDeps) {
    this.storage = deps.storage;
    this.providers = deps.providers;
    this.tools = deps.tools;
    this.config = deps.config;
    this.clock = deps.clock;
    this.validator = deps.validator;
    this.toolContextFactory = deps.toolContextFactory;
    this.onModelDelta = deps.onModelDelta;
    this.onRunFinished = deps.onRunFinished;
  }

  now(): string {
    return this.clock.now();
  }

  /* ------------------------------ transactions ------------------------------ */

  async txn<T>(
    taskId: TaskId,
    fn: (tx: EventTx) => Promise<T>,
    options: { runId?: string | null; stepId?: string | null } = {},
  ): Promise<T> {
    return runInTransaction(this, taskId, fn, options);
  }

  async emit(taskId: TaskId, drafts: readonly EventDraft[]): Promise<HarnessEvent[]> {
    if (drafts.length === 0) return [];
    return this.storage.appendEvents(taskId, drafts);
  }

  /* --------------------------------- loading -------------------------------- */

  async loadTask(taskId: TaskId): Promise<Task> {
    const task = await this.storage.getTask(taskId);
    if (!task) throw kernelError('not_found', `任务不存在：${taskId}`);
    return task;
  }

  async loadAggregate(taskId: TaskId): Promise<TaskAggregate> {
    const aggregate = await this.storage.getTaskAggregate(taskId);
    if (!aggregate) throw kernelError('not_found', `任务不存在：${taskId}`);
    return aggregate;
  }

  async loadRun(runId: RunId): Promise<Run> {
    const run = await this.storage.getRun(runId);
    if (!run) throw kernelError('not_found', `运行不存在：${runId}`);
    return run;
  }

  async loadPlan(taskId: TaskId, runId: string, version?: number): Promise<Plan | null> {
    if (version !== undefined) {
      const events = await readAllEvents(this.storage, taskId);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || event.runId !== runId) continue;
        if (event.type !== 'plan.proposed' && event.type !== 'plan.revised') continue;
        const payload = event.payload as { planVersion: number; plan: Plan };
        if (payload.planVersion === version) return payload.plan;
      }
      return null;
    }
    return loadLatestPlanFromEvents(this.storage, taskId, runId);
  }

  async loadDecisions(taskId: TaskId): Promise<Decision[]> {
    return this.storage.listDecisions(taskId);
  }

  async loadSteps(runId: string): Promise<Step[]> {
    return this.storage.listSteps(runId);
  }

  async loadSpans(taskId: TaskId): Promise<SourceSpan[]> {
    return this.storage.listSpans(taskId, 1000);
  }

  async loadSources(taskId: TaskId): Promise<SourceItem[]> {
    return this.storage.listSources(taskId);
  }

  async loadWorkspace(): Promise<Workspace> {
    return this.storage.getWorkspace();
  }

  async toolDescriptors(): Promise<Map<ToolId, ToolDescriptor>> {
    if (!this.descriptorCache) {
      this.descriptorCache = Promise.resolve(this.tools.descriptors()).then(
        (descriptors) => new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])),
      );
    }
    return this.descriptorCache;
  }

  /* -------------------------------- providers ------------------------------- */

  async selectProvider(): Promise<{ profile: ProviderProfile; capabilities: ProviderCapabilities } | null> {
    const configured = this.config.defaultModelProfileId;
    if (configured) {
      const profile = await this.providers.getProfile(configured);
      if (profile && profile.enabled) {
        return { profile, capabilities: await this.providers.capabilities(profile.id) };
      }
    }
    const enabled = await this.providers.listEnabledProfiles();
    const profile = enabled[0] ?? null;
    if (!profile) return null;
    return { profile, capabilities: await this.providers.capabilities(profile.id) };
  }

  /* --------------------------------- context -------------------------------- */

  async buildAndPersistContext(
    params: BuildSnapshotParams,
  ): Promise<{ snapshot: ContextSnapshot; systemPrompt: string; userPrompt: string; run: Run }> {
    const workspace = await this.loadWorkspace();
    const input = {
      workspaceSettings: workspace.settings,
      task: params.task,
      module: params.module,
      acceptedVersion: params.acceptedVersion,
      acceptedUpstream: [...params.acceptedUpstream],
      sourceRefs: params.sourceItems.map((source) => ({ sourceId: source.id, version: source.version })),
      stepGoal: params.stepGoal,
      evidenceRefs: [...params.evidenceRefs],
      recentToolResults: [...params.recentToolResults],
      plan: params.plan,
      // Additive, kernel-internal budgeting fields (see ./types ContextBuildInput).
      tokenBudget: this.config.contextTokenBudget,
      reserveTokens: this.config.contextReserveTokens,
    } as import('./types').ContextBuildInput & { tokenBudget: number; reserveTokens: number };
    const options: ContextBuildOptions = {
      purpose: params.purpose,
      clock: this.clock,
      runId: params.run.id,
      stepId: params.stepId,
      policyVersion: this.config.policyVersion,
      promptBundleVersion: this.config.promptBundleVersion,
      systemPrompt: params.systemPrompt,
      instruction: params.instruction,
      decisions: params.decisions,
      sources: params.sourceItems,
      budgetSummary: params.budgetSummary,
      completedStepSummaries: params.completedStepSummaries,
      toolDefinitionTokens: params.toolDefinitionTokens,
    };
    const built = buildContext(input, options);
    const updatedRun = await this.txn(
      params.task.id,
      async (tx) => {
        await this.storage.insertContextSnapshot(built.snapshot);
        tx.emit('context.snapshot_created', {
          contextSnapshotId: built.snapshot.id,
          runId: params.run.id,
          stepId: params.stepId,
          estimatedTokens: built.snapshot.estimatedInputTokens,
          fragmentCount: built.snapshot.fragments.length,
          omittedCount: built.snapshot.omitted.length,
        });
        if (!params.bindToRun) return params.run;
        const fresh = await this.loadRun(params.run.id);
        const next: Run = {
          ...fresh,
          contextSnapshotId: built.snapshot.id,
          revision: fresh.revision + 1,
          updatedAt: this.now(),
        };
        await this.storage.updateRun(next, fresh.revision);
        return next;
      },
      { runId: params.run.id, stepId: params.stepId },
    );
    return { snapshot: built.snapshot, systemPrompt: built.systemPrompt, userPrompt: built.userPrompt, run: updatedRun };
  }

  /* ---------------------------------- usage --------------------------------- */

  mergeUsage(
    usage: BudgetUsage,
    change: {
      modelRequests?: number;
      toolCalls?: number;
      inputTokens?: number | null;
      outputTokens?: number | null;
      estimatedInputTokens?: number;
      estimatedOutputTokens?: number;
      usdCost?: number | null;
      elapsedActiveMs?: number;
    },
  ): BudgetUsage {
    return {
      ...usage,
      modelRequests: usage.modelRequests + (change.modelRequests ?? 0),
      toolCalls: usage.toolCalls + (change.toolCalls ?? 0),
      inputTokens: usage.inputTokens + Math.max(0, change.inputTokens ?? 0),
      outputTokens: usage.outputTokens + Math.max(0, change.outputTokens ?? 0),
      estimatedInputTokens: usage.estimatedInputTokens + Math.max(0, change.estimatedInputTokens ?? 0),
      estimatedOutputTokens: usage.estimatedOutputTokens + Math.max(0, change.estimatedOutputTokens ?? 0),
      usdCost: change.usdCost == null ? usage.usdCost : (usage.usdCost ?? 0) + change.usdCost,
      elapsedActiveMs: usage.elapsedActiveMs + Math.max(0, change.elapsedActiveMs ?? 0),
      startedAt: usage.startedAt ?? this.now(),
      updatedAt: this.now(),
    };
  }

  /**
   * Persist a usage delta on a run (transactional with usage.updated and, when a
   * threshold is first crossed, budget.warning). Returns the refreshed run.
   */
  async recordUsage(
    run: Run,
    change: Parameters<Runtime['mergeUsage']>[1],
    hooks: {
      before?: (tx: EventTx) => void | Promise<void>;
      after?: (tx: EventTx) => void | Promise<void>;
    } = {},
  ): Promise<{ run: Run; usage: BudgetUsage; warning: BudgetResource | null }> {
    return this.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.loadRun(run.id);
        const usage = this.mergeUsage(fresh.budgetUsage, change);
        const warning = budgetWarning(fresh.budgetPolicy, usage);
        const crossed = warning !== null && budgetWarning(fresh.budgetPolicy, fresh.budgetUsage) === null;
        const next: Run = {
          ...fresh,
          budgetUsage: usage,
          revision: fresh.revision + 1,
          updatedAt: this.now(),
          startedAt: fresh.startedAt ?? this.now(),
        };
        await this.storage.updateRun(next, fresh.revision);
        await hooks.before?.(tx);
        tx.emit('usage.updated', {
          modelRequests: usage.modelRequests,
          toolCalls: usage.toolCalls,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimated: usage.estimatedInputTokens > 0 || usage.estimatedOutputTokens > 0,
          usdCost: usage.usdCost,
        });
        if (crossed && warning) {
          tx.emit('budget.warning', { resource: warning.resource, used: warning.used, limit: warning.limit });
        }
        await hooks.after?.(tx);
        return { run: next, usage, warning: warning?.resource ?? null };
      },
      { runId: run.id },
    );
  }

  checkRunBudget(run: Run): BudgetCheck {
    return checkBudget(run.budgetPolicy, run.budgetUsage);
  }

  /* -------------------------------- states ---------------------------------- */

  /** Generic state transition with its business event, atomically persisted. */
  async setRunState(
    run: Run,
    to: RunState,
    reason: string,
    patch: Partial<Run> = {},
    extraEvents?: (tx: EventTx) => void,
  ): Promise<Run> {
    return this.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.loadRun(run.id);
        if (fresh.state === to) return fresh;
        const next = transitionRun(fresh, to, reason, this.now(), patch);
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', { from: fresh.state, to, reason: reason.slice(0, 2000) });
        extraEvents?.(tx);
        return next;
      },
      { runId: run.id },
    );
  }

  async finalizeTerminal(runId: string): Promise<void> {
    if (this.finishedNotified.has(runId)) return;
    this.finishedNotified.add(runId);
    const run = await this.storage.getRun(runId);
    if (!run) return;
    await Promise.resolve(this.onRunFinished?.(run.id, run.state));
  }

  /** Mark open blockers cancelled when a run ends. */
  async cancelOpenBlockers(taskId: TaskId, runId: string, tx: EventTx, reason: string): Promise<void> {
    const blockers = await this.storage.listBlockers(taskId);
    for (const blocker of blockers) {
      if (blocker.runId !== runId || blocker.status !== 'open') continue;
      const cancelled: Blocker = {
        ...blocker,
        status: 'cancelled',
        clearedAt: this.now(),
      };
      await this.storage.updateBlocker(cancelled);
      void reason;
      void tx;
    }
  }

  async failRun(
    run: Run,
    error: RunError,
    options: { cancelBlockers?: boolean } = {},
  ): Promise<Run> {
    const updated = await this.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.loadRun(run.id);
        if (RUN_TERMINAL.includes(fresh.state)) return fresh;
        const next = transitionRun(fresh, 'FAILED', error.message, this.now(), {
          error,
          finishedAt: this.now(),
          returnState: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', {
          from: fresh.state,
          to: 'FAILED',
          reason: error.message.slice(0, 2000),
        });
        tx.emit('run.failed', {
          runId: next.id,
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            stage: error.stage,
          },
          draftPreserved: true,
          acceptedVersionUnchanged: true,
        });
        if (options.cancelBlockers !== false) {
          await this.cancelOpenBlockers(run.taskId, run.id, tx, '运行失败');
        }
        return next;
      },
      { runId: run.id },
    );
    return updated;
  }

  async cancelRunAtBoundary(run: Run, reason: string): Promise<Run> {
    const updated = await this.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.loadRun(run.id);
        if (RUN_TERMINAL.includes(fresh.state)) return fresh;
        if (fresh.state === 'COMMITTING') {
          throw kernelError('state_not_allowed', '提交事务进行中，不能取消；请在事务结束后按实际结果处理。');
        }
        let next = fresh;
        if (next.state !== 'CANCELLING') {
          next = transitionRun(next, 'CANCELLING', reason, this.now());
          tx.emit('run.state_changed', { from: fresh.state, to: 'CANCELLING', reason: reason.slice(0, 2000) });
        }
        next = transitionRun(next, 'CANCELLED', reason, this.now(), {
          finishedAt: this.now(),
          returnState: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', { from: 'CANCELLING', to: 'CANCELLED', reason: reason.slice(0, 2000) });
        tx.emit('run.cancelled', {
          runId: next.id,
          reason: reason.slice(0, 2000),
          draftPreserved: true,
          acceptedVersionUnchanged: true,
        });
        await this.cancelOpenBlockers(run.taskId, run.id, tx, reason);
        return next;
      },
      { runId: run.id },
    );
    await this.finalizeTerminal(updated.id);
    return updated;
  }

  /**
   * Pause at the next safe boundary: PAUSING then PAUSED with a checkpoint.
   * Only valid from RUNNING / VALIDATING / PAUSING (and READY handled by engine).
   */
  async pauseAtSafeBoundary(
    run: Run,
    note: string,
    reason: string,
    checkpointData: Record<string, unknown>,
    budget?: BudgetCheck,
  ): Promise<Run> {
    const updated = await this.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.loadRun(run.id);
        if (fresh.state === 'PAUSED') return fresh;
        if (!['RUNNING', 'VALIDATING', 'PAUSING'].includes(fresh.state)) {
          throw kernelError('state_not_allowed', `当前状态 ${fresh.state} 不能进入暂停`);
        }
        const checkpoint = await this.insertCheckpointInTx(tx, fresh, 'state', null, checkpointData);
        const returnState: RunState = fresh.returnState ?? (fresh.state === 'PAUSING' ? 'RUNNING' : fresh.state);
        let next = fresh;
        if (next.state !== 'PAUSING') {
          next = transitionRun(next, 'PAUSING', reason, this.now(), { checkpointId: checkpoint.id, returnState });
          tx.emit('run.state_changed', { from: fresh.state, to: 'PAUSING', reason: reason.slice(0, 2000) });
        }
        next = transitionRun(next, 'PAUSED', reason, this.now(), {
          checkpointId: checkpoint.id,
          returnState,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', { from: 'PAUSING', to: 'PAUSED', reason: reason.slice(0, 2000) });
        if (budget && !budget.allowed) {
          tx.emit('budget.exhausted', {
            resource: budget.resource ?? 'model_requests',
            used: budget.used,
            limit: budget.limit,
            message: budget.message.slice(0, 1000),
          });
        }
        const steps = await this.storage.listSteps(run.id);
        const completedSteps = steps.filter((step) => step.status === 'completed').length;
        tx.emit('run.paused', {
          runId: next.id,
          returnState,
          completedSteps,
          pendingSteps: Math.max(0, steps.length - completedSteps),
          atSafeBoundary: true,
          note: note.slice(0, 1000),
        });
        return next;
      },
      { runId: run.id },
    );
    return updated;
  }

  /* -------------------------------- checkpoint ------------------------------- */

  private async insertCheckpointInTx(
    tx: EventTx,
    run: Run,
    kind: RunCheckpoint['kind'],
    stepId: StepId | null,
    data: Record<string, unknown>,
  ): Promise<RunCheckpoint> {
    const seq = await this.storage.latestSeq(run.taskId);
    const checkpoint: RunCheckpoint = {
      id: newCheckpointId(),
      runId: run.id,
      kind,
      stepId,
      seqAtCheckpoint: seq,
      dataJson: JSON.stringify(data).slice(0, 200_000),
      createdAt: this.now(),
    };
    await this.storage.insertCheckpoint(checkpoint);
    void tx;
    return checkpoint;
  }

  /** Persist a recovery checkpoint and point the run at it (internal metadata, no business event). */
  async checkpoint(
    run: Run,
    kind: RunCheckpoint['kind'],
    stepId: StepId | null,
    data: Record<string, unknown>,
  ): Promise<RunCheckpoint> {
    return this.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.loadRun(run.id);
        const checkpoint = await this.insertCheckpointInTx(tx, fresh, kind, stepId, data);
        const next: Run = {
          ...fresh,
          checkpointId: checkpoint.id,
          revision: fresh.revision + 1,
          updatedAt: this.now(),
        };
        await this.storage.updateRun(next, fresh.revision);
        return checkpoint;
      },
      { runId: run.id, stepId },
    );
  }

  async latestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    return this.storage.latestCheckpoint(runId);
  }

  /* -------------------------------- blockers -------------------------------- */

  async createBlocker(run: Run, spec: BlockerSpec): Promise<CreateBlockerResult> {
    return this.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.loadRun(run.id);
        if (RUN_TERMINAL.includes(fresh.state) || fresh.state === 'COMMITTING') {
          throw kernelError('state_not_allowed', `当前状态 ${fresh.state} 不能创建阻塞`);
        }
        const blocker: Blocker = {
          id: newBlockerId(),
          taskId: fresh.taskId,
          runId: fresh.id,
          type: spec.type,
          severity: spec.severity,
          title: spec.title.slice(0, 300),
          detail: spec.detail.slice(0, 4000),
          evidenceRefs: (spec.evidenceRefs ?? []).slice(0, 32),
          affectedSteps: (spec.affectedSteps ?? []).slice(0, 32),
          affectedModuleIds: (spec.affectedModuleIds ?? []).slice(0, 8),
          resolutions: spec.resolutions.slice(0, 16),
          status: 'open',
          resolution: null,
          returnState: spec.returnState,
          createdAt: this.now(),
          resolvedAt: null,
          clearedAt: null,
        };
        await this.storage.insertBlocker(blocker);
        tx.emit('blocker.detected', { blocker });
        if (spec.requestInput !== false) {
          tx.emit('input.requested', {
            blockerId: blocker.id,
            title: blocker.title,
            resolutionOptionIds: blocker.resolutions.map((option) => option.id),
          });
        }
        let next = fresh;
        if (spec.requestInput !== false && fresh.state !== 'AWAITING_INPUT') {
          next = transitionRun(fresh, 'AWAITING_INPUT', spec.title, this.now(), {
            returnState: spec.returnState,
          });
          await this.storage.updateRun(next, fresh.revision);
          tx.emit('run.state_changed', {
            from: fresh.state,
            to: 'AWAITING_INPUT',
            reason: spec.title.slice(0, 2000),
          });
        }
        return { blocker, run: next };
      },
      { runId: run.id },
    );
  }

  /** Resolve an open blocker, record the decision, and return the updated blocker/run. */
  async resolveBlocker(
    run: Run,
    blocker: Blocker,
    resolution: NonNullable<Blocker['resolution']>,
    decision: Decision,
  ): Promise<{ blocker: Blocker; run: Run }> {
    return this.txn(
      run.taskId,
      async (tx) => {
        const freshRun = await this.loadRun(run.id);
        const freshBlocker = await this.storage.getBlocker(blocker.id);
        if (!freshBlocker) throw kernelError('not_found', `阻塞不存在：${blocker.id}`);
        if (freshBlocker.status !== 'open') {
          throw kernelError('state_not_allowed', '阻塞已被处理，不能重复解决');
        }
        const now = this.now();
        const resolved: Blocker = {
          ...freshBlocker,
          status: 'cleared',
          resolution,
          resolvedAt: now,
          clearedAt: now,
        };
        await this.storage.updateBlocker(resolved);
        await this.storage.insertDecision(decision);
        tx.emit('input.resolved', {
          blockerId: resolved.id,
          optionId: resolution.optionId,
          valuePreview: previewValue(resolution.value).slice(0, 1000),
          decidedBy: resolution.decidedBy,
        });
        tx.emit('blocker.cleared', { blockerId: resolved.id, invalidatedSteps: [] });
        return { blocker: resolved, run: freshRun };
      },
      { runId: run.id },
    );
  }

  /* ---------------------------------- model --------------------------------- */

  async callModel(params: ModelCallParams): Promise<ModelCallOutcome> {
    return streamModel(this, params);
  }

  /* ---------------------------------- tools --------------------------------- */

  async executeTool(params: ToolExecutionParams): Promise<ToolExecutionOutcome> {
    return runToolExecution(this, params);
  }
}

function previewValue(value: unknown): string {
  if (value === null || value === undefined) return '（空）';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '（空）';
  } catch {
    return '（不可序列化）';
  }
}

/* ------------------------------ shared helpers ------------------------------ */

export function emptyUsage(now: string): BudgetUsage {
  return createBudgetUsage(now);
}

export function defaultBudgetPolicy(): BudgetPolicy {
  return { ...DEFAULT_BUDGET_POLICY };
}

/** Derive the granted tool scopes from the committed plan's tool requirements. */
export function grantedScopesForPlan(plan: Plan, descriptors: ReadonlyMap<ToolId, ToolDescriptor>): ToolScope[] {
  const scopes = new Set<ToolScope>();
  for (const requirement of plan.tools) {
    const descriptor = descriptors.get(requirement.toolId);
    if (!descriptor) continue;
    for (const scope of descriptor.policy.requiredScopes) scopes.add(scope);
  }
  return [...scopes];
}

/** True when a tool is part of the plan allow-list. */
export function planAllowsTool(plan: Plan, toolId: ToolId): boolean {
  return plan.tools.some((requirement) => requirement.toolId === toolId);
}

/** Estimate tokens of model-facing tool definitions without calling the runtime. */
export function estimateToolDefinitionTokens(definitions: ReadonlyArray<{ name: string; description: string; parameters: unknown }>): number {
  return definitions.reduce(
    (sum, definition) => sum + estimateTokens(definition.name) + estimateTokens(definition.description) + estimateTokens(JSON.stringify(definition.parameters ?? {})),
    0,
  );
}

/** Tool result hash/size helpers used by the tool executor. */
export function toolCallId(): string {
  return newToolCallId();
}

export function ensureToolInvocationRecord(record: ToolInvocationRecord): ToolInvocationRecord {
  return record;
}
