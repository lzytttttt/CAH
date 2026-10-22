/**
 * Bounded execution loop (design sections 5.1-5.3, 7.2, 8.3, 12.1).
 *
 * Per planned step: build layered context → call the model with native tools →
 * execute only complete, schema-valid, allow-listed tool calls serially → append
 * tool results back to the conversation → continue until a candidate artifact is
 * produced or budget / round limits / the no-progress guard stop the run.
 *
 * Pause stops scheduling new steps at a safe boundary and saves a checkpoint.
 * Cancel aborts the in-flight request and preserves drafts. Budget exhaustion
 * pauses with an explanation instead of pretending success. No timer ever decides
 * success or unlocks anything.
 */
import {
  ModuleContentSchema,
  EvidenceRefSchema,
  TOOL_IDS,
  newStepId,
  newToolCallId,
  type ArtifactModule,
  type ArtifactVersion,
  type Blocker,
  type EvidenceRef,
  type ModelMessage,
  type ModelToolCall,
  type ModuleContent,
  type Plan,
  type PlanStep,
  type Run,
  type RunError,
  type Step,
  type StepId,
  type Task,
  type ToolId,
  type ToolScope,
} from '@ca/contracts';
import type { Runtime, RunControl } from './runtime';
import { grantedScopesForPlan } from './runtime';
import { budgetSummary, moduleSummary } from './planner';
import { renderExecutorInstruction, renderExecutorSystem } from './prompts';
import { CandidateParseError, kernelError } from './errors';
import { contentHash, truncateBytes, truncateChars } from './hashing';

export interface ExecutorParams {
  runtime: Runtime;
  run: Run;
  task: Task;
  module: ArtifactModule;
  plan: Plan;
  control: RunControl;
}

export interface ExecutorCheckpoint {
  phase: 'execution';
  completedPlanSteps: string[];
  currentPlanStepId: string | null;
  roundsUsed: number;
  recentToolResults: Array<{ toolId: string; summary: string }>;
  evidenceRefs: EvidenceRef[];
}

export type ExecutorOutcome =
  | {
      kind: 'candidate';
      run: Run;
      candidate: ModuleContent;
      evidenceRefs: EvidenceRef[];
      description: string;
      text: string;
      problems: string[];
      patchId: string | null;
    }
  | { kind: 'paused'; run: Run; checkpoint: ExecutorCheckpoint }
  | { kind: 'cancelled'; run: Run }
  | { kind: 'blocked'; run: Run; blocker: Blocker }
  | { kind: 'failed'; run: Run; error: RunError; retryable: boolean };

interface CandidateParseResult {
  candidate: ModuleContent;
  evidenceRefs: EvidenceRef[];
  description: string;
  problems: string[];
}

const STEP_KIND_MAP: Record<PlanStep['kind'], Step['kind']> = {
  tool: 'tool',
  model: 'model',
  validate: 'validate',
  compose: 'model',
};

const MAX_TOOL_MESSAGE_CHARS = 120_000;

export async function runExecutor(params: ExecutorParams): Promise<ExecutorOutcome> {
  const { runtime, task, module, plan, control } = params;
  let run = await runtime.loadRun(params.run.id);
  const state = await restoreCheckpoint(runtime, run);
  const completed = new Set(state.completedPlanSteps);
  const orderedSteps = orderPlanSteps(plan.steps);
  const allowedToolIds = new Set<ToolId>(plan.tools.map((requirement) => requirement.toolId));
  const descriptors = await runtime.toolDescriptors();
  const grantedScopes: ToolScope[] = grantedScopesForPlan(plan, descriptors);
  const modelTools = runtime.tools.modelTools([...allowedToolIds]);
  let lastText = '';
  let lastModelCallId: string | null = null;

  for (const planStep of orderedSteps) {
    if (completed.has(planStep.id)) continue;
    if (control.cancelRequested) return { kind: 'cancelled', run };
    if (control.pauseRequested) {
      return pauseWith(runtime, run, state, '收到暂停请求：在安全边界保存检查点，不调度新步骤。');
    }
    const preBudget = runtime.checkRunBudget(run);
    if (!preBudget.allowed) return pauseWith(runtime, run, state, preBudget.message, preBudget);
    if (run.budgetUsage.elapsedActiveMs >= run.budgetPolicy.maxRunDurationMs) {
      return pauseWith(runtime, run, state, '运行活动时长预算已用尽，已保存检查点。', preBudget);
    }

    state.currentPlanStepId = planStep.id;
    const started = await startStep(runtime, run, planStep);
    run = started.run;
    const step = started.step;

    // Deterministic validation steps are handled by the kernel validation stage.
    if (planStep.kind === 'validate') {
      run = await finishStep(runtime, run, step, {
        summary: '结构性校验由内核确定性校验器处理',
        outputRefs: [],
        modelCallId: null,
      });
      state.completedPlanSteps.push(planStep.id);
      continue;
    }

    const built = await buildStepContext(runtime, { task, run, module, plan, step: planStep, state });
    run = built.run;
    const conversation: ModelMessage[] = [
      { role: 'system', content: built.systemPrompt },
      { role: 'user', content: built.userPrompt },
    ];
    let stepModelCallId: string | null = null;
    let lastFailureSignature: string | null = null;
    let failureRepeat = 0;
    const recordFailure = (signature: string): boolean => {
      if (signature === lastFailureSignature) failureRepeat += 1;
      else {
        lastFailureSignature = signature;
        failureRepeat = 1;
      }
      return failureRepeat >= 2;
    };

    while (true) {
      if (control.cancelRequested) {
        await failStep(runtime, run, step, '运行被取消');
        return { kind: 'cancelled', run };
      }
      if (control.pauseRequested) {
        await failStep(runtime, run, step, '运行暂停');
        return pauseWith(runtime, run, state, '收到暂停请求：在安全边界保存检查点。');
      }
      state.roundsUsed += 1;
      if (state.roundsUsed > runtime.config.maxToolRounds) {
        await failStep(runtime, run, step, '达到单次运行的工具/模型轮次上限');
        return raiseNoProgress(runtime, run, step, {
          title: '达到工具/模型轮次上限，未产出候选成果',
          detail: `本 Run 已进行 ${state.roundsUsed - 1} 轮模型/工具往返（上限 ${runtime.config.maxToolRounds}）。为避免盲目重试已停止；请检查计划或补充范围后重试。`,
          affectedStep: step.id,
        });
      }
      const roundBudget = runtime.checkRunBudget(run);
      if (!roundBudget.allowed) {
        await failStep(runtime, run, step, roundBudget.message);
        return pauseWith(runtime, run, state, roundBudget.message, roundBudget);
      }
      if (run.budgetUsage.elapsedActiveMs >= run.budgetPolicy.maxRunDurationMs) {
        await failStep(runtime, run, step, '运行活动时长预算已用尽');
        return pauseWith(runtime, run, state, '运行活动时长预算已用尽，已保存检查点。', roundBudget);
      }

      // Persist one ContextSnapshot per model request (design 7.2) and refresh the
      // fixed system/user prefix; tool turns are appended to the live conversation.
      const roundContext = await buildStepContext(runtime, { task, run, module, plan, step: planStep, state });
      run = roundContext.run;
      conversation[0] = { role: 'system', content: roundContext.systemPrompt };
      conversation[1] = { role: 'user', content: roundContext.userPrompt };

      const provider = await runtime.selectProvider();
      if (!provider) {
        const error: RunError = {
          code: 'provider_model_missing',
          message: '未配置可用模型供应商，无法继续执行。',
          retryable: false,
          stage: 'execution',
          details: '',
        };
        const failed = await runtime.failRun(run, error);
        await runtime.finalizeTerminal(failed.id);
        return { kind: 'failed', run: failed, error, retryable: false };
      }
      const toolCallingSupported = provider.capabilities.toolCalling !== 'unsupported';
      const outcome = await runtime.callModel({
        run,
        taskId: task.id,
        stepId: step.id,
        stage: 'execution',
        purpose: 'executor',
        profile: provider.profile,
        capabilities: provider.capabilities,
        messages: conversation,
        tools: toolCallingSupported ? modelTools : [],
        toolChoice: toolCallingSupported && modelTools.length > 0 ? 'auto' : 'none',
        responseFormat: { kind: 'text' },
        temperature: 0.2,
        maxOutputTokens: run.budgetPolicy.maxOutputTokens,
        signal: control.abort.signal,
        control,
        estimatedInputTokens: roundContext.snapshot.estimatedInputTokens,
        label: `executor:${planStep.id}`,
      });
      if (outcome.kind === 'budget_exhausted') {
        await failStep(runtime, run, step, outcome.check.message);
        return pauseWith(runtime, run, state, outcome.check.message, outcome.check);
      }
      if (outcome.kind === 'cancelled') return { kind: 'cancelled', run: outcome.run };
      if (outcome.kind === 'paused') {
        await failStep(runtime, run, step, '模型请求被中断');
        return pauseWith(runtime, run, state, '模型请求被中断，已保存检查点。');
      }
      if (outcome.kind === 'failed') {
        await failStep(runtime, run, step, `模型调用失败：${outcome.error.message}`);
        return raiseServiceFailure(runtime, outcome.run, step, outcome.error.message);
      }
      run = outcome.run;
      lastModelCallId = outcome.modelCallId;
      stepModelCallId = outcome.modelCallId;
      lastText = outcome.text;

      if (outcome.toolCalls.length === 0) {
        // A final answer: it must be a parseable candidate, otherwise nudge once and
        // then stop with a no-progress blocker (never fabricate a result).
        conversation.push({ role: 'assistant', content: outcome.text });
        try {
          const parsed = parseCandidateOutput(outcome.text);
          return await completeWithCandidate(runtime, run, step, planStep, state, parsed, outcome.text, null);
        } catch (error) {
          const problems = error instanceof CandidateParseError ? error.problems : [String(error)];
          if (recordFailure(`parse:${problems[0] ?? 'unknown'}`)) {
            await failStep(runtime, run, step, '连续两次未产出可解析的候选成果');
            return raiseNoProgress(runtime, run, step, {
              title: '连续两次未产出可解析的候选成果',
              detail: `模型消息既没有原生工具调用，也不是合法的候选成果 JSON：${problems.slice(0, 3).join('；')}。已停止盲目重试。`,
              affectedStep: step.id,
            });
          }
          conversation.push({
            role: 'user',
            content: `当前消息不是合法的候选成果 JSON（${problems.slice(0, 3).join('；')}）。请调用 artifact.propose_patch，或只输出 {"candidate": <模块内容>, "evidenceRefs": [...]} 形式的 JSON，不要输出其他解释。`,
          });
          continue;
        }
      }

      // Native tool calls: append the assistant turn, execute serially, append
      // matching tool-result messages, then continue the bounded loop.
      const normalizedCalls: ModelToolCall[] = outcome.toolCalls.map((call) => ({
        callId: newToolCallId(),
        name: call.name,
        argumentsJson: call.argumentsJson,
      }));
      conversation.push({
        role: 'assistant',
        content: outcome.text,
        toolCalls: normalizedCalls,
      });

      for (const call of normalizedCalls) {
        const toolId = resolveToolId(call.name);
        const toolCallId = call.callId;
        if (!toolId) {
          conversation.push({
            role: 'tool',
            toolCallId,
            content: JSON.stringify({ status: 'failed', error: { code: 'tool_unknown', message: `未注册工具：${call.name}` } }),
          });
          if (recordFailure(`tool_unknown:${call.name}`)) {
            await failStep(runtime, run, step, `模型重复请求未注册工具 ${call.name}`);
            return raiseNoProgress(runtime, run, step, {
              title: '模型重复请求未注册工具',
              detail: `模型连续请求未注册工具「${call.name}」，已停止盲目重试。`,
              affectedStep: step.id,
            });
          }
          continue;
        }
        const execution = await runtime.executeTool({
          run,
          taskId: task.id,
          stepId: step.id,
          toolCallId,
          toolId,
          rawArgumentsJson: call.argumentsJson,
          allowedToolIds,
          grantedScopes,
          signal: control.abort.signal,
          control,
        });
        run = await runtime.loadRun(run.id);
        if (execution.kind === 'cancelled') return { kind: 'cancelled', run };
        if (execution.kind === 'paused') {
          return pauseWith(runtime, run, state, '工具执行期间暂停，已保存检查点。');
        }
        if (execution.kind === 'budget_exhausted') {
          await failStep(runtime, run, step, execution.check.message);
          return pauseWith(runtime, run, state, execution.check.message, execution.check);
        }
        if (execution.kind === 'unknown') {
          return raiseServiceFailure(
            runtime,
            run,
            step,
            `工具 ${toolId} 结果未知：${execution.detail}；不会自动重放不安全的副作用，请核对后重试或取消。`,
          );
        }
        if (execution.kind === 'succeeded') {
          state.recentToolResults.push({
            toolId,
            summary: execution.record.resultSummary ?? `${toolId} 成功`,
          });
          if (toolId === 'artifact.propose_patch') {
            const proposed = extractProposePatch(execution.result.result ?? undefined);
            if (!proposed) {
              await failStep(runtime, run, step, '候选补丁无法解析');
              return raiseNoProgress(runtime, run, step, {
                title: '候选补丁无法解析',
                detail: `artifact.propose_patch 成功返回但无法解析为候选补丁：${truncateChars(JSON.stringify(execution.result.result ?? null), 500)}`,
                affectedStep: step.id,
              });
            }
            return await completeWithCandidate(runtime, run, step, planStep, state, proposed, outcome.text, proposed.patchId);
          }
          conversation.push({
            role: 'tool',
            toolCallId,
            content: truncateBytes(
              JSON.stringify({
                status: 'succeeded',
                toolId,
                result: execution.result.result ?? null,
              }),
              MAX_TOOL_MESSAGE_CHARS,
            ),
          });
          continue;
        }
        // Failed / denied call: feed the typed error back so the model can adapt.
        const error =
          execution.kind === 'denied'
            ? { code: 'tool_not_allowed', message: execution.reason, retryable: false }
            : { code: execution.error.code, message: execution.error.message, retryable: execution.error.retryable };
        conversation.push({
          role: 'tool',
          toolCallId,
          content: truncateBytes(
            JSON.stringify({ status: 'failed', toolId, error: { code: error.code, message: truncateChars(error.message, 2000), retryable: error.retryable } }),
            20_000,
          ),
        });
        if (recordFailure(`${toolId}:${error.code}`)) {
          await failStep(runtime, run, step, `工具连续失败：${error.code}`);
          return raiseNoProgress(runtime, run, step, {
            title: '相同工具失败签名连续出现两次',
            detail: `工具 ${toolId} 连续失败（${error.code}：${truncateChars(error.message, 300)}），已停止盲目重试。`,
            affectedStep: step.id,
          });
        }
      }
    }
  }

  // All planned steps completed without a candidate: honest failure, not success.
  return raiseNoProgress(runtime, run, {
    id: newStepId(),
    runId: run.id,
    kind: 'model',
    title: '未产出候选成果',
    dependencies: [],
    inputRefsJson: '[]',
    outputRefs: [],
    status: 'failed',
    attempt: run.attempt,
    modelCallId: lastModelCallId,
    toolCallIds: [],
    summary: '',
    errorJson: null,
    startedAt: run.startedAt,
    finishedAt: runtime.now(),
  }, {
    title: '计划步骤已执行完，但模型没有产出候选成果',
    detail: '所有计划步骤都已完成，但没有获得可通过校验的候选成果。不会伪造成功：请检查模型配置/提示或缩小目标范围后重试。',
    affectedStep: null,
  });
}

/* ------------------------------ context build ------------------------------ */

async function buildStepContext(
  runtime: Runtime,
  params: {
    task: Task;
    run: Run;
    module: ArtifactModule;
    plan: Plan;
    step: PlanStep;
    state: ExecutorCheckpoint;
  },
): Promise<{
  run: Run;
  snapshot: import('@ca/contracts').ContextSnapshot;
  systemPrompt: string;
  userPrompt: string;
}> {
  const { task, run, module, plan, step, state } = params;
  const descriptors = await runtime.toolDescriptors();
  const allowedToolText = plan.tools
    .map((requirement) => {
      const descriptor = descriptors.get(requirement.toolId);
      if (!descriptor) return `- ${requirement.toolId}`;
      return `- ${descriptor.id}（effect=${descriptor.policy.effect}）：${truncateChars(descriptor.description, 400)} 参数: ${truncateChars(JSON.stringify(descriptor.parameters), 800)}`;
    })
    .join('\n');
  const baseVersion = await runtime.storage.getAcceptedVersion(module.id);
  const systemPrompt = renderExecutorSystem({
    policyVersion: runtime.config.policyVersion,
    promptBundleVersion: runtime.config.promptBundleVersion,
    moduleId: module.id,
    baseVersionId: baseVersion?.id ?? '（无已接受基线）',
    stepTitle: step.title,
    stepGoal: step.description || step.expectedOutput || step.title,
    moduleSummary: moduleSummary(module),
    budgetSummary: budgetSummary(run.budgetPolicy),
    allowedTools: allowedToolText || '（本步骤没有授权工具，请直接输出候选成果 JSON）',
  });
  const instruction = renderExecutorInstruction({
    stepGoal: step.description || step.expectedOutput || step.title,
  });
  const decisions = await runtime.loadDecisions(task.id);
  const sources = await runtime.loadSources(task.id);
  const acceptedUpstream: Array<{ module: ArtifactModule; version: ArtifactVersion }> = [];
  for (const dependencyId of module.dependencies) {
    const version = await runtime.storage.getAcceptedVersion(dependencyId);
    const dependency = await runtime.storage.getModule(dependencyId);
    if (version && dependency) acceptedUpstream.push({ module: dependency, version });
  }
  const built = await runtime.buildAndPersistContext({
    task,
    run,
    module,
    plan,
    stepId: null,
    stepGoal: step.description || step.title,
    purpose: 'executor',
    systemPrompt,
    instruction,
    decisions,
    sourceItems: sources,
    evidenceRefs: state.evidenceRefs,
    recentToolResults: state.recentToolResults,
    acceptedVersion: baseVersion,
    acceptedUpstream,
    budgetSummary: budgetSummary(run.budgetPolicy),
    completedStepSummaries: state.completedPlanSteps.map((id) => `计划步骤 ${id} 已完成`),
    toolDefinitionTokens: 0,
    bindToRun: false,
  });
  return {
    run: built.run,
    snapshot: built.snapshot,
    systemPrompt: built.systemPrompt,
    userPrompt: built.userPrompt,
  };
}

/* --------------------------------- steps ---------------------------------- */

function orderPlanSteps(steps: readonly PlanStep[]): PlanStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const order: PlanStep[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // plan guard rejects cycles; defensive stop
    visiting.add(id);
    const step = byId.get(id);
    if (!step) return;
    for (const dependency of step.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    order.push(step);
  };
  for (const step of steps) visit(step.id);
  return order;
}

async function startStep(runtime: Runtime, run: Run, planStep: PlanStep): Promise<{ run: Run; step: Step }> {
  const step: Step = {
    id: newStepId(),
    runId: run.id,
    kind: STEP_KIND_MAP[planStep.kind],
    title: planStep.title.slice(0, 300),
    dependencies: [],
    inputRefsJson: JSON.stringify(planStep.inputRefs ?? []).slice(0, 20_000),
    outputRefs: [],
    status: 'running',
    attempt: run.attempt,
    modelCallId: null,
    toolCallIds: [],
    summary: '',
    errorJson: null,
    startedAt: runtime.now(),
    finishedAt: null,
  };
  const result = await runtime.txn(
    run.taskId,
    async (tx) => {
      await runtime.storage.insertStep(step);
      const fresh = await runtime.loadRun(run.id);
      const next: Run = { ...fresh, revision: fresh.revision + 1, updatedAt: runtime.now() };
      await runtime.storage.updateRun(next, fresh.revision);
      tx.emit('step.started', {
        stepId: step.id,
        kind: step.kind,
        title: step.title,
        attempt: step.attempt,
      });
      return next;
    },
    { runId: run.id, stepId: step.id },
  );
  return { run: result, step };
}

async function finishStep(
  runtime: Runtime,
  run: Run,
  step: Step,
  input: { summary: string; outputRefs: string[]; modelCallId: string | null },
): Promise<Run> {
  const finished: Step = {
    ...step,
    status: 'completed',
    summary: input.summary.slice(0, 2000),
    outputRefs: input.outputRefs.slice(0, 64),
    modelCallId: (input.modelCallId ?? step.modelCallId) as never,
    finishedAt: runtime.now(),
  };
  return runtime.txn(
    run.taskId,
    async (tx) => {
      await runtime.storage.updateStep(finished);
      const fresh = await runtime.loadRun(run.id);
      const next: Run = { ...fresh, revision: fresh.revision + 1, updatedAt: runtime.now() };
      await runtime.storage.updateRun(next, fresh.revision);
      tx.emit('step.completed', {
        stepId: finished.id,
        kind: finished.kind,
        summary: finished.summary,
        outputRefs: finished.outputRefs,
      });
      return next;
    },
    { runId: run.id, stepId: finished.id },
  );
}

async function failStep(runtime: Runtime, run: Run, step: Step, message: string): Promise<void> {
  const failed: Step = {
    ...step,
    status: 'failed',
    summary: truncateChars(message, 2000),
    errorJson: JSON.stringify({ code: 'step_failed', message: truncateChars(message, 4000), retryable: true }),
    finishedAt: runtime.now(),
  };
  await runtime.txn(
    run.taskId,
    async (tx) => {
      await runtime.storage.updateStep(failed);
      tx.emit('step.failed', {
        stepId: failed.id,
        kind: failed.kind,
        error: { code: 'step_failed', message: truncateChars(message, 4000), retryable: true },
      });
    },
    { runId: run.id, stepId: failed.id },
  );
}

async function completeWithCandidate(
  runtime: Runtime,
  run: Run,
  step: Step,
  planStep: PlanStep,
  state: ExecutorCheckpoint,
  parsed: CandidateParseResult & { patchId?: string },
  text: string,
  patchId: string | null,
): Promise<ExecutorOutcome> {
  state.evidenceRefs = parsed.evidenceRefs;
  const finished = await finishStep(runtime, run, step, {
    summary: `产出候选成果（${patchId ? 'artifact.propose_patch' : '结构化 JSON'}）`,
    outputRefs: [contentHash(parsed.candidate)],
    modelCallId: null,
  });
  state.completedPlanSteps.push(planStep.id);
  await runtime.checkpoint(finished, 'state', step.id, { ...state, phase: 'execution' });
  return {
    kind: 'candidate',
    run: finished,
    candidate: parsed.candidate,
    evidenceRefs: parsed.evidenceRefs,
    description: parsed.description,
    text,
    problems: parsed.problems,
    patchId: patchId ?? parsed.patchId ?? null,
  };
}

/* ------------------------------- blockers --------------------------------- */

async function pauseWith(
  runtime: Runtime,
  run: Run,
  state: ExecutorCheckpoint,
  note: string,
  budget?: import('@ca/contracts').BudgetCheck,
): Promise<ExecutorOutcome> {
  const paused = await runtime.pauseAtSafeBoundary(run, note, note, { ...state, phase: 'execution' }, budget);
  return { kind: 'paused', run: paused, checkpoint: state };
}

async function raiseNoProgress(
  runtime: Runtime,
  run: Run,
  step: Step,
  input: { title: string; detail: string; affectedStep: StepId | null },
): Promise<ExecutorOutcome> {
  const result = await runtime.createBlocker(run, {
    type: 'no_progress',
    severity: 'blocking',
    title: input.title,
    detail: input.detail,
    affectedSteps: input.affectedStep ? [input.affectedStep] : [],
    affectedModuleIds: [run.moduleId],
    returnState: 'RUNNING',
    resolutions: [
      {
        id: 'retry',
        kind: 'choose',
        label: '调整方式后重试',
        detail: '可以补充说明、缩小范围或更换模型后重新执行；重试会使用新的 attempt 并产生新的模型费用。',
        options: [
          { value: 'retry', label: '补充说明后重试', description: '记录一条决策后继续执行。' },
          { value: 'cancel_run', label: '保留草稿并取消运行', description: '取消本次运行，已接受成果不变。' },
        ],
      },
      {
        id: 'note',
        kind: 'text',
        label: '补充说明（可选）',
        detail: '说明你希望模型如何调整。',
        placeholder: '例如：只汇总表格中的必填字段，不要扩展范围。',
        multiline: true,
        maxChars: 2000,
        required: false,
      },
    ],
  });
  return { kind: 'blocked', run: result.run, blocker: result.blocker };
}

async function raiseServiceFailure(runtime: Runtime, run: Run, step: Step, message: string): Promise<ExecutorOutcome> {
  const result = await runtime.createBlocker(run, {
    type: 'service_failure',
    severity: 'blocking',
    title: '模型/工具服务故障',
    detail: `${message}\n这是技术故障，不是业务选择题：请检查连接/凭据/模型配置后重试，或保留草稿并取消。`,
    affectedSteps: [step.id],
    affectedModuleIds: [run.moduleId],
    returnState: 'RUNNING',
    resolutions: [
      {
        id: 'recover',
        kind: 'choose',
        label: '技术恢复',
        detail: '修复连接/凭据/模型配置后重试；重试会使用新的 attempt 并产生新的模型费用。',
        options: [
          { value: 'retry', label: '重试', description: '从最近检查点继续执行。' },
          { value: 'cancel_run', label: '保留草稿并取消运行', description: '取消本次运行，已接受成果不变。' },
        ],
      },
    ],
  });
  return { kind: 'blocked', run: result.run, blocker: result.blocker };
}

/* ---------------------------- tool result parsing -------------------------- */

function resolveToolId(name: string): ToolId | null {
  if ((TOOL_IDS as readonly string[]).includes(name)) return name as ToolId;
  // Some providers sanitize dots in function names to underscores; map back.
  const normalized = name.replace(/__/g, '.').replace(/_/g, '.');
  if ((TOOL_IDS as readonly string[]).includes(normalized)) return normalized as ToolId;
  return null;
}

function extractProposePatch(raw: unknown): (CandidateParseResult & { patchId: string }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const patch = record.patch as Record<string, unknown> | undefined;
  const candidateRaw = patch?.candidate ?? record.candidate;
  const parsed = ModuleContentSchema.safeParse(candidateRaw);
  if (!parsed.success) return null;
  const problems: string[] = [];
  const evidenceRefs: EvidenceRef[] = [];
  const evidenceRaw = Array.isArray(patch?.evidenceRefs) ? (patch?.evidenceRefs as unknown[]) : [];
  for (const rawRef of evidenceRaw) {
    const ref = EvidenceRefSchema.safeParse(rawRef);
    if (ref.success) evidenceRefs.push(ref.data);
    else problems.push('候选补丁包含格式非法的证据引用');
  }
  return {
    candidate: parsed.data,
    evidenceRefs,
    description: typeof patch?.description === 'string' ? patch.description : '模型生成的候选补丁',
    problems,
    patchId: typeof patch?.id === 'string' ? patch.id : '',
  };
}

/** Parse a final assistant JSON message into a candidate module content. */
export function parseCandidateOutput(text: string): CandidateParseResult {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (error) {
    throw new CandidateParseError(error instanceof CandidateParseError ? error.problems : ['输出中没有合法 JSON']);
  }
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!record) throw new CandidateParseError(['候选成果 JSON 必须是对象']);
  const candidateRaw =
    record.candidate && typeof record.candidate === 'object'
      ? record.candidate
      : record.content && typeof record.content === 'object'
        ? record.content
        : record;
  const parsed = ModuleContentSchema.safeParse(candidateRaw);
  if (!parsed.success) {
    throw new CandidateParseError(
      parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const problems: string[] = [];
  const evidenceRefs: EvidenceRef[] = [];
  const evidenceRaw = Array.isArray(record.evidenceRefs) ? (record.evidenceRefs as unknown[]) : [];
  for (const entry of evidenceRaw) {
    const ref = EvidenceRefSchema.safeParse(entry);
    if (ref.success) evidenceRefs.push(ref.data);
    else problems.push('候选成果包含格式非法的证据引用（必须指向真实 SourceSpan/成果版本/工具结果，或显式用户假设）');
  }
  return {
    candidate: parsed.data,
    evidenceRefs,
    description: typeof record.description === 'string' ? truncateChars(record.description, 4000) : '模型生成的候选成果',
    problems,
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced && fenced[1] ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new CandidateParseError(['输出中没有 JSON 对象']);
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new CandidateParseError([`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`]);
  }
}

/* -------------------------------- restore --------------------------------- */

async function restoreCheckpoint(runtime: Runtime, run: Run): Promise<ExecutorCheckpoint> {
  const empty: ExecutorCheckpoint = {
    phase: 'execution',
    completedPlanSteps: [],
    currentPlanStepId: null,
    roundsUsed: 0,
    recentToolResults: [],
    evidenceRefs: [],
  };
  if (!run.checkpointId) return empty;
  const checkpoint = await runtime.storage.getCheckpoint(run.checkpointId);
  if (!checkpoint) return empty;
  try {
    const data = JSON.parse(checkpoint.dataJson) as Partial<ExecutorCheckpoint>;
    if (!data || data.phase !== 'execution') return empty;
    return {
      phase: 'execution',
      completedPlanSteps: Array.isArray(data.completedPlanSteps)
        ? data.completedPlanSteps.filter((entry): entry is string => typeof entry === 'string')
        : [],
      currentPlanStepId: typeof data.currentPlanStepId === 'string' ? data.currentPlanStepId : null,
      roundsUsed: typeof data.roundsUsed === 'number' ? data.roundsUsed : 0,
      recentToolResults: Array.isArray(data.recentToolResults)
        ? data.recentToolResults.filter(
            (entry): entry is { toolId: string; summary: string } =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              typeof (entry as { toolId?: unknown }).toolId === 'string' &&
              typeof (entry as { summary?: unknown }).summary === 'string',
          )
        : [],
      evidenceRefs: Array.isArray(data.evidenceRefs)
        ? data.evidenceRefs.filter((entry): entry is EvidenceRef => EvidenceRefSchema.safeParse(entry).success)
        : [],
    };
  } catch {
    return empty;
  }
}

/* ------------------------------- helpers ---------------------------------- */

export function executorPlanSteps(plan: Plan): PlanStep[] {
  return orderPlanSteps(plan.steps);
}

export function assertPlanForExecution(plan: Plan, module: ArtifactModule): void {
  if (plan.targetModuleId !== module.id) {
    throw kernelError('bad_request', '计划目标模块与运行模块不一致');
  }
  if (plan.steps.length === 0) {
    throw kernelError('bad_request', '计划没有可执行步骤');
  }
}
