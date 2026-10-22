/**
 * Deterministic constraint/risk analysis.
 *
 * Rules (design sections 7.3, 11.1, 11.4, 12.1):
 * - Risk count is real: zero conflicts => zero risks. Risks are never invented
 *   to satisfy a UI expectation.
 * - Real conflicts between hard constraints are always `blocking`.
 * - Model-proposed risks are only kept when they carry valid evidence, match a
 *   deterministic constraint conflict, or are explicitly declared unknown.
 */
import {
  EvidenceRefSchema,
  PlanRiskSchema,
  type BudgetPolicy,
  type Constraint,
  type Decision,
  type EvidenceRef,
  type ModuleId,
  type PlanRisk,
  type Task,
  type SourceItem,
} from '@ca/contracts';

export interface ConstraintConflict {
  id: string;
  constraintIds: [string, string];
  kind: 'hard_hard' | 'hard_preference';
  title: string;
  description: string;
  possibleResolutions: string[];
}

interface ConflictRule {
  id: string;
  title: string;
  description: string;
  /** Keywords belonging to the "side A" constraint. */
  sideA: readonly string[];
  /** Keywords belonging to the "side B" constraint. */
  sideB: readonly string[];
  possibleResolutions: string[];
}

/**
 * Deterministic, explicit conflict rules. Adding a rule is a code change and a
 * test change — never a model guess. A rule fires only when two *different*
 * constraints each match one side and both are hard/preference constraints.
 */
const CONFLICT_RULES: readonly ConflictRule[] = [
  {
    id: 'CONFLICT-OFFLINE-VS-CLOUD',
    title: '完全离线部署与依赖云端实时模型冲突',
    description:
      '一条约束要求业务数据与模型推理完全留在客户内网（离线/私有化），另一条要求核心交互依赖云端实时大模型服务；两条同时作为首版硬约束无法成立。',
    sideA: ['完全离线', '离线私有化', '私有化部署', '不离开客户内网', '不离开内网', '断网可用', '纯离线'],
    sideB: ['云端实时', '依赖云端', '云端大模型', '在线服务', '云端服务', '云服务'],
    possibleResolutions: [
      '允许私有化部署中接入本地模型服务，把云端模型改为可选增强',
      '明确首版仅支持混合部署，离线能力降级为只读与确定性配方',
      '拆分两个交付版本：离线版与云端版分别验收',
    ],
  },
];

function isActive(constraint: Constraint): boolean {
  return constraint.status !== 'waived' && constraint.status !== 'conflicted';
}

function matchesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/** Detect real constraint conflicts with deterministic keyword rules. */
export function detectConstraintConflicts(constraints: readonly Constraint[]): ConstraintConflict[] {
  const conflicts: ConstraintConflict[] = [];
  const active = constraints.filter(isActive);
  for (const rule of CONFLICT_RULES) {
    for (const sideA of active) {
      if (!matchesAny(sideA.text, rule.sideA)) continue;
      for (const sideB of active) {
        if (sideB.id === sideA.id) continue;
        if (!matchesAny(sideB.text, rule.sideB)) continue;
        // Deduplicate symmetric pairs.
        if (conflicts.some((c) => c.constraintIds.includes(sideA.id) && c.constraintIds.includes(sideB.id))) continue;
        const hardish = sideA.kind === 'hard' && sideB.kind === 'hard' ? 'hard_hard' : 'hard_preference';
        conflicts.push({
          id: rule.id,
          constraintIds: [sideA.id, sideB.id],
          kind: hardish,
          title: rule.title,
          description: `${rule.description}\n约束 A（${sideA.id}）：${sideA.text}\n约束 B（${sideB.id}）：${sideB.text}`,
          possibleResolutions: [...rule.possibleResolutions],
        });
      }
    }
  }
  return conflicts;
}

/** Decision keys used for conflict handling; one decision resolves one conflict. */
export function constraintConflictDecisionKey(conflict: ConstraintConflict): string {
  return `constraint_conflict:${conflict.id}:${conflict.constraintIds.join('+')}`;
}

export function resolvedConflictKeys(decisions: readonly Decision[]): Set<string> {
  return new Set(decisions.map((decision) => decision.key));
}

export interface RiskAnalysisInput {
  task: Task;
  moduleId: ModuleId;
  intent: string;
  sources: readonly SourceItem[];
  planStepCount: number;
  budget: BudgetPolicy;
  conflicts: readonly ConstraintConflict[];
  decisions: readonly Decision[];
  /** True when the module (or task) requires evidence for factual claims. */
  evidenceRequired: boolean;
}

export function deterministicRisks(input: RiskAnalysisInput): PlanRisk[] {
  const risks: PlanRisk[] = [];
  const resolved = resolvedConflictKeys(input.decisions);
  for (const conflict of input.conflicts) {
    if (resolved.has(constraintConflictDecisionKey(conflict))) continue;
    const hardBlocking = conflict.kind === 'hard_hard';
    risks.push({
      id: `det_${conflict.id}`,
      type: 'constraint_conflict',
      basis: 'constraint_conflict',
      title: `硬约束冲突：${conflict.title}`,
      detail: conflict.description,
      severity: hardBlocking ? 'blocking' : 'warning',
      affectedModuleIds: [input.moduleId],
      evidenceRefs: [],
      handlingOptions: conflict.possibleResolutions.map((resolution, index) => ({
        id: `o${index + 1}`,
        label: resolution,
        description: '由用户明确选择处理方式后记录决策；点击“忽略”不能消除冲突。',
      })),
      resolvedByDecisionId: null,
    });
  }

  // Missing input: only when the intent explicitly refers to materials/attachments.
  const refersToMaterials = /(根据|基于|依据|读取|分析|整理).{0,12}(资料|文件|附件|文档|数据|表格|素材)/.test(input.intent);
  if (refersToMaterials && input.sources.length === 0) {
    risks.push({
      id: 'det_missing_input',
      type: 'missing_input',
      basis: 'explicit_unknown',
      title: '目标引用了资料，但当前任务没有已绑定资料',
      detail: '意图中提到要根据资料/附件处理，但任务尚未导入任何来源。请先绑定资料，或明确按“无资料”处理。',
      severity: 'warning',
      affectedModuleIds: [input.moduleId],
      evidenceRefs: [],
      handlingOptions: [
        { id: 'bind_source', label: '绑定资料后再规划', description: '上传或选择来源文件。' },
        { id: 'proceed_without_sources', label: '按无资料处理', description: '只使用意图中提供的信息。' },
      ],
      resolvedByDecisionId: null,
    });
  }

  // Budget: the plan itself must fit inside the model request budget.
  if (input.planStepCount > input.budget.maxModelRequests) {
    risks.push({
      id: 'det_budget_steps',
      type: 'budget',
      basis: 'explicit_unknown',
      title: `计划步骤数（${input.planStepCount}）超过模型请求预算（${input.budget.maxModelRequests}）`,
      detail: '按当前步骤数执行会耗尽模型请求预算。请减少步骤、合并步骤，或由用户显式提高预算。',
      severity: 'warning',
      affectedModuleIds: [input.moduleId],
      evidenceRefs: [],
      handlingOptions: [
        { id: 'reduce_steps', label: '减少/合并计划步骤', description: '在不降低交付质量的前提下压缩计划。' },
        { id: 'raise_budget', label: '由用户显式提高预算', description: '预算只能由用户操作提高，模型不得自行提高。' },
      ],
      resolvedByDecisionId: null,
    });
  }
  return risks;
}

export interface ModelRiskFilterContext {
  conflicts: readonly ConstraintConflict[];
  moduleId: ModuleId;
  /** Deterministic evidence check against real SourceSpan/artifact/tool refs. */
  isEvidenceRefValid: (ref: EvidenceRef) => boolean;
}

export interface ModelRiskFilterResult {
  risks: PlanRisk[];
  dropped: number;
}

/** Filter model risks down to those with a real basis (never fabricate). */
export function filterModelRisks(rawRisks: readonly unknown[], context: ModelRiskFilterContext): ModelRiskFilterResult {
  const kept: PlanRisk[] = [];
  let dropped = 0;
  for (const raw of rawRisks) {
    const parsed = PlanRiskSchema.safeParse(raw);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const risk = parsed.data;
    const evidence: EvidenceRef[] = [];
    for (const candidate of risk.evidenceRefs) {
      const ref = EvidenceRefSchema.safeParse(candidate);
      if (ref.success && context.isEvidenceRefValid(ref.data)) evidence.push(ref.data);
    }
    if (risk.basis === 'evidence') {
      if (evidence.length === 0) {
        dropped += 1;
        continue;
      }
      kept.push({ ...risk, evidenceRefs: evidence, affectedModuleIds: normalizeModuleIds(risk.affectedModuleIds, context.moduleId) });
      continue;
    }
    if (risk.basis === 'constraint_conflict') {
      const hasMatchingConflict = context.conflicts.some((conflict) =>
        risk.detail.includes(conflict.constraintIds[0]) || risk.detail.includes(conflict.constraintIds[1]),
      );
      if (!hasMatchingConflict) {
        dropped += 1;
        continue;
      }
      kept.push({ ...risk, evidenceRefs: evidence, affectedModuleIds: normalizeModuleIds(risk.affectedModuleIds, context.moduleId) });
      continue;
    }
    // explicit_unknown: keep, but an unknown must never block commit by itself.
    const type = risk.type === 'constraint_conflict' ? 'explicit_unknown' : risk.type;
    kept.push({
      ...risk,
      type,
      basis: 'explicit_unknown',
      severity: risk.severity === 'blocking' ? 'warning' : risk.severity,
      evidenceRefs: evidence,
      affectedModuleIds: normalizeModuleIds(risk.affectedModuleIds, context.moduleId),
    });
  }
  return { risks: dedupeRisks(kept), dropped };
}

function normalizeModuleIds(ids: readonly ModuleId[], fallback: ModuleId): ModuleId[] {
  if (ids.length === 0) return [fallback];
  return [...new Set(ids)].slice(0, 8);
}

function dedupeRisks(risks: readonly PlanRisk[]): PlanRisk[] {
  const seen = new Set<string>();
  const out: PlanRisk[] = [];
  for (const risk of risks) {
    const key = `${risk.type}::${risk.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(risk);
  }
  return out;
}

/** Merge deterministic and filtered model risks, keeping stable ids. */
export function mergeRisks(deterministic: readonly PlanRisk[], model: readonly PlanRisk[]): PlanRisk[] {
  const usedIds = new Set(deterministic.map((risk) => risk.id));
  const merged = [...deterministic];
  for (const risk of model) {
    let id = risk.id;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${risk.id}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    merged.push({ ...risk, id });
  }
  return merged.slice(0, 32);
}

/** Blocking risks that are not resolved by a recorded decision. */
export function unresolvedBlockingRisks(risks: readonly PlanRisk[]): PlanRisk[] {
  return risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null);
}
