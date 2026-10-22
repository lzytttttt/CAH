/**
 * Business language map: every enum has an explicit Chinese text label plus a
 * tonal hint. Colour is always paired with text (design 16.1 / MC "never
 * colour-only"). No game vocabulary (no HP/XP/level/combat) — only 业务语言.
 */
import type {
  Blocker,
  BlockerStatus,
  BlockerType,
  CapabilityStatus,
  CheckStatus,
  DiffEntry,
  EngineMode,
  ModuleState,
  PlanReviewPhase,
  PlanRisk,
  PlanRiskType,
  ProspectState,
  RecipeKind,
  RecipeStatus,
  ResolutionOption,
  RunState,
  Severity,
  SpatialNodeStatus,
  TrustLevel,
  ValidationLayer,
  ValidationReportStatus,
  ViewMode,
} from '@ca/contracts';
import type { ElevationLayer, PanelId } from '../state/viewStore';

export type Tone = 'neutral' | 'accent' | 'pending' | 'success' | 'danger' | 'prospect' | 'muted';

/* --------------------------------- runs --------------------------------- */

const RUN_STATE_LABELS: Record<RunState, string> = {
  CREATED: '已创建',
  PLANNING: '规划中',
  AWAITING_INPUT: '等待输入',
  READY: '计划就绪',
  RUNNING: '执行中',
  PAUSING: '暂停中',
  PAUSED: '已暂停',
  VALIDATING: '验证中',
  AWAITING_REVIEW: '待审阅',
  COMMITTING: '提交中',
  COMPLETED: '已完成',
  CANCELLING: '取消中',
  CANCELLED: '已取消',
  FAILED: '失败',
  INTERRUPTED: '已中断',
};

export function runStateLabel(state: RunState | string | null | undefined): string {
  if (!state) return '无运行';
  return RUN_STATE_LABELS[state as RunState] ?? `未知状态（${state}）`;
}

export function runStateTone(state: RunState | string | null | undefined): Tone {
  switch (state) {
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
      return 'danger';
    case 'AWAITING_INPUT':
    case 'AWAITING_REVIEW':
    case 'PAUSED':
      return 'pending';
    case 'RUNNING':
    case 'PLANNING':
    case 'VALIDATING':
    case 'COMMITTING':
    case 'PAUSING':
    case 'CANCELLING':
    case 'READY':
    case 'CREATED':
      return 'accent';
    case 'CANCELLED':
    case 'INTERRUPTED':
      return 'muted';
    default:
      return 'neutral';
  }
}

/* -------------------------------- modules -------------------------------- */

const MODULE_STATE_LABELS: Record<ModuleState, string> = {
  empty: '未开始',
  draft: '草稿',
  ready_for_review: '待审阅',
  accepted: '已接受',
  stale: '已过期',
  blocked: '受阻',
};

export function moduleStateLabel(state: ModuleState | string | null | undefined): string {
  if (!state) return '未知';
  return MODULE_STATE_LABELS[state as ModuleState] ?? `未知（${state}）`;
}

export function moduleStateTone(state: ModuleState | string | null | undefined): Tone {
  switch (state) {
    case 'accepted':
      return 'success';
    case 'ready_for_review':
    case 'blocked':
      return 'pending';
    case 'stale':
      return 'muted';
    case 'draft':
      return 'accent';
    default:
      return 'neutral';
  }
}

/* ------------------------------ spatial status ------------------------------ */

const SPATIAL_STATUS_LABELS: Record<SpatialNodeStatus, string> = {
  idle: '空闲',
  empty: '空',
  draft: '草稿',
  ready_for_review: '待审阅',
  accepted: '已接受',
  stale: '已过期',
  blocked: '受阻',
  running: '执行中',
  warning: '注意',
  failed: '失败',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  unknown: '未知',
};

export function spatialStatusLabel(status: SpatialNodeStatus | string | null | undefined): string {
  if (!status) return '未知';
  return SPATIAL_STATUS_LABELS[status as SpatialNodeStatus] ?? `未知（${status}）`;
}

export function spatialStatusTone(status: SpatialNodeStatus | string | null | undefined): Tone {
  switch (status) {
    case 'accepted':
    case 'completed':
      return 'success';
    case 'ready_for_review':
    case 'blocked':
    case 'paused':
      return 'pending';
    case 'warning':
      return 'accent';
    case 'failed':
      return 'danger';
    case 'running':
      return 'accent';
    case 'stale':
    case 'cancelled':
      return 'muted';
    default:
      return 'neutral';
  }
}

/* -------------------------------- layers -------------------------------- */

export function layerLabel(layer: ElevationLayer): string {
  switch (layer) {
    case 'global':
      return 'Z+1 全局';
    case 'execution':
      return 'Z0 执行';
    case 'evidence':
      return 'Z-1 证据';
  }
}

export function layerDescription(layer: ElevationLayer): string {
  switch (layer) {
    case 'global':
      return '目标、约束、模块依赖、产物骨架与阻塞摘要';
    case 'execution':
      return '中心成果、当前支线、局部修复与待接受差异';
    case 'evidence':
      return '原始资料、检索片段、工具结果与验证细节';
  }
}

/* ------------------------------ plan review ------------------------------ */

const PLAN_PHASE_LABELS: Record<PlanReviewPhase, string> = {
  idle: '空闲',
  planning: '正在生成计划',
  peeking: '计划预览',
  resolving: '处理待决问题',
  ready: '计划就绪',
  executing: '执行中',
  review: '成果审阅',
  failed: '失败',
};

export function planPhaseLabel(phase: PlanReviewPhase | string | null | undefined): string {
  if (!phase) return '未知阶段';
  return PLAN_PHASE_LABELS[phase as PlanReviewPhase] ?? `未知阶段（${phase}）`;
}

/* -------------------------------- prospects -------------------------------- */

const PROSPECT_STATE_LABELS: Record<ProspectState, string> = {
  proposed: '候选',
  missing_inputs: '缺少输入',
  ready: '可生成',
  generating: '生成中',
  review: '待审阅',
  accepted: '已接受',
  stale: '已过期',
};

export function prospectStateLabel(state: ProspectState | string): string {
  return PROSPECT_STATE_LABELS[state as ProspectState] ?? `未知（${state}）`;
}

export function prospectStateTone(state: ProspectState | string): Tone {
  switch (state) {
    case 'ready':
      return 'prospect';
    case 'accepted':
      return 'success';
    case 'missing_inputs':
      return 'pending';
    case 'generating':
    case 'review':
      return 'accent';
    case 'stale':
      return 'muted';
    default:
      return 'neutral';
  }
}

/* ------------------------------- validation ------------------------------- */

const VALIDATION_STATUS_LABELS: Record<ValidationReportStatus, string> = {
  pass: '通过',
  fail: '未通过',
  needs_review: '待复核',
};

export function validationStatusLabel(status: ValidationReportStatus | string | null | undefined): string {
  if (!status) return '无验证报告';
  return VALIDATION_STATUS_LABELS[status as ValidationReportStatus] ?? String(status);
}

export function validationStatusTone(status: ValidationReportStatus | string | null | undefined): Tone {
  switch (status) {
    case 'pass':
      return 'success';
    case 'fail':
      return 'danger';
    case 'needs_review':
      return 'pending';
    default:
      return 'neutral';
  }
}

const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  pass: '通过',
  fail: '失败',
  needs_review: '待复核',
  not_applicable: '不适用',
};

export function checkStatusLabel(status: CheckStatus | string): string {
  return CHECK_STATUS_LABELS[status as CheckStatus] ?? String(status);
}

export function checkStatusTone(status: CheckStatus | string): Tone {
  switch (status) {
    case 'pass':
      return 'success';
    case 'fail':
      return 'danger';
    case 'needs_review':
      return 'pending';
    default:
      return 'muted';
  }
}

const LAYER_LABELS: Record<ValidationLayer, string> = {
  L0: 'L0 协议',
  L1: 'L1 结构',
  L2: 'L2 证据',
  L3: 'L3 业务规则',
  L4: 'L4 人工审阅',
};

export function validationLayerLabel(layer: ValidationLayer | string): string {
  return LAYER_LABELS[layer as ValidationLayer] ?? String(layer);
}

/** True when a failed/needs-review check blocks commit (only L0–L3). */
export function isBlockingCheck(layer: ValidationLayer, status: CheckStatus): boolean {
  return layer !== 'L4' && (status === 'fail' || status === 'needs_review');
}

export function validationCountsLabel(counts: { pass: number; fail: number; needsReview: number; notApplicable: number }): string {
  return `通过 ${counts.pass} · 失败 ${counts.fail} · 待复核 ${counts.needsReview} · 不适用 ${counts.notApplicable}`;
}

/* -------------------------------- blockers -------------------------------- */

const BLOCKER_TYPE_LABELS: Record<BlockerType, string> = {
  info_missing: '信息缺失',
  constraint_conflict: '约束冲突',
  validation_failed: '验证失败',
  no_progress: '无进展',
  service_failure: '服务故障',
  permission_denied: '权限不足',
};

export function blockerTypeLabel(type: BlockerType | string): string {
  return BLOCKER_TYPE_LABELS[type as BlockerType] ?? String(type);
}

export function blockerTypeTone(type: BlockerType | string): Tone {
  switch (type) {
    case 'service_failure':
    case 'permission_denied':
      return 'danger';
    case 'no_progress':
      return 'pending';
    default:
      return 'pending';
  }
}

/** Technical blockers get recovery actions, never business-style choices. */
export function isTechnicalBlocker(type: BlockerType | string): boolean {
  return type === 'service_failure' || type === 'permission_denied';
}

const SEVERITY_LABELS: Record<Severity, string> = {
  info: '提示',
  warning: '警告',
  blocking: '阻止',
};

export function severityLabel(severity: Severity | string): string {
  return SEVERITY_LABELS[severity as Severity] ?? String(severity);
}

export function severityTone(severity: Severity | string): Tone {
  switch (severity) {
    case 'blocking':
      return 'danger';
    case 'warning':
      return 'pending';
    default:
      return 'neutral';
  }
}

const BLOCKER_STATUS_LABELS: Record<BlockerStatus, string> = {
  open: '待处理',
  resolved: '已处理',
  cleared: '已解除',
  cancelled: '已取消',
};

export function blockerStatusLabel(status: BlockerStatus | string): string {
  return BLOCKER_STATUS_LABELS[status as BlockerStatus] ?? String(status);
}

export function resolutionOptionKindLabel(kind: ResolutionOption['kind']): string {
  switch (kind) {
    case 'choose':
      return '选择';
    case 'text':
      return '补充文本';
    case 'bind_source':
      return '绑定资料';
    case 'confirm_mapping':
      return '确认映射';
    case 'exclude':
      return '排除异常';
  }
}

/** The 1–3 card batch rule for mechanism B (design 12.2). */
export interface BlockerBatch {
  items: Blocker[];
  total: number;
  batchCount: number;
  batchIndex: number;
  moreCount: number;
}

export function blockerBatch(blockers: readonly Blocker[], batchIndex: number, batchSize = 3): BlockerBatch {
  const open = blockers.filter((blocker) => blocker.status === 'open');
  const total = open.length;
  const batchCount = Math.max(1, Math.ceil(total / batchSize));
  const index = Math.min(Math.max(0, Math.floor(batchIndex)), batchCount - 1);
  const items = open.slice(index * batchSize, index * batchSize + batchSize);
  return { items, total, batchCount, batchIndex: index, moreCount: Math.max(0, total - (index + 1) * batchSize) };
}

export function affectedFieldsSummary(blocker: Blocker): string {
  const modules = blocker.affectedModuleIds.length;
  const steps = blocker.affectedSteps.length;
  const evidence = blocker.evidenceRefs.length;
  const parts: string[] = [];
  if (modules > 0) parts.push(`影响 ${modules} 个模块`);
  if (steps > 0) parts.push(`${steps} 个步骤`);
  if (evidence > 0) parts.push(`${evidence} 条证据`);
  return parts.join(' · ') || '未声明影响范围';
}

/* -------------------------------- plan risks -------------------------------- */

const RISK_TYPE_LABELS: Record<PlanRiskType, string> = {
  constraint_conflict: '约束冲突',
  missing_input: '输入缺失',
  permission: '权限限制',
  scope_overrun: '范围越界',
  budget: '预算风险',
  unverified_assumption: '未验证假设',
  irreversible_change: '不可逆修改',
  explicit_unknown: '明确未知',
};

export function riskTypeLabel(type: PlanRiskType | string): string {
  return RISK_TYPE_LABELS[type as PlanRiskType] ?? String(type);
}

export function riskBasisLabel(basis: PlanRisk['basis']): string {
  switch (basis) {
    case 'evidence':
      return '有证据依据';
    case 'constraint_conflict':
      return '约束冲突';
    case 'explicit_unknown':
      return '明确未知';
  }
}

export interface RiskSummary {
  total: number;
  blocking: number;
  label: string;
  blockingRisks: PlanRisk[];
}

/** Real risk counts; zero risks renders zero cards (never fabricate three). */
export function summarizeRisks(risks: readonly PlanRisk[] | null | undefined): RiskSummary {
  const list = risks ?? [];
  const blockingRisks = list.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null);
  const label = list.length === 0 ? '未发现风险' : `${list.length} 个风险（${blockingRisks.length} 个阻止提交）`;
  return { total: list.length, blocking: blockingRisks.length, label, blockingRisks };
}

/* -------------------------------- recipes -------------------------------- */

const RECIPE_STATUS_LABELS: Record<RecipeStatus, string> = {
  candidate: '候选',
  validated: '已验证',
  stale: '已过期',
  disabled: '已禁用',
};

export function recipeStatusLabel(status: RecipeStatus | string): string {
  return RECIPE_STATUS_LABELS[status as RecipeStatus] ?? String(status);
}

export function recipeStatusTone(status: RecipeStatus | string): Tone {
  switch (status) {
    case 'validated':
      return 'success';
    case 'candidate':
      return 'pending';
    case 'stale':
      return 'muted';
    case 'disabled':
      return 'danger';
    default:
      return 'neutral';
  }
}

const RECIPE_KIND_LABELS: Record<RecipeKind, string> = {
  deterministic: '确定性规则',
  llm_assisted: 'LLM 辅助',
  cached_snapshot: '缓存快照',
};

export function recipeKindLabel(kind: RecipeKind | string): string {
  return RECIPE_KIND_LABELS[kind as RecipeKind] ?? String(kind);
}

/** Accounting text that must never hide model calls (design 13.2, AC-12). */
export function recipeRunAccounting(kind: RecipeKind | string, llmCalls?: number | null): string {
  if (kind === 'deterministic') return '确定性执行 · 0 次 LLM 调用';
  if (kind === 'cached_snapshot') return '缓存复用 · 不重新生成，不计新 LLM 调用';
  if (llmCalls == null) return 'LLM 辅助 · 调用次数以运行账本为准';
  return `LLM 辅助 · 本次 ${llmCalls} 次 LLM 调用`;
}

/* -------------------------------- evidence -------------------------------- */

const TRUST_LABELS: Record<TrustLevel, string> = {
  user_provided: '用户提供',
  synthetic_demo: '合成演示',
  unknown: '来源未知',
};

export function trustLevelLabel(level: TrustLevel | string): string {
  return TRUST_LABELS[level as TrustLevel] ?? String(level);
}

export function availabilityLabel(value: 'available' | 'missing' | 'changed' | string): string {
  switch (value) {
    case 'available':
      return '可用';
    case 'missing':
      return '缺失';
    case 'changed':
      return '版本已变更';
    default:
      return String(value);
  }
}

export function availabilityTone(value: 'available' | 'missing' | 'changed' | string): Tone {
  switch (value) {
    case 'available':
      return 'success';
    case 'missing':
      return 'danger';
    case 'changed':
      return 'pending';
    default:
      return 'neutral';
  }
}

export function trustLevelTone(level: TrustLevel | string): Tone {
  return level === 'user_provided' ? 'success' : level === 'synthetic_demo' ? 'pending' : 'muted';
}

export function parseStatusLabel(status: 'parsed' | 'unsupported' | 'failed' | string): string {
  switch (status) {
    case 'parsed':
      return '已解析';
    case 'unsupported':
      return '格式不支持';
    case 'failed':
      return '解析失败';
    default:
      return String(status);
  }
}

export function sourceOriginLabel(origin: 'upload' | 'demo_seed' | 'task_package' | string): string {
  switch (origin) {
    case 'upload':
      return '本地上传';
    case 'demo_seed':
      return '演示种子';
    case 'task_package':
      return '任务包导入';
    default:
      return String(origin);
  }
}

/* -------------------------------- providers -------------------------------- */

export function adapterTypeLabel(adapter: 'openai_compatible' | 'anthropic_native' | 'openai_responses' | string): string {
  switch (adapter) {
    case 'openai_compatible':
      return 'OpenAI 兼容';
    case 'anthropic_native':
      return 'Anthropic 原生';
    case 'openai_responses':
      return 'OpenAI Responses';
    default:
      return String(adapter);
  }
}

const CAPABILITY_LABELS: Record<CapabilityStatus, string> = {
  verified: '已验证',
  unsupported: '不支持',
  unknown: '未知',
};

export function capabilityStatusLabel(status: CapabilityStatus | 'error' | string): string {
  if (status === 'error') return '错误';
  return CAPABILITY_LABELS[status as CapabilityStatus] ?? String(status);
}

export function capabilityStatusTone(status: string): Tone {
  switch (status) {
    case 'verified':
      return 'success';
    case 'unsupported':
      return 'muted';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function probeLabel(probe: string): string {
  switch (probe) {
    case 'auth_and_text':
      return '鉴权与基础文本';
    case 'streaming':
      return '流式输出';
    case 'tool_calling':
      return '工具调用';
    case 'structured_output':
      return '结构化输出';
    case 'usage':
      return '用量上报';
    default:
      return probe;
  }
}

export function controlConnectionLabel(status: 'configured' | 'unconfigured' | 'error' | 'unknown' | string): string {
  switch (status) {
    case 'configured':
      return '连接已配置';
    case 'unconfigured':
      return '未配置连接';
    case 'error':
      return '连接错误';
    default:
      return '连接状态未知';
  }
}

export function connectionPhaseLabel(phase: string): string {
  switch (phase) {
    case 'idle':
      return '未连接';
    case 'connecting':
      return '连接中';
    case 'connected':
      return '已连接';
    case 'reconnecting':
      return '重连中';
    case 'offline':
      return '离线';
    default:
      return phase;
  }
}

export function connectionPhaseTone(phase: string): Tone {
  switch (phase) {
    case 'connected':
      return 'success';
    case 'connecting':
    case 'reconnecting':
      return 'pending';
    case 'offline':
      return 'danger';
    default:
      return 'neutral';
  }
}

/* --------------------------------- modes --------------------------------- */

export function modeLabel(mode: EngineMode | ViewMode | string): string {
  switch (mode) {
    case 'demo':
      return '演示';
    case 'live':
      return '正式';
    case 'replay':
      return '历史回放';
    default:
      return String(mode);
  }
}

export function modeTone(mode: EngineMode | ViewMode | string): Tone {
  switch (mode) {
    case 'live':
      return 'success';
    case 'demo':
      return 'accent';
    case 'replay':
      return 'prospect';
    default:
      return 'neutral';
  }
}

/* ------------------------------- diff review ------------------------------- */

export function changeKindLabel(change: DiffEntry['change']): string {
  switch (change) {
    case 'added':
      return '新增';
    case 'removed':
      return '删除';
    case 'changed':
      return '修改';
    case 'unchanged':
      return '未变';
  }
}

export function diffStatsLabel(stats: { added: number; removed: number; changed: number; unchanged: number }): string {
  return `新增 ${stats.added} · 修改 ${stats.changed} · 删除 ${stats.removed} · 未变 ${stats.unchanged}`;
}

/* -------------------------------- panels -------------------------------- */

const PANEL_TITLES: Record<Exclude<PanelId, null>, string> = {
  plan: '计划预览与风险处理',
  repair: '局部修复',
  review: '差异审阅',
  versions: '版本历史',
  sources: '资料与证据',
  settings: '连接与工作区设置',
  export: '导出与导入',
  events: '事件诊断与回放',
  recipes: '配方与路径折叠',
  constraints: '约束与依赖',
};

export function panelTitle(panel: PanelId | null): string {
  return panel ? PANEL_TITLES[panel] : '';
}

/* -------------------------------- events -------------------------------- */

export function eventCategoryLabel(category: string): string {
  switch (category) {
    case 'plan':
      return '计划';
    case 'execution':
      return '执行';
    case 'tool':
      return '工具';
    case 'blocker':
      return '阻塞';
    case 'artifact':
      return '成果';
    case 'recipe':
      return '配方';
    case 'control':
      return '控制';
    case 'usage':
      return '消耗';
    case 'context':
      return '上下文';
    default:
      return category;
  }
}

export function eventTypeLabel(type: string): string {
  const [prefix, ...rest] = type.split('.');
  const action = rest.join('.');
  const prefixLabel =
    prefix === 'run'
      ? '运行'
      : prefix === 'plan'
        ? '计划'
        : prefix === 'step'
          ? '步骤'
          : prefix === 'model'
            ? '模型'
            : prefix === 'tool'
              ? '工具'
              : prefix === 'blocker'
                ? '阻塞'
                : prefix === 'input'
                  ? '输入'
                  : prefix === 'artifact'
                    ? '成果'
                    : prefix === 'validation'
                      ? '验证'
                      : prefix === 'recipe'
                        ? '配方'
                        : prefix === 'usage'
                          ? '消耗'
                          : prefix === 'budget'
                            ? '预算'
                            : prefix === 'context'
                              ? '上下文'
                              : prefix === 'provider'
                                ? '模型服务'
                                : prefix;
  const actionLabel =
    action === 'created'
      ? '已创建'
      : action === 'proposed'
        ? '已提出'
        : action === 'revised'
          ? '已修订'
          : action === 'ready'
            ? '就绪'
            : action === 'committed'
              ? '已提交'
              : action === 'started'
                ? '开始'
                : action === 'completed'
                  ? '完成'
                  : action === 'failed'
                    ? '失败'
                    : action === 'requested'
                      ? '请求'
                      : action === 'authorized'
                        ? '已授权'
                        : action === 'succeeded'
                          ? '成功'
                          : action === 'outcome_unknown'
                            ? '结果未知'
                            : action === 'detected'
                              ? '发现'
                              : action === 'resolved'
                                ? '已处理'
                                : action === 'cleared'
                                  ? '已解除'
                                  : action === 'patch_proposed'
                                    ? '候选修改'
                                    : action === 'accepted'
                                      ? '已接受'
                                      : action === 'stale'
                                        ? '过期'
                                        : action === 'restored'
                                          ? '已恢复'
                                          : action === 'validated'
                                            ? '已验证'
                                            : action === 'run_started'
                                              ? '开始运行'
                                              : action === 'state_changed'
                                                ? '状态变化'
                                                : action === 'queued'
                                                  ? '排队'
                                                  : action === 'paused'
                                                    ? '已暂停'
                                                    : action === 'resumed'
                                                      ? '已继续'
                                                      : action === 'cancel_requested'
                                                        ? '请求取消'
                                                        : action === 'cancelled'
                                                          ? '已取消'
                                                          : action === 'interrupted'
                                                            ? '已中断'
                                                            : action === 'updated'
                                                              ? '已更新'
                                                              : action === 'warning'
                                                                ? '警告'
                                                                : action === 'exhausted'
                                                                  ? '已用尽'
                                                                  : action === 'snapshot_created'
                                                                    ? '已创建快照'
                                                                    : action === 'error'
                                                                      ? '错误'
                                                                      : action;
  return `${prefixLabel}·${actionLabel}`;
}
