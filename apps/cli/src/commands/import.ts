/** `import` and `source import` commands (task packages and evidence uploads). */
import path from 'node:path';
import {
  API_ROUTES,
  ImportRequestSchema,
  ImportResponseSchema,
  LIMITS,
  SourceImportRequestSchema,
  SourceImportResponseSchema,
  TaskIdSchema,
} from '@ca/contracts';
import { EXIT } from '../exit';
import { heading } from '../format';
import { base64Encode, readBinaryFile } from '../io';
import type { CommandSpec } from './types';
import { businessOutcome, commandId, okOutcome, parseId, validateRequest } from './shared';

/* ------------------------------------------------------------------ */
/* import (task package)                                               */
/* ------------------------------------------------------------------ */

export const importCommand: CommandSpec = {
  path: 'import',
  summary: '导入任务包 ZIP（不可信输入：服务端校验版本、路径、大小与哈希）',
  flags: {},
  positionals: [{ name: 'file', description: '任务包文件路径', required: true }],
  examples: ['cognitive-atrium import ./out/task-package.zip', 'cognitive-atrium import ./out/task-package.zip --json'],
  notes: ['导入不会自动执行包内配方，也不会自动激活工具连接。'],
  execute: async (command, ctx) => {
    const file = command.requirePositional(0, 'file');
    const resolved = path.resolve(ctx.cwd, file);
    const buffer = readBinaryFile(ctx.cwd, file, '任务包', LIMITS.maxImportPackageBytes);
    const request = validateRequest(
      ImportRequestSchema,
      {
        commandId: commandId(ctx),
        fileName: path.basename(resolved),
        contentBase64: base64Encode(buffer),
      },
      '任务包导入请求',
    );
    const response = await ctx.client.post(ImportResponseSchema, API_ROUTES.imports, request);
    const human = [
      heading('任务包已导入'),
      `  任务：${response.taskId}`,
      `  文件：${path.basename(resolved)}（${buffer.byteLength} 字节）`,
      ...(response.warnings.length ? [`  警告 ${response.warnings.length} 条：`, ...response.warnings.map((warning) => `    - ${warning}`)] : []),
    ];
    if (response.sourcesNeedRebinding) {
      human.push('  注意：包内未携带原始资料，导入后来源需要重新绑定（证据暂时不可读取，不会伪装为可用）。');
      human.push(`  重新上传：cognitive-atrium source import ${response.taskId} --file <路径>`);
    }
    human.push(`  查看任务：cognitive-atrium task status ${response.taskId}`);
    return okOutcome('import', response, human);
  },
};

/* ------------------------------------------------------------------ */
/* source import (extra, needed by bind_source blockers)               */
/* ------------------------------------------------------------------ */

const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export const sourceImportCommand: CommandSpec = {
  path: 'source import',
  summary: '导入任务资料（上传原始字节，服务端解析并生成证据）',
  flags: {
    '--file': { type: 'string', valueName: '<路径>', description: '资料文件路径（必填）' },
    '--mime': { type: 'string', valueName: '<mime>', description: '显式指定 MIME 类型（默认按扩展名推断）' },
  },
  positionals: [{ name: 'taskId', description: '任务 ID', required: true }],
  examples: ['cognitive-atrium source import <taskId> --file ./brief.md', 'cognitive-atrium source import <taskId> --file ./table.csv --mime text/csv --json'],
  notes: ['只支持明确列出的文本/表格格式；解析失败会如实返回，不会伪装为可用证据。'],
  execute: async (command, ctx) => {
    const taskId = parseId(command.requirePositional(0, 'taskId'), TaskIdSchema, 'taskId');
    const file = command.requireString('--file', '资料文件路径');
    const resolved = path.resolve(ctx.cwd, file);
    const buffer = readBinaryFile(ctx.cwd, file, '资料文件', LIMITS.maxSourceFileBytes);
    const mime = command.getString('--mime') ?? MIME_BY_EXTENSION[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    const request = validateRequest(
      SourceImportRequestSchema,
      {
        commandId: commandId(ctx),
        fileName: path.basename(resolved),
        mime,
        contentBase64: base64Encode(buffer),
        origin: 'upload',
      },
      '资料导入请求',
    );
    const response = await ctx.client.post(SourceImportResponseSchema, API_ROUTES.taskSources(taskId), request);
    const human = [
      heading('资料已导入'),
      `  资料：${response.sourceId} v${response.version}`,
      `  文件：${path.basename(resolved)}（${buffer.byteLength} 字节，${mime}）`,
      `  解析状态：${response.parseStatus}${response.parseNote ? ` — ${response.parseNote}` : ''}`,
      ...(response.warnings.length ? [`  警告 ${response.warnings.length} 条：`, ...response.warnings.map((warning) => `    - ${warning}`)] : []),
    ];
    if (response.parseStatus !== 'parsed') {
      human.push('  结论：资料内容未能解析为可用证据，不会用于生成成果。');
      return businessOutcome('source import', response, human, {
        exitCode: EXIT.STATE,
        status: 'failed',
        error: {
          kind: 'api',
          code: `source_parse_${response.parseStatus}`,
          message:
            response.parseStatus === 'unsupported'
              ? `不支持的文件类型或格式：${mime}`
              : `资料解析失败：${response.parseNote || '未知原因'}`,
        },
      });
    }
    human.push('  下一步：', `    cognitive-atrium task status ${taskId}`, `    cognitive-atrium run start ${taskId} --intent "..." --source ${response.sourceId}`);
    return okOutcome('source import', response, human);
  },
};

export const importCommands: CommandSpec[] = [importCommand, sourceImportCommand];
