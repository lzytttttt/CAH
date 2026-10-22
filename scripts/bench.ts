/**
 * Local performance measurements for the P0 targets in design section 21.2.
 * Records real numbers on the current machine; never fabricates results.
 * Run: pnpm exec tsx scripts/bench.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  newArtifactId,
  newModuleId,
  newRunId,
  newSourceId,
  newTaskId,
  utcNow,
  type Artifact,
  type ArtifactModule,
  type Task,
  type EventDraft,
} from '@ca/contracts';
import { applyTransformOperations, parseCsv, tableFromParsedCsv } from '@ca/tools';
import { openStorage } from '@ca/storage';
import { projectTaskSnapshot } from '../apps/server/src/projection';
import { loadConfig } from '../apps/server/src/config';

function nowIso(): string {
  return new Date().toISOString();
}

async function benchCleaning(): Promise<void> {
  const header = 'system_id,name,owner,status,data_volume_gb,latency_ms,protocol';
  const rows = Array.from({ length: 1000 }, (_, index) => {
    const id = `S-${1000 + index}`;
    return `${index % 7 === 0 ? `${id},名称 ${index},部门,Active,${100 + index},${50 + (index % 300)},REST` : `${id},系统 ${index},部门,active,${100 + index},${50 + (index % 300)},SOAP`}`;
  });
  const csvText = `${header}\n${rows.join('\n')}\n`;
  const start = performance.now();
  const parsed = parseCsv(csvText, { sourceLabel: 'bench-1000' });
  const table = tableFromParsedCsv(parsed);
  const outcome = applyTransformOperations(table, [
    { op: 'normalize', column: 'status', transforms: ['trim', 'lower'], nullTokens: [] },
    { op: 'dedupe', keys: ['system_id'], keep: 'last', normalize: 'trim_lower' },
    { op: 'cast', column: 'data_volume_gb', to: 'number', strict: false },
    { op: 'sort', column: 'system_id', direction: 'asc', numeric: false },
    { op: 'require', columns: ['system_id', 'name'] },
  ]);
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      benchmark: 'deterministic_cleaning_1000_rows',
      targetMs: 2000,
      elapsedMs: Number(elapsed.toFixed(1)),
      outputRows: outcome.table.rows.length,
      issues: outcome.issues.length,
      pass: elapsed < 2000,
      environment: `${process.platform} ${process.version}`,
    }),
  );
}

async function benchEventRecovery(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ca-bench-'));
  const config = { ...loadConfig({ CA_DATA_DIR: dir, CA_SEED_DEMO: 'false' }), dataDir: dir };
  const storage = openStorage({ dataDir: dir, mode: 'live', workspaceName: 'bench' });
  try {
    const now = utcNow();
    const taskId = newTaskId();
    const artifactId = newArtifactId();
    const moduleId = newModuleId();
    const task: Task = {
      id: taskId,
      workspaceId: (await storage.getWorkspace()).id,
      title: 'bench',
      intent: 'bench',
      constraints: [],
      artifactId,
      revision: 0,
      templateId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const module: ArtifactModule = {
      id: moduleId,
      artifactId,
      title: 'module',
      kind: 'markdown',
      order: 0,
      dependencies: [],
      acceptanceCriteria: [],
      status: 'empty',
      blockedFrom: null,
      acceptedVersionId: null,
      createdAt: now,
      updatedAt: now,
    };
    const artifact: Artifact = {
      id: artifactId,
      taskId,
      title: 'artifact',
      moduleIds: [moduleId],
      acceptedVersionId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await storage.insertTaskBundle({ task, artifact, modules: [module] });
    const runId = newRunId();
    const startAppend = performance.now();
    for (let batch = 0; batch < 50; batch += 1) {
      const drafts: EventDraft[] = Array.from({ length: 100 }, (_, index) => ({
        runId,
        stepId: null,
        causationId: null,
        type: 'run.state_changed',
        payload: { from: 'RUNNING', to: 'RUNNING', reason: `bench ${batch * 100 + index}` },
      }));
      await storage.appendEvents(taskId, drafts);
    }
    const appendElapsed = performance.now() - startAppend;
    const startProjection = performance.now();
    const snapshot = await projectTaskSnapshot(
      {
        storage,
        providers: {
          getProfile: async () => null,
          listEnabledProfiles: async () => [],
          capabilities: async () => {
            throw new Error('bench');
          },
          // eslint-disable-next-line require-yield
          stream: async function* () {
            throw new Error('bench');
          },
        },
        mode: 'live',
        schedulerActiveCount: () => 0,
      } as never,
      { taskId, afterSeq: 0, includeEvents: false },
    );
    const projectionElapsed = performance.now() - startProjection;
    console.log(
      JSON.stringify({
        benchmark: 'event_recovery_5000_events',
        targetMs: 2000,
        appendMs: Number(appendElapsed.toFixed(1)),
        projectionMs: Number(projectionElapsed.toFixed(1)),
        eventCount: await storage.eventCount(taskId),
        snapshotSeq: snapshot?.snapshotSeq ?? null,
        pass: projectionElapsed < 2000,
        environment: `${process.platform} ${process.version}`,
      }),
    );
    await storage.close();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    void config;
    void nowIso;
  }
}

async function main(): Promise<void> {
  console.log(`# Cognitive Atrium benchmark @ ${new Date().toISOString()} (${process.platform}/${process.arch}, ${process.version}, ${process.cpuModel ?? ''})`);
  await benchCleaning();
  await benchEventRecovery();
}

main().catch((error) => {
  console.error('bench failed', error);
  process.exit(1);
});
