import { describe, expect, it } from 'vitest';
import {
  CreateTaskResponseSchema,
  TaskSnapshotSchema,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type SessionInfo,
} from '@ca/contracts';
import { buildFixtureBundle, IDS } from '../src/api/fixture/data';
import { createFixtureClient } from '../src/api/fixture/client';
import { createHttpClient } from '../src/api/http';
import { ClientFailure, isClientFailure } from '../src/api/types';
import { commandEnvelope } from '../src/lib/ids';

const fixtureSnapshot = TaskSnapshotSchema.parse(buildFixtureBundle('review').snapshot);

async function fixtureSession(): Promise<SessionInfo> {
  return createFixtureClient({ scenario: 'review' }).getSession();
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFakeFetch(handler: (call: RecordedCall, attempt: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  let count = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    count += 1;
    const headerRecord: Record<string, string> = {};
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    const call: RecordedCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: headerRecord,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call, count);
  };
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('HttpApiClient — command envelopes, auth headers and snapshot resume', () => {
  it('bootstraps the session, sends csrf token + commandId/expectedRevision on writes', async () => {
    const session = await fixtureSession();
    const response: CreateTaskResponse = CreateTaskResponseSchema.parse({
      commandId: '00000000-0000-4000-8000-0000000000aa',
      duplicate: false,
      taskId: IDS.task,
      artifactId: IDS.artifact,
      revision: 0,
      moduleIds: [IDS.modules.arch],
    });
    const { calls, fetchImpl } = makeFakeFetch((call) => {
      if (call.url.endsWith('/api/session')) return jsonResponse(session);
      if (call.url.endsWith('/api/tasks')) return jsonResponse(response);
      return jsonResponse({ code: 'not_found', message: 'x', retryable: false, traceId: 't' }, 404);
    });
    const client = createHttpClient({ fetchImpl });
    const request: CreateTaskRequest = {
      ...commandEnvelope(),
      title: '任务',
      intent: '意图内容',
      artifactTitle: '交付物',
      constraints: [],
      templateId: 'cognitive-atrium',
      modules: [],
    };
    const created = await client.createTask(request);
    expect(created.taskId).toBe(IDS.task);
    expect(calls[0]!.url).toBe('/api/session');
    const write = calls[1]!;
    expect(write.method).toBe('POST');
    expect(write.url).toBe('/api/tasks');
    expect(write.headers['x-csrf-token']).toBe(session.csrfToken);
    expect(write.headers['x-ca-client']).toBe('web');
    expect(write.body).toMatchObject({ commandId: request.commandId, title: '任务', templateId: 'cognitive-atrium' });
    expect(client.kind).toBe('http');
  });

  it('requests the snapshot with afterSeq/includeEvents resume query parameters', async () => {
    const { calls, fetchImpl } = makeFakeFetch(() => jsonResponse(fixtureSnapshot));
    const client = createHttpClient({ fetchImpl });
    const snapshot = await client.getSnapshot(IDS.task, { afterSeq: 5, includeEvents: true });
    expect(snapshot.snapshotSeq).toBe(fixtureSnapshot.snapshotSeq);
    expect(calls[0]!.url).toBe(`/api/tasks/${IDS.task}/snapshot?afterSeq=5&includeEvents=true`);
  });

  it('joins an explicit base URL and keeps commands typed per route', async () => {
    const session = await fixtureSession();
    const { calls, fetchImpl } = makeFakeFetch((call) => {
      if (call.url.endsWith('/api/session')) return jsonResponse(session);
      return jsonResponse({ code: 'state_not_allowed', message: '暂停不被允许', retryable: false, traceId: 'trace-1' }, 409);
    });
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:4310', fetchImpl });
    const error = await client
      .pauseRun(IDS.runs.plan, { ...commandEnvelope(fixtureSnapshot.task.revision), expectedRevision: fixtureSnapshot.task.revision, reason: '' })
      .catch((caught: unknown) => caught);
    expect(isClientFailure(error)).toBe(true);
    expect((error as ClientFailure).code).toBe('state_not_allowed');
    expect(calls[1]!.url).toBe(`http://127.0.0.1:4310/api/runs/${IDS.runs.plan}/pause`);
    expect(calls[1]!.body).toMatchObject({ expectedRevision: fixtureSnapshot.task.revision });
  });
});

describe('HttpApiClient — error mapping is contract-driven', () => {
  it('maps HTTP API errors from code/retryable/traceId (never from Chinese message text)', async () => {
    const { fetchImpl } = makeFakeFetch(() =>
      jsonResponse({ code: 'revision_conflict', message: '任务已被更新', retryable: false, traceId: 'trace-9' }, 409),
    );
    const client = createHttpClient({ fetchImpl });
    const error = (await client.getSnapshot(IDS.task).catch((caught: unknown) => caught)) as ClientFailure;
    expect(error).toBeInstanceOf(ClientFailure);
    expect(error.kind).toBe('http');
    expect(error.code).toBe('revision_conflict');
    expect(error.status).toBe(409);
    expect(error.traceId).toBe('trace-9');
  });

  it('maps transport failures to network_error (retryable)', async () => {
    const { fetchImpl } = makeFakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = createHttpClient({ fetchImpl });
    const error = (await client.getSnapshot(IDS.task).catch((caught: unknown) => caught)) as ClientFailure;
    expect(error.kind).toBe('network');
    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
  });

  it('rejects schema-invalid responses as invalid_response instead of trusting them', async () => {
    const { fetchImpl } = makeFakeFetch(() => jsonResponse({ snapshotSeq: 'not-a-number' }));
    const client = createHttpClient({ fetchImpl });
    const error = (await client.getSnapshot(IDS.task).catch((caught: unknown) => caught)) as ClientFailure;
    expect(error.kind).toBe('invalid_response');
    expect(error.code).toBe('invalid_response');
  });

  it('re-bootstraps the session once when a write gets session_required', async () => {
    const session = await fixtureSession();
    const response: CreateTaskResponse = CreateTaskResponseSchema.parse({
      commandId: '00000000-0000-4000-8000-0000000000ab',
      duplicate: false,
      taskId: IDS.task,
      artifactId: IDS.artifact,
      revision: 0,
      moduleIds: [IDS.modules.arch],
    });
    const { calls, fetchImpl } = makeFakeFetch((call) => {
      if (call.url.endsWith('/api/session')) return jsonResponse(session);
      // First write fails with an expired session, the retry succeeds.
      if (calls.filter((entry) => entry.method === 'POST').length === 1) {
        return jsonResponse({ code: 'session_required', message: '会话过期', retryable: false, traceId: 'trace-s' }, 401);
      }
      return jsonResponse(response);
    });
    const client = createHttpClient({ fetchImpl });
    const created = await client.createTask({
      ...commandEnvelope(),
      title: '任务',
      intent: '意图内容',
      artifactTitle: '交付物',
      constraints: [],
      templateId: null,
      modules: [],
    });
    expect(created.taskId).toBe(IDS.task);
    expect(calls.filter((entry) => entry.url.endsWith('/api/session')).length).toBe(2);
    expect(calls.filter((entry) => entry.method === 'POST')).toHaveLength(2);
  });
});
