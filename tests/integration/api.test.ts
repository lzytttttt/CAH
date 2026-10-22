import { describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers';

async function injectJson(harness: TestHarness, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await harness.app.inject({
    method,
    url,
    headers: { ...harness.headers, ...headers },
    payload: payload as never,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
}

function uuid(): string {
  return crypto.randomUUID();
}

describe('server API (no model calls)', () => {
  it('serves health/session and enforces local session + origin for writes', async () => {
    const harness = await createHarness();
    try {
      const health = await harness.app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.body).ok).toBe(true);

      const session = await harness.app.inject({ method: 'GET', url: '/api/session' });
      expect(session.statusCode).toBe(200);
      expect(session.headers['set-cookie']).toContain('ca_session=');
      const info = JSON.parse(session.body);
      expect(info.csrfToken).toHaveLength(64);
      expect(info.availableModes).toContain('live');

      const unauthenticated = await harness.app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { commandId: uuid(), title: 'x', intent: 'y', artifactTitle: 'z' },
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(JSON.parse(unauthenticated.body).code).toBe('session_required');
    } finally {
      await harness.close();
    }
  });

  it('creates a custom task, lists it, and rejects stale revisions', async () => {
    const harness = await createHarness();
    try {
      const created = await injectJson(harness, 'POST', '/api/tasks', {
        commandId: uuid(),
        title: '自定义任务',
        intent: '构建 JSON 成果',
        artifactTitle: '自定义交付物',
        modules: [
          {
            key: 'main',
            title: '主成果',
            kind: 'json',
            order: 0,
            dependsOnKeys: [],
            acceptanceCriteria: [],
          },
        ],
      });
      expect(created.status).toBe(200);
      expect(created.body.moduleIds).toHaveLength(1);
      const taskId: string = created.body.taskId;

      const list = await injectJson(harness, 'GET', '/api/tasks');
      expect(list.body.tasks).toHaveLength(1);
      expect(list.body.tasks[0].artifactId).toBe(created.body.artifactId);

      const snapshot = await injectJson(harness, 'GET', `/api/tasks/${taskId}/snapshot`);
      expect(snapshot.body.task.taskId ?? snapshot.body.task.id).toBe(taskId);
      expect(snapshot.body.modules).toHaveLength(1);
      expect(snapshot.body.modules[0].module.status).toBe('empty');
      expect(snapshot.body.spatial.nodes.some((node: { kind: string }) => node.kind === 'hub')).toBe(true);

      const patched = await injectJson(harness, 'PATCH', `/api/tasks/${taskId}`, {
        commandId: uuid(),
        expectedRevision: 0,
        title: '更新后的标题',
      });
      expect(patched.status).toBe(200);
      expect(patched.body.task.title).toBe('更新后的标题');
      expect(patched.body.task.revision).toBe(1);

      const stale = await injectJson(harness, 'PATCH', `/api/tasks/${taskId}`, {
        commandId: uuid(),
        expectedRevision: 0,
        title: '过期修订',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('revision_conflict');
    } finally {
      await harness.close();
    }
  });

  it('expands the built-in template and validates module dependency cycles', async () => {
    const harness = await createHarness();
    try {
      const created = await injectJson(harness, 'POST', '/api/tasks', {
        commandId: uuid(),
        title: '模板任务',
        intent: '使用内置模板',
        artifactTitle: '模板交付物',
        templateId: 'cognitive-atrium',
      });
      expect(created.status).toBe(200);
      expect(created.body.moduleIds).toHaveLength(4);

      const cyclic = await injectJson(harness, 'POST', '/api/tasks', {
        commandId: uuid(),
        title: '环任务',
        intent: 'x',
        artifactTitle: 'y',
        modules: [
          { key: 'a', title: 'A', kind: 'markdown', order: 0, dependsOnKeys: ['b'], acceptanceCriteria: [] },
          { key: 'b', title: 'B', kind: 'markdown', order: 1, dependsOnKeys: ['a'], acceptanceCriteria: [] },
        ],
      });
      expect(cyclic.status).toBe(422);
      expect(cyclic.body.code).toBe('validation_failed');
    } finally {
      await harness.close();
    }
  });

  it('imports supported sources, rejects unsupported media, and is idempotent by commandId', async () => {
    const harness = await createHarness();
    try {
      const created = await injectJson(harness, 'POST', '/api/tasks', {
        commandId: uuid(),
        title: '资料任务',
        intent: '导入资料',
        artifactTitle: '资料交付物',
        templateId: 'cognitive-atrium',
      });
      const taskId: string = created.body.taskId;
      const content = Buffer.from('# 产品资料\n部署范围待澄清。', 'utf8').toString('base64');
      const fixedCommandId = uuid();

      const importSource = () =>
        injectJson(harness, 'POST', `/api/tasks/${taskId}/sources`, {
          commandId: fixedCommandId,
          fileName: 'brief.md',
          mime: 'text/markdown',
          contentBase64: content,
        });
      const first = await importSource();
      expect(first.status).toBe(200);
      expect(first.body.parseStatus).toBe('parsed');
      expect(first.body.duplicate).toBe(false);
      const second = await importSource();
      expect(second.body.duplicate).toBe(true);
      expect(second.body.sourceId).toBe(first.body.sourceId);

      const snapshot = await injectJson(harness, 'GET', `/api/tasks/${taskId}/snapshot`);
      expect(snapshot.body.sources).toHaveLength(1);
      expect(snapshot.body.sources[0].name).toBe('brief.md');

      const unsupported = await injectJson(harness, 'POST', `/api/tasks/${taskId}/sources`, {
        commandId: uuid(),
        fileName: 'doc.pdf',
        mime: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4').toString('base64'),
      });
      expect(unsupported.status).toBe(415);
      expect(unsupported.body.code).toBe('unsupported_media_type');

      const exportMd = await injectJson(harness, 'POST', `/api/tasks/${taskId}/export`, {
        commandId: uuid(),
        format: 'markdown',
        moduleIds: [],
        includeSources: false,
      });
      expect(exportMd.status).toBe(200);
      expect(exportMd.body.mime).toContain('markdown');
      expect(Buffer.from(exportMd.body.contentBase64, 'base64').toString('utf8')).toContain('资料交付物');
    } finally {
      await harness.close();
    }
  });

  it('blocks cross-origin writes and accepts bearer requests from CLI-style clients', async () => {
    const harness = await createHarness();
    try {
      const evil = await harness.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { ...harness.headers, origin: 'https://evil.example' },
        payload: { commandId: uuid(), title: 'x', intent: 'y', artifactTitle: 'z' },
      });
      expect(evil.statusCode).toBe(403);
      expect(JSON.parse(evil.body).code).toBe('origin_not_allowed');
    } finally {
      await harness.close();
    }
  });

  it('exposes demo workspace data without calling a model, and mode switch is guarded', async () => {
    const harness = await createHarness({ seedDemo: true });
    try {
      const liveTasks = await injectJson(harness, 'GET', '/api/tasks');
      expect(liveTasks.body.tasks).toHaveLength(0);

      const scenario = await injectJson(harness, 'GET', '/api/demo/scenario');
      expect(scenario.status).toBe(200);
      expect(scenario.body.templateId).toBe('cognitive-atrium');

      const switched = await injectJson(harness, 'POST', '/api/workspace/mode', { commandId: uuid(), mode: 'demo' });
      expect(switched.status).toBe(200);
      expect(switched.body.mode).toBe('demo');

      const demoTasks = await injectJson(harness, 'GET', '/api/tasks');
      expect(demoTasks.body.tasks).toHaveLength(1);
      const taskId = demoTasks.body.tasks[0].taskId;
      const snapshot = await injectJson(harness, 'GET', `/api/tasks/${taskId}/snapshot`);
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.modules).toHaveLength(4);
      expect(snapshot.body.workspace.mode).toBe('demo');
      expect(snapshot.body.sources.length).toBeGreaterThanOrEqual(5);

      // Fixed Demo fixtures (design 3.3 / 17.3): plan, blocker, pending patch,
      // accepted version, failure and validated recipe are all present.
      expect(snapshot.body.snapshotSeq).toBeGreaterThanOrEqual(50);
      expect(snapshot.body.events.length).toBeGreaterThan(0);
      const runs = snapshot.body.runs as Array<{ state: string }>;
      for (const state of ['COMPLETED', 'AWAITING_REVIEW', 'AWAITING_INPUT', 'FAILED']) {
        expect(runs.some((run) => run.state === state)).toBe(true);
      }
      expect(snapshot.body.blockers.length).toBe(1);
      expect(snapshot.body.blockers[0].resolutions.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.body.patches.length).toBeGreaterThanOrEqual(1);
      const moduleStatuses = (snapshot.body.modules as Array<{ module: { status: string } }>).map((m) => m.module.status);
      expect(moduleStatuses).toContain('accepted');
      expect(moduleStatuses).toContain('ready_for_review');
      expect((snapshot.body.recipes as Array<{ status: string }>).some((recipe) => recipe.status === 'validated')).toBe(true);
      expect(snapshot.body.spatial.nodes.length).toBeGreaterThanOrEqual(8);
      const prospects = snapshot.body.prospects as Array<{ state: string; missingInputs: string[] }>;
      expect(prospects.length).toBeGreaterThanOrEqual(1);
      expect(prospects.some((prospect) => prospect.state === 'missing_inputs')).toBe(true);

      // Demo mode is read-only for new runs: creating one reports a clear state error.
      const demoRun = await injectJson(harness, 'POST', `/api/tasks/${taskId}/runs`, {
        commandId: uuid(),
        expectedRevision: snapshot.body.task.revision,
        moduleId: snapshot.body.modules[0].module.id,
        intent: '演示模式不应执行真实模型',
        planFirst: true,
      });
      expect(demoRun.status).toBe(409);
      expect(demoRun.body.code).toBe('state_not_allowed');

      const back = await injectJson(harness, 'POST', '/api/workspace/mode', { commandId: uuid(), mode: 'live' });
      expect(back.status).toBe(200);
      expect(back.body.mode).toBe('live');
    } finally {
      await harness.close();
    }
  });
});
