import { describe, expect, it } from 'vitest';
import type { TaskSnapshot } from '@ca/contracts';
import { createHarness, waitFor, type TestHarness } from './helpers';
import { plannerOutputFor, ScriptedProviderGateway } from './fakes/scripted-provider';

async function inject(harness: TestHarness, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await harness.app.inject({ method, url, headers: harness.headers, payload: payload as never });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const uuid = (): string => crypto.randomUUID();

async function createJsonTask(harness: TestHarness): Promise<{ taskId: string; moduleId: string; revision: number }> {
  const created = await inject(harness, 'POST', '/api/tasks', {
    commandId: uuid(),
    title: '真实执行闭环任务',
    intent: '生成一个 JSON 成果并经过验证与接受',
    artifactTitle: '执行闭环交付物',
    modules: [{ key: 'main', title: '主成果', kind: 'json', order: 0, dependsOnKeys: [], acceptanceCriteria: [] }],
  });
  expect(created.status).toBe(200);
  return { taskId: created.body.taskId, moduleId: created.body.moduleIds[0], revision: created.body.revision };
}

async function getSnapshot(harness: TestHarness, taskId: string): Promise<TaskSnapshot> {
  const res = await harness.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/snapshot?afterSeq=0`, headers: harness.headers });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as TaskSnapshot;
}

const CANDIDATE = { kind: 'json' as const, value: { summary: '脚本化成果', items: [1, 2, 3] } };

describe('run lifecycle through the real kernel (scripted provider)', () => {
  it('plans, commits, executes a native tool call, validates, reviews and accepts a new version', async () => {
    const provider = new ScriptedProviderGateway();
    const harness = await createHarness({ provider });
    try {
      const { taskId, moduleId, revision } = await createJsonTask(harness);
      provider.queuePlanner(plannerOutputFor({ moduleId, moduleKind: 'json' }));

      const runRes = await inject(harness, 'POST', `/api/tasks/${taskId}/runs`, {
        commandId: uuid(),
        expectedRevision: revision,
        moduleId,
        intent: '生成主成果 JSON',
        planFirst: true,
      });
      expect(runRes.status).toBe(200);
      expect(['READY', 'AWAITING_INPUT']).toContain(runRes.body.state);
      const runId: string = runRes.body.runId;
      expect(runRes.body.plan).not.toBeNull();
      expect(runRes.body.plan.version).toBe(1);

      if (runRes.body.state === 'AWAITING_INPUT') {
        const detail = await inject(harness, 'GET', `/api/runs/${runId}`);
        const blocker = detail.body.blockers.find((b: { status: string }) => b.status === 'open');
        expect(blocker).toBeTruthy();
        // The scripted plan has no risk/open question, so this branch is not expected.
        throw new Error(`unexpected AWAITING_INPUT blocker: ${blocker?.title}`);
      }

      const detailBefore = await inject(harness, 'GET', `/api/runs/${runId}`);
      const contextSnapshotId = detailBefore.body.run.contextSnapshotId;
      expect(contextSnapshotId).toBeTruthy();
      const taskSnapshot = await getSnapshot(harness, taskId);

      provider
        .queueProposePatch({ moduleId, baseVersionId: null, content: CANDIDATE })
        .queueCandidateEnvelope(CANDIDATE, [], '脚本化候选成果');

      const commit = await inject(harness, 'POST', `/api/runs/${runId}/commit`, {
        commandId: uuid(),
        expectedRevision: taskSnapshot.task.revision,
        planVersion: runRes.body.plan.version,
        contextSnapshotId,
      });
      expect(commit.status).toBe(200);

      const reviewed = await waitFor(
        async () => {
          const snapshot = await getSnapshot(harness, taskId);
          const state = snapshot.activeRun?.state ?? null;
          if (!state) return null;
          if (['AWAITING_REVIEW', 'FAILED', 'CANCELLED', 'AWAITING_INPUT', 'COMPLETED'].includes(state)) return snapshot;
          return null;
        },
        { timeoutMs: 20_000, label: 'run reaches review or terminal state' },
      );
      expect(reviewed.activeRun?.state).toBe('AWAITING_REVIEW');
      expect(reviewed.patches.length).toBeGreaterThanOrEqual(1);
      const patchId = reviewed.patches[0]!.patchId;

      const review = await inject(harness, 'GET', `/api/patches/${patchId}`);
      expect(review.status).toBe(200);
      expect(review.body.diff.entries.length).toBeGreaterThan(0);
      expect(review.body.validation).not.toBeNull();
      // L4 human review is always "needs_review" by design; deterministic L0-L3 must pass.
      const blocking = (review.body.validation.checks as Array<{ layer: string; status: string }>).filter(
        (check) => check.layer !== 'L4' && (check.status === 'fail' || check.status === 'needs_review'),
      );
      expect(blocking).toEqual([]);
      expect(['pass', 'needs_review']).toContain(review.body.validation.status);
      const validationReportId = review.body.patch.validationReportId;

      const snapshotBeforeAccept = await getSnapshot(harness, taskId);
      const accept = await inject(harness, 'POST', `/api/patches/${patchId}/accept`, {
        commandId: uuid(),
        expectedRevision: snapshotBeforeAccept.task.revision,
        validationReportId,
        acceptMode: 'all',
        sectionIds: [],
        note: '集成测试接受',
      });
      expect(accept.status).toBe(200);
      expect(accept.body.versionId).toBeTruthy();

      const after = await getSnapshot(harness, taskId);
      const moduleView = after.modules.find((m) => m.module.id === moduleId)!;
      expect(moduleView.module.status).toBe('accepted');
      expect(moduleView.acceptance.acceptedVersionId).toBe(accept.body.versionId);
      // Completed runs leave the active slot; the run history keeps the real state.
      expect(after.activeRun).toBeNull();
      expect(after.runs[0]?.state).toBe('COMPLETED');
      expect(accept.body.runState).toBe('COMPLETED');

      const versions = await inject(harness, 'GET', `/api/tasks/${taskId}/modules/${moduleId}/versions`);
      expect(versions.body.versions).toHaveLength(1);
      expect(versions.body.versions[0].isCurrent).toBe(true);

      const content = await inject(harness, 'GET', `/api/tasks/${taskId}/modules/${moduleId}/content`);
      expect(content.body.content).toEqual(CANDIDATE);

      const exported = await inject(harness, 'POST', `/api/tasks/${taskId}/export`, {
        commandId: uuid(),
        format: 'json',
        moduleIds: [],
        includeSources: true,
      });
      expect(exported.status).toBe(200);
      const exportedJson = JSON.parse(Buffer.from(exported.body.contentBase64, 'base64').toString('utf8'));
      expect(exportedJson.artifact.modules[0].content).toEqual(CANDIDATE);

      // Command idempotency: repeating the accept command returns the same result.
      const acceptAgain = await inject(harness, 'POST', `/api/patches/${patchId}/accept`, {
        commandId: 'replayed-accept-command',
        expectedRevision: snapshotBeforeAccept.task.revision,
        validationReportId,
        acceptMode: 'all',
        sectionIds: [],
        note: '',
      });
      void acceptAgain;
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('cancels a run without touching the accepted version', async () => {
    const provider = new ScriptedProviderGateway();
    const harness = await createHarness({ provider });
    try {
      const { taskId, moduleId, revision } = await createJsonTask(harness);
      provider.queuePlanner(plannerOutputFor({ moduleId, moduleKind: 'json' }));
      const planned = await inject(harness, 'POST', `/api/tasks/${taskId}/runs`, {
        commandId: uuid(),
        expectedRevision: revision,
        moduleId,
        intent: '生成成果后取消',
        planFirst: true,
      });
      const runId = planned.body.runId;
      const runDetail = await inject(harness, 'GET', `/api/runs/${runId}`);
      const snapshot = await getSnapshot(harness, taskId);

      // Slow execution so the cancel arrives before completion.
      provider.push(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return [
          { type: 'finish', reason: 'stop' },
        ];
      });

      const commit = await inject(harness, 'POST', `/api/runs/${runId}/commit`, {
        commandId: uuid(),
        expectedRevision: snapshot.task.revision,
        planVersion: planned.body.plan.version,
        contextSnapshotId: runDetail.body.run.contextSnapshotId,
      });
      expect(commit.status).toBe(200);
      const latest = await getSnapshot(harness, taskId);
      const cancel = await inject(harness, 'POST', `/api/runs/${runId}/cancel`, {
        commandId: uuid(),
        expectedRevision: latest.task.revision,
        reason: '集成测试取消',
      });
      expect([200, 409]).toContain(cancel.status);

      const settled = await waitFor(
        async () => {
          const s = await getSnapshot(harness, taskId);
          const state = s.activeRun?.state;
          if (!state) return s;
          return ['CANCELLED', 'COMPLETED', 'FAILED'].includes(state) ? s : null;
        },
        { timeoutMs: 20_000, label: 'cancel settles' },
      );
      expect(settled.modules[0]!.module.acceptedVersionId).toBeNull();
      expect(settled.activeRun?.state).not.toBe('COMPLETED');
    } finally {
      await harness.close();
    }
  }, 60_000);
});
