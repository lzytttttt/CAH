import { describe, expect, it } from 'vitest';
import type { ModuleContent } from '@ca/contracts';
import { createHarness, waitFor, type TestHarness } from './helpers';
import { plannerOutputFor, ScriptedProviderGateway } from './fakes/scripted-provider';

const uuid = (): string => crypto.randomUUID();
const CONTENT_V1 = { kind: 'json' as const, value: { version: 1, summary: '第一版' } };
const CONTENT_V2 = { kind: 'json' as const, value: { version: 2, summary: '第二版' } };

async function inject(harness: TestHarness, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await harness.app.inject({ method, url, headers: harness.headers, payload: payload as never });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function createTaskAndPlan(harness: TestHarness, provider: ScriptedProviderGateway) {
  const created = await inject(harness, 'POST', '/api/tasks', {
    commandId: uuid(),
    title: '版本与审阅任务',
    intent: '验证版本冲突、拒绝、恢复与导出导入',
    artifactTitle: '版本交付物',
    modules: [{ key: 'main', title: '主成果', kind: 'json', order: 0, dependsOnKeys: [], acceptanceCriteria: [] }],
  });
  const taskId: string = created.body.taskId;
  const moduleId: string = created.body.moduleIds[0];
  provider.queuePlanner(plannerOutputFor({ moduleId, moduleKind: 'json' }));
  const planned = await inject(harness, 'POST', `/api/tasks/${taskId}/runs`, {
    commandId: uuid(),
    expectedRevision: 0,
    moduleId,
    intent: '生成成果',
    planFirst: true,
  });
  return { taskId, moduleId, runId: planned.body.runId as string, planVersion: planned.body.plan.version as number };
}

async function commitAndWaitForReview(
  harness: TestHarness,
  provider: ScriptedProviderGateway,
  input: { taskId: string; moduleId: string; runId: string; planVersion: number },
  content: ModuleContent,
) {
  const detail = await inject(harness, 'GET', `/api/runs/${input.runId}`);
  const contextSnapshotId = detail.body.run.contextSnapshotId;
  const snapshot = await inject(harness, 'GET', `/api/tasks/${input.taskId}/snapshot`);
  provider.queueProposePatch({ moduleId: input.moduleId, baseVersionId: null, content }).queueCandidateEnvelope(content);
  const commit = await inject(harness, 'POST', `/api/runs/${input.runId}/commit`, {
    commandId: uuid(),
    expectedRevision: snapshot.body.task.revision,
    planVersion: input.planVersion,
    contextSnapshotId,
  });
  expect(commit.status).toBe(200);
  const reviewed = await waitFor(
    async () => {
      const res = await inject(harness, 'GET', `/api/tasks/${input.taskId}/snapshot`);
      const snap = res.body;
      return ['AWAITING_REVIEW', 'FAILED', 'CANCELLED', 'AWAITING_INPUT'].includes(snap.activeRun?.state) ? snap : null;
    },
    { timeoutMs: 20_000, label: 'review' },
  );
  expect(reviewed.activeRun.state).toBe('AWAITING_REVIEW');
  return reviewed;
}

async function acceptPatch(harness: TestHarness, taskId: string, patchId: string) {
  const review = await inject(harness, 'GET', `/api/patches/${patchId}`);
  const snapshot = await inject(harness, 'GET', `/api/tasks/${taskId}/snapshot`);
  return inject(harness, 'POST', `/api/patches/${patchId}/accept`, {
    commandId: uuid(),
    expectedRevision: snapshot.body.task.revision,
    validationReportId: review.body.patch.validationReportId,
    acceptMode: 'all',
    sectionIds: [],
    note: '',
  });
}

describe('artifact versions, review and export/import', () => {
  it('creates v1, then a stale accept is rejected without overwriting; restore yields equal content in a new version', async () => {
    const provider = new ScriptedProviderGateway();
    const harness = await createHarness({ provider });
    try {
      const base = await createTaskAndPlan(harness, provider);
      const reviewed = await commitAndWaitForReview(harness, provider, base, CONTENT_V1);
      const patchId = reviewed.patches[0].patchId;
      const accepted = await acceptPatch(harness, base.taskId, patchId);
      expect(accepted.status).toBe(200);
      const v1 = accepted.body.versionId as string;

      // Second run -> v2
      provider.queuePlanner(plannerOutputFor({ moduleId: base.moduleId, moduleKind: 'json' }));
      const planned2 = await inject(harness, 'POST', `/api/tasks/${base.taskId}/runs`, {
        commandId: uuid(),
        expectedRevision: (await inject(harness, 'GET', `/api/tasks/${base.taskId}/snapshot`)).body.task.revision,
        moduleId: base.moduleId,
        intent: '生成第二版',
        planFirst: true,
      });
      const review2 = await commitAndWaitForReview(
        harness,
        provider,
        { taskId: base.taskId, moduleId: base.moduleId, runId: planned2.body.runId, planVersion: planned2.body.plan.version },
        CONTENT_V2,
      );
      const patch2 = review2.patches.find((p: { patchId: string }) => p.patchId)!.patchId;
      const accepted2 = await acceptPatch(harness, base.taskId, patch2);
      expect(accepted2.status).toBe(200);
      const v2 = accepted2.body.versionId as string;

      // Stale expectedRevision on a third run patch: reject the command, keep both sides.
      provider.queuePlanner(plannerOutputFor({ moduleId: base.moduleId, moduleKind: 'json' }));
      const planned3 = await inject(harness, 'POST', `/api/tasks/${base.taskId}/runs`, {
        commandId: uuid(),
        expectedRevision: (await inject(harness, 'GET', `/api/tasks/${base.taskId}/snapshot`)).body.task.revision,
        moduleId: base.moduleId,
        intent: '生成第三版',
        planFirst: true,
      });
      const review3 = await commitAndWaitForReview(
        harness,
        provider,
        { taskId: base.taskId, moduleId: base.moduleId, runId: planned3.body.runId, planVersion: planned3.body.plan.version },
        { kind: 'json', value: { version: 3 } },
      );
      const patch3 = review3.patches[0].patchId;
      const staleAccept = await inject(harness, 'POST', `/api/patches/${patch3}/accept`, {
        commandId: uuid(),
        expectedRevision: 0, // intentionally stale
        validationReportId: (await inject(harness, 'GET', `/api/patches/${patch3}`)).body.patch.validationReportId,
        acceptMode: 'all',
        sectionIds: [],
        note: '',
      });
      expect(staleAccept.status).toBe(409);
      expect(staleAccept.body.code).toBe('revision_conflict');

      const stateAfterStale = await inject(harness, 'GET', `/api/tasks/${base.taskId}/snapshot`);
      const acceptedNow = stateAfterStale.body.modules[0].acceptance.acceptedVersionId;
      expect(acceptedNow).toBe(v2);

      // Restore v1 -> new version v3 with identical content
      const restore = await inject(harness, 'POST', `/api/artifacts/${stateAfterStale.body.artifact.id}/restore`, {
        commandId: uuid(),
        expectedRevision: stateAfterStale.body.task.revision,
        moduleId: base.moduleId,
        versionId: v1,
        note: '恢复到第一版',
      });
      expect(restore.status).toBe(200);
      const restoredVersionId = restore.body.versionId as string;
      expect(restoredVersionId).not.toBe(v1);

      const versions = await inject(harness, 'GET', `/api/tasks/${base.taskId}/modules/${base.moduleId}/versions`);
      const versionList = versions.body.versions as Array<{ versionId: string; isCurrent: boolean }>;
      expect(versionList.length).toBeGreaterThanOrEqual(3);
      expect(versionList.find((v) => v.versionId === restoredVersionId)?.isCurrent).toBe(true);

      const content = await inject(harness, 'GET', `/api/tasks/${base.taskId}/modules/${base.moduleId}/content`);
      expect(content.body.content).toEqual(CONTENT_V1);
    } finally {
      await harness.close();
    }
  }, 90_000);

  it('rejecting a patch cancels the run and leaves the accepted version untouched', async () => {
    const provider = new ScriptedProviderGateway();
    const harness = await createHarness({ provider });
    try {
      const base = await createTaskAndPlan(harness, provider);
      const reviewed = await commitAndWaitForReview(harness, provider, base, CONTENT_V1);
      const patchId = reviewed.patches[0].patchId;
      const rejected = await inject(harness, 'POST', `/api/patches/${patchId}/reject`, {
        commandId: uuid(),
        expectedRevision: reviewed.task.revision,
        reason: '集成测试拒绝',
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe('rejected');
      const after = await inject(harness, 'GET', `/api/tasks/${base.taskId}/snapshot`);
      expect(after.body.modules[0].module.acceptedVersionId).toBeNull();
      expect(['CANCELLED', 'FAILED']).toContain(after.body.runs[0].state);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('exports and re-imports a task package with identical content hashes and disabled recipes', async () => {
    const provider = new ScriptedProviderGateway();
    const harness = await createHarness({ provider });
    try {
      const base = await createTaskAndPlan(harness, provider);
      const reviewed = await commitAndWaitForReview(harness, provider, base, CONTENT_V1);
      const accepted = await acceptPatch(harness, base.taskId, reviewed.patches[0].patchId);
      expect(accepted.status).toBe(200);

      const exported = await inject(harness, 'POST', `/api/tasks/${base.taskId}/export`, {
        commandId: uuid(),
        format: 'task_package',
        moduleIds: [],
        includeSources: true,
      });
      expect(exported.status).toBe(200);
      expect(exported.body.mime).toBe('application/zip');
      const bytes = Buffer.from(exported.body.contentBase64, 'base64');

      const imported = await inject(harness, 'POST', '/api/imports', {
        commandId: uuid(),
        fileName: 'exported.ca-task.zip',
        contentBase64: bytes.toString('base64'),
      });
      expect(imported.status).toBe(200);
      expect(imported.body.warnings.length).toBeGreaterThanOrEqual(0);
      const importedTaskId = imported.body.taskId as string;

      const importedSnapshot = await inject(harness, 'GET', `/api/tasks/${importedTaskId}/snapshot`);
      expect(importedSnapshot.status).toBe(200);
      const importedModule = importedSnapshot.body.modules[0];
      const originalSnapshot = await inject(harness, 'GET', `/api/tasks/${base.taskId}/snapshot`);
      expect(importedModule.acceptance.acceptedContentHash).toBe(originalSnapshot.body.modules[0].acceptance.acceptedContentHash);
      expect(importedModule.acceptedContent).toEqual(CONTENT_V1);
      // Imported results are marked stale until sources/validation are rebound.
      expect(importedModule.module.status).toBe('stale');

      const importedContent = await inject(harness, 'GET', `/api/tasks/${importedTaskId}/modules/${importedModule.module.id}/content`);
      expect(importedContent.body.content).toEqual(CONTENT_V1);
    } finally {
      await harness.close();
    }
  }, 90_000);
});
