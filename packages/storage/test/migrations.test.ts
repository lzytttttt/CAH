import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/migrate';
import { openStorageWithDiagnostics } from '../src/storage';
import { cleanupTempStorages, createTempStorage, defaultWorkspaceSettings } from './fixtures';

afterEach(async () => {
  await cleanupTempStorages();
});

describe('migrations + storage layout', () => {
  it('creates the per-mode database and object directory with WAL enabled', async () => {
    const { storage, dataDir } = await createTempStorage();
    const modeDir = path.join(dataDir, 'demo');
    expect(storage.dbPath).toBe(path.join(modeDir, 'cognitive-atrium.db'));
    expect(existsSync(storage.dbPath)).toBe(true);
    expect(existsSync(path.join(modeDir, 'objects'))).toBe(true);
    expect(storage.diagnostics().mode).toBe('demo');
    expect(storage.schemaVersion()).toBe(SCHEMA_VERSION);

    const journal = storage.rawQuery('PRAGMA journal_mode');
    expect(String(journal[0]?.['journal_mode'])).toBe('wal');
    const foreignKeys = storage.rawQuery('PRAGMA foreign_keys');
    expect(Number(foreignKeys[0]?.['foreign_keys'])).toBe(1);

    const tables = storage
      .rawQuery("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => String(row['name']));    for (const expected of [
      'artifact_modules',
      'artifact_versions',
      'artifacts',
      'blockers',
      'command_results',
      'context_snapshots',
      'decisions',
      'events',
      'patches',
      'provider_profiles',
      'recipes',
      'run_checkpoints',
      'run_leases',
      'runs',
      'schema_migrations',
      'source_spans',
      'sources',
      'steps',
      'tasks',
      'tool_invocations',
      'validation_reports',
      'workspace',
    ]) {
      expect(tables).toContain(expected);
    }

    // Artifact versions are protected at the database level, not only in code.
    const triggers = storage
      .rawQuery("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .map((row) => String(row['name']));
    expect(triggers).toContain('trg_artifact_versions_no_update');
    expect(triggers).toContain('trg_artifact_versions_no_delete');

    // Objects live under <modeDir>/objects/<hash[0..2]>/<hash>.
    const hash = 'c'.repeat(64);
    expect(storage.objects.root).toBe(path.join(modeDir, 'objects'));
    expect(storage.objects.pathFor(hash)).toBe(path.join(modeDir, 'objects', hash.slice(0, 2), hash));
  });

  it('is idempotent: reopening the same directory keeps one migration row and the same workspace', async () => {
    const first = await createTempStorage();
    const workspaceId = first.workspace.id;
    await first.storage.close();

    const second = openStorageWithDiagnostics({
      dataDir: first.dataDir,
      mode: 'demo',
      workspaceName: 'Renamed but should not replace existing workspace',
    });
    try {
      const workspace = await second.getWorkspace();
      expect(workspace.id).toBe(workspaceId);
      expect(workspace.name).toBe('Storage Test Workspace');
      expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
      const migrations = second.rawQuery('SELECT version FROM schema_migrations');
      expect(migrations).toHaveLength(1);
      expect(Number(migrations[0]?.['version'])).toBe(1);
    } finally {
      await second.close();
    }
  });

  it('ensureWorkspace is idempotent and leaves the existing workspace untouched', async () => {
    const { storage, workspace } = await createTempStorage();
    const ensured = await storage.ensureWorkspace({
      name: 'Another name',
      settings: { ...defaultWorkspaceSettings, autoAcceptVerifiedDrafts: true },
    });
    expect(ensured.id).toBe(workspace.id);
    expect(ensured.name).toBe(workspace.name);
    expect(ensured.settings.autoAcceptVerifiedDrafts).toBe(false);
  });

  it('persists data across a close/reopen cycle (crash-safe durable writes)', async () => {
    const first = await createTempStorage();
    const { task, artifact, modules } = (await import('./fixtures')).makeTaskBundle(first.workspace.id);
    await first.storage.insertTaskBundle({ task, artifact, modules });
    await first.storage.close();

    const reopened = openStorageWithDiagnostics({
      dataDir: first.dataDir,
      mode: 'demo',
      workspaceName: 'x',
    });
    try {
      const aggregate = await reopened.getTaskAggregate(task.id);
      expect(aggregate?.task.intent).toBe(task.intent);
      expect(aggregate?.artifact.id).toBe(artifact.id);
      expect(aggregate?.modules.map((module) => module.id)).toEqual(modules.map((module) => module.id));
    } finally {
      await reopened.close();
    }
  });

  it('keeps demo and live data in physically separate files and directories', async () => {
    const { dataDir } = await createTempStorage();
    const demo = openStorageWithDiagnostics({ dataDir, mode: 'demo', workspaceName: 'demo' });
    const live = openStorageWithDiagnostics({ dataDir, mode: 'live', workspaceName: 'live' });
    try {
      expect(demo.dbPath).not.toBe(live.dbPath);
      expect(demo.dbPath).toContain(path.join('demo', 'cognitive-atrium.db'));
      expect(live.dbPath).toContain(path.join('live', 'cognitive-atrium.db'));
      expect(demo.objects.root).not.toBe(live.objects.root);
      expect(existsSync(demo.dbPath)).toBe(true);
      expect(existsSync(live.dbPath)).toBe(true);

      const { makeTaskBundle } = await import('./fixtures');
      const bundle = makeTaskBundle((await demo.getWorkspace()).id);
      await demo.insertTaskBundle(bundle);
      expect(await demo.listTasks()).toHaveLength(1);
      expect(await live.listTasks()).toHaveLength(0);

      const demoObject = await demo.objects.put(new TextEncoder().encode('demo only'), 'text/plain');
      expect(await demo.objects.has(demoObject.hash)).toBe(true);
      expect(await live.objects.has(demoObject.hash)).toBe(false);
    } finally {
      await demo.close();
      await live.close();
    }
  });
});

describe('WAL durability side files', () => {
  it('writes a -wal file while open and removes it after a clean close', async () => {
    const { storage } = await createTempStorage();
    const { makeTaskBundle } = await import('./fixtures');
    const workspace = await storage.getWorkspace();
    await storage.insertTaskBundle(makeTaskBundle(workspace.id));
    // WAL is created lazily; after at least one write it must exist while open.
    expect(existsSync(`${storage.dbPath}-wal`)).toBe(true);
    await storage.close();
    expect(existsSync(`${storage.dbPath}-wal`)).toBe(false);
    await fs.access(storage.dbPath);
  });
});
