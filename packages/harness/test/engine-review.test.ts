import { describe, expect, it } from 'vitest';
import { newUuid as uuid } from '@ca/contracts';
import {
  candidateEnvelope,
  commitRun,
  createFixture,
  csvCandidate,
  latestPatch,
  latestReport,
  markdownCandidate,
  planToReady,
  seedAcceptedVersion,
} from './fixtures';
import { toolCallEvents } from './fakes/fake-provider';

const GOOD_CANDIDATE = markdownCandidate([
  { id: 'intro', title: '简介', markdown: '这是经过整理的简介，只包含可核验信息。' },
  { id: 'summary', title: '总结', markdown: '总结：按计划完成整理，保留人工验收。' },
]);

const BAD_CANDIDATE = markdownCandidate([
  { id: 'dup', title: '重复一', markdown: '正文一' },
  { id: 'dup', title: '重复二', markdown: '正文二' },
]);

describe('validation, repair and review', () => {
  it('repairs a deterministically invalid candidate once, revalidates, and only then proposes a patch', async () => {
    const fixture = await createFixture({ modules: [{ title: '修复模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueText(candidateEnvelope(BAD_CANDIDATE));
      fixture.provider.enqueueText(candidateEnvelope(GOOD_CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_REVIEW');
      const validationEvents = fixture.findEvents('validation.completed');
      expect(validationEvents.length).toBeGreaterThanOrEqual(2);
      const statuses = validationEvents.map((event) => (event.payload as { status: string }).status);
      expect(statuses[0]).toBe('fail');
      expect(statuses.at(-1)).not.toBe('fail');
      // total calls: planner + executor + 1 repair
      expect(fixture.provider.requests).toHaveLength(3);
      const patch = await latestPatch(fixture);
      expect(patch).not.toBeNull();
      expect(patch!.candidate).toEqual(GOOD_CANDIDATE);
      expect(fixture.eventTypes()).toContain('artifact.patch_proposed');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('stops after maxStructureRepairs with concrete findings and never fabricates a patch', async () => {
    const fixture = await createFixture({
      modules: [{ title: '修复耗尽模块', kind: 'markdown' }],
      budget: { maxStructureRepairs: 2 },
    });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueText(candidateEnvelope(BAD_CANDIDATE));
      fixture.provider.enqueueText(candidateEnvelope(BAD_CANDIDATE));
      fixture.provider.enqueueText(candidateEnvelope(BAD_CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_INPUT');
      expect(detail!.blockers.some((blocker) => blocker.type === 'validation_failed')).toBe(true);
      const blocker = detail!.blockers.find((entry) => entry.type === 'validation_failed')!;
      expect(blocker.detail).toContain('章节 ID');
      expect(fixture.eventTypes()).not.toContain('artifact.patch_proposed');
      expect(fixture.eventTypes()).not.toContain('artifact.accepted');
      const patch = await latestPatch(fixture);
      expect(patch).toBeNull();
      // planner + executor + 2 bounded repairs
      expect(fixture.provider.requests).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('returns VERSION_CONFLICT on accept when the baseline changed, preserving both sides', async () => {
    const fixture = await createFixture({ modules: [{ title: '版本冲突模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueText(candidateEnvelope(GOOD_CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_REVIEW');
      const patch = await latestPatch(fixture);
      const report = await latestReport(fixture, patch!);
      // Someone else accepts a different version before this patch is accepted.
      const other = await seedAcceptedVersion(
        fixture,
        0,
        markdownCandidate([{ id: 'other', title: '其他版本', markdown: '其他已接受内容' }]),
      );
      await expect(
        fixture.engine.accept({
          commandId: uuid() as never,
          patchId: patch!.id,
          expectedRevision: await fixture.taskRevision(),
          validationReportId: report!.id,
          acceptMode: 'all',
          sectionIds: [],
          note: '尝试接受',
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      // Both sides preserved, no overwrite, run still waiting for review.
      const preservedPatch = await fixture.storage.getPatch(patch!.id);
      expect(preservedPatch!.status).toBe('proposed');
      expect(preservedPatch!.candidate).toEqual(GOOD_CANDIDATE);
      const accepted = await fixture.storage.getAcceptedVersion(fixture.modules[0]!.id);
      expect(accepted!.id).toBe(other.id);
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('AWAITING_REVIEW');
      const versions = await fixture.storage.listVersions(fixture.modules[0]!.id);
      expect(versions).toHaveLength(1);
      expect(fixture.eventTypes()).not.toContain('artifact.accepted');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('rejects a proposal as CANCELLED while preserving the draft and any accepted version', async () => {
    const fixture = await createFixture({ modules: [{ title: '拒绝模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      fixture.provider.enqueueText(candidateEnvelope(GOOD_CANDIDATE));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const patch = await latestPatch(fixture);
      const result = await fixture.engine.reject({
        commandId: uuid() as never,
        patchId: patch!.id,
        reason: '内容不符合预期',
        actor: 'user',
      });
      expect(result.status).toBe('rejected');
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('CANCELLED');
      const preserved = await fixture.storage.getPatch(patch!.id);
      expect(preserved!.status).toBe('rejected');
      expect(preserved!.candidate).toEqual(GOOD_CANDIDATE);
      expect(await fixture.storage.getAcceptedVersion(fixture.modules[0]!.id)).toBeNull();
      expect(fixture.findEvents('run.cancelled')).toHaveLength(1);
      expect(fixture.finished).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('auto-accepts only with the explicit workspace policy and records the policy route', async () => {
    const fixture = await createFixture({
      modules: [{ title: '自动接受表格', kind: 'csv' }],
      workspaceSettings: { autoAcceptVerifiedDrafts: true },
    });
    try {
      const ready = await planToReady(fixture);
      const candidate = csvCandidate(
        [
          { key: 'id', label: 'ID', type: 'string', required: true },
          { key: 'name', label: '名称', type: 'string', required: true },
        ],
        [
          { id: '1', name: '甲' },
          { id: '2', name: '乙' },
        ],
      );
      fixture.provider.enqueueText(candidateEnvelope(candidate));
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('COMPLETED');
      expect(run!.autoAcceptPolicyApplied).toBe(true);
      const acceptedEvent = fixture.findEvents('artifact.accepted').at(-1)!;
      expect((acceptedEvent.payload as { route: string }).route).toBe('auto_accept_policy');
      const accepted = await fixture.storage.getAcceptedVersion(fixture.modules[0]!.id);
      expect(accepted).not.toBeNull();
      expect(fixture.finished).toHaveLength(1);
      expect(fixture.finished[0]!.state).toBe('COMPLETED');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('accepts only the selected markdown sections when acceptMode=sections', async () => {
    const fixture = await createFixture({ modules: [{ title: '按章节接受', kind: 'markdown' }] });
    try {
      const base = markdownCandidate([
        { id: 'a', title: 'A', markdown: '基线 A' },
        { id: 'b', title: 'B', markdown: '基线 B' },
      ]);
      const baseVersion = await seedAcceptedVersion(fixture, 0, base);
      const ready = await planToReady(fixture);
      const candidate = markdownCandidate([
        { id: 'a', title: 'A', markdown: '新 A' },
        { id: 'b', title: 'B', markdown: '基线 B' },
        { id: 'c', title: 'C', markdown: '未选中的新章节' },
      ]);
      fixture.provider.enqueue(
        toolCallEvents('artifact.propose_patch', {
          moduleId: fixture.modules[0]!.id as string,
          baseVersionId: baseVersion.id,
          description: '更新 A 章节',
          operations: [{ kind: 'replace_module', content: candidate }],
          evidenceRefs: [],
        }),
      );
      await commitRun(fixture, ready.runId);
      await fixture.engine.waitForIdle();
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('AWAITING_REVIEW');
      const patch = await latestPatch(fixture);
      const report = await latestReport(fixture, patch!);
      const result = await fixture.engine.accept({
        commandId: uuid() as never,
        patchId: patch!.id,
        expectedRevision: await fixture.taskRevision(),
        validationReportId: report!.id,
        acceptMode: 'sections',
        sectionIds: ['a'],
        note: '只接受 A 章节',
        actor: 'user',
      });
      const version = await fixture.storage.getVersion(result.versionId as string);
      expect(version!.content).toEqual(
        markdownCandidate([
          { id: 'a', title: 'A', markdown: '新 A' },
          { id: 'b', title: 'B', markdown: '基线 B' },
        ]),
      );
      expect(version!.parentId).toBe(baseVersion.id);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('restores an old version as a new version and marks downstream modules stale', async () => {
    const fixture = await createFixture({
      modules: [
        { title: '上游模块', kind: 'markdown' },
        { title: '下游模块', kind: 'markdown', dependencies: [0] },
      ],
    });
    try {
      const v1 = await seedAcceptedVersion(fixture, 0, markdownCandidate([{ id: 's', title: 'S', markdown: '第一版' }]));
      const v2 = await seedAcceptedVersion(fixture, 0, markdownCandidate([{ id: 's', title: 'S', markdown: '第二版' }]));
      await seedAcceptedVersion(fixture, 1, markdownCandidate([{ id: 't', title: 'T', markdown: '下游内容' }]));
      expect((await fixture.storage.getAcceptedVersion(fixture.modules[0]!.id))!.id).toBe(v2.id);
      const result = await fixture.engine.restore({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        moduleId: fixture.modules[0]!.id,
        versionId: v1.id,
        expectedRevision: await fixture.taskRevision(),
        note: '恢复第一版',
        actor: 'user',
      });
      const restored = await fixture.storage.getVersion(result.versionId as string);
      expect(restored).not.toBeNull();
      expect(restored!.content).toEqual(v1.content);
      expect(restored!.restoredFromVersionId).toBe(v1.id);
      expect(restored!.parentId).toBe(v2.id);
      expect(restored!.baseVersionId).toBe(v2.id);
      expect(restored!.patchId).toBeNull();
      const upstream = await fixture.storage.getModule(fixture.modules[0]!.id);
      expect(upstream!.acceptedVersionId).toBe(restored!.id);
      const downstream = await fixture.storage.getModule(fixture.modules[1]!.id);
      expect(downstream!.status).toBe('stale');
      expect(fixture.eventTypes()).toContain('artifact.restored');
      expect(fixture.eventTypes()).toContain('artifact.stale');
      const artifact = await fixture.storage.getArtifact(fixture.artifact.id);
      expect(artifact!.acceptedVersionId).toBe(restored!.id);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('fails the commit when the context snapshot is stale, before writing the version', async () => {
    const fixture = await createFixture({ modules: [{ title: '快照绑定模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      await expect(
        fixture.engine.commit({
          commandId: uuid() as never,
          runId: ready.runId as never,
          expectedRevision: await fixture.taskRevision(),
          planVersion: detail!.run.planVersion,
          contextSnapshotId: uuid(),
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'schema_invalid' });
      const run = await fixture.storage.getRun(ready.runId);
      expect(run!.state).toBe('READY');
      expect(await fixture.storage.listVersions(fixture.modules[0]!.id)).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
