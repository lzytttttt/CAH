import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient, loadAuth, normalizeServerUrl } from '../src/client';
import { AuthError, ConfigError, ConnectionError, ProtocolError } from '../src/exit';
import { apiError, json, makeSnapshot, startFakeServer, type FakeServer } from './helpers';

const NOOP_LOG = (): void => {};

function clientFor(server: FakeServer, overrides: { timeoutMs?: number; retryAttempts?: number } = {}): ApiClient {
  return new ApiClient({
    serverUrl: server.url,
    timeoutMs: overrides.timeoutMs ?? 2000,
    auth: { token: 'test-token', source: 'environment', tokenFile: null, notes: [] },
    log: NOOP_LOG,
    retryAttempts: overrides.retryAttempts ?? 3,
    retryBaseDelayMs: 1,
    sleep: async () => {},
  });
}

const servers: FakeServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});
async function makeServer(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

describe('auth resolution', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cli-auth-'));
    tempDirs.push(dir);
    return dir;
  };
  const globals = { serverUrl: 'http://127.0.0.1:4310', json: false, timeoutMs: 1000, tokenFile: null, color: false, help: false, version: false };

  it('reads an explicit --token-file and trims whitespace', () => {
    const dir = tempDir();
    const file = path.join(dir, 'session-token');
    fs.writeFileSync(file, '  bearer-token\n');
    const auth = loadAuth({ env: {}, cwd: dir, globals: { ...globals, tokenFile: file } });
    expect(auth.token).toBe('bearer-token');
    expect(auth.source).toBe('token-file');
  });

  it('reads a JSON token file variant', () => {
    const dir = tempDir();
    const file = path.join(dir, 'token.json');
    fs.writeFileSync(file, JSON.stringify({ token: 'json-token' }));
    const auth = loadAuth({ env: {}, cwd: dir, globals: { ...globals, tokenFile: file } });
    expect(auth.token).toBe('json-token');
  });

  it('prefers $CA_SESSION_TOKEN over the default file and reports missing files without failing', () => {
    const dir = tempDir();
    const auth = loadAuth({ env: { CA_SESSION_TOKEN: 'env-token' }, cwd: dir, globals });
    expect(auth.token).toBe('env-token');
    expect(auth.source).toBe('environment');

    const missing = loadAuth({ env: {}, cwd: dir, globals });
    expect(missing.token).toBeNull();
    expect(missing.notes.join('\n')).toContain('session-token');
  });

  it('uses $CA_DATA_DIR for the default token file path', () => {
    const dir = tempDir();
    const auth = loadAuth({ env: { CA_DATA_DIR: './mydata' }, cwd: dir, globals });
    expect(auth.tokenFile).toBe(path.join(dir, 'mydata', 'session-token'));
  });
});

describe('normalizeServerUrl', () => {
  it('normalizes valid URLs and rejects bad ones', () => {
    expect(normalizeServerUrl('http://127.0.0.1:4310/')).toBe('http://127.0.0.1:4310');
    expect(normalizeServerUrl('https://example.test/base/')).toBe('https://example.test/base');
    expect(() => normalizeServerUrl('ftp://example.test')).toThrow(ConfigError);
    expect(() => normalizeServerUrl('not a url')).toThrow(ConfigError);
    expect(() => normalizeServerUrl('http://user:pass@example.test')).toThrow(ConfigError);
  });
});

describe('ApiClient transport', () => {
  it('sends CLI headers and bearer token, and validates responses', async () => {
    const server = await makeServer((_request, response) => {
      json(response, 200, makeSnapshot());
    });
    const client = clientFor(server);
    const { TaskSnapshotSchema } = await import('@ca/contracts');
    const snapshot = await client.get(TaskSnapshotSchema as never, '/api/tasks/1/snapshot');
    expect((snapshot as unknown as { task: { title: string } }).task.title).toBe('客户反馈整理');
    expect(server.requests[0]!.headers['x-ca-client']).toBe('cli');
    expect(server.requests[0]!.headers.authorization).toBe('Bearer test-token');
    expect(server.requests[0]!.headers.accept).toBe('application/json');
  });

  it('retries safe GET requests on retryable failures, then succeeds', async () => {
    let calls = 0;
    const server = await makeServer((_request, response) => {
      calls += 1;
      if (calls === 1) apiError(response, 503, 'internal_error', 'temporary', { retryable: true });
      else json(response, 200, makeSnapshot());
    });
    const client = clientFor(server);
    const { TaskSnapshotSchema } = await import('@ca/contracts');
    await client.get(TaskSnapshotSchema as never, '/api/tasks/1/snapshot');
    expect(calls).toBe(2);
  });

  it('never retries POST commands (unsafe replay forbidden)', async () => {
    let calls = 0;
    const server = await makeServer((_request, response) => {
      calls += 1;
      response.destroy();
    });
    const client = clientFor(server);
    const { API_ROUTES, RunControlResponseSchema } = await import('@ca/contracts');
    await expect(
      client.post(RunControlResponseSchema as never, API_ROUTES.runPause('run-1'), { commandId: 'c' }),
    ).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toBe(1);
  });

  it('parses structured API errors (code/details/traceId) without reading messages', async () => {
    const server = await makeServer((_request, response) => {
      apiError(response, 409, 'revision_conflict', '任务已被修改', { retryable: false, details: { expected: 2, actual: 3 } });
    });
    const client = clientFor(server);
    const { API_ROUTES, RunControlResponseSchema } = await import('@ca/contracts');
    try {
      await client.post(RunControlResponseSchema as never, API_ROUTES.runPause('run-1'), {});
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const apiErrorInstance = error as { apiCode?: string; status?: number; traceId?: string; exitCode?: number; info: { retryable?: boolean } };
      expect(apiErrorInstance.apiCode).toBe('revision_conflict');
      expect(apiErrorInstance.status).toBe(409);
      expect(apiErrorInstance.traceId).toBe('trace-test');
      expect(apiErrorInstance.exitCode).toBe(4);
    }
  });

  it('maps 401 to an auth error with an actionable hint', async () => {
    const server = await makeServer((_request, response) => {
      apiError(response, 401, 'session_required', 'session token required');
    });
    const client = clientFor(server);
    const { TaskSnapshotSchema } = await import('@ca/contracts');
    try {
      await client.get(TaskSnapshotSchema as never, '/api/tasks/1/snapshot');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).info.hint).toContain('token-file');
    }
  });

  it('maps timeouts to a connection error', async () => {
    const server = await makeServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      json(response, 200, makeSnapshot());
    });
    const client = clientFor(server, { timeoutMs: 20, retryAttempts: 1 });
    const { TaskSnapshotSchema } = await import('@ca/contracts');
    try {
      await client.get(TaskSnapshotSchema as never, '/api/tasks/1/snapshot');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as ConnectionError).info.code).toBe('timeout');
    }
  });

  it('rejects responses that do not match the frozen contract', async () => {
    const server = await makeServer((_request, response) => {
      json(response, 200, { unexpected: true });
    });
    const client = clientFor(server);
    const { TaskSnapshotSchema } = await import('@ca/contracts');
    await expect(client.get(TaskSnapshotSchema as never, '/api/tasks/1/snapshot')).rejects.toBeInstanceOf(ProtocolError);
  });
});
