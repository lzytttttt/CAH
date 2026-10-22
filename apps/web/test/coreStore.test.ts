import { describe, expect, it } from 'vitest';
import { TaskSnapshotSchema } from '@ca/contracts';
import { createFixtureClient } from '../src/api/fixture/client';
import { buildFixtureBundle, IDS } from '../src/api/fixture/data';
import { ClientFailure } from '../src/api/types';
import type { ApiClient, EventSubscription, SubscribeEventsOptions } from '../src/api/types';
import { createCore } from '../src/state/coreStore';

const fixtureClient = createFixtureClient({ scenario: 'review' });

async function fixtureParts() {
  const session = await fixtureClient.getSession();
  const workspace = await fixtureClient.getWorkspace();
  const tasks = await fixtureClient.listTasks();
  const snapshot = TaskSnapshotSchema.parse(buildFixtureBundle('review').snapshot);
  return { session, workspace, tasks, snapshot };
}

function makeFakeClient(overrides: {
  snapshotProvider: () => ReturnType<typeof TaskSnapshotSchema.parse>;
  onSubscribe?: (options: SubscribeEventsOptions) => void;
}) {
  const partsPromise = fixtureParts();
  let subscribeOptions: SubscribeEventsOptions | null = null;
  const client = {
    kind: 'http' as const,
    baseUrl: '',
    getSession: async () => (await partsPromise).session,
    getWorkspace: async () => (await partsPromise).workspace,
    listTasks: async () => (await partsPromise).tasks,
    getSnapshot: async () => overrides.snapshotProvider(),
    subscribeEvents: (_taskId: string, options: SubscribeEventsOptions): EventSubscription => {
      subscribeOptions = options;
      overrides.onSubscribe?.(options);
      options.onOpen?.();
      return { close: () => options.onStateChange?.('closed'), isOpen: () => true };
    },
  } as unknown as ApiClient;
  return { client, getSubscribeOptions: () => subscribeOptions };
}

function cloneSnapshotWithSeq(seq: number) {
  const snapshot = TaskSnapshotSchema.parse(buildFixtureBundle('review').snapshot);
  snapshot.snapshotSeq = seq;
  snapshot.serverTime = new Date(Date.parse(snapshot.serverTime) + seq * 1000).toISOString();
  return snapshot;
}

function streamEventAfter(snapshot: ReturnType<typeof cloneSnapshotWithSeq>, seq: number) {
  const base = snapshot.events[snapshot.events.length - 1] as unknown as Record<string, unknown>;
  return {
    ...base,
    eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
  } as never;
}

describe('WorkbenchCore — business state only comes from the server', () => {
  it('boots, opens a task from the snapshot and connects the stream', async () => {
    const { client } = makeFakeClient({ snapshotProvider: () => cloneSnapshotWithSeq(10) });
    const core = createCore(client, { pollIntervalMs: 100_000, resyncDebounceMs: 5 });
    await core.boot();
    expect(core.getState().boot).toBe('ready');
    expect(core.getState().session?.authenticated).toBe(true);
    await core.openTask(IDS.task);
    const state = core.getState();
    expect(state.taskId).toBe(IDS.task);
    expect(state.snapshot?.snapshotSeq).toBe(10);
    expect(state.connection.phase).toBe('connected');
    expect(state.lastSeq).toBeGreaterThan(0);
    expect(state.events.length).toBeGreaterThan(0);
    core.dispose();
  });

  it('deduplicates stream events by seq and refreshes the snapshot afterwards', async () => {
    let seq = 10;
    const { client, getSubscribeOptions } = makeFakeClient({ snapshotProvider: () => cloneSnapshotWithSeq(seq) });
    const core = createCore(client, { pollIntervalMs: 100_000, resyncDebounceMs: 5 });
    await core.boot();
    await core.openTask(IDS.task);
    const options = getSubscribeOptions()!;
    const before = core.getState();
    const event = streamEventAfter(before.snapshot!, before.lastSeq + 1);
    options.onEvent(event);
    const once = core.getState();
    expect(once.lastSeq).toBe(before.lastSeq + 1);
    options.onEvent(event);
    expect(core.getState().lastSeq).toBe(once.lastSeq);
    // The scheduled snapshot refresh keeps business fields authoritative.
    seq = 11;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(core.getState().snapshot?.snapshotSeq).toBe(11);
    core.dispose();
  });

  it('refetches the snapshot on a seq gap and keeps the newest snapshot', async () => {
    let seq = 10;
    const { client, getSubscribeOptions } = makeFakeClient({ snapshotProvider: () => cloneSnapshotWithSeq(seq) });
    const core = createCore(client, { pollIntervalMs: 100_000, resyncDebounceMs: 1 });
    await core.boot();
    await core.openTask(IDS.task);
    getSubscribeOptions()!.onGap?.(12, 14);
    expect(core.getState().resyncReason).toContain('缺口');
    expect(core.getState().notices.some((notice) => notice.title.includes('缺口'))).toBe(true);
    seq = 20;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(core.getState().snapshot?.snapshotSeq).toBe(20);
    core.dispose();
  });

  it('never lets an older snapshot override a newer snapshot', async () => {
    let seq = 30;
    const { client } = makeFakeClient({ snapshotProvider: () => cloneSnapshotWithSeq(seq) });
    const core = createCore(client, { pollIntervalMs: 100_000, resyncDebounceMs: 1 });
    await core.boot();
    await core.openTask(IDS.task);
    seq = 12;
    await core.refreshSnapshot({ quiet: true });
    expect(core.getState().snapshot?.snapshotSeq).toBe(30);
    expect(core.getState().staleRejected).toBe(true);
    core.dispose();
  });

  it('surfaces command failures as notices and resyncs on revision conflicts', async () => {
    const { client } = makeFakeClient({ snapshotProvider: () => cloneSnapshotWithSeq(40) });
    const core = createCore(client, { pollIntervalMs: 100_000, resyncDebounceMs: 1 });
    await core.boot();
    await core.openTask(IDS.task);
    const result = await core.runCommand('接受变更', async () => {
      throw new ClientFailure({ kind: 'http', code: 'revision_conflict', message: '冲突', retryable: false, traceId: 'trace-1', status: 409 });
    });
    expect(result).toBeNull();
    const state = core.getState();
    expect(state.lastError?.code).toBe('revision_conflict');
    expect(state.notices.some((notice) => notice.title === '已自动重新同步')).toBe(true);
    core.dispose();
  });

  it('serialises overlapping commands (no double-submit from the UI)', async () => {
    const { client } = makeFakeClient({ snapshotProvider: () => cloneSnapshotWithSeq(50) });
    const core = createCore(client, { pollIntervalMs: 100_000, resyncDebounceMs: 1 });
    await core.boot();
    await core.openTask(IDS.task);
    let resolveFirst: (value: string) => void = () => undefined;
    const first = core.runCommand('第一个命令', () => new Promise<string>((resolve) => { resolveFirst = resolve; }));
    const second = core.runCommand('第二个命令', async () => 'second');
    await expect(second).resolves.toBeNull();
    resolveFirst('first');
    await expect(first).resolves.toBe('first');
    core.dispose();
  });
});

describe('WorkbenchCore polling fallback', () => {
  it('switches to interval polling when the stream is offline and stops on dispose', async () => {
    let snapshotCalls = 0;
    const { client, getSubscribeOptions } = makeFakeClient({
      snapshotProvider: () => {
        snapshotCalls += 1;
        return cloneSnapshotWithSeq(60);
      },
    });
    const core = createCore(client, { pollIntervalMs: 200, resyncDebounceMs: 1 });
    await core.boot();
    await core.openTask(IDS.task);
    const afterOpen = snapshotCalls;
    getSubscribeOptions()!.onError?.(new ClientFailure({ kind: 'network', code: 'network_error', message: '断线', retryable: true, traceId: 't' }));
    expect(core.getState().connection.phase).toBe('reconnecting');
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(snapshotCalls).toBeGreaterThan(afterOpen);
    core.dispose();
    const afterDispose = snapshotCalls;
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(snapshotCalls).toBe(afterDispose);
  });
});
