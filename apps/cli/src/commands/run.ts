/** `run` commands: start, status, commit, resolve, pause, resume, cancel. */
import {
  API_ROUTES,
  CANCELLABLE_RUN_STATES,
  CommitPlanRequestSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  PAUSABLE_RUN_STATES,
  ResolveInputRequestSchema,
  RunControlRequestSchema,
  RunControlResponseSchema,
  RunIdSchema,
  SourceIdSchema,
  TaskIdSchema,
  TERMINAL_RUN_STATES,
  validateBlockResolution,
  type CreateRunResponse,
  type ResolutionOption,
  type RunControlResponse,
  type RunDetailResponse,
} from '@ca/contracts';
import { EXIT, UsageError } from '../exit';
import {
  formatBudgetUsage,
  heading,
  renderPlan,
  renderRunDetail,
  runProgress,
} from '../format';
import { readJsonInput, readTextFile } from '../io';
import type { CommandSpec } from './types';
import {
  businessOutcome,
  commandId,
  currentTaskRevision,
  describeOutcomeError,
  getRunDetail,
  getSnapshot,
  okOutcome,
  openBlockers,
  parseId,
  pollRun,
  renderWaitingSummary,
  resolveModuleId,
  runBusinessState,
  shouldStopRunWatch,
  stateError,
  tryParseId,
  validateRequest,
  type BusinessState,
} from './shared';

/* ------------------------------------------------------------------ */
/* run start                                                           */
/* ------------------------------------------------------------------ */

export const runStartCommand: CommandSpec = {
  path: 'run start',
  summary: '为任务模块创建运行；默认先请求计划（planFirst），待审阅后再 commit',
  flags: {
    '--module': { type: 'string', valueName: '<moduleId|标题>', description: '目标模块 ID 或标题（只有一个模块时可省略）' },
    '--intent': { type: 'string', valueName: '<意图>', description: '本次工作要求（必填）' },
    '--plan-first': { type: 'boolean', default: true, description: '先生成可审阅计划（默认开启；--no-plan-first 直接执行）' },
    '--source': { type: 'list', valueName: '<sourceId>', description: '绑定到本次运行的资料 ID，可重复' },
    '--budget-file': { type: 'string', valueName: '<文件|JSON>', description: '预算覆盖项（BudgetPolicy 的 JSON 对象）' },
    '--expected-revision': { type: 'number', valueName: '<n>', description: '显式指定期望的任务修订号（默认现场读取快照）' },
    '--wait': { type: 'boolean', description: '等待计划生成/进入等待输入后再返回（进度输出到 stderr）' },
    '--interval': { type: 'number', valueName: '<ms>', description: '--wait 轮询间隔毫秒（默认 500）' },
  },
  positionals: [{ name: 'taskId', description: '任务 ID', required: true }],
  examples: [
    'cognitive-atrium run start <taskId> --module <moduleId> --intent "根据资料补齐交付物"',
    'cognitive-atrium run start <taskId> --module <moduleId> --intent "..." --wait --json',
  ],
  execute: async (command, ctx) => {
    const taskId = parseId(command.requirePositional(0, 'taskId'), TaskIdSchema, 'taskId');
    const intent = command.requireString('--intent', '本次工作要求');
    const snapshot = await getSnapshot(ctx, taskId);
    const moduleId = resolveModuleId(snapshot.modules.map((view) => ({ id: view.module.id, title: view.module.title })), command.getString('--module'));
    const sourceIds = command.getList('--source').map((value) => parseId(value, SourceIdSchema, '--source'));
    const budgetFile = command.getString('--budget-file');
    const budgetOverrides = budgetFile === undefined ? undefined : await readJsonInput(ctx.cwd, budgetFile, '预算覆盖项');
    const expectedRevision = command.getNumber('--expected-revision') ?? snapshot.task.revision;
    const request = validateRequest(
      CreateRunRequestSchema,
      {
        commandId: commandId(ctx),
        expectedRevision,
        moduleId,
        intent,
        planFirst: command.getBool('--plan-first'),
        ...(budgetOverrides === undefined ? {} : { budgetOverrides }),
        ...(sourceIds.length ? { sourceIds } : {}),
      },
      '运行创建请求',
    );
    const response = await ctx.client.post(CreateRunResponseSchema, API_ROUTES.taskRuns(taskId), request);
    const shouldWait = command.getBool('--wait');
    let detail: RunDetailResponse | null = null;
    if (shouldWait && needsPlanningWait(response)) {
      const interval = Math.max(50, command.getNumber('--interval') ?? 500);
      detail = await pollRun(ctx, response.runId, {
        intervalMs: interval,
        timeoutMs: ctx.globals.timeoutMs,
        shouldStop: runStartSettled,
        onUpdate: (current) => ctx.log(`[wait] ${runWatchLine(current)}`),
      });
      ctx.log(`[wait] 规划阶段结束：${runWatchLine(detail)}`);
    } else if (response.state === 'AWAITING_INPUT' || (response.state === 'PLANNING' && response.plan === null && !shouldWait)) {
      detail = await getRunDetail(ctx, response.runId);
    }
    const human = renderRunStart(response, detail);
    const state = detail ? runBusinessState(detail) : stateFromRunResponse(response);
    if (state.waitingForInput) human.push(...renderWaitingSummary(state.waitingForInput));
    return businessOutcome('run start', { run: response, detail }, human, state);
  },
};

function needsPlanningWait(response: CreateRunResponse): boolean {
  return response.state === 'PLANNING' || response.state === 'CREATED' || response.plan === null;
}

function runStartSettled(detail: RunDetailResponse): boolean {
  if (detail.plan !== null) return true;
  if (openBlockers(detail.blockers).length > 0) return true;
  return !['CREATED', 'PLANNING'].includes(detail.run.state);
}

function runWatchLine(detail: RunDetailResponse): string {
  const progress = runProgress(detail);
  return (
    `${detail.run.state}` +
    (progress.totalSteps ? ` 步骤 ${progress.completedSteps}/${progress.totalSteps}` : '') +
    (progress.runningStep ? ` 进行中：${progress.runningStep}` : '') +
    (openBlockers(detail.blockers).length ? ` 阻塞 ${openBlockers(detail.blockers).length}` : '')
  );
}

function renderRunStart(response: CreateRunResponse, detail: RunDetailResponse | null): string[] {
  const state = detail?.run.state ?? response.state;
  const lines = [heading('运行已创建'), `  运行：${response.runId}`, `  状态：${state}`, `  任务修订：${response.revision}`];
  const plan = detail?.plan ?? response.plan;
  if (plan) {
    lines.push(...renderPlan(plan, '  '));
    const blocking = plan.risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null);
    if (blocking.length > 0) lines.push(`  注意：计划仍有 ${blocking.length} 个阻止提交的风险，必须先处理（见上方风险与阻塞）。`);
  }
  if (detail) {
    lines.push(`  尝试：${detail.run.attempt}   预算：${formatBudgetUsage(detail.run.budgetUsage)}`);
    if (detail.steps.length) {
      const progress = runProgress(detail);
      lines.push(`  步骤：${progress.completedSteps}/${progress.totalSteps} 完成`);
    }
  }
  lines.push('  下一步：');
  if (state === 'READY') {
    lines.push(`    cognitive-atrium run commit ${response.runId}`);
    lines.push(`    cognitive-atrium run status ${response.runId} --watch`);
  } else if (state === 'PLANNING') {
    lines.push(`    cognitive-atrium run status ${response.runId} --watch`);
  } else if (state === 'AWAITING_INPUT') {
    lines.push(`    cognitive-atrium run status ${response.runId}`);
  } else {
    lines.push(`    cognitive-atrium run status ${response.runId} --watch`);
  }
  return lines;
}

function stateFromRunResponse(response: CreateRunResponse): BusinessState {
  switch (response.state) {
    case 'AWAITING_INPUT':
      return {
        exitCode: EXIT.WAITING_INPUT,
        status: 'waiting_for_input',
        error: { kind: 'api', code: 'waiting_for_input', message: '运行正在等待人工输入。' },
      };
    case 'FAILED':
    case 'CANCELLED':
    case 'INTERRUPTED':
      return {
        exitCode: EXIT.STATE,
        status: response.state === 'FAILED' ? 'failed' : response.state === 'CANCELLED' ? 'cancelled' : 'interrupted',
        error: { kind: 'api', code: `run_${response.state.toLowerCase()}`, message: `运行创建后立即进入 ${response.state} 状态，请用 run status 查看原因。` },
      };
    default:
      return { exitCode: EXIT.OK, status: 'ok' };
  }
}



/* ------------------------------------------------------------------ */
/* run status                                                          */
/* ------------------------------------------------------------------ */

export const runStatusCommand: CommandSpec = {
  path: 'run status',
  summary: '显示运行真实状态、步骤进度、预算、阻塞、验证与计划',
  flags: {
    '--watch': { type: 'boolean', description: '持续轮询直到进入终态/等待输入/待审阅（进度输出到 stderr）' },
    '--interval': { type: 'number', valueName: '<ms>', description: '轮询间隔毫秒（默认 1000）' },
  },
  positionals: [{ name: 'runId', description: '运行 ID', required: true }],
  examples: ['cognitive-atrium run status <runId>', 'cognitive-atrium run status <runId> --watch --json'],
  execute: async (command, ctx) => {
    const runId = parseId(command.requirePositional(0, 'runId'), RunIdSchema, 'runId');
    let detail = await getRunDetail(ctx, runId);
    if (command.getBool('--watch')) {
      const interval = Math.max(50, command.getNumber('--interval') ?? 1000);
      let lastLine = runWatchLine(detail);
      ctx.log(`[watch] ${lastLine}`);
      detail = await pollRun(ctx, runId, {
        intervalMs: interval,
        timeoutMs: ctx.globals.timeoutMs,
        shouldStop: shouldStopRunWatch,
        onUpdate: (current) => {
          const line = runWatchLine(current);
          if (line !== lastLine) {
            lastLine = line;
            ctx.log(`[watch] ${line}`);
          }
        },
      });
    }
    const state = runBusinessState(detail);
    const human = renderRunDetail(detail, { serverUrl: ctx.client.baseUrl });
    if (state.waitingForInput) human.push(...renderWaitingSummary(state.waitingForInput));
    return businessOutcome('run status', detail, human, state);
  },
};

/* ------------------------------------------------------------------ */
/* run commit                                                          */
/* ------------------------------------------------------------------ */

export const runCommitCommand: CommandSpec = {
  path: 'run commit',
  summary: '提交已审阅的计划（需要 planVersion、contextSnapshotId 与最新任务修订）',
  flags: {
    '--plan-version': { type: 'number', valueName: '<n>', description: '显式指定计划版本（默认读取运行详情中的当前计划）' },
    '--context-snapshot': { type: 'string', valueName: '<id>', description: '显式指定上下文快照 ID（默认读取运行详情）' },
    '--expected-revision': { type: 'number', valueName: '<n>', description: '显式指定期望的任务修订号（默认现场读取快照）' },
  },
  positionals: [{ name: 'runId', description: '运行 ID', required: true }],
  examples: ['cognitive-atrium run commit <runId>', 'cognitive-atrium run commit <runId> --plan-version 1 --context-snapshot <id> --json'],
  execute: async (command, ctx) => {
    const runId = parseId(command.requirePositional(0, 'runId'), RunIdSchema, 'runId');
    const detail = await getRunDetail(ctx, runId);
    if (detail.run.state !== 'READY') {
      throw stateError(
        `运行 ${runId} 当前状态为 ${detail.run.state}，只有 READY（计划已就绪）状态可以提交计划`,
        `请先用 run status ${runId} 查看真实状态与下一步操作。`,
      );
    }
    const planVersion = command.getNumber('--plan-version') ?? detail.plan?.version;
    if (planVersion === undefined) throw stateError(`运行 ${runId} 没有可提交的计划版本，无法提交`, `请重新规划：run start ... --wait`);
    const contextSnapshotId = command.getString('--context-snapshot') ?? detail.run.contextSnapshotId ?? detail.contextSnapshot?.id ?? null;
    if (!contextSnapshotId) {
      throw stateError(`运行 ${runId} 缺少上下文快照 ID，无法提交计划`, '计划提交必须绑定生成计划时使用的上下文快照。');
    }
    const expectedRevision = await currentTaskRevision(ctx, detail.run.taskId, command.getNumber('--expected-revision'));
    const request = validateRequest(
      CommitPlanRequestSchema,
      { commandId: commandId(ctx), expectedRevision, planVersion, contextSnapshotId },
      '计划提交请求',
    );
    const response = await ctx.client.post(RunControlResponseSchema, API_ROUTES.runCommit(runId), request);
    const human = [
      heading('计划已提交'),
      `  运行：${runId}`,
      `  计划版本：${planVersion}   上下文快照：${contextSnapshotId}`,
      `  当前状态：${response.state}${response.duplicate ? '（该命令此前已执行，服务端返回同一结果）' : ''}`,
      '  下一步：',
      `    cognitive-atrium run status ${runId} --watch`,
      `    cognitive-atrium events tail ${detail.run.taskId} --run ${runId}`,
    ];
    return okOutcome('run commit', { control: response, run: detail }, human);
  },
};

/* ------------------------------------------------------------------ */
/* run resolve                                                         */
/* ------------------------------------------------------------------ */

export const runResolveCommand: CommandSpec = {
  path: 'run resolve',
  summary: '回答运行阻塞（选择/文本/绑定资料/确认映射/排除）',
  flags: {
    '--blocker': { type: 'string', valueName: '<blockerId>', description: '阻塞 ID（必填，见 run status）' },
    '--option': { type: 'string', valueName: '<optionId>', description: '解决方式 ID（必填，见 run status 输出）' },
    '--value': { type: 'string', valueName: '<值|JSON>', description: '文本或 JSON 值；choose 时必须是选项值之一' },
    '--value-file': { type: 'string', valueName: '<文件>', description: '从文件读取文本值（多行文本用）' },
    '--source-id': { type: 'string', valueName: '<sourceId>', description: 'bind_source：绑定已上传的资料 ID' },
    '--source-version': { type: 'number', valueName: '<n>', description: 'bind_source：资料版本号（省略时取任务当前来源版本）' },
    '--note': { type: 'string', valueName: '<说明>', description: '决定备注' },
    '--expected-revision': { type: 'number', valueName: '<n>', description: '显式指定期望的任务修订号' },
  },
  positionals: [{ name: 'runId', description: '运行 ID', required: true }],
  examples: [
    'cognitive-atrium run resolve <runId> --blocker <blockerId> --option <optionId> --value "苏ICP备xxxx"',
    'cognitive-atrium run resolve <runId> --blocker <id> --option <id> --source-id <sourceId>',
  ],
  notes: ['输入会先按 contracts 的 resolution 规则校验；不满足选项要求时以退出码 1 结束，不会提交给服务端。'],
  execute: async (command, ctx) => {
    const runId = parseId(command.requirePositional(0, 'runId'), RunIdSchema, 'runId');
    const blockerId = command.requireString('--blocker', '阻塞 ID');
    const optionId = command.requireString('--option', '解决方式 ID');
    const detail = await getRunDetail(ctx, runId);
    const blocker = detail.blockers.find((item) => item.id === blockerId);
    if (!blocker) {
      const open = openBlockers(detail.blockers);
      throw stateError(
        `运行 ${runId} 中不存在阻塞 ${blockerId}`,
        open.length ? `当前开放阻塞：${open.map((item) => `${item.id}（${item.title}）`).join('、')}` : '当前没有开放阻塞；可能已被处理，请用 run status 查看。',
      );
    }
    if (blocker.status !== 'open') {
      throw stateError(`阻塞 ${blockerId} 当前状态为 ${blocker.status}，不需要重复回答`, `请用 run status ${runId} 查看最新状态。`);
    }
    const option = blocker.resolutions.find((item) => item.id === optionId);
    if (!option) {
      throw new UsageError(
        `阻塞 ${blockerId} 没有解决方式 ${optionId}`,
        `可选：${blocker.resolutions.map((item) => `${item.id}（${item.kind}：${item.label}）`).join('、')}`,
      );
    }
    const snapshot = await getSnapshot(ctx, detail.run.taskId);
    const expectedRevision = command.getNumber('--expected-revision') ?? snapshot.task.revision;
    const candidate = buildResolutionValue(option, command, ctx, snapshot.sources);
    const validation = validateBlockResolution(option, candidate);
    if (!validation.ok) {
      throw new UsageError(`输入不符合阻塞 ${blockerId} 的要求：${validation.error}`, resolutionUsage(option));
    }
    const request = validateRequest(
      ResolveInputRequestSchema,
      {
        commandId: commandId(ctx),
        expectedRevision,
        blockerId,
        optionId,
        value: validation.normalized,
        note: command.getString('--note') ?? '',
      },
      '阻塞回答请求',
    );
    const response = await ctx.client.post(RunControlResponseSchema, API_ROUTES.runResolve(runId), request);
    const fresh = await getRunDetail(ctx, runId);
    const state = runBusinessState(fresh);
    const human = [
      heading('阻塞回答已提交'),
      `  运行：${runId}   阻塞：${blockerId}（${blocker.title}）`,
      `  选择：${optionId}（${option.kind}）`,
      `  运行状态：${response.state}${response.duplicate ? '（该命令此前已执行，服务端返回同一结果）' : ''}`,
    ];
    if (state.waitingForInput) human.push(...renderWaitingSummary(state.waitingForInput));
    else human.push('  下一步：', `    cognitive-atrium run status ${runId} --watch`);
    if (state.error) human.push(...describeOutcomeError(state.error));
    return businessOutcome('run resolve', { control: response, run: fresh }, human, state);
  },
};

function resolutionUsage(option: ResolutionOption): string {
  switch (option.kind) {
    case 'choose':
      return `可选值：${option.options.map((choice) => `${choice.value}（${choice.label}）`).join(' / ')}`;
    case 'text':
      return `请用 --value "<文本>" 或 --value-file <文件> 提供内容（最多 ${option.maxChars} 字${option.required ? '，必填' : ''}）`;
    case 'bind_source':
      return '请用 --source-id <sourceId> [--source-version <n>] 绑定已上传资料';
    case 'confirm_mapping':
      return '请用 --value \'{"confirmed":true}\' 明确确认字段映射';
    case 'exclude':
      return '请用 --value \'{"itemRef":"<条目引用>"}\'（或省略 value 使用选项默认引用）';
  }
}

function buildResolutionValue(
  option: ResolutionOption,
  command: Parameters<CommandSpec['execute']>[0],
  ctx: Parameters<CommandSpec['execute']>[1],
  sources: ReadonlyArray<{ sourceId: string; version: number }>,
): unknown {
  const rawValue = command.getString('--value');
  const valueFile = command.getString('--value-file');
  switch (option.kind) {
    case 'choose': {
      if (rawValue === undefined) throw new UsageError('choose 类型阻塞需要通过 --value 选择一个选项值', resolutionUsage(option));
      return rawValue;
    }
    case 'text': {
      if (valueFile !== undefined) return readTextFile(ctx.cwd, valueFile, '文本值文件');
      if (rawValue !== undefined) return rawValue;
      if (!option.required) return '';
      throw new UsageError('text 类型阻塞需要提供 --value 或 --value-file', resolutionUsage(option));
    }
    case 'confirm_mapping': {
      if (rawValue === undefined) return { confirmed: true };
      const parsed = parseJsonOrString(rawValue);
      return parsed;
    }
    case 'exclude': {
      if (rawValue === undefined) return {};
      return parseJsonOrString(rawValue);
    }
    case 'bind_source': {
      if (rawValue !== undefined) return parseJsonOrString(rawValue);
      const sourceIdRaw = command.requireString('--source-id', '资料 ID');
      const sourceId = sourceIdRaw;
      const parsedSourceId = tryParseId(sourceId, SourceIdSchema);
      if (!parsedSourceId) throw new UsageError(`--source-id 不是合法 UUID：${sourceId}`);
      const explicitVersion = command.getNumber('--source-version');
      const version = explicitVersion ?? sources.find((source) => source.sourceId === parsedSourceId)?.version;
      if (version === undefined) {
        throw new UsageError(
          `资料 ${sourceId} 不在任务当前来源中，无法确定版本号`,
          '请先用 source import 上传该资料，或提供 --source-version（查询任务来源：task status）。',
        );
      }
      return { sourceId: parsedSourceId, version };
    }
  }
}

function parseJsonOrString(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* run pause / resume / cancel                                         */
/* ------------------------------------------------------------------ */

interface ControlCommandOptions {
  path: string;
  summary: string;
  action: 'pause' | 'resume' | 'cancel';
  extraNote: string;
}

function controlCommand(options: ControlCommandOptions): CommandSpec {
  return {
    path: options.path,
    summary: options.summary,
    flags: {
      '--reason': { type: 'string', valueName: '<原因>', description: '操作原因（记录到事件）' },
      '--expected-revision': { type: 'number', valueName: '<n>', description: '显式指定期望的任务修订号' },
    },
    positionals: [{ name: 'runId', description: '运行 ID', required: true }],
    examples: [`cognitive-atrium ${options.path} <runId>`, `cognitive-atrium ${options.path} <runId> --reason "...\"`],
    notes: [options.extraNote],
    execute: async (command, ctx) => {
      const runId = parseId(command.requirePositional(0, 'runId'), RunIdSchema, 'runId');
      const detail = await getRunDetail(ctx, runId);
      assertControlAllowed(options.action, detail);
      const expectedRevision = await currentTaskRevision(ctx, detail.run.taskId, command.getNumber('--expected-revision'));
      const route =
        options.action === 'pause' ? API_ROUTES.runPause(runId) : options.action === 'resume' ? API_ROUTES.runResume(runId) : API_ROUTES.runCancel(runId);
      const request = validateRequest(
        RunControlRequestSchema,
        { commandId: commandId(ctx), expectedRevision, reason: command.getString('--reason') ?? '' },
        `${options.action} 请求`,
      );
      const response = await ctx.client.post(RunControlResponseSchema, route, request);
      const human = renderControlResult(options.action, detail, response);
      return okOutcome(options.path, { control: response, run: detail }, human);
    },
  };
}

function assertControlAllowed(action: 'pause' | 'resume' | 'cancel', detail: RunDetailResponse): void {
  const state = detail.run.state;
  const runId = detail.run.runId;
  if (action === 'pause') {
    if (!(PAUSABLE_RUN_STATES as readonly string[]).includes(state)) {
      throw stateError(`运行 ${runId} 当前状态 ${state} 不能暂停`, `可暂停状态：${PAUSABLE_RUN_STATES.join(', ')}；用 run status 查看最新状态。`);
    }
    return;
  }
  if (action === 'resume') {
    if (state !== 'PAUSED' && state !== 'INTERRUPTED') {
      throw stateError(`运行 ${runId} 当前状态 ${state} 不能继续`, '只有 PAUSED（已暂停）或 INTERRUPTED（已中断）的运行可以 resume。');
    }
    return;
  }
  if ((TERMINAL_RUN_STATES as readonly string[]).includes(state) || state === 'CANCELLING') {
    throw stateError(`运行 ${runId} 当前状态 ${state} 不能取消`, '已是终态或正在取消；用 run status 查看实际结果。');
  }
  if (!(CANCELLABLE_RUN_STATES as readonly string[]).includes(state)) {
    throw stateError(`运行 ${runId} 当前状态 ${state} 不能取消`, `可取消状态：${CANCELLABLE_RUN_STATES.join(', ')}。`);
  }
}

function renderControlResult(action: 'pause' | 'resume' | 'cancel', detail: RunDetailResponse, response: RunControlResponse): string[] {
  const title = action === 'pause' ? '暂停请求已受理' : action === 'resume' ? '继续请求已受理' : '取消请求已受理';
  const lines = [
    heading(title),
    `  运行：${response.runId}`,
    `  状态：${detail.run.state} → ${response.state}${response.duplicate ? '（该命令此前已执行，服务端返回同一结果）' : ''}`,
    `  任务修订：${response.revision}`,
  ];
  if (action === 'pause') {
    lines.push('  说明：暂停只停止调度新步骤；当前步骤会在安全边界结束，已接受的正式版本不受影响。');
    lines.push('  下一步：', `    cognitive-atrium run status ${response.runId} --watch`, `    cognitive-atrium run resume ${response.runId}`);
  } else if (action === 'resume') {
    lines.push('  说明：继续从完整检查点重新组织后续工作，新的尝试编号与消耗会如实记录。');
    lines.push('  下一步：', `    cognitive-atrium run status ${response.runId} --watch`);
  } else {
    lines.push('  说明：取消不会自动接受任何候选成果；草稿保留，已接受的正式版本不变。');
    lines.push('  下一步：', `    cognitive-atrium run status ${response.runId}`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

export const runCommands: CommandSpec[] = [
  runStartCommand,
  runStatusCommand,
  runCommitCommand,
  runResolveCommand,
  controlCommand({
    path: 'run pause',
    summary: '请求暂停运行（安全边界停止调度，不丢弃已接受成果）',
    action: 'pause',
    extraNote: '处于 COMMITTING 的短事务不支持中途暂停；命令在事务结束后按实际结果响应。',
  }),
  controlCommand({
    path: 'run resume',
    summary: '从检查点继续已暂停/已中断的运行（产生新的尝试与消耗）',
    action: 'resume',
    extraNote: '继续表示从完整检查点重新组织后续工作，不是从断流 token 精确续写。',
  }),
  controlCommand({
    path: 'run cancel',
    summary: '请求取消运行（与提交串行，草稿保留、正式版本不变）',
    action: 'cancel',
    extraNote: '取消后不会偷偷接受成果；已完成运行请通过版本恢复处理。',
  }),
];
