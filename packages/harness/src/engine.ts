/**
 * createHarnessEngine — the command surface + orchestration of the execution
 * kernel.
 *
 * Invariants enforced here:
 * - `expectedRevision` is always the current Task.revision (Lead decision).
 * - every persisted business state change emits its business event in the same
 *   storage.transaction() (via runtime.txn/setRunState); acceptance is one
 *   storage transaction including commitAcceptance.
 * - no fabricated success: validation findings, bounded repair, blockers or
 *   FAILED states are the only possible outcomes of a failed check.
 * - timers are only used for leases/network limits, never for business outcomes.
 */
import {
  BudgetPolicySchema,
  EvidenceRefSchema,
  ModuleContentSchema,
  TIME_LIMITS,
  canTransitionModule,
  diffModuleContent,
  findPlanCycle,
  findUnknownPlanDependencies,
  isCommitAllowed,
  newArtifactVersionId,
  newBlockerId,
  newDecisionId,
  newPatchId,
  newRunId,
  summarizeValidationFailures,
  validateBlockResolution,
  DEFAULT_BUDGET_POLICY,
  type Artifact,
  type ArtifactModule,
  type ArtifactVersion,
  type BudgetCheck,
  type BudgetPolicy,
  type Blocker,
  type ChangeSummary,
  type Decision,
  type EvidenceRef,
  type HarnessEvent,
  type ModelMessage,
  type ModuleContent,
  type PatchProposal,
  type Plan,
  type Run,
  type RunError,
  type RunId,
  type RunState,
  type Task,
  type TaskId,
  type ValidationReport,
  type Workspace,
} from '@ca/contracts';
import type { CommitAcceptanceInput, CommitAcceptanceResult, EventDraft, StoragePort, TaskAggregate } from '@ca/storage';
import type { ValidatorPort } from '@ca/tools';
import type {
  AcceptPatchCommand,
  AcceptResult,
  CancelCommand,
  CommitPlanCommand,
  HarnessDeps,
  HarnessEngine,
  PauseCommand,
  PlanCommand,
  RecoveryReport,
  RejectPatchCommand,
  ResolveInputCommand,
  RestoreVersionCommand,
  ResumeCommand,
  RunDetail as RunDetailType,
  RunHandle,
} from './types';
import { HarnessError, systemClock, type Clock } from './types';
import { Runtime, type RunControl } from './runtime';
import { loadLatestPlanFromEvents, loadLatestValidationReportId, transitionRun } from './events-tx';
import { createArtifactValidator } from './validator';
import { parseCandidateOutput, runExecutor } from './executor';
import {
  buildPlanBlockerSpecs,
  revisePlanAfterDecisions,
  runPlanStage,
} from './planner';
import {
  renderRepairInstruction,
  renderRepairSystem,
} from './prompts';
import { detectConstraintConflicts } from './risk-rules';
import { contentHash, truncateBytes, truncateChars } from './hashing';
import { CandidateParseError, isRevisionConflict, isVersionConflict, kernelError, toKernelError } from './errors';
import { recoverInterruptedRuns } from './recovery';

const COMMAND_MARKER = '__harnessEngine';

interface StoredCommandResult {
  [COMMAND_MARKER]: string;
  kind: string;
  [key: string]: unknown;
}

export function createHarnessEngine(deps: HarnessDeps): HarnessEngine {
  return new HarnessEngineImpl(deps);
}

class HarnessEngineImpl implements HarnessEngine {
  readonly validator: ValidatorPort;
  private readonly runtime: Runtime;
  private readonly storage: StoragePort;
  private readonly clock: Clock;
  private readonly loops = new Map<string, Promise<void>>();
  private readonly controls = new Map<string, RunControl>();
  private readonly leaseTimers = new Map<string, ReturnType<typeof setInterval>>();
  private shuttingDown = false;

  constructor(private readonly deps: HarnessDeps) {
    this.storage = deps.storage;
    this.clock = deps.clock ?? systemClock;
    this.validator = createArtifactValidator({ storage: deps.storage, clock: this.clock });
    this.runtime = new Runtime({
      storage: deps.storage,
      providers: deps.providers,
      tools: deps.tools,
      config: deps.config,
      clock: this.clock,
      validator: this.validator,
      toolContextFactory: deps.toolContextFactory,
      onModelDelta: deps.onModelDelta,
      onRunFinished: deps.onRunFinished,
    });
  }

  /* -------------------------------- helpers -------------------------------- */

  private async loadAggregateWithRevision(taskId: TaskId, expectedRevision: number): Promise<TaskAggregate> {
    const aggregate = await this.runtime.loadAggregate(taskId);
    if (aggregate.task.revision !== expectedRevision) {
      throw new HarnessError(
        'revision_conflict',
        `任务修订号已变化：期望 ${expectedRevision}，当前 ${aggregate.task.revision}；请刷新后重试。`,
        { retryable: true, details: { expectedRevision, actualRevision: aggregate.task.revision } },
      );
    }
    return aggregate;
  }

  private async readCommandResult(commandId: string, kind: string): Promise<Record<string, unknown> | null> {
    try {
      const stored = await this.storage.getCommandResult(commandId as never);
      if (!stored) return null;
      if ((stored as Partial<StoredCommandResult>)[COMMAND_MARKER] !== 'harness-engine-1') return null;
      if ((stored as Partial<StoredCommandResult>).kind !== kind) return null;
      return stored;
    } catch {
      return null;
    }
  }

  private async saveCommandResult(commandId: string, kind: string, taskId: TaskId | null, response: Record<string, unknown>): Promise<void> {
    try {
      await this.storage.saveCommandResult(commandId as never, kind, taskId, {
        [COMMAND_MARKER]: 'harness-engine-1',
        kind,
        ...response,
      });
    } catch {
      // Idempotency bookkeeping must never fail the business command that already committed.
    }
  }

  private async planForRun(taskId: TaskId, runId: string): Promise<Plan | null> {
    return loadLatestPlanFromEvents(this.storage, taskId, runId);
  }

  private handleFor(run: Run, plan: Plan | null = null): RunHandle {
    return { runId: run.id, state: run.state, plan };
  }

  private newControl(kind: 'planning' | 'loop'): RunControl {
    return {
      abort: new AbortController(),
      pauseRequested: false,
      cancelRequested: false,
      note: '',
      kind,
    };
  }

  private async budgetPolicyFromCommand(workspace: Workspace, overrides?: Partial<BudgetPolicy>): Promise<BudgetPolicy> {
    const base = workspace.settings.defaultBudget ?? DEFAULT_BUDGET_POLICY;
    try {
      return BudgetPolicySchema.parse({ ...base, ...(overrides ?? {}) });
    } catch (error) {
      throw kernelError('bad_request', `预算参数不合法：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /* --------------------------------- plan ---------------------------------- */

  async plan(command: PlanCommand): Promise<RunHandle> {
    const previous = await this.readCommandResult(command.commandId, 'plan');
    if (previous && typeof previous.runId === 'string') {
      const run = await this.storage.getRun(previous.runId as never);
      if (run) {
        const plan = await this.planForRun(run.taskId, run.id);
        return { runId: run.id, state: run.state, plan };
      }
    }
    const aggregate = await this.loadAggregateWithRevision(command.taskId, command.expectedRevision);
    const module = aggregate.modules.find((entry) => entry.id === command.moduleId);
    if (!module) {
      throw kernelError('not_found', `目标模块不存在：${command.moduleId}`);
    }
    if (await this.storage.findActiveRunId(command.taskId)) {
      throw kernelError('conflict', '该任务已有进行中的运行，请等待其结束或取消后再创建新的运行。');
    }
    const workspace = await this.runtime.loadWorkspace();
    const budgetPolicy = await this.budgetPolicyFromCommand(workspace, command.budgetOverrides);
    const baseVersion = await this.storage.getAcceptedVersion(module.id);
    const now = this.clock.now();
    const run: Run = {
      id: newRunId(),
      taskId: command.taskId,
      moduleId: module.id,
      mode: this.storage.mode,
      origin: 'intent',
      state: 'CREATED',
      planVersion: 0,
      contextSnapshotId: null,
      budgetPolicy,
      budgetUsage: {
        modelRequests: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        usdCost: null,
        elapsedActiveMs: 0,
        startedAt: null,
        updatedAt: now,
      },
      baseVersionId: baseVersion?.id ?? null,
      revision: 0,
      returnState: null,
      interrupted: null,
      error: null,
      checkpointId: null,
      attempt: 1,
      autoAcceptPolicyApplied: false,
      queuePosition: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };

    let planningRun: Run;
    try {
      planningRun = await this.runtime.txn(command.taskId, async (tx) => {
        await this.storage.bumpTaskRevision(command.taskId, command.expectedRevision);
        await this.storage.insertRun(run);
        tx.emit('run.created', {
          runId: run.id,
          taskId: command.taskId,
          moduleId: module.id,
          origin: 'intent',
          baseVersionId: run.baseVersionId,
          budget: { maxModelRequests: budgetPolicy.maxModelRequests, maxToolCalls: budgetPolicy.maxToolCalls },
        });
        const planning = transitionRun(run, 'PLANNING', '计划命令已接受', this.clock.now());
        await this.storage.updateRun(planning, run.revision);
        tx.emit('run.state_changed', { from: 'CREATED', to: 'PLANNING', reason: '计划命令已接受，开始生成计划' });
        return planning;
      }, { runId: run.id });
    } catch (error) {
      if (isRevisionConflict(error)) {
        throw new HarnessError('revision_conflict', '任务修订号已变化，计划命令被拒绝。', { retryable: true });
      }
      throw toKernelError(error);
    }

    const control = this.newControl('planning');
    this.controls.set(planningRun.id, control);
    let outcome: Awaited<ReturnType<typeof runPlanStage>>;
    try {
      outcome = await runPlanStage({
        runtime: this.runtime,
        command,
        task: aggregate.task,
        run: planningRun,
        module,
        baseVersion,
        aggregate,
        control,
      });
    } catch (error) {
      const kernel = toKernelError(error);
      const fresh = await this.storage.getRun(planningRun.id);
      if (fresh && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(fresh.state)) {
        const failed = await this.runtime.failRun(fresh, {
          code: kernel.code,
          message: kernel.message,
          retryable: kernel.retryable,
          stage: 'planning',
          details: typeof kernel.details === 'string' ? kernel.details.slice(0, 4000) : '',
        });
        await this.runtime.finalizeTerminal(failed.id);
      }
      this.controls.delete(planningRun.id);
      throw kernel;
    } finally {
      this.controls.delete(planningRun.id);
    }

    switch (outcome.kind) {
      case 'ready': {
        let run = outcome.run;
        if (control.cancelRequested) {
          const cancelled = await this.runtime.cancelRunAtBoundary(run, control.note || '用户取消');
          return this.handleFor(cancelled, outcome.plan);
        }
        if (control.pauseRequested) {
          const paused = await this.pauseFromReady(run, '计划已生成，按暂停请求进入安全暂停');
          await this.saveCommandResult(command.commandId, 'plan', command.taskId, { runId: run.id, state: paused.state, planVersion: outcome.plan.version });
          return this.handleFor(paused, outcome.plan);
        }
        run = outcome.run;
        await this.saveCommandResult(command.commandId, 'plan', command.taskId, { runId: run.id, state: run.state, planVersion: outcome.plan.version });
        return this.handleFor(run, outcome.plan);
      }
      case 'awaiting_input': {
        await this.saveCommandResult(command.commandId, 'plan', command.taskId, { runId: outcome.run.id, state: outcome.run.state, planVersion: outcome.plan.version });
        return this.handleFor(outcome.run, outcome.plan);
      }
      case 'cancelled': {
        const cancelled = await this.runtime.cancelRunAtBoundary(outcome.run, control.note || '用户取消');
        return this.handleFor(cancelled, null);
      }
      case 'failed': {
        return this.handleFor(outcome.run, null);
      }
    }
  }

  /** READY → PAUSING → PAUSED (used when a pause request arrived during planning). */
  private async pauseFromReady(run: Run, note: string): Promise<Run> {
    return this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'READY') return fresh;
        const checkpoint = await this.runtime.checkpoint(fresh, 'state', null, { phase: 'ready', note });
        let next = transitionRun(fresh, 'PAUSING', note, this.clock.now(), { checkpointId: checkpoint.id });
        next = transitionRun(next, 'PAUSED', note, this.clock.now(), {
          checkpointId: checkpoint.id,
          returnState: 'READY',
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', { from: 'READY', to: 'PAUSING', reason: note.slice(0, 2000) });
        tx.emit('run.state_changed', { from: 'PAUSING', to: 'PAUSED', reason: note.slice(0, 2000) });
        tx.emit('run.paused', {
          runId: next.id,
          returnState: 'READY',
          completedSteps: 0,
          pendingSteps: 0,
          atSafeBoundary: true,
          note: note.slice(0, 1000),
        });
        return next;
      },
      { runId: run.id },
    );
  }

  /** Persist a revised plan that still contains blocking items (AWAITING_INPUT). */
  private async persistRevisedPlanWithBlockers(
    run: Run,
    plan: Plan,
    specs: ReturnType<typeof buildPlanBlockerSpecs>,
  ): Promise<Run> {
    return this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'AWAITING_INPUT') {
          throw kernelError('state_not_allowed', `当前状态 ${fresh.state} 不能写入修订计划。`);
        }
        const blockers: Blocker[] = specs.map((spec) => ({
          id: newBlockerId(),
          taskId: fresh.taskId,
          runId: fresh.id,
          type: spec.type,
          severity: spec.severity,
          title: spec.title,
          detail: spec.detail,
          evidenceRefs: [],
          affectedSteps: [],
          affectedModuleIds: [plan.targetModuleId],
          resolutions: spec.resolutions,
          status: 'open',
          resolution: null,
          returnState: 'READY',
          createdAt: this.clock.now(),
          resolvedAt: null,
          clearedAt: null,
        }));
        const next: Run = {
          ...fresh,
          planVersion: plan.version,
          returnState: 'READY',
          revision: fresh.revision + 1,
          updatedAt: this.clock.now(),
        };
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('plan.revised', {
          runId: next.id,
          planVersion: plan.version,
          reason: '根据用户决策生成新的计划版本，仍有阻塞项需要处理',
          plan,
        });
        for (const blocker of blockers) {
          await this.storage.insertBlocker(blocker);
          tx.emit('blocker.detected', { blocker });
          tx.emit('input.requested', {
            blockerId: blocker.id,
            title: blocker.title,
            resolutionOptionIds: blocker.resolutions.map((option) => option.id),
          });
        }
        return next;
      },
      { runId: run.id },
    );
  }

  /** Persist a revised plan that has no remaining blocking items → READY. */
  private async persistRevisedReadyPlan(run: Run, plan: Plan): Promise<Run> {
    return this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'AWAITING_INPUT') {
          throw kernelError('state_not_allowed', `当前状态 ${fresh.state} 不能进入 READY。`);
        }
        const next = transitionRun(fresh, 'READY', '阻塞项已由用户处理，修订计划通过校验', this.clock.now(), {
          planVersion: plan.version,
          returnState: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('plan.revised', {
          runId: next.id,
          planVersion: plan.version,
          reason: '根据用户决策生成新的计划版本，阻塞项已解除',
          plan,
        });
        tx.emit('plan.ready', { runId: next.id, planVersion: plan.version });
        tx.emit('run.state_changed', {
          from: 'AWAITING_INPUT',
          to: 'READY',
          reason: '阻塞项已由用户处理，计划等待提交',
        });
        return next;
      },
      { runId: run.id },
    );
  }

  /* -------------------------------- commit --------------------------------- */

  async commit(command: CommitPlanCommand): Promise<RunHandle> {
    const previous = await this.readCommandResult(command.commandId, 'commit');
    if (previous && typeof previous.runId === 'string') {
      const run = await this.storage.getRun(previous.runId as never);
      if (run) return this.handleFor(run, await this.planForRun(run.taskId, run.id));
    }
    let run = await this.runtime.loadRun(command.runId);
    await this.loadAggregateWithRevision(run.taskId, command.expectedRevision);
    if (run.state !== 'READY') {
      throw kernelError('state_not_allowed', `当前运行状态为 ${run.state}，只有 READY 状态可以提交计划。`, {
        details: { state: run.state },
      });
    }
    if (command.planVersion !== run.planVersion) {
      throw kernelError('state_not_allowed', `计划版本 ${command.planVersion} 不是当前版本 ${run.planVersion}；请重新生成计划。`);
    }
    if (command.contextSnapshotId !== run.contextSnapshotId) {
      throw kernelError('schema_invalid', '提交绑定的上下文快照与当前计划快照不一致；请重新检查计划。');
    }
    const snapshot = await this.storage.getContextSnapshot(command.contextSnapshotId);
    if (!snapshot || snapshot.runId !== run.id) {
      throw kernelError('state_not_allowed', '计划上下文快照不存在或不属于该运行；请重新生成计划。');
    }
    const plan = await this.planForRun(run.taskId, run.id);
    if (!plan || plan.version !== run.planVersion) {
      throw kernelError('state_not_allowed', '找不到当前计划版本，无法提交。');
    }
    if (findPlanCycle(plan.steps) || findUnknownPlanDependencies(plan.steps).length > 0) {
      throw kernelError('validation_failed', '计划依赖图不合法（存在环或未知依赖），禁止提交。');
    }
    if (plan.risks.some((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null)) {
      throw kernelError('state_not_allowed', '计划仍有阻止提交的风险未处理，禁止提交。');
    }
    if (plan.openQuestions.some((question) => question.blocking)) {
      throw kernelError('state_not_allowed', '计划仍有阻塞性待决问题未回答，禁止提交。');
    }

    run = await this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'READY') {
          throw kernelError('state_not_allowed', `运行状态已变为 ${fresh.state}，无法提交。`);
        }
        const next = transitionRun(fresh, 'RUNNING', `计划已由 ${command.actor} 提交`, this.clock.now(), {
          startedAt: fresh.startedAt ?? this.clock.now(),
          planVersion: plan.version,
          contextSnapshotId: command.contextSnapshotId as never,
          returnState: null,
          error: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('plan.committed', {
          runId: next.id,
          planVersion: plan.version,
          contextSnapshotId: command.contextSnapshotId as never,
          committedBy: command.actor.slice(0, 100),
        });
        tx.emit('run.started', { runId: next.id, attempt: next.attempt, planVersion: plan.version });
        tx.emit('run.state_changed', { from: 'READY', to: 'RUNNING', reason: '计划已提交，开始执行' });
        return next;
      },
      { runId: run.id },
    );

    await this.saveCommandResult(command.commandId, 'commit', run.taskId, { runId: run.id, state: run.state, planVersion: plan.version });
    void this.startLoop(run.id, 'execution').catch(() => undefined);
    return this.handleFor(run, plan);
  }

  /* -------------------------------- resolve -------------------------------- */

  async resolve(command: ResolveInputCommand): Promise<RunHandle> {
    const previous = await this.readCommandResult(command.commandId, 'resolve');
    if (previous && typeof previous.runId === 'string') {
      const run = await this.storage.getRun(previous.runId as never);
      if (run) return this.handleFor(run, await this.planForRun(run.taskId, run.id));
    }
    const run = await this.runtime.loadRun(command.runId);
    await this.loadAggregateWithRevision(run.taskId, command.expectedRevision);
    if (run.state !== 'AWAITING_INPUT') {
      throw kernelError('state_not_allowed', `当前运行状态为 ${run.state}，没有等待处理的输入请求。`);
    }
    const blocker = await this.storage.getBlocker(command.blockerId);
    if (!blocker || blocker.runId !== run.id) {
      throw kernelError('not_found', `阻塞不存在或不属于该运行：${command.blockerId}`);
    }
    if (blocker.status !== 'open') {
      throw kernelError('state_not_allowed', '该阻塞已被处理，不能重复解决。');
    }
    const option = blocker.resolutions.find((entry) => entry.id === command.optionId);
    if (!option) throw kernelError('bad_request', `未知的处理选项：${command.optionId}`);
    const validation = validateBlockResolution(option, command.value);
    if (!validation.ok) {
      throw kernelError('schema_invalid', validation.error ?? '处理选项的值不合法');
    }
    const normalized = validation.normalized;
    if (option.kind === 'bind_source') {
      const bound = normalized as { sourceId: string; version: number };
      const source = await this.storage.getSource(run.taskId, bound.sourceId as never, bound.version);
      if (!source) {
        throw kernelError('bad_request', `资料不存在或版本不可用：${bound.sourceId}@v${bound.version}`);
      }
    }
    const now = this.clock.now();
    const decision: Decision = {
      id: newDecisionId(),
      taskId: run.taskId,
      runId: run.id,
      blockerId: blocker.id,
      planVersion: run.planVersion,
      key: `blocker:${blocker.id}`,
      valueJson: JSON.stringify(normalized),
      note: command.note.slice(0, 2000),
      actor: command.actor === 'system' || command.actor === 'recipe' ? command.actor : 'user',
      createdAt: now,
    };
    const resolved = await this.runtime.resolveBlocker(
      run,
      blocker,
      {
        optionId: option.id,
        value: normalized,
        note: command.note,
        decidedBy: command.actor,
        decidedAt: now,
      },
      decision,
    );
    const choice = typeof normalized === 'string' ? normalized : normalized && typeof normalized === 'object' ? (normalized as { itemRef?: string }).itemRef ?? '' : '';
    const wantsCancel = choice === 'cancel_run' || choice === 'cancel';

    let current = resolved.run;
    if (wantsCancel) {
      const cancelled = await this.runtime.cancelRunAtBoundary(current, command.note || '用户选择取消本次运行');
      await this.saveCommandResult(command.commandId, 'resolve', run.taskId, { runId: run.id, state: cancelled.state });
      return this.handleFor(cancelled, null);
    }

    // Remaining open blockers decide whether we stay in AWAITING_INPUT.
    const remaining = (await this.storage.listBlockers(run.taskId)).filter(
      (entry) => entry.runId === run.id && entry.status === 'open',
    );
    if (current.returnState === 'READY') {
      const plan = await this.planForRun(run.taskId, run.id);
      if (plan) {
        const blockersForPlan = await this.storage.listBlockers(run.taskId);
        const decisions = await this.storage.listDecisions(run.taskId);
        const revised = revisePlanAfterDecisions(
          plan,
          decisions,
          blockersForPlan.filter((entry) => entry.runId === run.id),
          this.clock.now(),
        );
        const stillBlocking =
          revised.risks.some((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null) ||
          revised.openQuestions.some((question) => question.blocking);
        if (remaining.length > 0 || stillBlocking) {
          if (stillBlocking && remaining.length === 0) {
            const newSpecs = buildPlanBlockerSpecs(revised);
            if (newSpecs.length > 0) {
              const created = await this.persistRevisedPlanWithBlockers(current, revised, newSpecs);
              current = created;
            }
          }
          await this.saveCommandResult(command.commandId, 'resolve', run.taskId, { runId: run.id, state: current.state });
          return this.handleFor(current, revised);
        }
        const ready = await this.persistRevisedReadyPlan(current, revised);
        await this.saveCommandResult(command.commandId, 'resolve', run.taskId, { runId: run.id, state: ready.state, planVersion: revised.version });
        return this.handleFor(ready, revised);
      }
    }

    if (current.returnState === 'RUNNING') {
      const resumed = await this.resumeIntoExecution(current, command.actor);
      await this.saveCommandResult(command.commandId, 'resolve', run.taskId, { runId: run.id, state: resumed.state });
      void this.startLoop(run.id, 'execution').catch(() => undefined);
      return this.handleFor(resumed, await this.planForRun(run.taskId, run.id));
    }
    if (current.returnState === 'VALIDATING') {
      const resumed = await this.resumeValidation(current, command.actor);
      void this.startLoop(run.id, 'validation').catch(() => undefined);
      return this.handleFor(resumed, await this.planForRun(run.taskId, run.id));
    }
    await this.saveCommandResult(command.commandId, 'resolve', run.taskId, { runId: run.id, state: current.state });
    return this.handleFor(current, await this.planForRun(run.taskId, run.id));
  }

  /* --------------------------------- pause --------------------------------- */

  async pause(command: PauseCommand): Promise<void> {
    const run = await this.runtime.loadRun(command.runId);
    await this.loadAggregateWithRevision(run.taskId, command.expectedRevision);
    if (run.state === 'PAUSED' || run.state === 'PAUSING') return;
    if (!['PLANNING', 'READY', 'RUNNING', 'VALIDATING'].includes(run.state)) {
      throw kernelError('state_not_allowed', `当前运行状态 ${run.state} 不能暂停。`);
    }
    if (run.state === 'READY') {
      await this.pauseFromReady(run, `用户 ${command.actor} 请求暂停`);
      return;
    }
    const control = this.controls.get(run.id);
    if (!control) {
      throw kernelError('state_not_allowed', '该运行当前没有本进程内的执行循环；请使用恢复流程处理中断的运行。');
    }
    control.pauseRequested = true;
    control.note = `用户 ${command.actor} 请求暂停`;
    if (run.state === 'PLANNING') {
      await this.runtime.txn(
        run.taskId,
        async (tx) => {
          const fresh = await this.runtime.loadRun(run.id);
          tx.emit('run.pause_requested', {
            runId: fresh.id,
            requestedBy: command.actor.slice(0, 100),
            commandId: command.commandId.slice(0, 100),
          });
        },
        { runId: run.id },
      );
      return;
    }
    await this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'RUNNING' && fresh.state !== 'VALIDATING') return;
        const next = transitionRun(fresh, 'PAUSING', control.note, this.clock.now(), {
          returnState: fresh.state,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.pause_requested', {
          runId: next.id,
          requestedBy: command.actor.slice(0, 100),
          commandId: command.commandId.slice(0, 100),
        });
        tx.emit('run.state_changed', { from: fresh.state, to: 'PAUSING', reason: control.note.slice(0, 2000) });
      },
      { runId: run.id },
    );
  }

  /* --------------------------------- resume -------------------------------- */

  async resume(command: ResumeCommand): Promise<RunHandle> {
    const previous = await this.readCommandResult(command.commandId, 'resume');
    if (previous && typeof previous.runId === 'string') {
      const run = await this.storage.getRun(previous.runId as never);
      if (run) return this.handleFor(run, await this.planForRun(run.taskId, run.id));
    }
    const run = await this.runtime.loadRun(command.runId);
    await this.loadAggregateWithRevision(run.taskId, command.expectedRevision);
    if (run.state !== 'PAUSED') {
      throw kernelError('state_not_allowed', `当前运行状态 ${run.state} 不能继续；只有 PAUSED 可以继续。`);
    }
    const target = run.returnState ?? 'RUNNING';
    const resumed = await this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'PAUSED') {
          throw kernelError('state_not_allowed', `运行状态已变为 ${fresh.state}，不能继续。`);
        }
        const next = transitionRun(fresh, target, `运行由 ${command.actor} 继续`, this.clock.now(), {
          attempt: fresh.attempt + 1,
          returnState: null,
          finishedAt: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', { from: 'PAUSED', to: target, reason: '用户继续运行' });
        tx.emit('run.resumed', { runId: next.id, attempt: next.attempt, resumeMode: 'new_attempt' });
        return next;
      },
      { runId: run.id },
    );
    if (target === 'RUNNING') {
      void this.startLoop(run.id, 'execution').catch(() => undefined);
    } else if (target === 'VALIDATING') {
      void this.startLoop(run.id, 'validation').catch(() => undefined);
    }
    await this.saveCommandResult(command.commandId, 'resume', run.taskId, { runId: run.id, state: resumed.state, attempt: resumed.attempt });
    return this.handleFor(resumed, await this.planForRun(run.taskId, run.id));
  }

  private async resumeIntoExecution(run: Run, actor: string): Promise<Run> {
    return this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'AWAITING_INPUT') {
          throw kernelError('state_not_allowed', `当前状态 ${fresh.state} 不能恢复执行。`);
        }
        const next = transitionRun(fresh, 'RUNNING', `输入已补齐，由 ${actor} 继续执行`, this.clock.now(), {
          attempt: fresh.attempt + 1,
          returnState: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', { from: 'AWAITING_INPUT', to: 'RUNNING', reason: '输入已补齐，继续执行' });
        tx.emit('run.resumed', { runId: next.id, attempt: next.attempt, resumeMode: 'requires_revalidation' });
        return next;
      },
      { runId: run.id },
    );
  }

  private async resumeValidation(run: Run, actor: string): Promise<Run> {
    return this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state !== 'AWAITING_INPUT') {
          throw kernelError('state_not_allowed', `当前状态 ${fresh.state} 不能恢复校验。`);
        }
        const next = transitionRun(fresh, 'VALIDATING', `输入已补齐，由 ${actor} 继续校验`, this.clock.now(), {
          attempt: fresh.attempt + 1,
          returnState: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.state_changed', { from: 'AWAITING_INPUT', to: 'VALIDATING', reason: '输入已补齐，继续校验' });
        tx.emit('run.resumed', { runId: next.id, attempt: next.attempt, resumeMode: 'requires_revalidation' });
        return next;
      },
      { runId: run.id },
    );
  }

  /* --------------------------------- cancel -------------------------------- */

  async cancel(command: CancelCommand): Promise<void> {
    const run = await this.runtime.loadRun(command.runId);
    await this.loadAggregateWithRevision(run.taskId, command.expectedRevision);
    if (run.state === 'CANCELLED') return;
    if (run.state === 'COMPLETED' || run.state === 'FAILED') {
      throw kernelError('state_not_allowed', `运行已结束（${run.state}），不能被取消；如需撤回成果请通过恢复版本处理。`);
    }
    if (run.state === 'COMMITTING') {
      throw kernelError('state_not_allowed', '提交事务进行中，不能取消；请在事务结束后按实际结果处理。');
    }
    const control = this.controls.get(run.id);
    if (control) {
      control.cancelRequested = true;
      control.note = command.reason || `用户 ${command.actor} 请求取消`;
      control.abort.abort(new Error('cancelled'));
    }
    if (run.state === 'CANCELLING') return;

    const requestOnly = Boolean(control) && ['RUNNING', 'VALIDATING', 'PLANNING'].includes(run.state);
    const cancelled = await this.runtime.txn(
      run.taskId,
      async (tx) => {
        const fresh = await this.runtime.loadRun(run.id);
        if (fresh.state === 'CANCELLED' || fresh.state === 'CANCELLING') return fresh;
        if (fresh.state === 'COMMITTING') {
          throw kernelError('state_not_allowed', '提交事务进行中，不能取消。');
        }
        const next = transitionRun(fresh, 'CANCELLING', control?.note ?? command.reason, this.clock.now());
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('run.cancel_requested', {
          runId: next.id,
          requestedBy: command.actor.slice(0, 100),
          commandId: command.commandId.slice(0, 100),
        });
        tx.emit('run.state_changed', { from: fresh.state, to: 'CANCELLING', reason: (control?.note ?? command.reason).slice(0, 2000) });
        await this.runtime.cancelOpenBlockers(run.taskId, run.id, tx, '运行取消');
        return next;
      },
      { runId: run.id },
    );
    if (!requestOnly) {
      await this.runtime.cancelRunAtBoundary(cancelled, command.reason || `用户 ${command.actor} 取消运行`);
    }
  }

  /* --------------------------------- accept -------------------------------- */

  async accept(command: AcceptPatchCommand): Promise<AcceptResult> {
    const previous = await this.readCommandResult(command.commandId, 'accept');
    if (previous && typeof previous.versionId === 'string') {
      return {
        versionId: previous.versionId as never,
        moduleId: previous.moduleId as never,
        artifactRevision: Number(previous.artifactRevision ?? 0),
        runState: (previous.runState as RunState | null) ?? null,
        taskRevision: Number(previous.taskRevision ?? 0),
      };
    }
    const patch = await this.storage.getPatch(command.patchId);
    if (!patch) throw kernelError('not_found', `补丁不存在：${command.patchId}`);
    const aggregate = await this.loadAggregateWithRevision(patch.taskId, command.expectedRevision);
    const result = await this.performAcceptance({
      patch,
      aggregate,
      validationReportId: command.validationReportId,
      acceptMode: command.acceptMode,
      sectionIds: command.sectionIds,
      note: command.note,
      actor: command.actor,
      route: 'user_accept',
      expectedTaskRevision: command.expectedRevision,
      auto: false,
    });
    await this.saveCommandResult(command.commandId, 'accept', patch.taskId, {
      versionId: result.versionId,
      moduleId: result.moduleId,
      artifactRevision: result.artifactRevision,
      runState: result.runState,
      taskRevision: result.taskRevision,
    });
    return result;
  }

  private async performAcceptance(params: {
    patch: PatchProposal;
    aggregate: TaskAggregate;
    validationReportId: string;
    acceptMode: 'all' | 'sections';
    sectionIds: readonly string[];
    note: string;
    actor: string;
    route: 'user_accept' | 'auto_accept_policy';
    expectedTaskRevision: number;
    auto: boolean;
  }): Promise<AcceptResult> {
    const { patch } = params;
    if (patch.status !== 'proposed') {
      throw kernelError('state_not_allowed', `补丁状态为 ${patch.status}，只有 proposed 的补丁可以被接受。`, {
        details: { patchId: patch.id, status: patch.status },
      });
    }
    const report = await this.storage.getValidationReport(params.validationReportId);
    if (!report) throw kernelError('not_found', `验证报告不存在：${params.validationReportId}`);
    if (patch.validationReportId !== report.id) {
      throw kernelError('validation_failed', '验证报告与补丁不匹配：报告不是该补丁的最新校验结果。');
    }
    if (report.status === 'fail' || !isCommitAllowed(report)) {
      throw kernelError('validation_failed', '验证报告包含阻止提交的失败/待复核项，禁止接受。', {
        details: { summary: report.summary, blocking: summarizeValidationFailures(report.checks, 5) },
      });
    }
    if (report.candidateHash !== patch.candidateHash) {
      throw kernelError('validation_failed', '验证报告的候选内容哈希与补丁不一致，报告已失效。');
    }
    const module = params.aggregate.modules.find((entry) => entry.id === patch.moduleId) ?? (await this.storage.getModule(patch.moduleId));
    if (!module) throw kernelError('not_found', `模块不存在：${patch.moduleId}`);
    const artifact = params.aggregate.artifact;
    const currentAccepted = await this.storage.getAcceptedVersion(module.id);
    const baseId = patch.baseVersionId;
    if ((currentAccepted?.id ?? null) !== baseId) {
      throw kernelError(
        'version_conflict',
        '补丁基线已过期：当前已接受版本与补丁基线不一致，不能覆盖；双方内容均已保留，请重新生成差异或人工合并。',
        {
          details: {
            patchId: patch.id,
            patchBaseVersionId: baseId,
            currentAcceptedVersionId: currentAccepted?.id ?? null,
            moduleId: module.id,
          },
        },
      );
    }
    const run = await this.storage.getRun(patch.runId);
    if (run && run.state === 'CANCELLED') {
      throw kernelError('state_not_allowed', '运行已取消，不能静默接受其草稿；请重新运行或通过恢复版本处理。');
    }
    if (run && run.state === 'COMPLETED') {
      throw kernelError('state_not_allowed', '运行已完成为 COMPLETED，不能重复接受补丁。');
    }
    if (run && !['AWAITING_REVIEW', 'VALIDATING'].includes(run.state)) {
      throw kernelError('state_not_allowed', `当前运行状态为 ${run.state}，只有等待审阅的补丁可以被接受。`);
    }

    // Resolve the exact accepted content (whole candidate, or selected sections).
    let acceptedContent: ModuleContent = patch.candidate;
    let usedReport: ValidationReport = report;
    if (params.acceptMode === 'sections') {
      if (patch.moduleKind !== 'markdown') {
        throw kernelError('bad_request', '按章节接受只适用于 Markdown 模块。');
      }
      if (params.sectionIds.length === 0) throw kernelError('bad_request', '按章节接受时必须提供至少一个章节 ID。');
      const baseContent = currentAccepted?.content ?? null;
      if (!baseContent || baseContent.kind !== 'markdown') {
        throw kernelError('bad_request', '模块没有可用的已接受 Markdown 基线，无法按章节接受。');
      }
      const candidate = patch.candidate;
      if (candidate.kind !== 'markdown') {
        throw kernelError('validation_failed', '补丁候选内容不是 Markdown，无法按章节接受。');
      }
      const candidateById = new Map(candidate.sections.map((section) => [section.id, section]));
      const selected = new Set(params.sectionIds);
      for (const sectionId of selected) {
        if (!candidateById.has(sectionId)) {
          throw kernelError('bad_request', `章节不存在于补丁候选中：${sectionId}`);
        }
      }
      const mergedSections = baseContent.sections.map((section) => (selected.has(section.id) ? (candidateById.get(section.id) ?? section) : section));
      for (const section of candidate.sections) {
        if (selected.has(section.id) && !baseContent.sections.some((existing) => existing.id === section.id)) {
          mergedSections.push(section);
        }
      }
      acceptedContent = { kind: 'markdown', sections: mergedSections };
      const mergedReport = await this.validator.validate({
        taskId: patch.taskId,
        runId: patch.runId,
        moduleId: patch.moduleId,
        candidate: acceptedContent,
        evidenceRefs: patch.evidenceRefs,
        baseVersion: currentAccepted,
      });
      if (!isCommitAllowed(mergedReport)) {
        throw kernelError('validation_failed', '按章节合并后的内容未通过确定性校验，不能接受。', {
          details: { checks: summarizeValidationFailures(mergedReport.checks, 8) },
        });
      }
      usedReport = mergedReport;
    }

    // Revalidate at commit time with current data: a stale passing report is not
    // enough (input/upstream may have changed since proposal).
    const freshReport = await this.validator.validate({
      taskId: patch.taskId,
      runId: patch.runId,
      moduleId: patch.moduleId,
      candidate: acceptedContent,
      evidenceRefs: patch.evidenceRefs,
      baseVersion: currentAccepted,
    });
    if (!isCommitAllowed(freshReport) || freshReport.status === 'fail') {
      throw kernelError('validation_failed', '接受前复核未通过：验证报告已失效，请修复后重新生成候选成果。', {
        details: { checks: summarizeValidationFailures(freshReport.checks, 8) },
      });
    }

    const now = this.clock.now();
    const version: ArtifactVersion = {
      id: newArtifactVersionId(),
      artifactId: artifact.id,
      moduleId: module.id,
      moduleKind: module.kind,
      contentHash: contentHash(acceptedContent),
      content: acceptedContent,
      parentId: currentAccepted?.id ?? null,
      baseVersionId: patch.baseVersionId,
      sourceRunId: patch.runId,
      patchId: patch.id,
      validationReportId: usedReport.id,
      acceptedBy: params.actor.slice(0, 100),
      acceptedAt: now,
      note: truncateChars(
        params.note ||
          (params.route === 'auto_accept_policy'
            ? `自动接受策略（policyVersion=${this.deps.config.policyVersion}，promptBundle=${this.deps.config.promptBundleVersion}）`
            : ''),
        2000,
      ),
      restoredFromVersionId: null,
    };
    const modules = params.aggregate.modules;
    const staleModules = collectStaleModules(modules, module.id, now);
    const updatedModules: ArtifactModule[] = [
      { ...module, status: 'accepted', acceptedVersionId: version.id, updatedAt: now },
      ...staleModules,
    ];
    const updatedArtifact: Artifact = {
      ...artifact,
      acceptedVersionId: version.id,
      status: artifact.status === 'draft' ? 'active' : artifact.status,
      updatedAt: now,
    };
    const events: EventDraft[] = [
      {
        runId: patch.runId,
        stepId: null,
        causationId: null,
        type: 'artifact.accepted',
        payload: {
          versionId: version.id,
          patchId: patch.id,
          moduleId: module.id,
          contentHash: version.contentHash,
          acceptedBy: version.acceptedBy,
          note: version.note,
          route: params.route,
        },
        timestamp: now,
      },
      ...staleModules.map(
        (stale): EventDraft => ({
          runId: patch.runId,
          stepId: null,
          causationId: null,
          type: 'artifact.stale',
          payload: {
            artifactId: artifact.id as never,
            moduleId: stale.id,
            reason: `上游模块 ${module.title} 接受了新版本 ${version.id}，下游成果需要重新验证`,
            staleRefs: [version.id],
          },
          timestamp: now,
        }),
      ),
      ...(run
        ? ([
            {
              runId: run.id,
              stepId: null,
              causationId: null,
              type: 'run.state_changed',
              payload: { from: 'COMMITTING', to: 'COMPLETED', reason: '成果版本已通过事务提交' },
              timestamp: now,
            },
            {
              runId: run.id,
              stepId: null,
              causationId: null,
              type: 'run.completed',
              payload: { runId: run.id, versionId: version.id, moduleId: module.id },
              timestamp: now,
            },
          ] as EventDraft[])
        : []),
    ];

    const committed = await this.commitAcceptanceSafely({
      taskId: patch.taskId,
      patchId: patch.id,
      version,
      expectedTaskRevision: params.expectedTaskRevision,
      updatedModules,
      artifact: updatedArtifact,
      events,
      runIdForTransition: run?.id ?? null,
    });

    if (run) await this.runtime.finalizeTerminal(run.id);
    return {
      versionId: committed.version.id,
      moduleId: module.id,
      artifactRevision: committed.taskRevision,
      runState: run ? 'COMPLETED' : null,
      taskRevision: committed.taskRevision,
    };
  }

  /**
   * One storage transaction covers: AWAITING_REVIEW → COMMITTING transition,
   * commitAcceptance (version + modules + artifact + task revision CAS + events),
   * run row → COMPLETED, and superseding other pending proposals. Any conflict
   * rolls back everything, so both sides are preserved and the run stays in
   * AWAITING_REVIEW.
   */
  private async commitAcceptanceSafely(
    input: CommitAcceptanceInput & { runIdForTransition: string | null },
  ): Promise<CommitAcceptanceResult> {
    const { runIdForTransition, ...acceptance } = input;
    try {
      return await this.storage.transaction(async () => {
        if (runIdForTransition) {
          const freshRun = await this.storage.getRun(runIdForTransition);
          if (!freshRun || freshRun.state !== 'AWAITING_REVIEW') {
            throw kernelError('state_not_allowed', `运行状态已变为 ${freshRun?.state ?? 'missing'}，不能接受补丁。`);
          }
          const committing = transitionRun(freshRun, 'COMMITTING', '开始提交成果版本', this.clock.now());
          await this.storage.updateRun(committing, freshRun.revision);
          await this.storage.appendEvents(acceptance.taskId, [
            {
              runId: freshRun.id,
              stepId: null,
              causationId: null,
              type: 'run.state_changed',
              payload: { from: 'AWAITING_REVIEW', to: 'COMMITTING', reason: '用户接受候选成果，开始提交事务' },
              timestamp: this.clock.now(),
            },
          ]);
        }
        const commitResult = await this.storage.commitAcceptance({
          ...acceptance,
          events: acceptance.events as EventDraft[],
        });
        if (runIdForTransition) {
          const latestRun = await this.storage.getRun(runIdForTransition);
          if (latestRun) {
            const completed: Run = {
              ...latestRun,
              state: 'COMPLETED',
              finishedAt: this.clock.now(),
              updatedAt: this.clock.now(),
              revision: latestRun.revision + 1,
              returnState: null,
            };
            await this.storage.updateRun(completed, latestRun.revision);
          }
        }
        const others = (await this.storage.listPatches(acceptance.taskId)).filter(
          (candidate) =>
            candidate.moduleId === commitResult.version.moduleId &&
            candidate.id !== commitResult.version.patchId &&
            candidate.status === 'proposed',
        );
        for (const other of others) {
          await this.storage.updatePatch({ ...other, status: 'superseded' });
        }
        return commitResult;
      });
    } catch (error) {
      if (isVersionConflict(error) || isRevisionConflict(error)) {
        throw new HarnessError(
          'version_conflict',
          '提交被拒绝：任务修订号或已接受版本已变化，双方内容均已保留；请重新生成差异或人工合并。',
          { retryable: true, details: { cause: error instanceof Error ? error.message : String(error) } },
        );
      }
      throw toKernelError(error);
    }
  }

  /* --------------------------------- reject -------------------------------- */

  async reject(command: RejectPatchCommand): Promise<{ patchId: string; status: string }> {
    const previous = await this.readCommandResult(command.commandId, 'reject');
    if (previous && typeof previous.status === 'string') {
      return { patchId: String(previous.patchId), status: previous.status };
    }
    const patch = await this.storage.getPatch(command.patchId);
    if (!patch) throw kernelError('not_found', `补丁不存在：${command.patchId}`);
    if (patch.status === 'rejected') return { patchId: patch.id, status: 'rejected' };
    if (patch.status !== 'proposed') {
      throw kernelError('state_not_allowed', `补丁状态为 ${patch.status}，不能拒绝。`);
    }
    const run = await this.storage.getRun(patch.runId);
    const now = this.clock.now();
    await this.storage.transaction(async () => {
      await this.storage.updatePatch({ ...patch, status: 'rejected' });
      const module = await this.storage.getModule(patch.moduleId);
      if (module && module.status === 'ready_for_review') {
        await this.storage.updateModules([{ ...module, status: 'draft', updatedAt: now }]);
      }
      if (!run) return;
      const fresh = await this.storage.getRun(run.id);
      if (!fresh) return;
      if (fresh.state === 'COMPLETED') {
        throw kernelError('state_not_allowed', '运行已完成为 COMPLETED，不能拒绝已接受的补丁。');
      }
      if (fresh.state === 'CANCELLED' || fresh.state === 'FAILED') return;
      if (fresh.state !== 'AWAITING_REVIEW') {
        throw kernelError('state_not_allowed', `当前运行状态为 ${fresh.state}，没有等待审阅的补丁。`);
      }
      let next = transitionRun(fresh, 'CANCELLING', command.reason || '用户拒绝候选成果', now);
      next = transitionRun(next, 'CANCELLED', command.reason || '用户拒绝候选成果', now, {
        finishedAt: now,
        returnState: null,
      });
      await this.storage.updateRun(next, fresh.revision);
      const drafts: import('@ca/storage').EventDraft[] = [
        {
          runId: next.id,
          stepId: null,
          causationId: null,
          type: 'run.state_changed',
          payload: { from: 'AWAITING_REVIEW', to: 'CANCELLING', reason: '拒绝候选成果' },
          timestamp: now,
        },
        {
          runId: next.id,
          stepId: null,
          causationId: null,
          type: 'run.state_changed',
          payload: { from: 'CANCELLING', to: 'CANCELLED', reason: '拒绝候选成果，草稿保留' },
          timestamp: now,
        },
        {
          runId: next.id,
          stepId: null,
          causationId: null,
          type: 'run.cancelled',
          payload: {
            runId: next.id,
            reason: command.reason || '用户拒绝候选成果，草稿保留',
            draftPreserved: true,
            acceptedVersionUnchanged: true,
          },
          timestamp: now,
        },
      ];
      await this.storage.appendEvents(patch.taskId, drafts);
    });
    if (run) await this.runtime.finalizeTerminal(run.id);
    await this.saveCommandResult(command.commandId, 'reject', patch.taskId, { patchId: patch.id, status: 'rejected' });
    return { patchId: patch.id, status: 'rejected' };
  }

  /* -------------------------------- restore -------------------------------- */

  async restore(command: RestoreVersionCommand): Promise<{ versionId: string; artifactRevision: number }> {
    const previous = await this.readCommandResult(command.commandId, 'restore');
    if (previous && typeof previous.versionId === 'string') {
      return { versionId: previous.versionId as never, artifactRevision: Number(previous.artifactRevision ?? 0) };
    }
    const aggregate = await this.loadAggregateWithRevision(command.taskId, command.expectedRevision);
    const module = aggregate.modules.find((entry) => entry.id === command.moduleId);
    if (!module) throw kernelError('not_found', `模块不存在：${command.moduleId}`);
    const oldVersion = await this.storage.getVersion(command.versionId);
    if (!oldVersion || oldVersion.moduleId !== module.id) {
      throw kernelError('not_found', '要恢复的版本不存在或不属于该模块。');
    }
    const currentAccepted = await this.storage.getAcceptedVersion(module.id);
    if (currentAccepted?.id === oldVersion.id) {
      throw kernelError('bad_request', '该版本已经是当前已接受版本，无需恢复。');
    }
    const now = this.clock.now();
    const version: ArtifactVersion = {
      id: newArtifactVersionId(),
      artifactId: aggregate.artifact.id,
      moduleId: module.id,
      moduleKind: module.kind,
      contentHash: contentHash(oldVersion.content),
      content: oldVersion.content,
      parentId: currentAccepted?.id ?? null,
      baseVersionId: currentAccepted?.id ?? null,
      sourceRunId: null,
      patchId: null,
      validationReportId: null,
      acceptedBy: command.actor.slice(0, 100),
      acceptedAt: now,
      note: truncateChars(command.note || `恢复自版本 ${oldVersion.id}`, 2000),
      restoredFromVersionId: oldVersion.id,
    };
    const staleModules = collectStaleModules(aggregate.modules, module.id, now);
    const updatedModules: ArtifactModule[] = [
      { ...module, status: 'accepted', acceptedVersionId: version.id, updatedAt: now },
      ...staleModules,
    ];
    const artifact: Artifact = {
      ...aggregate.artifact,
      acceptedVersionId: version.id,
      status: aggregate.artifact.status === 'draft' ? 'active' : aggregate.artifact.status,
      updatedAt: now,
    };
    const events = [
      {
        runId: null,
        stepId: null,
        causationId: null,
        type: 'artifact.restored' as const,
        payload: {
          versionId: version.id,
          moduleId: module.id,
          restoredFromVersionId: oldVersion.id,
          acceptedBy: version.acceptedBy,
        },
        timestamp: now,
      },
      ...staleModules.map((stale) => ({
        runId: null,
        stepId: null,
        causationId: null,
        type: 'artifact.stale' as const,
        payload: {
          artifactId: aggregate.artifact.id as never,
          moduleId: stale.id,
          reason: `上游模块 ${module.title} 恢复了历史版本 ${oldVersion.id}，下游成果需要重新验证`,
          staleRefs: [version.id],
        },
        timestamp: now,
      })),
    ];
    let committed: CommitAcceptanceResult;
    try {
      committed = await this.storage.commitAcceptance({
        taskId: command.taskId,
        patchId: '00000000-0000-4000-8000-000000000000',
        version,
        expectedTaskRevision: command.expectedRevision,
        updatedModules,
        artifact,
        events: events as EventDraft[],
      });
    } catch (error) {
      if (isVersionConflict(error) || isRevisionConflict(error)) {
        throw new HarnessError(
          'version_conflict',
          '恢复被拒绝：任务修订号或当前已接受版本已变化，历史内容均已保留；请刷新后重试。',
          { retryable: true, details: { cause: error instanceof Error ? error.message : String(error) } },
        );
      }
      throw toKernelError(error);
    }
    await this.saveCommandResult(command.commandId, 'restore', command.taskId, {
      versionId: committed.version.id,
      artifactRevision: committed.taskRevision,
    });
    return { versionId: committed.version.id, artifactRevision: committed.taskRevision };
  }

  /* ------------------------------ execution loop --------------------------- */

  private startLoop(runId: string, mode: 'execution' | 'validation'): Promise<void> {
    const existing = this.loops.get(runId);
    if (existing) return existing;
    const promise = this.runLoop(runId, mode)
      .catch(async (error) => {
        const kernel = toKernelError(error);
        const run = await this.storage.getRun(runId as never);
        if (run && !['COMPLETED', 'CANCELLED', 'FAILED', 'PAUSED', 'AWAITING_INPUT', 'AWAITING_REVIEW', 'INTERRUPTED'].includes(run.state)) {
          const failed = await this.runtime.failRun(run, {
            code: kernel.code,
            message: kernel.message,
            retryable: kernel.retryable,
            stage: 'execution',
            details: typeof kernel.details === 'string' ? kernel.details.slice(0, 4000) : '',
          });
          await this.runtime.finalizeTerminal(failed.id);
        }
      })
      .finally(() => {
        this.loops.delete(runId);
        this.controls.delete(runId);
        const timer = this.leaseTimers.get(runId);
        if (timer) clearInterval(timer);
        this.leaseTimers.delete(runId);
      });
    this.loops.set(runId, promise);
    return promise;
  }

  private async runLoop(runId: string, mode: 'execution' | 'validation'): Promise<void> {
    const control = this.newControl('loop');
    this.controls.set(runId, control);
    const acquired = await this.storage.acquireRunLease(runId, this.deps.config.ownerId, TIME_LIMITS.runLeaseTtlMs);
    if (!acquired) {
      throw kernelError('state_not_allowed', '另一个执行者持有该运行的租约，拒绝并行执行。');
    }
    const heartbeat = setInterval(() => {
      void this.storage.renewRunLease(runId, this.deps.config.ownerId, TIME_LIMITS.runLeaseTtlMs).catch(() => false);
    }, TIME_LIMITS.heartbeatIntervalMs);
    heartbeat.unref?.();
    this.leaseTimers.set(runId, heartbeat);
    try {
      let run = await this.runtime.loadRun(runId as never);
      const task = await this.runtime.loadTask(run.taskId);
      const module = await this.storage.getModule(run.moduleId);
      if (!module) throw kernelError('not_found', `模块不存在：${run.moduleId}`);
      const plan = await this.planForRun(run.taskId, run.id);
      if (!plan) throw kernelError('state_not_allowed', '运行没有已提交的计划，无法执行。');
      if (mode === 'validation') {
        run = await this.continueValidation(run, task, module, control);
        void run;
        return;
      }
      const outcome = await runExecutor({ runtime: this.runtime, run, task, module, plan, control });
      switch (outcome.kind) {
        case 'cancelled': {
          await this.runtime.cancelRunAtBoundary(outcome.run, control.note || '用户取消运行');
          return;
        }
        case 'paused':
        case 'blocked':
          return;
        case 'failed': {
          await this.runtime.finalizeTerminal(outcome.run.id);
          return;
        }
        case 'candidate': {
          await this.runValidationPhase({
            run: outcome.run,
            task,
            module,
            plan,
            control,
            candidate: outcome.candidate,
            evidenceRefs: outcome.evidenceRefs,
            description: outcome.description,
            problems: outcome.problems,
            patchId: outcome.patchId,
            repairAttempt: 0,
          });
          return;
        }
      }
    } finally {
      clearInterval(heartbeat);
      this.leaseTimers.delete(runId);
      await this.storage.releaseRunLease(runId, this.deps.config.ownerId).catch(() => undefined);
    }
  }

  private async continueValidation(run: Run, task: Task, module: ArtifactModule, control: RunControl): Promise<Run> {
    const checkpoint = run.checkpointId ? await this.storage.getCheckpoint(run.checkpointId) : null;
    if (!checkpoint) throw kernelError('state_not_allowed', '校验阶段缺少检查点，无法继续。');
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(checkpoint.dataJson) as Record<string, unknown>;
    } catch {
      throw kernelError('state_not_allowed', '校验阶段检查点损坏，无法继续。');
    }
    const parsed = ModuleContentSchema.safeParse(data.candidate);
    if (!parsed.success) {
      throw kernelError('state_not_allowed', '校验阶段检查点缺少可恢复的候选内容；请重新运行。');
    }
    const plan = await this.planForRun(run.taskId, run.id);
    if (!plan) throw kernelError('state_not_allowed', '运行没有已提交的计划，无法继续校验。');
    const evidenceRefs: EvidenceRef[] = [];
    if (Array.isArray(data.evidenceRefs)) {
      for (const raw of data.evidenceRefs) {
        const ref = EvidenceRefSchema.safeParse(raw);
        if (ref.success) evidenceRefs.push(ref.data);
      }
    }
    await this.runValidationPhase({
      run,
      task,
      module,
      plan,
      control,
      candidate: parsed.data,
      evidenceRefs,
      description: typeof data.description === 'string' ? data.description : '恢复的候选成果',
      problems: Array.isArray(data.problems) ? data.problems.filter((entry): entry is string => typeof entry === 'string') : [],
      patchId: typeof data.patchId === 'string' ? data.patchId : null,
      repairAttempt: typeof data.repairAttempt === 'number' ? data.repairAttempt : 0,
    });
    return run;
  }

  /* ------------------------------- validation ------------------------------ */

  private async runValidationPhase(params: {
    run: Run;
    task: Task;
    module: ArtifactModule;
    plan: Plan;
    control: RunControl;
    candidate: ModuleContent;
    evidenceRefs: EvidenceRef[];
    description: string;
    problems: string[];
    patchId: string | null;
    repairAttempt: number;
  }): Promise<void> {
    const { task, module, plan, control } = params;
    let run = params.run;
    let candidate = params.candidate;
    let evidenceRefs = params.evidenceRefs;
    let problems = params.problems;
    let repairAttempt = params.repairAttempt;

    if (run.state === 'RUNNING') {
      run = await this.runtime.setRunState(run, 'VALIDATING', '收到候选成果，进入确定性校验');
    } else if (run.state !== 'VALIDATING') {
      throw kernelError('state_not_allowed', `当前状态 ${run.state} 不能进入校验`);
    }

    while (true) {
      if (control.cancelRequested) return;
      if (control.pauseRequested || this.shuttingDown) {
        await this.pauseValidation(run, '收到暂停/关闭请求：在校验安全边界保存检查点。', {
          phase: 'validation',
          candidate: safeCandidateForCheckpoint(candidate),
          evidenceRefs,
          problems,
          patchId: params.patchId,
          repairAttempt,
        });
        return;
      }
      const budgetCheck = this.runtime.checkRunBudget(run);
      if (!budgetCheck.allowed) {
        await this.pauseValidation(run, budgetCheck.message, {
          phase: 'validation',
          candidate: safeCandidateForCheckpoint(candidate),
          evidenceRefs,
          problems,
          patchId: params.patchId,
          repairAttempt,
        }, budgetCheck);
        return;
      }
      const acceptedVersion = await this.storage.getAcceptedVersion(module.id);
      const report = await this.validator.validate({
        taskId: task.id,
        runId: run.id,
        moduleId: module.id,
        candidate,
        evidenceRefs,
        baseVersion: acceptedVersion,
      });
      run = await this.runtime.txn(
        task.id,
        async (tx) => {
          await this.storage.insertValidationReport(report);
          tx.emit('validation.completed', {
            validationReportId: report.id,
            moduleId: module.id,
            status: report.status,
            checks: report.checks.slice(0, 200),
            summary: report.summary,
          });
          const fresh = await this.runtime.loadRun(run.id);
          const next: Run = { ...fresh, revision: fresh.revision + 1, updatedAt: this.clock.now() };
          await this.storage.updateRun(next, fresh.revision);
          return next;
        },
        { runId: run.id },
      );
      const blocking = !isCommitAllowed(report) || report.status === 'fail' || problems.length > 0;
      if (!blocking) {
        await this.finishValidationWithPatch({
          run,
          task,
          module,
          plan,
          candidate,
          evidenceRefs,
          description: params.description,
          report,
          patchId: params.patchId,
          repairAttempt,
        });
        return;
      }
      if (repairAttempt >= run.budgetPolicy.maxStructureRepairs) {
        const findings = [...summarizeValidationFailures(report.checks, 8), ...problems];
        await this.pauseValidation(run, '校验失败且修复次数已用尽', {
          phase: 'repair',
          candidate: safeCandidateForCheckpoint(candidate),
          evidenceRefs,
          problems,
          patchId: params.patchId,
          repairAttempt,
        });
        void findings;
        await this.raiseValidationBlocker(run, task, module, report, problems);
        return;
      }
      repairAttempt += 1;
      const repairBudget = this.runtime.checkRunBudget(run);
      if (!repairBudget.allowed) {
        await this.pauseValidation(run, repairBudget.message, {
          phase: 'repair',
          candidate: safeCandidateForCheckpoint(candidate),
          evidenceRefs,
          problems,
          patchId: params.patchId,
          repairAttempt,
        }, repairBudget);
        return;
      }
      run = await this.runtime.setRunState(run, 'RUNNING', `确定性校验未通过，进入第 ${repairAttempt} 次结构修复`);
      const findings = [...summarizeValidationFailures(report.checks, 8), ...problems];
      const repaired = await this.requestArtifactRepair({
        run,
        taskId: task.id,
        control,
        module,
        candidate,
        findings,
        attempt: repairAttempt,
        maxAttempts: run.budgetPolicy.maxStructureRepairs,
      });
      switch (repaired.kind) {
        case 'cancelled':
          return;
        case 'paused':
          return;
        case 'blocked':
          await this.raiseValidationBlockerFromFailure(run, task, module, repaired.message);
          return;
        case 'failed':
          await this.raiseValidationBlockerFromFailure(run, task, module, repaired.message);
          return;
        case 'ok':
          run = repaired.run;
          candidate = repaired.candidate;
          evidenceRefs = repaired.evidenceRefs;
          problems = repaired.problems;
          run = await this.runtime.setRunState(run, 'VALIDATING', `第 ${repairAttempt} 次修复完成，重新校验`);
          break;
      }
    }
  }

  private async pauseValidation(
    run: Run,
    note: string,
    checkpointData: Record<string, unknown>,
    budget?: BudgetCheck,
  ): Promise<void> {
    try {
      await this.runtime.pauseAtSafeBoundary(run, note, note, checkpointData, budget);
    } catch {
      // If the state already changed (e.g. cancellation), the caller handles it.
    }
  }

  private async raiseValidationBlocker(
    run: Run,
    task: Task,
    module: ArtifactModule,
    report: ValidationReport,
    extraProblems: string[],
  ): Promise<void> {
    const findings = [...summarizeValidationFailures(report.checks, 8), ...extraProblems].slice(0, 8);
    await this.runtime.createBlocker(run, {
      type: 'validation_failed',
      severity: 'blocking',
      title: '候选成果未通过确定性校验（修复次数已用尽）',
      detail: findings.join('\n') || '候选成果未通过确定性校验。',
      affectedModuleIds: [module.id],
      returnState: 'RUNNING',
      resolutions: [
        {
          id: 'fix',
          kind: 'text',
          label: '补充信息或修正要求',
          detail: '内核会根据你的说明重新执行受影响步骤；不会伪造校验通过。',
          placeholder: '例如：把“市场规模”段落改为待验证假设，或补充引用资料。',
          multiline: true,
          maxChars: 2000,
          required: true,
        },
        {
          id: 'decision',
          kind: 'choose',
          label: '选择处理方式',
          detail: '也可以标记缺口为明确假设后重试，或保留草稿取消。',
          options: [
            { value: 'mark_assumption', label: '标记为明确假设后重试', description: '写入决策记录后重试。' },
            { value: 'cancel_run', label: '保留草稿并取消运行', description: '取消本次运行，已接受成果不变。' },
          ],
        },
      ],
    });
    void task;
  }

  private async raiseValidationBlockerFromFailure(
    run: Run,
    task: Task,
    module: ArtifactModule,
    message: string,
  ): Promise<void> {
    await this.runtime.createBlocker(run, {
      type: 'service_failure',
      severity: 'blocking',
      title: '结构修复失败',
      detail: `${message}\n这是技术/结构故障，请检查模型配置后重试，或保留草稿并取消。`,
      affectedModuleIds: [module.id],
      returnState: 'RUNNING',
      resolutions: [
        {
          id: 'recover',
          kind: 'choose',
          label: '技术恢复',
          detail: '修复后重试；重试会使用新的 attempt 并产生新的模型费用。',
          options: [
            { value: 'retry', label: '重试', description: '从校验阶段重新开始。' },
            { value: 'cancel_run', label: '保留草稿并取消运行', description: '取消本次运行，已接受成果不变。' },
          ],
        },
      ],
    });
    void task;
  }

  private async requestArtifactRepair(params: {
    run: Run;
    taskId: TaskId;
    control: RunControl;
    module: ArtifactModule;
    candidate: ModuleContent;
    findings: string[];
    attempt: number;
    maxAttempts: number;
  }): Promise<
    | { kind: 'ok'; run: Run; candidate: ModuleContent; evidenceRefs: EvidenceRef[]; problems: string[] }
    | { kind: 'cancelled' }
    | { kind: 'paused' }
    | { kind: 'blocked'; message: string }
    | { kind: 'failed'; message: string }
  > {
    const provider = await this.runtime.selectProvider();
    if (!provider) return { kind: 'failed', message: '没有可用模型供应商，无法执行结构修复。' };
    const spans = await this.storage.listSpans(params.taskId, 20);
    const allowedEvidence =
      spans.length === 0
        ? '（没有可引用的真实 SourceSpan；不得编造引用，未验证陈述必须改写为“待验证假设”。）'
        : spans
            .slice(0, 20)
            .map(
              (span) =>
                `- spanId=${span.id} sourceId=${span.sourceId} v${span.version} locator=${JSON.stringify(span.locator)} excerpt=${JSON.stringify(span.excerpt)}`,
            )
            .join('\n');
    const system = renderRepairSystem({ policyVersion: this.deps.config.policyVersion });
    const user = renderRepairInstruction({
      moduleKind: params.module.kind,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
      findings: params.findings.map((finding) => `- ${finding}`).join('\n'),
      allowedEvidence,
      candidateJson: truncateBytes(JSON.stringify(params.candidate), 60_000),
    });
    const messages: ModelMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const outcome = await this.runtime.callModel({
      run: params.run,
      taskId: params.run.taskId,
      stepId: null,
      stage: 'validation',
      purpose: 'repair',
      profile: provider.profile,
      capabilities: provider.capabilities,
      messages,
      tools: [],
      toolChoice: 'none',
      responseFormat: { kind: 'text' },
      temperature: 0,
      maxOutputTokens: params.run.budgetPolicy.maxOutputTokens,
      signal: params.control.abort.signal,
      control: params.control,
      estimatedInputTokens: 2_000,
      label: 'repair.artifact',
    });
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
    if (outcome.kind === 'paused') return { kind: 'paused' };
    if (outcome.kind === 'budget_exhausted') {
      await this.pauseValidation(outcome.run, outcome.check.message, {
        phase: 'repair',
        candidate: safeCandidateForCheckpoint(params.candidate),
        evidenceRefs: [],
        problems: params.findings,
        repairAttempt: params.attempt,
      }, outcome.check);
      return { kind: 'paused' };
    }
    if (outcome.kind === 'failed') {
      return { kind: 'failed', message: `结构修复模型调用失败：${outcome.error.message}` };
    }
    try {
      const parsed = parseCandidateOutput(outcome.text);
      return {
        kind: 'ok',
        run: outcome.run,
        candidate: parsed.candidate,
        evidenceRefs: parsed.evidenceRefs,
        problems: parsed.problems,
      };
    } catch (error) {
      const issues = error instanceof CandidateParseError ? error.problems : [String(error)];
      return {
        kind: 'ok',
        run: outcome.run,
        candidate: params.candidate,
        evidenceRefs: [],
        problems: [`修复输出不是合法的候选成果 JSON：${issues.slice(0, 3).join('；')}`],
      };
    }
  }

  private async finishValidationWithPatch(params: {
    run: Run;
    task: Task;
    module: ArtifactModule;
    plan: Plan;
    candidate: ModuleContent;
    evidenceRefs: EvidenceRef[];
    description: string;
    report: ValidationReport;
    patchId: string | null;
    repairAttempt: number;
  }): Promise<void> {
    const { task, module, candidate, report } = params;
    const acceptedVersion = await this.storage.getAcceptedVersion(module.id);
    const baseVersionId = acceptedVersion?.id ?? null;
    const candidateHash = contentHash(candidate);
    const existing = params.patchId ? await this.storage.getPatch(params.patchId) : null;
    const changeSummary = buildChangeSummary(module, acceptedVersion, candidate);
    const patch: PatchProposal =
      existing && existing.moduleId === module.id
        ? {
            ...existing,
            baseVersionId,
            candidateHash,
            candidate,
            evidenceRefs: mergeEvidenceRefs(existing.evidenceRefs, params.evidenceRefs),
            validationReportId: report.id,
            status: 'proposed',
            description: existing.description || truncateChars(params.description, 4000),
            changeSummary: existing.changeSummary ?? changeSummary,
          }
        : {
            id: newPatchId(),
            taskId: task.id,
            runId: params.run.id,
            moduleId: module.id,
            moduleKind: module.kind,
            baseVersionId,
            operations: [{ kind: 'replace_module', content: candidate }],
            evidenceRefs: mergeEvidenceRefs([], params.evidenceRefs),
            validationReportId: report.id,
            candidateHash,
            candidate,
            status: 'proposed',
            description: truncateChars(params.description, 4000),
            changeSummary,
            createdAt: this.clock.now(),
            acceptedVersionId: null,
          };
    const now = this.clock.now();
    let moduleStatus = module.status;
    if (canTransitionModule(moduleStatus, 'ready_for_review')) moduleStatus = 'ready_for_review';
    else if (canTransitionModule(moduleStatus, 'draft') && canTransitionModule('draft', 'ready_for_review')) moduleStatus = 'ready_for_review';
    else moduleStatus = canTransitionModule(moduleStatus, 'draft') ? 'draft' : moduleStatus;
    const updatedModule: ArtifactModule = { ...module, status: moduleStatus, updatedAt: now };

    const awaitingRun = await this.runtime.txn(
      task.id,
      async (tx) => {
        const fresh = await this.runtime.loadRun(params.run.id);
        if (fresh.state !== 'VALIDATING') {
          throw kernelError('state_not_allowed', `当前状态 ${fresh.state} 不能进入待审阅`);
        }
        if (existing) await this.storage.updatePatch(patch);
        else await this.storage.insertPatch(patch);
        await this.storage.updateModules([updatedModule]);
        const next = transitionRun(fresh, 'AWAITING_REVIEW', '候选成果通过确定性校验，等待人工接受', this.clock.now(), {
          baseVersionId,
          returnState: null,
        });
        await this.storage.updateRun(next, fresh.revision);
        tx.emit('artifact.patch_proposed', {
          patchId: patch.id,
          moduleId: module.id,
          baseVersionId,
          candidateHash,
          validationReportId: report.id,
          changeSummary: patch.changeSummary,
        });
        tx.emit('run.state_changed', {
          from: 'VALIDATING',
          to: 'AWAITING_REVIEW',
          reason: '候选成果通过确定性校验，等待人工接受',
        });
        return next;
      },
      { runId: params.run.id },
    );

    // Auto-accept is an explicit, auditable workspace policy; default off.
    const workspace = await this.runtime.loadWorkspace();
    if (isAutoAcceptEligible(workspace, task, module, report)) {
      const aggregate = await this.storage.getTaskAggregate(task.id);
      if (aggregate) {
        try {
          await this.performAcceptance({
            patch,
            aggregate,
            validationReportId: report.id,
            acceptMode: 'all',
            sectionIds: [],
            note: `命中用户显式开启的自动接受策略（policyVersion=${this.deps.config.policyVersion}）`,
            actor: 'auto_accept_policy',
            route: 'auto_accept_policy',
            expectedTaskRevision: aggregate.task.revision,
            auto: true,
          });
        } catch (error) {
          // Auto-accept must never bypass checks: leave the patch in review instead.
          void error;
        }
      }
    }
  }

  /* -------------------------------- recovery ------------------------------- */

  async recoverInterrupted(): Promise<RecoveryReport> {
    return recoverInterruptedRuns(this.runtime, {
      ownerId: this.deps.config.ownerId,
      leaseTtlMs: TIME_LIMITS.runLeaseTtlMs,
      isActive: (runId) => this.controls.has(runId),
    });
  }

  /* -------------------------------- run detail ----------------------------- */

  async getRunDetail(runId: RunId): Promise<RunDetailType | null> {
    const run = await this.storage.getRun(runId);
    if (!run) return null;
    const plan = await this.planForRun(run.taskId, run.id);
    const steps = await this.storage.listSteps(run.id);
    const blockers = (await this.storage.listBlockers(run.taskId)).filter((blocker) => blocker.runId === run.id);
    const contextSnapshot = run.contextSnapshotId ? await this.storage.getContextSnapshot(run.contextSnapshotId) : null;
    const reportId = await loadLatestValidationReportId(this.storage, run.taskId, run.id);
    const validationReport = reportId ? await this.storage.getValidationReport(reportId) : null;
    return {
      run,
      plan,
      steps,
      blockers,
      contextSnapshot,
      validationReport,
    };
  }

  /* --------------------------------- startRun ------------------------------ */

  async startRun(runId: RunId): Promise<void> {
    let run = await this.runtime.loadRun(runId);
    if (run.state === 'RUNNING') {
      const existing = this.loops.get(run.id);
      if (existing) return existing;
      return this.startLoop(run.id, 'execution');
    }
    if (run.state === 'INTERRUPTED') {
      const unclear = await this.storage.findUnclearToolInvocations(run.id);
      const descriptors = await this.runtime.toolDescriptors();
      const unsafe = unclear.filter((record) => {
        const descriptor = descriptors.get(record.toolId);
        return !descriptor || descriptor.policy.effect !== 'read';
      });
      if (unsafe.length > 0) {
        throw kernelError(
          'tool_outcome_unknown',
          '存在结果未知的工具调用（非只读）。不会自动重放未知副作用；请先人工核对，再决定是否继续或重新运行。',
          { details: { unclearToolCalls: unsafe.map((record) => record.toolCallId) } },
        );
      }
      run = await this.runtime.txn(
        run.taskId,
        async (tx) => {
          const fresh = await this.runtime.loadRun(run.id);
          if (fresh.state !== 'INTERRUPTED') {
            throw kernelError('state_not_allowed', `运行状态已变为 ${fresh.state}，不能恢复。`);
          }
          const next = transitionRun(fresh, 'RUNNING', '从最近检查点安全恢复运行', this.clock.now(), {
            attempt: fresh.attempt + 1,
            interrupted: null,
            returnState: null,
          });
          await this.storage.updateRun(next, fresh.revision);
          tx.emit('run.resumed', { runId: next.id, attempt: next.attempt, resumeMode: 'from_checkpoint' });
          tx.emit('run.state_changed', { from: 'INTERRUPTED', to: 'RUNNING', reason: '从最近检查点安全恢复' });
          for (const record of unclear) {
            await this.storage.updateToolInvocation({ ...record, status: 'outcome_unknown' });
            tx.emit('tool.outcome_unknown', {
              toolCallId: record.toolCallId,
              toolId: record.toolId,
              detail: '进程中断时调用的只读工具结果未知；只读工具允许安全重试',
              retryRefused: false,
            });
          }
          return next;
        },
        { runId: run.id },
      );
      const checkpoint = run.checkpointId ? await this.storage.getCheckpoint(run.checkpointId) : null;
      let phase: 'execution' | 'validation' = 'execution';
      if (checkpoint) {
        try {
          const data = JSON.parse(checkpoint.dataJson) as { phase?: string };
          if (data.phase === 'validation' || data.phase === 'repair') phase = 'validation';
        } catch {
          phase = 'execution';
        }
      }
      return this.startLoop(run.id, phase);
    }
    if (run.state === 'PAUSED') {
      throw kernelError('state_not_allowed', '运行处于 PAUSED，请使用恢复（resume）命令继续。');
    }
    if (run.state === 'VALIDATING') {
      return this.startLoop(run.id, 'validation');
    }
    if (run.state === 'READY') {
      throw kernelError('state_not_allowed', '计划尚未提交（READY），请先提交计划再启动执行。');
    }
    throw kernelError('state_not_allowed', `运行状态 ${run.state} 不能启动执行。`);
  }

  /* --------------------------------- misc ---------------------------------- */

  async waitForIdle(): Promise<void> {
    while (this.loops.size > 0) {
      const pending = [...this.loops.values()];
      await Promise.allSettled(pending);
    }
  }

  activeRunCount(): number {
    return this.loops.size;
  }

  async *events(taskId: TaskId, afterSeq: number): AsyncIterable<HarnessEvent> {
    let seq = Math.max(0, afterSeq);
    for (;;) {
      const page = await this.storage.eventsAfter(taskId, seq, 200);
      if (page.length === 0) {
        if (this.shuttingDown) return;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 25);
          timer.unref?.();
        });
        continue;
      }
      for (const event of page) {
        yield event;
        seq = event.seq;
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const control of this.controls.values()) {
      control.pauseRequested = true;
      control.note = '服务关闭时安全暂停';
      control.abort.abort(new Error('shutdown'));
    }
    await this.waitForIdle();
    for (const timer of this.leaseTimers.values()) clearInterval(timer);
    this.leaseTimers.clear();
  }
}

/* ------------------------------ pure helpers ------------------------------- */

function buildChangeSummary(module: ArtifactModule, base: ArtifactVersion | null, candidate: ModuleContent): ChangeSummary {
  const candidateHash = contentHash(candidate);
  const diff = diffModuleContent(module.id as never, module.kind, base?.content ?? null, candidate, {
    baseVersionId: base?.id ?? null,
    candidateHash,
  });
  return {
    addedLines: 0,
    removedLines: 0,
    changedSections: diff.entries.filter((entry) => entry.change === 'changed').map((entry) => entry.title).slice(0, 100),
    addedSections: diff.entries.filter((entry) => entry.change === 'added').map((entry) => entry.title).slice(0, 100),
    removedSections: diff.entries.filter((entry) => entry.change === 'removed').map((entry) => entry.title).slice(0, 100),
    affectedRows: candidate.kind === 'csv' ? candidate.rows.length : 0,
    note: `对比基线：${base?.id ?? '无已接受版本'}`,
  };
}

function collectStaleModules(modules: readonly ArtifactModule[], changedModuleId: string, now: string): ArtifactModule[] {
  const affected = new Set<string>();
  const queue = [changedModuleId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const module of modules) {
      if (affected.has(module.id) || module.id === changedModuleId) continue;
      if (!module.dependencies.includes(current as never)) continue;
      affected.add(module.id);
      queue.push(module.id);
    }
  }
  const stale: ArtifactModule[] = [];
  for (const moduleId of affected) {
    const module = modules.find((entry) => entry.id === moduleId);
    if (!module) continue;
    if (module.status === 'accepted' || module.status === 'ready_for_review' || module.status === 'draft') {
      stale.push({ ...module, status: 'stale', updatedAt: now });
    }
  }
  return stale;
}

function mergeEvidenceRefs(existing: readonly EvidenceRef[], incoming: readonly EvidenceRef[]): EvidenceRef[] {
  const out: EvidenceRef[] = [...existing];
  const seen = new Set(existing.map((ref) => JSON.stringify(ref)));
  for (const ref of incoming) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= 256) break;
  }
  return out;
}

function safeCandidateForCheckpoint(candidate: ModuleContent): ModuleContent | null {
  const serialized = JSON.stringify(candidate);
  if (serialized.length > 150_000) return null;
  return candidate;
}

function isAutoAcceptEligible(
  workspace: Workspace,
  task: Task,
  module: ArtifactModule,
  report: ValidationReport,
): boolean {
  if (!workspace.settings.autoAcceptVerifiedDrafts) return false;
  if (module.kind === 'json') return false;
  if (task.constraints.some((constraint) => constraint.kind === 'hard' && constraint.status !== 'waived')) return false;
  if (detectConstraintConflicts(task.constraints).length > 0) return false;
  if (module.acceptanceCriteria.some((criterion) => criterion.layer === 'L2' || criterion.layer === 'L3')) return false;
  if (report.checks.some((check) => check.layer !== 'L4' && check.status !== 'pass' && check.status !== 'not_applicable')) return false;
  return true;
}

export { isAutoAcceptEligible };
