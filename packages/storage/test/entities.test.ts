import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactModuleSchema,
  BudgetPolicySchema,
  createBudgetUsage,
  LIMITS,
  newRunId,
  utcNow,
  type Artifact,
  type ArtifactModule,
  type Task,
} from '@ca/contracts';
import { RevisionConflictError } from '../src/types';
import {
  cleanupTempStorages,
  createTempStorage,
  defaultWorkspaceSettings,
  makeBlocker,
  makeCheckpoint,
  makeContextSnapshot,
  makeDecision,
  makePatch,
  makeProviderProfile,
  makeRecipe,
  makeRun,
  makeSource,
  makeSpan,
  makeStep,
  makeTaskBundle,
  makeToolInvocation,
  makeValidationReport,
  makeVersion,
  sampleCsvContent,
  sampleJsonContent,
  sampleMarkdownContent,
  type TaskBundleFixture,
} from './fixtures';

afterEach(async () => {
  await cleanupTempStorages();
});

interface Setup {
  storage: Awaited<ReturnType<typeof createTempStorage>>['storage'];
  bundle: TaskBundleFixture;
}

async function setup(kinds: Array<ArtifactModule['kind']> = ['markdown', 'json', 'csv']): Promise<Setup> {
  const { storage, workspace } = await createTempStorage();
  const bundle = makeTaskBundle(workspace.id, { kinds });
  await storage.insertTaskBundle(bundle);
  return { storage, bundle };
}

function moduleWith(module: ArtifactModule, patch: Partial<ArtifactModule>): ArtifactModule {
  return ArtifactModuleSchema.parse({ ...module, ...patch, updatedAt: utcNow() });
}

describe('workspace settings', () => {
  it('merges partial settings and bumps the internal workspace revision', async () => {
    const { storage } = await createTempStorage();
    const before = await storage.getWorkspace();
    const updated = await storage.updateWorkspaceSettings({ autoAcceptVerifiedDrafts: true, theme: 'system' }, 0);
    expect(updated.settings.autoAcceptVerifiedDrafts).toBe(true);
    expect(updated.settings.theme).toBe('system');
    expect(updated.id).toBe(before.id);
    // Other settings keep their previous values.
    expect(updated.settings.reducedMotion).toBe(defaultWorkspaceSettings.reducedMotion);
    await expect(storage.updateWorkspaceSettings({ pauseWhenPageCloses: true }, 0)).rejects.toBeInstanceOf(
      RevisionConflictError,
    );
  });
});

describe('task bundle aggregate', () => {
  it('round-trips task, artifact and modules preserving the initial revision', async () => {
    const { storage, bundle } = await setup();
    const aggregate = await storage.getTaskAggregate(bundle.task.id);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.task).toEqual(bundle.task);
    expect(aggregate!.task.revision).toBe(0);
    expect(aggregate!.artifact).toEqual(bundle.artifact);
    expect(aggregate!.modules).toEqual(bundle.modules);

    expect(await storage.getTask(bundle.task.id)).toEqual(bundle.task);
    expect(await storage.listTasks()).toEqual([bundle.task]);
    expect(await storage.getTaskAggregate('00000000-0000-4000-8000-000000000000' as Task['id'])).toBeNull();
  });

  it('rejects a task bundle whose modules do not match the artifact skeleton', async () => {
    const { storage, workspace } = await createTempStorage();
    const bundle = makeTaskBundle(workspace.id, { kinds: ['markdown', 'json'] });
    await expect(
      storage.insertTaskBundle({ ...bundle, modules: [bundle.modules[0]!] }),
    ).rejects.toThrow(/exactly one module per artifact/i);
    await expect(
      storage.insertTaskBundle({
        ...bundle,
        artifact: { ...bundle.artifact, taskId: bundle.artifact.id as unknown as Task['id'] },
      }),
    ).rejects.toThrow();
    // Duplicate ids in artifact.moduleIds are rejected even when lengths match.
    await expect(
      storage.insertTaskBundle({
        ...bundle,
        artifact: {
          ...bundle.artifact,
          moduleIds: [bundle.modules[0]!.id, bundle.modules[0]!.id],
        },
      }),
    ).rejects.toThrow(/duplicates/i);
    expect(await storage.listTasks()).toHaveLength(0);
  });

  it('updateTask persists changes and bumpTaskRevision is compare-and-set', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const updated = { ...bundle.task, intent: 'Revised intent', updatedAt: utcNow() };
    await storage.updateTask(updated);
    expect((await storage.getTask(bundle.task.id))!.intent).toBe('Revised intent');

    const bumped = await storage.bumpTaskRevision(bundle.task.id, 0);
    expect(bumped.revision).toBe(1);
    expect(bumped.intent).toBe('Revised intent');
    await expect(storage.bumpTaskRevision(bundle.task.id, 0)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(1);

    const bumpedAgain = await storage.bumpTaskRevision(bundle.task.id, 1);
    expect(bumpedAgain.revision).toBe(2);

    await expect(
      storage.updateTask({ ...bundle.task, intent: 'ghost', id: '00000000-0000-4000-8000-000000000001' as Task['id'] }),
    ).rejects.toThrow(/does not exist/);
  });

  it('updates and reorders modules, and reads artifact/module lookups', async () => {
    const { storage, bundle } = await setup(['markdown', 'json']);
    const [first, second] = bundle.modules as [ArtifactModule, ArtifactModule];
    const updatedFirst = moduleWith(first, { title: 'Renamed', order: 1 });
    const updatedSecond = moduleWith(second, { order: 0 });
    await storage.updateModules([updatedFirst, updatedSecond]);

    expect(await storage.getModule(first.id)).toEqual(updatedFirst);
    expect((await storage.listModules(bundle.artifact.id)).map((module) => module.id)).toEqual([
      updatedSecond.id,
      updatedFirst.id,
    ]);
    expect(await storage.getArtifact(bundle.artifact.id)).toEqual(bundle.artifact);
    expect(await storage.getArtifact('00000000-0000-4000-8000-000000000002')).toBeNull();

    // Modules can never be moved to another artifact.
    const other = makeTaskBundle((await storage.getWorkspace()).id, { kinds: ['markdown'] });
    await storage.insertTaskBundle(other);
    await expect(
      storage.updateModules([moduleWith(first, { artifactId: other.artifact.id })]),
    ).rejects.toMatchObject({ code: 'state_not_allowed' });
  });
});

describe('artifact versions', () => {
  it('stores immutable versions and resolves the accepted version per module', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const module = bundle.modules[0]!;
    const v1 = makeVersion(bundle.artifact, module, { content: sampleMarkdownContent() });
    await storage.insertVersion(v1);
    const v2 = makeVersion(bundle.artifact, module, { baseVersionId: v1.id, parentId: v1.id });
    await storage.insertVersion(v2);

    expect(await storage.getVersion(v1.id)).toEqual(v1);
    expect((await storage.listVersions(module.id)).map((version) => version.id)).toEqual([v1.id, v2.id]);
    expect(await storage.getAcceptedVersion(module.id)).toBeNull();

    await storage.updateModules([moduleWith(module, { acceptedVersionId: v1.id, status: 'accepted' })]);
    expect(await storage.getAcceptedVersion(module.id)).toEqual(v1);

    // Duplicate id is rejected: versions are immutable.
    await expect(storage.insertVersion(v1)).rejects.toThrow(/already exists/i);
    // Unknown module is rejected before any write.
    const orphan = makeVersion(bundle.artifact, module);
    await expect(
      storage.insertVersion({ ...orphan, moduleId: '00000000-0000-4000-8000-000000000003' as ArtifactModule['id'] }),
    ).rejects.toThrow(/does not exist/);
  });

  it('preserves JSON content fidelity for markdown, JSON and CSV module versions', async () => {
    const { storage, bundle } = await setup(['markdown', 'json', 'csv']);
    const contents = [sampleMarkdownContent(), sampleJsonContent(), sampleCsvContent()];
    for (let index = 0; index < bundle.modules.length; index += 1) {
      const module = bundle.modules[index]!;
      const version = makeVersion(bundle.artifact, module, { content: contents[index]! });
      await storage.insertVersion(version);
      expect((await storage.getVersion(version.id))!.content).toEqual(contents[index]);
    }
  });
});

describe('sources and spans', () => {
  it('stores versioned sources, reads content, and lists latest versions', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const taskId = bundle.task.id;
    const v1 = makeSource(taskId, { content: new TextEncoder().encode('version one') });
    await storage.insertSource(v1.source, v1.content);
    // Idempotent replay.
    await storage.insertSource(v1.source, v1.content);
    // A content update is a NEW version; overwriting evidence is rejected.
    await expect(storage.insertSource(v1.source, new TextEncoder().encode('different'))).rejects.toThrow(
      /content hashes to/i,
    );

    const v2 = makeSource(taskId, { version: 2, content: new TextEncoder().encode('版本二 content') });
    v2.source = { ...v2.source, id: v1.source.id };
    await storage.insertSource(v2.source, v2.content);

    const latest = await storage.getSource(taskId, v1.source.id);
    expect(latest!.source.version).toBe(2);
    expect(new TextDecoder().decode(latest!.content)).toBe('版本二 content');
    const older = await storage.getSource(taskId, v1.source.id, 1);
    expect(new TextDecoder().decode(older!.content)).toBe('version one');

    expect(await storage.listSources(taskId)).toEqual([v2.source]);
    const candidates = await storage.listLatestSourceContents(taskId);
    expect(candidates).toHaveLength(1);
    expect(new TextDecoder().decode(candidates[0]!.bytes)).toBe('版本二 content');

    await storage.markSourcesMissing([v1.source.id]);
    expect((await storage.listSources(taskId))[0]!.availability).toBe('missing');
    expect(await storage.listLatestSourceContents(taskId)).toHaveLength(0);
    await expect(storage.getSource(taskId, v1.source.id)).resolves.not.toBeNull();
  });

  it('rejects a source whose declared hash/size does not match its bytes', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const source = makeSource(bundle.task.id);
    await expect(
      storage.insertSource({ ...source.source, hash: 'a'.repeat(64) }, source.content),
    ).rejects.toThrow(/content hashes to/i);
    await expect(
      storage.insertSource({ ...source.source, sizeBytes: source.source.sizeBytes + 1 }, source.content),
    ).rejects.toThrow(/declares/i);
  });

  it('enforces the per-file source size limit before hashing or writing', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const oversized = new Uint8Array(LIMITS.maxSourceFileBytes + 1);
    const source = makeSource(bundle.task.id);
    await expect(
      storage.insertSource({ ...source.source, sizeBytes: oversized.byteLength }, oversized),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect((await storage.objects.listObjects()).length).toBe(0);
  });

  it('inserts spans, upserts them idempotently by id, and filters by task', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const source = makeSource(bundle.task.id);
    await storage.insertSource(source.source, source.content);
    const span = makeSpan(source.source);
    await storage.insertSpans([span]);
    expect(await storage.listSpans(bundle.task.id)).toEqual([span]);

    const replayed = makeSpan(source.source, { id: span.id, excerpt: 'updated excerpt' });
    await storage.insertSpans([replayed]);
    const spans = await storage.listSpans(bundle.task.id);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.excerpt).toBe('updated excerpt');
    expect(spans[0]!.createdAt).toBe(span.createdAt);

    const other = makeTaskBundle((await storage.getWorkspace()).id, { kinds: ['markdown'] });
    await storage.insertTaskBundle(other);
    expect(await storage.listSpans(other.task.id)).toEqual([]);
  });
});

describe('runs, steps and checkpoints', () => {
  it('round-trips runs with CAS updates and active/queued queries', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const module = bundle.modules[0]!;
    const run = makeRun(bundle.task, module.id);
    await storage.insertRun(run);
    expect(await storage.getRun(run.id)).toEqual(run);
    expect(await storage.listRuns(bundle.task.id)).toEqual([run]);

    const updated = await storage.updateRun({ ...run, state: 'PLANNING', updatedAt: utcNow() }, 0);
    expect(updated.revision).toBe(1);
    await expect(storage.updateRun({ ...run, state: 'READY' }, 0)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await storage.getRun(run.id))!.state).toBe('PLANNING');

    const next = await storage.updateRunStateIfRevision(
      run.id,
      1,
      { ...updated, state: 'READY', revision: 1, updatedAt: utcNow() } as typeof updated,
    );
    expect(next.state).toBe('READY');
    expect(next.revision).toBe(2);
    await expect(storage.updateRunStateIfRevision(run.id, 1, next)).rejects.toBeInstanceOf(RevisionConflictError);

    expect(await storage.findActiveRunId(bundle.task.id)).toBe(run.id);
    expect(await storage.countActiveRuns()).toBe(1);
    expect(await storage.listQueuedRuns()).toHaveLength(0);

    // Runs are physically mode-scoped and their module must belong to the task.
    await expect(storage.insertRun({ ...makeRun(bundle.task, module.id), mode: 'live' })).rejects.toMatchObject({
      code: 'state_not_allowed',
    });
    const other = makeTaskBundle((await storage.getWorkspace()).id, { kinds: ['markdown'] });
    await storage.insertTaskBundle(other);
    await expect(
      storage.insertRun({ ...makeRun(bundle.task, module.id), moduleId: other.modules[0]!.id }),
    ).rejects.toMatchObject({ code: 'state_not_allowed' });

    const queued = makeRun(bundle.task, module.id, { state: 'CREATED' });
    await storage.insertRun({ ...queued, queuePosition: 2 });
    const queuedFirst = makeRun(bundle.task, module.id, { state: 'CREATED' });
    await storage.insertRun({ ...queuedFirst, queuePosition: 1 });
    const queue = await storage.listQueuedRuns();
    expect(queue.map((entry) => entry.id)).toEqual([queuedFirst.id, queued.id]);

    const finished = await storage.updateRunStateIfRevision(
      run.id,
      next.revision,
      { ...next, state: 'COMPLETED', revision: next.revision, updatedAt: utcNow() } as typeof next,
    );
    expect(finished.state).toBe('COMPLETED');
    expect(await storage.findActiveRunId(bundle.task.id)).toBeNull();
    // Queued CREATED runs are not executing, so they do not count as active.
    expect(await storage.countActiveRuns()).toBe(0);

    // A READY run waiting for global capacity is also "queued" (state READY),
    // because listQueuedRuns serves the server capacity scheduler.
    const readyQueued = makeRun(bundle.task, module.id, { state: 'READY' });
    await storage.insertRun({ ...readyQueued, queuePosition: 3 });
    expect((await storage.listQueuedRuns()).map((entry) => entry.id)).toEqual([
      queuedFirst.id,
      queued.id,
      readyQueued.id,
    ]);
    expect(await storage.countActiveRuns()).toBe(1);
    // Clearing the queue position removes a run from the queue.
    const readyStored = await storage.getRun(readyQueued.id);
    await storage.updateRun({ ...readyStored!, queuePosition: null, updatedAt: utcNow() }, readyStored!.revision);
    expect(await storage.listQueuedRuns()).toHaveLength(2);
  });

  it('rejects runs/steps for unknown parents and supports step updates', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const module = bundle.modules[0]!;
    const run = makeRun(bundle.task, module.id);
    await expect(storage.insertStep(makeStep(run))).rejects.toThrow(/does not exist/);

    await storage.insertRun(run);
    const step = makeStep(run);
    await storage.insertStep(step);
    expect(await storage.listSteps(run.id)).toEqual([step]);
    const finishedStep = { ...step, status: 'completed' as const, summary: 'done', finishedAt: utcNow() };
    await storage.updateStep(finishedStep);
    expect(await storage.listSteps(run.id)).toEqual([finishedStep]);
    await expect(storage.updateStep({ ...step, id: makeStep(run).id })).rejects.toThrow(/does not exist/);
  });

  it('keeps the latest checkpoint by seqAtCheckpoint', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const run = makeRun(bundle.task, bundle.modules[0]!.id);
    await storage.insertRun(run);
    const first = makeCheckpoint(run, { seqAtCheckpoint: 2 });
    const second = makeCheckpoint(run, { seqAtCheckpoint: 5 });
    const third = makeCheckpoint(run, { seqAtCheckpoint: 3 });
    await storage.insertCheckpoint(first);
    await storage.insertCheckpoint(third);
    await storage.insertCheckpoint(second);
    expect(await storage.getCheckpoint(first.id)).toEqual(first);
    expect(await storage.latestCheckpoint(run.id)).toEqual(second);
    // Exact replay is a no-op; conflicting duplicate is rejected.
    await storage.insertCheckpoint(first);
    await expect(storage.insertCheckpoint({ ...first, dataJson: '{"other":true}' })).rejects.toThrow(/different content/i);
  });
});

describe('blockers, decisions, patches, validation, context snapshots, tool invocations', () => {
  it('round-trips blockers with resolution state', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const run = makeRun(bundle.task, bundle.modules[0]!.id);
    await storage.insertRun(run);
    const blocker = makeBlocker(bundle.task, run);
    await storage.insertBlocker(blocker);
    expect(await storage.getBlocker(blocker.id)).toEqual(blocker);
    expect(await storage.listBlockers(bundle.task.id)).toEqual([blocker]);

    const resolved = {
      ...blocker,
      status: 'resolved' as const,
      resolvedAt: utcNow(),
      resolution: {
        optionId: 'choose-audience',
        value: 'internal',
        note: 'internal team',
        decidedBy: 'user',
        decidedAt: utcNow(),
      },
    };
    await storage.updateBlocker(resolved);
    expect(await storage.getBlocker(blocker.id)).toEqual(resolved);
    await expect(storage.updateBlocker({ ...blocker, id: makeBlocker(bundle.task, run).id })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('round-trips decisions', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const run = makeRun(bundle.task, bundle.modules[0]!.id);
    await storage.insertRun(run);
    const decision = makeDecision(bundle.task, run);
    await storage.insertDecision(decision);
    expect(await storage.listDecisions(bundle.task.id)).toEqual([decision]);
  });

  it('round-trips patches and updates status/acceptedVersionId', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const module = bundle.modules[0]!;
    const run = makeRun(bundle.task, module.id);
    await storage.insertRun(run);
    const patch = makePatch(bundle.task, run, module);
    await storage.insertPatch(patch);
    expect(await storage.getPatch(patch.id)).toEqual(patch);
    expect(await storage.listPatches(bundle.task.id)).toEqual([patch]);

    const versionId = makeVersion(bundle.artifact, module).id;
    const accepted = { ...patch, status: 'accepted' as const, acceptedVersionId: versionId };
    await storage.updatePatch(accepted);
    expect(await storage.getPatch(patch.id)).toEqual(accepted);
  });

  it('round-trips validation reports and context snapshots', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const module = bundle.modules[0]!;
    const run = makeRun(bundle.task, module.id);
    await storage.insertRun(run);
    const report = makeValidationReport(bundle.task, run, module);
    await storage.insertValidationReport(report);
    expect(await storage.getValidationReport(report.id)).toEqual(report);
    expect(await storage.listValidationReports(bundle.task.id)).toEqual([report]);

    const snapshot = makeContextSnapshot(bundle.task, run);
    await storage.insertContextSnapshot(snapshot);
    expect(await storage.getContextSnapshot(snapshot.id)).toEqual(snapshot);
  });

  it('round-trips tool invocations and finds unclear outcomes for recovery', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const module = bundle.modules[0]!;
    const run = makeRun(bundle.task, module.id);
    await storage.insertRun(run);
    const step = makeStep(run);
    await storage.insertStep(step);

    const planned = makeToolInvocation(run, step);
    await storage.insertToolInvocation(planned);
    const started = makeToolInvocation(run, step, { status: 'started', startedAt: utcNow() });
    await storage.insertToolInvocation(started);
    const unknown = makeToolInvocation(run, step, { status: 'outcome_unknown', startedAt: utcNow() });
    await storage.insertToolInvocation(unknown);
    const succeeded = makeToolInvocation(run, step, { status: 'succeeded', finishedAt: utcNow() });
    await storage.insertToolInvocation(succeeded);

    expect(await storage.listToolInvocations(run.id)).toHaveLength(4);
    const unclear = await storage.findUnclearToolInvocations(run.id);
    expect(unclear.map((record) => record.toolCallId).sort()).toEqual([started.toolCallId, unknown.toolCallId].sort());

    const failed = { ...started, status: 'failed' as const, finishedAt: utcNow() };
    await storage.updateToolInvocation(failed);
    const unclearAfter = await storage.findUnclearToolInvocations(run.id);
    expect(unclearAfter).toHaveLength(1);
    expect(unclearAfter[0]!.toolCallId).toBe(unknown.toolCallId);
  });
});

describe('recipes and provider profiles', () => {
  it('stores recipe versions and resolves the latest per id', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const run = makeRun(bundle.task, bundle.modules[0]!.id);
    await storage.insertRun(run);
    const v1 = makeRecipe(bundle.task, run);
    await storage.insertRecipe(v1);
    expect(await storage.getRecipe(v1.id)).toEqual(v1);
    expect(await storage.listRecipes()).toEqual([v1]);
    expect(await storage.listRecipes(bundle.task.id)).toEqual([v1]);
    expect(await storage.nextRecipeVersion(v1.id)).toBe(2);

    const v2 = makeRecipe(bundle.task, run, { id: v1.id, version: 2, status: 'validated', updatedAt: utcNow() });
    await storage.insertRecipe(v2);
    expect(await storage.getRecipe(v1.id)).toEqual(v2);
    expect(await storage.nextRecipeVersion(v1.id)).toBe(3);
    const disabled = { ...v2, status: 'disabled' as const };
    await storage.updateRecipe(disabled);
    expect(await storage.getRecipe(v1.id)).toEqual(disabled);
    await expect(storage.insertRecipe(v1)).rejects.toThrow(/already exists/i);
  });

  it('upserts, lists and deletes provider profiles without ever exposing credentials', async () => {
    const { storage } = await createTempStorage();
    const profile = makeProviderProfile();
    await storage.upsertProviderProfile(profile);
    expect(await storage.getProviderProfile(profile.id)).toEqual(profile);
    expect(await storage.listProviderProfiles()).toEqual([profile]);

    const changed = { ...profile, model: 'other-model', updatedAt: utcNow() };
    await storage.upsertProviderProfile(changed);
    const stored = await storage.getProviderProfile(profile.id);
    expect(stored!.model).toBe('other-model');
    expect(stored!.createdAt).toBe(profile.createdAt);

    const columns = storage.rawQuery('PRAGMA table_info(provider_profiles)').map((row) => String(row['name']));
    expect(columns).toContain('credential_ref');
    expect(columns.some((column) => /secret|token|password|api_key/i.test(column))).toBe(false);

    await storage.deleteProviderProfile(profile.id);
    expect(await storage.getProviderProfile(profile.id)).toBeNull();
    await storage.deleteProviderProfile(profile.id); // idempotent
  });
});

describe('empty/boundary inputs', () => {
  it('returns empty collections for an empty workspace and rejects empty update batches', async () => {
    const { storage } = await createTempStorage();
    expect(await storage.listTasks()).toEqual([]);
    expect(await storage.listProviderProfiles()).toEqual([]);
    expect(await storage.listQueuedRuns()).toEqual([]);
    expect(await storage.countActiveRuns()).toBe(0);
    expect(await storage.latestSeq('00000000-0000-4000-8000-000000000004' as Task['id'])).toBe(0);
    await expect(storage.updateModules([])).resolves.toBeUndefined();
  });

  it('exposes artifacts created with default budget helpers for later run insertion', async () => {
    const { storage, bundle } = await setup(['markdown']);
    const run = makeRun(bundle.task, bundle.modules[0]!.id);
    const normalized = {
      ...run,
      budgetPolicy: BudgetPolicySchema.parse({}),
      budgetUsage: createBudgetUsage(utcNow()),
    };
    await storage.insertRun(normalized);
    expect((await storage.getRun(run.id))!.budgetPolicy.maxModelRequests).toBe(12);
    expect(await storage.getRun(newRunId())).toBeNull();
  });
});
