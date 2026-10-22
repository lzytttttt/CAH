import { describe, expect, it } from 'vitest';
import { newUuid as uuid, type ContextSnapshot } from '@ca/contracts';
import { buildContext } from '../src/context';
import { estimateTokens } from '../src/hashing';
import {
  COMPRESSOR_V1_VERSION,
  EXECUTOR_V1_VERSION,
  PLANNER_V1_VERSION,
  PROMPT_TEMPLATE_HASHES,
  RECIPE_EXTRACTOR_V1_VERSION,
  REPAIR_V1_VERSION,
  renderCompressorPrompt,
  renderExecutorInstruction,
  renderExecutorSystem,
  renderPlannerInstruction,
  renderPlannerSystem,
  renderRecipeExtractorPrompt,
  renderRepairInstruction,
  renderRepairSystem,
} from '../src/prompts';
import { createFixture, markdownCandidate, seedAcceptedVersion } from './fixtures';

describe('context builder', () => {
  it('renders layered fragments in priority order and records omissions under a tight budget', async () => {
    const fixture = await createFixture({
      modules: [{ title: '上下文模块', kind: 'markdown' }],
      sources: [{ name: 'notes.md', text: '资料第一段\n资料第二段' }],
    });
    try {
      const baseline = await seedAcceptedVersion(
        fixture,
        0,
        markdownCandidate([{ id: 'old', title: '旧基线', markdown: 'o'.repeat(4_000) }]),
      );
      const input = {
        workspaceSettings: fixture.workspace.settings,
        task: fixture.task,
        module: fixture.modules[0]!,
        acceptedVersion: baseline,
        acceptedUpstream: [],
        sourceRefs: fixture.sources.map((source) => ({ sourceId: source.id, version: source.version })),
        stepGoal: '生成候选成果',
        evidenceRefs: [],
        recentToolResults: [
          { toolId: 'source.read', summary: '读取了资料片段' },
          { toolId: 'source.search', summary: '检索到 2 条命中' },
        ],
        plan: null,
        tokenBudget: 700,
        reserveTokens: 100,
      };
      const built = buildContext(input as never, {
        purpose: 'executor',
        clock: fixture.clock,
        runId: uuid(),
        policyVersion: 'p0-policy-1',
        promptBundleVersion: 'prompts-1',
        systemPrompt: 'SYSTEM-POLICY-TEXT',
        instruction: 'INSTRUCTION-TEXT',
        decisions: [],
        sources: fixture.sources,
      });
      const snapshot: ContextSnapshot = built.snapshot;
      expect(built.userPrompt).toContain('SYSTEM-POLICY-TEXT');
      expect(built.userPrompt).toContain('INSTRUCTION-TEXT');
      expect(built.userPrompt).toContain('## [P1]');
      const includedPriorities = snapshot.fragments.filter((fragment) => fragment.included).map((fragment) => fragment.priority);
      expect(includedPriorities).toContain(1);
      expect(includedPriorities).toContain(2);
      // Priority 1/2 always survive; lower priorities are recorded as omitted.
      expect(snapshot.omitted.length).toBeGreaterThan(0);
      expect(snapshot.omitted.every((entry) => entry.reason.length > 0)).toBe(true);
      expect(snapshot.promptBundleVersion).toBe('prompts-1');
      expect(snapshot.promptTemplateHashes['planner.v1']).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.promptTemplateHashes['executor.v1']).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.estimatedInputTokens).toBeGreaterThan(0);
      // No full-history dumping: the bounded history list is capped.
      expect(snapshot.fragments.length).toBeLessThan(50);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('never omits hard constraints or the user goal, and keeps accepted upstream version refs', async () => {
    const fixture = await createFixture({
      modules: [
        { title: '上游', kind: 'markdown' },
        { title: '下游', kind: 'markdown', dependencies: [0] },
      ],
      constraints: [{ text: '必须完全离线部署', kind: 'hard' }],
    });
    try {
      const upstreamVersion = await seedAcceptedVersion(
        fixture,
        0,
        markdownCandidate([{ id: 'u', title: 'U', markdown: '上游已接受内容' }]),
      );
      const built = buildContext(
        {
          workspaceSettings: fixture.workspace.settings,
          task: fixture.task,
          module: fixture.modules[1]!,
          acceptedVersion: null,
          acceptedUpstream: [{ module: fixture.modules[0]!, version: upstreamVersion }],
          sourceRefs: [],
          stepGoal: '生成下游成果',
          evidenceRefs: [],
          recentToolResults: [],
          plan: null,
          tokenBudget: 4_000,
          reserveTokens: 200,
        } as never,
        {
          purpose: 'executor',
          clock: fixture.clock,
          runId: uuid(),
          policyVersion: 'p0-policy-1',
          promptBundleVersion: 'prompts-1',
          systemPrompt: 'SYS',
          instruction: 'INS',
          decisions: [],
          sources: [],
        },
      );
      expect(built.userPrompt).toContain('必须完全离线部署');
      expect(built.userPrompt).toContain('生成下游成果');
      expect(built.userPrompt).toContain(upstreamVersion.id);
      const hardConstraintFragment = built.snapshot.fragments.find((fragment) => fragment.kind === 'hard_constraint');
      expect(hardConstraintFragment!.included).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('estimates tokens deterministically and monotonically', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('中文内容')).toBeGreaterThan(estimateTokens('中文'));
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('versioned prompt bundle', () => {
  it('exposes stable versions and sha256 hashes for every role template', () => {
    expect(PLANNER_V1_VERSION).toBe('planner.v1');
    expect(EXECUTOR_V1_VERSION).toBe('executor.v1');
    expect(REPAIR_V1_VERSION).toBe('repair.v1');
    expect(COMPRESSOR_V1_VERSION).toBe('compressor.v1');
    expect(RECIPE_EXTRACTOR_V1_VERSION).toBe('recipe-extractor.v1');
    expect(Object.keys(PROMPT_TEMPLATE_HASHES)).toEqual([
      'planner.v1',
      'executor.v1',
      'repair.v1',
      'compressor.v1',
      'recipe-extractor.v1',
    ]);
    for (const hash of Object.values(PROMPT_TEMPLATE_HASHES)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forbids fabricated sources/risks, hidden chain-of-thought and text-embedded tool calls', () => {
    const planner = renderPlannerSystem({
      policyVersion: 'p0-policy-1',
      promptBundleVersion: 'prompts-1',
      allowedTools: '- artifact.propose_patch',
      moduleSummary: 'module',
      budgetSummary: 'budget',
    });
    expect(planner).toContain('不得编造');
    expect(planner).toContain('隐藏思维链');
    expect(planner).toContain('p0-policy-1');
    expect(planner).toContain('artifact.propose_patch');
    const plannerUser = renderPlannerInstruction({ goal: '目标A', skeletonModuleId: uuid(), moduleKind: 'markdown' });
    expect(plannerUser).toContain('目标A');
    expect(plannerUser).toContain('openQuestions');

    const executor = renderExecutorSystem({
      policyVersion: 'p0-policy-1',
      promptBundleVersion: 'prompts-1',
      moduleId: uuid(),
      baseVersionId: 'none',
      stepTitle: '步骤一',
      stepGoal: '生成内容',
      moduleSummary: 'module',
      budgetSummary: 'budget',
      allowedTools: '- source.read',
    });
    expect(executor).toContain('原生 tool call');
    expect(executor).toContain('不得编造');
    expect(renderExecutorInstruction({ stepGoal: '生成内容' })).toContain('生成内容');

    const repair = renderRepairSystem({ policyVersion: 'p0-policy-1' });
    expect(repair).toContain('只修改');
    const repairUser = renderRepairInstruction({
      moduleKind: 'markdown',
      attempt: 1,
      maxAttempts: 2,
      findings: '- L1/x: 重复章节 ID',
      allowedEvidence: '- spanId=abc',
      candidateJson: '{"kind":"markdown"}',
    });
    expect(repairUser).toContain('重复章节 ID');
    expect(repairUser).toContain('spanId=abc');

    const compressor = renderCompressorPrompt({ budgetSummary: 'limit', fragments: '- fragment' });
    expect(compressor.system).toContain('压缩');
    expect(compressor.user).toContain('confirmedFacts');

    const extractor = renderRecipeExtractorPrompt({
      taskTitle: '任务',
      moduleKind: 'csv',
      sourceSummary: '资料',
      toolSummary: '工具',
      validatorSummary: '校验器',
      budgetSummary: '预算',
    });
    expect(extractor.system).toContain('配方');
    expect(extractor.user).toContain('testCases');
  });
});
