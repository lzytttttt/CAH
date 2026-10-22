import { afterEach, describe, expect, it } from 'vitest';
import { newCommandId, utcNow } from '@ca/contracts';
import { StateNotAllowedError } from '../src/types';
import {
  cleanupTempStorages,
  createTempStorage,
  makeRun,
  makeSource,
  makeTaskBundle,
  stateChangedDraft,
  type TaskBundleFixture,
} from './fixtures';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('command idempotency', () => {
  it('stores the first response for a commandId and replays it', async () => {
    const { storage, bundle } = await setup();
    const commandId = newCommandId();
    expect(await storage.getCommandResult(commandId)).toBeNull();

    const first = { ok: true, taskId: bundle.task.id, revision: 0 };
    await storage.saveCommandResult(commandId, 'task.create', bundle.task.id, first);
    expect(await storage.getCommandResult(commandId)).toEqual(first);

    // A replay with a different body must not overwrite the committed response.
    await storage.saveCommandResult(commandId, 'task.create', bundle.task.id, { ok: false });
    expect(await storage.getCommandResult(commandId)).toEqual(first);
  });

  it('keeps taskId null for commands that are not task scoped and rejects unserializable responses', async () => {
    const { storage } = await setup();
    const commandId = newCommandId();
    await storage.saveCommandResult(commandId, 'workspace.settings', null, { ok: true });
    expect(await storage.getCommandResult(commandId)).toEqual({ ok: true });

    const badId = newCommandId();
    await expect(
      storage.saveCommandResult(badId, 'bad', null, { nested: BigInt(1) } as unknown as Record<string, unknown>),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await storage.getCommandResult(badId)).toBeNull();
  });
});

describe('run leases with fencing tokens', () => {
  it('grants one owner at a time and fences ownership changes', async () => {
    const { storage, run } = await setup();
    expect(await storage.listLeaseOwner(run.id)).toBeNull();

    expect(await storage.acquireRunLease(run.id, 'owner-a', 60_000)).toBe(true);
    expect(await storage.listLeaseOwner(run.id)).toBe('owner-a');
    expect(storage.fencingToken(run.id)).toBe(1);

    // A second owner cannot take a live lease.
    expect(await storage.acquireRunLease(run.id, 'owner-b', 60_000)).toBe(false);
    // The holder may re-acquire (extend) without changing the fence.
    expect(await storage.acquireRunLease(run.id, 'owner-a', 60_000)).toBe(true);
    expect(storage.fencingToken(run.id)).toBe(1);

    expect(await storage.renewRunLease(run.id, 'owner-a', 60_000)).toBe(true);
    expect(await storage.renewRunLease(run.id, 'owner-b', 60_000)).toBe(false);

    // Releasing with the wrong owner is a no-op.
    await storage.releaseRunLease(run.id, 'owner-b');
    expect(await storage.listLeaseOwner(run.id)).toBe('owner-a');
    await storage.releaseRunLease(run.id, 'owner-a');
    expect(await storage.listLeaseOwner(run.id)).toBeNull();
    expect(await storage.renewRunLease(run.id, 'owner-a', 60_000)).toBe(false);

    // The fencing token is monotonic across release/re-acquire, so an executor
    // that only knows the old token can never look current again.
    expect(await storage.acquireRunLease(run.id, 'owner-c', 60_000)).toBe(true);
    expect(storage.fencingToken(run.id)).toBe(2);
    expect(await storage.listLeaseOwner(run.id)).toBe('owner-c');
  });

  it('expires stale leases, allows takeover and increments the fencing token', async () => {
    const { storage, run } = await setup();
    expect(await storage.acquireRunLease(run.id, 'crashed-executor', 5)).toBe(true);
    await sleep(25);
    expect(await storage.listLeaseOwner(run.id)).toBeNull();
    expect(await storage.renewRunLease(run.id, 'crashed-executor', 60_000)).toBe(false);

    expect(await storage.acquireRunLease(run.id, 'recovering-executor', 60_000)).toBe(true);
    expect(await storage.listLeaseOwner(run.id)).toBe('recovering-executor');
    expect(storage.fencingToken(run.id)).toBe(2);
    const lease = storage.leaseRecord(run.id);
    expect(lease?.owner).toBe('recovering-executor');
    expect(lease!.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('demo reset and physical isolation', () => {
  it('resetDemoData clears the demo database and objects in one safe reset', async () => {
    const { storage, bundle } = await setup();
    const source = makeSource(bundle.task.id);
    await storage.insertSource(source.source, source.content);
    await storage.appendEvents(bundle.task.id, [stateChangedDraft(makeRun(bundle.task, bundle.modules[0]!.id), 'CREATED', 'PLANNING')]);
    expect(await storage.listTasks()).toHaveLength(1);
    expect((await storage.objects.listObjects()).length).toBeGreaterThan(0);

    const workspaceBefore = await storage.getWorkspace();
    await storage.resetDemoData();

    expect(await storage.listTasks()).toEqual([]);
    expect(await storage.listSources(bundle.task.id)).toEqual([]);
    expect(await storage.latestSeq(bundle.task.id)).toBe(0);
    expect(await storage.objects.listObjects()).toEqual([]);
    const workspaceAfter = await storage.getWorkspace();
    expect(workspaceAfter.mode).toBe('demo');
    // Workspace identity survives a demo reset so open sessions/seeds stay valid.
    expect(workspaceAfter.id).toBe(workspaceBefore.id);
    expect(workspaceAfter.settings).toEqual(workspaceBefore.settings);
    expect(storage.schemaVersion()).toBe(1);

    // Storage is fully usable after a reset.
    const fresh = makeTaskBundle(workspaceAfter.id, { kinds: ['json'] });
    await storage.insertTaskBundle(fresh);
    expect(await storage.listTasks()).toHaveLength(1);
    const object = await storage.objects.put(new TextEncoder().encode('after reset'), 'text/plain');
    expect(await storage.objects.has(object.hash)).toBe(true);
  });

  it('refuses to reset live data', async () => {
    const { storage } = await createTempStorage({ mode: 'live' });
    await expect(storage.resetDemoData()).rejects.toBeInstanceOf(StateNotAllowedError);
  });

  it('keeps demo and live databases independent even from the same dataDir', async () => {
    const demo = await createTempStorage({ mode: 'demo' });
    const live = await createTempStorage({ mode: 'live' });
    // The fixture helper creates separate dataDirs; force both modes under one
    // directory to prove isolation.
    const sharedDir = demo.dataDir;
    const { openStorageWithDiagnostics } = await import('../src/storage');
    const demoShared = openStorageWithDiagnostics({ dataDir: sharedDir, mode: 'demo', workspaceName: 'demo' });
    const liveShared = openStorageWithDiagnostics({ dataDir: sharedDir, mode: 'live', workspaceName: 'live' });
    try {
      const demoBundle = makeTaskBundle((await demoShared.getWorkspace()).id, { kinds: ['markdown'] });
      await demoShared.insertTaskBundle(demoBundle);
      expect(await demoShared.listTasks()).toHaveLength(1);
      expect(await liveShared.listTasks()).toHaveLength(0);
      expect(demoShared.dbPath).not.toBe(liveShared.dbPath);
      expect(demoShared.objects.root).not.toBe(liveShared.objects.root);
    } finally {
      await demoShared.close();
      await liveShared.close();
    }
    void live;
    void utcNow;
  });
});
