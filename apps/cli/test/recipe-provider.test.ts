import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  json,
  makeCapabilityReport,
  makeCreateRecipeResponse,
  makeProposeRecipeResponse,
  makeRecipe,
  makeRecipeRunResult,
  makeRunRecipeResponse,
  makeValidateRecipeResponse,
  makeWorkspaceView,
  runCommand,
  startFakeServer,
  PROFILE_ID,
  RECIPE_ID,
  RUN_ID,
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

describe('provider test', () => {
  it('resolves the single configured profile, posts probes and prints per-probe status', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === '/api/workspace') return json(response, 200, makeWorkspaceView());
      if (request.method === 'POST' && request.path === `/api/provider-profiles/${PROFILE_ID}/test`) {
        return json(response, 200, { commandId: uuidFor(20), duplicate: false, report: makeCapabilityReport() });
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const human = await runCommand(['provider', 'test'], { server: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('已验证');
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect(post.body).toMatchObject({ probes: ['auth_and_text'], confirmCharges: false });
    expect((post.body as Record<string, unknown>).commandId).toMatch(UUID_RE);
  });

  it('requires --confirm-charges for extra probes (exit 1, no POST)', async () => {
    const server = await makeServer((request, response) => {
      if (request.path === '/api/workspace') return json(response, 200, makeWorkspaceView());
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['provider', 'test', '--probes', 'auth_and_text', '--probes', 'streaming'], { server: server.url });
    expect(result.code).toBe(1);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(result.stderr).toContain('confirm-charges');
  });

  it('sends confirmed multi-probe requests and reports probe errors as failure (exit 4)', async () => {
    const report = makeCapabilityReport({
      probes: [
        {
          capability: 'streaming',
          status: 'error',
          detail: '连接被拒绝',
          latencyMs: null,
          testedModel: null,
          testedAt: '2026-10-22T12:00:00.000Z',
          error: { code: 'network_error', message: 'connect ECONNREFUSED', retryable: true, httpStatus: null, retryAfterMs: null, providerRequestId: null },
        },
      ],
    });
    const server = await makeServer((request, response) => {
      if (request.path === '/api/workspace') return json(response, 200, makeWorkspaceView());
      if (request.method === 'POST' && request.path.endsWith('/test')) {
        return json(response, 200, { commandId: uuidFor(21), duplicate: false, report });
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(
      ['provider', 'test', '--probes', 'auth_and_text', '--probes', 'streaming', '--confirm-charges', '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(4);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect((post.body as Record<string, unknown>).confirmCharges).toBe(true);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(false);
    expect((document.error as Record<string, unknown>).code).toBe('provider_probe_error');
  });

  it('requires --profile when several profiles exist (exit 1)', async () => {
    const view = makeWorkspaceView();
    const profiles = view.providerProfiles as Array<Record<string, unknown>>;
    view.providerProfiles = [profiles[0], { ...profiles[0]!, id: uuidFor(30), profileName: '第二个连接' }];
    const server = await makeServer((request, response) => {
      if (request.path === '/api/workspace') return json(response, 200, view);
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['provider', 'test'], { server: server.url });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--profile');
  });
});

describe('recipe save', () => {
  it('extracts the proposal server-side and registers a candidate recipe', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'POST' && request.path === '/api/recipes/propose') {
        return json(response, 200, makeProposeRecipeResponse());
      }
      if (request.method === 'POST' && request.path === '/api/recipes') {
        return json(response, 200, makeCreateRecipeResponse());
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(
      ['recipe', 'save', '--run-id', RUN_ID, '--name', '反馈归类', '--kind', 'deterministic', '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    const proposeBody = server.requests[0]!.body as Record<string, unknown>;
    expect(server.requests[0]!.path).toBe('/api/recipes/propose');
    expect(proposeBody).toMatchObject({ runId: RUN_ID, name: '反馈归类', kind: 'deterministic', description: '', applicability: '' });
    expect(proposeBody.commandId).toMatch(UUID_RE);
    const createBody = server.requests[1]!.body as Record<string, unknown>;
    expect(server.requests[1]!.path).toBe('/api/recipes');
    expect((createBody.proposal as Record<string, unknown>).runId).toBe(RUN_ID);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).recipe).toMatchObject({ recipeId: RECIPE_ID, status: 'candidate' });
  });

  it('requires --name and --kind in extraction mode (exit 1)', async () => {
    const server = await makeServer((_request, response) => json(response, 200, {}));
    const result = await runCommand(['recipe', 'save', '--run-id', RUN_ID], { server: server.url });
    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(0);
  });
});

describe('recipe validate', () => {
  it('posts test inputs and reports an accepted recipe', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'POST' && request.path === `/api/recipes/${RECIPE_ID}/validate`) {
        return json(response, 200, makeValidateRecipeResponse());
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const testInputs = JSON.stringify([{ testCaseId: 't1', inputs: { input: 'a' } }]);
    const result = await runCommand(['recipe', 'validate', RECIPE_ID, '--test-inputs', testInputs, '--json'], {
      server: server.url,
    });
    expect(result.code).toBe(0);
    const body = server.requests[0]!.body as Record<string, unknown>;
    expect(body.testInputs).toEqual([{ testCaseId: 't1', inputs: { input: 'a' } }]);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).status).toBe('validated');
  });

  it('returns exit 4 when a test case fails', async () => {
    const response = makeValidateRecipeResponse({ status: 'candidate' });
    response.testCases = [
      {
        id: 't1',
        label: '原始输入',
        kind: 'original',
        inputs: { input: 'a' },
        expectation: 'accept',
        status: 'failed',
        detail: '输出与期望不一致',
        normalizedOutputHash: null,
        lastRunAt: null,
      },
    ];
    const server = await makeServer((_request, responder) => json(responder, 200, response));
    const testInputs = JSON.stringify([{ testCaseId: 't1', inputs: { input: 'a' } }]);
    const result = await runCommand(['recipe', 'validate', RECIPE_ID, '--test-inputs', testInputs, '--json'], {
      server: server.url,
    });
    expect(result.code).toBe(4);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.status).toBe('failed');
    expect((document.error as Record<string, unknown>).code).toBe('recipe_validation_failed');
  });

  it('rejects malformed test-input JSON locally (exit 1)', async () => {
    const server = await makeServer((_request, response) => json(response, 200, {}));
    const result = await runCommand(['recipe', 'validate', RECIPE_ID, '--test-inputs', '{"bad":true}'], {
      server: server.url,
    });
    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(0);
  });
});

describe('recipe run', () => {
  it('runs a validated recipe and prints deterministic accounting (0 LLM calls)', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/recipes/${RECIPE_ID}`) {
        return json(response, 200, { recipe: makeRecipe() });
      }
      if (request.method === 'POST' && request.path === `/api/recipes/${RECIPE_ID}/run`) {
        return json(response, 200, makeRunRecipeResponse());
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const human = await runCommand(['recipe', 'run', RECIPE_ID, '--inputs', '{"input":"a"}'], { server: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('确定性路径');
    expect(human.stdout).toContain('LLM 调用 0 次');
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect((post.body as Record<string, unknown>).inputs).toEqual({ input: 'a' });
  });

  it('rejects an unvalidated recipe before calling the run route (exit 4)', async () => {
    const server = await makeServer((request, response) => {
      if (request.path === `/api/recipes/${RECIPE_ID}`) {
        return json(response, 200, { recipe: makeRecipe({ status: 'candidate' }) });
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['recipe', 'run', RECIPE_ID, '--inputs', '{"input":"a"}'], { server: server.url });
    expect(result.code).toBe(4);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(result.stderr).toContain('validated');
  });

  it('flags a deterministic recipe that reports LLM calls (exit 4, not a silent success)', async () => {
    const server = await makeServer((request, response) => {
      if (request.path === `/api/recipes/${RECIPE_ID}`) return json(response, 200, { recipe: makeRecipe() });
      if (request.method === 'POST') {
        return json(response, 200, makeRunRecipeResponse({ result: makeRecipeRunResult({ llmCalls: 2 }) }));
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['recipe', 'run', RECIPE_ID, '--inputs', '{"input":"a"}', '--json'], {
      server: server.url,
    });
    expect(result.code).toBe(4);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.error as Record<string, unknown>).code).toBe('recipe_llm_accounting_mismatch');
  });
});
