import { describe, expect, it } from 'vitest';
import { newUuid as uuid, type HarnessEvent } from '@ca/contracts';
import {
  candidateEnvelope,
  commitRun,
  createFixture,
  latestPatch,
  latestReport,
  markdownCandidate,
  planToReady,
  validPlannerOutput,
} from './fixtures';
import { toolCallEvents } from './fakes/fake-provider';
import { sleep } from '../src/hashing';

const CANDIDATE = markdownCandidate([{ id: 's', title: 'S', markdown: '控制命令测试正文。' }]);

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await sleep(2);
  }
}

describe('command guards and control semantics', () => {
  it('honors a pause request received while planning: plan completes, then the run pauses at READY', async () => {
    const fixture = await createFixture({ modules: [{ title: '规划暂停模块', kind: 'markdown' }] });
    try {
      const moduleId = fixture.modules[0]!.id;
      fixture.provider.enqueueHandler(async () => {
        await sleep(25);
        const text = JSON.stringify(validPlannerOutput({ moduleId: moduleId as string, moduleKind: 'markdown' }));
        const events: HarnessEvent[] = [];
        void events;
        return [
          { type: 'text_delta', text },
          { type: 'finish', reason: 'stop' },
        ];
      });
      const planPromise = fixture.engine.plan({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId,
        intent: fixture.task.intent,
        planFirst: true,
        actor: 'user',
      });
      await waitFor(async () => {
        const runs = await fixture.storage.listRuns(fixture.task.id);
        return runs.length === 1 && runs[0]!.state === 'PLANNING';
      });
      const running = (await fixture.storage.listRuns(fixture.task.id))[0]!;
      await fixture.engine.pause({
        commandId: uuid() as never,
        runId: running.id,
        expectedRevision: await fixture.taskRevision(),
        actor: 'user',
      });
      const handle = await planPromise;
      expect(handle.state).toBe('PAUSED');
      const run = await fixture.storage.getRun(handle.runId);
      expect(run!.state).toBe('PAUSED');
      expect(run!.returnState).toBe('READY');
      expect(fixture.eventTypes()).toContain('run.pause_requested');
      expect(fixture.eventTypes()).toContain('run.paused');
      expect(handle.plan).not.toBeNull();
      // Resume returns to READY (the plan was never committed).
      const resumed = await fixture.engine.resume({
        commandId: uuid() as never,
        runId: handle.runId as never,
        expectedRevision: await fixture.taskRevision(),
        actor: 'user',
      });
      expect(resumed.state).toBe('READY');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('cancels a run while planning and ends it as CANCELLED without a plan', async () => {
    const fixture = await createFixture({ modules: [{ title: '规划取消模块', kind: 'markdown' }] });
    try {
      const moduleId = fixture.modules[0]!.id;
      fixture.provider.enqueueHandler(async () => {
        await sleep(30);
        return [
          { type: 'text_delta', text: JSON.stringify(validPlannerOutput({ moduleId: moduleId as string, moduleKind: 'markdown' })) },
          { type: 'finish', reason: 'stop' },
        ];
      });
      const planPromise = fixture.engine.plan({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId,
        intent: fixture.task.intent,
        planFirst: true,
        actor: 'user',
      });
      await waitFor(async () => {
        const runs = await fixture.storage.listRuns(fixture.task.id);
        return runs.length === 1 && runs[0]!.state === 'PLANNING';
      });
      const running = (await fixture.storage.listRuns(fixture.task.id))[0]!;
      await fixture.engine.cancel({
        commandId: uuid() as never,
        runId: running.id,
        expectedRevision: await fixture.taskRevision(),
        reason: '规划阶段取消',
        actor: 'user',
      });
      const handle = await planPromise;
      expect(handle.state).toBe('CANCELLED');
      const run = await fixture.storage.getRun(running.id);
      expect(run!.state).toBe('CANCELLED');
      expect(fixture.eventTypes()).toContain('run.cancelled');
      expect(fixture.finished).toHaveLength(1);
      expect(handle.plan).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('rejects illegal transitions: commit twice, pause a completed run, cancel a completed run', async () => {
    const fixture = await createFixture({ modules: [{ title: '非法转换模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      await commitRun(fixture, ready.runId);
      await expect(
        fixture.engine.commit({
          commandId: uuid() as never,
          runId: ready.runId as never,
          expectedRevision: await fixture.taskRevision(),
          planVersion: ready.planVersion,
          contextSnapshotId: (await fixture.storage.getRun(ready.runId))!.contextSnapshotId as string,
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'state_not_allowed' });
      await fixture.engine.waitForIdle();
      const patch = await latestPatch(fixture);
      const report = await latestReport(fixture, patch!);
      await fixture.engine.accept({
        commandId: uuid() as never,
        patchId: patch!.id,
        expectedRevision: await fixture.taskRevision(),
        validationReportId: report!.id,
        acceptMode: 'all',
        sectionIds: [],
        note: '',
        actor: 'user',
      });
      const completed = await fixture.storage.getRun(ready.runId);
      expect(completed!.state).toBe('COMPLETED');
      await expect(
        fixture.engine.pause({
          commandId: uuid() as never,
          runId: ready.runId as never,
          expectedRevision: await fixture.taskRevision(),
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'state_not_allowed' });
      await expect(
        fixture.engine.cancel({
          commandId: uuid() as never,
          runId: ready.runId as never,
          expectedRevision: await fixture.taskRevision(),
          reason: '试图取消已完成运行',
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'state_not_allowed' });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('is idempotent by commandId for accept(): a retry returns the same version and writes nothing new', async () => {
    const fixture = await createFixture({ modules: [{ title: '幂等接受模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const patch = await latestPatch(fixture);
      const report = await latestReport(fixture, patch!);
      const command = {
        commandId: uuid() as never,
        patchId: patch!.id,
        expectedRevision: await fixture.taskRevision(),
        validationReportId: report!.id,
        acceptMode: 'all' as const,
        sectionIds: [],
        note: '接受',
        actor: 'user',
      };
      const first = await fixture.engine.accept(command);
      const second = await fixture.engine.accept(command);
      expect(second.versionId).toBe(first.versionId);
      expect(await fixture.storage.listVersions(fixture.modules[0]!.id)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('enforces the committed plan tool allow-list: tools outside the plan are denied before execution', async () => {
    const fixture = await createFixture({ modules: [{ title: '允许清单模块', kind: 'markdown' }] });
    try {
      const moduleId = fixture.modules[0]!.id;
      const plan = validPlannerOutput({ moduleId: moduleId as string, moduleKind: 'markdown' });
      // Only the proposal tool is declared; source tools are not in the plan.
      plan.tools = [{ toolId: 'artifact.propose_patch', reason: '产出候选成果', effect: 'draft_write' }];
      const ready = await planToReady(fixture, plan);
      fixture.provider.enqueue(toolCallEvents('source.list', {}));
      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      expect(fixture.tools.calls.some((call) => call.toolId === 'source.list')).toBe(false);
      const failed = fixture.findEvents('tool.failed');
      expect(
        failed.some((event) => (event.payload as { error: { code: string } }).error.code === 'tool_not_allowed'),
      ).toBe(true);
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_REVIEW');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('resume on a non-paused run and startRun on a paused run are rejected with state_not_allowed', async () => {
    const fixture = await createFixture({ modules: [{ title: '恢复守卫模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      await expect(
        fixture.engine.resume({
          commandId: uuid() as never,
          runId: ready.runId as never,
          expectedRevision: await fixture.taskRevision(),
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'state_not_allowed' });
      await fixture.engine.pause({
        commandId: uuid() as never,
        runId: ready.runId as never,
        expectedRevision: await fixture.taskRevision(),
        actor: 'user',
      });
      await expect(fixture.engine.startRun(ready.runId as never)).rejects.toMatchObject({ code: 'state_not_allowed' });
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('PAUSED');
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
