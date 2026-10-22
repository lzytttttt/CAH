/**
 * One tool call, executed only after: allow-list check → strict argument schema
 * validation → policy/scope check → budget check. Every attempt is recorded as a
 * ToolInvocation with planned/authorized/started/outcome events.
 *
 * Unknown outcomes are never auto-replayed for side-effecting tools. Read-only
 * tools may be retried inside the budget on retryable failures.
 */
import {
  newToolCallId,
  type BudgetCheck,
  type JsonValue,
  type Run,
  type StepId,
  type TaskId,
  type ToolCallId,
  type ToolDescriptor,
  type ToolError,
  type ToolId,
  type ToolInvocationRecord,
  type ToolResult,
  type ToolScope,
} from '@ca/contracts';
import type { Runtime, RunControl } from './runtime';
import { CallAbortedError, TimeoutError, kernelError } from './errors';
import { argumentsHash, backoffDelay, contentHash, sleep, truncateChars, truncateBytes, utf8Bytes } from './hashing';

export interface ToolExecutionParams {
  run: Run;
  taskId: TaskId;
  stepId: StepId;
  toolCallId: string;
  toolId: ToolId;
  rawArgumentsJson: string;
  allowedToolIds: ReadonlySet<ToolId>;
  grantedScopes: readonly ToolScope[];
  signal: AbortSignal;
  control?: RunControl;
}

export type ToolExecutionOutcome =
  | { kind: 'succeeded'; record: ToolInvocationRecord; result: ToolResult; durationMs: number }
  | { kind: 'failed'; record: ToolInvocationRecord; error: ToolError }
  | { kind: 'denied'; record: ToolInvocationRecord; reason: string }
  | { kind: 'unknown'; record: ToolInvocationRecord; detail: string }
  | { kind: 'budget_exhausted'; check: BudgetCheck; record: ToolInvocationRecord | null }
  | { kind: 'cancelled'; record: ToolInvocationRecord | null }
  | { kind: 'paused'; record: ToolInvocationRecord | null };

const MAX_RESULT_CONTENT_CHARS = 120_000;

export async function runToolExecution(runtime: Runtime, params: ToolExecutionParams): Promise<ToolExecutionOutcome> {
  const descriptors = await runtime.toolDescriptors();
  const descriptor = descriptors.get(params.toolId) ?? null;
  let run = await runtime.loadRun(params.run.id);
  const now = runtime.now();
  const argumentsPreview = truncateChars(params.rawArgumentsJson, 4_000);
  const hash = argumentsHash(params.rawArgumentsJson);
  const record: ToolInvocationRecord = {
    toolCallId: params.toolCallId as ToolCallId,
    runId: run.id,
    stepId: params.stepId,
    toolId: params.toolId,
    status: 'planned',
    argumentsJson: truncateBytes(params.rawArgumentsJson, 400_000),
    resultSummary: null,
    resultObjectHash: null,
    resultBytes: null,
    error: null,
    attempt: 1,
    plannedAt: now,
    authorizedAt: null,
    startedAt: null,
    finishedAt: null,
  };

  await runtime.txn(
    params.taskId,
    async (tx) => {
      await runtime.storage.insertToolInvocation(record);
      tx.emit('tool.requested', {
        toolCallId: record.toolCallId,
        stepId: params.stepId,
        toolId: params.toolId,
        argumentsPreview,
        argumentsHash: hash,
      });
    },
    { runId: run.id, stepId: params.stepId },
  );

  const deny = async (code: string, message: string): Promise<ToolExecutionOutcome> => {
    const error: ToolError = { code, message, retryable: false };
    const denied: ToolInvocationRecord = {
      ...record,
      status: 'denied',
      error,
      finishedAt: runtime.now(),
    };
    await runtime.txn(
      params.taskId,
      async (tx) => {
        await runtime.storage.updateToolInvocation(denied);
        tx.emit('tool.authorized', {
          toolCallId: denied.toolCallId,
          decision: 'deny',
          reason: message.slice(0, 2000),
          scopes: [],
        });
        tx.emit('tool.failed', {
          toolCallId: denied.toolCallId,
          toolId: denied.toolId,
          error: { code, message: message.slice(0, 4000), retryable: false },
          durationMs: 0,
        });
      },
      { runId: run.id, stepId: params.stepId },
    );
    return { kind: 'denied', record: denied, reason: message };
  };

  if (!descriptor) {
    return deny('tool_unknown', `工具未注册：${params.toolId}`);
  }
  if (!params.allowedToolIds.has(params.toolId)) {
    return deny('tool_not_allowed', `工具 ${params.toolId} 不在已提交计划的允许清单内`);
  }

  // Strict schema validation BEFORE anything executes.
  const validation = runtime.tools.validateArguments(params.toolId, params.rawArgumentsJson);
  if (!validation.ok) {
    const error: ToolError = { code: 'invalid_arguments', message: validation.error, retryable: false };
    const failed: ToolInvocationRecord = { ...record, status: 'failed', error, finishedAt: runtime.now() };
    await runtime.txn(
      params.taskId,
      async (tx) => {
        await runtime.storage.updateToolInvocation(failed);
        tx.emit('tool.failed', {
          toolCallId: failed.toolCallId,
          toolId: failed.toolId,
          error: { code: error.code, message: error.message.slice(0, 4000), retryable: false },
          durationMs: 0,
        });
      },
      { runId: run.id, stepId: params.stepId },
    );
    return { kind: 'failed', record: failed, error };
  }

  const budget = runtime.checkRunBudget(run);
  if (!budget.allowed) {
    const error: ToolError = { code: 'budget_exhausted', message: budget.message, retryable: false };
    const failed: ToolInvocationRecord = { ...record, status: 'failed', error, finishedAt: runtime.now() };
    await runtime.txn(
      params.taskId,
      async (tx) => {
        await runtime.storage.updateToolInvocation(failed);
        tx.emit('tool.failed', {
          toolCallId: failed.toolCallId,
          toolId: failed.toolId,
          error: { code: error.code, message: error.message.slice(0, 4000), retryable: false },
          durationMs: 0,
        });
      },
      { runId: run.id, stepId: params.stepId },
    );
    return { kind: 'budget_exhausted', check: budget, record: failed };
  }

  // Policy/scope authorization (P0: reads + draft writes only; no approval UI here).
  const requiredScopes = descriptor.policy.requiredScopes;
  const missingScope = requiredScopes.find((scope) => !params.grantedScopes.includes(scope));
  if (missingScope) {
    return deny('forbidden', `缺少工具作用域 ${missingScope}，无法执行 ${params.toolId}`);
  }
  if (descriptor.policy.effect === 'external_write') {
    return deny('forbidden', 'P0 不开放外部写入工具');
  }
  const authorized: ToolInvocationRecord = {
    ...record,
    status: 'authorized',
    authorizedAt: runtime.now(),
  };
  await runtime.txn(
    params.taskId,
    async (tx) => {
      await runtime.storage.updateToolInvocation(authorized);
      tx.emit('tool.authorized', {
        toolCallId: authorized.toolCallId,
        decision: 'allow',
        reason: `工具 ${params.toolId} 在计划允许清单内且作用域满足`,
        scopes: requiredScopes.slice(0, 16),
      });
    },
    { runId: run.id, stepId: params.stepId },
  );
  record.status = 'authorized';
  record.authorizedAt = authorized.authorizedAt;

  const maxRetries = run.budgetPolicy.maxRetries;
  const retryableOperation = descriptor.policy.effect === 'read' || descriptor.policy.idempotency === 'safe';
  let attempt = 0;
  const startedAt = runtime.clock.monotonicMs();

  for (;;) {
    attempt += 1;
    run = await runtime.loadRun(run.id);
    const attemptBudget = runtime.checkRunBudget(run);
    if (!attemptBudget.allowed) {
      return { kind: 'budget_exhausted', check: attemptBudget, record };
    }
    const startedRecord: ToolInvocationRecord = {
      ...record,
      status: 'started',
      attempt,
      startedAt: runtime.now(),
    };
    const usage = await runtime.recordUsage(
      run,
      { toolCalls: 1 },
      {
        before: async (tx) => {
          await runtime.storage.updateToolInvocation(startedRecord);
          tx.emit('tool.started', { toolCallId: startedRecord.toolCallId, toolId: startedRecord.toolId, attempt });
        },
      },
    );
    run = usage.run;
    await runtime.checkpoint(run, 'before_tool', params.stepId, {
      toolCallId: params.toolCallId,
      toolId: params.toolId,
      attempt,
    });

    const timeoutMs = Math.max(1, Math.min(descriptor.policy.timeoutMs, run.budgetPolicy.toolTimeoutMs));
    const inner = new AbortController();
    const onOuterAbort = (): void => inner.abort(params.signal.reason ?? new Error('aborted'));
    if (params.signal.aborted) onOuterAbort();
    params.signal.addEventListener('abort', onOuterAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (inner.signal.aborted) reject(new CallAbortedError(params.control?.cancelRequested ? 'cancel' : 'pause'));
      inner.signal.addEventListener(
        'abort',
        () => {
          if (!timedOut) reject(new CallAbortedError(params.control?.cancelRequested ? 'cancel' : 'pause'));
        },
        { once: true },
      );
    });
    abortPromise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        inner.abort(new Error('tool_timeout'));
        reject(new TimeoutError('tool', timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });
    timeoutPromise.catch(() => undefined);

    const durationStarted = runtime.clock.monotonicMs();
    try {
      const toolContext = await runtime.toolContextFactory({
        taskId: params.taskId,
        runId: run.id,
        stepId: params.stepId,
        toolCallId: params.toolCallId,
        grantedScopes: params.grantedScopes,
        signal: inner.signal,
      });
      const execution = runtime.tools.execute(params.toolId, params.rawArgumentsJson, toolContext);
      execution.catch(() => undefined);
      const result = await Promise.race([execution, abortPromise, timeoutPromise]);
      const durationMs = Math.max(0, Math.round(runtime.clock.monotonicMs() - durationStarted));
      return await finalizeResult(runtime, params, run, record, result, attempt, durationMs);
    } catch (error) {
      const durationMs = Math.max(0, Math.round(runtime.clock.monotonicMs() - durationStarted));
      if (error instanceof CallAbortedError || (params.signal.aborted && !timedOut)) {
        return await markOutcomeUnknown(runtime, params, run, record, attempt, {
          detail: params.control?.cancelRequested ? '运行被取消，工具结果未知' : '运行暂停，工具结果未知',
          retryRefused: true,
          pausedOrCancelled: params.control?.cancelRequested ? 'cancelled' : 'paused',
          durationMs,
        });
      }
      if (error instanceof TimeoutError || timedOut) {
        if (retryableOperation && attempt <= maxRetries && !params.signal.aborted) {
          await runtime.checkpoint(run, 'after_tool', params.stepId, {
            toolCallId: params.toolCallId,
            toolId: params.toolId,
            attempt,
            outcome: 'timeout_retry',
          });
          await sleep(backoffDelay(attempt, 120, 1_500));
          continue;
        }
        return await markOutcomeUnknown(runtime, params, run, record, attempt, {
          detail: `工具执行超时（${timeoutMs}ms），结果未知；不安全副作用不会自动重放`,
          retryRefused: true,
          durationMs,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      const toolError: ToolError = { code: 'tool_error', message, retryable: true };
      if (retryableOperation && attempt <= maxRetries && !params.signal.aborted) {
        await runtime.checkpoint(run, 'after_tool', params.stepId, {
          toolCallId: params.toolCallId,
          toolId: params.toolId,
          attempt,
          outcome: 'error_retry',
          message: truncateChars(message, 500),
        });
        await sleep(backoffDelay(attempt, 120, 1_500));
        continue;
      }
      return await finalizeFailure(runtime, params, run, record, toolError, attempt, durationMs);
    } finally {
      if (timer) clearTimeout(timer);
      params.signal.removeEventListener('abort', onOuterAbort);
      inner.abort(new Error('settled'));
    }
  }
}

async function finalizeResult(
  runtime: Runtime,
  params: ToolExecutionParams,
  run: Run,
  base: ToolInvocationRecord,
  result: ToolResult,
  attempt: number,
  durationMs: number,
): Promise<ToolExecutionOutcome> {
  if (result.status === 'succeeded') {
    const resultJson = safeJson(result.result);
    const summary = truncateChars(summarizeToolResult(params.toolId, result), 2_000);
    const record: ToolInvocationRecord = {
      ...base,
      status: 'succeeded',
      attempt,
      resultSummary: summary,
      resultObjectHash: result.resultObjectHash ?? contentHash(result.result ?? null),
      resultBytes: result.resultBytes ?? utf8Bytes(resultJson),
      error: null,
      finishedAt: runtime.now(),
    };
    await runtime.txn(
      params.taskId,
      async (tx) => {
        await runtime.storage.updateToolInvocation(record);
        tx.emit('tool.succeeded', {
          toolCallId: record.toolCallId,
          toolId: record.toolId,
          resultSummary: summary,
          resultObjectHash: record.resultObjectHash,
          resultBytes: record.resultBytes ?? 0,
          durationMs,
        });
      },
      { runId: run.id, stepId: params.stepId },
    );
    await runtime.checkpoint(run, 'after_tool', params.stepId, {
      toolCallId: params.toolCallId,
      toolId: params.toolId,
      attempt,
      outcome: 'succeeded',
      resultBytes: record.resultBytes,
    });
    await runtime.recordUsage(run, { elapsedActiveMs: durationMs });
    return { kind: 'succeeded', record, result, durationMs };
  }
  if (result.status === 'failed') {
    const error: ToolError = result.error ?? { code: 'tool_error', message: '工具执行失败', retryable: false };
    return finalizeFailure(runtime, params, run, base, error, attempt, durationMs);
  }
  return markOutcomeUnknown(runtime, params, run, base, attempt, {
    detail: '工具返回 outcome_unknown：副作用结果不明，不自动重放',
    retryRefused: true,
    durationMs,
  });
}

async function finalizeFailure(
  runtime: Runtime,
  params: ToolExecutionParams,
  run: Run,
  base: ToolInvocationRecord,
  error: ToolError,
  attempt: number,
  durationMs: number,
): Promise<ToolExecutionOutcome> {
  const record: ToolInvocationRecord = {
    ...base,
    status: 'failed',
    attempt,
    error,
    finishedAt: runtime.now(),
  };
  await runtime.txn(
    params.taskId,
    async (tx) => {
      await runtime.storage.updateToolInvocation(record);
      tx.emit('tool.failed', {
        toolCallId: record.toolCallId,
        toolId: record.toolId,
        error: { code: error.code.slice(0, 100), message: error.message.slice(0, 4000), retryable: error.retryable },
        durationMs,
      });
    },
    { runId: run.id, stepId: params.stepId },
  );
  await runtime.checkpoint(run, 'after_tool', params.stepId, {
    toolCallId: params.toolCallId,
    toolId: params.toolId,
    attempt,
    outcome: 'failed',
    code: error.code,
  });
  await runtime.recordUsage(run, { elapsedActiveMs: durationMs });
  return { kind: 'failed', record, error };
}

async function markOutcomeUnknown(
  runtime: Runtime,
  params: ToolExecutionParams,
  run: Run,
  base: ToolInvocationRecord,
  attempt: number,
  detail: {
    detail: string;
    retryRefused: boolean;
    durationMs: number;
    pausedOrCancelled?: 'paused' | 'cancelled';
  },
): Promise<ToolExecutionOutcome> {
  const record: ToolInvocationRecord = {
    ...base,
    status: 'outcome_unknown',
    attempt,
    error: { code: 'tool_outcome_unknown', message: detail.detail, retryable: false },
    finishedAt: runtime.now(),
  };
  await runtime.txn(
    params.taskId,
    async (tx) => {
      await runtime.storage.updateToolInvocation(record);
      tx.emit('tool.outcome_unknown', {
        toolCallId: record.toolCallId,
        toolId: record.toolId,
        detail: detail.detail.slice(0, 2000),
        retryRefused: detail.retryRefused,
      });
    },
    { runId: run.id, stepId: params.stepId },
  );
  if (detail.pausedOrCancelled === 'cancelled') return { kind: 'cancelled', record };
  if (detail.pausedOrCancelled === 'paused') return { kind: 'paused', record };
  return { kind: 'unknown', record, detail: detail.detail };
}

function summarizeToolResult(toolId: ToolId, result: ToolResult): string {
  const payload = safeJson(result.result);
  const patchInfo =
    toolId === 'artifact.propose_patch' && result.result && typeof result.result === 'object'
      ? '（已生成候选补丁草稿）'
      : '';
  return `${toolId} 成功${patchInfo}：${truncateChars(payload, 900)}`;
}

function safeJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'null';
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

/** Stable helper used by the executor to build a synthetic tool call id if needed. */
export function makeToolCallId(): ToolCallId {
  return newToolCallId();
}

/** Validate that a tool id exists before building descriptors (defensive). */
export function requireDescriptor(descriptor: ToolDescriptor | null, toolId: ToolId): ToolDescriptor {
  if (!descriptor) throw kernelError('bad_request', `工具未注册：${toolId}`);
  return descriptor;
}

export { MAX_RESULT_CONTENT_CHARS };
