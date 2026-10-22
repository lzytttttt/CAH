import { afterEach, describe, expect, it } from 'vitest';
import {
  json,
  makeSnapshot,
  runCommand,
  runCompletedEvent,
  sseEvent,
  sseStart,
  startFakeServer,
  stateChangedEvent,
  stepStartedEvent,
  TASK_ID,
  RUN_ID,
  type FakeServer,
} from './helpers';

const servers: FakeServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});
async function makeServer(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

describe('events tail', () => {
  it('ignores duplicate seq and emits exactly one JSON document for --json --limit', async () => {
    const server = await makeServer((request, response) => {
      if (request.path !== `/api/tasks/${TASK_ID}/events`) return json(response, 404, {});
      sseStart(response);
      sseEvent(response, { id: 1, type: 'run.state_changed', data: stateChangedEvent(1, 'RUNNING', 'VALIDATING') });
      sseEvent(response, { id: 1, type: 'run.state_changed', data: stateChangedEvent(1, 'RUNNING', 'VALIDATING') });
      sseEvent(response, { id: 2, type: 'step.started', data: stepStartedEvent(2) });
      response.end();
    });
    const result = await runCommand(['events', 'tail', TASK_ID, '--limit', '2', '--no-reconnect', '--json'], {
      server: server.url,
    });
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document.ok).toBe(true);
    const data = document.data as Record<string, unknown>;
    const events = data.events as Array<Record<string, unknown>>;
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(data.duplicatesIgnored).toBe(1);
    expect(data.stoppedReason).toBe('limit');
    expect(data.lastSeq).toBe(2);
  });

  it('reconnects with Last-Event-ID and afterSeq after the stream closes', async () => {
    const connections: Array<Record<string, unknown>> = [];
    const server = await makeServer((request, response) => {
      connections.push({
        lastEventId: request.headers['last-event-id'],
        afterSeq: request.query.get('afterSeq'),
      });
      sseStart(response);
      if (connections.length === 1) {
        sseEvent(response, { id: 1, type: 'run.state_changed', data: stateChangedEvent(1, 'CREATED', 'PLANNING') });
        sseEvent(response, { id: 2, type: 'step.started', data: stepStartedEvent(2) });
        response.end();
        return;
      }
      sseEvent(response, { id: 3, type: 'run.state_changed', data: stateChangedEvent(3, 'RUNNING', 'VALIDATING') });
      response.end();
    });
    const result = await runCommand(['events', 'tail', TASK_ID, '--limit', '3', '--json'], { server: server.url });
    expect(result.code).toBe(0);
    expect(connections.length).toBe(2);
    expect(connections[0]).toMatchObject({ afterSeq: '0' });
    expect(connections[1]).toMatchObject({ lastEventId: '2', afterSeq: '2' });
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    const events = (document.data as Record<string, unknown>).events as Array<Record<string, unknown>>;
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((document.data as Record<string, unknown>).reconnects).toBe(1);
  });

  it('fills a seq gap from the task snapshot instead of silently skipping it', async () => {
    const server = await makeServer((request, response) => {
      if (request.path === `/api/tasks/${TASK_ID}/snapshot`) {
        return json(response, 200, makeSnapshot({ events: [stateChangedEvent(2, 'PLANNING', 'READY')], snapshotSeq: 2 }));
      }
      if (request.path === `/api/tasks/${TASK_ID}/events`) {
        sseStart(response);
        sseEvent(response, { id: 1, type: 'run.state_changed', data: stateChangedEvent(1, 'CREATED', 'PLANNING') });
        sseEvent(response, { id: 3, type: 'run.state_changed', data: stateChangedEvent(3, 'READY', 'RUNNING') });
        response.end();
        return;
      }
      json(response, 404, {});
    });
    const result = await runCommand(['events', 'tail', TASK_ID, '--limit', '3', '--no-reconnect', '--json'], {
      server: server.url,
    });
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = document.data as Record<string, unknown>;
    const events = data.events as Array<Record<string, unknown>>;
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(data.gapsFilled).toBe(1);
    const snapshotRequest = server.requests.find((request) => request.path === `/api/tasks/${TASK_ID}/snapshot`);
    expect(snapshotRequest?.query.get('afterSeq')).toBe('1');
  });

  it('streams human-readable event lines by default', async () => {
    const server = await makeServer((_request, response) => {
      sseStart(response);
      sseEvent(response, { id: 1, type: 'run.state_changed', data: stateChangedEvent(1, 'CREATED', 'PLANNING') });
      response.end();
    });
    const result = await runCommand(['events', 'tail', TASK_ID, '--limit', '1', '--no-reconnect'], { server: server.url });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('#1');
    expect(result.stdout).toContain('run.state_changed');
    expect(result.stdout).toContain('CREATED → PLANNING');
  });

  it('filters by event type while still tracking seq', async () => {
    const server = await makeServer((_request, response) => {
      sseStart(response);
      sseEvent(response, { id: 1, type: 'step.started', data: stepStartedEvent(1) });
      sseEvent(response, { id: 2, type: 'run.state_changed', data: stateChangedEvent(2, 'RUNNING', 'VALIDATING') });
      response.end();
    });
    const result = await runCommand(
      ['events', 'tail', TASK_ID, '--type', 'run.state_changed', '--limit', '1', '--no-reconnect', '--json'],
      { server: server.url },
    );
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    const events = (document.data as Record<string, unknown>).events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBe(2);
  });

  it('stops on a terminal event for the watched run when asked', async () => {
    const server = await makeServer((_request, response) => {
      sseStart(response);
      sseEvent(response, { id: 1, type: 'step.started', data: stepStartedEvent(1) });
      sseEvent(response, { id: 2, type: 'run.completed', data: runCompletedEvent(2) });
      sseEvent(response, { id: 3, type: 'step.started', data: stepStartedEvent(3) });
      response.end();
    });
    const result = await runCommand(
      ['events', 'tail', TASK_ID, '--run', RUN_ID, '--stop-on-terminal', '--no-reconnect', '--json'],
      { server: server.url, timeoutMs: 3000 },
    );
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = document.data as Record<string, unknown>;
    expect(data.stoppedReason).toBe('terminal');
    expect((data.events as unknown[]).length).toBe(2);
  });

  it('streams one JSON object per line with --jsonl', async () => {
    const server = await makeServer((_request, response) => {
      sseStart(response);
      sseEvent(response, { id: 1, type: 'run.state_changed', data: stateChangedEvent(1, 'CREATED', 'PLANNING') });
      sseEvent(response, { id: 2, type: 'run.state_changed', data: stateChangedEvent(2, 'PLANNING', 'READY') });
      response.end();
    });
    const result = await runCommand(['events', 'tail', TASK_ID, '--limit', '2', '--no-reconnect', '--jsonl'], {
      server: server.url,
    });
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).seq).toBe(1);
    expect((JSON.parse(lines[1]!) as Record<string, unknown>).seq).toBe(2);
  });

  it('fails as a protocol error when an SSE event is not contract-valid (exit 5)', async () => {
    const server = await makeServer((_request, response) => {
      sseStart(response);
      sseEvent(response, { id: 1, type: 'run.state_changed', data: { not: 'an event' } });
      response.end();
    });
    const result = await runCommand(['events', 'tail', TASK_ID, '--limit', '1', '--no-reconnect', '--json'], {
      server: server.url,
    });
    expect(result.code).toBe(5);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((document.error as Record<string, unknown>).code).toBe('protocol_error');
  });
});
