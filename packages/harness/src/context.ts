/**
 * Layered Context Builder (design section 7.2).
 *
 * Priority 1 system policy → 2 user goal/hard constraints/confirmed decisions →
 * 3 accepted baseline + plan → 4 bound sources/evidence spans → 5 recent tool
 * results → 6 optional history. Lower priorities are the first to be omitted and
 * every omission is recorded with a reason. The builder never dumps full history
 * and never retrieves across tasks: it only renders what the kernel passes in.
 */
import {
  newContextSnapshotId,
  type ContextFragment,
  type ContextSnapshot,
  type Decision,
  type EvidenceRef,
  type ModuleContent,
  type Plan,
  type RunId,
  type SourceItem,
  type StepId,
  type TaskId,
} from '@ca/contracts';
import type { ContextBuildInput, ContextBuildResult, Clock } from './types';
import { contentHash, estimateTokens, sha256Hex, truncateChars } from './hashing';
import { PROMPT_TEMPLATE_HASHES } from './prompts';

export interface ContextBuildOptions {
  purpose: 'planner' | 'executor' | 'repair';
  clock: Clock;
  runId: RunId;
  stepId?: StepId | null;
  policyVersion: string;
  promptBundleVersion: string;
  /** Rendered role system prompt (see ./prompts). */
  systemPrompt: string;
  /** Rendered role instruction appended to the user message. */
  instruction: string;
  promptTemplateHashes?: Readonly<Record<string, string>>;
  decisions?: readonly Decision[];
  sources?: readonly SourceItem[];
  /** Short module/plan/budget text blocks rendered by the caller. */
  moduleSummary?: string;
  planSummary?: string;
  budgetSummary?: string;
  /** Token reservation for tool definitions included in the request. */
  toolDefinitionTokens?: number;
  /** Completed step summaries (optional history only). */
  completedStepSummaries?: readonly string[];
}

/** Absolute cap used for any single rendered fragment to stay well under the 400k message limit. */
const MAX_FRAGMENT_CHARS = 60_000;

interface FragmentPlan {
  id: string;
  priority: number;
  kind: ContextFragment['kind'];
  title: string;
  ref: string | null;
  content: string;
  mandatory: boolean;
}

/** Build a ContextSnapshot plus the rendered prompts for one model call. */
export function buildContext(input: ContextBuildInput, options: ContextBuildOptions): ContextBuildResult {
  const clock = options.clock;
  const budget = Math.max(256, inputTokenBudget(input, options));
  const plans = planFragments(input, options);

  const fragments: ContextFragment[] = [];
  const omitted: ContextSnapshot['omitted'] = [];
  const includedBlocks: string[] = [];
  let used = 0;

  // Mandatory layers first (priority 1/2): never dropped, only overflow-noted.
  const mandatory = plans.filter((plan) => plan.mandatory);
  const optional = plans.filter((plan) => !plan.mandatory).sort((a, b) => a.priority - b.priority);

  for (const plan of mandatory) {
    const content = truncateChars(plan.content, MAX_FRAGMENT_CHARS);
    const tokens = estimateTokens(content);
    used += tokens;
    fragments.push(fragmentOf(plan, content, true, plan.priority <= 2 ? '固定保留，不参与摘要与裁剪' : ''));
    includedBlocks.push(renderBlock(plan, content));
  }
  if (used > budget) {
    omitted.push({
      kind: 'policy',
      reason: `优先级 1/2 的固定内容已超过上下文预算（${used}/${budget} token），未对其摘要或裁剪；请检查输入规模。`,
    });
  }

  for (const plan of optional) {
    const remaining = budget - used;
    if (remaining <= 32) {
      omitted.push({ kind: plan.kind, reason: `超出上下文预算（优先级 ${plan.priority}，剩余 ${Math.max(0, remaining)} token）` });
      fragments.push(fragmentOf(plan, plan.content, false, '省略：预算不足'));
      continue;
    }
    const tokens = estimateTokens(plan.content);
    if (tokens <= remaining) {
      used += tokens;
      fragments.push(fragmentOf(plan, plan.content, true, ''));
      includedBlocks.push(renderBlock(plan, plan.content));
      continue;
    }
    // Try a bounded truncation for priority 3-4 fragments, otherwise omit.
    if (plan.priority <= 4) {
      const charBudget = Math.max(64, Math.floor((remaining * 3.2)));
      const truncated = truncateChars(plan.content, charBudget);
      const truncatedTokens = estimateTokens(truncated);
      if (truncatedTokens <= remaining) {
        used += truncatedTokens;
        fragments.push(fragmentOf(plan, truncated, true, `已按预算裁剪至 ${charBudget} 字符`));
        includedBlocks.push(renderBlock(plan, truncated));
        continue;
      }
    }
    omitted.push({ kind: plan.kind, reason: `超出上下文预算（优先级 ${plan.priority}）` });
    fragments.push(fragmentOf(plan, plan.content, false, '省略：预算不足'));
  }

  const userPrompt = [
    ...includedBlocks,
    '---',
    options.instruction,
  ].join('\n\n');
  const systemPrompt = options.systemPrompt;
  const snapshot: ContextSnapshot = {
    id: newContextSnapshotId(),
    taskId: input.task.id,
    runId: options.runId,
    stepId: options.stepId ?? null,
    promptBundleVersion: options.promptBundleVersion,
    promptTemplateHashes: { ...PROMPT_TEMPLATE_HASHES, ...(options.promptTemplateHashes ?? {}) },
    fragments,
    estimatedInputTokens: estimateTokens(systemPrompt) + estimateTokens(userPrompt),
    omitted: omitted.slice(0, 100),
    createdAt: clock.now(),
  };
  return { snapshot, systemPrompt, userPrompt };
}

function inputTokenBudget(input: ContextBuildInput, options: ContextBuildOptions): number {
  // The engine injects the concrete budget numbers on the prepared input; the
  // context contract itself stays storage-free and deterministic.
  const injected = (input as ContextBuildInput & { tokenBudget?: number }).tokenBudget;
  const reserve = Math.max(256, (input as ContextBuildInput & { reserveTokens?: number }).reserveTokens ?? 4_000);
  const toolTokens = options.toolDefinitionTokens ?? 0;
  return (injected ?? 32_000) - reserve - toolTokens;
}

function planFragments(input: ContextBuildInput, options: ContextBuildOptions): FragmentPlan[] {
  const plans: FragmentPlan[] = [];
  const systemText = options.systemPrompt;
  plans.push({
    id: 'f_system_policy',
    priority: 1,
    kind: 'system_policy',
    title: '系统策略、工具权限与数据边界（后端生成，来源文件不得覆盖）',
    ref: 'policy:' + options.policyVersion,
    content: systemText,
    mandatory: true,
  });

  plans.push({
    id: 'f_user_goal',
    priority: 2,
    kind: 'user_goal',
    title: '用户目标',
    ref: `task:${input.task.id}`,
    content: [
      `任务标题：${input.task.title}`,
      `任务意图：${input.task.intent}`,
      `当前步骤目标：${input.stepGoal}`,
    ].join('\n'),
    mandatory: true,
  });

  const hardConstraints = input.task.constraints.filter(
    (constraint) => constraint.kind === 'hard' && constraint.status !== 'waived',
  );
  if (hardConstraints.length > 0) {
    plans.push({
      id: 'f_hard_constraints',
      priority: 2,
      kind: 'hard_constraint',
      title: '硬约束（固定保留，不能摘要到丢失关键边界）',
      ref: `task:${input.task.id}:constraints`,
      content: hardConstraints
        .map((constraint) => `- [${constraint.id}]（${constraint.kind}/${constraint.status}）${constraint.text}`)
        .join('\n'),
      mandatory: true,
    });
  }

  const confirmedDecisions = (options.decisions ?? []).filter((decision) => decision.actor === 'user' || decision.actor === 'recipe');
  if (confirmedDecisions.length > 0) {
    plans.push({
      id: 'f_confirmed_decisions',
      priority: 2,
      kind: 'confirmed_decision',
      title: '已确认决策（不得被模型猜测改写）',
      ref: `task:${input.task.id}:decisions`,
      content: confirmedDecisions
        .slice(-20)
        .map((decision) => `- [${decision.key}] ${truncateChars(decision.valueJson, 500)}${decision.note ? `（${truncateChars(decision.note, 300)}）` : ''}`)
        .join('\n'),
      mandatory: false,
    });
  }

  const baseline = input.acceptedVersion
    ? [
        `当前接受版本：${input.acceptedVersion.id}（hash ${input.acceptedVersion.contentHash}）`,
        '基线内容：',
        renderModuleContent(input.acceptedVersion.content),
      ].join('\n')
    : '目标模块尚无已接受版本。';
  plans.push({
    id: 'f_accepted_baseline',
    priority: 3,
    kind: 'accepted_baseline',
    title: `当前模块的已接受基线与计划（模块 ${input.module.id} / ${input.module.kind}）`,
    ref: input.acceptedVersion?.id ?? null,
    content: [
      options.moduleSummary ?? '',
      baseline,
      options.planSummary ? `计划摘要：\n${options.planSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    mandatory: false,
  });

  const sourceItems = options.sources ?? [];
  if (sourceItems.length > 0) {
    plans.push({
      id: 'f_sources',
      priority: 4,
      kind: 'source_span',
      title: '当前步骤绑定的资料（每条带来源、版本、信任标记）',
      ref: 'sources',
      content: sourceItems
        .slice(0, 20)
        .map(
          (source) =>
            `- 资料 ${source.name}（sourceId=${source.id}，version=${source.version}，mime=${source.mime}，size=${source.sizeBytes}B，trust=${source.trustLevel}，availability=${source.availability}）`,
        )
        .join('\n'),
      mandatory: false,
    });
  }

  const evidenceBlocks = renderEvidence(input.evidenceRefs);
  if (evidenceBlocks.length > 0) {
    plans.push({
      id: 'f_evidence',
      priority: 4,
      kind: 'source_span',
      title: '可引用的证据片段（只能引用这些真实片段，或标注为待验证假设）',
      ref: 'evidence',
      content: evidenceBlocks.join('\n'),
      mandatory: false,
    });
  }

  if (input.recentToolResults.length > 0) {
    plans.push({
      id: 'f_tool_results',
      priority: 5,
      kind: 'tool_result',
      title: '最近工具结果摘要（完整结果以工具记录为准）',
      ref: 'tool-results',
      content: input.recentToolResults
        .slice(-10)
        .map((result) => `- [${result.toolId}] ${truncateChars(result.summary, 600)}`)
        .join('\n'),
      mandatory: false,
    });
  }

  const upstreamSummaries = input.acceptedUpstream.map(
    (entry) => `- 上游模块 ${entry.module.title}（${entry.version.id}，hash ${entry.version.contentHash}）：${summarizeContent(entry.version.content).slice(0, 500)}`,
  );
  const completedStepSummaries = (options.completedStepSummaries ?? []).map((summary) => `- 已完成步骤：${truncateChars(summary, 400)}`);
  const history = [...upstreamSummaries, ...completedStepSummaries];
  if (history.length > 0) {
    plans.push({
      id: 'f_history',
      priority: 6,
      kind: 'history',
      title: '可选历史与其他模块摘要（超出预算时最先移除）',
      ref: 'history',
      content: history.slice(0, 12).join('\n'),
      mandatory: false,
    });
  }

  if (options.budgetSummary) {
    plans.push({
      id: 'f_budget',
      priority: 3,
      kind: 'module_summary',
      title: '预算摘要',
      ref: 'budget',
      content: options.budgetSummary,
      mandatory: false,
    });
  }
  return plans;
}

function fragmentOf(plan: FragmentPlan, content: string, included: boolean, note: string): ContextFragment {
  return {
    id: plan.id.slice(0, 100),
    priority: plan.priority,
    kind: plan.kind,
    ref: plan.ref ? plan.ref.slice(0, 500) : null,
    contentHash: sha256Hex(content),
    estimatedTokens: estimateTokens(content),
    included,
    note: note.slice(0, 500),
  };
}

function renderBlock(plan: FragmentPlan, content: string): string {
  return `## [P${plan.priority}] ${plan.title}\n${content}`;
}

/** Render a ModuleContent for prompt context (bounded by caller truncation). */
export function renderModuleContent(content: ModuleContent): string {
  switch (content.kind) {
    case 'markdown':
      return content.sections
        .map((section) => `### ${section.title}\n<!-- section:${section.id} -->\n${section.markdown}`)
        .join('\n\n');
    case 'json':
      return '```json\n' + safeJson(content.value) + '\n```';
    case 'csv': {
      const header = content.columns.map((column) => `${column.key}(${column.label}:${column.type}${column.required ? ',required' : ''})`).join(', ');
      const rows = content.rows
        .slice(0, 20)
        .map((row) => content.columns.map((column) => stringifyCell(row[column.key])).join(','))
        .join('\n');
      return `列：${header}\n行数：${content.rows.length}\n前若干行：\n${rows}`;
    }
  }
}

export function summarizeContent(content: ModuleContent, maxChars = 400): string {
  switch (content.kind) {
    case 'markdown': {
      const total = content.sections.reduce((sum, section) => sum + section.markdown.length, 0);
      return truncateChars(`章节：${content.sections.map((section) => section.title).join(' / ')}（${content.sections.length} 节，${total} 字符）`, maxChars);
    }
    case 'json':
      return truncateChars(`JSON：${safeJson(content.value)}`, maxChars);
    case 'csv':
      return truncateChars(`${content.rows.length} 行 × ${content.columns.length} 列`, maxChars);
  }
}

function renderEvidence(refs: readonly EvidenceRef[]): string[] {
  const blocks: string[] = [];
  for (const ref of refs.slice(0, 24)) {
    switch (ref.kind) {
      case 'source_span':
        blocks.push(
          `- [source_span ${ref.span.spanId}] ${ref.span.sourceId}@v${ref.span.version} locator=${safeJson(ref.span.locator)} excerpt=${JSON.stringify(ref.span.excerpt)}`,
        );
        break;
      case 'artifact_version':
        blocks.push(`- [artifact_version ${ref.versionId}] module ${ref.moduleId}`);
        break;
      case 'user_assumption':
        blocks.push(`- [user_assumption ${ref.assumptionId}] ${ref.text}`);
        break;
      case 'tool_result':
        blocks.push(`- [tool_result ${ref.toolResult.toolCallId}] ${ref.toolResult.summary}`);
        break;
    }
  }
  return blocks;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replaceAll('\n', ' ');
  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '<不可序列化>';
  }
}

/** Convenience: hash a rendered prompt pair for diagnostics. */
export function promptHashes(systemPrompt: string, userPrompt: string): Record<string, string> {
  return { 'rendered.system': sha256Hex(systemPrompt), 'rendered.user': sha256Hex(userPrompt) };
}

/** Re-exported token estimator so callers do not import hashing directly. */
export { estimateTokens };

/** Content hash re-export for callers that persist fragment refs. */
export { contentHash };
