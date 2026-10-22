/** `task` commands: create, list, status, export. */
import fs from 'node:fs';
import path from 'node:path';
import {
  API_ROUTES,
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  EXPORT_FORMATS,
  ExportResponseSchema,
  TaskIdSchema,
  TaskListResponseSchema,
} from '@ca/contracts';
import { IntegrityError, UsageError } from '../exit';
import {
  renderExportResult,
  renderSnapshot,
  renderTaskList,
  runStateLabel,
  shortId,
} from '../format';
import { base64Decode, readJsonInput, resolvePath, sha256Hex, writeFileAtomic } from '../io';
import type { CommandSpec } from './types';
import {
  businessOutcome,
  commandId,
  getSnapshot,
  getTaskList,
  okOutcome,
  parseId,
  renderWaitingSummary,
  snapshotBusinessState,
  sleep,
  validateRequest,
} from './shared';

/* ------------------------------------------------------------------ */
/* task create                                                         */
/* ------------------------------------------------------------------ */

export const taskCreateCommand: CommandSpec = {
  path: 'task create',
  summary: '创建任务与成果骨架（可显式定义模块，或使用内置模板）',
  flags: {
    '--title': { type: 'string', valueName: '<标题>', description: '任务标题（必填）' },
    '--intent': { type: 'string', valueName: '<意图>', description: '任务意图/目标（必填）' },
    '--artifact-title': { type: 'string', valueName: '<标题>', description: '交付物标题（默认同任务标题）' },
    '--template': { type: 'string', valueName: '<templateId>', description: '内置模板 ID（未提供 --modules 时使用，例如 cognitive-atrium）' },
    '--modules': { type: 'string', valueName: '<文件|JSON>', description: '模块定义：JSON 数组文件路径、内联 JSON 或 -（stdin）' },
    '--constraints-file': { type: 'string', valueName: '<文件|JSON>', description: '约束定义：JSON 数组文件路径或内联 JSON' },
    '--constraint': { type: 'list', valueName: '<文本>', description: '一条约束文本，可重复（自动分配 id）' },
    '--constraint-kind': {
      type: 'string',
      valueName: '<kind>',
      choices: ['hard', 'preference', 'assumption'],
      description: '--constraint 使用的约束类型（默认 hard）',
    },
  },
  positionals: [],
  examples: [
    'cognitive-atrium task create --title "整理客户反馈" --intent "汇总反馈并给出优先级" --template cognitive-atrium',
    'cognitive-atrium task create --title "清洗旧系统清单" --intent "输出标准化 CSV" --modules ./modules.json --constraint "必须保留原始编号" --constraint-kind hard',
  ],
  execute: async (command, ctx) => {
    const title = command.requireString('--title', '任务标题');
    const intent = command.requireString('--intent', '任务意图');
    const artifactTitle = command.getString('--artifact-title') ?? title;
    const templateId = command.getString('--template') ?? null;
    const modulesArg = command.getString('--modules');
    const modules = modulesArg === undefined ? [] : await readJsonInput(ctx.cwd, modulesArg, '模块定义');
    if (modulesArg === undefined && !templateId) {
      throw new UsageError('必须提供 --modules（显式模块定义）或 --template（内置模板）之一', '示例：--template cognitive-atrium');
    }
    const constraintKind = command.getString('--constraint-kind') ?? 'hard';
    const constraints: unknown[] = [];
    const constraintsFile = command.getString('--constraints-file');
    if (constraintsFile !== undefined) {
      const raw = await readJsonInput(ctx.cwd, constraintsFile, '约束定义');
      if (!Array.isArray(raw)) throw new UsageError('约束定义必须是 JSON 数组');
      constraints.push(...raw);
    }
    for (const text of command.getList('--constraint')) constraints.push({ text, kind: constraintKind });
    const normalizedConstraints = constraints.map((entry, index) => {
      if (typeof entry === 'string') return { id: `c${index + 1}`, text: entry, kind: constraintKind };
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        return { ...record, id: typeof record.id === 'string' && record.id !== '' ? record.id : `c${index + 1}`, kind: record.kind ?? constraintKind };
      }
      throw new UsageError(`第 ${index + 1} 条约束格式非法`);
    });

    const request = validateRequest(
      CreateTaskRequestSchema,
      {
        commandId: commandId(ctx),
        title,
        intent,
        artifactTitle,
        constraints: normalizedConstraints,
        templateId,
        modules,
      },
      '任务创建请求',
    );
    const response = await ctx.client.post(CreateTaskResponseSchema, API_ROUTES.tasks, request);
    const firstModule = response.moduleIds[0];
    const human = [
      '== 任务已创建 ==',
      `  任务：${response.taskId}`,
      `  交付物：${response.artifactId}`,
      `  修订：${response.revision}`,
      `  模块 ${response.moduleIds.length} 个：${response.moduleIds.map((id) => shortId(id)).join(', ')}`,
      '  下一步：',
      `    cognitive-atrium task status ${response.taskId}`,
      ...(firstModule ? [`    cognitive-atrium run start ${response.taskId} --module ${firstModule} --intent "<工作意图>"`] : []),
    ];
    return okOutcome('task create', response, human);
  },
};

/* ------------------------------------------------------------------ */
/* task list                                                           */
/* ------------------------------------------------------------------ */

export const taskListCommand: CommandSpec = {
  path: 'task list',
  summary: '列出任务及其实时状态（只读）',
  flags: {},
  positionals: [],
  examples: ['cognitive-atrium task list', 'cognitive-atrium task list --json'],
  execute: async (_command, ctx) => {
    const response = await ctx.client.get(TaskListResponseSchema, API_ROUTES.tasks);
    return okOutcome('task list', response, renderTaskList(response));
  },
};

/* ------------------------------------------------------------------ */
/* task status                                                         */
/* ------------------------------------------------------------------ */

export const taskStatusCommand: CommandSpec = {
  path: 'task status',
  summary: '显示任务的完整投影：模块、活动运行、阻塞、计划、补丁与资料',
  flags: {
    '--after': { type: 'number', valueName: '<seq>', description: '从指定事件序号之后获取增量快照' },
    '--watch': { type: 'boolean', description: '持续轮询直到任务进入稳定/终态（进度输出到 stderr）' },
    '--interval': { type: 'number', valueName: '<ms>', description: '轮询间隔毫秒（默认 1000）' },
  },
  positionals: [{ name: 'taskId', description: '任务 ID', required: true }],
  examples: ['cognitive-atrium task status <taskId>', 'cognitive-atrium task status <taskId> --watch --json'],
  execute: async (command, ctx) => {
    const taskId = parseId(command.requirePositional(0, 'taskId'), TaskIdSchema, 'taskId');
    const afterSeq = command.getNumber('--after') ?? 0;
    let snapshot = await getSnapshot(ctx, taskId, afterSeq);
    if (command.getBool('--watch')) {
      const interval = Math.max(50, command.getNumber('--interval') ?? 1000);
      const deadline = Date.now() + ctx.globals.timeoutMs;
      let lastSignature = snapshotSignature(snapshot);
      for (;;) {
        if (taskStable(snapshot) || Date.now() >= deadline) break;
        await sleep(interval);
        snapshot = await getSnapshot(ctx, taskId);
        const signature = snapshotSignature(snapshot);
        if (signature !== lastSignature) {
          lastSignature = signature;
          ctx.log(`[watch] ${signature}`);
        }
      }
      if (Date.now() >= deadline && !taskStable(snapshot)) {
        ctx.log(`[watch] 达到等待上限（${ctx.globals.timeoutMs}ms），输出当前状态（服务端任务继续运行）`);
      }
    }
    const state = snapshotBusinessState(snapshot);
    const human = renderSnapshot(snapshot, { serverUrl: ctx.client.baseUrl });
    if (state.waitingForInput) human.push(...renderWaitingSummary(state.waitingForInput));
    return businessOutcome('task status', snapshot, human, state);
  },
};

function snapshotSignature(snapshot: Awaited<ReturnType<typeof getSnapshot>>): string {
  const active = snapshot.activeRun;
  const open = snapshot.blockers.filter((blocker) => blocker.status === 'open').length;
  return [
    `修订 ${snapshot.task.revision}`,
    active ? `运行 ${shortId(active.runId)} ${runStateLabel(active.state)}` : '无活动运行',
    `阻塞 ${open}`,
    `待审补丁 ${snapshot.patches.filter((patch) => patch.status === 'proposed').length}`,
  ].join(' · ');
}

function taskStable(snapshot: Awaited<ReturnType<typeof getSnapshot>>): boolean {
  const active = snapshot.activeRun;
  if (!active) return true;
  if (snapshot.blockers.some((blocker) => blocker.status === 'open')) return true;
  return ['COMPLETED', 'CANCELLED', 'FAILED', 'INTERRUPTED', 'AWAITING_INPUT', 'AWAITING_REVIEW', 'PAUSED'].includes(active.state);
}

/* ------------------------------------------------------------------ */
/* task export                                                         */
/* ------------------------------------------------------------------ */

export const taskExportCommand: CommandSpec = {
  path: 'task export',
  summary: '导出成果或任务包（文件写入后校验 sha256 与字节数）',
  flags: {
    '--format': {
      type: 'string',
      valueName: '<format>',
      choices: EXPORT_FORMATS,
      description: `导出格式：${EXPORT_FORMATS.join(' / ')}（必填）`,
    },
    '--module': { type: 'list', valueName: '<moduleId>', description: '仅导出指定模块，可重复（默认全部）' },
    '--include-sources': { type: 'boolean', description: '任务包中携带原始资料（默认不携带）' },
    '--out': { type: 'string', valueName: '<路径>', description: '输出文件或目录（默认当前目录）' },
  },
  positionals: [{ name: 'taskId', description: '任务 ID', required: true }],
  examples: [
    'cognitive-atrium task export <taskId> --format markdown --out ./out',
    'cognitive-atrium task export <taskId> --format task_package --include-sources --out ./out',
  ],
  notes: ['导出内容先写入临时文件再原子重命名；sha256/字节数不一致时不会声明成功。'],
  execute: async (command, ctx) => {
    const taskId = parseId(command.requirePositional(0, 'taskId'), TaskIdSchema, 'taskId');
    const format = command.requireString('--format', `导出格式：${EXPORT_FORMATS.join('/')}`);
    const response = await ctx.client.post(ExportResponseSchema, API_ROUTES.taskExport(taskId), {
      commandId: commandId(ctx),
      format,
      moduleIds: command.getList('--module'),
      includeSources: command.getBool('--include-sources'),
    });
    const buffer = base64Decode(response.contentBase64, '导出内容');
    const digest = sha256Hex(buffer);
    const integrity = {
      sha256Verified: digest === response.sha256,
      bytesVerified: buffer.byteLength === response.bytes,
    };
    if (!integrity.sha256Verified || !integrity.bytesVerified) {
      throw new IntegrityError('导出内容完整性校验失败：sha256 或字节数与服务端声明不一致', {
        expectedSha256: response.sha256,
        actualSha256: digest,
        expectedBytes: response.bytes,
        actualBytes: buffer.byteLength,
      });
    }
    const outputPath = resolveExportPath(ctx.cwd, command.getString('--out'), response.fileName);
    writeFileAtomic(outputPath, buffer);
    const human = renderExportResult(response, outputPath, integrity);
    return okOutcome('task export', { export: response, outputPath, integrity }, human);
  },
};

function resolveExportPath(cwd: string, out: string | undefined, fileName: string): string {
  const safeName = path.basename(fileName) || 'export.bin';
  if (!out) return path.resolve(cwd, safeName);
  const resolved = resolvePath(cwd, out);
  const looksLikeDirectory = out.endsWith('/') || out.endsWith('\\');
  if (looksLikeDirectory) return path.resolve(resolved, safeName);
  try {
    if (fs.statSync(resolved).isDirectory()) return path.resolve(resolved, safeName);
  } catch {
    // non-existent path: treat as a file name
  }
  return resolved;
}
