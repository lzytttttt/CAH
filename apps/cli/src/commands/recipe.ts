/** `recipe` commands: save (server extraction or explicit proposal), validate, run. */
import {
  API_ROUTES,
  CreateRecipeRequestSchema,
  CreateRecipeResponseSchema,
  ProposeRecipeRequestSchema,
  ProposeRecipeResponseSchema,
  RECIPE_KINDS,
  RecipeIdSchema,
  RunIdSchema,
  RunRecipeRequestSchema,
  RunRecipeResponseSchema,
  ValidateRecipeRequestSchema,
  ValidateRecipeResponseSchema,
  canRunRecipe,
  recipeKindConsistencyErrors,
  type CreateRecipeResponse,
  type ProposeRecipeResponse,
  type Recipe,
  type ValidateRecipeResponse,
} from '@ca/contracts';
import { UsageError } from '../exit';
import {
  heading,
  recipeKindLabel,
  recipeStatusLabel,
  renderRecipe,
  renderRecipeRunResult,
  runStateLabel,
} from '../format';
import { readJsonInput } from '../io';
import type { CliOutcome, CommandSpec } from './types';
import {
  businessOutcome,
  commandId,
  getRecipe,
  getRunDetail,
  okOutcome,
  parseId,
  pollRun,
  runBusinessState,
  shouldStopRunWatch,
  stateError,
  validateRequest,
} from './shared';

/* ------------------------------------------------------------------ */
/* recipe save                                                         */
/* ------------------------------------------------------------------ */

export const recipeSaveCommand: CommandSpec = {
  path: 'recipe save',
  summary: '把已成功运行保存为候选配方（服务端从运行轨迹提取；也可提交显式 proposal）',
  flags: {
    '--run-id': { type: 'string', valueName: '<runId>', description: '来源运行 ID（提取模式必填）' },
    '--name': { type: 'string', valueName: '<名称>', description: '配方名称（提取模式必填）' },
    '--kind': {
      type: 'string',
      valueName: '<kind>',
      choices: RECIPE_KINDS,
      description: `配方类型：${RECIPE_KINDS.join(' / ')}（提取模式必填；deterministic 不得包含模型调用）`,
    },
    '--description': { type: 'string', valueName: '<描述>', description: '配方描述' },
    '--applicability': { type: 'string', valueName: '<适用范围>', description: '适用范围说明' },
    '--proposal': { type: 'string', valueName: '<文件|JSON>', description: '直接提交完整 RecipeProposalInput（跳过服务端提取）' },
  },
  positionals: [],
  examples: [
    'cognitive-atrium recipe save --run-id <runId> --name "反馈归类流程" --kind llm_assisted',
    'cognitive-atrium recipe save --proposal ./proposal.json --run-id <runId>',
  ],
  notes: ['保存得到的是候选配方；只有 validate 通过后才可以 run。'],
  execute: async (command, ctx) => {
    const proposalFile = command.getString('--proposal');
    let proposal: unknown;
    let proposeResponse: ProposeRecipeResponse | null = null;
    let proposeRequest: unknown = null;
    if (proposalFile !== undefined) {
      const raw = await readJsonInput(ctx.cwd, proposalFile, '配方 proposal');
      const runId = command.getString('--run-id');
      proposal =
        runId !== undefined && raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>), runId }
          : raw;
    } else {
      const runId = parseId(command.requireString('--run-id', '来源运行 ID'), RunIdSchema, 'runId');
      const name = command.requireString('--name', '配方名称');
      const kind = command.requireString('--kind', `配方类型：${RECIPE_KINDS.join('/')}`);
      proposeRequest = validateRequest(
        ProposeRecipeRequestSchema,
        {
          commandId: commandId(ctx),
          runId,
          name,
          description: command.getString('--description') ?? '',
          kind,
          applicability: command.getString('--applicability') ?? '',
        },
        '配方提取请求',
      );
      proposeResponse = await ctx.client.post(ProposeRecipeResponseSchema, API_ROUTES.recipePropose, proposeRequest);
      proposal = proposeResponse.proposal;
    }
    const createRequest = validateRequest(
      CreateRecipeRequestSchema,
      { commandId: commandId(ctx), proposal },
      '配方 proposal',
    );
    const response = await ctx.client.post(CreateRecipeResponseSchema, API_ROUTES.recipes, createRequest);
    const human = renderSaveResult(response, proposeResponse);
    return okOutcome('recipe save', { proposal, propose: proposeResponse, recipe: response }, human);
  },
};

function renderSaveResult(response: CreateRecipeResponse, propose: ProposeRecipeResponse | null): string[] {
  const recipe = response.recipe;
  const lines = [
    heading('配方已保存为候选'),
    `  配方：${recipe.id} v${response.version}（${recipe.name}）`,
    `  类型：${recipeKindLabel(recipe.kind)}   状态：${recipeStatusLabel(response.status)}`,
    `  指纹：${recipe.fingerprint}`,
    ...(propose ? [`  服务端从运行 ${propose.sourceRunId} 的 ${propose.traceStepCount} 个步骤提取 proposal`] : []),
    `  步骤 ${recipe.steps.length} 个 · 输入参数 ${recipe.inputParameters.length} 个 · 测试用例 ${recipe.testCases.length} 个`,
  ];
  const errors = recipeKindConsistencyErrors(recipe);
  if (errors.length) {
    lines.push('  警告：');
    for (const error of errors) lines.push(`    - ${error}`);
  }
  lines.push('  下一步：');
  lines.push(`    验证配方：cognitive-atrium recipe validate ${recipe.id} --test-inputs ./test-inputs.json`);
  return lines;
}

/* ------------------------------------------------------------------ */
/* recipe validate                                                     */
/* ------------------------------------------------------------------ */

export const recipeValidateCommand: CommandSpec = {
  path: 'recipe validate',
  summary: '用固定测试输入运行配方测试；通过后配方注册为 validated 才可运行',
  flags: {
    '--test-inputs': {
      type: 'string',
      valueName: '<文件|JSON>',
      description: '测试输入：JSON 数组 [{testCaseId, inputs}] 或 {"testInputs":[...]}（必填）',
    },
  },
  positionals: [{ name: 'recipeId', description: '配方 ID', required: true }],
  examples: ['cognitive-atrium recipe validate <recipeId> --test-inputs ./test-inputs.json'],
  execute: async (command, ctx) => {
    const recipeId = parseId(command.requirePositional(0, 'recipeId'), RecipeIdSchema, 'recipeId');
    const raw = await readJsonInput(
      ctx.cwd,
      command.requireString('--test-inputs', '测试输入 JSON'),
      '测试输入',
    );
    const testInputs = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { testInputs?: unknown }).testInputs) ? (raw as { testInputs: unknown }).testInputs : raw;
    const request = validateRequest(
      ValidateRecipeRequestSchema,
      { commandId: commandId(ctx), testInputs },
      '配方验证请求',
    );
    const response = await ctx.client.post(ValidateRecipeResponseSchema, API_ROUTES.recipeValidate(recipeId), request);
    return validateOutcome(response);
  },
};

function validateOutcome(response: ValidateRecipeResponse): CliOutcome {
  const passed = response.testCases.filter((testCase) => testCase.status === 'passed').length;
  const failed = response.testCases.filter((testCase) => testCase.status === 'failed');
  const human = [
    heading(`配方验证 ${response.recipeId} v${response.version}`),
    `  状态：${recipeStatusLabel(response.status)}`,
    `  测试用例 ${response.testCases.length} 个：通过 ${passed} / 未通过 ${failed.length}`,
  ];
  for (const testCase of response.testCases) {
    human.push(
      `    - [${testCase.kind}/${testCase.expectation}] ${testCase.label}：${testCase.status}` +
        (testCase.detail ? ` — ${testCase.detail}` : '') +
        (testCase.normalizedOutputHash ? ` 输出哈希 ${testCase.normalizedOutputHash}` : ''),
    );
  }
  if (response.status === 'validated' && failed.length === 0) {
    human.push('  下一步：', `    cognitive-atrium recipe run ${response.recipeId} --inputs ./inputs.json`);
    return okOutcome('recipe validate', response, human);
  }
  human.push('  结论：配方未通过验证，不能运行。');
  return businessOutcome('recipe validate', response, human, {
    exitCode: 4,
    status: 'failed',
    error: {
      kind: 'api',
      code: 'recipe_validation_failed',
      message:
        failed.length > 0
          ? `${failed.length} 个测试用例失败：${failed.map((testCase) => testCase.label).join('、')}`
          : `配方状态为 ${response.status}，未达到 validated`,
      details: failed.map((testCase) => ({ id: testCase.id, detail: testCase.detail })),
    },
  });
}

/* ------------------------------------------------------------------ */
/* recipe run                                                          */
/* ------------------------------------------------------------------ */

export const recipeRunCommand: CommandSpec = {
  path: 'recipe run',
  summary: '用新输入运行已验证配方，输出确定性/LLM 辅助的真实调用账本',
  flags: {
    '--inputs': { type: 'string', valueName: '<文件|JSON>', description: '输入参数 JSON 对象（或 {"inputs":{...}}），必填' },
    '--expected-revision': { type: 'number', valueName: '<n>', description: '显式指定期望的修订号' },
    '--wait': { type: 'boolean', description: '等待运行结束并输出结果（进度输出到 stderr）' },
    '--interval': { type: 'number', valueName: '<ms>', description: '--wait 轮询间隔毫秒（默认 1000）' },
  },
  positionals: [{ name: 'recipeId', description: '配方 ID', required: true }],
  examples: ['cognitive-atrium recipe run <recipeId> --inputs ./inputs.json', 'cognitive-atrium recipe run <recipeId> --inputs ./inputs.json --wait --json'],
  notes: ['只有 validated 状态的配方可以运行；deterministic 配方的调用账本必须显示 0 次 LLM 调用。'],
  execute: async (command, ctx) => {
    const recipeId = parseId(command.requirePositional(0, 'recipeId'), RecipeIdSchema, 'recipeId');
    const recipe = await getRecipe(ctx, recipeId);
    if (!canRunRecipe(recipe.status)) {
      throw stateError(
        `配方 ${recipeId} 当前状态为 ${recipeStatusLabel(recipe.status)}，只有 validated 状态可以运行`,
        `先执行：cognitive-atrium recipe validate ${recipeId} --test-inputs ./test-inputs.json`,
        'recipe_not_validated',
      );
    }
    const raw = await readJsonInput(ctx.cwd, command.requireString('--inputs', '输入参数 JSON'), '配方输入');
    const inputs = raw && typeof raw === 'object' && !Array.isArray(raw) && 'inputs' in raw ? (raw as { inputs: unknown }).inputs : raw;
    const expectedRevision = command.getNumber('--expected-revision');
    const request = validateRequest(
      RunRecipeRequestSchema,
      {
        commandId: commandId(ctx),
        inputs,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
      '配方运行请求',
    );
    const response = await ctx.client.post(RunRecipeResponseSchema, API_ROUTES.recipeRun(recipeId), request);
    let human: string[];
    let detail = null as Awaited<ReturnType<typeof getRunDetail>> | null;
    if (response.result) {
      human = renderRecipeRunResult(response.result, response.cacheState);
      const mismatch = recipe.kind === 'deterministic' && response.result.llmCalls > 0;
      if (mismatch) {
        human.push('  错误：deterministic 配方的调用账本出现 LLM 调用，结果不可信（应重新验证配方）。');
        return businessOutcome(
          'recipe run',
          { run: response, recipe },
          human,
          {
            exitCode: 4,
            status: 'failed',
            error: {
              kind: 'api',
              code: 'recipe_llm_accounting_mismatch',
              message: `deterministic 配方出现 ${response.result.llmCalls} 次 LLM 调用（AC-12 要求为 0）`,
            },
          },
        );
      }
      human.push(`  Web 工作台：${ctx.client.baseUrl}/?task=${recipe.sourceTaskId}`);
      return okOutcome('recipe run', { run: response, recipe }, human);
    }
    if (command.getBool('--wait')) {
      const interval = Math.max(50, command.getNumber('--interval') ?? 1000);
      ctx.log(`[wait] 配方运行已排队/执行中：${response.runId}`);
      detail = await pollRun(ctx, response.runId, {
        intervalMs: interval,
        timeoutMs: ctx.globals.timeoutMs,
        shouldStop: shouldStopRunWatch,
        onUpdate: (current) => ctx.log(`[wait] ${current.run.state}`),
      });
      const state = runBusinessState(detail);
      human = [
        heading(`配方运行 ${response.runId}`),
        `  配方：${recipeId}（${recipeKindLabel(recipe.kind)}）`,
        `  执行方式：${response.cacheState === 'cache_hit' ? '命中缓存' : '实际执行'}`,
        `  运行状态：${runStateLabel(detail.run.state)}`,
      ];
      if (state.exitCode !== 0) {
        human.push('  运行没有成功结束；配方结果不可用。');
        if (state.waitingForInput) human.push(`  阻塞 ${state.waitingForInput.blockers.length} 个，请用 run status ${response.runId} 查看。`);
        return businessOutcome('recipe run', { run: response, recipe, detail }, human, state);
      }
      human.push(`  查看运行：cognitive-atrium run status ${response.runId}`);
      return okOutcome('recipe run', { run: response, recipe, detail }, human);
    }
    human = [
      heading(`配方运行已开始 ${response.runId}`),
      `  配方：${recipeId}（${recipeKindLabel(recipe.kind)}）`,
      `  执行方式：${response.cacheState === 'cache_hit' ? '命中缓存' : '实际执行'}`,
      '  结果尚未生成；使用 --wait 等待，或稍后查看运行状态。',
      '  下一步：',
      `    cognitive-atrium run status ${response.runId} --watch`,
    ];
    return okOutcome('recipe run', { run: response, recipe, detail }, human);
  },
};

export const recipeCommands: CommandSpec[] = [recipeSaveCommand, recipeValidateCommand, recipeRunCommand];
