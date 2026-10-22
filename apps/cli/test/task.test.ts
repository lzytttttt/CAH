import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  json,
  makeImportResponse,
  makeSnapshot,
  makeTaskList,
  runCommand,
  makeExportResponse,
  makeBlocker,
  startFakeServer,
  TASK_ID,
  MODULE_ID,
  BLOCKER_ID,
  PATCH_ID,
  type FakeServer,
} from './helpers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const servers: FakeServer[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function makeServer(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cli-task-'));
  tempDirs.push(dir);
  return dir;
}

describe('task create', () => {
  it('sends a contract-valid request from the built-in template and prints ids', async () => {
    const server = await makeServer((_request, response) => {
      json(response, 200, {
        commandId: '11111111-1111-4111-8111-111111111111',
        duplicate: false,
        taskId: TASK_ID,
        artifactId: '33333333-3333-4333-8333-333333333333',
        revision: 0,
        moduleIds: [MODULE_ID],
      });
    });
    const result = await runCommand(
      ['task', 'create', '--title', '客户反馈整理', '--intent', '汇总并分级', '--template', 'cognitive-atrium', '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('错误');
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/tasks');
    const body = request.body as Record<string, unknown>;
    expect(body.title).toBe('客户反馈整理');
    expect(body.intent).toBe('汇总并分级');
    expect(body.artifactTitle).toBe('客户反馈整理');
    expect(body.templateId).toBe('cognitive-atrium');
    expect(body.modules).toEqual([]);
    expect(body.constraints).toEqual([]);
    expect(body.commandId).toMatch(UUID_RE);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    expect(document.exitCode).toBe(0);
    expect((document.data as Record<string, unknown>).taskId).toBe(TASK_ID);
    expect(result.stdout).toContain(TASK_ID);
  });

  it('accepts explicit modules and inline constraints', async () => {
    const server = await makeServer((_request, response) => {
      json(response, 200, {
        commandId: '11111111-1111-4111-8111-111111111111',
        duplicate: false,
        taskId: TASK_ID,
        artifactId: '33333333-3333-4333-8333-333333333333',
        revision: 0,
        moduleIds: [MODULE_ID],
      });
    });
    const modules = JSON.stringify([{ key: 'summary', title: '摘要', kind: 'markdown', order: 0, acceptanceCriteria: [] }]);
    const result = await runCommand(
      [
        'task',
        'create',
        '--title',
        'T',
        '--intent',
        'I',
        '--artifact-title',
        '交付物',
        '--modules',
        modules,
        '--constraint',
        '必须保留原始编号',
        '--constraint-kind',
        'hard',
      ],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    const body = server.requests[0]!.body as Record<string, unknown>;
    expect(body.templateId).toBeNull();
    const requestModules = body.modules as Array<Record<string, unknown>>;
    expect(requestModules).toHaveLength(1);
    expect(requestModules[0]!.key).toBe('summary');
    expect(requestModules[0]!.dependsOnKeys).toEqual([]);
    const constraints = body.constraints as Array<Record<string, unknown>>;
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatchObject({ id: 'c1', text: '必须保留原始编号', kind: 'hard' });
  });

  it('rejects locally when neither --modules nor --template is provided (exit 1, no request)', async () => {
    const server = await makeServer((_request, response) => json(response, 200, {}));
    const result = await runCommand(['task', 'create', '--title', 'T', '--intent', 'I'], { server: server.url });
    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(0);
    expect(result.stderr).toContain('--modules');
  });

  it('rejects invalid module JSON locally (exit 1)', async () => {
    const server = await makeServer((_request, response) => json(response, 200, {}));
    const result = await runCommand(
      ['task', 'create', '--title', 'T', '--intent', 'I', '--modules', '[{"key":"x"}]'],
      { server: server.url },
    );
    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(0);
    expect(result.stderr).toContain('校验失败');
  });
});

describe('task list', () => {
  it('renders the task list and returns JSON data', async () => {
    const server = await makeServer((_request, response) => json(response, 200, makeTaskList()));
    const human = await runCommand(['task', 'list'], { server: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('客户反馈整理');
    expect(server.requests[0]!.path).toBe('/api/tasks');

    const jsonResult = await runCommand(['task', 'list', '--json'], { server: server.url });
    expect(jsonResult.code).toBe(0);
    const document = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    expect((document.data as { tasks: unknown[] }).tasks).toHaveLength(1);
  });
});

describe('task status', () => {
  it('reports waiting-for-input with blockerId and resolutions (exit 2, not failure)', async () => {
    const blocker = makeBlocker();
    const server = await makeServer((_request, response) =>
      json(response, 200, makeSnapshot({ blockers: [blocker], activeRun: null })),
    );
    const result = await runCommand(['task', 'status', TASK_ID, '--json'], { server: server.url });
    expect(result.code).toBe(2);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(false);
    expect(document.status).toBe('waiting_for_input');
    expect(document.exitCode).toBe(2);
    const waiting = document.waitingForInput as Record<string, unknown>;
    expect(waiting.blockerId).toBe(BLOCKER_ID);
    expect((waiting.resolutions as unknown[]).length).toBe(1);
    expect((waiting.blockers as unknown[]).length).toBe(1);
    expect((waiting.nextCommands as string[])[0]).toContain('run resolve');
    expect(server.requests[0]!.path).toBe(`/api/tasks/${TASK_ID}/snapshot`);
  });

  it('shows module table, plan and pending patches in human output (exit 0)', async () => {
    const server = await makeServer((_request, response) =>
      json(
        response,
        200,
        makeSnapshot({
          patches: [
            {
              patchId: PATCH_ID,
              moduleId: MODULE_ID,
              status: 'proposed',
              validationStatus: 'pass',
              createdAt: '2026-10-22T12:00:00.000Z',
            },
          ],
        }),
      ),
    );
    const result = await runCommand(['task', 'status', TASK_ID], { server: server.url });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('客户反馈整理');
    expect(result.stdout).toContain('执行摘要');
    expect(result.stdout).toContain(PATCH_ID);
    expect(result.stdout).toContain('artifact review');
  });
});

describe('task export', () => {
  it('writes the decoded file and verifies sha256 + byte count', async () => {
    const dir = tempDir();
    const content = Buffer.from('# 报告\n\n内容\n', 'utf8');
    const server = await makeServer((_request, response) => json(response, 200, makeExportResponse(content)));
    const outputPath = path.join(dir, 'report.md');
    const result = await runCommand(
      ['task', 'export', TASK_ID, '--format', 'markdown', '--out', outputPath, '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    expect(fs.readFileSync(outputPath)).toEqual(content);
    const body = server.requests[0]!.body as Record<string, unknown>;
    expect(server.requests[0]!.path).toBe(`/api/tasks/${TASK_ID}/export`);
    expect(body.format).toBe('markdown');
    expect(body.moduleIds).toEqual([]);
    expect(body.includeSources).toBe(false);
    expect(body.commandId).toMatch(UUID_RE);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = document.data as Record<string, unknown>;
    expect((data.integrity as Record<string, unknown>).sha256Verified).toBe(true);
    expect((data.integrity as Record<string, unknown>).bytesVerified).toBe(true);
    expect(data.outputPath).toBe(outputPath);
  });

  it('fails with exit 5 when the server sha256 does not match the payload', async () => {
    const dir = tempDir();
    const content = Buffer.from('# 报告');
    const server = await makeServer((_request, response) =>
      json(response, 200, makeExportResponse(content, { sha256: 'b'.repeat(64) })),
    );
    const outputPath = path.join(dir, 'report.md');
    const result = await runCommand(
      ['task', 'export', TASK_ID, '--format', 'markdown', '--out', outputPath, '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(5);
    expect(fs.existsSync(outputPath)).toBe(false);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(false);
    expect((document.error as Record<string, unknown>).code).toBe('integrity_error');
  });
});

describe('import', () => {
  it('uploads the package bytes and reports rebinding', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'package.zip');
    fs.writeFileSync(file, Buffer.from('fake-zip-bytes'));
    const server = await makeServer((_request, response) =>
      json(response, 200, makeImportResponse({ sourcesNeedRebinding: true })),
    );
    const result = await runCommand(['import', file, '--json'], { server: server.url });
    expect(result.code).toBe(0);
    const request = server.requests[0]!;
    expect(request.path).toBe('/api/imports');
    const body = request.body as Record<string, unknown>;
    expect(body.fileName).toBe('package.zip');
    expect(Buffer.from(String(body.contentBase64), 'base64').toString('utf8')).toBe('fake-zip-bytes');
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    expect(result.stdout).toContain('sourcesNeedRebinding');
  });
});

describe('source import', () => {
  it('uploads a source file with inferred mime and reports parse status', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'brief.md');
    fs.writeFileSync(file, '# 简报');
    const server = await makeServer((_request, response) =>
      json(response, 200, {
        commandId: '11111111-1111-4111-8111-111111111111',
        duplicate: false,
        sourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        version: 1,
        parseStatus: 'parsed',
        parseNote: '',
        warnings: [],
      }),
    );
    const result = await runCommand(['source', 'import', TASK_ID, '--file', file], { server: server.url });
    expect(result.code).toBe(0);
    const request = server.requests[0]!;
    expect(request.path).toBe(`/api/tasks/${TASK_ID}/sources`);
    const body = request.body as Record<string, unknown>;
    expect(body.mime).toBe('text/markdown');
    expect(body.origin).toBe('upload');
  });

  it('returns exit 4 when the server cannot parse the source', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'x.bin');
    fs.writeFileSync(file, Buffer.from([0, 1, 2]));
    const server = await makeServer((_request, response) =>
      json(response, 200, {
        commandId: '11111111-1111-4111-8111-111111111111',
        duplicate: false,
        sourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        version: 1,
        parseStatus: 'failed',
        parseNote: '不支持的二进制内容',
        warnings: [],
      }),
    );
    const result = await runCommand(['source', 'import', TASK_ID, '--file', file, '--json'], { server: server.url });
    expect(result.code).toBe(4);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(false);
    expect((document.error as Record<string, unknown>).code).toBe('source_parse_failed');
  });
});
