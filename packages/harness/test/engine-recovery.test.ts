import { describe, expect, it } from 'vitest';
import {
  newStepId,
  newToolCallId,
  newUuid as uuid,
  type Run,
  type ToolInvocationRecord,
} from '@ca/contracts';
import { candidateEnvelope, commitRun, createFixture, markdownCandidate, planToReady } from './fixtures';

const CANDIDATE = markdownCandidate([{ id: 's', title: 'S', markdown: '恢复后的候选成果正文。' }]);

function invocation(run: Run, toolId: 'source.read' | 'artifact.propose_patch'): ToolInvocationRecord {
  return {
    toolCallId: newToolCallId(),
    runId: run.id,
    stepId: newStepId(),
    toolId,
    status: 'started',
    argumentsJson: '{}',
    resultSummary: null,
    resultObjectHash: null,
    resultBytes: null,
    error: null,
    attempt: 1,
    plannedAt: new Date().toISOString(),
    authorizedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

async function markRunning(fixture: Awaited<ReturnType<typeof createFixture>>, runId: string): Promise<Run> {
  const run = (await fixture.storage.getRun(runId))!;
  const next: Run = {
    ...run,
    state: 'RUNNING',
    startedAt: fixture.clock.now(),
    updatedAt: fixture.clock.now(),
    revision: run.revision + 1,
  };
  await fixture.storage.updateRun(next, run.revision);
  return next;
}

describe('crash recovery', () => {
  it('marks an interrupted run INTERRUPTED with unknown tool calls and refuses to auto-replay non-read side effects', async () => {
    const fixture = await createFixture({ modules: [{ title: '恢复模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      const running = await markRunning(fixture, ready.runId as string);
      const unclear = invocation(running, 'artifact.propose_patch');
      fixture.storage.seedUnclearToolInvocation(unclear);

      const report = await fixture.engine.recoverInterrupted();
      expect(report.interrupted.some((entry) => entry.runId === running.id)).toBe(true);
      const recovered = await fixture.storage.getRun(running.id);
      expect(recovered!.state).toBe('INTERRUPTED');
      expect(recovered!.interrupted!.reason).toBe('lease_expired');
      expect(recovered!.interrupted!.unclearToolCalls).toEqual([unclear.toolCallId]);
      const interruptedEvent = fixture.findEvents('run.interrupted').at(-1)!;
      expect((interruptedEvent.payload as { unclearToolCalls: string[] }).unclearToolCalls).toEqual([unclear.toolCallId]);
      const record = await fixture.storage.findUnclearToolInvocations(running.id);
      expect(record).toHaveLength(0);
      const allRecords = await fixture.storage.listToolInvocations(running.id);
      expect(allRecords[0]!.status).toBe('outcome_unknown');

      await expect(fixture.engine.startRun(running.id)).rejects.toMatchObject({ code: 'tool_outcome_unknown' });
      const stillInterrupted = await fixture.storage.getRun(running.id);
      expect(stillInterrupted!.state).toBe('INTERRUPTED');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('safely resumes an INTERRUPTED run when unknown calls are read-only, using checkpoint + new attempt', async () => {
    const fixture = await createFixture({ modules: [{ title: '安全恢复模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      const running = await markRunning(fixture, ready.runId as string);
      fixture.storage.seedUnclearToolInvocation(invocation(running, 'source.read'));
      const report = await fixture.engine.recoverInterrupted();
      expect(report.interrupted).toHaveLength(1);
      const interrupted = await fixture.storage.getRun(running.id);
      expect(interrupted!.state).toBe('INTERRUPTED');

      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      await fixture.engine.startRun(running.id as never);
      const after = await fixture.storage.getRun(running.id);
      expect(after!.state).toBe('AWAITING_REVIEW');
      expect(after!.attempt).toBe(2);
      expect(fixture.eventTypes()).toContain('run.resumed');
      const resumed = fixture.findEvents('run.resumed').at(-1)!;
      expect((resumed.payload as { resumeMode: string }).resumeMode).toBe('from_checkpoint');
      const records = await fixture.storage.listToolInvocations(running.id);
      expect(records[0]!.status).toBe('outcome_unknown');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('reconciles a crash during COMMITTING when the completion event was already committed', async () => {
    const fixture = await createFixture({ modules: [{ title: '提交恢复模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      const run = (await fixture.storage.getRun(ready.runId))!;
      const versionId = uuid();
      await fixture.storage.updateRun(
        { ...run, state: 'COMMITTING', revision: run.revision + 1, updatedAt: fixture.clock.now() },
        run.revision,
      );
      await fixture.storage.appendEvents(fixture.task.id, [
        {
          runId: run.id,
          stepId: null,
          causationId: null,
          type: 'run.completed',
          payload: { runId: run.id, versionId: versionId as never, moduleId: fixture.modules[0]!.id },
          timestamp: fixture.clock.now(),
        },
      ]);
      const report = await fixture.engine.recoverInterrupted();
      expect(report.recovered).toBe(1);
      expect(report.interrupted).toHaveLength(0);
      const reconciled = await fixture.storage.getRun(run.id);
      expect(reconciled!.state).toBe('COMPLETED');
      expect(fixture.findEvents('run.interrupted')).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('leaves READY runs untouched and ignores them during recovery', async () => {
    const fixture = await createFixture({ modules: [{ title: '就绪模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      const report = await fixture.engine.recoverInterrupted();
      expect(report.interrupted).toHaveLength(0);
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('READY');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('startRun on a RUNNING run without an active loop continues from the last checkpoint', async () => {
    const fixture = await createFixture({ modules: [{ title: '直接恢复模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      await markRunning(fixture, ready.runId as string);
      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      await fixture.engine.startRun(ready.runId as never);
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('AWAITING_REVIEW');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('refuses to startRun a READY run whose plan is not committed yet', async () => {
    const fixture = await createFixture({ modules: [{ title: '未提交模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      await expect(fixture.engine.startRun(ready.runId as never)).rejects.toMatchObject({ code: 'state_not_allowed' });
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('READY');
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

void commitRun;
