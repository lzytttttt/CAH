import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  json,
  makeExportResponse,
  makeSession,
  runCommand,
  startFakeServer,
  TASK_ID,
  type FakeServer,
} from './helpers';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cli-exit-'));
  tempDirs.push(dir);
  return dir;
}

describe('exit-code contract', () => {
  it('maps 401 to exit 3 with auth diagnostics and still attempts the request when the token file is missing', async () => {
    const server = await makeServer((_request, response) => apiError(response, 401, 'session_required', '需要本地会话令牌'));
    const emptyDataDir = tempDir();
    const result = await runCommand(['session', '--json'], {
      server: server.url,
      env: { CA_SESSION_TOKEN: undefined, CA_DATA_DIR: emptyDataDir },
    });
    expect(result.code).toBe(3);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(false);
    expect(document.exitCode).toBe(3);
    const error = document.error as Record<string, unknown>;
    expect(error.code).toBe('session_required');
    expect(String(error.hint)).toContain('token-file');
    expect(result.stderr).toContain('会话令牌');
  });

  it('sends the bearer token read from --token-file', async () => {
    const dir = tempDir();
    const tokenFile = path.join(dir, 'session-token');
    fs.writeFileSync(tokenFile, 'file-token\n');
    const server = await makeServer((_request, response) => json(response, 200, makeSession()));
    const result = await runCommand(['session', '--json'], {
      server: server.url,
      tokenFile,
      env: { CA_SESSION_TOKEN: undefined, CA_DATA_DIR: dir },
    });
    expect(result.code).toBe(0);
    expect(server.requests[0]!.headers.authorization).toBe('Bearer file-token');
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).mode).toBe('live');
  });

  it('maps connection failures to exit 3 (network_error)', async () => {
    const dead = await startFakeServer((_request, response) => json(response, 200, makeSession()));
    const deadUrl = dead.url;
    await dead.close();
    const result = await runCommand(['session', '--json'], { server: deadUrl, timeoutMs: 500 });
    expect(result.code).toBe(3);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.status).toBe('error');
    expect((document.error as Record<string, unknown>).code).toBe('network_error');
    expect(String((document.error as Record<string, unknown>).message)).toContain(deadUrl);
  });

  it('maps server-side 500 to exit 5 after bounded GET retries', async () => {
    let calls = 0;
    const server = await makeServer((_request, response) => {
      calls += 1;
      apiError(response, 500, 'internal_error', 'boom', { retryable: true });
    });
    const result = await runCommand(['session', '--json'], { server: server.url });
    expect(result.code).toBe(5);
    expect(calls).toBe(3);
  });

  it('maps 422 validation failures to exit 4', async () => {
    const server = await makeServer((_request, response) => apiError(response, 422, 'schema_invalid', '请求结构非法'));
    const result = await runCommand(['task', 'list', '--json'], { server: server.url });
    expect(result.code).toBe(4);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.error as Record<string, unknown>).code).toBe('schema_invalid');
  });

  it('uses exit 1 for usage errors (unknown command, missing args, bad duration)', async () => {
    const unknown = await runCommand(['bogus', 'command']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('未知命令');

    const missing = await runCommand(['run', 'status']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('缺少参数');

    const badTimeout = await runCommand(['session', '--timeout', 'abc']);
    expect(badTimeout.code).toBe(1);
  });

  it('prints help/version and exits 0 without touching the server', async () => {
    const help = await runCommand(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('用法');
    expect(help.stdout).toContain('退出码');

    const commandHelp = await runCommand(['run', 'resolve', '--help']);
    expect(commandHelp.code).toBe(0);
    expect(commandHelp.stdout).toContain('--blocker');

    const version = await runCommand(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain('0.1.0');

    const groupHelp = await runCommand(['task', '--help']);
    expect(groupHelp.code).toBe(0);
    expect(groupHelp.stdout).toContain('task create');
  });

  it('generates a fresh commandId for every invocation and passes it through', async () => {
    const dir = tempDir();
    const content = Buffer.from('# ok');
    const server = await makeServer((_request, response) => json(response, 200, makeExportResponse(content)));
    const first = await runCommand(['task', 'export', TASK_ID, '--format', 'markdown', '--out', path.join(dir, 'a.md')], {
      server: server.url,
    });
    const second = await runCommand(['task', 'export', TASK_ID, '--format', 'markdown', '--out', path.join(dir, 'b.md')], {
      server: server.url,
    });
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const commandIds = server.requests.map((request) => (request.body as Record<string, unknown>).commandId as string);
    expect(commandIds).toHaveLength(2);
    expect(commandIds[0]).not.toBe(commandIds[1]);
    expect(new Set(commandIds).size).toBe(2);
  });

  it('keeps stdout as one JSON document in --json mode even with progress logs', async () => {
    const server = await makeServer((request, response) => {
      if (request.path === `/api/tasks/${TASK_ID}/snapshot`) {
        return json(response, 200, {
          snapshotSeq: 0,
          serverTime: '2026-10-22T12:00:00.000Z',
          workspace: { workspaceId: '11111111-1111-4111-8111-111111111111', mode: 'live', name: 'L', settings: {}, policyVersion: 'p0-policy-1' },
          task: {
            id: TASK_ID,
            workspaceId: '11111111-1111-4111-8111-111111111111',
            title: 't',
            intent: 'i',
            constraints: [],
            artifactId: '33333333-3333-4333-8333-333333333333',
            revision: 1,
            templateId: null,
            status: 'active',
            createdAt: '2026-10-22T12:00:00.000Z',
            updatedAt: '2026-10-22T12:00:00.000Z',
          },
          artifact: {
            id: '33333333-3333-4333-8333-333333333333',
            taskId: TASK_ID,
            title: 'A',
            moduleIds: ['44444444-4444-4444-8444-444444444444'],
            acceptedVersionId: null,
            status: 'draft',
            createdAt: '2026-10-22T12:00:00.000Z',
            updatedAt: '2026-10-22T12:00:00.000Z',
          },
          modules: [],
          plan: null,
          runs: [],
          activeRun: null,
          blockers: [],
          patches: [],
          validations: [],
          sources: [],
          spans: [],
          prospects: [],
          recipes: [],
          spatial: {
            nodes: [],
            edges: [],
            stage: { phase: 'idle', label: 'l', completedSteps: null, totalSteps: null, activeStepTitle: null, note: '' },
            counts: { branchCount: 0, nodeCount: 0, edgeCount: 0, collapsedNodes: 0, byKind: {} },
            activeBranchId: null,
            focusHint: '',
          },
          control: {
            runId: null,
            state: null,
            canPause: false,
            canResume: false,
            canCancel: false,
            budgetLabel: '',
            providerLabel: '',
            connectionStatus: 'unknown',
            queuePosition: null,
            unsavedDraft: false,
          },
          usage: null,
          events: [],
          limits: { maxSpatialBranches: 3, maxSpatialNodes: 12, maxSpatialEdges: 16 },
        });
      }
      return apiError(response, 404, 'not_found', 'not found');
    });
    const result = await runCommand(['task', 'status', TASK_ID, '--json'], { server: server.url });
    expect(result.code).toBe(0);
    // A single JSON document must parse as a whole.
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    expect(result.stdout.trim().startsWith('{')).toBe(true);
  });
});
