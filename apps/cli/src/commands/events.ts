/**
 * `events tail` — SSE subscription with Last-Event-ID resume and seq de-dup.
 *
 * Behaviour mirrors the client rules frozen in the design (section 18.2):
 *  - duplicate `seq` are ignored;
 *  - a seq gap triggers a snapshot refetch and the missing committed events are
 *    emitted from the snapshot before continuing the live stream;
 *  - reconnection always sends the last seen seq as `Last-Event-ID` and as
 *    `afterSeq`, so no committed change is silently skipped;
 *  - `--json` produces one document (collected events); `--jsonl` streams one
 *    JSON object per line and is the explicit streaming exception.
 */
import {
  API_ROUTES,
  EVENT_TYPES,
  HarnessEventSchema,
  RunIdSchema,
  TaskIdSchema,
  TERMINAL_EVENT_TYPES,
  type HarnessEvent,
} from '@ca/contracts';
import { EXIT, ProtocolError, ConnectionError, UsageError, toCliError } from '../exit';
import { heading, shortId, truncate } from '../format';
import type { CliOutcome, CommandSpec } from './types';
import { getSnapshot, parseId, sleep } from './shared';

export const eventsTailCommand: CommandSpec = {
  path: 'events tail',
  summary: '订阅任务事件流（SSE）：断线自动用 Last-Event-ID 续传，重复 seq 忽略',
  flags: {
    '--after': { type: 'number', valueName: '<seq>', description: '从该事件序号之后开始（默认 0，即全部保留事件）' },
    '--run': { type: 'string', valueName: '<runId>', description: '只输出该运行相关事件（仍会跟踪全局 seq）' },
    '--type': { type: 'list', valueName: '<eventType>', description: '只输出指定事件类型，可重复（例如 run.state_changed）' },
    '--limit': { type: 'number', valueName: '<n>', description: '输出 n 个事件后退出（便于脚本）' },
    '--stop-on-terminal': { type: 'boolean', description: '看到运行终态事件（completed/cancelled/failed）后退出' },
    '--reconnect': { type: 'boolean', default: true, description: '断线自动重连（--no-reconnect 关闭）' },
    '--max-reconnects': { type: 'number', valueName: '<n>', description: '最大连续重连次数（默认 5）' },
    '--jsonl': { type: 'boolean', description: '逐行输出 JSON（流式，与 --json 的单文档约定不同）' },
  },
  positionals: [{ name: 'taskId', description: '任务 ID', required: true }],
  examples: [
    'cognitive-atrium events tail <taskId> --limit 20',
    'cognitive-atrium events tail <taskId> --run <runId> --stop-on-terminal --json',
    'cognitive-atrium events tail <taskId> --type blocker.detected --jsonl',
  ],
  notes: ['--json 在退出时输出单个 JSON 文档；持续跟踪时请在需要停止时按 Ctrl-C（退出码 0）。'],
  execute: async (command, ctx) => {
    const taskId = parseId(command.requirePositional(0, 'taskId'), TaskIdSchema, 'taskId');
    const after = Math.max(0, command.getNumber('--after') ?? 0);
    const runFilter = command.getString('--run') === undefined ? null : parseId(command.getString('--run'), RunIdSchema, '--run');
    const typeFilter = command.getList('--type');
    const knownTypes = new Set<string>(EVENT_TYPES);
    for (const type of typeFilter) {
      if (!knownTypes.has(type)) {
        throw new UsageError(`未知事件类型：${type}`, `可用类型见 contracts EVENT_TYPES（示例：run.state_changed、blocker.detected、model.finished）`);
      }
    }
    const limit = command.getNumber('--limit');
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new UsageError('--limit 必须是正整数');
    const stopOnTerminal = command.getBool('--stop-on-terminal');
    const reconnect = command.getBool('--reconnect');
    const maxReconnects = Math.max(0, command.getNumber('--max-reconnects') ?? 5);
    const jsonl = command.getBool('--jsonl');
    // `--jsonl` is the explicit streaming exception: one JSON object per line.
    // `--json` remains the single-document contract for non-streaming commands.
    const streamJsonLines = jsonl;

    const collected: HarnessEvent[] = [];
    let lastSeq = after;
    let emitted = 0;
    let duplicatesIgnored = 0;
    let gapsFilled = 0;
    let reconnectCount = 0;
    let interrupted = false;
    let stoppedReason = 'stream_end';
    const controller = new AbortController();
    const onSigint = (): void => {
      interrupted = true;
      controller.abort();
    };
    process.once('SIGINT', onSigint);

    const emit = (event: HarnessEvent): void => {
      if (event.seq > lastSeq) lastSeq = event.seq;
      if (runFilter && event.runId !== runFilter) return;
      if (typeFilter.length > 0 && !typeFilter.includes(event.type)) return;
      emitted += 1;
      collected.push(event);
      if (streamJsonLines) {
        ctx.stdout(`${JSON.stringify(event)}\n`);
      } else if (!ctx.globals.json) {
        ctx.stdout(`${formatEventLine(event)}\n`);
      }
    };

    const reachedStop = (): boolean => {
      if (limit !== undefined && emitted >= limit) {
        stoppedReason = 'limit';
        return true;
      }
      if (stopOnTerminal && collected.some((event) => isTerminalFor(event, runFilter))) {
        stoppedReason = 'terminal';
        return true;
      }
      return false;
    };

    const processEvent = async (event: HarnessEvent): Promise<boolean> => {
      if (event.seq <= lastSeq) {
        duplicatesIgnored += 1;
        ctx.log(`[sse] 忽略重复事件 seq=${event.seq}（已处理到 ${lastSeq}）`);
        return false;
      }
      if (lastSeq > 0 && event.seq > lastSeq + 1) {
        ctx.log(`[sse] 检测到事件序号缺口 ${lastSeq + 1}..${event.seq - 1}，重新获取快照补洞`);
        const missing = await fetchMissingEvents(ctx, taskId, lastSeq, event.seq);
        for (const item of missing) {
          if (item.seq > lastSeq && item.seq < event.seq) {
            gapsFilled += 1;
            emit(item);
            if (reachedStop()) return true;
          }
        }
      }
      emit(event);
      return reachedStop();
    };

    try {
      let following = true;
      while (following) {
        const route = `${API_ROUTES.taskEvents(taskId)}?afterSeq=${lastSeq}`;
        try {
          for await (const message of ctx.client.sse(route, {
            signal: controller.signal,
            lastEventId: lastSeq > 0 ? String(lastSeq) : null,
          })) {
            if (interrupted) break;
            if (message.data === undefined || message.data === '') continue;
            const parsed = parseEventPayload(message.data);
            if (await processEvent(parsed)) {
              following = false;
              break;
            }
          }
        } catch (error) {
          if (interrupted) break;
          const cliError = toCliError(error);
          if (!reconnect) throw cliError;
          if (cliError.info.code === 'protocol_error') throw cliError;
          reconnectCount += 1;
          if (reconnectCount > maxReconnects) {
            stoppedReason = 'reconnect_exhausted';
            throw new ConnectionError(
              `事件流连续中断 ${reconnectCount} 次，停止重连（最后事件序号 ${lastSeq}）`,
              `可用 --max-reconnects 调整，或稍后重新执行 events tail ${taskId} --after ${lastSeq}。`,
              'sse_reconnect_exhausted',
            );
          }
          ctx.log(`[sse] 连接中断（${cliError.info.message}），用 Last-Event-ID=${lastSeq} 重连（${reconnectCount}/${maxReconnects}）`);
          await sleep(reconnectDelayMs(reconnectCount));
          continue;
        }
        if (!following) break;
        if (interrupted) break;
        if (!reconnect) {
          stoppedReason = 'stream_end';
          break;
        }
        reconnectCount += 1;
        if (reconnectCount > maxReconnects) {
          stoppedReason = 'reconnect_exhausted';
          break;
        }
        ctx.log(`[sse] 服务端结束事件流，使用 Last-Event-ID=${lastSeq} 重连（${reconnectCount}/${maxReconnects}）`);
        await sleep(reconnectDelayMs(reconnectCount));
      }
      if (interrupted) stoppedReason = 'interrupted';
    } finally {
      process.removeListener('SIGINT', onSigint);
      controller.abort();
    }

    const data = {
      taskId,
      lastSeq,
      events: collected,
      emitted,
      duplicatesIgnored,
      gapsFilled,
      reconnects: reconnectCount,
      interrupted,
      stoppedReason,
    };
    const human = streamJsonLines
      ? ''
      : [
          heading('事件流结束'),
          `  最后序号：${lastSeq}   输出 ${emitted} 个事件` +
            `${duplicatesIgnored ? `   忽略重复 ${duplicatesIgnored}` : ''}${gapsFilled ? `   补洞 ${gapsFilled}` : ''}` +
            `   重连 ${reconnectCount} 次`,
          `  停止原因：${stoppedReason}`,
          ...(lastSeq > 0 ? [`  继续跟踪：cognitive-atrium events tail ${taskId} --after ${lastSeq}`] : []),
        ].join('\n') + '\n';
    const outcome: CliOutcome = {
      command: 'events tail',
      data,
      human,
      exitCode: EXIT.OK,
      status: interrupted ? 'incomplete' : 'ok',
      alreadyEmitted: streamJsonLines,
    };
    return outcome;
  },
};

async function fetchMissingEvents(
  ctx: Parameters<CommandSpec['execute']>[1],
  taskId: string,
  fromSeq: number,
  toSeq: number,
): Promise<HarnessEvent[]> {
  const snapshot = await getSnapshot(ctx, taskId, fromSeq);
  return snapshot.events
    .filter((event) => event.seq > fromSeq && event.seq < toSeq)
    .sort((a, b) => a.seq - b.seq) as unknown as HarnessEvent[];
}

function parseEventPayload(data: string): HarnessEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    throw new ProtocolError('SSE 事件的 data 不是合法 JSON', { data: data.slice(0, 300) });
  }
  const parsed = HarnessEventSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`);
    throw new ProtocolError('SSE 事件不符合 @ca/contracts 事件 Schema', { issues });
  }
  return parsed.data as HarnessEvent;
}

function isTerminalFor(event: HarnessEvent, runFilter: string | null): boolean {
  if (!(TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type)) return false;
  if (runFilter && event.runId !== runFilter) return false;
  return true;
}

function reconnectDelayMs(attempt: number): number {
  return Math.min(2_000, 250 * attempt);
}

function formatEventLine(event: HarnessEvent): string {
  return `#${event.seq} ${event.timestamp} ${event.category}/${event.type} ${summarizeEvent(event)}`.trimEnd();
}

/** One-line payload summary for human tail output (never invents data). */
export function summarizeEvent(event: HarnessEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const str = (key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null);
  const num = (key: string): number | null => (typeof payload[key] === 'number' ? (payload[key] as number) : null);
  switch (event.type) {
    case 'run.created':
      return `module=${shortId(str('moduleId'))}`;
    case 'run.state_changed': {
      const from = str('from');
      const to = str('to');
      return from && to ? `${from} → ${to}` : '';
    }
    case 'plan.proposed':
    case 'plan.revised':
    case 'plan.ready':
    case 'plan.committed':
      return `plan v${num('planVersion') ?? '?'}`;
    case 'run.started':
      return `attempt ${num('attempt') ?? '?'}`;
    case 'step.started':
    case 'step.completed':
    case 'step.failed':
      return str('title') ?? shortId(str('stepId'));
    case 'model.started':
      return `model=${str('model') ?? '?'}`;
    case 'model.delta_batch':
      return `+${(str('text') ?? '').length} chars`;
    case 'model.finished':
      return `finish=${str('finishReason') ?? '?'}`;
    case 'tool.requested':
    case 'tool.started':
    case 'tool.succeeded':
    case 'tool.failed':
    case 'tool.outcome_unknown':
      return `tool=${str('toolId') ?? '?'}${str('error') ? '' : ''}`;
    case 'blocker.detected': {
      const blocker = payload.blocker as { title?: unknown; id?: unknown } | undefined;
      return `${String(blocker?.id ?? '')} ${String(blocker?.title ?? '')}`.trim();
    }
    case 'input.requested':
      return str('title') ?? shortId(str('blockerId'));
    case 'input.resolved':
      return `blocker=${shortId(str('blockerId'))} option=${str('optionId') ?? '?'}`;
    case 'blocker.cleared':
      return `blocker=${shortId(str('blockerId'))}`;
    case 'artifact.patch_proposed':
      return `patch=${shortId(str('patchId'))} module=${shortId(str('moduleId'))}`;
    case 'validation.completed':
      return `validation=${str('status') ?? '?'}`;
    case 'artifact.accepted':
      return `version=${shortId(str('versionId'))} module=${shortId(str('moduleId'))}`;
    case 'artifact.restored':
      return `version=${shortId(str('versionId'))}`;
    case 'artifact.stale':
      return `module=${shortId(str('moduleId'))} reason=${truncate(str('reason') ?? '', 80)}`;
    case 'recipe.proposed':
    case 'recipe.validated':
    case 'recipe.stale':
    case 'recipe.run_started':
      return `recipe=${shortId(str('recipeId'))} v${num('version') ?? '?'}`;
    case 'run.paused':
    case 'run.resumed':
    case 'run.cancelled':
    case 'run.completed':
    case 'run.failed':
    case 'run.interrupted':
      return str('reason') ?? (str('versionId') ? `version=${shortId(str('versionId'))}` : '');
    case 'usage.updated':
      return `model=${num('modelRequests') ?? 0} tool=${num('toolCalls') ?? 0}`;
    case 'budget.warning':
    case 'budget.exhausted':
      return `${str('resource') ?? '?'} ${num('used') ?? 0}/${num('limit') ?? 0}`;
    case 'context.snapshot_created':
      return `tokens=${num('estimatedTokens') ?? 0} fragments=${num('fragmentCount') ?? 0}`;
    case 'provider.error':
      return `stage=${str('stage') ?? '?'}`;
    default:
      return '';
  }
}
