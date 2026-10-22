import { describe, expect, it } from 'vitest';
import { newSourceId, newSourceSpanId, newUuid as uuid } from '@ca/contracts';
import { commitRun, createFixture, planToReady, sourceSpanEvidence, validPlannerOutput } from './fixtures';
import { sha256Hex } from '../src/hashing';
import { detectConstraintConflicts } from '../src/risk-rules';

const CONFLICT_CONSTRAINTS = [
  { text: '首版必须支持完全离线私有化部署：业务数据与模型推理都不离开客户内网。', kind: 'hard' as const },
  { text: '核心交互必须依赖云端实时大模型服务完成流式生成与工具调用。', kind: 'hard' as const },
];

describe('planning stage', () => {
  it('produces zero risks for a conflict-free task and stays READY (never invents risks)', async () => {
    const fixture = await createFixture({ modules: [{ title: '无冲突模块', kind: 'markdown' }] });
    try {
      const ready = await planToReady(fixture);
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      expect(detail!.run.state).toBe('READY');
      expect(detail!.plan!.risks).toHaveLength(0);
      expect(detail!.plan!.budget.maxModelRequests).toBeGreaterThan(0);
      expect(detail!.plan!.promptVersion).toBe('planner.v1');
      expect(detail!.plan!.tools.some((tool) => tool.toolId === 'artifact.propose_patch')).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('blocks on a real hard-constraint conflict and requires an explicit user decision before commit', async () => {
    const fixture = await createFixture({
      modules: [{ title: '冲突模块', kind: 'markdown' }],
      constraints: CONFLICT_CONSTRAINTS,
    });
    try {
      const moduleId = fixture.modules[0]!.id as string;
      fixture.provider.enqueueText(JSON.stringify(validPlannerOutput({ moduleId, moduleKind: 'markdown' })));
      const handle = await fixture.engine.plan({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId: fixture.modules[0]!.id,
        intent: fixture.task.intent,
        planFirst: true,
        actor: 'user',
      });
      expect(handle.state).toBe('AWAITING_INPUT');
      const detail = await fixture.engine.getRunDetail(handle.runId as never);
      expect(detail!.plan!.risks.filter((risk) => risk.severity === 'blocking')).toHaveLength(1);
      const conflictRisk = detail!.plan!.risks.find((risk) => risk.type === 'constraint_conflict')!;
      expect(conflictRisk.basis).toBe('constraint_conflict');
      expect(detail!.blockers).toHaveLength(1);
      expect(detail!.blockers[0]!.type).toBe('constraint_conflict');
      expect(detail!.blockers[0]!.status).toBe('open');
      // Commit is blocked while the conflict is unresolved.
      await expect(
        fixture.engine.commit({
          commandId: uuid() as never,
          runId: handle.runId as never,
          expectedRevision: await fixture.taskRevision(),
          planVersion: handle.plan!.version,
          contextSnapshotId: detail!.run.contextSnapshotId as string,
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'state_not_allowed' });

      // User explicitly chooses a resolution → new plan version WITHOUT re-calling the model.
      const blocker = detail!.blockers[0]!;
      const choice = blocker.resolutions.find((option) => option.id === 'choice')!;
      const optionValue = choice.kind === 'choose' ? choice.options[0]!.value : 'o1';
      const resolved = await fixture.engine.resolve({
        commandId: uuid() as never,
        runId: handle.runId as never,
        expectedRevision: await fixture.taskRevision(),
        blockerId: blocker.id,
        optionId: 'choice',
        value: optionValue,
        note: '明确选择冲突处理方式',
        actor: 'user',
      });
      expect(resolved.state).toBe('READY');
      expect(resolved.plan!.version).toBe(2);
      expect(
        resolved.plan!.risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null),
      ).toHaveLength(0);
      expect(resolved.plan!.risks.some((risk) => risk.resolvedByDecisionId !== null)).toBe(true);
      expect(fixture.eventTypes()).toContain('plan.revised');
      expect(fixture.eventTypes()).toContain('input.resolved');
      // The user decision is recorded as a Decision row.
      const decisions = await fixture.storage.listDecisions(fixture.task.id);
      expect(decisions.length).toBe(1);
      expect(decisions[0]!.blockerId).toBe(blocker.id);
      // Now the plan can be committed.
      const committed = await commitRun(fixture, handle.runId as string);
      expect(committed.state).toBe('RUNNING');
      await fixture.engine.waitForIdle();
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('filters fabricated model risks and keeps only evidence-backed or explicit-unknown risks', async () => {
    const fixture = await createFixture({ modules: [{ title: '风险过滤模块', kind: 'markdown' }] });
    try {
      const moduleId = fixture.modules[0]!.id;
      // A real, persisted source span the model may cite.
      const spanId = newSourceSpanId();
      const quoteHash = sha256Hex('真实证据片段');
      const span = {
        id: spanId as unknown as string,
        sourceId: newSourceId() as unknown as string,
        version: 1,
        locator: { kind: 'text_lines' as const, startLine: 1, endLine: 1 },
        quoteHash,
        excerpt: '真实证据片段',
        createdAt: fixture.clock.now(),
      };
      await fixture.storage.insertSpans([{ ...span, id: spanId, sourceId: span.sourceId as never }]);
      const plan = validPlannerOutput({ moduleId: moduleId as string, moduleKind: 'markdown' });
      plan.risks = [
        {
          id: 'r_fake',
          type: 'missing_input',
          basis: 'evidence',
          title: '缺少市场数据（无证据）',
          detail: '模型编造的风险',
          severity: 'blocking',
          affectedModuleIds: [moduleId],
          evidenceRefs: [],
          handlingOptions: [{ id: 'o1', label: '补充资料', description: '' }],
          resolvedByDecisionId: null,
        },
        {
          id: 'r_real',
          type: 'explicit_unknown',
          basis: 'evidence',
          title: '有真实证据的风险',
          detail: '基于真实 SourceSpan 的风险提示',
          severity: 'warning',
          affectedModuleIds: [moduleId],
          evidenceRefs: [sourceSpanEvidence(span)],
          handlingOptions: [{ id: 'o1', label: '核对证据', description: '' }],
          resolvedByDecisionId: null,
        },
        {
          id: 'r_unknown',
          type: 'explicit_unknown',
          basis: 'explicit_unknown',
          title: '待确认的边界',
          detail: '明确未知项',
          severity: 'blocking',
          affectedModuleIds: [moduleId],
          evidenceRefs: [],
          handlingOptions: [{ id: 'o1', label: '确认边界', description: '' }],
          resolvedByDecisionId: null,
        },
      ];
      const ready = await planToReady(fixture, plan);
      const detail = await fixture.engine.getRunDetail(ready.runId as never);
      const titles = detail!.plan!.risks.map((risk) => risk.title);
      expect(titles).not.toContain('缺少市场数据（无证据）');
      expect(titles).toContain('有真实证据的风险');
      expect(titles).toContain('待确认的边界');
      // explicit_unknown may never block commit by itself.
      const unknown = detail!.plan!.risks.find((risk) => risk.title === '待确认的边界')!;
      expect(unknown.severity).toBe('warning');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('bounds plan-structure repair and fails with concrete problems instead of forcing success', async () => {
    const fixture = await createFixture({ modules: [{ title: '坏计划模块', kind: 'markdown' }] });
    try {
      fixture.provider.enqueueText('这不是 JSON');
      fixture.provider.enqueueText('仍然不是 JSON');
      fixture.provider.enqueueText('还是不是 JSON');
      const handle = await fixture.engine.plan({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId: fixture.modules[0]!.id,
        intent: fixture.task.intent,
        planFirst: true,
        actor: 'user',
      });
      expect(handle.state).toBe('FAILED');
      const run = await fixture.storage.getRun(handle.runId as never);
      expect(run!.state).toBe('FAILED');
      expect(run!.error!.stage).toBe('planning');
      expect(fixture.eventTypes()).toContain('run.failed');
      expect(fixture.eventTypes()).not.toContain('plan.ready');
      expect(fixture.finished).toHaveLength(1);
      // initial planner call + 2 bounded structure repairs
      expect(fixture.provider.requests).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('recovers from one invalid plan response through the bounded repair prompt', async () => {
    const fixture = await createFixture({ modules: [{ title: '修复计划模块', kind: 'markdown' }] });
    try {
      fixture.provider.enqueueText('{"goal": 42}');
      fixture.provider.enqueueText(
        JSON.stringify(validPlannerOutput({ moduleId: fixture.modules[0]!.id as string, moduleKind: 'markdown' })),
      );
      const ready = await planToReady(fixture, undefined);
      expect(ready.runId).toBeTruthy();
      expect(fixture.provider.requests).toHaveLength(2);
      // Repair calls use the repair prompt + no tools.
      expect(fixture.provider.requests[1]!.tools).toHaveLength(0);
      expect(fixture.provider.requests[1]!.messages[0]!.role).toBe('system');
      expect((fixture.provider.requests[1]!.messages[0] as { content: string }).content).toContain('repair.v1');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('uses a deterministic zero-LLM shortest plan for planFirst=false', async () => {
    const fixture = await createFixture({
      modules: [{ title: '直接执行模块', kind: 'markdown' }],
      sources: [{ name: 'note.md', text: '直接执行路径测试资料。' }],
    });
    try {
      const handle = await fixture.engine.plan({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId: fixture.modules[0]!.id,
        intent: '读取资料并整理成一段说明',
        planFirst: false,
        actor: 'user',
      });
      expect(handle.state).toBe('READY');
      expect(fixture.provider.requests).toHaveLength(0);
      expect(handle.plan!.promptVersion).toBe('deterministic-plan-1');
      expect(handle.plan!.modelProfileId).toBeNull();
      expect(handle.plan!.risks).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('still blocks a direct (planFirst=false) run when real hard constraints conflict', async () => {
    const fixture = await createFixture({
      modules: [{ title: '直接执行冲突模块', kind: 'markdown' }],
      constraints: CONFLICT_CONSTRAINTS,
    });
    try {
      const handle = await fixture.engine.plan({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId: fixture.modules[0]!.id,
        intent: '整理说明',
        planFirst: false,
        actor: 'user',
      });
      expect(handle.state).toBe('AWAITING_INPUT');
      expect(handle.plan!.risks.some((risk) => risk.type === 'constraint_conflict' && risk.severity === 'blocking')).toBe(true);
      expect(fixture.provider.requests).toHaveLength(0);
      expect(detectConstraintConflicts(
        CONFLICT_CONSTRAINTS.map((constraint, index) => ({
          id: `C${index + 1}`,
          text: constraint.text,
          kind: constraint.kind,
          status: 'confirmed' as const,
          sourceRefs: [],
          note: '',
        })),
      )).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 30_000);
  it('fails honestly when no provider is configured for reviewed planning', async () => {
    const fixture = await createFixture({ modules: [{ title: '无供应商模块', kind: 'markdown' }], configureProvider: false });
    try {
      const handle = await fixture.engine.plan({
        commandId: uuid() as never,
        taskId: fixture.task.id,
        expectedRevision: await fixture.taskRevision(),
        moduleId: fixture.modules[0]!.id,
        intent: fixture.task.intent,
        planFirst: true,
        actor: 'user',
      });
      expect(handle.state).toBe('FAILED');
      const run = await fixture.storage.getRun(handle.runId as never);
      expect(run!.error!.code).toBe('provider_model_missing');
      expect(fixture.provider.requests).toHaveLength(0);
      expect(fixture.eventTypes()).toContain('run.failed');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('rejects a stale expectedRevision with a typed revision_conflict', async () => {
    const fixture = await createFixture({ modules: [{ title: '修订冲突模块', kind: 'markdown' }] });
    try {
      await expect(
        fixture.engine.plan({
          commandId: uuid() as never,
          taskId: fixture.task.id,
          expectedRevision: 99,
          moduleId: fixture.modules[0]!.id,
          intent: fixture.task.intent,
          planFirst: true,
          actor: 'user',
        }),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      const runs = await fixture.storage.listRuns(fixture.task.id);
      expect(runs).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
