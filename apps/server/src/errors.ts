import { ZodError } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '@ca/contracts';

/** Structured HTTP error; every response uses this shape via app error handler. */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, status: number, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export const fail = {
  badRequest: (message: string, details?: unknown) => new ApiFailure('bad_request', 400, message, { details }),
  sessionRequired: (message = '需要本地会话令牌') => new ApiFailure('session_required', 401, message),
  forbidden: (message: string) => new ApiFailure('forbidden', 403, message),
  originNotAllowed: (origin: string) => new ApiFailure('origin_not_allowed', 403, `来源不被允许：${origin}`),
  notFound: (what: string) => new ApiFailure('not_found', 404, `${what}不存在`),
  conflict: (message: string, details?: unknown) => new ApiFailure('conflict', 409, message, { details }),
  revisionConflict: (expected: number, actual: number) =>
    new ApiFailure('revision_conflict', 409, `修订号冲突：期望 ${expected}，当前 ${actual}`, { details: { expected, actual } }),
  versionConflict: (message: string, details?: unknown) => new ApiFailure('version_conflict', 409, message, { details }),
  stateNotAllowed: (message: string) =>
    new ApiFailure('state_not_allowed', 409, message, { retryable: false }),
  validationFailed: (message: string, details?: unknown) => new ApiFailure('validation_failed', 422, message, { details }),
  schemaInvalid: (message: string, details?: unknown) => new ApiFailure('schema_invalid', 422, message, { details }),
  budgetExhausted: (message: string, details?: unknown) => new ApiFailure('budget_exhausted', 422, message, { details }),
  unsupportedMedia: (message: string) => new ApiFailure('unsupported_media_type', 415, message),
  payloadTooLarge: (message: string) => new ApiFailure('payload_too_large', 413, message),
  importInvalid: (message: string, details?: unknown) => new ApiFailure('import_invalid', 422, message, { details }),
  provider: (message: string, details?: unknown) => new ApiFailure('provider_error', 502, message, { retryable: true, details }),
  internal: (message: string, details?: unknown) => new ApiFailure('internal_error', 500, message, { details }),
};

export interface MappedError {
  status: number;
  body: ApiErrorBody;
}

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  retryable?: boolean;
  details?: unknown;
  statusCode?: number;
  issues?: unknown;
}

/** Map unknown errors to the documented ApiErrorBody + status rules. */
export function mapError(error: unknown, traceId: string): MappedError {
  if (error instanceof ApiFailure) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: (error.details ?? undefined) as ApiErrorBody['details'],
        traceId,
      },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: {
        code: 'schema_invalid',
        message: '请求结构校验失败',
        retryable: false,
        details: error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        traceId,
      },
    };
  }
  const err = error as ErrorLike;
  const name = err?.name ?? '';
  const code = err?.code ?? '';
  if (name === 'RevisionConflictError' || code === 'revision_conflict') {
    return { status: 409, body: { code: 'revision_conflict', message: err.message ?? '修订号冲突', retryable: false, traceId } };
  }
  if (name === 'VersionConflictError' || code === 'version_conflict') {
    return { status: 409, body: { code: 'version_conflict', message: err.message ?? '版本冲突', retryable: false, traceId } };
  }
  if (name === 'StateNotAllowedError' || code === 'state_not_allowed') {
    return { status: 409, body: { code: 'state_not_allowed', message: err.message ?? '当前状态不允许该操作', retryable: false, traceId } };
  }
  if (name === 'UrlPolicyError' || code === 'url_not_allowed') {
    return { status: 400, body: { code: 'bad_request', message: err.message ?? '模型服务地址不被允许', retryable: false, traceId } };
  }
  if (name === 'HarnessError' || name === 'ProviderError') {
    const mapped: Record<string, { status: number; code: ApiErrorBody['code']; retryable?: boolean }> = {
      revision_conflict: { status: 409, code: 'revision_conflict' },
      version_conflict: { status: 409, code: 'version_conflict' },
      state_not_allowed: { status: 409, code: 'state_not_allowed' },
      budget_exhausted: { status: 422, code: 'budget_exhausted' },
      schema_invalid: { status: 422, code: 'schema_invalid' },
      validation_failed: { status: 422, code: 'validation_failed' },
      dependency_unavailable: { status: 422, code: 'dependency_unavailable' },
      not_found: { status: 404, code: 'not_found' },
      // Contract ProviderErrorDetail codes (adapter surface).
      auth_error: { status: 502, code: 'provider_auth_error' },
      rate_limited: { status: 503, code: 'provider_rate_limited', retryable: true },
      model_missing: { status: 502, code: 'provider_model_missing' },
      bad_request: { status: 422, code: 'bad_request' },
      refused: { status: 422, code: 'validation_failed' },
      truncated: { status: 422, code: 'validation_failed' },
      unsupported_feature: { status: 422, code: 'bad_request' },
      invalid_response: { status: 502, code: 'provider_error', retryable: true },
      network_error: { status: 502, code: 'provider_error', retryable: true },
      first_event_timeout: { status: 504, code: 'provider_error', retryable: true },
      idle_timeout: { status: 504, code: 'provider_error', retryable: true },
      total_timeout: { status: 504, code: 'provider_error', retryable: true },
      cancelled: { status: 409, code: 'state_not_allowed' },
      // Harness-level provider kinds.
      provider_auth_error: { status: 502, code: 'provider_auth_error' },
      provider_rate_limited: { status: 503, code: 'provider_rate_limited', retryable: true },
      provider_model_missing: { status: 502, code: 'provider_model_missing' },
      provider_error: { status: 502, code: 'provider_error' },
      tool_timeout: { status: 504, code: 'tool_timeout' },
      tool_outcome_unknown: { status: 409, code: 'tool_outcome_unknown' },
    };
    const entry = mapped[code];
    if (entry) {
      return {
        status: entry.status,
        body: {
          code: entry.code,
          message: err.message ?? '执行失败',
          retryable: entry.retryable ?? err.retryable ?? false,
          details: err.details as ApiErrorBody['details'],
          traceId,
        },
      };
    }
    return {
      status: 502,
      body: { code: 'provider_error', message: err.message ?? '执行失败', retryable: err.retryable ?? false, traceId },
    };
  }
  if (err?.statusCode && err.statusCode < 500) {
    return {
      status: err.statusCode,
      body: { code: 'bad_request', message: err.message ?? '请求无效', retryable: false, traceId },
    };
  }
  return {
    status: 500,
    body: {
      code: 'internal_error',
      message: '服务器内部错误',
      retryable: false,
      details: process.env.NODE_ENV === 'production' ? undefined : { message: err?.message ?? String(error) },
      traceId,
    },
  };
}
