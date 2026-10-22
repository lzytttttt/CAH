/** Formatting helpers: time, counts, budgets, truncation. Pure and DOM-free. */

export { formatBytes } from './ids';

export function formatTimestamp(iso: string | null | undefined, locale = 'zh-CN'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(5, 16).replace('T', ' ');
  }
}

export function formatRelativeTime(iso: string | null | undefined, now: string | number = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const diff = Math.max(0, nowMs - then);
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return formatTimestamp(iso);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function formatTokens(input: number, output: number): string {
  return `入 ${formatNumber(input)} · 出 ${formatNumber(output)}`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '金额未知';
  return `$${usd.toFixed(4)}`;
}

/** Step-based progress only (never a fabricated overall success percentage). */
export function formatStepProgress(completed: number | null, total: number | null): string {
  if (completed == null || total == null || total <= 0) return '步骤进度未知';
  const safeCompleted = Math.min(Math.max(0, completed), total);
  const percent = Math.round((safeCompleted / total) * 100);
  return `已完成 ${safeCompleted}/${total} 个步骤（${percent}%）`;
}

/** Usage summary label independent from a server-provided budgetLabel. */
export function formatUsageSummary(
  usage: { modelRequests: number; toolCalls: number; inputTokens: number; outputTokens: number; estimatedInputTokens: number; estimatedOutputTokens: number; usdCost: number | null } | null,
  policy?: { maxModelRequests?: number; maxToolCalls?: number } | null,
): string {
  if (!usage) return '尚无消耗记录';
  const input = usage.inputTokens || usage.estimatedInputTokens;
  const inputLabel = usage.inputTokens ? formatNumber(input) : `${formatNumber(input)}（估算）`;
  const output = usage.outputTokens || usage.estimatedOutputTokens;
  const outputLabel = usage.outputTokens ? formatNumber(output) : `${formatNumber(output)}（估算）`;
  const modelLimit = policy?.maxModelRequests != null ? `/${policy.maxModelRequests}` : '';
  const toolLimit = policy?.maxToolCalls != null ? `/${policy.maxToolCalls}` : '';
  return `模型 ${usage.modelRequests}${modelLimit} · 工具 ${usage.toolCalls}${toolLimit} · token 入 ${inputLabel} · 出 ${outputLabel} · ${formatCost(usage.usdCost)}`;
}

export function truncateText(text: string | null | undefined, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Bounded, stable excerpt for diff/evidence previews. */
export function excerptLines(text: string | null | undefined, maxLines = 4, maxChars = 240): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/).slice(0, maxLines).join('\n');
  return truncateText(lines, maxChars);
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

export function safeJsonPreview(value: unknown, maxChars = 400): string {
  try {
    return truncateText(JSON.stringify(value, null, 2) ?? String(value), maxChars);
  } catch {
    return '<无法序列化>';
  }
}

/** Compatibility check used by key-value detail lists. */
export function describeBoolean(value: boolean | null | undefined, yes = '是', no = '否'): string {
  if (value == null) return '未知';
  return value ? yes : no;
}
