import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_CATEGORY_BY_TYPE, EVENT_SCHEMA_VERSION, utcNow, type EventType, type Task } from '@ca/contracts';
import { StorageError } from '../src/types';
import {
  cleanupTempStorages,
  createTempStorage,
  makeRun,
  makeTaskBundle,
  runCreatedPayload,
  stateChangedDraft,
  usageUpdatedDraft,
  type TaskBundleFixture,
} from './fixtures';
import type { EventDraft } from '../src/types';

afterEach(async () => {
  await cleanupTempStorages();
});

async function setup(): Promise<{
  storage: Awaited<ReturnType<typeof createTempStorage>>['storage'];
  bundle: TaskBundleFixture;
  run: ReturnType<typeof makeRun>;
}> {
  const { storage, workspace } = await createTempStorage();
  const bundle = makeTaskBundle(workspace.id, { kinds: ['markdown'] });
  await storage.insertTaskBundle(bundle);
  const run = makeRun(bundle.task, bundle.modules[0]!.id);
  await storage.insertRun(run);
  return { storage, bundle, run };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('business event stream', () => {
  it('emits fully formed harness events with per-task seq starting at 1', async () => {
    const { storage, bundle, run } = await setup();
    const injectedTimestamp = '2026-01-02T03:04:05.000Z';
    const drafts: EventDraft[] = [
      runCreatedPayload(run),
      stateChangedDraft(run, 'CREATED', 'PLANNING'),
      { ...usageUpdatedDraft(run), timestamp: injectedTimestamp },
    ];
    const events = await storage.appendEvents(bundle.task.id, drafts);

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    events.forEach((event, index) => {
      expect(event.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
      expect(event.eventId).toMatch(UUID_RE);
      expect(event.taskId).toBe(bundle.task.id);
      expect(event.runId).toBe(run.id);
      expect(event.stepId).toBeNull();
      expect(event.causationId).toBeNull();
      expect(event.type).toBe(drafts[index]!.type);
      expect(event.category).toBe(EVENT_CATEGORY_BY_TYPE[drafts[index]!.type]);
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    });
    expect(events[2]!.timestamp).toBe(injectedTimestamp);
    expect(events[0]!.payload).toEqual(runCreatedPayload(run).payload);

    expect(await storage.latestSeq(bundle.task.id)).toBe(3);
    expect(await storage.eventCount(bundle.task.id)).toBe(3);
    expect(await storage.eventsAfter(bundle.task.id, 0)).toEqual(events);
    expect((await storage.eventsAfter(bundle.task.id, 1)).map((event) => event.seq)).toEqual([2, 3]);
    expect((await storage.eventsAfter(bundle.task.id, 1, 1)).map((event) => event.seq)).toEqual([2]);
    expect(await storage.eventsAfter(bundle.task.id, 99)).toEqual([]);
    // cap at LIMITS.maxEventPageSize never throws
    expect(await storage.eventsAfter(bundle.task.id, 0, 10_000)).toHaveLength(3);
  });

  it('allocates consecutive seqs for a multi-draft batch and continues across calls', async () => {
    const { storage, bundle, run } = await setup();
    const batch = Array.from({ length: 5 }, (_, index) =>
      stateChangedDraft(run, index === 0 ? 'CREATED' : 'PLANNING', index === 4 ? 'READY' : 'PLANNING'),
    );
    const first = await storage.appendEvents(bundle.task.id, batch);
    expect(first.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    const second = await storage.appendEvents(bundle.task.id, [usageUpdatedDraft(run)]);
    expect(second.map((event) => event.seq)).toEqual([6]);
  });

  it('rejects an invalid payload without persisting any part of the batch', async () => {
    const { storage, bundle, run } = await setup();
    const valid = stateChangedDraft(run, 'CREATED', 'PLANNING');
    const invalid = { ...valid, payload: { from: 'CREATED', to: 'NOT_A_STATE', reason: 'x' } } as unknown as EventDraft;
    await expect(storage.appendEvents(bundle.task.id, [valid, invalid])).rejects.toMatchObject({
      name: 'StorageError',
      code: 'schema_invalid',
    });
    expect(await storage.latestSeq(bundle.task.id)).toBe(0);
    expect(await storage.eventCount(bundle.task.id)).toBe(0);

    // The stream is still usable afterwards.
    const events = await storage.appendEvents(bundle.task.id, [valid]);
    expect(events.map((event) => event.seq)).toEqual([1]);
  });

  it('rejects unknown event types and missing tasks', async () => {
    const { storage, bundle, run } = await setup();
    const unknown = { ...stateChangedDraft(run, 'CREATED', 'PLANNING'), type: 'not.a.real_event' } as unknown as EventDraft;
    await expect(storage.appendEvents(bundle.task.id, [unknown])).rejects.toBeInstanceOf(StorageError);
    await expect(
      storage.appendEvents('00000000-0000-4000-8000-000000000005' as Task['id'], [
        stateChangedDraft(run, 'CREATED', 'PLANNING'),
      ]),
    ).rejects.toThrow(/does not exist/);
    expect(await storage.latestSeq(bundle.task.id)).toBe(0);
  });

  it('keeps seq unique and monotonic under concurrent appendEvents calls on one task', async () => {
    const { storage, bundle, run } = await setup();
    const appends = Array.from({ length: 12 }, () =>
      storage.appendEvents(bundle.task.id, [stateChangedDraft(run, 'CREATED', 'PLANNING'), usageUpdatedDraft(run)]),
    );
    const results = await Promise.all(appends);
    const seqs = results.flat().map((event) => event.seq);
    expect(seqs).toHaveLength(24);
    expect(new Set(seqs).size).toBe(24);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));

    const stored = await storage.eventsAfter(bundle.task.id, 0, 500);
    expect(stored.map((event) => event.seq)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(await storage.eventCount(bundle.task.id)).toBe(24);
  });

  it('keeps independent counters per task', async () => {
    const { storage, bundle, run } = await setup();
    const other = makeTaskBundle((await storage.getWorkspace()).id, { kinds: ['json'] });
    await storage.insertTaskBundle(other);

    await storage.appendEvents(bundle.task.id, [stateChangedDraft(run, 'CREATED', 'PLANNING')]);
    const otherEvents = await storage.appendEvents(other.task.id, [
      stateChangedDraft(run, 'CREATED', 'PLANNING'),
      usageUpdatedDraft(run),
    ]);
    expect(otherEvents.map((event) => event.seq)).toEqual([1, 2]);
    expect(await storage.latestSeq(bundle.task.id)).toBe(1);
    expect(await storage.latestSeq(other.task.id)).toBe(2);
    expect(await storage.eventCount(bundle.task.id)).toBe(1);
    expect(await storage.eventCount(other.task.id)).toBe(2);
  });

  it('maps every known event type to its category consistently', async () => {
    const { storage, bundle, run } = await setup();
    const types = Object.keys(EVENT_CATEGORY_BY_TYPE) as EventType[];
    expect(types.length).toBeGreaterThan(40);
    const events = await storage.appendEvents(bundle.task.id, [runCreatedPayload(run)]);
    expect(events[0]!.category).toBe('plan');
    expect(events[0]!.timestamp).toBe(new Date(events[0]!.timestamp).toISOString());
  });
});
