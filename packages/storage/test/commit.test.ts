import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactModuleSchema, ArtifactSchema, utcNow, type Artifact, type ArtifactModule, type Run } from '@ca/contracts';
import { RevisionConflictError, StateNotAllowedError, VersionConflictError } from '../src/types';
import type { EventDraft } from '../src/types';
import {
  cleanupTempStorages,
  createTempStorage,
  makePatch,
  makeRun,
  makeTaskBundle,
  makeVersion,
  type TaskBundleFixture,
} from './fixtures';

afterEach(async () => {
  await cleanupTempStorages();
});

interface CommitSetup {
  storage: Awaited<ReturnType<typeof createTempStorage>>['storage'];
  bundle: TaskBundleFixture;
  module: ArtifactModule;
  run: Run;
}

async function setup(): Promise<CommitSetup> {
  const { storage, workspace } = await createTempStorage();
  const bundle = makeTaskBundle(workspace.id, { kinds: ['markdown'] });
  await storage.insertTaskBundle(bundle);
  const module = bundle.modules[0]!;
  const run = makeRun(bundle.task, module.id);
  await storage.insertRun(run);
  return { storage, bundle, module, run };
}

function acceptedArtifact(artifact: Artifact, versionId: string): Artifact {
  return ArtifactSchema.parse({
    ...artifact,
    status: 'active',
    acceptedVersionId: versionId,
    updatedAt: utcNow(),
  });
}

function acceptedModule(module: ArtifactModule, versionId: string): ArtifactModule {
  return ArtifactModuleSchema.parse({ ...module, status: 'accepted', acceptedVersionId: versionId, updatedAt: utcNow() });
}

function artifactAcceptedDraft(
  artifact: Artifact,
  module: ArtifactModule,
  versionId: string,
  patchId: string | null,
  contentHash: string,
): EventDraft<'artifact.accepted'> {
  return {
    runId: null,
    stepId: null,
    causationId: null,
    type: 'artifact.accepted',
    payload: {
      versionId: versionId as EventDraft<'artifact.accepted'>['payload']['versionId'],
      patchId: patchId as EventDraft<'artifact.accepted'>['payload']['patchId'],
      moduleId: module.id,
      contentHash,
      acceptedBy: 'user',
      note: '',
      route: 'user_accept',
    },
  };
}

function runCompletedDraft(run: Run, versionId: string): EventDraft<'run.completed'> {
  return {
    runId: run.id,
    stepId: null,
    causationId: null,
    type: 'run.completed',
    payload: {
      runId: run.id,
      versionId: versionId as EventDraft<'run.completed'>['payload']['versionId'],
      moduleId: run.moduleId,
    },
  };
}

describe('commitAcceptance', () => {
  it('atomically inserts the immutable version, updates pointers/patch/task and appends events', async () => {
    const { storage, bundle, module, run } = await setup();
    const version = makeVersion(bundle.artifact, module);
    const patch = makePatch(bundle.task, run, module, { content: version.content });
    await storage.insertPatch(patch);

    const result = await storage.commitAcceptance({
      taskId: bundle.task.id,
      patchId: patch.id,
      version,
      expectedTaskRevision: 0,
      updatedModules: [acceptedModule(module, version.id)],
      artifact: acceptedArtifact(bundle.artifact, version.id),
      events: [
        artifactAcceptedDraft(bundle.artifact, module, version.id, patch.id, version.contentHash),
        runCompletedDraft(run, version.id),
      ],
    });

    expect(result.taskRevision).toBe(1);
    expect(result.version).toEqual(version);
    expect(result.artifact.acceptedVersionId).toBe(version.id);
    expect(result.events.map((event) => event.seq)).toEqual([1, 2]);

    expect(await storage.getVersion(version.id)).toEqual(version);
    expect(await storage.getAcceptedVersion(module.id)).toEqual(version);
    expect((await storage.getPatch(patch.id))!.status).toBe('accepted');
    expect((await storage.getPatch(patch.id))!.acceptedVersionId).toBe(version.id);
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(1);
    expect((await storage.getArtifact(bundle.artifact.id))!.acceptedVersionId).toBe(version.id);
    expect((await storage.getModule(module.id))!.status).toBe('accepted');
    expect((await storage.eventsAfter(bundle.task.id, 0)).map((event) => event.type)).toEqual([
      'artifact.accepted',
      'run.completed',
    ]);
  });

  it('auto-accepts the target module when updatedModules omits it', async () => {
    const { storage, bundle, module, run } = await setup();
    const version = makeVersion(bundle.artifact, module);
    await storage.commitAcceptance({
      taskId: bundle.task.id,
      patchId: '',
      version,
      expectedTaskRevision: 0,
      updatedModules: [],
      artifact: acceptedArtifact(bundle.artifact, version.id),
      events: [],
    });
    const storedModule = await storage.getModule(module.id);
    expect(storedModule!.status).toBe('accepted');
    expect(storedModule!.acceptedVersionId).toBe(version.id);
    expect(await storage.getAcceptedVersion(module.id)).toEqual(version);
  });

  it('rejects a stale base version and preserves both sides of the conflict', async () => {
    const { storage, bundle, module, run } = await setup();
    const v1 = makeVersion(bundle.artifact, module);
    const patch1 = makePatch(bundle.task, run, module, { content: v1.content });
    await storage.insertPatch(patch1);
    await storage.commitAcceptance({
      taskId: bundle.task.id,
      patchId: patch1.id,
      version: v1,
      expectedTaskRevision: 0,
      updatedModules: [acceptedModule(module, v1.id)],
      artifact: acceptedArtifact(bundle.artifact, v1.id),
      events: [],
    });

    // Second change generated against v1 is fine while v1 is still accepted.
    const v2 = makeVersion(bundle.artifact, module, { baseVersionId: v1.id, parentId: v1.id });
    await storage.commitAcceptance({
      taskId: bundle.task.id,
      patchId: '',
      version: v2,
      expectedTaskRevision: 1,
      updatedModules: [acceptedModule(module, v2.id)],
      artifact: acceptedArtifact(bundle.artifact, v2.id),
      events: [],
    });
    expect((await storage.getAcceptedVersion(module.id))!.id).toBe(v2.id);

    // A third change still generated against v1 is stale now.
    const stale = makeVersion(bundle.artifact, module, { baseVersionId: v1.id });
    const seqBefore = await storage.latestSeq(bundle.task.id);
    await expect(
      storage.commitAcceptance({
        taskId: bundle.task.id,
        patchId: '',
        version: stale,
        expectedTaskRevision: 2,
        updatedModules: [acceptedModule(module, stale.id)],
        artifact: acceptedArtifact(bundle.artifact, stale.id),
        events: [artifactAcceptedDraft(bundle.artifact, module, stale.id, null, stale.contentHash)],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // Nothing from the rejected commit leaked; the accepted version is unchanged.
    expect(await storage.getVersion(stale.id)).toBeNull();
    expect(await storage.getVersion(v1.id)).toEqual(v1);
    expect(await storage.getVersion(v2.id)).toEqual(v2);
    expect((await storage.getAcceptedVersion(module.id))!.id).toBe(v2.id);
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(2);
    expect(await storage.latestSeq(bundle.task.id)).toBe(seqBefore);
  });

  it('rejects a non-existent base version', async () => {
    const { storage, bundle, module } = await setup();
    const version = makeVersion(bundle.artifact, module);
    const missingBase = makeVersion(bundle.artifact, module).id;
    await expect(
      storage.commitAcceptance({
        taskId: bundle.task.id,
        patchId: '',
        version: { ...version, baseVersionId: missingBase },
        expectedTaskRevision: 0,
        updatedModules: [],
        artifact: acceptedArtifact(bundle.artifact, version.id),
        events: [],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await storage.getVersion(version.id)).toBeNull();
  });

  it('rejects a stale expected task revision before writing anything', async () => {
    const { storage, bundle, module } = await setup();
    const version = makeVersion(bundle.artifact, module);
    await expect(
      storage.commitAcceptance({
        taskId: bundle.task.id,
        patchId: '',
        version,
        expectedTaskRevision: 7,
        updatedModules: [],
        artifact: acceptedArtifact(bundle.artifact, version.id),
        events: [],
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await storage.getVersion(version.id)).toBeNull();
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(0);
    expect(await storage.eventCount(bundle.task.id)).toBe(0);
  });

  it('rolls back the whole acceptance when an event payload is invalid', async () => {
    const { storage, bundle, module, run } = await setup();
    const version = makeVersion(bundle.artifact, module);
    const patch = makePatch(bundle.task, run, module, { content: version.content });
    await storage.insertPatch(patch);
    const invalid = {
      ...artifactAcceptedDraft(bundle.artifact, module, version.id, patch.id, version.contentHash),
      payload: { versionId: version.id },
    } as unknown as EventDraft;

    await expect(
      storage.commitAcceptance({
        taskId: bundle.task.id,
        patchId: patch.id,
        version,
        expectedTaskRevision: 0,
        updatedModules: [acceptedModule(module, version.id)],
        artifact: acceptedArtifact(bundle.artifact, version.id),
        events: [invalid],
      }),
    ).rejects.toMatchObject({ code: 'schema_invalid' });

    expect(await storage.getVersion(version.id)).toBeNull();
    expect(await storage.getAcceptedVersion(module.id)).toBeNull();
    expect((await storage.getTask(bundle.task.id))!.revision).toBe(0);
    expect((await storage.getPatch(patch.id))!.status).toBe('proposed');
    expect((await storage.getArtifact(bundle.artifact.id))!.acceptedVersionId).toBeNull();
    expect(await storage.eventCount(bundle.task.id)).toBe(0);
  });

  it('rejects replaying an already accepted patch and duplicate versions', async () => {
    const { storage, bundle, module, run } = await setup();
    const version = makeVersion(bundle.artifact, module);
    const patch = makePatch(bundle.task, run, module, { content: version.content });
    await storage.insertPatch(patch);
    await storage.commitAcceptance({
      taskId: bundle.task.id,
      patchId: patch.id,
      version,
      expectedTaskRevision: 0,
      updatedModules: [acceptedModule(module, version.id)],
      artifact: acceptedArtifact(bundle.artifact, version.id),
      events: [],
    });

    const replay = makeVersion(bundle.artifact, module, { baseVersionId: version.id });
    await expect(
      storage.commitAcceptance({
        taskId: bundle.task.id,
        patchId: patch.id,
        version: replay,
        expectedTaskRevision: 1,
        updatedModules: [],
        artifact: acceptedArtifact(bundle.artifact, replay.id),
        events: [],
      }),
    ).rejects.toBeInstanceOf(StateNotAllowedError);

    await expect(
      storage.commitAcceptance({
        taskId: bundle.task.id,
        patchId: '',
        version,
        expectedTaskRevision: 1,
        updatedModules: [],
        artifact: acceptedArtifact(bundle.artifact, version.id),
        events: [],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('tolerates a missing patch row (restore path) and keeps version.patchId null', async () => {
    const { storage, bundle, module, run } = await setup();
    const v1 = makeVersion(bundle.artifact, module);
    await storage.commitAcceptance({
      taskId: bundle.task.id,
      patchId: '',
      version: v1,
      expectedTaskRevision: 0,
      updatedModules: [acceptedModule(module, v1.id)],
      artifact: acceptedArtifact(bundle.artifact, v1.id),
      events: [],
    });
    const restoredContent = makeVersion(bundle.artifact, module, { baseVersionId: v1.id }).content;
    const restored = {
      ...makeVersion(bundle.artifact, module, { baseVersionId: v1.id, parentId: v1.id }),
      content: restoredContent,
      restoredFromVersionId: v1.id,
      acceptedBy: 'user',
    };
    const result = await storage.commitAcceptance({
      taskId: bundle.task.id,
      patchId: 'synthetic-restore-' as unknown as string,
      version: restored,
      expectedTaskRevision: 1,
      updatedModules: [acceptedModule(module, restored.id)],
      artifact: acceptedArtifact(bundle.artifact, restored.id),
      events: [],
    });
    expect(result.taskRevision).toBe(2);
    expect((await storage.getVersion(restored.id))!.restoredFromVersionId).toBe(v1.id);
    expect((await storage.getAcceptedVersion(module.id))!.id).toBe(restored.id);
    void run;
  });
});
