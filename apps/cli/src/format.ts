/**
 * Human-readable rendering. `--json` uses the raw typed responses instead, so
 * nothing here is involved in scriptable output. Text labels are always shown
 * (never color-only), and step progress is reported as real completed/total
 * counts — the CLI never fabricates a percentage.
 */
import type {
  Blocker,
  BudgetUsage,
  CapabilityReport,
  ContentDiff,
  EvidenceRef,
  ExportResponse,
  ModuleView,
  PatchReviewResponse,
  Plan,
  PlanRisk,
  Recipe,
  RecipeKind,
  RecipeRunResult,
  ResolutionOption,
  RunDetailResponse,
  TaskListResponse,
  TaskSnapshot,
  ValidationReport,
} from '@ca/contracts';

/* ------------------------------------------------------------------ */
/* Text layout helpers                                                 */
/* ------------------------------------------------------------------ */

const WIDE_CHAR = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function charWidth(char: string): number {
  return WIDE_CHAR.test(char) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of Array.from(text)) width += charWidth(char);
  return width;
}

export function padEnd(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

export function truncate(text: string, max: number, suffix = '…'): string {
  if (max <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  // Count wide chars so the visual width stays close to `max`.
  let width = 0;
  let index = 0;
  for (; index < chars.length; index += 1) {
    width += charWidth(chars[index]!);
    if (width > max) break;
  }
  return `${chars.slice(0, Math.max(0, index - 1)).join('')}${suffix}`;
}

export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return headers.join('  ');
  const all = [headers, ...rows.map((row) => row.map((cell) => String(cell)))];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => displayWidth(row[column] ?? ''))));
  return all.map((row) => row.map((cell, column) => padEnd(cell ?? '', widths[column]!)).join('  ').trimEnd()).join('\n');
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '-';
  return id.length <= length ? id : `${id.slice(0, length)}…`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function formatUsd(value: number | null | undefined): string {
  return value == null ? '金额未知' : `$${value.toFixed(4)}`;
}

export function heading(text: string): string {
  return `== ${text} ==`;
}

/* ------------------------------------------------------------------ */
/* State labels                                                        */
/* ------------------------------------------------------------------ */

const RUN_STATE_LABELS: Record<string, string> = {
  CREATED: '已创建',
  PLANNING: '规划中',
  AWAITING_INPUT: '等待输入',
  READY: '待提交',
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

export function runStateLabel(state: string | null | undefined): string {
  if (!state) return '-';
  const label = RUN_STATE_LABELS[state];
  return label ? `${state}（${label}）` : state;
}

const MODULE_STATE_LABELS: Record<string, string> = {
  empty: '空',
  draft: '草稿',
  ready_for_review: '待审阅',
  accepted: '已接受',
  stale: '已过期',
  blocked: '阻塞',
};

export function moduleStateLabel(state: string | null | undefined): string {
  if (!state) return '-';
  return MODULE_STATE_LABELS[state] ?? state;
}

const PATCH_STATUS_LABELS: Record<string, string> = {
  proposed: '待审阅',
  accepted: '已接受',
  rejected: '已拒绝',
  superseded: '已被取代',
  conflicted: '冲突',
};

export function patchStatusLabel(status: string | null | undefined): string {
  if (!status) return '-';
  return PATCH_STATUS_LABELS[status] ?? status;
}

const VALIDATION_STATUS_LABELS: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  needs_review: '待复核',
};

export function validationStatusLabel(status: string | null | undefined): string {
  if (!status) return '-';
  return VALIDATION_STATUS_LABELS[status] ?? status;
}

const CHECK_STATUS_LABELS: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  needs_review: '待复核',
  not_applicable: '不适用',
};

const LAYER_LABELS: Record<string, string> = {
  L0: '协议',
  L1: '结构',
  L2: '证据',
  L3: '业务规则',
  L4: '人工审阅',
};

export function checkStatusLabel(status: string): string {
  return CHECK_STATUS_LABELS[status] ?? status;
}

export function layerLabel(layer: string): string {
  return LAYER_LABELS[layer] ?? layer;
}

const BLOCKER_TYPE_LABELS: Record<string, string> = {
  info_missing: '缺少信息',
  constraint_conflict: '约束冲突',
  validation_failed: '验证未通过',
  no_progress: '无进展',
  service_failure: '服务故障',
  permission_denied: '权限不足',
};

export function blockerTypeLabel(type: string): string {
  return BLOCKER_TYPE_LABELS[type] ?? type;
}

const SEVERITY_LABELS: Record<string, string> = {
  info: '提示',
  warning: '警告',
  blocking: '阻止',
};

export function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity] ?? severity;
}

const PROBE_STATUS_LABELS: Record<string, string> = {
  verified: '已验证',
  unsupported: '不支持',
  unknown: '未知',
  error: '出错',
};

export function probeStatusLabel(status: string): string {
  return PROBE_STATUS_LABELS[status] ?? status;
}

const CAPABILITY_LABELS: Record<string, string> = {
  verified: '已验证',
  unsupported: '不支持',
  unknown: '未知',
};

export function capabilityLabel(status: string): string {
  return CAPABILITY_LABELS[status] ?? status;
}

const RECIPE_STATUS_LABELS: Record<string, string> = {
  candidate: '候选',
  validated: '已验证',
  stale: '已过期',
  disabled: '已禁用',
};

export function recipeStatusLabel(status: string): string {
  return RECIPE_STATUS_LABELS[status] ?? status;
}

const RECIPE_KIND_LABELS: Record<string, string> = {
  deterministic: '确定性',
  llm_assisted: 'LLM 辅助',
  cached_snapshot: '缓存快照',
};

export function recipeKindLabel(kind: string): string {
  return RECIPE_KIND_LABELS[kind] ?? kind;
}

/* ------------------------------------------------------------------ */
/* Budget, evidence, blockers                                          */
/* ------------------------------------------------------------------ */

export function formatBudgetUsage(usage: BudgetUsage | null | undefined): string {
  if (!usage) return '暂无预算计量';
  const input = usage.inputTokens > 0 ? `${usage.inputTokens}` : `${usage.estimatedInputTokens}（估算）`;
  const output = usage.outputTokens > 0 ? `${usage.outputTokens}` : `${usage.estimatedOutputTokens}（估算）`;
  return [
    `模型请求 ${usage.modelRequests}`,
    `工具调用 ${usage.toolCalls}`,
    `token 入 ${input} / 出 ${output}`,
    formatUsd(usage.usdCost),
    `活跃时长 ${formatDurationMs(usage.elapsedActiveMs)}`,
  ].join(' · ');
}

export function locatorSummary(ref: EvidenceRef): string {
  if (ref.kind !== 'source_span') return '';
  const locator = ref.span.locator;
  switch (locator.kind) {
    case 'text_lines':
      return `行 ${locator.startLine}-${locator.endLine}`;
    case 'csv_rows':
      return `CSV 行 ${locator.rowNumbers.slice(0, 5).join(',')}${locator.rowNumbers.length > 5 ? '…' : ''}`;
    case 'csv_key':
      return `CSV ${locator.primaryKeyColumn}=${locator.primaryKeyValue}`;
    case 'json_pointer':
      return `JSON ${locator.pointer}`;
  }
}

export function formatEvidenceRef(ref: EvidenceRef, excerptChars = 120): string {
  switch (ref.kind) {
    case 'source_span':
      return `资料 ${shortId(ref.span.sourceId)}@v${ref.span.version} ${locatorSummary(ref)}：${truncate(ref.span.excerpt, excerptChars)}`;
    case 'artifact_version':
      return `成果版本 ${shortId(ref.versionId)}（模块 ${shortId(ref.moduleId)}）`;
    case 'user_assumption':
      return `用户假设 ${ref.assumptionId}：${truncate(ref.text, excerptChars)}`;
    case 'tool_result':
      return `工具结果 ${shortId(ref.toolResult.toolCallId)}：${truncate(ref.toolResult.summary, excerptChars)}`;
  }
}

export function resolutionHint(blocker: Blocker, runId: string | null, bin = 'cognitive-atrium'): string[] {
  const run = runId ?? '<runId>';
  const lines: string[] = [];
  for (const option of blocker.resolutions) {
    switch (option.kind) {
      case 'choose': {
        const choices = option.options.map((choice) => `--value ${JSON.stringify(choice.value)}（${choice.label}）`).join(' / ');
        lines.push(`    ${bin} run resolve ${run} --blocker ${blocker.id} --option ${option.id} ${choices}`);
        break;
      }
      case 'text':
        lines.push(
          `    ${bin} run resolve ${run} --blocker ${blocker.id} --option ${option.id} --value "文本"` +
            (option.required ? '（必填）' : '（可选）') +
            (option.multiline ? '（可先用编辑器写入文件，再用 --value-file 传入）' : ''),
        );
        break;
      case 'bind_source':
        lines.push(`    ${bin} run resolve ${run} --blocker ${blocker.id} --option ${option.id} --source-id <资料ID> --source-version <版本号>`);
        lines.push(`    （先用 ${bin} source import <taskId> --file <路径> 上传资料）`);
        break;
      case 'confirm_mapping':
        lines.push(`    ${bin} run resolve ${run} --blocker ${blocker.id} --option ${option.id} --value '{"confirmed":true}'`);
        break;
      case 'exclude':
        lines.push(
          `    ${bin} run resolve ${run} --blocker ${blocker.id} --option ${option.id} --value '{"itemRef":"${option.itemRef || '<条目引用>'}"}'`,
        );
        break;
    }
  }
  return lines;
}

export function renderResolutionOption(option: ResolutionOption): string[] {
  const head = `  [${option.kind}] ${option.id}：${option.label}`;
  const lines = [head];
  if (option.detail) lines.push(`    说明：${option.detail}`);
  if (option.kind === 'choose') {
    for (const choice of option.options) {
      lines.push(`    选项 ${JSON.stringify(choice.value)}：${choice.label}${choice.description ? ` — ${choice.description}` : ''}`);
    }
  } else if (option.kind === 'text') {
    lines.push(`    最多 ${option.maxChars} 字${option.required ? '，必填' : '，可选'}${option.placeholder ? `；示例：${option.placeholder}` : ''}`);
  } else if (option.kind === 'bind_source') {
    lines.push(`    接受类型：${option.acceptsMime.length ? option.acceptsMime.join(', ') : '不限'}${option.purpose ? `；用途：${option.purpose}` : ''}`);
  } else if (option.kind === 'confirm_mapping') {
    for (const pair of option.mappingPreview.slice(0, 10)) {
      lines.push(`    映射 ${pair.from} → ${pair.to}${pair.note ? `（${pair.note}）` : ''}`);
    }
  } else if (option.kind === 'exclude') {
    lines.push(`    排除条目：${option.itemLabel}${option.itemRef ? `（${option.itemRef}）` : ''}`);
  }
  return lines;
}

export function renderBlocker(blocker: Blocker, runId: string | null, bin = 'cognitive-atrium'): string[] {
  const lines = [
    `- [${severityLabel(blocker.severity)}] ${blockerTypeLabel(blocker.type)} ${blocker.id}`,
    `  ${blocker.title}`,
    `  说明：${blocker.detail}`,
  ];
  if (blocker.affectedModuleIds.length) lines.push(`  受影响模块：${blocker.affectedModuleIds.map((id) => shortId(id)).join(', ')}`);
  if (blocker.evidenceRefs.length) {
    lines.push('  证据：');
    for (const ref of blocker.evidenceRefs.slice(0, 5)) lines.push(`    - ${formatEvidenceRef(ref)}`);
  }
  lines.push('  处理方式：');
  for (const option of blocker.resolutions) lines.push(...renderResolutionOption(option));
  const hints = resolutionHint(blocker, runId, bin);
  if (hints.length) {
    lines.push('  命令示例：');
    lines.push(...hints);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Plan / validation / runs                                            */
/* ------------------------------------------------------------------ */

export function renderPlan(plan: Plan, indent = ''): string[] {
  const lines: string[] = [];
  lines.push(`${indent}计划 v${plan.version}：${plan.goal}`);
  lines.push(`${indent}  步骤 ${plan.steps.length} 个：${plan.steps.map((step) => `${step.id} ${step.title}（${step.kind}${step.toolId ? `:${step.toolId}` : ''}）`).slice(0, 12).join('；')}${plan.steps.length > 12 ? '…' : ''}`);
  const tools = plan.tools.map((tool) => `${tool.toolId}(${tool.effect})`).join('、');
  lines.push(`${indent}  工具：${tools || '无'}`);
  lines.push(`${indent}  预算：模型 ${plan.budget.maxModelRequests} 次 / 工具 ${plan.budget.maxToolCalls} 次 / 输出 ${plan.budget.maxOutputTokens} tokens`);
  const blocking = plan.risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null);
  lines.push(`${indent}  风险 ${plan.risks.length} 个（${blocking.length} 个阻止提交）`);
  for (const risk of plan.risks.slice(0, 8)) {
    lines.push(`${indent}    - [${severityLabel(risk.severity)}] ${risk.title}（${risk.type}）${risk.resolvedByDecisionId ? '（已处理）' : ''}`);
    if (risk.detail) lines.push(`${indent}      ${truncate(risk.detail, 200)}`);
  }
  if (plan.openQuestions.length) {
    lines.push(`${indent}  待确认问题 ${plan.openQuestions.length} 个：`);
    for (const question of plan.openQuestions.slice(0, 8)) {
      lines.push(`${indent}    - ${question.question}${question.blocking ? '（阻止执行）' : ''}`);
    }
  }
  if (plan.assumptions.length) {
    lines.push(`${indent}  假设 ${plan.assumptions.length} 个：${plan.assumptions.map((item) => truncate(item.text, 80)).join('；')}`);
  }
  lines.push(`${indent}  提示词版本：${plan.promptVersion}`);
  return lines;
}

export function renderValidationReport(report: ValidationReport, indent = ''): string[] {
  const counts = { pass: 0, fail: 0, needs_review: 0, not_applicable: 0 };
  for (const check of report.checks) counts[check.status] += 1;
  const lines = [
    `${indent}验证报告 ${report.id}：${validationStatusLabel(report.status)}`,
    `${indent}  检查 ${report.checks.length} 项：通过 ${counts.pass} / 失败 ${counts.fail} / 待复核 ${counts.needs_review} / 不适用 ${counts.not_applicable}`,
    `${indent}  候选哈希：${report.candidateHash}`,
    `${indent}  验证器：${report.validatorVersion} · ${report.createdAt}`,
  ];
  if (report.summary) lines.push(`${indent}  摘要：${truncate(report.summary, 400)}`);
  lines.push(`${indent}  检查明细：`);
  for (const check of report.checks.slice(0, 20)) {
    lines.push(`${indent}    [${check.layer}/${check.code}] ${checkStatusLabel(check.status)} ${check.title}${check.status === 'pass' || check.status === 'not_applicable' ? '' : `：${truncate(check.detail, 300)}`}`);
  }
  if (report.checks.length > 20) lines.push(`${indent}    … 其余 ${report.checks.length - 20} 项检查未显示`);
  const findings = report.checks.filter((check) => check.layer !== 'L4' && (check.status === 'fail' || check.status === 'needs_review'));
  if (findings.length) {
    lines.push(`${indent}  阻断项：`);
    for (const check of findings.slice(0, 10)) {
      lines.push(`${indent}    [${check.layer}/${check.code}] ${check.title}：${truncate(check.detail || checkStatusLabel(check.status), 400)}`);
      for (const ref of check.evidenceRefs.slice(0, 3)) lines.push(`${indent}      证据：${formatEvidenceRef(ref)}`);
    }
  }
  const review = report.checks.filter((check) => check.layer === 'L4' && check.status !== 'not_applicable');
  if (review.length) {
    lines.push(`${indent}  人工审阅项：`);
    for (const check of review.slice(0, 6)) lines.push(`${indent}    [L4/${check.code}] ${checkStatusLabel(check.status)} ${check.title}：${truncate(check.detail, 300)}`);
  }
  return lines;
}

export interface RunProgress {
  completedSteps: number;
  totalSteps: number;
  failedSteps: number;
  runningStep: string | null;
  activeStepTitle: string | null;
}

export function runProgress(detail: RunDetailResponse): RunProgress {
  const totalSteps = detail.steps.length;
  let completedSteps = 0;
  let failedSteps = 0;
  let runningStep: string | null = null;
  for (const step of detail.steps) {
    if (step.status === 'completed') completedSteps += 1;
    else if (step.status === 'failed') failedSteps += 1;
    else if (step.status === 'running') runningStep = step.title;
  }
  const active = detail.steps.find((step) => step.status === 'running')
    ?? [...detail.steps].reverse().find((step) => step.status === 'completed')
    ?? null;
  return {
    completedSteps,
    totalSteps,
    failedSteps,
    runningStep,
    activeStepTitle: runningStep ?? (active ? active.title : null),
  };
}

export function renderRunDetail(detail: RunDetailResponse, options: { serverUrl: string }): string[] {
  const run = detail.run;
  const progress = runProgress(detail);
  const lines: string[] = [];
  lines.push(heading(`运行 ${run.runId}`));
  lines.push(`  状态：${runStateLabel(run.state)}`);
  lines.push(`  任务：${run.taskId}   模块：${run.moduleId}`);
  lines.push(`  尝试：${run.attempt}   计划版本：${run.planVersion}   上下文快照：${shortId(run.contextSnapshotId)}`);
  lines.push(`  创建：${formatTimestamp(run.createdAt)}   更新：${formatTimestamp(run.updatedAt)}${run.startedAt ? `   开始：${formatTimestamp(run.startedAt)}` : ''}${run.finishedAt ? `   结束：${formatTimestamp(run.finishedAt)}` : ''}`);
  if (progress.totalSteps > 0) {
    lines.push(
      `  步骤：${progress.completedSteps}/${progress.totalSteps} 完成${progress.failedSteps ? `，${progress.failedSteps} 失败` : ''}` +
        (progress.runningStep ? `；进行中：${progress.runningStep}` : ''),
    );
  } else {
    lines.push('  步骤：尚未生成执行步骤');
  }
  lines.push(`  预算：${formatBudgetUsage(run.budgetUsage)}`);
  if (detail.plan) {
    lines.push(...renderPlan(detail.plan, '  '));
  }
  if (detail.contextSnapshot) {
    const snapshot = detail.contextSnapshot;
    lines.push(`  上下文快照：${snapshot.fragments.length} 个片段，估算输入 ${snapshot.estimatedInputTokens} tokens，省略 ${snapshot.omitted.length} 项`);
  }
  const openBlockers = detail.blockers.filter((blocker) => blocker.status === 'open');
  if (openBlockers.length) {
    lines.push(`  阻塞 ${openBlockers.length} 个（需要人工输入，不会自动继续）：`);
    for (const blocker of openBlockers) lines.push(...renderBlocker(blocker, run.runId).map((line) => `  ${line}`));
  } else {
    lines.push('  阻塞：无');
  }
  if (detail.validationReport) {
    lines.push(...renderValidationReport(detail.validationReport, '  '));
  }
  if (run.error && typeof run.error === 'object') {
    const error = run.error as { code?: unknown; message?: unknown; retryable?: unknown; stage?: unknown };
    lines.push(`  错误：${String(error.code ?? 'error')} ${String(error.message ?? '')}${error.stage ? `（阶段 ${String(error.stage)}）` : ''}${error.retryable === true ? '（可重试）' : ''}`);
  }
  if (run.interrupted && typeof run.interrupted === 'object') {
    const interrupted = run.interrupted as { reason?: unknown; lastCheckpointId?: unknown; unclearToolCalls?: unknown };
    const unclear = Array.isArray(interrupted.unclearToolCalls) ? interrupted.unclearToolCalls.length : 0;
    lines.push(`  中断：原因 ${String(interrupted.reason ?? 'unknown')}，最后检查点 ${shortId(String(interrupted.lastCheckpointId ?? ''))}，结果不明工具调用 ${unclear} 个（不会自动重放）`);
  }
  lines.push(`  Web 工作台：${uiLink(options.serverUrl, { taskId: run.taskId, runId: run.runId })}`);
  lines.push('  下一步：');
  for (const line of nextStepHints(detail)) lines.push(`    ${line}`);
  return lines;
}

export function nextStepHints(detail: RunDetailResponse): string[] {
  const run = detail.run;
  const id = run.runId;
  const openBlockers = detail.blockers.filter((blocker) => blocker.status === 'open');
  if (openBlockers.length) {
    const first = openBlockers[0]!;
    return [
      `解决阻塞：cognitive-atrium run resolve ${id} --blocker ${first.id} --option <optionId> ...`,
      `查看完整阻塞：cognitive-atrium run status ${id}`,
    ];
  }
  switch (run.state) {
    case 'PLANNING':
      return [`等待规划完成：cognitive-atrium run status ${id} --watch`];
    case 'READY':
      return [`提交已审阅计划：cognitive-atrium run commit ${id}`];
    case 'RUNNING':
    case 'PAUSING':
    case 'VALIDATING':
    case 'COMMITTING':
      return [`查看进度：cognitive-atrium run status ${id} --watch`, `跟踪事件：cognitive-atrium events tail ${run.taskId} --run ${id}`];
    case 'PAUSED':
      return [`继续运行：cognitive-atrium run resume ${id}`];
    case 'INTERRUPTED':
      return [`核对后继续：cognitive-atrium run resume ${id}`, `查看事件：cognitive-atrium events tail ${run.taskId} --run ${id}`];
    case 'AWAITING_REVIEW':
      return [
        `查看候选补丁：cognitive-atrium task status ${run.taskId}`,
        `接受成果：cognitive-atrium artifact accept <patchId> --validation-report <validationReportId>`,
      ];
    case 'COMPLETED':
      return [`查看任务：cognitive-atrium task status ${run.taskId}`, `导出成果：cognitive-atrium task export ${run.taskId} --format markdown --out ./out`];
    case 'CANCELLED':
      return [`草稿已保留，正式版本未改变。查看任务：cognitive-atrium task status ${run.taskId}`];
    case 'FAILED':
      return [`查看失败原因：cognitive-atrium run status ${id}`, `重新开始：cognitive-atrium run start ${run.taskId} --module ${run.moduleId} --intent "<意图>"`];
    default:
      return [`查看任务：cognitive-atrium task status ${run.taskId}`];
  }
}

/* ------------------------------------------------------------------ */
/* Patch review                                                        */
/* ------------------------------------------------------------------ */

export function renderDiff(diff: ContentDiff, options: { full: boolean }): string[] {
  const lines: string[] = [];
  lines.push(
    `  差异：新增 ${diff.stats.added} / 删除 ${diff.stats.removed} / 修改 ${diff.stats.changed} / 未变 ${diff.stats.unchanged}`,
  );
  const entries = diff.entries.filter((entry) => entry.change !== 'unchanged');
  if (entries.length === 0) {
    lines.push('  没有内容变化（候选与当前版本一致）');
    return lines;
  }
  const excerptChars = options.full ? 4000 : 160;
  for (const entry of entries.slice(0, 40)) {
    lines.push(`  - ${entry.change} [${entry.sectionId ?? '-'}] ${entry.title}${entry.summary ? `：${entry.summary}` : ''}`);
    if (entry.beforeExcerpt) lines.push(`      前：${truncate(entry.beforeExcerpt.replace(/\n/g, ' ⏎ '), excerptChars)}`);
    if (entry.afterExcerpt) lines.push(`      后：${truncate(entry.afterExcerpt.replace(/\n/g, ' ⏎ '), excerptChars)}`);
  }
  if (entries.length > 40) lines.push(`  … 其余 ${entries.length - 40} 条差异未显示（--full 显示更多内容）`);
  return lines;
}

export function renderPatchReview(review: PatchReviewResponse, options: { full: boolean }): string[] {
  const patch = review.patch;
  const lines: string[] = [];
  lines.push(heading(`补丁 ${patch.id}`));
  lines.push(`  状态：${patchStatusLabel(patch.status)}   模块：${patch.moduleId}（${patch.moduleKind}）`);
  lines.push(`  运行：${patch.runId}   任务：${patch.taskId}`);
  lines.push(`  基础版本：${patch.baseVersionId ?? '（无，首次写入）'}`);
  lines.push(`  候选哈希：${patch.candidateHash}`);
  lines.push(`  验证报告：${patch.validationReportId ?? review.validation?.id ?? '（无）'}`);
  if (patch.description) lines.push(`  描述：${truncate(patch.description, 1200)}`);
  const summary = patch.changeSummary;
  lines.push(
    `  变更摘要：+${summary.addedLines}/-${summary.removedLines} 行` +
      (summary.changedSections.length ? `；修改章节 ${summary.changedSections.length}` : '') +
      (summary.addedSections.length ? `；新增章节 ${summary.addedSections.length}` : '') +
      (summary.removedSections.length ? `；删除章节 ${summary.removedSections.length}` : '') +
      (summary.affectedRows ? `；影响行 ${summary.affectedRows}` : ''),
  );
  if (summary.note) lines.push(`  摘要说明：${truncate(summary.note, 600)}`);
  lines.push(...renderDiff(review.diff, options));
  if (review.validation) {
    lines.push(...renderValidationReport(review.validation, '  '));
  } else {
    lines.push('  验证：尚无验证报告（不能接受；请先运行 artifact review 确认服务端验证结果）');
  }
  if (patch.evidenceRefs.length) {
    lines.push(`  证据 ${patch.evidenceRefs.length} 条：`);
    for (const ref of patch.evidenceRefs.slice(0, 20)) lines.push(`    - ${formatEvidenceRef(ref)}`);
  }
  if (patch.operations.length) {
    lines.push(`  操作 ${patch.operations.length} 个：${patch.operations.map((operation) => operation.kind).join(', ')}`);
  }
  lines.push('  下一步：');
  if (patch.status === 'proposed') {
    lines.push(`    接受补丁：cognitive-atrium artifact accept ${patch.id} --validation-report ${patch.validationReportId ?? review.validation?.id ?? '<validationReportId>'}`);
    lines.push(`    查看版本：cognitive-atrium task status ${patch.taskId}`);
  } else if (patch.status === 'accepted') {
    lines.push(`    已接受；查看任务：cognitive-atrium task status ${patch.taskId}`);
  } else {
    lines.push(`    该补丁状态为 ${patchStatusLabel(patch.status)}，不能接受。`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Snapshot (task status)                                              */
/* ------------------------------------------------------------------ */

export function renderSnapshot(snapshot: TaskSnapshot, options: { serverUrl: string }): string[] {
  const lines: string[] = [];
  lines.push(heading(`任务 ${snapshot.task.id}`));
  lines.push(`  ${snapshot.task.title}`);
  lines.push(`  状态：${snapshot.task.status}   修订：${snapshot.task.revision}   模式：${snapshot.workspace.mode}   工作区：${snapshot.workspace.name}`);
  lines.push(`  策略版本：${snapshot.workspace.policyVersion}   快照序号：${snapshot.snapshotSeq}   服务时间：${snapshot.serverTime}`);
  lines.push(`  意图：${truncate(snapshot.task.intent, 500)}`);
  lines.push(`  交付物：${snapshot.artifact.title}（${snapshot.modules.length} 个模块，${snapshot.artifact.status}）`);
  lines.push('  模块：');
  const rows = snapshot.modules.map((view: ModuleView) => [
    shortId(view.module.id),
    view.module.title,
    view.module.kind,
    moduleStateLabel(view.module.status),
    shortId(view.acceptance?.acceptedVersionId ?? view.module.acceptedVersionId),
    view.acceptance?.pendingPatchId ? shortId(view.acceptance.pendingPatchId) : '-',
    view.acceptance?.openBlockerIds.length ? String(view.acceptance.openBlockerIds.length) : '-',
  ]);
  lines.push(indentBlock(renderTable(['ID', '标题', '类型', '状态', '已接受版本', '待审补丁', '阻塞'], rows), '    '));
  if (snapshot.activeRun) {
    const progress = snapshot.runs.find((run) => run.runId === snapshot.activeRun?.runId);
    lines.push(`  活动运行：${snapshot.activeRun.runId}  状态：${runStateLabel(snapshot.activeRun.state)}  尝试：${snapshot.activeRun.attempt}`);
    lines.push(`    计划版本：${snapshot.activeRun.planVersion}   预算：${formatBudgetUsage(snapshot.activeRun.budgetUsage)}`);
    if (progress?.activeStepTitle) lines.push(`    当前步骤：${progress.activeStepTitle}`);
  } else {
    lines.push('  活动运行：无');
  }
  const openBlockers = snapshot.blockers.filter((blocker) => blocker.status === 'open');
  if (openBlockers.length) {
    lines.push(`  待处理阻塞 ${openBlockers.length} 个：`);
    for (const blocker of openBlockers) lines.push(...renderBlocker(blocker, snapshot.activeRun?.runId ?? null).map((line) => `  ${line}`));
  } else {
    lines.push('  待处理阻塞：无');
  }
  if (snapshot.plan) {
    lines.push(...renderPlan(snapshot.plan, '  '));
  } else {
    lines.push('  计划：尚未生成');
  }
  const pendingPatches = snapshot.patches.filter((patch) => patch.status === 'proposed');
  if (pendingPatches.length) {
    lines.push(`  待审阅补丁 ${pendingPatches.length} 个：`);
    for (const patch of pendingPatches.slice(0, 10)) {
      lines.push(`    - ${patch.patchId}（模块 ${shortId(patch.moduleId)}，验证 ${patch.validationStatus ? validationStatusLabel(patch.validationStatus) : '无'}）`);
      lines.push(`      查看：cognitive-atrium artifact review ${patch.patchId}`);
    }
  }
  if (snapshot.validations.length) {
    lines.push('  最近验证：');
    for (const validation of snapshot.validations.slice(0, 5)) {
      lines.push(
        `    - ${validation.validationReportId}（模块 ${shortId(validation.moduleId)}）：${validationStatusLabel(validation.status)}` +
          `（通过 ${validation.checkCounts.pass} / 失败 ${validation.checkCounts.fail} / 待复核 ${validation.checkCounts.needsReview}）` +
          (validation.blockingFindings.length ? ` 阻断：${validation.blockingFindings.slice(0, 3).map((item) => truncate(item, 120)).join('；')}` : ''),
      );
    }
  }
  lines.push(`  资料：${snapshot.sources.length} 个（可用 ${snapshot.sources.filter((source) => source.availability === 'available').length}，缺失 ${snapshot.sources.filter((source) => source.availability === 'missing').length}）`);
  if (snapshot.recipes.length) lines.push(`  配方：${snapshot.recipes.map((recipe) => `${recipe.name} v${recipe.version}（${recipeKindLabel(recipe.kind)}/${recipeStatusLabel(recipe.status)}）`).join('、')}`);
  const control = snapshot.control;
  if (control) {
    lines.push(
      `  控制：暂停 ${control.canPause ? '可用' : '不可用'} / 继续 ${control.canResume ? '可用' : '不可用'} / 取消 ${control.canCancel ? '可用' : '不可用'}` +
        `；模型连接：${control.connectionStatus}${control.budgetLabel ? `；预算：${control.budgetLabel}` : ''}`,
    );
  }
  lines.push(`  Web 工作台：${uiLink(options.serverUrl, { taskId: snapshot.task.id })}`);
  lines.push('  下一步：');
  for (const line of snapshotNextSteps(snapshot)) lines.push(`    ${line}`);
  return lines;
}

export function snapshotNextSteps(snapshot: TaskSnapshot): string[] {
  const taskId = snapshot.task.id;
  const openBlockers = snapshot.blockers.filter((blocker) => blocker.status === 'open');
  if (openBlockers.length) {
    const first = openBlockers[0]!;
    return [`解决阻塞：cognitive-atrium run resolve ${first.runId} --blocker ${first.id} --option <optionId> ...`];
  }
  const pending = snapshot.patches.find((patch) => patch.status === 'proposed');
  if (pending) return [`审阅补丁：cognitive-atrium artifact review ${pending.patchId}`];
  if (snapshot.activeRun) {
    return [
      `查看运行：cognitive-atrium run status ${snapshot.activeRun.runId} --watch`,
      `跟踪事件：cognitive-atrium events tail ${taskId} --run ${snapshot.activeRun.runId}`,
    ];
  }
  if (snapshot.plan && snapshot.activeRun === null) {
    const planRun = snapshot.runs[0];
    if (planRun && planRun.state === 'READY') return [`提交计划：cognitive-atrium run commit ${planRun.runId}`];
  }
  const firstModule = snapshot.modules[0];
  if (firstModule) {
    return [
      `开始运行：cognitive-atrium run start ${taskId} --module ${firstModule.module.id} --intent "<工作意图>"`,
      `导入资料：cognitive-atrium source import ${taskId} --file <路径>`,
    ];
  }
  return [`查看任务列表：cognitive-atrium task list`];
}

/* ------------------------------------------------------------------ */
/* Task list / export / capability / recipe                            */
/* ------------------------------------------------------------------ */

export function renderTaskList(response: TaskListResponse): string[] {
  const lines = [heading(`任务列表（${response.tasks.length}）`)];
  if (response.tasks.length === 0) {
    lines.push('  暂无任务。创建：cognitive-atrium task create --title ... --intent ... --template cognitive-atrium');
    return lines;
  }
  const rows = response.tasks.map((task) => [
    shortId(task.taskId, 10),
    truncate(task.title, 30),
    task.status,
    String(task.revision),
    String(task.moduleCount),
    task.activeRunState ?? '-',
    String(task.acceptedCount),
    formatTimestamp(task.updatedAt),
  ]);
  lines.push(indentBlock(renderTable(['任务ID', '标题', '状态', '修订', '模块', '活动运行', '已接受', '更新时间'], rows), '  '));
  lines.push('  查看详情：cognitive-atrium task status <taskId>');
  return lines;
}

export function renderExportResult(response: ExportResponse, outputPath: string, integrity: { sha256Verified: boolean; bytesVerified: boolean }): string[] {
  return [
    heading('导出完成'),
    `  文件：${outputPath}`,
    `  大小：${response.bytes} 字节   类型：${response.mime}`,
    `  sha256：${response.sha256}`,
    `  完整性校验：${integrity.sha256Verified && integrity.bytesVerified ? '通过（sha256 与字节数一致）' : '失败'}`,
    `  脱敏：${response.redacted ? '是（已排除密钥/凭据等敏感内容）' : '否'}`,
    ...(response.warnings.length ? [`  警告 ${response.warnings.length} 条：`, ...response.warnings.map((warning) => `    - ${warning}`)] : []),
  ];
}

export function renderCapabilityReport(report: CapabilityReport): string[] {
  const lines: string[] = [];
  lines.push(heading(`能力测试 ${report.profileId}`));
  lines.push(`  服务：${report.serviceLabel}   模型：${report.testedModel}`);
  lines.push(`  请求数：${report.requestCount}   预估费用：${formatUsd(report.estimatedCostUsd)}`);
  lines.push(`  测试时间：${formatTimestamp(report.startedAt)} → ${formatTimestamp(report.finishedAt)}`);
  lines.push('  探测项：');
  for (const probe of report.probes) {
    lines.push(
      `    - ${probe.capability}：${probeStatusLabel(probe.status)}` +
        `${probe.latencyMs == null ? '' : `（${formatDurationMs(probe.latencyMs)}）`}` +
        `${probe.detail ? ` — ${truncate(probe.detail, 300)}` : ''}`,
    );
    if (probe.error) lines.push(`      错误：${probe.error.code} ${truncate(probe.error.message, 300)}${probe.error.retryable ? '（可重试）' : ''}`);
  }
  const capabilities = report.capabilities;
  lines.push(
    `  能力结论：streaming=${capabilityLabel(capabilities.streaming)} toolCalling=${capabilityLabel(capabilities.toolCalling)} structuredOutput=${capabilityLabel(capabilities.structuredOutput)} vision=${capabilityLabel(capabilities.vision)} usage=${capabilityLabel(capabilities.usageReporting)}`,
  );
  lines.push(`  实测服务/模型：${capabilities.testedServiceLabel ?? report.serviceLabel} / ${capabilities.testedModel ?? report.testedModel}`);
  lines.push('  注意：本次结果只代表上述服务与模型的实际测试，不代表对其它服务的兼容性。');
  return lines;
}

export function renderRecipe(recipe: Recipe): string[] {
  return [
    `  配方：${recipe.name}（${recipe.id}）v${recipe.version}`,
    `  类型：${recipeKindLabel(recipe.kind)}   状态：${recipeStatusLabel(recipe.status)}   指纹：${truncate(recipe.fingerprint, 80)}`,
    `  步骤 ${recipe.steps.length} 个：${recipe.steps.map((step) => `${step.id}:${step.kind}`).join(', ')}`,
    `  输入参数：${recipe.inputParameters.map((parameter) => `${parameter.name}:${parameter.type}${parameter.required ? '' : '?'}`).join(', ')}`,
    `  预算：模型调用 ${recipe.budget.maxModelCalls} / 工具调用 ${recipe.budget.maxToolCalls} / 最长 ${formatDurationMs(recipe.budget.maxRuntimeMs)}`,
    `  测试用例 ${recipe.testCases.length} 个：${recipe.testCases.map((testCase) => `${testCase.kind}/${testCase.expectation}=${testCase.status}`).join(', ')}`,
    ...(recipe.staleReason ? [`  过期原因：${recipe.staleReason}`] : []),
  ];
}

export function renderRecipeRunResult(result: RecipeRunResult, cacheState: string): string[] {
  const deterministic = result.llmCalls === 0;
  const lines: string[] = [];
  lines.push(heading(`配方运行 ${result.runId}`));
  lines.push(`  配方：${result.recipeId} v${result.recipeVersion}   执行方式：${cacheState === 'cache_hit' ? '命中缓存' : '实际执行'}`);
  lines.push('  输出：');
  for (const output of result.outputs) {
    lines.push(`    - ${output.name}（${output.moduleKind}）哈希 ${truncate(output.objectHash, 16)}${output.rowCount == null ? '' : `，${output.rowCount} 行`}`);
    if (output.preview) lines.push(`      预览：${truncate(output.preview, 200)}`);
  }
  lines.push(`  规范化输出哈希：${result.normalizedOutputHash}`);
  lines.push(
    `  调用账本：LLM 调用 ${result.llmCalls} 次` +
      (deterministic ? '（确定性路径，未调用模型）' : '（LLM 辅助，如实计费）') +
      ` · 工具调用 ${result.toolCalls} 次 · 耗时 ${formatDurationMs(result.durationMs)}`,
  );
  lines.push(`  时间：${formatTimestamp(result.startedAt)} → ${formatTimestamp(result.finishedAt)}`);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function indentBlock(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function uiLink(serverUrl: string, params: { taskId?: string; runId?: string } = {}): string {
  const query = new URLSearchParams();
  if (params.taskId) query.set('task', params.taskId);
  if (params.runId) query.set('run', params.runId);
  const suffix = query.toString();
  return suffix ? `${serverUrl}/?${suffix}` : `${serverUrl}/`;
}

export function planRiskSummary(risks: readonly PlanRisk[]): string {
  const blocking = risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null).length;
  if (risks.length === 0) return '未发现风险';
  return `${risks.length} 个风险（${blocking} 个阻止提交）`;
}

/** Labels for the JSON `status` field of non-zero business outcomes. */
export function businessStatusForRunState(state: string): 'ok' | 'waiting_for_input' | 'failed' | 'cancelled' | 'interrupted' | 'incomplete' {
  switch (state) {
    case 'AWAITING_INPUT':
      return 'waiting_for_input';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'INTERRUPTED':
      return 'interrupted';
    default:
      return 'ok';
  }
}
