import { describe, expect, it } from 'vitest';
import { newUuid as uuid } from '@ca/contracts';
import {
  candidateEnvelope,
  commitRun,
  createFixture,
  latestPatch,
  markdownCandidate,
  planToReady,
  validPlannerOutput,
} from './fixtures';
import { toolCallEvents } from './fakes/fake-provider';
import { sleep } from '../src/hashing';

const CANDIDATE = markdownCandidate([
  { id: 'body', title: '正文', markdown: '执行循环测试正文，不编造事实。' },
]);

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await sleep(2);
  }
}

async function startRunWithCandidate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  candidate = CANDIDATE,
): Promise<{ runId: string; patchId: string | null }> {
  const ready = await planToReady(fixture);
  fixture.provider.enqueueText(candidateEnvelope(candidate));
  await commitRun(fixture, ready.runId);
  await fixture.engine.waitForIdle();
  const detail = await fixture.engine.getRunDetail(ready.runId as never);
  const patch = await latestPatch(fixture);
  return { runId: ready.runId, patchId: patch?.id ?? null };
}

describe('execution loop', () => {
  it('never executes invalid tool arguments; the run can still finish through the JSON fallback', async () => {
    const fixture = await createFixture({ modules: [{ title: '参数校验模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      // Round 1: artifact.propose_patch with invalid arguments (missing operations).
      fixture.provider.enqueue(
        toolCallEvents('artifact.propose_patch', {
          moduleId: fixture.modules[0]!.id as string,
          description: '缺少操作',
        }),
      );
      // Round 2: plain JSON candidate envelope.
      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      expect(fixture.tools.calls.filter((call) => call.toolId === 'artifact.propose_patch')).toHaveLength(0);
      expect(fixture.eventTypes()).toContain('tool.failed');
      const failedTool = fixture.findEvents('tool.failed')[0]!;
      expect((failedTool.payload as { error: { code: string } }).error.code).toBe('invalid_arguments');
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_REVIEW');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('never executes unregistered tools and stops after the same failure signature twice', async () => {
    const fixture = await createFixture({ modules: [{ title: '未知工具模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueue(toolCallEvents('shell.exec', { command: 'rm -rf /' }));
      fixture.provider.enqueue(toolCallEvents('shell.exec', { command: 'rm -rf /' }));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      expect(fixture.tools.calls).toHaveLength(0);
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_INPUT');
      expect(detail!.blockers.some((blocker) => blocker.type === 'no_progress')).toBe(true);
      expect(fixture.eventTypes()).toContain('blocker.detected');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('pauses with an explicit budget explanation when the model request budget is exhausted, then resumes as a new attempt', async () => {
    const fixture = await createFixture({
      modules: [{ title: '预算模块', kind: 'markdown' }],
      budget: { maxModelRequests: 2 },
    });
    try {
      // Planning uses request #1; the first execution round uses #2 and then the
      // executor must pause instead of exceeding the budget.
      const ready = await planToReady(fixture);
      fixture.provider.enqueue(toolCallEvents('source.list', {}));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      let run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('PAUSED');
      expect(run!.returnState).toBe('RUNNING');
      const exhausted = fixture.findEvents('budget.exhausted');
      expect(exhausted).toHaveLength(1);
      expect((exhausted[0]!.payload as { resource: string }).resource).toBe('model_requests');
      const paused = fixture.findEvents('run.paused');
      expect(paused).toHaveLength(1);

      // The user explicitly raises the budget (kernel never does this itself).
      run = await fixture.storage.getRun(ready.runId);
      await fixture.storage.updateRun(
        { ...run!, budgetPolicy: { ...run!.budgetPolicy, maxModelRequests: 6 } },
        run!.revision,
      );
      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      const resumed = await fixture.engine.resume({
        commandId: uuid() as never,
        runId: ready.runId as never,
        expectedRevision: await fixture.taskRevision(),
        actor: 'user',
      });
      expect(resumed.state).toBe('RUNNING');
      await fixture.engine.waitForIdle();
      const after = await fixture.storage.getRun(ready.runId);
      expect(after!.state).toBe('AWAITING_REVIEW');
      expect(after!.attempt).toBe(2);
      const resumedEvent = fixture.findEvents('run.resumed').at(-1)!;
      expect((resumedEvent.payload as { resumeMode: string }).resumeMode).toBe('new_attempt');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('pauses when the tool-call budget is exhausted and preserves the current checkpoint', async () => {
    const fixture = await createFixture({
      modules: [{ title: '工具预算模块', kind: 'markdown' }],
      sources: [{ name: 'note.md', text: '资料第一行\n资料第二行' }],
      budget: { maxToolCalls: 1 },
    });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueue(toolCallEvents('source.list', {}));
      fixture.provider.enqueue(toolCallEvents('source.read', { sourceId: fixture.sources[0]!.id, version: 1, maxChars: 100 }));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('PAUSED');
      expect(run!.budgetUsage.toolCalls).toBe(1);
      const exhausted = fixture.findEvents('budget.exhausted');
      expect(exhausted).toHaveLength(1);
      expect((exhausted[0]!.payload as { resource: string }).resource).toBe('tool_calls');
      expect(run!.checkpointId).not.toBeNull();
      const checkpoint = await fixture.storage.getCheckpoint(run!.checkpointId!);
      expect(checkpoint).not.toBeNull();
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('pauses at a safe boundary, keeps the checkpoint, and resumes from it with a new attempt', async () => {
    const fixture = await createFixture({ modules: [{ title: '暂停模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueAbortable();
      await commitRun(fixture, ready.runId);
      await waitFor(() => fixture.provider.requests.length >= 2);
      await fixture.engine.pause({
        commandId: uuid() as never,
        runId: ready.runId as never,
        expectedRevision: await fixture.taskRevision(),
        actor: 'user',
      });
      await fixture.engine.waitForIdle();
      let run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('PAUSED');
      expect(run!.returnState).toBe('RUNNING');
      expect(run!.checkpointId).not.toBeNull();
      expect(fixture.eventTypes()).toContain('run.pause_requested');
      expect(fixture.eventTypes()).toContain('run.paused');
      expect(fixture.provider.abortedRequests.length).toBeGreaterThan(0);

      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      const resumed = await fixture.engine.resume({
        commandId: uuid() as never,
        runId: ready.runId as never,
        expectedRevision: await fixture.taskRevision(),
        actor: 'user',
      });
      expect(resumed.state).toBe('RUNNING');
      await fixture.engine.waitForIdle();
      run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('AWAITING_REVIEW');
      expect(run!.attempt).toBe(2);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('cancels a running execution at a safe boundary, preserves the draft and never accepts silently', async () => {
    const fixture = await createFixture({ modules: [{ title: '取消模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueAbortable();
      await commitRun(fixture, ready.runId);
      await waitFor(() => fixture.provider.requests.length >= 2);
      await fixture.engine.cancel({
        commandId: uuid() as never,
        runId: ready.runId as never,
        expectedRevision: await fixture.taskRevision(),
        reason: '用户取消',
        actor: 'user',
      });
      await fixture.engine.waitForIdle();
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('CANCELLED');
      expect(run!.finishedAt).not.toBeNull();
      const cancelled = fixture.findEvents('run.cancelled').at(-1)!;
      expect(cancelled).toBeTruthy();
      expect((cancelled.payload as { draftPreserved: boolean }).draftPreserved).toBe(true);
      expect((cancelled.payload as { acceptedVersionUnchanged: boolean }).acceptedVersionUnchanged).toBe(true);
      const versions = await fixture.storage.listVersions(fixture.modules[0]!.id);
      expect(versions).toHaveLength(0);
      const module = await fixture.storage.getModule(fixture.modules[0]!.id);
      expect(module!.acceptedVersionId).toBeNull();
      expect(fixture.finished.filter((entry) => entry.runId === ready.runId)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('cancelling a run in AWAITING_REVIEW preserves the patch draft but forbids accepting it afterwards', async () => {
    const fixture = await createFixture({ modules: [{ title: '审阅取消模块', kind: 'markdown' }] });
    try {
      const { runId } = await startRunWithCandidate(fixture);
      const detail = await fixture.engine.getRunDetail(runId as never);
      expect(detail!.run.state).toBe('AWAITING_REVIEW');
      const patch = await latestPatch(fixture);
      expect(patch).not.toBeNull();
      await fixture.engine.cancel({
        commandId: uuid() as never,
        runId: runId as never,
        expectedRevision: await fixture.taskRevision(),
        reason: '放弃本次成果',
        actor: 'user',
      });
      const after = await fixture.storage.getRun(runId);
      expect(after!.state).toBe('CANCELLED');
      const preserved = await fixture.storage.getPatch(patch!.id);
      expect(preserved!.status).toBe('proposed');
      expect(preserved!.candidate).toBeTruthy();
      await expect(
        fixture.engine.accept({
          commandId: uuid() as never,
          patchId: patch!.id,
          expectedRevision: await fixture.taskRevision(),
          validationReportId: detail!.validationReport!.id,
          acceptMode: 'all',
          sectionIds: [],
          note: '',
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'state_not_allowed' });
      const versions = await fixture.storage.listVersions(fixture.modules[0]!.id);
      expect(versions).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('reports a tool outcome-unknown as a technical blocker instead of replaying it', async () => {
    const fixture = await createFixture({
      modules: [{ title: '未知结果模块', kind: 'markdown' }],
      sources: [{ name: 'data.csv', text: 'id,name\n1,a' }],
    });
    try {
      const ready = await planToReady(fixture);
      fixture.tools.setHandler('source.read', async (args, ctx) => ({
        toolCallId: ctx.toolCallId,
        toolId: 'source.read',
        status: 'outcome_unknown',
        durationMs: 1,
        error: null,
        trust: 'untrusted_content',
        resultObjectHash: null,
        resultBytes: 0,
        result: args.sourceId as never,
      }));
      fixture.provider.enqueue(
        toolCallEvents('source.read', { sourceId: fixture.sources[0]!.id, version: 1, maxChars: 100 }),
      );
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_INPUT');
      expect(detail!.blockers.some((blocker) => blocker.type === 'service_failure')).toBe(true);
      expect(fixture.eventTypes()).toContain('tool.outcome_unknown');
      const invocations = await fixture.storage.listToolInvocations(ready.runId as never);
      expect(invocations.some((record) => record.status === 'outcome_unknown')).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('fails with a committed state change when the planner output is valid but the model never produces a candidate', async () => {
    const fixture = await createFixture({
      modules: [{ title: '空输出模块', kind: 'markdown' }],
      config: { maxToolRounds: 2 },
    });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueText('我会尽力完成，但没有 JSON。');
      fixture.provider.enqueueText('仍然没有候选成果。');
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_INPUT');
      expect(detail!.blockers.some((blocker) => blocker.type === 'no_progress')).toBe(true);
      const patch = await latestPatch(fixture);
      expect(patch).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

void validPlannerOutput;
