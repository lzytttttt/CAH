import {
  budgetSummaryLabel,
  CANCELLABLE_RUN_STATES as _cancelStates,
  PAUSABLE_RUN_STATES,
  summarizeModuleContent,
  utcNow,
  type Blocker,
  type HarnessEvent,
  type ModuleView,
  type PatchProposal,
  type Plan,
  type ProspectProjection,
  type Run,
  type RunState,
  type SpatialEdge,
  type SpatialNode,
  type SpatialProjection,
  type StageSummary,
  type TaskSnapshot,
  type ValidationReport,
  type ValidationSummary,
  type Workspace,
  type ModuleAcceptanceSummary,
  type EvidenceSummary,
  type TaskRunSummary,
  PLAN_REVIEW_PHASES,
} from '@ca/contracts';
import { TaskSnapshotSchema } from '@ca/contracts';
import type { StoragePort } from '@ca/storage';
import type { ProviderGateway } from '@ca/harness';

const PHASE_BY_STATE: Record<string, (typeof PLAN_REVIEW_PHASES)[number]> = {
  CREATED: 'planning',
  PLANNING: 'planning',
  AWAITING_INPUT: 'resolving',
  READY: 'ready',
  RUNNING: 'executing',
  PAUSING: 'executing',
  PAUSED: 'executing',
  VALIDATING: 'executing',
  AWAITING_REVIEW: 'review',
  COMMITTING: 'executing',
  COMPLETED: 'review',
  CANCELLING: 'executing',
  CANCELLED: 'failed',
  FAILED: 'failed',
  INTERRUPTED: 'failed',
};

const PHASE_LABELS: Record<string, string> = {
  idle: '空闲',
  planning: '规划中',
  peeking: '计划预览',
  resolving: '等待补充输入',
  ready: '计划就绪',
  executing: '执行中',
  review: '待审阅',
  failed: '需要处理',
};

export interface ProjectionDeps {
  storage: StoragePort;
  providers: ProviderGateway;
  mode: 'demo' | 'live';
  schedulerActiveCount: () => number;
  queuePosition?: (runId: string) => number | null;
}

interface ProjectionInput {
  taskId: string;
  afterSeq: number;
  includeEvents: boolean;
}

/**
 * Build the complete backend projection for one task. Every field comes from
 * persisted state or persisted events; no UI-supplied or timer-derived state is
 * trusted. The result is validated against TaskSnapshotSchema before returning.
 */
export async function projectTaskSnapshot(deps: ProjectionDeps, input: ProjectionInput): Promise<TaskSnapshot | null> {
  const aggregate = await deps.storage.getTaskAggregate(input.taskId as never);
  if (!aggregate) return null;
  const workspace = await deps.storage.getWorkspace();
  const { task, artifact, modules } = aggregate;

  const allEvents = await deps.storage.eventsAfter(task.id, 0, 20_000);
  const runs = await deps.storage.listRuns(task.id);
  const blockers = await deps.storage.listBlockers(task.id);
  const patches = await deps.storage.listPatches(task.id);
  const validations = await deps.storage.listValidationReports(task.id);
  const sources = await deps.storage.listSources(task.id);
  const spans = await deps.storage.listSpans(task.id, 100);
  const recipes = await deps.storage.listRecipes(task.id);
  const decisions = await deps.storage.listDecisions(task.id);

  const activeRun = pickActiveRun(runs);
  const activeSteps = activeRun ? await deps.storage.listSteps(activeRun.id) : [];
  const latestPlan = findLatestPlan(allEvents, activeRun?.id ?? runs[0]?.id ?? null);
  const pendingPatches = patches.filter((p) => p.status === 'proposed');
  const openBlockers = blockers.filter((b) => b.status === 'open');

  const moduleViews: ModuleView[] = [];
  for (const module of modules.sort((a, b) => a.order - b.order)) {
    const acceptedVersion = module.acceptedVersionId ? await deps.storage.getVersion(module.acceptedVersionId) : null;
    const modulePatch = pendingPatches
      .filter((p) => p.moduleId === module.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    const moduleValidation = latestValidationFor(validations, module.id);
    const staleEvent = [...allEvents]
      .reverse()
      .find((e) => e.type === 'artifact.stale' && (e.payload as { moduleId?: string }).moduleId === module.id);
    const acceptance: ModuleAcceptanceSummary = {
      moduleId: module.id,
      status: module.status,
      acceptedVersionId: module.acceptedVersionId,
      acceptedAt: acceptedVersion?.acceptedAt ?? null,
      acceptedSummary: acceptedVersion ? summarizeModuleContent(acceptedVersion.content) : null,
      acceptedContentHash: acceptedVersion?.contentHash ?? null,
      pendingPatchId: modulePatch?.id ?? null,
      pendingValidationReportId: modulePatch?.validationReportId ?? null,
      pendingValidationStatus: moduleValidation?.status ?? null,
      staleReason: staleEvent ? (staleEvent.payload as { reason: string }).reason : null,
      openBlockerIds: openBlockers.filter((b) => b.affectedModuleIds.includes(module.id)).map((b) => b.id),
    };
    moduleViews.push({
      module,
      acceptance,
      acceptedContent: acceptedVersion?.content ?? null,
      acceptedVersion,
      pendingCandidateSummary: modulePatch ? summarizeProposal(modulePatch) : null,
    });
  }

  const runSummaries: TaskRunSummary[] = runs
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((run) => {
      const runBlocker = openBlockers.find((b) => b.runId === run.id);
      return {
        runId: run.id,
        moduleId: run.moduleId,
        state: run.state,
        origin: run.origin,
        attempt: run.attempt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        activeStepTitle: activeRun && activeRun.id === run.id ? activeSteps.find((s) => s.status === 'running')?.title ?? null : null,
        errorSummary: run.error?.message ?? runBlocker?.title ?? null,
      };
    });

  const validationSummaries: ValidationSummary[] = [];
  for (const module of modules) {
    const report = latestValidationFor(validations, module.id);
    if (!report) continue;
    const counts = { pass: 0, fail: 0, needsReview: 0, notApplicable: 0 };
    for (const check of report.checks) {
      if (check.status === 'pass') counts.pass += 1;
      else if (check.status === 'fail') counts.fail += 1;
      else if (check.status === 'needs_review') counts.needsReview += 1;
      else counts.notApplicable += 1;
    }
    validationSummaries.push({
      validationReportId: report.id,
      moduleId: module.id,
      status: report.status,
      checkCounts: counts,
      blockingFindings: report.checks
        .filter((c) => c.layer !== 'L4' && (c.status === 'fail' || c.status === 'needs_review'))
        .slice(0, 5)
        .map((c) => `[${c.layer}] ${c.title}: ${c.detail}`),
      createdAt: report.createdAt,
    });
  }

  const spanCountBySource = new Map<string, number>();
  for (const span of spans) spanCountBySource.set(span.sourceId, (spanCountBySource.get(span.sourceId) ?? 0) + 1);
  const evidence: EvidenceSummary[] = sources
    .filter((s) => s.version === Math.max(...sources.filter((x) => x.id === s.id).map((x) => x.version), s.version))
    .map((source) => ({
      sourceId: source.id,
      name: source.name,
      version: source.version,
      availability: source.availability,
      spanCount: spanCountBySource.get(source.id) ?? 0,
      trustLevel: source.trustLevel,
      previewSpanIds: spans.filter((s) => s.sourceId === source.id).slice(0, 5).map((s) => s.id),
    }));

  const prospects = buildProspects(modules, moduleViews, activeRun, allEvents);
  const spatial = buildSpatial({
    artifactTitle: artifact.title,
    artifactAcceptedVersionId: artifact.acceptedVersionId,
    modules,
    moduleViews,
    activeRun,
    activeSteps,
    openBlockers,
    pendingPatches,
    sources,
    prospects,
    runs,
  });
  const queuePosition = activeRun ? deps.queuePosition?.(activeRun.id) ?? activeRun.queuePosition ?? null : null;
  const control = await buildControl(deps, workspace, activeRun, queuePosition, modules, decisions.length);

  const tailEvents = allEvents.filter((e) => e.seq > input.afterSeq).slice(-500);
  const snapshot: TaskSnapshot = {
    snapshotSeq: allEvents.reduce((max, e) => Math.max(max, e.seq), 0),
    serverTime: utcNow(),
    workspace: {
      workspaceId: workspace.id,
      mode: workspace.mode,
      name: workspace.name,
      settings: workspace.settings,
      policyVersion: workspace.policyVersion,
    },
    task,
    artifact,
    modules: moduleViews,
    plan: activeRun ? latestPlan : latestPlan,
    runs: runSummaries,
    activeRun: activeRun
      ? {
          runId: activeRun.id,
          moduleId: activeRun.moduleId,
          state: activeRun.state,
          revision: activeRun.revision,
          attempt: activeRun.attempt,
          planVersion: activeRun.planVersion,
          contextSnapshotId: activeRun.contextSnapshotId,
          budgetUsage: activeRun.budgetUsage,
          error: activeRun.error,
          interrupted: activeRun.interrupted,
        }
      : null,
    blockers: openBlockers,
    patches: pendingPatches.map((p) => ({
      patchId: p.id,
      moduleId: p.moduleId,
      status: p.status,
      validationStatus: latestValidationFor(validations, p.moduleId)?.status ?? null,
      createdAt: p.createdAt,
    })),
    validations: validationSummaries,
    sources: evidence,
    spans: spans.slice(0, 100),
    prospects,
    recipes: recipes.map((r) => ({
      recipeId: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      version: r.version,
      fingerprint: r.fingerprint,
    })),
    spatial,
    control,
    usage: activeRun?.budgetUsage ?? null,
    events: input.includeEvents ? tailEvents : [],
    limits: { maxSpatialBranches: 3, maxSpatialNodes: 12, maxSpatialEdges: 16 },
  };
  return TaskSnapshotSchema.parse(snapshot) as TaskSnapshot;
}

function pickActiveRun(runs: Run[]): Run | null {
  const active = runs
    .filter((r) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(r.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return active[0] ?? null;
}

function findLatestPlan(events: HarnessEvent[], runId: string | null): Plan | null {
  let latest: Plan | null = null;
  for (const event of events) {
    if (runId && event.runId !== runId) continue;
    if (event.type === 'plan.proposed' || event.type === 'plan.revised') {
      const plan = (event.payload as { plan?: Plan }).plan;
      if (plan) latest = plan;
    }
  }
  return latest;
}

function latestValidationFor(validations: ValidationReport[], moduleId: string): ValidationReport | null {
  return (
    validations
      .filter((v) => v.moduleId === moduleId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

function summarizeProposal(patch: PatchProposal): string {
  const summary = patch.changeSummary;
  const parts: string[] = [];
  if (summary.addedSections.length) parts.push(`新增 ${summary.addedSections.length} 节`);
  if (summary.changedSections.length) parts.push(`修改 ${summary.changedSections.length} 节`);
  if (summary.removedSections.length) parts.push(`删除 ${summary.removedSections.length} 节`);
  if (summary.affectedRows) parts.push(`${summary.affectedRows} 行数据`);
  return `${patch.description}${parts.length ? `（${parts.join('，')}）` : ''}`;
}

function buildProspects(
  modules: Array<{ id: string; title: string; dependencies: readonly string[]; status: string; acceptedVersionId: string | null }>,
  moduleViews: ModuleView[],
  activeRun: Run | null,
  events: HarnessEvent[],
): ProspectProjection[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const accepted = new Map<string, boolean>(
    moduleViews.map((v) => [v.module.id as string, v.acceptance.acceptedVersionId != null]),
  );
  const staleSet = new Set(
    events
      .filter((e) => e.type === 'artifact.stale')
      .map((e) => (e.payload as { moduleId?: string }).moduleId ?? ''),
  );
  const prospects: ProspectProjection[] = [];
  for (const module of modules) {
    if (module.dependencies.length === 0) continue;
    const requiredInputs = module.dependencies.map((depId) => {
      const dep = byId.get(depId);
      return {
        moduleId: depId as never,
        label: dep?.title ?? depId,
        satisfied: accepted.get(depId) === true,
        moduleStatus: (dep?.status ?? 'empty') as never,
      };
    });
    const missing = requiredInputs.filter((input) => !input.satisfied).map((input) => input.label);
    let state: ProspectProjection['state'] = 'missing_inputs';
    if (module.acceptedVersionId) state = 'accepted';
    else if (staleSet.has(module.id)) state = 'stale';
    else if (module.dependencies.length > 0 && missing.length === 0) state = 'ready';
    if (state === 'ready' && activeRun && activeRun.moduleId === module.id) {
      state = activeRun.state === 'AWAITING_REVIEW' ? 'review' : 'generating';
    }
    prospects.push({
      id: `prospect-${module.id}`,
      title: `${module.title}（综合成果）`,
      state,
      valueStatement: `基于已接受的 ${module.dependencies.length} 项上游成果生成；依赖满足只代表允许生成，仍需生成、验证与接受。`,
      requiredInputs,
      missingInputs: missing,
      note: '合成预览不会展示未生成的正文；实际内容来自真实 Run。',
      candidateUnverified: false,
      targetModuleId: module.id as never,
      sourceModuleId: module.dependencies[0] as never,
    });
  }
  return prospects.slice(0, 8);
}

interface SpatialInput {
  artifactTitle: string;
  artifactAcceptedVersionId: string | null;
  modules: Array<{ id: string; title: string; status: string; dependencies: readonly string[]; order: number; acceptedVersionId: string | null }>;
  moduleViews: ModuleView[];
  activeRun: Run | null;
  activeSteps: Array<{ id: string; title: string; status: string; kind: string }>;
  openBlockers: Blocker[];
  pendingPatches: PatchProposal[];
  sources: Array<{ id: string; name: string; version: number }>;
  prospects: ProspectProjection[];
  runs: Run[];
}

function buildSpatial(input: SpatialInput): SpatialProjection {
  const nodes: SpatialNode[] = [];
  const edges: SpatialEdge[] = [];
  const addNode = (node: SpatialNode): void => {
    nodes.push(node);
  };
  const addEdge = (edge: SpatialEdge): void => {
    edges.push(edge);
  };

  const activeModuleId = input.activeRun?.moduleId ?? null;
  addNode({
    id: 'hub',
    kind: 'hub',
    layer: 'execution',
    title: input.artifactTitle,
    status: input.artifactAcceptedVersionId ? 'accepted' : 'idle',
    summary: input.artifactAcceptedVersionId ? '已接受成果版本存在' : '尚无已接受成果',
    moduleId: null,
    runId: input.activeRun?.id ?? null,
    stepId: null,
    refId: input.artifactAcceptedVersionId,
    badgeCount: null,
    laneHint: 0,
  });

  for (const module of input.modules) {
    addNode({
      id: `module:${module.id}`,
      kind: 'module',
      layer: 'execution',
      title: module.title,
      status: module.status as SpatialNode['status'],
      summary: module.acceptedVersionId ? '已接受版本' : '尚无已接受版本',
      moduleId: module.id as never,
      runId: null,
      stepId: null,
      refId: module.acceptedVersionId,
      badgeCount: null,
      laneHint: module.order,
    });
  }

  const activeStep = input.activeRun ? input.activeSteps.find((s) => s.status === 'running') ?? input.activeSteps.at(-1) : null;
  if (input.activeRun) {
    addNode({
      id: `run:${input.activeRun.id}`,
      kind: 'run',
      layer: 'execution',
      title: `运行 ${input.activeRun.attempt}`,
      status: input.activeRun.state === 'AWAITING_REVIEW' ? 'ready_for_review' : input.activeRun.state === 'RUNNING' ? 'running' : 'warning',
      summary: input.activeRun.state,
      moduleId: input.activeRun.moduleId as never,
      runId: input.activeRun.id as never,
      stepId: null,
      refId: input.activeRun.id,
      badgeCount: input.activeSteps.length,
      laneHint: 0,
    });
    if (activeStep) {
      addNode({
        id: `step:${activeStep.id}`,
        kind: 'step',
        layer: 'execution',
        title: activeStep.title,
        status: activeStep.status === 'running' ? 'running' : activeStep.status === 'failed' ? 'failed' : 'completed',
        summary: activeStep.kind,
        moduleId: input.activeRun.moduleId as never,
        runId: input.activeRun.id as never,
        stepId: activeStep.id as never,
        refId: activeStep.id,
        badgeCount: null,
        laneHint: 1,
      });
      addEdge({ id: `flow-step-${activeStep.id}`, from: `run:${input.activeRun.id}`, to: `step:${activeStep.id}`, kind: 'flow', label: '' });
      addEdge({
        id: `dependency-step-${activeStep.id}`,
        from: `step:${activeStep.id}`,
        to: `module:${input.activeRun.moduleId}`,
        kind: 'flow',
        label: '回收',
      });
    }
  }

  for (const blocker of input.openBlockers.slice(0, 3)) {
    const target = blocker.affectedSteps[0] ?? activeStep?.id ?? null;
    addNode({
      id: `blocker:${blocker.id}`,
      kind: 'blocker',
      layer: 'execution',
      title: blocker.title,
      status: 'blocked',
      summary: blocker.type,
      moduleId: blocker.affectedModuleIds[0] ?? null,
      runId: blocker.runId as never,
      stepId: target as never,
      refId: blocker.id,
      badgeCount: blocker.resolutions.length,
      laneHint: 2,
    });
    if (target) {
      addEdge({ id: `trace-blocker-${blocker.id}`, from: `step:${target}`, to: `blocker:${blocker.id}`, kind: 'trace', label: '等待输入' });
    }
  }

  for (const patch of input.pendingPatches.slice(0, 2)) {
    addNode({
      id: `patch:${patch.id}`,
      kind: 'patch',
      layer: 'execution',
      title: '待审阅变更',
      status: 'ready_for_review',
      summary: summarizeProposal(patch),
      moduleId: patch.moduleId,
      runId: patch.runId,
      stepId: null,
      refId: patch.id,
      badgeCount: patch.evidenceRefs.length,
      laneHint: 3,
    });
    addEdge({ id: `flow-patch-${patch.id}`, from: `patch:${patch.id}`, to: `module:${patch.moduleId}`, kind: 'flow', label: '候选变更' });
    for (const evidence of patch.evidenceRefs.slice(0, 2)) {
      if (evidence.kind !== 'source_span') continue;
      const sourceNodeId = `source:${evidence.span.sourceId}`;
      if (!nodes.some((n) => n.id === sourceNodeId)) {
        const source = input.sources.find((s) => s.id === evidence.span.sourceId);
        addNode({
          id: sourceNodeId,
          kind: 'source',
          layer: 'evidence',
          title: source?.name ?? '资料',
          status: 'idle',
          summary: `v${evidence.span.version}`,
          moduleId: null,
          runId: null,
          stepId: null,
          refId: evidence.span.sourceId,
          badgeCount: null,
          laneHint: 0,
        });
      }
      addEdge({ id: `evidence-patch-${patch.id}-${evidence.span.spanId}`, from: sourceNodeId, to: `patch:${patch.id}`, kind: 'evidence', label: '证据' });
    }
  }

  for (const prospect of input.prospects.slice(0, 2)) {
    addNode({
      id: `prospect:${prospect.id}`,
      kind: 'prospect',
      layer: 'prospect',
      title: prospect.title,
      status: prospect.state as SpatialNode['status'],
      summary: prospect.missingInputs.length ? `缺少：${prospect.missingInputs.join('、')}` : '依赖已满足',
      moduleId: prospect.targetModuleId,
      runId: null,
      stepId: null,
      refId: prospect.id,
      badgeCount: prospect.requiredInputs.length,
      laneHint: 0,
    });
    for (const req of prospect.requiredInputs) {
      addEdge({ id: `binding-${prospect.id}-${req.moduleId}`, from: `module:${req.moduleId}`, to: `prospect:${prospect.id}`, kind: 'binding', label: req.satisfied ? '已满足' : '缺少' });
    }
  }

  // Module dependency edges (raw dependency graph is separate from coordinates).
  for (const module of input.modules) {
    for (const dep of module.dependencies) {
      addEdge({ id: `dependency-${dep}-${module.id}`, from: `module:${dep}`, to: `module:${module.id}`, kind: 'dependency', label: '依赖' });
    }
  }

  const maxNodes = 12; // excluding the hub
  const maxEdges = 16;
  const hub = nodes.filter((n) => n.kind === 'hub');
  const rest = nodes.filter((n) => n.kind !== 'hub');
  const ordered = [...rest].sort((a, b) => nodePriority(a) - nodePriority(b) || a.laneHint - b.laneHint);
  const kept = ordered.slice(0, maxNodes);
  const collapsed = ordered.slice(maxNodes);
  const keptIds = new Set(kept.map((n) => n.id));
  const keptEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)).slice(0, maxEdges);
  const byKind: Record<string, number> = {};
  for (const node of collapsed) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  const activeRuns = input.runs.filter((r) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(r.state));
  return {
    nodes: [...hub, ...kept],
    edges: keptEdges,
    stage: buildStage(input.activeRun, input.activeSteps, input.openBlockers),
    counts: {
      branchCount: Math.min(activeRuns.length, 3),
      nodeCount: kept.length,
      edgeCount: keptEdges.length,
      collapsedNodes: collapsed.length,
      byKind,
    },
    activeBranchId: input.activeRun ? `run:${input.activeRun.id}` : null,
    focusHint: activeModuleId ? `当前目标模块：${input.modules.find((m) => m.id === activeModuleId)?.title ?? ''}` : '选择模块后开始',
  };
}

function nodePriority(node: SpatialNode): number {
  switch (node.kind) {
    case 'module':
      return 0;
    case 'run':
      return 1;
    case 'step':
      return 2;
    case 'blocker':
      return 3;
    case 'patch':
      return 4;
    case 'prospect':
      return 5;
    case 'source':
      return 6;
    default:
      return 9;
  }
}

function buildStage(
  activeRun: Run | null,
  steps: Array<{ title: string; status: string }>,
  blockers: Blocker[],
): StageSummary {
  if (!activeRun) {
    return {
      phase: 'idle',
      label: PHASE_LABELS.idle,
      completedSteps: null,
      totalSteps: null,
      activeStepTitle: null,
      note: '尚无执行中的运行',
    };
  }
  const completed = steps.filter((s) => s.status === 'completed').length;
  const total = steps.length;
  const activeStep = steps.find((s) => s.status === 'running')?.title ?? null;
  const phase = PHASE_BY_STATE[activeRun.state] ?? 'idle';
  const blocker = blockers.find((b) => b.runId === activeRun.id);
  return {
    phase,
    label: PHASE_LABELS[phase] ?? activeRun.state,
    completedSteps: total ? completed : null,
    totalSteps: total ? total : null,
    activeStepTitle: activeStep,
    note: blocker ? `等待处理：${blocker.title}` : activeRun.state === 'PAUSED' ? '已暂停，可从检查点继续' : '',
  };
}

async function buildControl(
  deps: ProjectionDeps,
  workspace: Workspace,
  activeRun: Run | null,
  queuePosition: number | null,
  modules: Array<{ id: string; acceptedVersionId: string | null }>,
  decisionCount: number,
) {
  const profiles = await deps.providers.listEnabledProfiles();
  const profile = profiles[0] ?? null;
  let connectionStatus: 'configured' | 'unconfigured' | 'error' | 'unknown' = 'unconfigured';
  let providerLabel = '未配置模型连接';
  if (profile) {
    providerLabel = `${profile.profileName} · ${profile.model}`;
    try {
      const status = await deps.providers.capabilities(profile.id);
      connectionStatus = status.streaming === 'verified' ? 'configured' : 'unknown';
    } catch {
      connectionStatus = 'error';
    }
  }
  const state = activeRun?.state ?? null;
  return {
    runId: activeRun?.id ?? null,
    state: state as RunState | null,
    canPause: state ? PAUSABLE_RUN_STATES.includes(state) : false,
    canResume: state ? state === 'PAUSED' || state === 'INTERRUPTED' : false,
    canCancel: state ? _cancelStates.includes(state) : false,
    budgetLabel: activeRun ? budgetSummaryLabel(activeRun.budgetPolicy, activeRun.budgetUsage) : '尚无运行',
    providerLabel,
    connectionStatus,
    queuePosition,
    unsavedDraft: decisionCount > 0 && !activeRun,
  };
}
