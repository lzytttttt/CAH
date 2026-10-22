/**
 * Deterministic local fixture backend (explicit `?fixture=1` preview only).
 *
 * This is a fake backend, not fake UI state: reads return a contract-valid
 * TaskSnapshot and commands mutate the fixture snapshot exactly like the real
 * server would. The UI still goes through the same core store (fetch + refresh),
 * and every surface shows the persistent 本地夹具（非真实执行） badge. No timers
 * decide success anywhere — command handlers answer synchronously.
 */
import {
  TaskSnapshotSchema,
  applyPatchOperations,
  canRunRecipe,
  diffModuleContent,
  isCommitAllowed,
  validateBlockResolution,
  type ArtifactVersion,
  type BudgetPolicy,
  type CapabilityProbe,
  type CapabilityReport,
  type Constraint,
  type DemoTemplate,
  type EngineMode,
  type HarnessEvent,
  type ModuleContent,
  type PatchProposal,
  type Plan,
  type ProviderProfilePublic,
  type Recipe,
  type RecipeProposalInput,
  type TaskSnapshot,
  type ValidationReport,
  type ValidationSummary,
  type VersionListResponse,
  type WorkspaceView,
} from '@ca/contracts';
import { base64ToBytes, bytesToBase64, formatBytes, randomUuid, shortId } from '../../lib/ids';
import { ClientFailure } from '../types';
import type {
  ApiClient,
  EventSubscription,
  SubscribeEventsOptions,
} from '../types';
import { buildFixtureBundle, fixtureHash, fixtureUuid, IDS, loadFixtureBundle, type FixtureScenario } from './data';

const DEFAULT_CONSTRAINT_NOTE = '由夹具后端创建';

interface FixtureState {
  snapshots: Map<string, TaskSnapshot>;
  patches: Map<string, PatchProposal>;
  validations: Map<string, ValidationReport>;
  baseContents: Map<string, ModuleContent | null>;
  recipes: Map<string, Recipe>;
  recipeProposals: Map<string, RecipeProposalInput>;
  profiles: ProviderProfilePublic[];
  versions: Map<string, ArtifactVersion[]>;
  taskId: string;
  scenario: FixtureScenario;
}

export interface FixtureApiClientOptions {
  scenario?: FixtureScenario;
  /** Injectable clock for deterministic display. */
  now?: () => string;
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultBudget(): BudgetPolicy {
  return {
    maxModelRequests: 12,
    maxToolCalls: 20,
    maxOutputTokens: 8192,
    firstEventTimeoutMs: 30_000,
    idleTimeoutMs: 45_000,
    totalModelRequestTimeoutMs: 180_000,
    toolTimeoutMs: 30_000,
    maxRetries: 2,
    maxStructureRepairs: 2,
    maxRunDurationMs: 600_000,
    userCostBudgetUsd: null,
  };
}

function simplePlan(runId: string, moduleId: string, moduleKind: 'markdown' | 'json' | 'csv', goal: string, now: string): Plan {
  return {
    runId: runId as never,
    version: 1,
    goal: goal.slice(0, 4000),
    targetModuleId: moduleId as never,
    artifactSkeleton: [{ moduleId: moduleId as never, moduleKind, sections: [], expectedContentSummary: '由夹具后端生成的简单计划' }],
    inputRefs: [],
    constraintRefs: [],
    assumptions: [],
    openQuestions: [],
    steps: [
      { id: 's1', title: '读取绑定资料', kind: 'tool', dependencies: [], toolId: 'source.read', description: '', expectedOutput: '资料片段', inputRefs: [] },
      { id: 's2', title: '生成候选草稿', kind: 'model', dependencies: ['s1'], toolId: null, description: '', expectedOutput: '候选内容', inputRefs: [] },
      { id: 's3', title: '确定性校验', kind: 'validate', dependencies: ['s2'], toolId: 'artifact.validate', description: '', expectedOutput: '校验报告', inputRefs: [] },
    ],
    tools: [{ toolId: 'source.read', reason: '读取绑定资料', effect: 'read' }],
    validators: [{ id: 'deterministic', layer: 'L1', description: '结构校验' }],
    budget: defaultBudget(),
    risks: [],
    promptVersion: 'planner.v1',
    modelProfileId: null,
    createdAt: now,
  };
}

export class FixtureApiClient {
  readonly kind = 'fixture' as const;
  readonly baseUrl = 'fixture://local';
  readonly scenario: FixtureScenario;

  private readonly now: () => string;
  private state: FixtureState;
  private readonly commandCache = new Map<string, unknown>();
  private readonly subscriptions = new Set<SubscribeEventsOptions>();
  private counter = 0;

  constructor(options: FixtureApiClientOptions = {}) {
    this.scenario = options.scenario ?? 'review';
    this.now = options.now ?? (() => new Date().toISOString());
    this.state = this.loadState(this.scenario);
  }

  /* -------------------------------- plumbing -------------------------------- */

  private nextId(): string {
    this.counter += 1;
    return fixtureUuid(700 + this.counter);
  }

  private traceId(): string {
    return `fixture-${shortId(this.nextId(), 8)}`;
  }

  private fail(code: string, message: string, status = 400, retryable = false): never {
    throw new ClientFailure({
      kind: 'http',
      code,
      message,
      retryable,
      traceId: this.traceId(),
      status,
    });
  }

  private current(): TaskSnapshot {
    const snapshot = this.state.snapshots.get(this.state.taskId);
    if (!snapshot) this.fail('not_found', '夹具任务不存在', 404);
    return snapshot;
  }

  private bump(snapshot: TaskSnapshot): void {
    snapshot.task.revision += 1;
    snapshot.snapshotSeq += 1;
    snapshot.task.updatedAt = this.now();
    snapshot.artifact.updatedAt = this.now();
    snapshot.serverTime = this.now();
  }

  private idempotent<T>(commandId: string, run: () => T): T {
    const cached = this.commandCache.get(commandId);
    if (cached !== undefined) return deepClone(cached as T);
    const result = run();
    this.commandCache.set(commandId, deepClone(result));
    return result;
  }

  private loadState(scenario: FixtureScenario): FixtureState {
    const bundle = loadFixtureBundle(scenario);
    const snapshot = TaskSnapshotSchema.parse(bundle.snapshot);
    const snapshots = new Map<string, TaskSnapshot>();
    snapshots.set(snapshot.task.id, snapshot);
    const patches = new Map<string, PatchProposal>();
    for (const patch of bundle.patches) patches.set(patch.id, patch);
    const validations = new Map<string, ValidationReport>();
    for (const [id, report] of Object.entries(bundle.validations)) validations.set(id, report);
    const baseContents = new Map<string, ModuleContent | null>();
    for (const [id, content] of Object.entries(bundle.baseContents)) baseContents.set(id, content);
    const recipes = new Map<string, Recipe>();
    for (const recipe of bundle.recipes) recipes.set(recipe.id, recipe);
    const recipeProposals = new Map<string, RecipeProposalInput>();
    for (const [runId, proposal] of Object.entries(bundle.recipeProposals)) recipeProposals.set(runId, proposal);
    return {
      snapshots,
      patches,
      validations,
      baseContents,
      recipes,
      recipeProposals,
      profiles: [],
      versions: new Map(),
      taskId: snapshot.task.id,
      scenario,
    };
  }

  /** Swap the active fixture scenario (preview control). */
  loadScenario(scenario: FixtureScenario): string {
    this.state = this.loadState(scenario);
    this.commandCache.clear();
    return this.state.taskId;
  }

  /* -------------------------------- session -------------------------------- */

  async getSession() {
    const snapshot = this.current();
    return {
      authenticated: true,
      mode: snapshot.workspace.mode,
      availableModes: ['demo', 'live'] as EngineMode[],
      csrfToken: 'fixture-csrf-token',
      serverVersion: '0.1.0-fixture',
      policyVersion: snapshot.workspace.policyVersion,
      liveProviderConfigured: false,
      demoAvailable: true,
      serverTime: this.now(),
      uptimeSeconds: 60,
    };
  }

  async getWorkspace(): Promise<WorkspaceView> {
    const snapshot = this.current();
    return {
      workspace: {
        id: snapshot.workspace.workspaceId,
        mode: snapshot.workspace.mode,
        name: snapshot.workspace.name,
        settings: snapshot.workspace.settings,
        policyVersion: snapshot.workspace.policyVersion,
        createdAt: snapshot.task.createdAt,
        updatedAt: snapshot.task.updatedAt,
      },
      providerProfiles: deepClone(this.state.profiles),
      demoAvailable: true,
      liveAvailable: false,
      appVersion: '0.1.0-fixture',
      policyVersion: snapshot.workspace.policyVersion,
      limits: { ...snapshot.limits },
    };
  }

  async updateWorkspace(request: { commandId: string; settings: Partial<TaskSnapshot['workspace']['settings']> }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.current();
      snapshot.workspace.settings = { ...snapshot.workspace.settings, ...request.settings };
      this.bump(snapshot);
      return {
        commandId: request.commandId,
        duplicate: false,
        workspace: {
          id: snapshot.workspace.workspaceId,
          mode: snapshot.workspace.mode,
          name: snapshot.workspace.name,
          settings: snapshot.workspace.settings,
          policyVersion: snapshot.workspace.policyVersion,
          createdAt: snapshot.task.createdAt,
          updatedAt: snapshot.task.updatedAt,
        },
      };
    });
  }

  async setWorkspaceMode(request: { commandId: string; mode: EngineMode }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.current();
      if (snapshot.activeRun) this.fail('state_not_allowed', '存在进行中的运行，不能切换模式；请先结束或保留当前运行。', 409);
      snapshot.workspace.mode = request.mode;
      for (const taskSnapshot of this.state.snapshots.values()) taskSnapshot.workspace.mode = request.mode;
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, mode: request.mode, redirected: false };
    });
  }

  /* --------------------------------- tasks --------------------------------- */

  async listTasks() {
    return {
      tasks: [...this.state.snapshots.values()].map((snapshot) => ({
        taskId: snapshot.task.id,
        artifactId: snapshot.artifact.id,
        title: snapshot.task.title,
        status: snapshot.task.status,
        revision: snapshot.task.revision,
        createdAt: snapshot.task.createdAt,
        updatedAt: snapshot.task.updatedAt,
        moduleCount: snapshot.modules.length,
        activeRunState: snapshot.activeRun ? snapshot.activeRun.state : null,
        acceptedCount: snapshot.modules.filter((view) => view.acceptance.status === 'accepted').length,
      })),
    };
  }

  async createTask(request: {
    commandId: string;
    title: string;
    intent: string;
    artifactTitle: string;
    constraints?: Array<Omit<Constraint, 'status'>>;
    templateId?: string | null;
    modules?: Array<{ key: string; title: string; kind: 'markdown' | 'json' | 'csv'; order: number; acceptanceCriteria: Array<{ text: string; layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'; id?: string }>; dependsOnKeys?: string[]; intentHint?: string }>;
  }) {
    return this.idempotent(request.commandId, () => {
      const empty = TaskSnapshotSchema.parse(loadFixtureBundle('empty').snapshot);
      const taskId = this.nextId();
      const artifactId = this.nextId();
      const moduleSpecs = request.modules && request.modules.length > 0
        ? request.modules
        : [
            { key: 'm1', title: '核心架构拓扑', kind: 'json' as const, order: 0, acceptanceCriteria: [] },
            { key: 'm2', title: '多模态交互引擎规范', kind: 'markdown' as const, order: 1, acceptanceCriteria: [] },
            { key: 'm3', title: '存量系统兼容层清洗', kind: 'csv' as const, order: 2, acceptanceCriteria: [] },
            { key: 'm4', title: '商业化价值壁垒矩阵', kind: 'csv' as const, order: 3, acceptanceCriteria: [] },
          ];
      const moduleIds = moduleSpecs.map(() => this.nextId());
      const modules = empty.modules.slice(0, 0);
      for (const [index, spec] of moduleSpecs.entries()) {
        const moduleId = moduleIds[index]!;
        modules.push({
          module: {
            id: moduleId as never,
            artifactId: artifactId as never,
            title: spec.title,
            kind: spec.kind,
            order: spec.order,
            dependencies: [],
            acceptanceCriteria: (spec.acceptanceCriteria ?? []).map((criterion, criterionIndex) => ({
              id: criterion.id ?? `ac-${criterionIndex + 1}`,
              text: criterion.text,
              layer: criterion.layer,
              validatorId: null,
            })),
            status: 'empty',
            blockedFrom: null,
            acceptedVersionId: null,
            createdAt: this.now(),
            updatedAt: this.now(),
          },
          acceptance: {
            moduleId: moduleId as never,
            status: 'empty',
            acceptedVersionId: null,
            acceptedAt: null,
            acceptedSummary: null,
            acceptedContentHash: null,
            pendingPatchId: null,
            pendingValidationReportId: null,
            pendingValidationStatus: null,
            staleReason: null,
            openBlockerIds: [],
          },
          acceptedContent: null,
          acceptedVersion: null,
          pendingCandidateSummary: null,
        });
      }
      const snapshot: TaskSnapshot = {
        ...empty,
        snapshotSeq: 1,
        serverTime: this.now(),
        task: {
          ...empty.task,
          id: taskId as never,
          workspaceId: empty.workspace.workspaceId,
          title: request.title.slice(0, 200),
          intent: request.intent.slice(0, 8000),
          constraints: (request.constraints ?? []).map((constraint, index) => ({
            ...constraint,
            status: 'open' as const,
            note: constraint.note ?? DEFAULT_CONSTRAINT_NOTE,
            id: constraint.id || `C-${index + 1}`,
          })),
          artifactId: artifactId as never,
          revision: 0,
          templateId: request.templateId ?? null,
          status: 'active',
          createdAt: this.now(),
          updatedAt: this.now(),
        },
        artifact: {
          ...empty.artifact,
          id: artifactId as never,
          taskId: taskId as never,
          title: request.artifactTitle.slice(0, 200),
          moduleIds: moduleIds as never,
          acceptedVersionId: null,
          status: 'draft',
          createdAt: this.now(),
          updatedAt: this.now(),
        },
        modules: modules as never,
        spatial: {
          ...empty.spatial,
          nodes: [
            {
              id: 'node-hub',
              kind: 'hub',
              layer: 'global',
              title: request.artifactTitle.slice(0, 300),
              status: 'empty',
              summary: `${moduleSpecs.length} 个模块 · 尚未开始`,
              moduleId: null,
              runId: null,
              stepId: null,
              refId: artifactId,
              badgeCount: moduleSpecs.length,
              laneHint: 0,
            },
          ],
        },
      };
      this.state.snapshots.set(taskId, snapshot);
      this.state.taskId = taskId;
      return {
        commandId: request.commandId,
        duplicate: false,
        taskId,
        artifactId,
        revision: 0,
        moduleIds,
      };
    });
  }

  async updateTask(taskId: string, request: { commandId: string; expectedRevision: number; title?: string; intent?: string; constraints?: Constraint[]; modules?: unknown[] }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.state.snapshots.get(taskId);
      if (!snapshot) this.fail('not_found', '任务不存在', 404);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      if (request.title) snapshot.task.title = request.title.slice(0, 200);
      if (request.intent) snapshot.task.intent = request.intent.slice(0, 8000);
      if (request.constraints) snapshot.task.constraints = request.constraints;
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, task: snapshot.task };
    });
  }

  async getSnapshot(taskId: string, query?: { afterSeq?: number; includeEvents?: boolean }): Promise<TaskSnapshot> {
    const snapshot = this.state.snapshots.get(taskId);
    if (!snapshot) this.fail('not_found', '任务不存在', 404);
    const clone = deepClone(snapshot);
    if (query && query.includeEvents === false) clone.events = [];
    return TaskSnapshotSchema.parse(clone);
  }

  subscribeEvents(taskId: string, options: SubscribeEventsOptions): EventSubscription {
    if (!this.state.snapshots.has(taskId)) {
      options.onError?.(new ClientFailure({ kind: 'http', code: 'not_found', message: '任务不存在', retryable: false, traceId: this.traceId(), status: 404 }));
      return { close: () => undefined, isOpen: () => false };
    }
    this.subscriptions.add(options);
    options.onStateChange?.('open');
    options.onOpen?.();
    return {
      close: () => {
        this.subscriptions.delete(options);
        options.onStateChange?.('closed');
      },
      isOpen: () => this.subscriptions.has(options),
    };
  }

  /** Push a contract-valid event to fixture subscribers (used when a command changes state). */
  private emit(type: HarnessEvent['type'], payload: unknown, runId: string | null = null): void {
    if (this.subscriptions.size === 0) return;
    // Fixture events are not needed for correctness: the core store refetches
    // the snapshot after every command. Keeping the emitter minimal avoids
    // pretending the fixture is a real event log.
    void type;
    void payload;
    void runId;
  }

  /* -------------------------------- sources -------------------------------- */

  async importSource(taskId: string, request: { commandId: string; fileName: string; mime: string; contentBase64: string; origin?: string }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.state.snapshots.get(taskId);
      if (!snapshot) this.fail('not_found', '任务不存在', 404);
      const normalizedName = request.fileName.toLowerCase();
      const supported = /\.(md|markdown|txt|json|csv)$/.test(normalizedName);
      if (!supported) {
        this.fail('unsupported_media_type', '首版仅支持 UTF-8 TXT / Markdown / JSON / CSV 资料；该文件已明确拒绝，不会伪装成空文件。', 415);
      }
      let bytes = 0;
      try {
        bytes = base64ToBytes(request.contentBase64).byteLength;
      } catch {
        this.fail('bad_request', '文件内容不是合法 base64', 400);
      }
      if (bytes > 10 * 1024 * 1024) this.fail('payload_too_large', '单文件不能超过 10 MiB', 413);
      const sourceId = this.nextId();
      snapshot.sources.push({
        sourceId: sourceId as never,
        name: request.fileName.slice(0, 300),
        version: 1,
        availability: 'available',
        spanCount: 0,
        trustLevel: 'user_provided',
        previewSpanIds: [],
      });
      this.bump(snapshot);
      return {
        commandId: request.commandId,
        duplicate: false,
        sourceId,
        version: 1,
        parseStatus: 'parsed' as const,
        parseNote: `已登记 ${formatBytes(bytes)}；夹具后端不解析正文内容。`,
        warnings: [],
      };
    });
  }

  /* --------------------------------- runs --------------------------------- */

  async createRun(taskId: string, request: { commandId: string; expectedRevision: number; moduleId: string; intent: string; planFirst?: boolean; sourceIds?: string[] }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.state.snapshots.get(taskId);
      if (!snapshot) this.fail('not_found', '任务不存在', 404);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      const moduleView = snapshot.modules.find((view) => view.module.id === request.moduleId);
      if (!moduleView) this.fail('bad_request', '目标模块不存在', 400);
      if (moduleView.module.status === 'blocked') this.fail('state_not_allowed', '目标模块当前受阻，请先处理阻塞', 409);
      const runId = this.nextId();
      const plan = simplePlan(runId, request.moduleId, moduleView.module.kind, request.intent, this.now());
      snapshot.runs.unshift({
        runId: runId as never,
        moduleId: request.moduleId as never,
        state: 'READY',
        origin: 'intent',
        attempt: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
        activeStepTitle: null,
        errorSummary: null,
      });
      snapshot.plan = plan;
      snapshot.activeRun = {
        runId: runId as never,
        moduleId: request.moduleId as never,
        state: 'READY',
        revision: 1,
        attempt: 1,
        planVersion: plan.version,
        contextSnapshotId: null,
        budgetUsage: snapshot.usage ?? {
          modelRequests: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          usdCost: null,
          elapsedActiveMs: 0,
          startedAt: null,
          updatedAt: this.now(),
        },
        error: null,
        interrupted: null,
      };
      snapshot.spatial.stage = {
        phase: 'peeking',
        label: '计划已生成 · 等待审阅',
        completedSteps: 0,
        totalSteps: plan.steps.length,
        activeStepTitle: null,
        note: `真实风险 ${plan.risks.length} 项；未处理阻止提交的风险前不能执行。`,
      };
      snapshot.control = {
        ...snapshot.control,
        runId: runId as never,
        state: 'READY',
        canPause: true,
        canResume: false,
        canCancel: true,
        unsavedDraft: false,
      };
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, runId, state: 'READY', revision: snapshot.task.revision, plan };
    });
  }

  async commitPlan(runId: string, request: { commandId: string; expectedRevision: number; planVersion: number; contextSnapshotId: string }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.activeSnapshotForRun(runId);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      if (!snapshot.plan || snapshot.plan.version !== request.planVersion) this.fail('version_conflict', '计划版本已变化，请重新检查', 409);
      const blocking = snapshot.plan.risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null);
      if (blocking.length > 0) this.fail('validation_failed', `${blocking.length} 项阻止提交的风险尚未处理`, 422);
      if (!snapshot.activeRun) this.fail('state_not_allowed', '当前没有可提交的计划', 409);
      snapshot.activeRun.state = 'RUNNING';
      snapshot.control = { ...snapshot.control, state: 'RUNNING', canPause: true, canResume: false, canCancel: true };
      // Simulated completion of the run inside the fixture backend (clearly labelled in the UI).
      this.simulateRunCompletion(snapshot);
      this.bump(snapshot);
      return {
        commandId: request.commandId,
        duplicate: false,
        runId: runId as never,
        state: snapshot.activeRun.state,
        revision: snapshot.task.revision,
      };
    });
  }

  async resolveInput(runId: string, request: { commandId: string; expectedRevision: number; blockerId: string; optionId: string; value: unknown; note?: string }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.activeSnapshotForRun(runId);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      const blocker = snapshot.blockers.find((candidate) => candidate.id === request.blockerId);
      if (!blocker) this.fail('not_found', '待决问题不存在或已被处理', 404);
      const option = blocker.resolutions.find((candidate) => candidate.id === request.optionId);
      if (!option) this.fail('bad_request', '处理选项不存在', 400);
      const validation = validateBlockResolution(option, request.value);
      if (!validation.ok) this.fail('validation_failed', validation.error ?? '输入不合法', 422);
      snapshot.blockers = snapshot.blockers.filter((candidate) => candidate.id !== blocker.id);
      // Clear the matching blocking risk (deterministic for the demo only).
      if (snapshot.plan) {
        for (const risk of snapshot.plan.risks) {
          if (risk.severity === 'blocking' && risk.resolvedByDecisionId === null) {
            risk.resolvedByDecisionId = this.nextId().slice(0, 8) as never;
            break;
          }
        }
      }
      for (const view of snapshot.modules) {
        if (view.acceptance.openBlockerIds.includes(blocker.id)) {
          view.acceptance.openBlockerIds = view.acceptance.openBlockerIds.filter((id) => id !== blocker.id);
        }
        if (view.module.status === 'blocked' && view.acceptance.openBlockerIds.length === 0) {
          view.module.status = (view.module.blockedFrom ?? 'empty') as never;
          view.acceptance.status = (view.module.blockedFrom ?? 'empty') as never;
        }
      }
      if (snapshot.activeRun) {
        snapshot.activeRun.state = snapshot.blockers.some((candidate) => candidate.status === 'open') ? 'AWAITING_INPUT' : 'RUNNING';
        snapshot.control = { ...snapshot.control, state: snapshot.activeRun.state as never };
      }
      snapshot.spatial.stage = {
        ...snapshot.spatial.stage,
        label: snapshot.blockers.length === 0 ? '待决问题已处理 · 继续执行' : `待决问题已处理 · 仍有 ${snapshot.blockers.length} 项待处理`,
        note: '修复不通过时继续显示原因；已接受成果不变。',
      };
      this.bump(snapshot);
      return {
        commandId: request.commandId,
        duplicate: false,
        runId: runId as never,
        state: snapshot.activeRun?.state ?? 'READY',
        revision: snapshot.task.revision,
      };
    });
  }

  async pauseRun(runId: string, request: { commandId: string; expectedRevision: number; reason?: string }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.activeSnapshotForRun(runId);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      if (!snapshot.activeRun) this.fail('state_not_allowed', '当前没有活动运行', 409);
      if (!snapshot.control.canPause) this.fail('state_not_allowed', '当前状态不接受暂停', 409);
      snapshot.activeRun.state = 'PAUSED';
      snapshot.control = { ...snapshot.control, state: 'PAUSED', canPause: false, canResume: true, canCancel: true };
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, runId: runId as never, state: 'PAUSED', revision: snapshot.task.revision };
    });
  }

  async resumeRun(runId: string, request: { commandId: string; expectedRevision: number; reason?: string }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.activeSnapshotForRun(runId);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      if (!snapshot.activeRun) this.fail('state_not_allowed', '当前没有可继续的运行', 409);
      if (!snapshot.control.canResume) this.fail('state_not_allowed', '当前状态不接受继续', 409);
      snapshot.activeRun.state = 'RUNNING';
      snapshot.control = { ...snapshot.control, state: 'RUNNING', canPause: true, canResume: false, canCancel: true };
      if (snapshot.activeRun.attempt) snapshot.activeRun.attempt += 1;
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, runId: runId as never, state: 'RUNNING', revision: snapshot.task.revision };
    });
  }

  async cancelRun(runId: string, request: { commandId: string; expectedRevision: number; reason?: string }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.activeSnapshotForRun(runId);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      if (!snapshot.activeRun) this.fail('state_not_allowed', '当前没有活动运行', 409);
      if (!snapshot.control.canCancel) this.fail('state_not_allowed', '当前状态不接受取消', 409);
      const run = snapshot.runs.find((candidate) => candidate.runId === runId);
      if (run) run.state = 'CANCELLED';
      snapshot.activeRun = null;
      snapshot.control = { ...snapshot.control, runId: null, state: null, canPause: false, canResume: false, canCancel: false };
      snapshot.spatial.stage = {
        ...snapshot.spatial.stage,
        phase: 'idle',
        label: '运行已取消 · 已接受成果保留',
        note: '取消与提交串行处理；已提交版本不会被撤回。',
      };
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, runId: runId as never, state: 'CANCELLED', revision: snapshot.task.revision };
    });
  }

  async getRunDetail(runId: string) {
    const snapshot = this.activeSnapshotForRun(runId);
    const summary = snapshot.runs.find((run) => run.runId === runId);
    return {
      run: {
        runId,
        taskId: snapshot.task.id,
        moduleId: summary?.moduleId ?? snapshot.modules[0]!.module.id,
        state: summary?.state ?? 'COMPLETED',
        revision: 1,
        attempt: summary?.attempt ?? 1,
        planVersion: snapshot.plan?.version ?? 0,
        contextSnapshotId: null,
        budgetUsage: snapshot.usage ?? {
          modelRequests: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          usdCost: null,
          elapsedActiveMs: 0,
          startedAt: null,
          updatedAt: this.now(),
        },
        error: null,
        interrupted: null,
        createdAt: summary?.createdAt ?? this.now(),
        updatedAt: summary?.updatedAt ?? this.now(),
        startedAt: summary?.createdAt ?? null,
        finishedAt: null,
      },
      plan: snapshot.plan,
      steps: [],
      blockers: snapshot.blockers,
      contextSnapshot: null,
      validationReport: snapshot.validations[0] ? this.state.validations.get(snapshot.validations[0].validationReportId) ?? null : null,
    };
  }

  private activeSnapshotForRun(runId: string): TaskSnapshot {
    for (const snapshot of this.state.snapshots.values()) {
      if (snapshot.activeRun?.runId === runId) return snapshot;
      if (snapshot.runs.some((run) => run.runId === runId)) return snapshot;
    }
    this.fail('not_found', '运行不存在', 404);
  }

  /** Deterministic in-backend simulation of a completed run producing a patch. */
  private simulateRunCompletion(snapshot: TaskSnapshot): void {
    const run = snapshot.activeRun;
    if (!run || !snapshot.plan) return;
    const moduleView = snapshot.modules.find((view) => view.module.id === run.moduleId);
    if (!moduleView) return;
    const base = (moduleView.acceptedVersion?.content ?? null) as ModuleContent | null;
    const patchId = this.nextId();
    const validationReportId = this.nextId();
    const baseContent: ModuleContent =
      base ??
      (moduleView.module.kind === 'markdown'
        ? { kind: 'markdown', sections: [] }
        : moduleView.module.kind === 'json'
          ? { kind: 'json', value: null }
          : { kind: 'csv', columns: [], rows: [] });
    let candidate: ModuleContent;
    let operations: PatchProposal['operations'];
    if (moduleView.module.kind === 'markdown') {
      operations = [
        {
          kind: 'markdown.insert_section',
          afterSectionId: baseContent.kind === 'markdown' && baseContent.sections.length > 0 ? baseContent.sections[baseContent.sections.length - 1]!.id : null,
          title: '夹具生成的候选章节',
          markdown: '## 夹具生成的候选章节\n\n这是本地夹具（非真实执行）生成的候选内容，用于预览差异审阅与接受流程。\n',
          id: 'fixture-new-section',
        },
      ];
    } else if (moduleView.module.kind === 'json') {
      operations = [{ kind: 'replace_module', content: { kind: 'json', value: { fixture: true, note: '本地夹具候选内容' } } }];
    } else {
      operations = [
        {
          kind: 'replace_module',
          content: {
            kind: 'csv',
            columns: [
              { key: 'system_id', label: '系统ID', type: 'string', required: true },
              { key: 'name', label: '系统名称', type: 'string', required: true },
            ],
            rows: [{ system_id: 'S-1001', name: '订单中心' }],
          },
        },
      ];
    }
    candidate = applyPatchOperations(baseContent, moduleView.module.kind, operations);
    const candidateHash = fixtureHash(`fixture-candidate-${patchId}`);
    const validation: ValidationReport = {
      id: validationReportId as never,
      taskId: snapshot.task.id,
      runId: run.runId,
      moduleId: moduleView.module.id,
      baseVersionId: moduleView.acceptance.acceptedVersionId,
      candidateHash: candidateHash as never,
      checks: [
        { id: 'chk-0', layer: 'L0', code: 'schema_valid', title: '结构合法', status: 'pass', detail: '夹具校验通过。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-1', layer: 'L1', code: 'structure', title: '结构完整', status: 'pass', detail: '夹具校验通过。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-2', layer: 'L4', code: 'human_review', title: '人工审阅', status: 'not_applicable', detail: '由用户接受。', evidenceRefs: [], affectedPaths: [] },
      ],
      status: 'pass',
      summary: '夹具确定性校验通过（非真实执行）。',
      validatorVersion: 'fixture-validator',
      createdAt: this.now(),
    };
    const patch: PatchProposal = {
      id: patchId as never,
      taskId: snapshot.task.id,
      runId: run.runId,
      moduleId: moduleView.module.id,
      moduleKind: moduleView.module.kind,
      baseVersionId: moduleView.acceptance.acceptedVersionId,
      operations,
      evidenceRefs: [],
      validationReportId: validationReportId as never,
      candidateHash: candidateHash as never,
      candidate,
      status: 'proposed',
      description: '夹具生成的候选修改（非真实模型输出）。',
      changeSummary: {
        addedLines: 8,
        removedLines: 0,
        changedSections: [],
        addedSections: moduleView.module.kind === 'markdown' ? ['夹具生成的候选章节'] : [],
        removedSections: [],
        affectedRows: moduleView.module.kind === 'csv' ? 1 : 0,
        note: '本地夹具数据',
      },
      createdAt: this.now(),
      acceptedVersionId: null,
    };
    this.state.patches.set(patchId, patch);
    this.state.validations.set(validationReportId, validation);
    this.state.baseContents.set(patchId, base);
    snapshot.patches.unshift({ patchId: patchId as never, moduleId: moduleView.module.id, status: 'proposed', validationStatus: 'pass', createdAt: this.now() });
    snapshot.validations.unshift({
      validationReportId: validationReportId as never,
      moduleId: moduleView.module.id,
      status: 'pass',
      checkCounts: { pass: 2, fail: 0, needsReview: 0, notApplicable: 1 },
      blockingFindings: [],
      createdAt: this.now(),
    } satisfies ValidationSummary);
    moduleView.acceptance.pendingPatchId = patchId as never;
    moduleView.acceptance.pendingValidationReportId = validationReportId as never;
    moduleView.acceptance.pendingValidationStatus = 'pass';
    moduleView.acceptance.status = 'ready_for_review';
    moduleView.module.status = 'ready_for_review';
    moduleView.pendingCandidateSummary = '夹具候选：校验通过，等待接受。';
    // Update run/state to AWAITING_REVIEW.
    run.state = 'AWAITING_REVIEW';
    for (const summary of snapshot.runs) if (summary.runId === run.runId) summary.state = 'AWAITING_REVIEW';
    snapshot.control = { ...snapshot.control, state: 'AWAITING_REVIEW', canPause: false, canResume: false, canCancel: true };
    snapshot.spatial.stage = {
      phase: 'review',
      label: '候选已通过校验 · 等待接受',
      completedSteps: snapshot.plan.steps.length,
      totalSteps: snapshot.plan.steps.length,
      activeStepTitle: null,
      note: '接受或拒绝不会播放成功动画；结果来自后端事件。',
    };
  }

  /* -------------------------------- patches -------------------------------- */

  async getPatchReview(patchId: string) {
    const patch = this.state.patches.get(patchId);
    if (!patch) this.fail('not_found', '差异不存在', 404);
    const validation = patch.validationReportId ? this.state.validations.get(patch.validationReportId) ?? null : null;
    const baseContent = this.state.baseContents.get(patchId) ?? null;
    const diff = diffModuleContent(patch.moduleId, patch.moduleKind, baseContent, patch.candidate, {
      baseVersionId: patch.baseVersionId,
      candidateHash: patch.candidateHash,
    });
    return { patch, diff, validation, baseContent };
  }

  async acceptPatch(patchId: string, request: { commandId: string; expectedRevision: number; validationReportId: string; acceptMode?: 'all' | 'sections'; sectionIds?: string[]; note?: string }) {
    return this.idempotent(request.commandId, () => {
      const patch = this.state.patches.get(patchId);
      if (!patch) this.fail('not_found', '差异不存在', 404);
      const snapshot = this.state.snapshots.get(patch.taskId) ?? this.current();
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      if (patch.status !== 'proposed') this.fail('state_not_allowed', '该差异已处理', 409);
      const moduleView = snapshot.modules.find((view) => view.module.id === patch.moduleId);
      if (!moduleView) this.fail('not_found', '模块不存在', 404);
      if (patch.baseVersionId !== moduleView.acceptance.acceptedVersionId) this.fail('version_conflict', '基线版本已变化，请重新生成差异', 409);
      const validation = this.state.validations.get(request.validationReportId);
      if (!validation || validation.id !== patch.validationReportId) this.fail('validation_failed', '校验报告不匹配，请重新校验', 422);
      if (!isCommitAllowed(validation)) this.fail('validation_failed', '校验未通过，不能接受该变异', 422);
      let content = patch.candidate;
      if (request.acceptMode === 'sections') {
        const sectionIds = request.sectionIds ?? [];
        if (sectionIds.length === 0) this.fail('bad_request', '按章节接受必须选择至少一个章节', 400);
        const base = this.state.baseContents.get(patchId) ?? null;
        const ops = patch.operations.filter((operation) => {
          if (operation.kind === 'markdown.replace_section' || operation.kind === 'markdown.remove_section') return sectionIds.includes(operation.sectionId);
          if (operation.kind === 'markdown.insert_section') return operation.id != null && sectionIds.includes(operation.id);
          return false;
        });
        if (ops.length === 0) this.fail('bad_request', '所选章节没有可接受的修改', 400);
        content = applyPatchOperations(base, patch.moduleKind, ops);
      }
      const versionId = this.nextId();
      const acceptedAt = this.now();
      const version: ArtifactVersion = {
        id: versionId as never,
        artifactId: snapshot.artifact.id,
        moduleId: patch.moduleId,
        moduleKind: patch.moduleKind,
        contentHash: fixtureHash(`fixture-version-${versionId}`) as never,
        content,
        parentId: moduleView.acceptance.acceptedVersionId,
        baseVersionId: moduleView.acceptance.acceptedVersionId,
        sourceRunId: patch.runId,
        patchId: patch.id,
        validationReportId: validation.id,
        acceptedBy: 'user',
        acceptedAt,
        note: request.note ?? '',
        restoredFromVersionId: null,
      };
      moduleView.module.acceptedVersionId = versionId as never;
      moduleView.module.status = 'accepted';
      moduleView.acceptedVersion = version;
      moduleView.acceptedContent = content;
      moduleView.pendingCandidateSummary = null;
      moduleView.acceptance = {
        ...moduleView.acceptance,
        status: 'accepted',
        acceptedVersionId: versionId as never,
        acceptedAt,
        acceptedSummary: patch.description.slice(0, 500),
        acceptedContentHash: version.contentHash,
        pendingPatchId: null,
        pendingValidationReportId: null,
        pendingValidationStatus: null,
      };
      patch.status = 'accepted';
      patch.acceptedVersionId = versionId as never;
      snapshot.patches = snapshot.patches.map((item) => (item.patchId === patchId ? { ...item, status: 'accepted' as const } : item));
      snapshot.artifact.acceptedVersionId = versionId as never;
      snapshot.artifact.status = 'active';
      const versionList = this.state.versions.get(patch.moduleId) ?? [];
      versionList.push(version);
      this.state.versions.set(patch.moduleId, versionList);
      const run = snapshot.runs.find((item) => item.runId === patch.runId);
      let runState: string | null = run?.state ?? null;
      if (run && run.state !== 'COMPLETED') {
        run.state = 'COMPLETED';
        run.updatedAt = acceptedAt;
        run.activeStepTitle = null;
        runState = 'COMPLETED';
      }
      if (snapshot.activeRun?.runId === patch.runId) snapshot.activeRun = null;
      snapshot.control = { ...snapshot.control, runId: snapshot.activeRun?.runId ?? null, state: (snapshot.activeRun?.state ?? null) as never, canPause: false, canResume: false, canCancel: false };
      snapshot.spatial.stage = { ...snapshot.spatial.stage, phase: 'ready', label: '成果已接受 · 可继续下一步', note: '接受由后端事务提交，版本不可变。' };
      this.markDownstreamStale(snapshot, patch.moduleId);
      this.bump(snapshot);
      return {
        commandId: request.commandId,
        duplicate: false,
        patchId: patchId as never,
        versionId: versionId as never,
        moduleId: patch.moduleId,
        runState,
        artifactRevision: snapshot.task.revision,
      };
    });
  }

  async rejectPatch(patchId: string, request: { commandId: string; expectedRevision?: number; reason: string }) {
    return this.idempotent(request.commandId, () => {
      const patch = this.state.patches.get(patchId);
      if (!patch) this.fail('not_found', '差异不存在', 404);
      if (patch.status !== 'proposed') this.fail('state_not_allowed', '该差异已处理', 409);
      patch.status = 'rejected';
      const snapshot = this.state.snapshots.get(patch.taskId) ?? this.current();
      snapshot.patches = snapshot.patches.map((item) => (item.patchId === patchId ? { ...item, status: 'rejected' as const } : item));
      const moduleView = snapshot.modules.find((view) => view.module.id === patch.moduleId);
      if (moduleView) {
        moduleView.acceptance = { ...moduleView.acceptance, pendingPatchId: null, pendingValidationReportId: null, pendingValidationStatus: null, status: 'draft' };
        moduleView.pendingCandidateSummary = null;
        moduleView.module.status = 'draft';
      }
      const run = snapshot.runs.find((item) => item.runId === patch.runId);
      if (run && run.state === 'AWAITING_REVIEW') run.state = 'CANCELLED';
      if (snapshot.activeRun?.runId === patch.runId) snapshot.activeRun = null;
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, patchId: patchId as never, status: 'rejected' as const };
    });
  }

  async getModuleContent(taskId: string, moduleId: string) {
    const snapshot = this.state.snapshots.get(taskId);
    if (!snapshot) this.fail('not_found', '任务不存在', 404);
    const view = snapshot.modules.find((candidate) => candidate.module.id === moduleId);
    if (!view) this.fail('not_found', '模块不存在', 404);
    return {
      moduleId,
      versionId: view.acceptance.acceptedVersionId,
      contentHash: view.acceptance.acceptedContentHash,
      moduleKind: view.module.kind,
      content: (view.acceptedContent as ModuleContent | null) ?? null,
      acceptedAt: view.acceptance.acceptedAt,
      acceptedBy: view.acceptedVersion?.acceptedBy ?? null,
    };
  }

  async getVersions(taskId: string, moduleId: string): Promise<VersionListResponse> {
    const snapshot = this.state.snapshots.get(taskId);
    if (!snapshot) this.fail('not_found', '任务不存在', 404);
    const stored = this.state.versions.get(moduleId) ?? [];
    const view = snapshot.modules.find((candidate) => candidate.module.id === moduleId);
    const entries: VersionListResponse['versions'] = [];
    if (view?.acceptedVersion) {
      entries.push({
        versionId: view.acceptedVersion.id,
        contentHash: view.acceptedVersion.contentHash,
        acceptedAt: view.acceptedVersion.acceptedAt,
        acceptedBy: view.acceptedVersion.acceptedBy,
        parentId: view.acceptedVersion.parentId,
        sourceRunId: view.acceptedVersion.sourceRunId,
        note: view.acceptedVersion.note,
        isCurrent: true,
      });
      entries.push({
        versionId: fixtureUuid(210) as never,
        contentHash: fixtureHash('interaction-v1'),
        acceptedAt: snapshot.task.createdAt,
        acceptedBy: 'demo-seed',
        parentId: null,
        sourceRunId: IDS.runs.interaction as never,
        note: '初始基线',
        isCurrent: false,
      });
    }
    for (const version of stored) {
      if (entries.some((entry) => entry.versionId === version.id)) continue;
      entries.push({
        versionId: version.id,
        contentHash: version.contentHash,
        acceptedAt: version.acceptedAt,
        acceptedBy: version.acceptedBy,
        parentId: version.parentId,
        sourceRunId: version.sourceRunId,
        note: version.note,
        isCurrent: view?.acceptance.acceptedVersionId === version.id,
      });
    }
    return { moduleId: moduleId as never, versions: entries };
  }

  async restoreVersion(artifactId: string, request: { commandId: string; expectedRevision: number; moduleId: string; versionId: string; note?: string }) {
    return this.idempotent(request.commandId, () => {
      let snapshot: TaskSnapshot | undefined;
      for (const candidate of this.state.snapshots.values()) if (candidate.artifact.id === artifactId) snapshot = candidate;
      if (!snapshot) this.fail('not_found', '成果不存在', 404);
      if (request.expectedRevision !== snapshot.task.revision) this.fail('revision_conflict', '任务已被其他操作更新，请重新同步', 409);
      const view = snapshot.modules.find((candidate) => candidate.module.id === request.moduleId);
      if (!view) this.fail('not_found', '模块不存在', 404);
      const versions = this.state.versions.get(request.moduleId) ?? [];
      const old = versions.find((version) => version.id === request.versionId) ?? (view.acceptedVersion?.id === request.versionId ? view.acceptedVersion : null);
      if (!old) this.fail('not_found', '目标版本不存在', 404);
      const newId = this.nextId();
      const restored: ArtifactVersion = {
        ...old,
        id: newId as never,
        parentId: view.acceptance.acceptedVersionId,
        baseVersionId: view.acceptance.acceptedVersionId,
        restoredFromVersionId: old.id,
        acceptedAt: this.now(),
        acceptedBy: 'user',
        note: request.note ?? `恢复自 ${shortId(old.id)}`,
      };
      view.acceptedVersion = restored;
      view.acceptedContent = restored.content;
      view.module.acceptedVersionId = newId as never;
      view.acceptance = { ...view.acceptance, acceptedVersionId: newId as never, acceptedAt: restored.acceptedAt, acceptedContentHash: restored.contentHash, acceptedSummary: restored.note };
      versions.push(restored);
      this.markDownstreamStale(snapshot, request.moduleId);
      this.bump(snapshot);
      return { commandId: request.commandId, duplicate: false, versionId: newId as never, moduleId: request.moduleId as never, artifactRevision: snapshot.task.revision };
    });
  }

  private markDownstreamStale(snapshot: TaskSnapshot, moduleId: string): void {
    for (const view of snapshot.modules) {
      if (view.module.dependencies.includes(moduleId as never) && view.module.status === 'accepted') {
        view.module.status = 'stale';
        view.acceptance.staleReason = '上游模块版本已更新，需要重新验证';
        view.acceptance.status = 'stale';
        for (const node of snapshot.spatial.nodes) {
          if (node.moduleId === view.module.id) node.status = 'stale';
        }
      }
    }
    const affected = snapshot.modules.filter((view) => view.module.dependencies.includes(moduleId as never)).map((view) => view.module.title);
    snapshot.spatial.stage = { ...snapshot.spatial.stage, note: affected.length > 0 ? `下游模块已标记过期：${affected.join('、')}` : snapshot.spatial.stage.note };
  }

  /* ------------------------------- providers ------------------------------- */

  async createProviderProfile(request: {
    commandId: string;
    profileName: string;
    adapterType: 'openai_compatible' | 'anthropic_native' | 'openai_responses';
    baseURL: string;
    model: string;
    credentialRef: string;
    enabled?: boolean;
    contextWindowOverride?: number | null;
  }) {
    return this.idempotent(request.commandId, () => {
      const profile: ProviderProfilePublic = {
        id: this.nextId() as never,
        profileName: request.profileName,
        adapterType: request.adapterType,
        baseURL: request.baseURL,
        model: request.model,
        enabled: request.enabled ?? true,
        timeouts: {},
        contextWindowOverride: request.contextWindowOverride ?? null,
        priceTable: null,
        capabilities: { streaming: 'unknown', toolCalling: 'unknown', structuredOutput: 'unknown', vision: 'unknown', usageReporting: 'unknown' },
        createdAt: this.now(),
        updatedAt: this.now(),
        credentialConfigured: true,
        credentialHint: `环境变量 ${request.credentialRef}`,
        credentialError: null,
      };
      this.state.profiles.push(profile);
      return { commandId: request.commandId, duplicate: false, profileId: profile.id, profile };
    });
  }

  async updateProviderProfile(id: string, request: { commandId: string; profileName?: string; baseURL?: string; model?: string; enabled?: boolean; credentialRef?: string }) {
    return this.idempotent(request.commandId, () => {
      const profile = this.state.profiles.find((candidate) => candidate.id === id);
      if (!profile) this.fail('not_found', '连接配置不存在', 404);
      if (request.profileName) profile.profileName = request.profileName;
      if (request.baseURL) profile.baseURL = request.baseURL;
      if (request.model) profile.model = request.model;
      if (request.enabled != null) profile.enabled = request.enabled;
      profile.updatedAt = this.now();
      return { commandId: request.commandId, duplicate: false, profileId: profile.id, profile };
    });
  }

  async testProviderProfile(id: string, request: { commandId: string; probes: Array<'auth_and_text' | 'streaming' | 'tool_calling' | 'structured_output' | 'usage'>; confirmCharges: boolean }) {
    return this.idempotent(request.commandId, () => {
      const profile = this.state.profiles.find((candidate) => candidate.id === id);
      if (!profile) this.fail('not_found', '连接配置不存在', 404);
      if (!request.confirmCharges) this.fail('bad_request', '能力测试可能产生少量费用，需要明确确认', 400);
      const probes: CapabilityProbe[] = request.probes.map((probe) => ({
        capability: probe,
        status:
          probe === 'auth_and_text'
            ? ('verified' as const)
            : probe === 'streaming' || probe === 'tool_calling'
              ? profile.adapterType === 'openai_compatible'
                ? ('verified' as const)
                : ('unknown' as const)
              : ('unknown' as const),
        detail: '本地夹具结果：非真实网络测试。',
        latencyMs: probe === 'auth_and_text' ? 42 : null,
        testedModel: profile.model,
        testedAt: this.now(),
        error: null,
      }));
      const report: CapabilityReport = {
        profileId: profile.id,
        serviceLabel: '本地夹具（非真实服务）',
        testedModel: profile.model,
        probes,
        capabilities: {
          streaming: probes.find((probe) => probe.capability === 'streaming')?.status === 'verified' ? 'verified' : 'unknown',
          toolCalling: probes.find((probe) => probe.capability === 'tool_calling')?.status === 'verified' ? 'verified' : 'unknown',
          structuredOutput: 'unknown',
          vision: 'unknown',
          usageReporting: 'unknown',
        },
        requestCount: probes.length,
        estimatedCostUsd: null,
        startedAt: this.now(),
        finishedAt: this.now(),
      };
      profile.capabilities = report.capabilities;
      return { commandId: request.commandId, duplicate: false, report };
    });
  }

  /* -------------------------------- recipes -------------------------------- */

  async proposeRecipe(request: { commandId: string; runId: string; name: string; description: string; kind: 'deterministic' | 'llm_assisted' | 'cached_snapshot'; applicability: string }) {
    return this.idempotent(request.commandId, () => {
      const fixtureProposal = this.state.recipeProposals.get(request.runId);
      if (!fixtureProposal) this.fail('not_found', '该运行没有可提取的配方步骤', 404);
      const proposal: RecipeProposalInput = {
        ...fixtureProposal,
        name: request.name,
        description: request.description,
        kind: request.kind,
        applicability: request.applicability,
      };
      return { commandId: request.commandId, duplicate: false, proposal, sourceRunId: request.runId as never, traceStepCount: proposal.steps.length };
    });
  }

  async createRecipe(request: { commandId: string; proposal: RecipeProposalInput }) {
    return this.idempotent(request.commandId, () => {
      const recipeId = this.nextId();
      const recipe: Recipe = {
        id: recipeId as never,
        version: 1,
        name: request.proposal.name,
        description: request.proposal.description,
        kind: request.proposal.kind,
        status: 'candidate',
        dslVersion: '1',
        inputParameters: request.proposal.inputParameters,
        steps: request.proposal.steps,
        outputArtifactKind: 'csv',
        validators: [{ id: 'deterministic', description: '确定性校验', supported: true }],
        permissions: { tools: ['source.read', 'data.transform', 'artifact.propose_patch'], scopes: ['sources:read', 'data:transform'], allowModelCalls: request.proposal.kind === 'deterministic' ? false : true, maxModelCallsPerRun: request.proposal.kind === 'deterministic' ? 0 : 4 },
        budget: { maxModelCalls: request.proposal.kind === 'deterministic' ? 0 : 4, maxToolCalls: 20, maxRuntimeMs: 60_000 },
        testCases: request.proposal.testCases,
        fingerprint: fixtureHash(`fixture-recipe-${recipeId}`),
        fingerprintInputs: { dslVersion: '1', stepFingerprint: fixtureHash('fixture-steps'), toolVersions: {}, promptHashes: {}, validatorVersion: 'fixture-validator', parserVersion: 'fixture' },
        sourceRunId: '00000000-0000-4000-8000-000000000033' as never,
        sourceTaskId: this.current().task.id,
        sourceModuleId: null,
        applicability: request.proposal.applicability,
        staleReason: null,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.state.recipes.set(recipeId, recipe);
      this.current().recipes.unshift({ recipeId: recipeId as never, name: recipe.name, kind: recipe.kind, status: recipe.status, version: recipe.version, fingerprint: recipe.fingerprint });
      this.bump(this.current());
      return { commandId: request.commandId, duplicate: false, recipeId: recipeId as never, version: 1, status: 'candidate' as const, recipe };
    });
  }

  async listRecipes(_taskId: string) {
    return { recipes: [...this.state.recipes.values()] };
  }

  async getRecipe(recipeId: string) {
    const recipe = this.state.recipes.get(recipeId);
    if (!recipe) this.fail('not_found', '配方不存在', 404);
    return { recipe };
  }

  async validateRecipe(recipeId: string, request: { commandId: string; testInputs: Array<{ testCaseId: string; inputs: Record<string, unknown> }> }) {
    return this.idempotent(request.commandId, () => {
      const recipe = this.state.recipes.get(recipeId);
      if (!recipe) this.fail('not_found', '配方不存在', 404);
      const testCases = recipe.testCases.map((testCase) => {
        const provided = request.testInputs.find((input) => input.testCaseId === testCase.id);
        if (!provided) return { ...testCase, status: 'untested' as const };
        const passed = testCase.expectation === 'accept' ? Object.keys(provided.inputs).length > 0 : true;
        return {
          ...testCase,
          status: passed ? ('passed' as const) : ('failed' as const),
          detail: passed ? '夹具测试通过（非真实执行）。' : '夹具测试失败：输入不满足预期。',
          lastRunAt: this.now(),
        };
      });
      const allPassed = testCases.filter((testCase) => testCase.status === 'passed').length >= 2 && testCases.some((testCase) => testCase.kind === 'invalid');
      recipe.testCases = testCases;
      recipe.status = allPassed ? 'validated' : 'candidate';
      recipe.updatedAt = this.now();
      this.state.recipes.set(recipeId, recipe);
      const summary = this.current().recipes.find((item) => item.recipeId === recipeId);
      if (summary) summary.status = recipe.status;
      this.bump(this.current());
      return { commandId: request.commandId, duplicate: false, recipeId: recipeId as never, version: recipe.version, status: recipe.status, testCases };
    });
  }

  async runRecipe(recipeId: string, request: { commandId: string; inputs: Record<string, unknown>; expectedRevision?: number }) {
    return this.idempotent(request.commandId, () => {
      const recipe = this.state.recipes.get(recipeId);
      if (!recipe) this.fail('not_found', '配方不存在', 404);
      if (!canRunRecipe(recipe.status)) this.fail('state_not_allowed', '只有已验证的配方可以直接运行；请先完成测试。', 409);
      const missing = recipe.inputParameters.filter((parameter) => parameter.required && !(parameter.name in request.inputs));
      if (missing.length > 0) this.fail('validation_failed', `缺少必需输入：${missing.map((parameter) => parameter.name).join('、')}`, 422);
      const runId = this.nextId();
      const llmCalls = recipe.kind === 'deterministic' ? 0 : 1;
      this.current().runs.unshift({
        runId: runId as never,
        moduleId: (recipe.sourceModuleId ?? this.current().modules[0]!.module.id) as never,
        state: 'COMPLETED',
        origin: 'recipe',
        attempt: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
        activeStepTitle: null,
        errorSummary: null,
      });
      this.bump(this.current());
      return {
        commandId: request.commandId,
        duplicate: false,
        recipeId: recipeId as never,
        runId: runId as never,
        cacheState: 'executed' as const,
        result: {
          recipeId: recipeId as never,
          recipeVersion: recipe.version,
          runId: runId as never,
          cacheState: 'executed' as const,
          outputs: [{ name: 'cleaned.csv', moduleKind: 'csv' as const, objectHash: fixtureHash(`fixture-recipe-output-${runId}`) as never, preview: 'system_id,name\nS-1001,订单中心', rowCount: 1 }],
          normalizedOutputHash: fixtureHash(`fixture-normalized-${runId}`) as never,
          llmCalls,
          toolCalls: 2,
          durationMs: 12,
          startedAt: this.now(),
          finishedAt: this.now(),
        },
      };
    });
  }

  async disableRecipe(recipeId: string, request: { commandId: string; reason?: string }) {
    return this.idempotent(request.commandId, () => {
      const recipe = this.state.recipes.get(recipeId);
      if (!recipe) this.fail('not_found', '配方不存在', 404);
      recipe.status = 'disabled';
      recipe.updatedAt = this.now();
      const summary = this.current().recipes.find((item) => item.recipeId === recipeId);
      if (summary) summary.status = 'disabled';
      this.bump(this.current());
      return { recipe };
    });
  }

  /* --------------------------- transfer / demo --------------------------- */

  async exportTask(taskId: string, request: { commandId: string; format: 'markdown' | 'json' | 'csv' | 'task_package'; moduleIds?: string[]; includeSources?: boolean }) {
    return this.idempotent(request.commandId, () => {
      const snapshot = this.state.snapshots.get(taskId);
      if (!snapshot) this.fail('not_found', '任务不存在', 404);
      const selected = snapshot.modules.filter(
        (view) => (!request.moduleIds || request.moduleIds.length === 0 || request.moduleIds.includes(view.module.id)) && view.acceptedContent != null,
      );
      let fileName = `${snapshot.task.title.slice(0, 40)}.${request.format === 'task_package' ? 'zip.json' : request.format}`;
      let mime = 'text/plain';
      let text = '';
      if (request.format === 'markdown') {
        text = selected.map((view) => `# ${view.module.title}\n\n${markdownFromContent(view.acceptedContent as ModuleContent)}`).join('\n\n---\n\n');
        mime = 'text/markdown';
      } else if (request.format === 'json' || request.format === 'task_package') {
        text = JSON.stringify(
          {
            schemaVersion: '1',
            fixture: true,
            task: { taskId: snapshot.task.id, title: snapshot.task.title, intent: snapshot.task.intent },
            modules: selected.map((view) => ({ moduleId: view.module.id, title: view.module.title, kind: view.module.kind, content: view.acceptedContent })),
            sources: request.includeSources ? snapshot.sources : [],
          },
          null,
          2,
        );
        mime = 'application/json';
      } else {
        const csvView = selected.find((view) => view.module.kind === 'csv');
        text = csvView ? csvFromContent(csvView.acceptedContent as ModuleContent) : '';
        mime = 'text/csv';
      }
      const bytes = new TextEncoder().encode(text);
      const contentBase64 = bytesToBase64(bytes);
      const sha256 = fixtureHash(text);
      return {
        commandId: request.commandId,
        fileName,
        mime,
        contentBase64,
        sha256,
        bytes: bytes.byteLength,
        redacted: !request.includeSources,
        warnings: selected.length === 0 ? ['没有已接受内容可导出；请先接受候选成果。'] : ['本地夹具导出：非真实成果文件。'],
      };
    });
  }

  async importTask(request: { commandId: string; fileName: string; contentBase64: string }) {
    return this.idempotent(request.commandId, () => {
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(request.contentBase64);
      } catch {
        this.fail('import_invalid', '任务包内容不是合法 base64', 422);
      }
      if (bytes.byteLength > 128 * 1024 * 1024) this.fail('payload_too_large', '任务包不能超过 128 MiB', 413);
      const empty = TaskSnapshotSchema.parse(loadFixtureBundle('empty').snapshot);
      const taskId = this.nextId();
      const artifactId = this.nextId();
      const snapshot: TaskSnapshot = {
        ...empty,
        task: { ...empty.task, id: taskId as never, artifactId: artifactId as never, title: `导入任务：${request.fileName.slice(0, 80)}` },
        artifact: { ...empty.artifact, id: artifactId as never, taskId: taskId as never, title: `导入成果：${request.fileName.slice(0, 80)}` },
      };
      this.state.snapshots.set(taskId, snapshot);
      return {
        commandId: request.commandId,
        duplicate: false,
        taskId,
        warnings: ['本地夹具导入：资料需要重新绑定（sourcesNeedRebinding）。'],
        sourcesNeedRebinding: true,
      };
    });
  }

  async demoReset(request: { commandId: string }) {
    return this.idempotent(request.commandId, () => {
      const taskId = this.loadScenario('review');
      return { commandId: request.commandId, taskId, template: this.demoTemplate() };
    });
  }

  async getDemoScenario() {
    return this.demoTemplate();
  }

  private demoTemplate(): DemoTemplate {
    return {
      templateId: 'cognitive-atrium',
      name: '次世代智能工作空间产品架构与 GTM 策略中枢',
      description: '内置四模块场景（合成演示数据）：架构拓扑、交互规范、存量系统清洗、商业化价值矩阵。',
      modules: [
        { key: 'core-architecture', title: '核心架构拓扑', kind: 'json', status: 'accepted' },
        { key: 'interaction-spec', title: '多模态交互引擎规范', kind: 'markdown', status: 'ready_for_review' },
        { key: 'legacy-cleanup', title: '存量系统兼容层清洗', kind: 'csv', status: 'ready_for_review' },
        { key: 'value-matrix', title: '商业化价值壁垒矩阵', kind: 'csv', status: 'blocked' },
      ],
      seedSourceNames: ['product-brief.md', 'constraints.json', 'legacy-systems.csv', 'stakeholder-notes.md'],
      fixtureVersion: 'fixture-1',
    };
  }
}

function markdownFromContent(content: ModuleContent): string {
  if (content.kind === 'markdown') return content.sections.map((section) => `## ${section.title}\n\n${section.markdown}`).join('\n\n');
  if (content.kind === 'json') return `\`\`\`json\n${JSON.stringify(content.value, null, 2)}\n\`\`\``;
  return content.rows.map((row) => content.columns.map((column) => String(row[column.key] ?? '')).join(',')).join('\n');
}

function csvFromContent(content: ModuleContent): string {
  if (content.kind !== 'csv') return '';
  const header = content.columns.map((column) => column.label).join(',');
  const rows = content.rows.map((row) => content.columns.map((column) => String(row[column.key] ?? '')).join(','));
  return [header, ...rows].join('\n');
}

/** Create the fixture client from a URL search string (`?fixture=1&scenario=review`). */
export function createFixtureClientFromLocation(search: string): FixtureApiClient {
  const params = new URLSearchParams(search);
  const scenario = params.get('scenario');
  const valid: FixtureScenario[] = ['review', 'blocked', 'empty', 'completed'];
  return new FixtureApiClient({ scenario: scenario && (valid as string[]).includes(scenario) ? (scenario as FixtureScenario) : 'review' });
}

/**
 * Typed facade for the fixture backend. The concrete class intentionally keeps
 * loosely-typed command inputs (they are validated by the real contracts in the
 * HTTP client); this single cast keeps the UI-facing surface identical.
 */
export function createFixtureClient(options: FixtureApiClientOptions = {}): ApiClient {
  return new FixtureApiClient(options) as unknown as ApiClient;
}

/** Re-exported for tests that need to inspect the raw fixture bundle. */
export { buildFixtureBundle, fixtureHash, fixtureUuid, IDS };
export type { FixtureScenario };
export { randomUuid };
