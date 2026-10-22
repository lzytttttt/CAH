/** Resource budgets: counted, enforced by the kernel, never inferred from UI state. */
import { z } from 'zod';
import { LIMITS, TIME_LIMITS, UtcTimestampSchema } from './primitives';

export const BudgetPolicySchema = z.object({
  maxModelRequests: z.number().int().positive().max(1000).default(TIME_LIMITS.maxModelRequestsPerRun),
  maxToolCalls: z.number().int().positive().max(1000).default(TIME_LIMITS.maxToolCallsPerRun),
  maxOutputTokens: z.number().int().positive().max(200_000).default(LIMITS.maxModelOutputTokens),
  firstEventTimeoutMs: z.number().int().positive().max(600_000).default(TIME_LIMITS.firstEventTimeoutMs),
  idleTimeoutMs: z.number().int().positive().max(600_000).default(TIME_LIMITS.idleTimeoutMs),
  totalModelRequestTimeoutMs: z.number().int().positive().max(3_600_000).default(TIME_LIMITS.totalModelRequestTimeoutMs),
  toolTimeoutMs: z.number().int().positive().max(600_000).default(TIME_LIMITS.toolTimeoutMs),
  maxRetries: z.number().int().min(0).max(5).default(TIME_LIMITS.maxRetries),
  maxStructureRepairs: z.number().int().min(0).max(5).default(TIME_LIMITS.maxStructureRepairs),
  maxRunDurationMs: z.number().int().positive().max(86_400_000).default(TIME_LIMITS.runActiveDurationMs),
  /** Optional user-confirmed money cap. Only a soft aid: provider billing is delayed. */
  userCostBudgetUsd: z.number().positive().max(10_000).nullable().default(null),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = BudgetPolicySchema.parse({});

export type BudgetResource = 'model_requests' | 'tool_calls' | 'run_duration' | 'cost';

export const BudgetUsageSchema = z.object({
  modelRequests: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  estimatedInputTokens: z.number().int().nonnegative().default(0),
  estimatedOutputTokens: z.number().int().nonnegative().default(0),
  usdCost: z.number().nonnegative().nullable().default(null),
  elapsedActiveMs: z.number().int().nonnegative().default(0),
  startedAt: UtcTimestampSchema.nullable().default(null),
  updatedAt: UtcTimestampSchema,
});
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

export function createBudgetUsage(now: string): BudgetUsage {
  return {
    modelRequests: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    usdCost: null,
    elapsedActiveMs: 0,
    startedAt: null,
    updatedAt: now,
  };
}

export interface BudgetCheck {
  readonly allowed: boolean;
  readonly resource: BudgetResource | null;
  readonly used: number;
  readonly limit: number;
  readonly message: string;
}

/** Check all counters before scheduling an external call. */
export function checkBudget(policy: BudgetPolicy, usage: BudgetUsage): BudgetCheck {
  if (usage.modelRequests >= policy.maxModelRequests) {
    return {
      allowed: false,
      resource: 'model_requests',
      used: usage.modelRequests,
      limit: policy.maxModelRequests,
      message: `模型请求次数预算已用尽（${usage.modelRequests}/${policy.maxModelRequests}）`,
    };
  }
  if (usage.toolCalls >= policy.maxToolCalls) {
    return {
      allowed: false,
      resource: 'tool_calls',
      used: usage.toolCalls,
      limit: policy.maxToolCalls,
      message: `工具调用次数预算已用尽（${usage.toolCalls}/${policy.maxToolCalls}）`,
    };
  }
  if (usage.elapsedActiveMs >= policy.maxRunDurationMs) {
    return {
      allowed: false,
      resource: 'run_duration',
      used: usage.elapsedActiveMs,
      limit: policy.maxRunDurationMs,
      message: `运行时长预算已用尽（${Math.round(usage.elapsedActiveMs / 1000)}s/${Math.round(policy.maxRunDurationMs / 1000)}s）`,
    };
  }
  return { allowed: true, resource: null, used: 0, limit: 0, message: '' };
}

export function budgetWarning(
  policy: BudgetPolicy,
  usage: BudgetUsage,
): { resource: BudgetResource; used: number; limit: number } | null {
  const checks: Array<{ resource: BudgetResource; used: number; limit: number }> = [
    { resource: 'model_requests', used: usage.modelRequests, limit: policy.maxModelRequests },
    { resource: 'tool_calls', used: usage.toolCalls, limit: policy.maxToolCalls },
    { resource: 'run_duration', used: usage.elapsedActiveMs, limit: policy.maxRunDurationMs },
  ];
  for (const check of checks) {
    if (check.used / check.limit >= 0.8) return check;
  }
  return null;
}

/** Merge token/cost accounting from a single model call into the run usage. */
export function addModelUsage(
  usage: BudgetUsage,
  input: { inputTokens?: number | null; outputTokens?: number | null; estimatedInput?: number; estimatedOutput?: number; usdCost?: number | null },
  now: string,
): BudgetUsage {
  return {
    ...usage,
    modelRequests: usage.modelRequests + 1,
    inputTokens: usage.inputTokens + Math.max(0, input.inputTokens ?? 0),
    outputTokens: usage.outputTokens + Math.max(0, input.outputTokens ?? 0),
    estimatedInputTokens: usage.estimatedInputTokens + Math.max(0, input.estimatedInput ?? 0),
    estimatedOutputTokens: usage.estimatedOutputTokens + Math.max(0, input.estimatedOutput ?? 0),
    usdCost: input.usdCost == null || usage.usdCost == null ? usage.usdCost : usage.usdCost + input.usdCost,
    updatedAt: now,
  };
}

export function budgetSummaryLabel(policy: BudgetPolicy, usage: BudgetUsage): string {
  return [
    `模型 ${usage.modelRequests}/${policy.maxModelRequests}`,
    `工具 ${usage.toolCalls}/${policy.maxToolCalls}`,
    `token 入 ${usage.inputTokens || usage.estimatedInputTokens}${usage.inputTokens ? '' : '（估算）'}`,
    `出 ${usage.outputTokens || usage.estimatedOutputTokens}${usage.outputTokens ? '' : '（估算）'}`,
    usage.usdCost == null ? '金额未知' : `$${usage.usdCost.toFixed(4)}`,
  ].join(' · ');
}
