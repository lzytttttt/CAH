/**
 * Structured kernel errors. Every error that crosses the engine boundary maps to
 * one of the public API error codes; technical failures keep their detail so the
 * server can render a technical recovery entry instead of a business question.
 */
import { HarnessError } from './types';

export type KernelErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'revision_conflict'
  | 'version_conflict'
  | 'validation_failed'
  | 'schema_invalid'
  | 'budget_exhausted'
  | 'state_not_allowed'
  | 'dependency_unavailable'
  | 'provider_error'
  | 'provider_auth_error'
  | 'provider_rate_limited'
  | 'provider_model_missing'
  | 'tool_error'
  | 'tool_timeout'
  | 'tool_outcome_unknown'
  | 'internal_error';

export function kernelError(
  code: KernelErrorCode,
  message: string,
  options: { retryable?: boolean; details?: unknown } = {},
): HarnessError {
  return new HarnessError(code, message, options);
}

/** True when the thrown value is one of storage's optimistic-concurrency errors. */
export function isRevisionConflict(error: unknown): boolean {
  return isStorageErrorCode(error, 'revision_conflict');
}

export function isVersionConflict(error: unknown): boolean {
  return isStorageErrorCode(error, 'version_conflict');
}

export function isStateNotAllowed(error: unknown): boolean {
  return isStorageErrorCode(error, 'state_not_allowed');
}

function isStorageErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name !== 'HarnessError' &&
    (error as { code?: unknown }).code === code
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}

/** Map an unknown value to a structured kernel error (never re-label as success). */
export function toKernelError(error: unknown): HarnessError {
  if (error instanceof HarnessError) return error;
  if (isRevisionConflict(error)) return kernelError('revision_conflict', errorMessage(error), { retryable: true });
  if (isVersionConflict(error)) return kernelError('version_conflict', errorMessage(error));
  if (isStateNotAllowed(error)) return kernelError('state_not_allowed', errorMessage(error));
  return kernelError('internal_error', errorMessage(error));
}

/** Internal error representing a provider/tool timeout, classified by stage. */
export class TimeoutError extends Error {
  readonly phase: 'first_event' | 'idle' | 'total' | 'tool';
  readonly timeoutMs: number;
  constructor(phase: 'first_event' | 'idle' | 'total' | 'tool', timeoutMs: number) {
    super(`超时（${phase}，${timeoutMs}ms）`);
    this.name = 'TimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/** Raised when a provider stream reports a typed error event. */
export class ProviderStreamError extends Error {
  readonly detail: import('@ca/contracts').ProviderErrorDetail;
  constructor(detail: import('@ca/contracts').ProviderErrorDetail) {
    super(detail.message);
    this.name = 'ProviderStreamError';
    this.detail = detail;
  }
}

/** Candidate JSON could not be parsed into a valid module candidate. */
export class CandidateParseError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('；'));
    this.name = 'CandidateParseError';
    this.problems = problems;
  }
}

/** Raised by the model-call helper when a pause/cancel/shutdown aborted the call. */
export class CallAbortedError extends Error {
  readonly reason: 'pause' | 'cancel' | 'shutdown';
  constructor(reason: 'pause' | 'cancel' | 'shutdown') {
    super(`模型调用被中止（${reason}）`);
    this.name = 'CallAbortedError';
    this.reason = reason;
  }
}
