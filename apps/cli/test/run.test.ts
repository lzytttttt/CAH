import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  json,
  makeBlocker,
  makeCreateRunResponse,
  makePlan,
  makeResolutionOption,
  makeRunControlResponse,
  makeRunDetail,
  makeModuleView,
  makeSnapshot,
  makeUsage,
  runCommand,
  startFakeServer,
  BLOCKER_ID,
  CONTEXT_SNAPSHOT_ID,
  MODULE_ID,
  RUN_ID,
  TASK_ID,
  uuidFor,
  type FakeServer,
} from './helpers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const servers: FakeServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});
async function makeServer(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

function steps() {
  return [
    { stepId: uuidFor(2001), kind: 'context', title: '组装上下文', status: 'completed', summary: '', startedAt: null, finishedAt: null },
    { stepId: uuidFor(2002), kind: 'model', title: '生成候选', status: 'completed', summary: '', startedAt: null, finishedAt: null },
    { stepId: uuidFor(2003), kind: 'tool', title: '读取资料', status: 'running', summary: '', startedAt: null, finishedAt: null },
    { stepId: uuidFor(2004), kind: 'validate', title: '验证候选', status: 'pending', summary: '', startedAt: null, finishedAt: null },
    { stepId: uuidFor(2005), kind: 'commit', title: '提交成果', status: 'pending', summary: '', startedAt: null, finishedAt: null },
  ];
}

describe('run start', () => {
  it('reads the task revision first, then POSTs a contract-valid run request', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/tasks/${TASK_ID}/runs`) {
        return json(response, 200, makeCreateRunResponse());
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(
      ['run', 'start', TASK_ID, '--module', MODULE_ID, '--intent', '补齐交付物', '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    const post = server.requests.find((request) => request.method === 'POST')!;
    const body = post.body as Record<string, unknown>;
    expect(body.expectedRevision).toBe(3);
    expect(body.moduleId).toBe(MODULE_ID);
    expect(body.planFirst).toBe(true);
    expect(body.intent).toBe('补齐交付物');
    expect(body.commandId).toMatch(UUID_RE);
    expect((document.data as Record<string, unknown>).run).toMatchObject({ runId: RUN_ID, state: 'READY' });
  });

  it('requires --module when the task has several modules (exit 1, no request)', async () => {
    const server = await makeServer((request, response) => {
      if (request.path === `/api/tasks/${TASK_ID}/snapshot`) {
        return json(response, 200, makeSnapshot({ modules: [makeModuleView(), makeModuleView('55555555-5555-4555-8555-555555555555')] }));
      }
      return json(response, 200, {});
    });
    const result = await runCommand(['run', 'start', TASK_ID, '--intent', 'x'], { server: server.url });
    expect(result.code).toBe(1);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(result.stderr).toContain('--module');
  });

  it('reports waiting_for_input with blocker details (exit 2)', async () => {
    const blocker = makeBlocker();
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/tasks/${TASK_ID}/runs`) {
        return json(response, 200, makeCreateRunResponse({ state: 'AWAITING_INPUT', plan: null }));
      }
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'AWAITING_INPUT' }, blockers: [blocker] }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(
      ['run', 'start', TASK_ID, '--module', MODULE_ID, '--intent', 'x', '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(2);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.status).toBe('waiting_for_input');
    expect(document.ok).toBe(false);
    const waiting = document.waitingForInput as Record<string, unknown>;
    expect(waiting.blockerId).toBe(BLOCKER_ID);
    expect((waiting.resolutions as unknown[]).length).toBe(1);
  });

  it('waits for the plan with --wait and reports READY', async () => {
    let runGets = 0;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/tasks/${TASK_ID}/runs`) {
        return json(response, 200, makeCreateRunResponse({ state: 'PLANNING', plan: null }));
      }
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        runGets += 1;
        if (runGets === 1) {
          return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'PLANNING' } }));
        }
        return json(
          response,
          200,
          makeRunDetail({
            run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'READY' },
            plan: makePlan(),
            contextSnapshot: {
              id: CONTEXT_SNAPSHOT_ID,
              taskId: TASK_ID,
              runId: RUN_ID,
              stepId: null,
              promptBundleVersion: 'prompts-1',
              promptTemplateHashes: {},
              fragments: [],
              estimatedInputTokens: 10,
              omitted: [],
              createdAt: '2026-10-22T12:00:00.000Z',
            },
          }),
        );
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(
      ['run', 'start', TASK_ID, '--module', MODULE_ID, '--intent', 'x', '--wait', '--interval', '10', '--json'],
      { server: server.url, timeoutMs: 3000 },
    );
    expect(result.code).toBe(0);
    expect(runGets).toBeGreaterThanOrEqual(2);
    expect(result.stderr).toContain('[wait]');
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).detail).not.toBeNull();
  });
});

describe('run status', () => {
  it('reports real step progress and budget (never a fabricated percentage)', async () => {
    const detail = makeRunDetail({
      steps: steps(),
      run: {
        ...(makeRunDetail().run as Record<string, unknown>),
        state: 'RUNNING',
        budgetUsage: makeUsage({ modelRequests: 3, toolCalls: 2, inputTokens: 1500, outputTokens: 800, usdCost: 0.0012, elapsedActiveMs: 12_300 }),
      },
    });
    const server = await makeServer((_request, response) => json(response, 200, detail));
    const human = await runCommand(['run', 'status', RUN_ID], { server: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('2/5 完成');
    expect(human.stdout).toContain('进行中：读取资料');
    expect(human.stdout).toContain('模型请求 3');
    expect(human.stdout).not.toMatch(/\d+%/);

    const jsonResult = await runCommand(['run', 'status', RUN_ID, '--json'], { server: server.url });
    const document = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    expect(((document.data as Record<string, unknown>).steps as unknown[]).length).toBe(5);
  });

  it('reports a failed run with a non-zero exit code and machine-readable state', async () => {
    const server = await makeServer((_request, response) =>
      json(
        response,
        200,
        makeRunDetail({
          run: {
            ...(makeRunDetail().run as Record<string, unknown>),
            state: 'FAILED',
            error: { code: 'validation_failed', message: '候选未通过验证', retryable: false, stage: 'validation' },
            finishedAt: '2026-10-22T12:01:00.000Z',
          },
        }),
      ),
    );
    const result = await runCommand(['run', 'status', RUN_ID, '--json'], { server: server.url });
    expect(result.code).toBe(4);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(false);
    expect(document.status).toBe('failed');
    expect((document.error as Record<string, unknown>).code).toBe('validation_failed');
  });

  it('reports a cancelled run as cancelled (exit 4)', async () => {
    const server = await makeServer((_request, response) =>
      json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'CANCELLED' } })),
    );
    const result = await runCommand(['run', 'status', RUN_ID, '--json'], { server: server.url });
    expect(result.code).toBe(4);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.status).toBe('cancelled');
    expect(result.stdout).toContain('正式版本未被修改');
  });

  it('reports waiting_for_input when blockers are open (exit 2)', async () => {
    const server = await makeServer((_request, response) =>
      json(
        response,
        200,
        makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'AWAITING_INPUT' }, blockers: [makeBlocker()] }),
      ),
    );
    const result = await runCommand(['run', 'status', RUN_ID, '--json'], { server: server.url });
    expect(result.code).toBe(2);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.status).toBe('waiting_for_input');
    expect((document.waitingForInput as Record<string, unknown>).blockerId).toBe(BLOCKER_ID);
  });
});

describe('run commit', () => {
  it('uses planVersion/contextSnapshotId from the run detail and the fresh task revision', async () => {
    const snapshot = makeSnapshot();
    (snapshot.task as Record<string, unknown>).revision = 6;
    const detail = makeRunDetail({
      run: {
        ...(makeRunDetail().run as Record<string, unknown>),
        state: 'READY',
        planVersion: 2,
        contextSnapshotId: CONTEXT_SNAPSHOT_ID,
      },
      plan: makePlan({ version: 2 }),
    });
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) return json(response, 200, detail);
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, snapshot);
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/commit`) {
        return json(response, 200, makeRunControlResponse({ state: 'RUNNING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['run', 'commit', RUN_ID, '--json'], { server: server.url });
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect(post.body).toMatchObject({
      expectedRevision: 6,
      planVersion: 2,
      contextSnapshotId: CONTEXT_SNAPSHOT_ID,
    });
    expect((post.body as Record<string, unknown>).commandId).toMatch(UUID_RE);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).control).toMatchObject({ state: 'RUNNING' });
  });

  it('refuses to commit a run that is not READY (exit 4, no POST)', async () => {
    const server = await makeServer((_request, response) =>
      json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'RUNNING' } })),
    );
    const result = await runCommand(['run', 'commit', RUN_ID], { server: server.url });
    expect(result.code).toBe(4);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(result.stderr).toContain('READY');
  });
});

describe('run resolve', () => {
  it('validates and submits a choose answer, then reports the fresh state', async () => {
    const blocker = makeBlocker();
    let runGets = 0;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        runGets += 1;
        if (runGets === 1) {
          return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'AWAITING_INPUT' }, blockers: [blocker] }));
        }
        return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'RUNNING' } }));
      }
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/resolve`) {
        return json(response, 200, makeRunControlResponse({ state: 'RUNNING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(
      ['run', 'resolve', RUN_ID, '--blocker', BLOCKER_ID, '--option', 'opt-choice', '--value', 'keep', '--note', '确认保留', '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect(post.body).toMatchObject({
      blockerId: BLOCKER_ID,
      optionId: 'opt-choice',
      value: 'keep',
      note: '确认保留',
      expectedRevision: 3,
    });
    expect(runGets).toBe(2);
  });

  it('rejects an invalid choose value locally (exit 1, no POST)', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        return json(response, 200, makeRunDetail({ blockers: [makeBlocker()] }));
      }
      return json(response, 200, makeSnapshot());
    });
    const result = await runCommand(
      ['run', 'resolve', RUN_ID, '--blocker', BLOCKER_ID, '--option', 'opt-choice', '--value', 'nope'],
      { server: server.url },
    );
    expect(result.code).toBe(1);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(result.stderr).toContain('有效选项');
  });

  it('builds bind_source values from --source-id/--source-version', async () => {
    const blocker = makeBlocker({ resolutions: [makeResolutionOption({ id: 'bind', kind: 'bind_source', label: '绑定资料', acceptsMime: [], purpose: '' })] });
    let runGets = 0;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        runGets += 1;
        if (runGets === 1) {
          return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'AWAITING_INPUT' }, blockers: [blocker] }));
        }
        return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'RUNNING' } }));
      }
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/resolve`) {
        return json(response, 200, makeRunControlResponse({ state: 'RUNNING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const sourceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const result = await runCommand(
      ['run', 'resolve', RUN_ID, '--blocker', BLOCKER_ID, '--option', 'bind', '--source-id', sourceId, '--source-version', '2'],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect((post.body as Record<string, unknown>).value).toEqual({ sourceId, version: 2 });
  });

  it('fills the bind_source version from the task snapshot sources', async () => {
    const sourceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const blocker = makeBlocker({ resolutions: [makeResolutionOption({ id: 'bind', kind: 'bind_source', label: '绑定资料', acceptsMime: [], purpose: '' })] });
    const snapshot = makeSnapshot({
      sources: [
        { sourceId, name: 'brief.md', version: 4, availability: 'available', spanCount: 2, trustLevel: 'user_provided', previewSpanIds: [] },
      ],
    });
    let runGets = 0;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        runGets += 1;
        if (runGets === 1) {
          return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'AWAITING_INPUT' }, blockers: [blocker] }));
        }
        return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'RUNNING' } }));
      }
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, snapshot);
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/resolve`) {
        return json(response, 200, makeRunControlResponse({ state: 'RUNNING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(
      ['run', 'resolve', RUN_ID, '--blocker', BLOCKER_ID, '--option', 'bind', '--source-id', sourceId],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect((post.body as Record<string, unknown>).value).toEqual({ sourceId, version: 4 });
  });

  it('uses the declared default itemRef for exclude answers', async () => {
    const blocker = makeBlocker({
      resolutions: [makeResolutionOption({ id: 'ex', kind: 'exclude', label: '排除', itemLabel: '旧系统', itemRef: 'legacy-1' })],
    });
    let runGets = 0;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        runGets += 1;
        if (runGets === 1) {
          return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'AWAITING_INPUT' }, blockers: [blocker] }));
        }
        return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'RUNNING' } }));
      }
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/resolve`) {
        return json(response, 200, makeRunControlResponse({ state: 'RUNNING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['run', 'resolve', RUN_ID, '--blocker', BLOCKER_ID, '--option', 'ex'], { server: server.url });
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect((post.body as Record<string, unknown>).value).toEqual({ itemRef: 'legacy-1' });
  });
});

describe('run control commands', () => {
  it('pauses a RUNNING run with an expectedRevision guard', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) return json(response, 200, makeRunDetail());
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/pause`) {
        return json(response, 200, makeRunControlResponse({ state: 'PAUSING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['run', 'pause', RUN_ID, '--reason', '整理资料', '--json'], { server: server.url });
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect(post.body).toMatchObject({ expectedRevision: 3, reason: '整理资料' });
    expect(result.stdout).toContain('PAUSING');
  });

  it('refuses to pause a finished run (exit 4, no POST)', async () => {
    const server = await makeServer((_request, response) =>
      json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'COMPLETED' } })),
    );
    const result = await runCommand(['run', 'pause', RUN_ID], { server: server.url });
    expect(result.code).toBe(4);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('resumes a PAUSED run', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) {
        return json(response, 200, makeRunDetail({ run: { ...(makeRunDetail().run as Record<string, unknown>), state: 'PAUSED' } }));
      }
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/resume`) {
        return json(response, 200, makeRunControlResponse({ state: 'RUNNING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['run', 'resume', RUN_ID], { server: server.url });
    expect(result.code).toBe(0);
    expect(server.requests.some((request) => request.path === `/api/runs/${RUN_ID}/resume`)).toBe(true);
  });

  it('cancels a RUNNING run and states that no result was accepted', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) return json(response, 200, makeRunDetail());
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      if (request.method === 'POST' && request.path === `/api/runs/${RUN_ID}/cancel`) {
        return json(response, 200, makeRunControlResponse({ state: 'CANCELLING' }));
      }
      apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['run', 'cancel', RUN_ID, '--json'], { server: server.url });
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).control).toMatchObject({ state: 'CANCELLING' });
  });
});

describe('run conflict handling', () => {
  it('maps 409 revision_conflict to exit 4 with an actionable hint', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/runs/${RUN_ID}`) return json(response, 200, makeRunDetail());
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      apiError(response, 409, 'revision_conflict', '任务已被其他命令修改', { retryable: false });
    });
    const result = await runCommand(['run', 'pause', RUN_ID], { server: server.url });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('revision_conflict');
    expect(result.stderr).toContain('未覆盖任何数据');
  });
});
