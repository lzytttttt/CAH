import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  json,
  makeAcceptResponse,
  makePatchReview,
  makeRestoreResponse,
  makeSnapshot,
  makeValidationReport,
  runCommand,
  startFakeServer,
  MODULE_ID,
  PATCH_ID,
  TASK_ID,
  VALIDATION_ID,
  VERSION_ID,
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

describe('artifact review', () => {
  it('prints diff summary, validation findings and evidence (exit 0 for a passing patch)', async () => {
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/patches/${PATCH_ID}`) return json(response, 200, makePatchReview());
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const human = await runCommand(['artifact', 'review', PATCH_ID], { server: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('差异');
    expect(human.stdout).toContain('验证报告');
    expect(human.stdout).toContain('结构检查');

    const jsonResult = await runCommand(['artifact', 'review', PATCH_ID, '--json'], { server: server.url });
    const document = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    const data = document.data as Record<string, unknown>;
    expect((data.patch as Record<string, unknown>).id).toBe(PATCH_ID);
    expect((data.validation as Record<string, unknown>).status).toBe('pass');
    expect(document.exitCode).toBe(0);
  });

  it('returns exit 4 when the candidate failed validation (not acceptable)', async () => {
    const failedReport = makeValidationReport({ status: 'fail' });
    (failedReport.checks as Array<Record<string, unknown>>)[0] = {
      id: 'c2',
      layer: 'L3',
      code: 'constraint',
      title: '硬约束检查',
      status: 'fail',
      detail: '违反硬约束：必须保留原始编号',
      evidenceRefs: [],
      affectedPaths: [],
    };
    const server = await makeServer((_request, response) => json(response, 200, makePatchReview({ validation: failedReport })));
    const result = await runCommand(['artifact', 'review', PATCH_ID, '--json'], { server: server.url });
    expect(result.code).toBe(4);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(false);
    expect(document.status).toBe('failed');
    expect((document.error as Record<string, unknown>).code).toBe('validation_failed');
  });
});

describe('artifact accept', () => {
  it('binds validationReportId and the fresh task revision, then reports the new version', async () => {
    const snapshot = makeSnapshot();
    (snapshot.task as Record<string, unknown>).revision = 5;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/patches/${PATCH_ID}`) return json(response, 200, makePatchReview());
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, snapshot);
      if (request.method === 'POST' && request.path === `/api/patches/${PATCH_ID}/accept`) {
        return json(response, 200, makeAcceptResponse());
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['artifact', 'accept', PATCH_ID, '--note', '审阅通过', '--json'], { server: server.url });
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    const body = post.body as Record<string, unknown>;
    expect(body.validationReportId).toBe(VALIDATION_ID);
    expect(body.expectedRevision).toBe(5);
    expect(body.acceptMode).toBe('all');
    expect(body.sectionIds).toEqual([]);
    expect(body.note).toBe('审阅通过');
    expect(body.commandId).toMatch(UUID_RE);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).accept).toMatchObject({ versionId: VERSION_ID, runState: 'COMPLETED' });
  });

  it('rejects a patch whose base version is stale (exit 4, no POST)', async () => {
    const review = makePatchReview();
    (review.patch as Record<string, unknown>).baseVersionId = VERSION_ID;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/patches/${PATCH_ID}`) return json(response, 200, review);
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['artifact', 'accept', PATCH_ID], { server: server.url });
    expect(result.code).toBe(4);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(result.stderr).toContain('基础版本');
  });

  it('refuses to accept a patch without a validation report (exit 4)', async () => {
    const review = makePatchReview({ validation: null, validationReportId: null });
    (review.patch as Record<string, unknown>).validationReportId = null;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/patches/${PATCH_ID}`) return json(response, 200, review);
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['artifact', 'accept', PATCH_ID], { server: server.url });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('验证报告');
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('refuses an already accepted patch (exit 4)', async () => {
    const review = makePatchReview();
    (review.patch as Record<string, unknown>).status = 'accepted';
    const server = await makeServer((request, response) => {
      if (request.path === `/api/patches/${PATCH_ID}`) return json(response, 200, review);
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['artifact', 'accept', PATCH_ID], { server: server.url });
    expect(result.code).toBe(4);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('rejects unknown section ids locally when accepting sections (exit 1)', async () => {
    const server = await makeServer((request, response) => {
      if (request.path === `/api/patches/${PATCH_ID}`) return json(response, 200, makePatchReview());
      if (request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, makeSnapshot());
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['artifact', 'accept', PATCH_ID, '--mode', 'sections', '--section', 'missing-section'], {
      server: server.url,
    });
    expect(result.code).toBe(1);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(result.stderr).toContain('可用章节');
  });
});

describe('artifact restore', () => {
  it('restores a historical version through the artifact route', async () => {
    const snapshot = makeSnapshot();
    (snapshot.task as Record<string, unknown>).revision = 9;
    const server = await makeServer((request, response) => {
      if (request.method === 'GET' && request.path === `/api/tasks/${TASK_ID}/snapshot`) return json(response, 200, snapshot);
      if (request.method === 'POST' && request.path === '/api/artifacts/33333333-3333-4333-8333-333333333333/restore') {
        return json(response, 200, makeRestoreResponse());
      }
      return apiError(response, 404, 'not_found', `${request.method} ${request.path}`);
    });
    const result = await runCommand(['artifact', 'restore', TASK_ID, '--module', MODULE_ID, '--to-version', VERSION_ID, '--json'], {
      server: server.url,
    });
    expect(result.code).toBe(0);
    const post = server.requests.find((request) => request.method === 'POST')!;
    expect(post.body).toMatchObject({ moduleId: MODULE_ID, versionId: VERSION_ID, expectedRevision: 9 });
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.data as Record<string, unknown>).restore).toMatchObject({ moduleId: MODULE_ID });
  });

  it('rejects an unknown module locally (exit 1, no request)', async () => {
    const server = await makeServer((_request, response) => json(response, 200, makeSnapshot()));
    const result = await runCommand(['artifact', 'restore', TASK_ID, '--module', 'nope', '--to-version', VERSION_ID], {
      server: server.url,
    });
    expect(result.code).toBe(1);
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
  });
});
