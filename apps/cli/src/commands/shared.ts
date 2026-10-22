/**
 * Shared command helpers: typed snapshot/run/patch fetches, revision handling,
 * blocker plumbing and run polling. Every mutating command reads the current
 * `Task.revision` from the task snapshot right before sending the command, so a
 * stale client cannot silently overwrite a newer version.
 */
import {
  API_ROUTES,
  PatchReviewResponseSchema,
  RecipeResponseSchema,
  RunDetailResponseSchema,
  SessionInfoSchema,
  TaskListResponseSchema,
  TaskSnapshotSchema,
  WorkspaceViewSchema,
  type Blocker,
  type CommandId,
  type PatchReviewResponse,
  type Recipe,
  type ResolutionOption,
  type RunDetailResponse,
  type SessionInfo,
  type TaskListResponse,
  type TaskSnapshot,
  type WorkspaceView,
} from '@ca/contracts';
import type { ApiClient, ResponseSchema } from '../client';
import { CliError, ConnectionError, EXIT, UsageError, type ErrorInfo } from '../exit';
import type { CliOutcome, CommandContext, CommandSpec, OutcomeStatus, WaitingForInputInfo } from './types';

export { EXIT };

/** Structural UUID schema check without importing zod directly. */
interface UuidSchema {
  safeParse(input: unknown): { success: true; data: string } | { success: false };
}

export function parseId(value: string | undefined, schema: UuidSchema, label: string): string {
  if (!value) throw new UsageError(`缺少${label}`, '请提供 UUID 形式的标识');
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UsageError(`${label}不是合法 UUID：${value}`);
  return parsed.data;
}

/** Try a UUID schema without throwing (module/title resolution uses it). */
export function tryParseId(value: string, schema: UuidSchema): string | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve `--module` by exact id, exact title, or unique id prefix. When the
 * task has exactly one module and no value is given, that module is used.
 */
export function resolveModuleId(
  modules: readonly { id: string; title: string }[],
  raw: string | undefined,
  optionName = '--module',
): string {
  if (modules.length === 0) throw new UsageError('任务没有可用模块，请先检查任务定义');
  if (raw === undefined) {
    if (modules.length === 1) return modules[0]!.id;
    throw new UsageError(
      `任务包含多个模块，请用 ${optionName} 指定目标模块`,
      `可选模块：${modules.map((module) => `${module.id}（${module.title}）`).join('、')}`,
    );
  }
  const exact = modules.find((module) => module.id === raw);
  if (exact) return exact.id;
  const byTitle = modules.filter((module) => module.title === raw);
  if (byTitle.length === 1) return byTitle[0]!.id;
  const byPrefix = modules.filter((module) => module.id.startsWith(raw));
  if (byPrefix.length === 1) return byPrefix[0]!.id;
  throw new UsageError(
    `找不到目标模块：${raw}`,
    `可选模块：${modules.map((module) => `${module.id}（${module.title}）`).join('、')}`,
  );
}

export function commandId(ctx: CommandContext): CommandId {
  return ctx.client.commandId();
}

/** Local preflight rejected the operation because the real state does not allow it. */
export function stateError(message: string, hint?: string, code = 'state_not_allowed'): CliError {
  return new CliError(EXIT.STATE, { kind: 'api', code, message, hint });
}

/** Validate a locally-built request payload against its frozen request schema. */
export function validateRequest<T>(schema: ResponseSchema<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`);
    throw new UsageError(`${label}校验失败：${issues.join('；')}`, '请根据提示修正输入后重试。');
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function getSnapshot(ctx: CommandContext, taskId: string, afterSeq?: number): Promise<TaskSnapshot> {
  const query = afterSeq === undefined || afterSeq <= 0 ? '' : `?afterSeq=${afterSeq}`;
  return ctx.client.get(TaskSnapshotSchema, `${API_ROUTES.taskSnapshot(taskId)}${query}`);
}

export function getRunDetail(ctx: CommandContext, runId: string): Promise<RunDetailResponse> {
  return ctx.client.get(RunDetailResponseSchema, API_ROUTES.run(runId));
}

export function getPatchReview(ctx: CommandContext, patchId: string): Promise<PatchReviewResponse> {
  return ctx.client.get(PatchReviewResponseSchema, API_ROUTES.patch(patchId));
}

export function getWorkspace(ctx: CommandContext): Promise<WorkspaceView> {
  return ctx.client.get(WorkspaceViewSchema, API_ROUTES.workspace);
}

export function getSession(ctx: CommandContext): Promise<SessionInfo> {
  return ctx.client.get(SessionInfoSchema, API_ROUTES.session);
}

export function getTaskList(ctx: CommandContext): Promise<TaskListResponse> {
  return ctx.client.get(TaskListResponseSchema, API_ROUTES.tasks);
}

export function getRecipe(ctx: CommandContext, recipeId: string): Promise<Recipe> {
  return ctx.client.get(RecipeResponseSchema, API_ROUTES.recipe(recipeId)).then((response) => response.recipe);
}

/**
 * Fetch the authoritative task revision for a mutation. `--expected-revision`
 * is an explicit override for scripted retries; otherwise the snapshot is read
 * immediately before the POST.
 */
export async function currentTaskRevision(ctx: CommandContext, taskId: string, override: number | undefined): Promise<number> {
  if (override !== undefined) return override;
  const snapshot = await getSnapshot(ctx, taskId);
  return snapshot.task.revision;
}

/** Refresh a task snapshot purely to obtain the latest revision (with an optional hint). */
export async function refreshSnapshot(ctx: CommandContext, taskId: string): Promise<TaskSnapshot> {
  return getSnapshot(ctx, taskId);
}

/* ------------------------------------------------------------------ */
/* Blocker / business-state plumbing                                   */
/* ------------------------------------------------------------------ */

export function openBlockers(blockers: readonly Blocker[]): Blocker[] {
  return blockers.filter((blocker) => blocker.status === 'open');
}

export function allResolutions(blocker: Blocker): ResolutionOption[] {
  return blocker.resolutions;
}

export function buildWaitingForInput(blockers: readonly Blocker[], taskId: string | null, runId: string | null): WaitingForInputInfo {
  const list = openBlockers(blockers);
  const first = list[0];
  const nextCommands = first ? resolutionCommands(first, runId) : [];
  return {
    taskId,
    runId,
    blockerId: first?.id ?? 'unknown',
    blockers: list,
    resolutions: first ? first.resolutions : [],
    nextCommands,
  };
}

function resolutionCommands(blocker: Blocker, runId: string | null): string[] {
  const run = runId ?? '<runId>';
  return blocker.resolutions.map((option) => {
    switch (option.kind) {
      case 'choose':
        return `run resolve ${run} --blocker ${blocker.id} --option ${option.id} --value <选项值>`;
      case 'text':
        return `run resolve ${run} --blocker ${blocker.id} --option ${option.id} --value "<文本>"`;
      case 'bind_source':
        return `run resolve ${run} --blocker ${blocker.id} --option ${option.id} --source-id <资料ID> --source-version <版本号>`;
      case 'confirm_mapping':
        return `run resolve ${run} --blocker ${blocker.id} --option ${option.id} --value '{"confirmed":true}'`;
      case 'exclude':
        return `run resolve ${run} --blocker ${blocker.id} --option ${option.id} --value '{"itemRef":"<条目引用>"}'`;
    }
  });
}

export interface BusinessState {
  exitCode: number;
  status: OutcomeStatus;
  waitingForInput?: WaitingForInputInfo;
  error?: ErrorInfo;
}

/** Map a run detail to the CLI business state (never report blocked/failed as success). */
export function runBusinessState(detail: RunDetailResponse): BusinessState {
  const open = openBlockers(detail.blockers);
  const taskId = detail.run.taskId;
  if (open.length > 0) {
    return {
      exitCode: EXIT.WAITING_INPUT,
      status: 'waiting_for_input',
      waitingForInput: buildWaitingForInput(open, taskId, detail.run.runId),
    };
  }
  switch (detail.run.state) {
    case 'AWAITING_INPUT':
      return {
        exitCode: EXIT.WAITING_INPUT,
        status: 'waiting_for_input',
        waitingForInput: buildWaitingForInput([], taskId, detail.run.runId),
        error: {
          kind: 'api',
          code: 'waiting_for_input',
          message: '运行处于等待输入状态，但当前没有读取到开放的阻塞项；请用 run status 重新查询。',
        },
      };
    case 'FAILED': {
      const runError = detail.run.error as { code?: unknown; message?: unknown; retryable?: unknown; stage?: unknown } | null;
      return {
        exitCode: EXIT.STATE,
        status: 'failed',
        error: {
          kind: 'api',
          code: typeof runError?.code === 'string' ? runError.code : 'run_failed',
          message:
            typeof runError?.message === 'string' && runError.message !== ''
              ? runError.message
              : '运行失败：没有产生新版本，已接受的成果未被修改。',
          retryable: runError?.retryable === true,
          details: runError ?? undefined,
        },
      };
    }
    case 'CANCELLED':
      return {
        exitCode: EXIT.STATE,
        status: 'cancelled',
        error: {
          kind: 'api',
          code: 'run_cancelled',
          message: '运行已取消：草稿保留，已接受的正式版本未被修改。',
        },
      };
    case 'INTERRUPTED':
      return {
        exitCode: EXIT.STATE,
        status: 'interrupted',
        error: {
          kind: 'api',
          code: 'run_interrupted',
          message: '运行已中断：未自动重放结果不明的工具调用；请核对后用 run resume 从安全边界继续。',
        },
      };
    default:
      return { exitCode: EXIT.OK, status: 'ok' };
  }
}

/** Business state from a task snapshot (open blockers at task level). */
export function snapshotBusinessState(snapshot: TaskSnapshot): BusinessState {
  const open = openBlockers(snapshot.blockers);
  if (open.length > 0) {
    const runId = open[0]?.runId ?? snapshot.activeRun?.runId ?? null;
    return {
      exitCode: EXIT.WAITING_INPUT,
      status: 'waiting_for_input',
      waitingForInput: buildWaitingForInput(open, snapshot.task.id, runId),
    };
  }
  return { exitCode: EXIT.OK, status: 'ok' };
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  shouldStop: (detail: RunDetailResponse) => boolean;
  onUpdate?: (detail: RunDetailResponse, previous: RunDetailResponse | null) => void;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Poll `GET /api/runs/:id` until `shouldStop`. Used by `run status --watch`,
 * `run start --wait` and `recipe run --wait`. This is a read loop, so retries
 * are safe.
 */
export async function pollRun(ctx: CommandContext, runId: string, options: PollOptions): Promise<RunDetailResponse> {
  const deadline = Date.now() + Math.max(1, options.timeoutMs);
  let detail = await getRunDetail(ctx, runId);
  let previous: RunDetailResponse | null = null;
  while (!options.shouldStop(detail)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ConnectionError(
        `等待运行状态超时（${options.timeoutMs}ms）：run ${runId} 仍在 ${detail.run.state}`,
        '可提高 --timeout，或稍后用 run status 查看；服务端运行不受 CLI 退出影响。',
        'timeout',
      );
    }
    await sleep(Math.min(Math.max(10, options.intervalMs), remaining));
    previous = detail;
    detail = await getRunDetail(ctx, runId);
    options.onUpdate?.(detail, previous);
  }
  return detail;
}

export function shouldStopRunWatch(detail: RunDetailResponse): boolean {
  if (openBlockers(detail.blockers).length > 0) return true;
  switch (detail.run.state) {
    case 'COMPLETED':
    case 'CANCELLED':
    case 'FAILED':
    case 'INTERRUPTED':
    case 'AWAITING_INPUT':
    case 'AWAITING_REVIEW':
    case 'PAUSED':
      return true;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Command spec helpers                                                */
/* ------------------------------------------------------------------ */

export function okOutcome(command: CommandSpec | string, data: unknown, human: string | string[]): CliOutcome {
  return {
    command: typeof command === 'string' ? command : command.path,
    data,
    human: Array.isArray(human) ? `${human.join('\n')}\n` : human,
    exitCode: EXIT.OK,
    status: 'ok',
  };
}

export function businessOutcome(
  command: string,
  data: unknown,
  human: string | string[],
  state: BusinessState,
): CliOutcome {
  return {
    command,
    data,
    human: Array.isArray(human) ? `${human.join('\n')}\n` : human,
    exitCode: state.exitCode,
    status: state.status,
    waitingForInput: state.waitingForInput,
    error: state.error,
  };
}

export function renderWaitingSummary(waiting: WaitingForInputInfo): string[] {
  const lines: string[] = [];
  lines.push(`等待人工输入：有 ${waiting.blockers.length} 个阻塞（未产生新版本，也未自动继续）。`);
  if (waiting.blockers.length === 0) {
    lines.push('  当前无法读取到阻塞详情，请重新执行 run status 获取最新状态。');
    return lines;
  }
  const first = waiting.blockers[0]!;
  lines.push(`  阻塞 ID：${first.id}   类型：${first.type}   严重级别：${first.severity}`);
  lines.push(`  标题：${first.title}`);
  lines.push('  解决方式：');
  for (const option of first.resolutions) {
    lines.push(`    --option ${option.id}（${option.kind}）：${option.label}`);
  }
  if (waiting.nextCommands.length) {
    lines.push('  下一步命令示例：');
    for (const next of waiting.nextCommands) lines.push(`    cognitive-atrium ${next}`);
  }
  return lines;
}

/** Describe why the CLI exits non-zero in human mode. */
export function describeOutcomeError(error: ErrorInfo | undefined): string[] {
  if (!error) return [];
  const lines = [`${error.code}：${error.message}`];
  if (error.retryable) lines.push('该错误被标记为可重试。');
  if (error.traceId) lines.push(`traceId：${error.traceId}`);
  return lines;
}

export type { ApiClient };
