import { createHash } from 'node:crypto';
import {
  DEFAULT_BUDGET_POLICY,
  RECIPE_DSL_VERSION,
  canonicalJson,
  createBudgetUsage,
  newArtifactVersionId,
  newRecipeId,
  newRunId,
  utcNow,
  type JsonObject,
  type Recipe,
  type RecipeProposalInput,
  type RecipeRunResult,
  type RecipeTestCase,
  type Run,
  type TaskId,
  type ValidationReport,
} from '@ca/contracts';
import { computeRecipeFingerprint, createRecipeRuntime, deserializeModuleContent, extractRecipeCandidate, buildRecipeFingerprint, type RecipeTrace } from '@ca/recipes';
import type { EventDraft } from '@ca/storage';
import type { ModeRuntime } from './runtime-manager';
import { createArtifactAccess, createObjectWriter, createSourceReader } from './tool-ports';
import { fail } from './errors';

const VALIDATOR_VERSION = 'deterministic-validator-1';
const PARSER_VERSION = 'tools-parser-1';

export interface RecipeTraceSource {
  trace: RecipeTrace | null;
  reason: string | null;
}

/** Build a bounded execution trace from persisted run data (no model invented steps). */
export async function buildRecipeTrace(runtime: ModeRuntime, runId: string): Promise<RecipeTraceSource> {
  const run = await runtime.storage.getRun(runId);
  if (!run) return { trace: null, reason: '运行不存在' };
  const task = await runtime.storage.getTask(run.taskId);
  if (!task) return { trace: null, reason: '任务不存在' };
  const steps = await runtime.storage.listSteps(runId);
  const invocations = await runtime.storage.listToolInvocations(runId);
  const aggregate = await runtime.storage.getTaskAggregate(run.taskId);
  if (!aggregate) return { trace: null, reason: '任务成果不存在' };
  const module = aggregate.modules.find((m) => m.id === run.moduleId);
  if (!module) return { trace: null, reason: '目标模块不存在' };
  const accepted = module.acceptedVersionId ? await runtime.storage.getVersion(module.acceptedVersionId) : null;
  const patch = (await runtime.storage.listPatches(run.taskId)).find((p) => p.runId === runId);
  const producedContent = patch?.candidate ?? accepted?.content ?? null;
  const traceSteps = steps.map((step) => {
    const invocation = invocations.find((i) => i.stepId === step.id);
    // Recipes extraction recovers declarative operators from the tool invocation
    // arguments; step summaries alone are rejected as insufficient.
    let inputSummary = '{}';
    if (step.kind === 'tool' && invocation) {
      inputSummary = invocation.argumentsJson;
    } else if (step.kind === 'model') {
      inputSummary = JSON.stringify({ maxOutputTokens: 1024 });
    }
    return {
      kind: step.kind,
      title: step.title,
      toolId: invocation?.toolId ?? null,
      inputSummary,
      outputSummary: (invocation?.resultSummary ?? step.summary).slice(0, 500),
      outputObjectHash: invocation?.resultObjectHash ?? null,
      startedAt: step.startedAt ?? step.finishedAt ?? run.createdAt,
      finishedAt: step.finishedAt ?? step.startedAt ?? run.updatedAt,
    };
  });
  const sources = await runtime.storage.listSources(task.id);
  return {
    trace: {
      runId: run.id,
      taskId: task.id,
      moduleId: module.id,
      moduleKind: module.kind,
      steps: traceSteps,
      sourceRefs: sources.map((s) => ({ sourceId: s.id, version: s.version })),
      acceptedVersion: accepted,
      producedContent,
    },
    reason: null,
  };
}

export interface ProposeRecipeInput {
  runId: string;
  name: string;
  description: string;
  kind: 'deterministic' | 'llm_assisted' | 'cached_snapshot';
  applicability: string;
}

export async function proposeRecipe(runtime: ModeRuntime, input: ProposeRecipeInput) {
  const { trace, reason } = await buildRecipeTrace(runtime, input.runId);
  if (!trace) throw fail.validationFailed(reason ?? '无法读取运行轨迹');
  try {
    const proposal = extractRecipeCandidate(trace, {
      name: input.name,
      kind: input.kind,
      description: input.description,
      applicability: input.applicability,
    });
    return { proposal, traceStepCount: trace.steps.length };
  } catch (error) {
    throw fail.validationFailed(`无法从该运行提取可执行配方：${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface RegisterRecipeResult {
  recipe: Recipe;
  events: EventDraft[];
}

/** Register a reviewed proposal as a candidate recipe (never auto-validated). */
export async function registerRecipe(
  runtime: ModeRuntime,
  proposal: RecipeProposalInput,
): Promise<RegisterRecipeResult> {
  const run = await runtime.storage.getRun(proposal.runId);
  if (!run) throw fail.notFound('来源运行');
  const task = await runtime.storage.getTask(run.taskId);
  if (!task) throw fail.notFound('来源任务');
  const toolVersions: Record<string, string> = {};
  for (const descriptor of runtime.tools.descriptors()) toolVersions[descriptor.id] = descriptor.version;
  const pins = {
    toolVersions,
    promptHashes: {} as Record<string, string>,
    validatorVersion: VALIDATOR_VERSION,
    parserVersion: PARSER_VERSION,
  };
  const built = buildRecipeFingerprint({ steps: proposal.steps }, pins);
  const now = utcNow();
  const recipe: Recipe = {
    id: newRecipeId(),
    version: 1,
    name: proposal.name,
    description: proposal.description,
    kind: proposal.kind,
    status: 'candidate',
    dslVersion: RECIPE_DSL_VERSION,
    inputParameters: proposal.inputParameters,
    steps: proposal.steps,
    outputArtifactKind: proposal.kind === 'deterministic' ? proposal.steps
      .map((step) => (step.kind === 'emit_artifact' ? step.moduleKind : null))
      .find((kind): kind is Recipe['outputArtifactKind'] => kind !== null) ?? 'csv' : 'csv',
    validators: proposal.testCases.length ? [] : [],
    permissions: {
      tools: ['source.read', 'source.search', 'data.profile', 'data.transform', 'artifact.read'],
      scopes: ['sources:read', 'data:profile', 'data:transform', 'artifact:read'],
      allowModelCalls: proposal.kind !== 'deterministic',
      maxModelCallsPerRun: proposal.kind === 'deterministic' ? 0 : 8,
    },
    budget: {
      maxModelCalls: proposal.kind === 'deterministic' ? 0 : 8,
      maxToolCalls: 20,
      maxRuntimeMs: 60_000,
    },
    testCases: proposal.testCases,
    fingerprint: built.fingerprint,
    fingerprintInputs: built.fingerprintInputs,
    sourceRunId: run.id,
    sourceTaskId: task.id,
    sourceModuleId: run.moduleId,
    applicability: proposal.applicability,
    staleReason: null,
    createdAt: now,
    updatedAt: now,
  };
  await runtime.storage.insertRecipe(recipe);
  return {
    recipe,
    events: [
      {
        runId: run.id,
        stepId: null,
        causationId: null,
        type: 'recipe.proposed',
        payload: { recipeId: recipe.id, version: recipe.version, kind: recipe.kind, name: recipe.name },
      },
    ],
  };
}

export class RecipeService {
  constructor(private readonly runtime: ModeRuntime) {}

  private executionDeps() {
    return {
      sources: createSourceReader(this.runtime.storage),
      artifacts: createArtifactAccess(this.runtime.storage),
      objects: createObjectWriter(this.runtime.storage),
      validator: this.runtime.validator,
      now: () => utcNow(),
      runModelStep: async () => {
        throw new Error('llm_assisted 配方执行在 P0 中未启用；请使用 deterministic 配方或等待 Live 运行');
      },
    };
  }

  async validate(recipe: Recipe, testInputs: Array<{ testCaseId: string; inputs: JsonObject }>) {
    const inputsByCase: Record<string, JsonObject> = {};
    for (const item of testInputs) inputsByCase[item.testCaseId] = item.inputs;
    const runtime = createRecipeRuntime({
      deps: this.executionDeps(),
      toolVersions: Object.fromEntries(this.runtime.tools.descriptors().map((d) => [d.id, d.version])),
      promptHashes: {},
      validatorVersion: VALIDATOR_VERSION,
      parserVersion: PARSER_VERSION,
    });
    const updated = await runtime.validate(recipe, recipe.testCases, inputsByCase);
    const changed: Recipe = {
      ...updated,
      updatedAt: utcNow(),
    };
    await this.runtime.storage.updateRecipe(changed);
    const events: EventDraft[] = [];
    if (changed.status === 'validated' && recipe.status !== 'validated') {
      events.push({
        runId: changed.sourceRunId,
        stepId: null,
        causationId: null,
        type: 'recipe.validated',
        payload: {
          recipeId: changed.id,
          version: changed.version,
          fingerprint: changed.fingerprint,
          testSummary: changed.staleReason ?? `${changed.testCases.length} 个测试用例执行完成`,
          testCases: changed.testCases.length,
        },
      });
    }
    return { recipe: changed, events };
  }

  async run(
    recipe: Recipe,
    inputs: JsonObject,
    commandId: string,
  ): Promise<{ run: Run; result: RecipeRunResult; events: EventDraft[]; patchId: string }> {
    if (recipe.status !== 'validated') {
      throw fail.stateNotAllowed(`配方状态为 ${recipe.status}，只有 validated 配方可以直接运行`);
    }
    const task = await this.runtime.storage.getTask(recipe.sourceTaskId);
    if (!task) throw fail.notFound('配方来源任务');
    const aggregate = await this.runtime.storage.getTaskAggregate(task.id);
    if (!aggregate) throw fail.notFound('任务成果');
    const module =
      aggregate.modules.find((m) => m.id === recipe.sourceModuleId) ??
      aggregate.modules.find((m) => m.kind === recipe.outputArtifactKind);
    if (!module) throw fail.validationFailed('找不到可写入的模块');
    const now = utcNow();
    const runId = newRunId();
    const baseVersion = module.acceptedVersionId ? await this.runtime.storage.getVersion(module.acceptedVersionId) : null;
    const run: Run = {
      id: runId,
      taskId: task.id,
      moduleId: module.id,
      mode: this.runtime.mode,
      origin: 'recipe',
      state: 'RUNNING',
      planVersion: 0,
      contextSnapshotId: null,
      budgetPolicy: { ...DEFAULT_BUDGET_POLICY, maxModelRequests: Math.max(1, recipe.budget.maxModelCalls), maxToolCalls: recipe.budget.maxToolCalls },
      budgetUsage: createBudgetUsage(now),
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
      startedAt: now,
      finishedAt: null,
    };
    await this.runtime.storage.insertRun(run);
    const events: EventDraft[] = [
      {
        runId,
        stepId: null,
        causationId: commandId,
        type: 'run.created',
        payload: {
          runId,
          taskId: task.id,
          moduleId: module.id,
          origin: 'recipe',
          baseVersionId: baseVersion?.id ?? null,
          budget: { maxModelRequests: run.budgetPolicy.maxModelRequests, maxToolCalls: run.budgetPolicy.maxToolCalls },
        },
      },
      {
        runId,
        stepId: null,
        causationId: commandId,
        type: 'recipe.run_started',
        payload: { recipeId: recipe.id, version: recipe.version, runId, cached: false },
      },
      {
        runId,
        stepId: null,
        causationId: commandId,
        type: 'run.state_changed',
        payload: { from: 'CREATED', to: 'RUNNING', reason: '配方运行开始' },
      },
    ];

    const runtime = createRecipeRuntime({
      deps: this.executionDeps(),
      toolVersions: Object.fromEntries(this.runtime.tools.descriptors().map((d) => [d.id, d.version])),
      promptHashes: {},
      validatorVersion: VALIDATOR_VERSION,
      parserVersion: PARSER_VERSION,
    });
    let result: RecipeRunResult;
    try {
      result = await runtime.run(recipe, {
        taskId: task.id,
        runId,
        moduleId: module.id,
        params: inputs as Record<string, unknown>,
        signal: new AbortController().signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failRun(run, commandId, message, events);
      throw fail.validationFailed(`配方执行失败：${message}`);
    }

    // Output becomes a draft patch through the same validation path as model output.
    const output = result.outputs[0];
    if (!output) {
      await this.failRun(run, commandId, '配方没有产生输出', events);
      throw fail.validationFailed('配方没有产生输出');
    }
    const object = await this.runtime.storage.objects.get(output.objectHash);
    if (!object) {
      await this.failRun(run, commandId, '配方输出对象丢失', events);
      throw fail.internal('配方输出对象丢失');
    }
    // emit_artifact writes canonical ModuleContent JSON; decode it strictly.
    let candidateContent: import('@ca/contracts').ModuleContent;
    try {
      candidateContent = deserializeModuleContent(object.bytes);
    } catch (error) {
      await this.failRun(run, commandId, `配方输出不是合法模块内容：${error instanceof Error ? error.message : String(error)}`, events);
      throw fail.validationFailed('配方输出不是合法模块内容');
    }
    const validation: ValidationReport = await this.runtime.validator.validate({
      taskId: task.id,
      runId,
      moduleId: module.id,
      candidate: candidateContent,
      evidenceRefs: [],
      baseVersion,
    });
    const artifacts = createArtifactAccess(this.runtime.storage);
    const { patch } = await artifacts.saveProposal({
      taskId: task.id,
      runId,
      moduleId: module.id,
      baseVersionId: baseVersion?.id ?? null,
      operations: [{ kind: 'replace_module', content: candidateContent }],
      evidenceRefs: [],
      description: `配方「${recipe.name}」v${recipe.version} 生成（${recipe.kind}）`,
      candidate: candidateContent,
      validation,
    });
    const finished = utcNow();
    await this.runtime.storage.updateRun(
      {
        ...run,
        state: 'AWAITING_REVIEW',
        revision: run.revision + 2,
        budgetUsage: {
          ...run.budgetUsage,
          modelRequests: result.llmCalls,
          toolCalls: result.toolCalls,
          elapsedActiveMs: result.durationMs,
          updatedAt: finished,
        },
        updatedAt: finished,
        finishedAt: null,
      },
      run.revision,
    );
    events.push(
      {
        runId,
        stepId: null,
        causationId: commandId,
        type: 'artifact.patch_proposed',
        payload: {
          patchId: patch.id,
          moduleId: module.id,
          baseVersionId: baseVersion?.id ?? null,
          candidateHash: patch.candidateHash,
          validationReportId: validation.id,
          changeSummary: patch.changeSummary,
        },
      },
      {
        runId,
        stepId: null,
        causationId: commandId,
        type: 'validation.completed',
        payload: {
          validationReportId: validation.id,
          moduleId: module.id,
          status: validation.status,
          checks: validation.checks,
          summary: validation.summary,
        },
      },
      {
        runId,
        stepId: null,
        causationId: commandId,
        type: 'run.state_changed',
        payload: { from: 'RUNNING', to: 'AWAITING_REVIEW', reason: '配方生成候选草稿，等待接受' },
      },
      {
        runId,
        stepId: null,
        causationId: commandId,
        type: 'usage.updated',
        payload: {
          modelRequests: result.llmCalls,
          toolCalls: result.toolCalls,
          inputTokens: 0,
          outputTokens: 0,
          estimated: true,
          usdCost: null,
        },
      },
    );
    return { run: { ...run, state: 'AWAITING_REVIEW' }, result, events, patchId: patch.id };
  }

  private async failRun(run: Run, commandId: string, message: string, events: EventDraft[]): Promise<void> {
    const now = utcNow();
    await this.runtime.storage.updateRun({ ...run, state: 'FAILED', error: { code: 'recipe_error', message, retryable: false, stage: 'execution', details: '' }, updatedAt: now, finishedAt: now }, run.revision);
    events.push(
      { runId: run.id, stepId: null, causationId: commandId, type: 'run.failed', payload: { runId: run.id, error: { code: 'recipe_error', message, retryable: false, stage: 'execution' }, draftPreserved: true, acceptedVersionUnchanged: true } },
      { runId: run.id, stepId: null, causationId: commandId, type: 'run.state_changed', payload: { from: 'RUNNING', to: 'FAILED', reason: message } },
    );
    await this.runtime.storage.appendEvents(run.taskId, events);
  }
}

function parseCsvContent(text: string): import('@ca/contracts').CsvContent {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const header = splitCsvLine(lines[0] ?? '');
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string | number | boolean | null> = {};
    header.forEach((key, index) => {
      row[slugColumn(key)] = cells[index] ?? '';
    });
    return row;
  });
  return {
    kind: 'csv',
    columns: header.map((key) => ({ key: slugColumn(key), label: key, type: 'string', required: false })),
    rows,
  };
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function slugColumn(key: string): string {
  const slug = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || `col_${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

export { newArtifactVersionId };
