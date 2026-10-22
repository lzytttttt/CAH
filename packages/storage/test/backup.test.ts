import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSyncCtor } from '../src/sqlite-driver';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FileObjectStore } from '../src/object-store';
import { sha256Hex } from '../src/hash';
import { cleanupTempStorages, createTempStorage, makeSource, makeTaskBundle } from './fixtures';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await cleanupTempStorages();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('backupTo', () => {
  it('produces a reopenable database snapshot, copied objects and a manifest', async () => {
    const { storage, workspace } = await createTempStorage();
    const bundle = makeTaskBundle(workspace.id, { kinds: ['markdown', 'json'] });
    await storage.insertTaskBundle(bundle);
    const source = makeSource(bundle.task.id, {
      content: new TextEncoder().encode('# backup me\n\nwith unicode 中文\n'),
    });
    await storage.insertSource(source.source, source.content);
    const { stateChangedDraft } = await import('./fixtures');
    const { makeRun } = await import('./fixtures');
    const run = makeRun(bundle.task, bundle.modules[0]!.id);
    await storage.insertRun(run);
    await storage.appendEvents(bundle.task.id, [
      stateChangedDraft(run, 'CREATED', 'PLANNING'),
      stateChangedDraft(run, 'PLANNING', 'READY'),
    ]);

    const destination = await tempDir('ca-backup-');
    const manifestPath = await storage.backupTo(destination);
    expect(manifestPath).toBe(path.join(destination, 'manifest.json'));

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      kind: string;
      formatVersion: number;
      mode: string;
      schemaVersion: number;
      database: { file: string; sizeBytes: number; sha256: string };
      objects: { count: number; totalBytes: number; entries: Array<{ hash: string; sizeBytes: number; mime: string; file: string }> };
    };
    expect(manifest.kind).toBe('cognitive-atrium-backup');
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.mode).toBe('demo');
    expect(manifest.schemaVersion).toBe(1);

    const dbCopyPath = path.join(destination, manifest.database.file);
    const dbBytes = await fs.readFile(dbCopyPath);
    expect(sha256Hex(dbBytes)).toBe(manifest.database.sha256);
    expect(dbBytes.byteLength).toBe(manifest.database.sizeBytes);

    // The copied database opens independently and contains the committed state.
    const copy = new (DatabaseSyncCtor as unknown as typeof DatabaseSync)(dbCopyPath);
    try {
      const taskCount = copy.prepare('SELECT COUNT(*) AS n FROM tasks').get();
      expect(Number(taskCount?.['n'])).toBe(1);
      const eventCount = copy.prepare('SELECT COUNT(*) AS n FROM events').get();
      expect(Number(eventCount?.['n'])).toBe(2);
      const sourceRow = copy.prepare('SELECT hash FROM sources LIMIT 1').get();
      expect(String(sourceRow?.['hash'])).toBe(source.source.hash);
    } finally {
      copy.close();
    }

    // Objects referenced by the database are copied with their metadata.
    expect(manifest.objects.count).toBeGreaterThanOrEqual(1);
    const entry = manifest.objects.entries.find((candidate) => candidate.hash === source.source.hash);
    expect(entry).toBeTruthy();
    expect(entry!.sizeBytes).toBe(source.content.byteLength);
    expect(entry!.mime).toBe('text/markdown');
    const copiedStore = new FileObjectStore(path.join(destination, 'objects'));
    const object = await copiedStore.get(source.source.hash);
    expect(object).not.toBeNull();
    expect(new Uint8Array(object!.bytes)).toEqual(source.content);
    expect(object!.mime).toBe('text/markdown');
    expect(manifest.objects.totalBytes).toBeGreaterThanOrEqual(source.content.byteLength);
  });

  it('writes independent snapshots for successive backups', async () => {
    const { storage, workspace } = await createTempStorage();
    const first = makeTaskBundle(workspace.id, { kinds: ['markdown'] });
    await storage.insertTaskBundle(first);
    const firstDir = await tempDir('ca-backup-a-');
    await storage.backupTo(firstDir);

    const second = makeTaskBundle(workspace.id, { kinds: ['json'] });
    await storage.insertTaskBundle(second);
    const secondDir = await tempDir('ca-backup-b-');
    await storage.backupTo(secondDir);

    for (const [dir, expectedTasks] of [
      [firstDir, 1],
      [secondDir, 2],
    ] as const) {
      const copy = new (DatabaseSyncCtor as unknown as typeof DatabaseSync)(path.join(dir, 'cognitive-atrium.db'));
      try {
        const row = copy.prepare('SELECT COUNT(*) AS n FROM tasks').get();
        expect(Number(row?.['n'])).toBe(expectedTasks);
      } finally {
        copy.close();
      }
    }
  });
});
