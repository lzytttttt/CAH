import { describe, expect, it } from 'vitest';
import { createHarness, waitFor, type TestHarness } from './helpers';
import { startFakeOpenAiServer, type FakeOpenAiServer } from './fakes/fake-openai-server';
import { plannerOutputFor } from './fakes/scripted-provider';

const uuid = (): string => crypto.randomUUID();
const CANDIDATE = { kind: 'json' as const, value: { summary: '本地假服务生成成果', items: ['a', 'b'] } };

async function inject(harness: TestHarness, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await harness.app.inject({ method, url, headers: harness.headers, payload: payload as never });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/**
 * Proves the REAL provider path end-to-end without credentials: server route ->
 * LiveProviderGateway -> @ca/providers OpenAI-compatible adapter -> HTTP SSE ->
 * harness kernel -> tools -> storage -> review -> accept.
 */
describe('live provider path against a local OpenAI-compatible server', () => {
  let fake: FakeOpenAiServer | null = null;
  let harness: TestHarness | null = null;

  it('creates a profile, tests the capability, then runs a real task through the adapter', async () => {
    process.env.CA_IT_FAKE_KEY = 'sk-local-fake-key';
    fake = await startFakeOpenAiServer({ moduleId: '', plannerJson: '{}', candidateJson: JSON.stringify(CANDIDATE) });
    harness = await createHarness({ useRealProviders: true });
    try {
      const h = harness;
      // 1) Save a live profile pointing at the local server.
      const profileRes = await inject(h, 'POST', '/api/provider-profiles', {
        commandId: uuid(),
        profileName: '本地假服务',
        adapterType: 'openai_compatible',
        baseURL: fake.baseURL,
        model: 'fake-model',
        credentialRef: 'CA_IT_FAKE_KEY',
        enabled: true,
      });
      expect(profileRes.status).toBe(200);
      expect(profileRes.body.profile.credentialConfigured).toBe(true);
      expect(profileRes.body.profile.credentialRef).toBeUndefined();
      expect(JSON.stringify(profileRes.body)).not.toContain('sk-local-fake-key');
      const profileId = profileRes.body.profileId as string;

      // 2) Capability test (auth + text) through the real adapter.
      const testRes = await inject(h, 'POST', `/api/provider-profiles/${profileId}/test`, {
        commandId: uuid(),
        probes: ['auth_and_text'],
        confirmCharges: true,
      });
      expect(testRes.status).toBe(200);
      expect(testRes.body.report.probes[0].status).toBe('verified');

      // 3) Create a task and plan through the real adapter.
      const created = await inject(h, 'POST', '/api/tasks', {
        commandId: uuid(),
        title: '真实适配器路径任务',
        intent: '验证适配器到内核的完整链路',
        artifactTitle: '适配器交付物',
        modules: [{ key: 'main', title: '主成果', kind: 'json', order: 0, dependsOnKeys: [], acceptanceCriteria: [] }],
      });
      const taskId = created.body.taskId as string;
      const moduleId = created.body.moduleIds[0] as string;
      fake.config.moduleId = moduleId;
      fake.config.plannerJson = JSON.stringify(plannerOutputFor({ moduleId, moduleKind: 'json', goal: '本地假服务计划' }));

      const planned = await inject(h, 'POST', `/api/tasks/${taskId}/runs`, {
        commandId: uuid(),
        expectedRevision: created.body.revision,
        moduleId,
        intent: '按计划生成 JSON 成果',
        planFirst: true,
      });
      expect(planned.status).toBe(200);
      expect(planned.body.state).toBe('READY');
      expect(planned.body.plan.goal).toBe('本地假服务计划');

      const detail = await inject(h, 'GET', `/api/runs/${planned.body.runId}`);
      const snapshot = await inject(h, 'GET', `/api/tasks/${taskId}/snapshot`);
      const commit = await inject(h, 'POST', `/api/runs/${planned.body.runId}/commit`, {
        commandId: uuid(),
        expectedRevision: snapshot.body.task.revision,
        planVersion: planned.body.plan.version,
        contextSnapshotId: detail.body.run.contextSnapshotId,
      });
      expect(commit.status).toBe(200);

      const reviewed = await waitFor(
        async () => {
          const res = await inject(h, 'GET', `/api/tasks/${taskId}/snapshot`);
          const snap = res.body;
          return ['AWAITING_REVIEW', 'FAILED', 'CANCELLED', 'AWAITING_INPUT'].includes(snap.activeRun?.state) ? snap : null;
        },
        { timeoutMs: 20_000, label: 'live-path run reaches review' },
      );
      expect(reviewed.activeRun.state).toBe('AWAITING_REVIEW');
      const patchId = reviewed.patches[0].patchId;
      const review = await inject(h, 'GET', `/api/patches/${patchId}`);
      expect(review.body.patch.candidate).toEqual(CANDIDATE);

      const reviewSnapshot = await inject(h, 'GET', `/api/tasks/${taskId}/snapshot`);
      const accepted = await inject(h, 'POST', `/api/patches/${patchId}/accept`, {
        commandId: uuid(),
        expectedRevision: reviewSnapshot.body.task.revision,
        validationReportId: review.body.patch.validationReportId,
        acceptMode: 'all',
        sectionIds: [],
        note: '',
      });
      expect(accepted.status).toBe(200);

      const finalSnapshot = await inject(h, 'GET', `/api/tasks/${taskId}/snapshot`);
      expect(finalSnapshot.body.modules[0].module.status).toBe('accepted');
      const content = await inject(h, 'GET', `/api/tasks/${taskId}/modules/${moduleId}/content`);
      expect(content.body.content).toEqual(CANDIDATE);

      // Real adapter path: planner + executor + tool round happened over HTTP SSE.
      expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    } finally {
      await harness.close();
      harness = null;
      await fake.close();
      fake = null;
      delete process.env.CA_IT_FAKE_KEY;
    }
  }, 90_000);
});
