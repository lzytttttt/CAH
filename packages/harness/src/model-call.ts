/**
 * One bounded model request with explicit timeouts, retries, streaming assembly
 * and usage accounting.
 *
 * Timers are used only for real network/time limits (first event / idle / total);
 * they never decide business success. Text deltas are batched (~10/s) for
 * `model.delta_batch`; only `tool_call_complete` events are ever turned into tool
 * executions (the kernel never executes partial tool-call JSON).
 */
import {
  ModelRequestSchema,
  LIMITS,
  newModelCallId,
  newStepId,
  type FinishReason,
  type ModelEvent,
  type ModelMessage,
  type ModelToolCall,
  type ModelUsage,
  type ProviderCapabilities,
  type ProviderErrorDetail,
  type ProviderProfile,
  type ResponseFormat,
  type Run,
  type StepId,
  type TaskId,
  type ToolDefinition,
} from '@ca/contracts';
import type { BudgetCheck } from '@ca/contracts';
import type { EventDraft } from '@ca/storage';
import type { RunControl, Runtime } from './runtime';
import { ProviderStreamError, TimeoutError, kernelError } from './errors';
import { backoffDelay, estimateTokens, sleep } from './hashing';

export interface ModelCallParams {
  run: Run;
  taskId: TaskId;
  stepId: StepId | null;
  stage: 'planning' | 'execution' | 'validation';
  purpose: 'planner' | 'executor' | 'repair' | 'compressor' | 'recipe';
  profile: ProviderProfile;
  capabilities: ProviderCapabilities;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  responseFormat?: ResponseFormat;
  temperature?: number | null;
  maxOutputTokens?: number;
  /** Outer abort signal from the run control (pause/cancel/shutdown). */
  signal: AbortSignal;
  control?: RunControl;
  estimatedInputTokens: number;
  /** Attempts beyond the first; defaults to the run's maxRetries. */
  retriesAllowed?: number;
  /** Optional label used in checkpoints/diagnostics. */
  label?: string;
}

export interface ModelCallSuccess {
  kind: 'ok';
  modelCallId: string;
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: FinishReason;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; source: 'provider' | 'estimated' | 'mixed'; costUsd: number | null };
  attempts: number;
  durationMs: number;
  run: Run;
}

export type ModelCallOutcome =
  | ModelCallSuccess
  | { kind: 'budget_exhausted'; check: BudgetCheck; run: Run }
  | { kind: 'cancelled'; run: Run }
  | { kind: 'paused'; run: Run }
  | { kind: 'failed'; error: ProviderErrorDetail; code: string; attempts: number; run: Run };

const PROVIDER_CODE_MAP: Record<ProviderErrorDetail['code'], string> = {
  auth_error: 'provider_auth_error',
  rate_limited: 'provider_rate_limited',
  model_missing: 'provider_model_missing',
  bad_request: 'provider_error',
  server_error: 'provider_error',
  network_error: 'provider_error',
  first_event_timeout: 'provider_error',
  idle_timeout: 'provider_error',
  total_timeout: 'provider_error',
  cancelled: 'provider_error',
  truncated: 'provider_error',
  refused: 'provider_error',
  invalid_response: 'provider_error',
  unsupported_feature: 'provider_error',
  unknown: 'provider_error',
};

interface TimeoutState {
  phase: 'first_event' | 'idle' | 'total' | null;
}

export async function streamModel(runtime: Runtime, params: ModelCallParams): Promise<ModelCallOutcome> {
  const budgetPolicy = params.run.budgetPolicy;
  let run = params.run;
  const maxRetries = Math.max(0, params.retriesAllowed ?? budgetPolicy.maxRetries);
  const maxAttempts = maxRetries + 1;
  const effectiveStepId: StepId = params.stepId ?? newStepId();
  const startedAtMonotonic = runtime.clock.monotonicMs();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (params.signal.aborted) return abortOutcome(runtime, params, run);
    const budgetCheck = runtime.checkRunBudget(run);
    if (!budgetCheck.allowed) return { kind: 'budget_exhausted', check: budgetCheck, run };

    const modelCallId = newModelCallId();
    const maxOutputTokens = Math.min(
      params.maxOutputTokens ?? budgetPolicy.maxOutputTokens,
      budgetPolicy.maxOutputTokens,
      LIMITS.maxModelOutputTokens,
    );
    const request = ModelRequestSchema.parse({
      modelCallId,
      model: params.profile.model,
      messages: params.messages,
      tools: params.tools ?? [],
      toolChoice: params.toolChoice ?? (params.tools && params.tools.length > 0 ? 'auto' : 'none'),
      temperature: params.temperature ?? null,
      maxOutputTokens,
      responseFormat: params.responseFormat ?? { kind: 'text' },
      stream: true,
    });

    // Register the call intent + count the request *before* the network call so a
    // crash cannot hide consumed budget (design 5.3: retries are not free).
    const startedUsage = await runtime.recordUsage(
      run,
      { modelRequests: 1 },
      {
        before: (tx) => {
          tx.emit('model.started', {
            modelCallId,
            stepId: effectiveStepId,
            attempt,
            model: params.profile.model,
            profileId: params.profile.id,
          });
        },
      },
    );
    run = startedUsage.run;

    await runtime.checkpoint(run, 'before_model', effectiveStepId, {
      phase: params.purpose,
      modelCallId,
      attempt,
      stage: params.stage,
      label: params.label ?? null,
      estimatedInputTokens: params.estimatedInputTokens,
    });

    const timeouts = resolveTimeouts(params.profile, budgetPolicy);
    const inner = new AbortController();
    const timeoutState: TimeoutState = { phase: null };
    let firstTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    let text = '';
    const toolCalls: ModelToolCall[] = [];
    let finishReason: FinishReason = 'unknown';
    const reportedUsage: { usage: ModelUsage | null } = { usage: null };
    let receivedFirstEvent = false;
    let deltaBuffer = '';
    let lastDeltaFlush = runtime.clock.monotonicMs();

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutState.phase = 'idle';
        inner.abort(new Error('idle_timeout'));
      }, timeouts.idleTimeoutMs);
      idleTimer.unref?.();
    };
    const flushDeltaBatch = async (): Promise<void> => {
      if (deltaBuffer.length === 0) return;
      const batch = deltaBuffer;
      deltaBuffer = '';
      lastDeltaFlush = runtime.clock.monotonicMs();
      const draft: EventDraft = {
        runId: run.id,
        stepId: effectiveStepId,
        causationId: modelCallId,
        type: 'model.delta_batch',
        payload: { modelCallId, text: batch.slice(0, 200_000), kind: 'output' },
        timestamp: runtime.now(),
      };
      await runtime.emit(params.taskId, [draft]);
    };

    const onOuterAbort = (): void => {
      inner.abort(params.signal.reason ?? new Error('aborted'));
    };
    params.signal.addEventListener('abort', onOuterAbort, { once: true });

    try {
      firstTimer = setTimeout(() => {
        timeoutState.phase = 'first_event';
        inner.abort(new Error('first_event_timeout'));
      }, timeouts.firstEventTimeoutMs);
      firstTimer.unref?.();
      totalTimer = setTimeout(() => {
        timeoutState.phase = 'total';
        inner.abort(new Error('total_timeout'));
      }, timeouts.totalTimeoutMs);
      totalTimer.unref?.();
      armIdle();

      const iterator = runtime.providers.stream(params.profile.id, request, inner.signal)[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        if (!receivedFirstEvent) {
          receivedFirstEvent = true;
          if (firstTimer) {
            clearTimeout(firstTimer);
            firstTimer = null;
          }
        }
        armIdle();
        const handled = await handleModelEvent(runtime, event, {
          modelCallId,
          onDelta: (delta) => {
            text += delta;
            deltaBuffer += delta;
          },
          onToolCall: (call) => toolCalls.push(call),
          onUsage: (reported) => {
            reportedUsage.usage = reported;
          },
          onFinish: (reason) => {
            finishReason = reason;
          },
          onError: (detail) => {
            throw new ProviderStreamError(detail);
          },
        });
        if (deltaBuffer.length > 0 && runtime.clock.monotonicMs() - lastDeltaFlush >= 100) {
          await flushDeltaBatch();
        }
        if (!handled) continue;
      }
      await flushDeltaBatch();

      // Usage accounting: provider numbers when present, deterministic estimates otherwise.
      const usage = reportedUsage.usage;
      const inputTokens = usage?.inputTokens ?? null;
      const outputTokens = usage?.outputTokens ?? null;
      const estimatedInput = inputTokens === null ? params.estimatedInputTokens : 0;
      const estimatedOutput = outputTokens === null ? estimateTokens(text) : 0;
      const totalTokens = usage?.totalTokens ?? null;
      const costUsd = computeCost(params.profile, inputTokens, outputTokens, usage?.costUsd ?? null);
      const source: 'provider' | 'estimated' | 'mixed' =
        inputTokens === null && outputTokens === null
          ? 'estimated'
          : inputTokens === null || outputTokens === null
            ? 'mixed'
            : 'provider';
      const totalMs = Math.max(0, Math.round(runtime.clock.monotonicMs() - startedAtMonotonic));
      const finishedUsage: ModelUsage = {
        inputTokens,
        outputTokens,
        totalTokens,
        source,
        costUsd,
      };
      const after = await runtime.recordUsage(
        run,
        {
          inputTokens,
          outputTokens,
          estimatedInputTokens: estimatedInput,
          estimatedOutputTokens: estimatedOutput,
          usdCost: costUsd,
          elapsedActiveMs: Math.max(0, Math.round(runtime.clock.monotonicMs() - startedAtMonotonic)),
        },
        {
          before: (tx) => {
            tx.emit('model.finished', {
              modelCallId,
              finishReason,
              usage: finishedUsage,
              textLength: text.length,
              toolCallCount: toolCalls.length,
              durationMs: totalMs,
            });
          },
        },
      );
      run = after.run;
      await runtime.checkpoint(run, 'after_model', effectiveStepId, {
        phase: params.purpose,
        modelCallId,
        attempt,
        finishReason,
        textLength: text.length,
        toolCallCount: toolCalls.length,
      });
      return {
        kind: 'ok',
        modelCallId,
        text,
        toolCalls,
        finishReason,
        usage: { inputTokens, outputTokens, totalTokens, source, costUsd },
        attempts: attempt,
        durationMs: totalMs,
        run,
      };
    } catch (error) {
      if (params.signal.aborted) {
        await flushDeltaBatch().catch(() => undefined);
        return abortOutcome(runtime, params, run);
      }
      const detail = classifyFailure(error, timeoutState);
      // Provider errors are recorded as business events (technical recovery info).
      await runtime
        .emit(params.taskId, [
          {
            runId: run.id,
            stepId: effectiveStepId,
            causationId: modelCallId,
            type: 'provider.error',
            payload: { runId: run.id, stage: params.stage, error: detail },
            timestamp: runtime.now(),
          },
        ])
        .catch(() => undefined);

      if (attempt < maxAttempts && isRetryable(detail)) {
        const delay = detail.retryAfterMs != null && detail.retryAfterMs > 0 ? Math.min(detail.retryAfterMs, 5_000) : backoffDelay(attempt, 150, 2_000);
        const budgetNow = runtime.checkRunBudget(run);
        if (!budgetNow.allowed) return { kind: 'budget_exhausted', check: budgetNow, run };
        await sleep(delay);
        continue;
      }
      return {
        kind: 'failed',
        error: detail,
        code: PROVIDER_CODE_MAP[detail.code] ?? 'provider_error',
        attempts: attempt,
        run,
      };
    } finally {
      if (firstTimer) clearTimeout(firstTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      params.signal.removeEventListener('abort', onOuterAbort);
      inner.abort(new Error('settled'));
    }
  }

  return {
    kind: 'failed',
    error: {
      code: 'unknown',
      message: '模型请求在重试后仍未成功',
      retryable: false,
      httpStatus: null,
      retryAfterMs: null,
      providerRequestId: null,
    },
    code: 'provider_error',
    attempts: maxAttempts,
    run,
  };
}

interface ModelEventHandler {
  modelCallId: string;
  onDelta: (text: string) => void;
  onToolCall: (call: ModelToolCall) => void;
  onUsage: (usage: ModelUsage) => void;
  onFinish: (reason: FinishReason) => void;
  onError: (detail: ProviderErrorDetail) => void;
}

async function handleModelEvent(runtime: Runtime, event: ModelEvent, handlers: ModelEventHandler): Promise<boolean> {
  switch (event.type) {
    case 'text_delta':
      handlers.onDelta(event.text);
      runtime.onModelDelta?.(event);
      return true;
    case 'tool_call_delta':
      // Partial tool-call JSON is display-only; never executed.
      runtime.onModelDelta?.(event);
      return true;
    case 'tool_call_complete':
      handlers.onToolCall({ callId: event.callId, name: event.name, argumentsJson: event.argumentsJson });
      runtime.onModelDelta?.(event);
      return true;
    case 'usage':
      handlers.onUsage(event.usage);
      return true;
    case 'finish':
      handlers.onFinish(event.reason);
      return true;
    case 'error':
      handlers.onError(event.error);
      return false;
  }
}

function classifyFailure(error: unknown, timeoutState: TimeoutState): ProviderErrorDetail {
  if (timeoutState.phase !== null) {
    const code: ProviderErrorDetail['code'] =
      timeoutState.phase === 'first_event' ? 'first_event_timeout' : timeoutState.phase === 'idle' ? 'idle_timeout' : 'total_timeout';
    return {
      code,
      message: `模型请求超时（${timeoutState.phase}）`,
      retryable: true,
      httpStatus: null,
      retryAfterMs: null,
      providerRequestId: null,
    };
  }
  if (error instanceof TimeoutError) {
    const code: ProviderErrorDetail['code'] =
      error.phase === 'first_event' ? 'first_event_timeout' : error.phase === 'idle' ? 'idle_timeout' : 'total_timeout';
    return { code, message: error.message, retryable: true, httpStatus: null, retryAfterMs: null, providerRequestId: null };
  }
  if (error instanceof ProviderStreamError) return error.detail;
  return {
    code: 'network_error',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    httpStatus: null,
    retryAfterMs: null,
    providerRequestId: null,
  };
}

function isRetryable(detail: ProviderErrorDetail): boolean {
  if (!detail.retryable) return false;
  return detail.code !== 'cancelled' && detail.code !== 'refused';
}

function resolveTimeouts(
  profile: ProviderProfile,
  policy: import('@ca/contracts').BudgetPolicy,
): { firstEventTimeoutMs: number; idleTimeoutMs: number; totalTimeoutMs: number } {
  return {
    firstEventTimeoutMs: Math.min(profile.timeouts?.firstEventTimeoutMs ?? policy.firstEventTimeoutMs, policy.firstEventTimeoutMs),
    idleTimeoutMs: Math.min(profile.timeouts?.idleTimeoutMs ?? policy.idleTimeoutMs, policy.idleTimeoutMs),
    totalTimeoutMs: Math.min(profile.timeouts?.totalTimeoutMs ?? policy.totalModelRequestTimeoutMs, policy.totalModelRequestTimeoutMs),
  };
}

function computeCost(
  profile: ProviderProfile,
  inputTokens: number | null,
  outputTokens: number | null,
  reportedCost: number | null,
): number | null {
  if (reportedCost !== null) return reportedCost;
  const price = profile.priceTable;
  if (!price) return null;
  if (price.inputPerMillionUsd === null && price.outputPerMillionUsd === null) return null;
  const input = inputTokens !== null && price.inputPerMillionUsd !== null ? (inputTokens / 1_000_000) * price.inputPerMillionUsd : null;
  const output = outputTokens !== null && price.outputPerMillionUsd !== null ? (outputTokens / 1_000_000) * price.outputPerMillionUsd : null;
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

function abortOutcome(runtime: Runtime, params: ModelCallParams, run: Run): ModelCallOutcome {
  void runtime;
  if (params.control?.cancelRequested) return { kind: 'cancelled', run };
  return { kind: 'paused', run };
}

/** Thrown for impossible request shapes; kept separate to fail loudly. */
export function invalidRequestError(detail: string): never {
  throw kernelError('schema_invalid', `模型请求不合法：${detail}`);
}

/** Exposed for callers that need to surface provider error codes consistently. */
export function providerErrorCode(detail: ProviderErrorDetail): string {
  return PROVIDER_CODE_MAP[detail.code] ?? 'provider_error';
}

/** Health message used in diagnostics; never shown as a business result. */
export function modelCallSummary(outcome: ModelCallOutcome): string {
  switch (outcome.kind) {
    case 'ok':
      return `model ok (${outcome.finishReason}, ${outcome.attempts} attempt(s))`;
    case 'failed':
      return `model failed (${outcome.error.code})`;
    case 'budget_exhausted':
      return `budget exhausted (${outcome.check.resource})`;
    case 'cancelled':
      return 'model cancelled';
    case 'paused':
      return 'model paused';
  }
}
