import { describe, expect, it } from 'vitest';
import {
  blockerBatch,
  blockerTypeLabel,
  capabilityStatusLabel,
  checkStatusLabel,
  controlConnectionLabel,
  diffStatsLabel,
  isTechnicalBlocker,
  layerLabel,
  modeLabel,
  moduleStateLabel,
  planPhaseLabel,
  probeLabel,
  prospectStateLabel,
  recipeKindLabel,
  recipeRunAccounting,
  recipeStatusLabel,
  riskBasisLabel,
  riskTypeLabel,
  runStateLabel,
  spatialStatusLabel,
  summarizeRisks,
  trustLevelLabel,
  validationLayerLabel,
  validationStatusLabel,
} from '../src/lib/labels';
import { formatDuration, formatStepProgress, formatTimestamp, formatUsageSummary, truncateText } from '../src/lib/format';

describe('business status language (text-first, no game terms)', () => {
  it('maps run, module, spatial, plan and prospect states to business Chinese', () => {
    expect(runStateLabel('AWAITING_REVIEW')).toBe('待审阅');
    expect(runStateLabel('FAILED')).toBe('失败');
    expect(moduleStateLabel('ready_for_review')).toBe('待审阅');
    expect(moduleStateLabel('stale')).toBe('已过期');
    expect(spatialStatusLabel('blocked')).toBe('受阻');
    expect(planPhaseLabel('resolving')).toBe('处理待决问题');
    expect(prospectStateLabel('missing_inputs')).toBe('缺少输入');
    expect(layerLabel('global')).toBe('Z+1 全局');
    expect(modeLabel('live')).toBe('正式');
  });

  it('never contains game vocabulary in the label maps', () => {
    const labels = [
      runStateLabel('RUNNING'),
      moduleStateLabel('accepted'),
      spatialStatusLabel('running'),
      planPhaseLabel('peeking'),
      prospectStateLabel('ready'),
      riskTypeLabel('constraint_conflict'),
      blockerTypeLabel('info_missing'),
      validationStatusLabel('needs_review'),
      recipeStatusLabel('validated'),
      recipeKindLabel('deterministic'),
    ].join(' ');
    for (const word of ['HP', '血条', '经验', '等级', '关卡', '宝箱', '战斗', '击杀']) {
      expect(labels).not.toContain(word);
    }
  });

  it('labels validation layers, checks, risks and technical blockers', () => {
    expect(validationLayerLabel('L2')).toBe('L2 证据');
    expect(checkStatusLabel('not_applicable')).toBe('不适用');
    expect(riskTypeLabel('explicit_unknown')).toBe('明确未知');
    expect(riskBasisLabel('explicit_unknown')).toBe('明确未知');
    expect(isTechnicalBlocker('service_failure')).toBe(true);
    expect(isTechnicalBlocker('info_missing')).toBe(false);
    expect(trustLevelLabel('synthetic_demo')).toBe('合成演示');
    expect(capabilityStatusLabel('verified')).toBe('已验证');
    expect(probeLabel('tool_calling')).toBe('工具调用');
    expect(controlConnectionLabel('unconfigured')).toBe('未配置连接');
    expect(modeLabel('demo')).toBe('演示');
    expect(diffStatsLabel({ added: 1, removed: 2, changed: 3, unchanged: 4 })).toBe('新增 1 · 修改 3 · 删除 2 · 未变 4');
  });
});

describe('risk formatting — real counts only', () => {
  it('renders zero risks as zero cards worth of data', () => {
    const summary = summarizeRisks([]);
    expect(summary.total).toBe(0);
    expect(summary.blocking).toBe(0);
    expect(summary.label).toBe('未发现风险');
    expect(summary.blockingRisks).toEqual([]);
  });

  it('counts only unresolved blocking risks as blocking', () => {
    const summary = summarizeRisks([
      { id: '1', type: 'missing_input', basis: 'evidence', title: 'a', detail: '', severity: 'warning', affectedModuleIds: [], evidenceRefs: [], handlingOptions: [{ id: 'h', label: 'x' }], resolvedByDecisionId: null },
      { id: '2', type: 'constraint_conflict', basis: 'constraint_conflict', title: 'b', detail: '', severity: 'blocking', affectedModuleIds: [], evidenceRefs: [], handlingOptions: [{ id: 'h', label: 'x' }], resolvedByDecisionId: null },
      { id: '3', type: 'scope_overrun', basis: 'explicit_unknown', title: 'c', detail: '', severity: 'blocking', affectedModuleIds: [], evidenceRefs: [], handlingOptions: [{ id: 'h', label: 'x' }], resolvedByDecisionId: 'decision-1' },
    ] as never);
    expect(summary.total).toBe(3);
    expect(summary.blocking).toBe(1);
    expect(summary.label).toBe('3 个风险（1 个阻止提交）');
  });
});

describe('blocker batches — 1–3 cards per batch', () => {
  const blockers = Array.from({ length: 7 }, (_, index) => ({ id: `b-${index}`, status: 'open' })) as never[];
  it('splits into batches of at most 3 and reports remaining counts', () => {
    expect(blockerBatch(blockers, 0, 3)).toMatchObject({ total: 7, batchCount: 3, batchIndex: 0, moreCount: 4 });
    expect(blockerBatch(blockers, 0, 3).items.length).toBe(3);
    expect(blockerBatch(blockers, 1, 3).items.length).toBe(3);
    expect(blockerBatch(blockers, 2, 3).items.length).toBe(1);
    expect(blockerBatch(blockers, 99, 3).batchIndex).toBe(2);
  });

  it('ignores non-open blockers', () => {
    const mixed = [{ id: 'a', status: 'open' }, { id: 'b', status: 'cleared' }] as never[];
    expect(blockerBatch(mixed, 0, 3).total).toBe(1);
  });
});

describe('recipe accounting — deterministic shows 0 LLM calls', () => {
  it('never hides model calls', () => {
    expect(recipeRunAccounting('deterministic')).toContain('0 次 LLM 调用');
    expect(recipeRunAccounting('llm_assisted', 3)).toContain('3 次 LLM 调用');
    expect(recipeRunAccounting('cached_snapshot')).toContain('缓存复用');
  });
});

describe('format helpers', () => {
  it('formats step-based progress without fabricating success', () => {
    expect(formatStepProgress(2, 6)).toBe('已完成 2/6 个步骤（33%）');
    expect(formatStepProgress(9, 6)).toBe('已完成 6/6 个步骤（100%）');
    expect(formatStepProgress(null, 6)).toBe('步骤进度未知');
  });

  it('formats usage with estimated markers and unknown money', () => {
    const label = formatUsageSummary({
      modelRequests: 2,
      toolCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 200,
      usdCost: null,
    });
    expect(label).toContain('模型 2');
    expect(label).toContain('估算');
    expect(label).toContain('金额未知');
  });

  it('formats time and truncation', () => {
    expect(formatTimestamp('not-a-date')).toBe('—');
    expect(formatDuration(1500)).toBe('1.5 秒');
    expect(truncateText('abcdef', 4)).toBe('abc…');
    expect(truncateText('abc', 4)).toBe('abc');
  });
});
