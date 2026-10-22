/**
 * Planning stage: deterministic analysis + (for reviewed planning) a versioned
 * planner model call with bounded structure repair.
 *
 * The kernel — not the model — decides whether a plan is executable:
 * PlanSchema, acyclic dependencies, tool allow-list, input refs and budget are
 * all validated here. Real hard-constraint conflicts block execution and require
 * an explicit user decision; they can never be "clicked away".
 */
import {
  EvidenceRefSchema,
  PlanSchema,
  PlanRiskSchema,
  TOOL_IDS,
  blockingRisks,
  findPlanCycle,
  findUnknownPlanDependencies,
  newBlockerId,
  type ArtifactModule,
  type ArtifactVersion,
  type Blocker,
  type BudgetPolicy,
  type Decision,
  type EvidenceRef,
  type InputRef,
  type Plan,
  type PlanRisk,
  type PlanStep,
  type PlanToolRequirement,
  type Run,
  type RunError,
  type SourceItem,
  type SourceSpan,
  type Task,
  type ToolId,
  type Workspace,
  type WorkspaceSettings,
} from '@ca/contracts';
import type { TaskAggregate } from '@ca/storage';
import { z } from 'zod';
import type { PlanCommand } from './types';
import type { RunControl, Runtime } from './runtime';
import {
  constraintConflictDecisionKey,
  detectConstraintConflicts,
  deterministicRisks,
  filterModelRisks,
  mergeRisks,
  resolvedConflictKeys,
  unresolvedBlockingRisks,
  type ConstraintConflict,
} from './risk-rules';
import { PLANNER_V1_HASH, renderPlannerInstruction, renderPlannerSystem, REPAIR_V1_HASH, renderRepairInstruction, renderRepairSystem } from './prompts';
import { CandidateParseError } from './errors';
import { estimateToolDefinitionTokens, planAllowsTool } from './runtime';
import { truncateChars } from './hashing';

/* ------------------------------ planner output ----------------------------- */

const PlannerStepDraftSchema = z.object({
  id: z.string().min(1).max(64).default('s1'),
  title: z.string().min(1).max(200),
  kind: z.enum(['tool', 'model', 'validate', 'compose']).default('model'),
  dependencies: z.array(z.string().min(1).max(64)).max(32).default([]),
  toolId: z.string().max(100).nullable().default(null),
  description: z.string().max(2000).default(''),
  expectedOutput: z.string().max(1000).default(''),
});

const PlannerToolDraftSchema = z.object({
  toolId: z.string().min(1).max(100),
  reason: z.string().max(1000).default(''),
  effect: z.enum(['read', 'draft_write', 'external_write']).default('read'),
});

export const PlannerOutputSchema = z.object({
  goal: z.string().max(4000).default(''),
  skeleton: z
    .array(
      z.object({
        moduleId: z.string().max(100).default(''),
        moduleKind: z.string().max(20).optional(),
        sections: z.array(z.string().min(1).max(200)).max(64).default([]),
        expectedContentSummary: z.string().max(1000).default(''),
      }),
    )
    .max(8)
    .default([]),
  steps: z.array(PlannerStepDraftSchema).max(32).default([]),
  tools: z.array(PlannerToolDraftSchema).max(16).default([]),
  assumptions: z
    .array(z.object({ id: z.string().max(64).default(''), text: z.string().max(2000), needsConfirmation: z.boolean().default(true) }))
    .max(32)
    .default([]),
  openQuestions: z
    .array(
      z.object({
        id: z.string().max(64).default(''),
        question: z.string().max(2000),
        blocking: z.boolean().default(false),
        reason: z.string().max(1000).default(''),
      }),
    )
    .max(32)
    .default([]),
  risks: z.array(z.record(z.string(), z.unknown())).max(32).default([]),
  rationale: z.string().max(4000).default(''),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/* --------------------------------- helpers -------------------------------- */

export function budgetSummary(policy: BudgetPolicy): string {
  return [
    `模型请求 ≤ ${policy.maxModelRequests}`,
    `工具调用 ≤ ${policy.maxToolCalls}`,
    `输出 token ≤ ${policy.maxOutputTokens}`,
    `单 Run 活动时长 ≤ ${Math.round(policy.maxRunDurationMs / 1000)}s`,
    '预算只能由用户显式提高，模型与内核都不得自行提高',
  ].join('；');
}

export function moduleSummary(module: ArtifactModule): string {
  const criteria = module.acceptanceCriteria.map((criterion) => `[${criterion.layer}] ${criterion.text}`);
  return [
    `moduleId=${module.id}`,
    `标题=${module.title}`,
    `类型=${module.kind}`,
    `依赖=${module.dependencies.length > 0 ? module.dependencies.join(', ') : '无'}`,
    criteria.length > 0 ? `验收标准：\n${criteria.map((line) => `- ${line}`).join('\n')}` : '验收标准：无',
  ].join('\n');
}

function toolCatalog(descriptors: ReadonlyMap<ToolId, import('@ca/contracts').ToolDescriptor>): string {
  return [...descriptors.values()]
    .filter((descriptor) => descriptor.modelFacing)
    .map((descriptor) => {
      const params = JSON.stringify(descriptor.parameters);
      return `- ${descriptor.id}（effect=${descriptor.policy.effect}，idempotency=${descriptor.policy.idempotency}）：${truncateChars(descriptor.description, 300)} 参数 Schema: ${truncateChars(params, 600)}`;
    })
    .join('\n');
}

function sanitizePlanStepIds(steps: PlannerOutput['steps']): PlannerOutput['steps'] {
  const seen = new Set<string>();
  return steps.map((step, index) => {
    let id = /^[A-Za-z][A-Za-z0-9_-]*$/.test(step.id) ? step.id : `s${index + 1}`;
    if (seen.has(id)) {
      let suffix = 2;
      while (seen.has(`${id}_${suffix}`)) suffix += 1;
      id = `${id}_${suffix}`;
    }
    seen.add(id);
    return { ...step, id };
  });
}

interface AssembleContext {
  runtime: Runtime;
  command: PlanCommand;
  task: Task;
  run: Run;
  module: ArtifactModule;
  baseVersion: ArtifactVersion | null;
  sources: SourceItem[];
  decisions: Decision[];
  spans: SourceSpan[];
  conflicts: ConstraintConflict[];
  descriptors: ReadonlyMap<ToolId, import('@ca/contracts').ToolDescriptor>;
  validEvidenceKeys: Set<string>;
  modelProfileId: string | null;
  planVersion: number;
  promptVersion: string;
  modelDroppedRiskNote: string | null;
}

export function evidenceRefKey(ref: EvidenceRef): string {
  try {
    return JSON.stringify(ref);
  } catch {
    return 'invalid';
  }
}

/** Resolve which model-provided evidence refs are real (spans/versions/tool calls). */
export async function resolveValidEvidenceRefs(
  runtime: Runtime,
  taskId: string,
  runId: string,
  refs: readonly unknown[],
): Promise<Set<string>> {
  const valid = new Set<string>();
  const spans = await runtime.loadSpans(taskId as never);
  const spanById = new Map(spans.map((span) => [span.id, span]));
  const invocations = await runtime.storage.listToolInvocations(runId);
  const toolCallIds = new Set(invocations.map((record) => record.toolCallId));
  const versionCache = new Map<string, ArtifactVersion | null>();
  const acceptedCache = new Map<string, ArtifactVersion | null>();
  for (const raw of refs) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success) continue;
    const ref = parsed.data;
    if (ref.kind === 'source_span') {
      const span = spanById.get(ref.span.spanId);
      if (span && span.sourceId === ref.span.sourceId && span.version === ref.span.version && span.quoteHash === ref.span.quoteHash) {
        valid.add(evidenceRefKey(ref));
      }
      continue;
    }
    if (ref.kind === 'artifact_version') {
      if (!versionCache.has(ref.versionId)) {
        versionCache.set(ref.versionId, await runtime.storage.getVersion(ref.versionId));
      }
      const version = versionCache.get(ref.versionId) ?? null;
      if (!version || version.moduleId !== ref.moduleId) continue;
      if (!acceptedCache.has(ref.moduleId)) {
        acceptedCache.set(ref.moduleId, await runtime.storage.getAcceptedVersion(ref.moduleId));
      }
      const accepted = acceptedCache.get(ref.moduleId) ?? null;
      if (accepted?.id === ref.versionId) valid.add(evidenceRefKey(ref));
      continue;
    }
    if (ref.kind === 'tool_result') {
      if (toolCallIds.has(ref.toolResult.toolCallId)) valid.add(evidenceRefKey(ref));
      continue;
    }
    // user_assumption is not evidence for a factual risk claim.
  }
  return valid;
}

/* ------------------------------ plan assembly ------------------------------ */

function assemblePlan(draft: PlannerOutput, context: AssembleContext): Plan {
  const modelKind = context.module.kind;
  const skeletonInput = draft.skeleton.filter((item) => item.moduleId === context.module.id || item.moduleId === '');
  const skeleton = (skeletonInput.length > 0 ? skeletonInput : [null]).map((item) => ({
    moduleId: context.module.id,
    moduleKind: modelKind,
    sections: item?.sections?.slice(0, 64) ?? [],
    expectedContentSummary: item?.expectedContentSummary ?? `为模块「${context.module.title}」生成候选成果`,
  }));

  const steps = sanitizePlanStepIds(draft.steps.length > 0 ? draft.steps : [
    { id: 's1', title: '生成候选成果', kind: 'model' as const, dependencies: [], toolId: null, description: context.command.intent, expectedOutput: '候选成果 JSON' },
  ]);
  const stepIds = new Set(steps.map((step) => step.id));
  const normalizedSteps: PlanStep[] = steps.map((step) => ({
    id: step.id,
    title: truncateChars(step.title, 200),
    kind: step.kind,
    dependencies: step.dependencies.filter((dependency) => stepIds.has(dependency) && dependency !== step.id),
    toolId: step.toolId && (TOOL_IDS as readonly string[]).includes(step.toolId) ? (step.toolId as PlanStep['toolId']) : null,
    description: truncateChars(step.description, 2000),
    expectedOutput: truncateChars(step.expectedOutput, 1000),
    inputRefs: [],
  }));
  // Drop unknown dependencies deterministically so the plan is internally
  // consistent; unknown *tool* references are still invalid and are rejected by
  // validation below (never silently executed).
  for (const step of normalizedSteps) {
    step.dependencies = step.dependencies.filter((dependency) => stepIds.has(dependency));
  }

  const toolRequirements = new Map<ToolId, PlanToolRequirement>();
  for (const requirement of draft.tools) {
    if (!(TOOL_IDS as readonly string[]).includes(requirement.toolId)) continue;
    const descriptor = context.descriptors.get(requirement.toolId as ToolId);
    if (!descriptor) continue;
    if (requirement.effect === 'external_write' || descriptor.policy.effect === 'external_write') continue;
    toolRequirements.set(descriptor.id, {
      toolId: descriptor.id,
      reason: truncateChars(requirement.reason || '计划声明需要', 1000),
      effect: descriptor.policy.effect,
    });
  }
  for (const step of normalizedSteps) {
    if (!step.toolId) continue;
    const descriptor = context.descriptors.get(step.toolId);
    if (!descriptor) continue;
    if (!toolRequirements.has(descriptor.id)) {
      toolRequirements.set(descriptor.id, { toolId: descriptor.id, reason: `计划步骤 ${step.id} 引用该工具`, effect: descriptor.policy.effect });
    }
  }
  // Baseline capabilities the kernel needs for candidate production.
  const ensureTool = (toolId: ToolId, reason: string): void => {
    const descriptor = context.descriptors.get(toolId);
    if (!descriptor || toolRequirements.has(toolId)) return;
    toolRequirements.set(toolId, { toolId, reason, effect: descriptor.policy.effect });
  };
  ensureTool('artifact.propose_patch', '产出可审阅的候选补丁（executor 的首选输出通道）');
  if (context.sources.length > 0) {
    ensureTool('source.list', '列出已绑定资料元数据');
    ensureTool('source.read', '读取已授权资料片段作为证据');
  }
  const finalTools = [...toolRequirements.values()].slice(0, 16);

  const inputRefs: InputRef[] = [];
  for (const source of context.sources.slice(0, 64)) {
    inputRefs.push({ kind: 'source', source: { sourceId: source.id, version: source.version } });
  }
  if (context.baseVersion) {
    inputRefs.push({ kind: 'artifact_version', versionId: context.baseVersion.id, moduleId: context.baseVersion.moduleId });
  }

  const conflicts = resolvedConflictKeys(context.decisions);
  const deterministicRiskList = deterministicRisks({
    task: context.task,
    moduleId: context.module.id,
    intent: context.command.intent,
    sources: context.sources,
    planStepCount: normalizedSteps.length,
    budget: context.run.budgetPolicy,
    conflicts: context.conflicts,
    decisions: context.decisions,
    evidenceRequired: context.module.acceptanceCriteria.some((criterion) => criterion.layer === 'L2'),
  });
  const filtered = filterModelRisks(draft.risks, {
    conflicts: context.conflicts,
    moduleId: context.module.id,
    isEvidenceRefValid: (ref) => context.validEvidenceKeys.has(evidenceRefKey(ref)),
  });
  const risks = mergeRisks(deterministicRiskList, filtered.risks);
  // Mark already-resolved conflicts so a revised plan is consistent.
  for (const risk of risks) {
    if (risk.type !== 'constraint_conflict') continue;
    const conflict = context.conflicts.find((entry) => risk.detail.includes(entry.constraintIds[0]) && risk.detail.includes(entry.constraintIds[1]));
    if (conflict && conflicts.has(constraintConflictDecisionKey(conflict))) {
      risk.resolvedByDecisionId = context.decisions.find((decision) => decision.key === constraintConflictDecisionKey(conflict))?.id ?? null;
    }
  }

  const assumptions = draft.assumptions.map((assumption, index) => ({
    id: assumption.id && /^[A-Za-z0-9_-]{1,64}$/.test(assumption.id) ? assumption.id : `a${index + 1}`,
    text: truncateChars(assumption.text, 2000),
    needsConfirmation: assumption.needsConfirmation,
  }));
  const openQuestions = draft.openQuestions.map((question, index) => ({
    id: question.id && /^[A-Za-z0-9_-]{1,64}$/.test(question.id) ? question.id : `q${index + 1}`,
    question: truncateChars(question.question, 2000),
    blocking: question.blocking,
    reason: truncateChars(question.reason, 1000),
  }));

  const validators = [
    { id: 'harness-validator-1', layer: 'L0' as const, description: '协议/Schema/必填字段' },
    { id: 'harness-validator-1', layer: 'L1' as const, description: '结构/依赖/表格与 JSON 规则' },
    { id: 'harness-validator-1', layer: 'L2' as const, description: '证据引用可定位性' },
    { id: 'harness-validator-1', layer: 'L3' as const, description: '硬约束与确定性验收标准' },
  ];

  const rationaleParts = [truncateChars(draft.rationale, 3500)];
  if (filtered.dropped > 0) {
    rationaleParts.push(`[内核校验] 移除了 ${filtered.dropped} 条缺少有效证据或约束依据的风险声明；风险数量不包含已移除项。`);
  }
  if (context.modelDroppedRiskNote) rationaleParts.push(context.modelDroppedRiskNote);
  const goal = (draft.goal.trim() || context.command.intent).slice(0, 4000);

  const plan: Plan = {
    runId: context.run.id,
    version: context.planVersion,
    goal,
    targetModuleId: context.module.id,
    artifactSkeleton: skeleton,
    inputRefs: inputRefs.slice(0, 64),
    constraintRefs: context.task.constraints.map((constraint) => ({
      constraintId: constraint.id,
      text: truncateChars(constraint.text, 2000),
    })),
    assumptions,
    openQuestions,
    steps: normalizedSteps,
    tools: finalTools,
    validators,
    budget: context.run.budgetPolicy,
    risks,
    promptVersion: context.promptVersion,
    modelProfileId: context.modelProfileId,
    createdAt: context.runtime.now(),
  };
  return PlanSchema.parse(plan);
}

/** Validate a plan against the hard kernel guards; returns readable problems. */
export function validatePlanDocument(plan: Plan, context: AssembleContext): string[] {
  const problems: string[] = [];
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 10)) {
      problems.push(`Schema: ${issue.path.join('.') || '(root)'} ${issue.message}`);
    }
    return problems;
  }
  const cycle = findPlanCycle(parsed.data.steps);
  if (cycle) problems.push(`步骤依赖存在环：${cycle.join(' -> ')}`);
  const unknownDeps = findUnknownPlanDependencies(parsed.data.steps);
  if (unknownDeps.length > 0) problems.push(`步骤依赖引用未知步骤：${unknownDeps.join(', ')}`);
  const stepIds = new Set(parsed.data.steps.map((step) => step.id));
  if (stepIds.size !== parsed.data.steps.length) problems.push('步骤 id 不唯一');
  for (const step of parsed.data.steps) {
    if (step.toolId && !(TOOL_IDS as readonly string[]).includes(step.toolId)) {
      problems.push(`步骤 ${step.id} 引用未注册工具 ${step.toolId}`);
    }
    if (step.toolId && !planAllowsTool(parsed.data, step.toolId)) {
      problems.push(`步骤 ${step.id} 使用工具 ${step.toolId}，但工具清单没有声明该工具`);
    }
  }
  for (const requirement of parsed.data.tools) {
    if (requirement.effect === 'external_write') problems.push(`工具 ${requirement.toolId} 是 external_write，P0 不允许`);
  }
  if (parsed.data.targetModuleId !== context.module.id) problems.push('计划目标模块与命令目标模块不一致');
  if (JSON.stringify(parsed.data.budget) !== JSON.stringify(context.run.budgetPolicy)) problems.push('计划预算与运行预算不一致（不允许提高预算）');
  const sourceIds = new Set(context.sources.map((source) => source.id));
  for (const ref of parsed.data.inputRefs) {
    if (ref.kind === 'source' && !sourceIds.has(ref.source.sourceId)) {
      problems.push(`输入引用 ${ref.source.sourceId} 不是本任务已绑定资料`);
    }
  }
  return problems;
}

/* ------------------------------ deterministic ----------------------------- */

function buildDeterministicDraft(context: AssembleContext): PlannerOutput {
  const hasSources = context.sources.length > 0;
  return {
    goal: context.command.intent.slice(0, 4000),
    skeleton: [
      {
        moduleId: context.module.id,
        moduleKind: context.module.kind,
        sections: [],
        expectedContentSummary: `按用户目标生成模块「${context.module.title}」的候选成果`,
      },
    ],
    steps: [
      {
        id: 's1',
        title: '读取资料并生成候选成果',
        kind: 'model',
        dependencies: [],
        toolId: null,
        description: '直接执行路径：内核采用最短计划；执行器在步骤内按需调用已授权工具并产出候选成果。',
        expectedOutput: '可校验的候选模块内容',
      },
    ],
    tools: [
      ...(hasSources
        ? [
            { toolId: 'source.list', reason: '列出已绑定资料', effect: 'read' as const },
            { toolId: 'source.read', reason: '读取资料片段作为证据', effect: 'read' as const },
          ]
        : []),
      { toolId: 'artifact.propose_patch', reason: '产出候选补丁草稿', effect: 'draft_write' as const },
    ],
    assumptions: [],
    openQuestions: [],
    risks: [],
    rationale: '直接执行路径（planFirst=false，设计 11.1）：内核按确定性规则生成最短计划，不调用规划模型；真实硬约束冲突仍会阻塞执行。',
  };
}

/* -------------------------------- main flow -------------------------------- */

export interface PlanStageParams {
  runtime: Runtime;
  command: PlanCommand;
  task: Task;
  run: Run;
  module: ArtifactModule;
  baseVersion: ArtifactVersion | null;
  aggregate: TaskAggregate;
  control: RunControl;
}

export type PlanStageOutcome =
  | { kind: 'ready'; run: Run; plan: Plan }
  | { kind: 'awaiting_input'; run: Run; plan: Plan; blockers: Blocker[] }
  | { kind: 'cancelled'; run: Run }
  | { kind: 'failed'; run: Run; error: RunError; retryable: boolean };

export async function runPlanStage(params: PlanStageParams): Promise<PlanStageOutcome> {
  const { runtime, command, task, module, control } = params;
  let run = params.run;

  const sources = await runtime.loadSources(task.id);
  if (command.sourceIds && command.sourceIds.length > 0) {
    const known = new Map(sources.map((source) => [source.id, source]));
    const missing = command.sourceIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`来源不存在或不属于该任务：${missing.join(', ')}`);
    }
    for (const id of known.keys()) {
      if (!command.sourceIds.includes(id)) known.delete(id);
    }
    // Keep the declared order.
    sources.length = 0;
    for (const id of command.sourceIds) {
      const source = known.get(id);
      if (source) sources.push(source);
    }
  }
  const decisions = await runtime.loadDecisions(task.id);
  const spans = await runtime.loadSpans(task.id);
  const conflicts = detectConstraintConflicts(task.constraints);
  const descriptors = await runtime.toolDescriptors();
  const workspace = await runtime.loadWorkspace();
  const baseVersion = params.baseVersion;

  const plannerPlan = command.planFirst;
  const modelProfile = plannerPlan ? await runtime.selectProvider() : null;
  if (plannerPlan && !modelProfile) {
    const error: RunError = {
      code: 'provider_model_missing',
      message: '未配置可用的模型供应商，无法生成计划；请先配置并测试模型连接，或对简单只读任务使用“直接执行”。',
      retryable: false,
      stage: 'planning',
      details: 'no enabled provider profile',
    };
    const failed = await runtime.failRun(run, error);
    await runtime.finalizeTerminal(failed.id);
    return { kind: 'failed', run: failed, error, retryable: false };
  }

  const plannerSystem = renderPlannerSystem({
    policyVersion: runtime.config.policyVersion,
    promptBundleVersion: runtime.config.promptBundleVersion,
    allowedTools: toolCatalog(descriptors),
    moduleSummary: moduleSummary(module),
    budgetSummary: budgetSummary(run.budgetPolicy),
  });
  const plannerInstruction = renderPlannerInstruction({
    goal: command.intent,
    skeletonModuleId: module.id,
    moduleKind: module.kind,
  });

  // Planning context is bound to the run: commit() verifies this snapshot id.
  const contextResult = await runtime.buildAndPersistContext({
    task,
    run,
    module,
    plan: null,
    stepId: null,
    stepGoal: command.intent,
    purpose: 'planner',
    systemPrompt: plannerSystem,
    instruction: plannerInstruction,
    decisions,
    sourceItems: sources,
    evidenceRefs: [],
    recentToolResults: [],
    acceptedVersion: baseVersion,
    acceptedUpstream: [],
    budgetSummary: budgetSummary(run.budgetPolicy),
    toolDefinitionTokens: 0,
    bindToRun: true,
  });
  run = contextResult.run;

  let validEvidenceKeys = new Set<string>();
  let draft: PlannerOutput | null = null;
  let promptTokenEstimate = contextResult.snapshot.estimatedInputTokens;

  if (plannerPlan && modelProfile) {
    const outcome = await runtime.callModel({
      run,
      taskId: task.id,
      stepId: null,
      stage: 'planning',
      purpose: 'planner',
      profile: modelProfile.profile,
      capabilities: modelProfile.capabilities,
      messages: [
        { role: 'system', content: contextResult.systemPrompt },
        { role: 'user', content: contextResult.userPrompt },
      ],
      tools: [],
      toolChoice: 'none',
      responseFormat:
        modelProfile.capabilities.structuredOutput === 'verified'
          ? { kind: 'json_schema', name: 'planner_output', schema: plannerOutputJsonSchema(), strict: false }
          : { kind: 'text' },
      temperature: 0.2,
      maxOutputTokens: run.budgetPolicy.maxOutputTokens,
      signal: control.abort.signal,
      control,
      estimatedInputTokens: promptTokenEstimate,
      label: 'planner.v1',
    });
    if (outcome.kind === 'budget_exhausted') {
      const error: RunError = {
        code: 'budget_exhausted',
        message: `规划阶段模型请求预算不足：${outcome.check.message}`,
        retryable: true,
        stage: 'planning',
        details: outcome.check.resource ?? '',
      };
      const failed = await runtime.failRun(run, error);
      await runtime.finalizeTerminal(failed.id);
      return { kind: 'failed', run: failed, error, retryable: true };
    }
    if (outcome.kind === 'cancelled') return { kind: 'cancelled', run: outcome.run };
    if (outcome.kind === 'paused') {
      const error: RunError = {
        code: 'service_failure',
        message: '规划阶段被服务关闭中断；没有持久化计划，请重新创建运行。',
        retryable: true,
        stage: 'planning',
        details: 'paused_during_planning',
      };
      const failed = await runtime.failRun(outcome.run, error);
      await runtime.finalizeTerminal(failed.id);
      return { kind: 'failed', run: failed, error, retryable: true };
    }
    if (outcome.kind === 'failed') {
      const error: RunError = {
        code: outcome.code,
        message: `规划模型调用失败：${outcome.error.message}`,
        retryable: outcome.error.retryable,
        stage: 'planning',
        details: JSON.stringify(outcome.error),
      };
      const failed = await runtime.failRun(outcome.run, error);
      await runtime.finalizeTerminal(failed.id);
      return { kind: 'failed', run: failed, error, retryable: outcome.error.retryable };
    }
    run = outcome.run;
    const parsed = parsePlannerOutput(outcome.text);
    draft = parsed.draft;
    validEvidenceKeys = await resolveValidEvidenceRefs(
      runtime,
      task.id,
      run.id,
      parsed.draft ? parsed.draft.risks.flatMap((risk) => (Array.isArray((risk as { evidenceRefs?: unknown[] }).evidenceRefs) ? ((risk as { evidenceRefs?: unknown[] }).evidenceRefs as unknown[]) : [])) : [],
    );
    // Bounded structure repair for plan JSON/schema problems.
    let problems = parsed.problems;
    let attempts = 0;
    while (problems.length > 0 && attempts < run.budgetPolicy.maxStructureRepairs) {
      attempts += 1;
      const repair = await requestPlanRepair(runtime, {
        run,
        taskId: task.id,
        control,
        findings: problems,
        rawOutput: outcome.text,
        availableEvidence: spans,
        attempt: attempts,
        maxAttempts: run.budgetPolicy.maxStructureRepairs,
      });
      if (repair.kind === 'cancelled') return { kind: 'cancelled', run: repair.run };
      if (repair.kind !== 'ok') {
        const error: RunError = {
          code: repair.error.code,
          message: `计划结构修复失败：${repair.error.message}`,
          retryable: repair.error.retryable,
          stage: 'planning',
          details: '',
        };
        const failed = await runtime.failRun(repair.run, error);
        await runtime.finalizeTerminal(failed.id);
        return { kind: 'failed', run: failed, error, retryable: repair.error.retryable };
      }
      run = repair.run;
      const repairedParse = parsePlannerOutput(repair.text);
      problems = repairedParse.problems;
      if (repairedParse.draft) {
        draft = repairedParse.draft;
        validEvidenceKeys = await resolveValidEvidenceRefs(
          runtime,
          task.id,
          run.id,
          repairedParse.draft.risks.flatMap((risk) => (Array.isArray((risk as { evidenceRefs?: unknown[] }).evidenceRefs) ? ((risk as { evidenceRefs?: unknown[] }).evidenceRefs as unknown[]) : [])),
        );
      }
    }
    if (problems.length > 0 || !draft) {
      const error: RunError = {
        code: 'validation_failed',
        message: `规划输出结构在 ${attempts} 次修复后仍不合法：${problems.slice(0, 5).join('；') || '没有可解析的计划 JSON'}`,
        retryable: false,
        stage: 'planning',
        details: problems.slice(0, 10).join('\n').slice(0, 4000),
      };
      const failed = await runtime.failRun(run, error);
      await runtime.finalizeTerminal(failed.id);
      return { kind: 'failed', run: failed, error, retryable: false };
    }
  } else {
    draft = buildDeterministicDraft({
      runtime,
      command,
      task,
      run,
      module,
      baseVersion,
      sources,
      decisions,
      spans,
      conflicts,
      descriptors,
      validEvidenceKeys,
      modelProfileId: null,
      planVersion: 1,
      promptVersion: 'deterministic-plan-1',
      modelDroppedRiskNote: null,
    });
  }

  const assembleContext: AssembleContext = {
    runtime,
    command,
    task,
    run,
    module,
    baseVersion,
    sources,
    decisions,
    spans,
    conflicts,
    descriptors,
    validEvidenceKeys,
    modelProfileId: plannerPlan && modelProfile ? modelProfile.profile.id : null,
    planVersion: 1,
    promptVersion: plannerPlan ? 'planner.v1' : 'deterministic-plan-1',
    modelDroppedRiskNote: null,
  };

  let plan: Plan;
  try {
    plan = assemblePlan(draft, assembleContext);
  } catch (error) {
    const error2: RunError = {
      code: 'schema_invalid',
      message: `计划无法组装为合法结构：${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
      stage: 'planning',
      details: '',
    };
    const failed = await runtime.failRun(run, error2);
    await runtime.finalizeTerminal(failed.id);
    return { kind: 'failed', run: failed, error: error2, retryable: false };
  }

  let planProblems = validatePlanDocument(plan, assembleContext);
  let repairAttempts = 0;
  while (planProblems.length > 0 && plannerPlan && repairAttempts < run.budgetPolicy.maxStructureRepairs) {
    repairAttempts += 1;
    const repair = await requestPlanRepair(runtime, {
      run,
      taskId: task.id,
      control,
      findings: planProblems,
      rawOutput: JSON.stringify(plan),
      availableEvidence: spans,
      attempt: repairAttempts,
      maxAttempts: run.budgetPolicy.maxStructureRepairs,
    });
    if (repair.kind === 'cancelled') return { kind: 'cancelled', run: repair.run };
    if (repair.kind !== 'ok') break;
    run = repair.run;
    const repairedParse = parsePlannerOutput(repair.text);
    if (!repairedParse.draft) {
      planProblems = repairedParse.problems;
      continue;
    }
    try {
      plan = assemblePlan(repairedParse.draft, assembleContext);
      planProblems = validatePlanDocument(plan, assembleContext);
    } catch (error) {
      planProblems = [`组装计划失败：${error instanceof Error ? error.message : String(error)}`];
    }
  }
  if (planProblems.length > 0) {
    const error: RunError = {
      code: 'validation_failed',
      message: `计划未通过内核校验：${planProblems.slice(0, 5).join('；')}`,
      retryable: false,
      stage: 'planning',
      details: planProblems.slice(0, 10).join('\n').slice(0, 4000),
    };
    const failed = await runtime.failRun(run, error);
    await runtime.finalizeTerminal(failed.id);
    return { kind: 'failed', run: failed, error, retryable: false };
  }

  const blockerSpecs = buildPlanBlockerSpecs(plan);
  const planContext: AssembleContext = {
    ...assembleContext,
    run,
    planVersion: 1,
    spans,
  };
  void planContext;

  if (blockerSpecs.length > 0) {
    const result = await persistPlanWithBlockers(runtime, run, plan, blockerSpecs);
    return { kind: 'awaiting_input', run: result.run, plan, blockers: result.blockers };
  }
  const readyRun = await persistReadyPlan(runtime, run, plan);
  return { kind: 'ready', run: readyRun, plan };
}

/* ------------------------------- plan repair ------------------------------- */

async function requestPlanRepair(
  runtime: Runtime,
  params: {
    run: Run;
    taskId: Task['id'];
    control: RunControl;
    findings: string[];
    rawOutput: string;
    availableEvidence: SourceSpan[];
    attempt: number;
    maxAttempts: number;
  },
): Promise<{ kind: 'ok'; text: string; run: Run } | { kind: 'cancelled'; run: Run } | { kind: 'error'; error: import('@ca/contracts').ProviderErrorDetail; run: Run }> {
  const provider = await runtime.selectProvider();
  if (!provider) {
    return {
      kind: 'error',
      error: { code: 'model_missing', message: '没有可用模型供应商', retryable: false, httpStatus: null, retryAfterMs: null, providerRequestId: null },
      run: params.run,
    };
  }
  const system = renderRepairSystem({ policyVersion: runtime.config.policyVersion });
  const user = renderRepairInstruction({
    moduleKind: 'plan',
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    findings: params.findings.map((finding) => `- ${finding}`).join('\n'),
    allowedEvidence:
      params.availableEvidence.length === 0
        ? '（没有可引用的真实 SourceSpan；不得编造引用，风险只能声明为 explicit_unknown 或留空。）'
        : params.availableEvidence
            .slice(0, 20)
            .map((span) => `- spanId=${span.id} sourceId=${span.sourceId} v${span.version} locator=${JSON.stringify(span.locator)} excerpt=${JSON.stringify(span.excerpt)}`)
            .join('\n'),
    candidateJson: truncateChars(params.rawOutput, 60_000),
  });
  const outcome = await runtime.callModel({
    run: params.run,
    taskId: params.taskId,
    stepId: null,
    stage: 'planning',
    purpose: 'repair',
    profile: provider.profile,
    capabilities: provider.capabilities,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [],
    toolChoice: 'none',
    responseFormat: { kind: 'text' },
    temperature: 0.1,
    maxOutputTokens: params.run.budgetPolicy.maxOutputTokens,
    signal: params.control.abort.signal,
    control: params.control,
    estimatedInputTokens: 2_000,
    label: 'repair.plan',
  });
  if (outcome.kind === 'ok') return { kind: 'ok', text: outcome.text, run: outcome.run };
  if (outcome.kind === 'cancelled') return { kind: 'cancelled', run: outcome.run };
  if (outcome.kind === 'paused') {
    return {
      kind: 'error',
      error: { code: 'cancelled', message: '规划修复被中断', retryable: true, httpStatus: null, retryAfterMs: null, providerRequestId: null },
      run: outcome.run,
    };
  }
  if (outcome.kind === 'budget_exhausted') {
    return {
      kind: 'error',
      error: { code: 'unknown', message: `修复预算不足：${outcome.check.message}`, retryable: true, httpStatus: null, retryAfterMs: null, providerRequestId: null },
      run: outcome.run,
    };
  }
  return { kind: 'error', error: outcome.error, run: outcome.run };
}

/* ------------------------------- persistence ------------------------------- */

interface BlockerSpecInternal {
  type: Blocker['type'];
  severity: Blocker['severity'];
  title: string;
  detail: string;
  riskId: string | null;
  questionId: string | null;
  resolutions: Blocker['resolutions'];
}

export function buildPlanBlockerSpecs(plan: Plan): BlockerSpecInternal[] {
  const specs: BlockerSpecInternal[] = [];
  for (const risk of unresolvedBlockingRisks(plan.risks)) {
    const options = risk.handlingOptions.map((option) => ({
      value: option.id,
      label: truncateChars(option.label, 200),
      description: truncateChars(option.description, 500),
    }));
    if (options.length < 2) {
      options.push({ value: 'cancel_run', label: '取消本次运行', description: '保留草稿与运行记录，不提交成果。' });
    }
    specs.push({
      type: risk.type === 'constraint_conflict' ? 'constraint_conflict' : risk.type === 'permission' ? 'permission_denied' : 'info_missing',
      severity: 'blocking',
      title: truncateChars(risk.title, 300),
      detail: `${risk.detail}\n风险ID：${risk.id}`.slice(0, 4000),
      riskId: risk.id,
      questionId: null,
      resolutions: [
        {
          id: 'choice',
          kind: 'choose',
          label: '选择处理方式',
          detail: '硬约束冲突必须通过修改输入、缩小范围或由用户显式修改约束来解决；记录决策后才能继续。',
          options: options.slice(0, 10),
        },
        {
          id: 'custom',
          kind: 'text',
          label: '补充说明或替代方案',
          detail: '用文字给出其他处理方式或修改后的约束。',
          placeholder: '例如：首版仅支持混合部署，离线能力降级为只读。',
          multiline: true,
          maxChars: 2000,
          required: true,
        },
      ],
    });
  }
  for (const question of plan.openQuestions.filter((entry) => entry.blocking)) {
    specs.push({
      type: 'info_missing',
      severity: 'blocking',
      title: truncateChars(question.question, 300),
      detail: `${question.reason || '该问题无法由内核自行决定。'}\n问题ID：${question.id}`.slice(0, 4000),
      riskId: null,
      questionId: question.id,
      resolutions: [
        {
          id: 'answer',
          kind: 'text',
          label: '回答该问题',
          detail: '回答后内核会生成新的计划版本并重新检查阻塞项。',
          placeholder: question.question.slice(0, 200),
          multiline: true,
          maxChars: 2000,
          required: true,
        },
      ],
    });
  }
  return specs;
}

async function persistReadyPlan(runtime: Runtime, run: Run, plan: Plan): Promise<Run> {
  return runtime.txn(run.taskId, async (tx) => {
    const fresh = await runtime.loadRun(run.id);
    const next: Run = {
      ...fresh,
      planVersion: plan.version,
      state: 'READY',
      returnState: null,
      revision: fresh.revision + 1,
      updatedAt: runtime.now(),
    };
    await runtime.storage.updateRun(next, fresh.revision);
    tx.emit('plan.proposed', { runId: next.id, planVersion: plan.version, plan });
    tx.emit('plan.ready', { runId: next.id, planVersion: plan.version });
    tx.emit('run.state_changed', { from: fresh.state, to: 'READY', reason: '计划通过校验，等待提交执行' });
    return next;
  }, { runId: run.id });
}

async function persistPlanWithBlockers(
  runtime: Runtime,
  run: Run,
  plan: Plan,
  specs: BlockerSpecInternal[],
): Promise<{ run: Run; blockers: Blocker[] }> {
  return runtime.txn(run.taskId, async (tx) => {
    const fresh = await runtime.loadRun(run.id);
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
      status: 'open' as const,
      resolution: null,
      returnState: 'READY' as const,
      createdAt: runtime.now(),
      resolvedAt: null,
      clearedAt: null,
    }));
    const next: Run = {
      ...fresh,
      planVersion: plan.version,
      state: 'AWAITING_INPUT',
      returnState: 'READY',
      revision: fresh.revision + 1,
      updatedAt: runtime.now(),
    };
    await runtime.storage.updateRun(next, fresh.revision);
    tx.emit('plan.proposed', { runId: next.id, planVersion: plan.version, plan });
    for (const blocker of blockers) {
      await runtime.storage.insertBlocker(blocker);
      tx.emit('blocker.detected', { blocker });
      tx.emit('input.requested', {
        blockerId: blocker.id,
        title: blocker.title,
        resolutionOptionIds: blocker.resolutions.map((option) => option.id),
      });
    }
    tx.emit('run.state_changed', {
      from: fresh.state,
      to: 'AWAITING_INPUT',
      reason: `${blockers.length} 个阻塞项需要用户处理（硬约束冲突/待决问题）`,
    });
    return { run: next, blockers };
  }, { runId: run.id });
}

/* ------------------------------- parse helpers ----------------------------- */

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced && fenced[1] ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new CandidateParseError(['输出中没有 JSON 对象']);
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (error) {
    throw new CandidateParseError([`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`]);
  }
}

export function parsePlannerOutput(text: string): { draft: PlannerOutput | null; problems: string[] } {
  let raw: unknown;
  try {
    raw = extractJsonObject(text);
  } catch (error) {
    return { draft: null, problems: error instanceof CandidateParseError ? error.problems : [String(error)] };
  }
  const parsed = PlannerOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      draft: null,
      problems: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const problems: string[] = [];
  if (parsed.data.steps.length === 0) problems.push('计划没有步骤');
  return { draft: parsed.data, problems };
}

function plannerOutputJsonSchema(): import('@ca/contracts').JsonObject {
  try {
    return z.toJSONSchema(PlannerOutputSchema) as import('@ca/contracts').JsonObject;
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

/* --------------------------- plan revision after input ---------------------- */

/**
 * Build a new plan version after user decisions, without re-calling the model.
 * Risks handled by a decision get `resolvedByDecisionId`; answered blocking
 * questions move into assumptions (explicit, needsConfirmation=false).
 */
export function revisePlanAfterDecisions(
  plan: Plan,
  decisions: readonly Decision[],
  blockers: readonly Blocker[],
  now: string,
): Plan {
  const decisionByKey = new Map(decisions.map((decision) => [decision.key, decision]));
  const resolvedRisks = plan.risks.map((risk) => {
    if (risk.resolvedByDecisionId) return risk;
    const blocker = blockers.find((candidate) => candidate.detail.includes(`风险ID：${risk.id}`));
    if (!blocker) return risk;
    const decision = decisions.find((candidate) => candidate.key.startsWith(`blocker:${blocker.id}`));
    if (decision) return { ...risk, resolvedByDecisionId: decision.id };
    if (risk.type === 'constraint_conflict') {
      const direct = decisions.find((candidate) => candidate.id === decisionByKey.get(`${candidate.key}`)?.id && candidate.key.startsWith('constraint_conflict:'));
      if (direct) return { ...risk, resolvedByDecisionId: direct.id };
    }
    return risk;
  });
  const answeredQuestions = new Set<string>();
  const newAssumptions = [...plan.assumptions];
  for (const blocker of blockers) {
    const match = /问题ID：(\S+)/.exec(blocker.detail);
    if (!match) continue;
    const questionId = match[1]!;
    const question = plan.openQuestions.find((entry) => entry.id === questionId);
    if (!question) continue;
    const decision = decisions.find((candidate) => candidate.key.startsWith(`blocker:${blocker.id}`));
    if (!decision) continue;
    answeredQuestions.add(questionId);
    newAssumptions.push({
      id: `a_${question.id}`.slice(0, 64),
      text: `用户已回答「${truncateChars(question.question, 500)}」：${truncateChars(decision.valueJson, 1000)}`,
      needsConfirmation: false,
    });
  }
  return PlanSchema.parse({
    ...plan,
    version: plan.version + 1,
    risks: resolvedRisks,
    openQuestions: plan.openQuestions.filter((question) => !answeredQuestions.has(question.id)),
    assumptions: newAssumptions.slice(0, 32),
    createdAt: now,
  });
}

/** Blocker detail parser used by resolve(). */
export function blockerRiskId(detail: string): string | null {
  const match = /风险ID：(\S+)/.exec(detail);
  return match ? match[1]! : null;
}

export function blockerQuestionId(detail: string): string | null {
  const match = /问题ID：(\S+)/.exec(detail);
  return match ? match[1]! : null;
}

export { blockingRisks, PlanRiskSchema };
