import { afterEach, describe, expect, it } from 'vitest';
import { utcNow } from '@ca/contracts';
import { RevisionConflictError, StorageError } from '../src/types';
import {
  cleanupTempStorages,
  createTempStorage,
  makeRun,
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
}> {
  const { storage, workspace } = await createTempStorage();
  const bundle = makeTaskBundle(workspace.id, { kinds: ['markdown'] });
  await storage.insertTaskBundle(bundle);
  return { storage, bundle };
}

describe('transactions', () => {
  it('returns the callback result and commits', async () => {
    const { storage, bundle } = await setup();
    const result = await storage.transaction(async () => {
      const task = await storage.bumpTaskRevision(bundle.task.id, 0);
      return task.revision;
    });
    expect(result).toBe(1);
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(1);
  });

  it('rolls back every write when the callback throws', async () => {
    const { storage, bundle } = await setup();
    await expect(
      storage.transaction(async () => {
        await storage.updateTask({ ...bundle.task, intent: 'should never persist', updatedAt: utcNow() });
        await storage.bumpTaskRevision(bundle.task.id, 0);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const task = await storage.getTask(bundle.task.id);
    expect(task!.intent).toBe(bundle.task.intent);
    expect(task!.revision).toBe(0);
  });

  it('supports nested transactions as savepoints', async () => {
    const { storage, bundle } = await setup();
    await storage.transaction(async () => {
      await storage.updateTask({ ...bundle.task, intent: 'outer-a', updatedAt: utcNow() });
      // Inner failure must only roll back the inner savepoint...
      await expect(
        storage.transaction(async () => {
          await storage.updateTask({ ...bundle.task, intent: 'inner-fails', updatedAt: utcNow() });
          throw new Error('inner boom');
        }),
      ).rejects.toThrow('inner boom');
      expect((await storage.getTask(bundle.task.id))!.intent).toBe('outer-a');
      // ...and a nested success stays part of the outer transaction.
      await storage.transaction(async () => {
        await storage.updateTask({ ...bundle.task, intent: 'inner-ok', updatedAt: utcNow() });
      });
      await storage.updateTask({ ...bundle.task, intent: 'outer-c', updatedAt: utcNow() });
    });
    expect((await storage.getTask(bundle.task.id))!.intent).toBe('outer-c');
  });

  it('rolls back nested commits when the outer transaction fails', async () => {
    const { storage, bundle } = await setup();
    await expect(
      storage.transaction(async () => {
        await storage.transaction(async () => {
          await storage.updateTask({ ...bundle.task, intent: 'nested', updatedAt: utcNow() });
        });
        throw new Error('outer boom');
      }),
    ).rejects.toThrow('outer boom');
    expect((await storage.getTask(bundle.task.id))!.intent).toBe(bundle.task.intent);
  });

  it('serializes concurrent transactions and keeps compare-and-set correct', async () => {
    const { storage, bundle } = await setup();
    const results = await Promise.allSettled([
      storage.transaction(async () => storage.bumpTaskRevision(bundle.task.id, 0)),
      storage.transaction(async () => storage.bumpTaskRevision(bundle.task.id, 0)),
      storage.transaction(async () => storage.bumpTaskRevision(bundle.task.id, 0)),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    }
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(1);
  });

  it('commits state changes and their business events atomically', async () => {
    const { storage, bundle } = await setup();
    const run = makeRun(bundle.task, bundle.modules[0]!.id);
    await storage.insertRun(run);

    await expect(
      storage.transaction(async () => {
        await storage.bumpTaskRevision(bundle.task.id, 0);
        await storage.appendEvents(bundle.task.id, [stateChangedDraft(run, 'CREATED', 'PLANNING')]);
        throw new Error('abort after both writes');
      }),
    ).rejects.toThrow('abort after both writes');
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(0);
    expect(await storage.latestSeq(bundle.task.id)).toBe(0);
    expect(await storage.eventCount(bundle.task.id)).toBe(0);

    const committed = await storage.transaction(async () => {
      const task = await storage.bumpTaskRevision(bundle.task.id, 0);
      const events = await storage.appendEvents(bundle.task.id, [stateChangedDraft(run, 'CREATED', 'PLANNING')]);
      return { task, events };
    });
    expect(committed.task.revision).toBe(1);
    expect(committed.events.map((event) => event.seq)).toEqual([1]);
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(1);
    expect(await storage.latestSeq(bundle.task.id)).toBe(1);
  });

  it('rejects use after close', async () => {
    const { storage, bundle } = await setup();
    await storage.close();
    await expect(storage.getTask(bundle.task.id)).rejects.toMatchObject({ code: 'closed' });
    await expect(storage.transaction(async () => undefined)).rejects.toMatchObject({ code: 'closed' });
    await storage.close(); // idempotent
    await expect(storage.getWorkspace()).rejects.toBeInstanceOf(StorageError);
  });
});
