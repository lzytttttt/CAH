import { describe, expect, it } from 'vitest';
import { newUuid } from '@ca/contracts';
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

const CANDIDATE = markdownCandidate([
  { id: 'background', title: '背景', markdown: '这是根据用户意图生成的背景说明，不包含未经证实的数字。' },
  { id: 'conclusion', title: '结论', markdown: '结论：按计划完成测试模块，并保留人工验收环节。' },
]);

describe('engine happy path', () => {
  it('plans, commits, executes one native tool call, validates, reviews and accepts into a new version', async () => {
    const fixture = await createFixture({
      modules: [{ title: '测试模块', kind: 'markdown' }],
      sources: [{ name: 'notes.md', text: '背景资料：测试模块需要一份说明。\n结论来自人工整理。' }],
    });
    try {
      const ready = await planToReady(fixture);
      const planned = await fixture.engine.getRunDetail(ready.runId as never);
      expect(planned).not.toBeNull();
      expect(planned!.run.state).toBe('READY');
      expect(planned!.plan).not.toBeNull();
      expect(planned!.plan!.version).toBe(1);
      expect(planned!.plan!.risks).toHaveLength(0);
      expect(planned!.contextSnapshot).not.toBeNull();
      expect(planned!.run.contextSnapshotId).toBe(planned!.contextSnapshot!.id);

      // Executor: one native artifact.propose_patch call, then the kernel goes to review.
      fixture.provider.enqueue(
        toolCallEvents('artifact.propose_patch', {
          moduleId: fixture.modules[0]!.id as string,
          baseVersionId: planned!.run.baseVersionId,
          description: '生成测试候选成果',
          operations: [{ kind: 'replace_module', content: CANDIDATE }],
          evidenceRefs: [],
        }),
      );
      const committed = await commitRun(fixture, ready.runId);
      expect(committed.state).toBe('RUNNING');
      await fixture.engine.waitForIdle();

      const afterRun = await fixture.engine.getRunDetail(ready.runId as never);
      expect(afterRun).not.toBeNull();
      expect(afterRun!.run.state).toBe('AWAITING_REVIEW');
      expect(afterRun!.validationReport).not.toBeNull();
      expect(afterRun!.validationReport!.id).toBeTruthy();
      const patch = await latestPatch(fixture);
      expect(patch).not.toBeNull();
      expect(patch!.status).toBe('proposed');
      expect(patch!.candidateHash).toBe(afterRun!.validationReport!.candidateHash);
      const report = await latestReport(fixture, patch!);
      expect(report).not.toBeNull();
      expect(report!.status).not.toBe('fail');

      // Model event stream records the native tool call and its result.
      const types = fixture.eventTypes();
      for (const expected of [
        'run.created',
        'plan.proposed',
        'plan.ready',
        'plan.committed',
        'run.started',
        'step.started',
        'model.started',
        'tool.requested',
        'tool.authorized',
        'tool.started',
        'tool.succeeded',
        'validation.completed',
        'artifact.patch_proposed',
      ]) {
        expect(types, `missing event ${expected}`).toContain(expected);
      }
      expect(types.filter((type) => type === 'run.completed')).toHaveLength(0);

      // Checkpoints around external calls were persisted.
      expect(fixture.storage.checkpointKinds).toContain('before_model');
      expect(fixture.storage.checkpointKinds).toContain('after_model');
      expect(fixture.storage.checkpointKinds).toContain('before_tool');
      expect(fixture.storage.checkpointKinds).toContain('after_tool');

      // Accept into an immutable version.
      const acceptResult = await fixture.engine.accept({
        commandId: newUuid() as never,
        patchId: patch!.id,
        expectedRevision: await fixture.taskRevision(),
        validationReportId: report!.id,
        acceptMode: 'all',
        sectionIds: [],
        note: '测试接受',
        actor: 'user',
      });
      expect(acceptResult.runState).toBe('COMPLETED');
      expect(acceptResult.versionId).toBeTruthy();

      const version = await fixture.storage.getVersion(acceptResult.versionId as string);
      expect(version).not.toBeNull();
      expect(version!.content).toEqual(CANDIDATE);
      expect(version!.patchId).toBe(patch!.id);
      const module = await fixture.storage.getModule(fixture.modules[0]!.id);
      expect(module!.status).toBe('accepted');
      expect(module!.acceptedVersionId).toBe(version!.id);
      const artifact = await fixture.storage.getArtifact(fixture.artifact.id);
      expect(artifact!.acceptedVersionId).toBe(version!.id);

      const finalRun = await fixture.engine.getRunDetail(ready.runId as never);
      expect(finalRun!.run.state).toBe('COMPLETED');
      const typesFinal = fixture.eventTypes();
      expect(typesFinal).toContain('artifact.accepted');
      expect(typesFinal).toContain('run.completed');
      const acceptedEvent = fixture.findEvents('artifact.accepted').at(-1)!;
      expect((acceptedEvent.payload as { route: string }).route).toBe('user_accept');
      expect(fixture.finished.filter((entry) => entry.runId === ready.runId)).toHaveLength(1);
      expect(fixture.finished[0]!.state).toBe('COMPLETED');

      // The event stream API yields the same committed events in seq order.
      const streamed = [];
      for await (const event of fixture.engine.events(fixture.task.id, 0)) {
        streamed.push(event);
        if (event.type === 'run.completed') break;
      }
      expect(streamed.map((event) => event.seq)).toEqual([...streamed.map((event) => event.seq)].sort((a, b) => a - b));
      expect(streamed.map((event) => event.type)).toContain('run.completed');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('is idempotent by commandId for plan() and does not create a second run', async () => {
    const fixture = await createFixture({ modules: [{ title: '幂等模块', kind: 'markdown' }] });
    try {
      const command = {
        commandId: newUuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId: fixture.modules[0]!.id,
        intent: fixture.task.intent,
        planFirst: true,
        actor: 'user',
      };
      fixture.provider.enqueueText(JSON.stringify(validPlannerOutput({ moduleId: fixture.modules[0]!.id as string, moduleKind: 'markdown' })));
      const first = await fixture.engine.plan(command);
      const second = await fixture.engine.plan(command);
      expect(second.runId).toBe(first.runId);
      expect(fixture.provider.requests).toHaveLength(1);
      const runs = await fixture.storage.listRuns(fixture.task.id);
      expect(runs).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('accepts a final plain-JSON candidate envelope without any tool call', async () => {
    const fixture = await createFixture({ modules: [{ title: '文本模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      // No native tool call: plain JSON envelope is the fallback extraction path.
      fixture.provider.enqueueText(candidateEnvelope(CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_REVIEW');
      expect(detail!.validationReport).not.toBeNull();
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
