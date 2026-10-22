/**
 * Deterministic provider error mapping.
 *
 * The adapter never surfaces raw HTTP bodies, fetch exceptions or provider
 * error payloads to callers: everything is normalized into a `ProviderError`
 * whose code is one of the contract's `ProviderErrorDetail` codes. Messages are
 * sanitized (credential redaction, control characters, length) before they
 * leave this module.
 */
import type { ProviderErrorDetail } from '@ca/contracts';
import { ProviderError } from './types';
import { redactSecrets } from './mask';

export type ProviderErrorCode = ProviderErrorDetail['code'];

const KNOWN_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set<ProviderErrorCode>([
  'auth_error',
  'rate_limited',
  'model_missing',
  'bad_request',
  'server_error',
  'network_error',
  'first_event_timeout',
  'idle_timeout',
  'total_timeout',
  'cancelled',
  'truncated',
  'refused',
  'invalid_response',
  'unsupported_feature',
  'unknown',
]);

export function isKnownProviderErrorCode(code: string): code is ProviderErrorCode {
  return KNOWN_PROVIDER_ERROR_CODES.has(code);
}

export interface SanitizeOptions {
  /** Concrete secret values that must never appear in the output. */
  secrets?: readonly string[];
  /** Maximum output length (default 2000). */
  maxLength?: number;
}

/**
 * Turn provider-controlled text into a bounded, secret-free, single-line
 * message suitable for an event payload or a UI notice.
 */
export function sanitizeProviderMessage(value: unknown, options: SanitizeOptions = {}): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = value.message;
  else if (value === null || value === undefined) text = '';
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  // Strip ANSI escapes and control characters (never allow terminal injection).
  text = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  text = redactSecrets(text, options.secrets ?? []);
  text = text.replace(/\s+/g, ' ').trim();
  const maxLength = options.maxLength ?? 2000;
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}\u2026`;
  return text;
}

export interface HttpErrorInput {
  status: number;
  bodyText: string;
  headers?: Headers | null;
  secrets?: readonly string[];
}

/** Retry-After may be delta-seconds or an HTTP-date; return milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.round(dateMs - nowMs));
}

export function extractProviderRequestId(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const candidates = ['x-request-id', 'openai-request-id', 'request-id', 'x-amzn-requestid'];
  for (const name of candidates) {
    const value = headers.get(name);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().slice(0, 200);
    }
  }
  return null;
}

interface ParsedErrorPayload {
  message: string;
  codeText: string;
}

/** Extract a public-ish message from a JSON (or plain text) provider error body. */
export function extractApiErrorMessage(bodyText: string): string | null {
  const parsed = parseJsonObject(bodyText);
  if (parsed) {
    const record = parsed as Record<string, unknown>;
    const errorValue = record['error'];
    if (typeof errorValue === 'string' && errorValue.trim().length > 0) return errorValue.trim();
    if (errorValue && typeof errorValue === 'object') {
      const errorObject = errorValue as Record<string, unknown>;
      const message = firstString(errorObject, ['message', 'detail', 'msg']);
      if (message) return message;
      const nested = errorObject['error'];
      if (typeof nested === 'string' && nested.trim().length > 0) return nested.trim();
    }
    const direct = firstString(record, ['message', 'detail', 'msg', 'error_description']);
    if (direct) return direct;
  }
  const raw = bodyText.trim();
  return raw.length > 0 ? raw.slice(0, 500) : null;
}

function parseErrorPayload(bodyText: string): ParsedErrorPayload {
  const parsed = parseJsonObject(bodyText);
  const record = (parsed ?? {}) as Record<string, unknown>;
  const pieces: string[] = [];
  let message = '';
  const errorValue = record['error'];
  if (errorValue && typeof errorValue === 'object') {
    const errorObject = errorValue as Record<string, unknown>;
    message = firstString(errorObject, ['message', 'detail', 'msg']) ?? '';
    for (const key of ['code', 'type', 'param']) {
      const value = errorObject[key];
      if (typeof value === 'string' && value.trim().length > 0) pieces.push(value.trim());
    }
  } else if (typeof errorValue === 'string' && errorValue.trim().length > 0) {
    message = errorValue.trim();
    pieces.push(message);
  }
  if (message.length === 0) {
    message = firstString(record, ['message', 'detail', 'msg', 'error_description']) ?? '';
  }
  for (const key of ['code', 'type']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) pieces.push(value.trim());
  }
  if (message.length === 0) {
    const raw = bodyText.trim();
    if (raw.length > 0) message = raw.slice(0, 500);
  }
  if (pieces.length === 0 && message.length > 0) pieces.push(message);
  return { message, codeText: [message, ...pieces].join(' ') };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const candidate = trimmed.startsWith('{') || trimmed.startsWith('[') ? trimmed : trimmed.slice(0, 8_192);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

interface ErrorClassification {
  code: ProviderErrorCode;
  retryable: boolean;
  reason: string;
}

/**
 * Classify an HTTP status deterministically (design section 6.2 matrix).
 * This is the single source of truth used by the adapter and capability probes.
 */
export function classifyHttpStatus(status: number): ErrorClassification {
  if (status === 401 || status === 403) {
    return { code: 'auth_error', retryable: false, reason: 'authentication or authorization failed' };
  }
  if (status === 404) return { code: 'model_missing', retryable: false, reason: 'model or endpoint was not found' };
  if (status === 429) return { code: 'rate_limited', retryable: true, reason: 'provider rate limit was hit' };
  if (status === 408) return { code: 'network_error', retryable: true, reason: 'provider reported a request timeout' };
  if (status === 400 || status === 402 || status === 405 || status === 409 || status === 413 || status === 415 || status === 422) {
    return { code: 'bad_request', retryable: false, reason: 'provider rejected the request as invalid' };
  }
  if (status >= 500 && status <= 599) {
    return { code: 'server_error', retryable: true, reason: 'provider server error' };
  }
  if (status >= 300 && status <= 399) {
    return { code: 'invalid_response', retryable: false, reason: 'unexpected redirect response' };
  }
  if (status >= 400 && status <= 499) {
    return { code: 'bad_request', retryable: false, reason: 'provider rejected the request' };
  }
  return { code: 'invalid_response', retryable: false, reason: 'unexpected provider response' };
}

/**
 * Classify a provider API error object (status 200 SSE error payload or a JSON
 * body). Only explicit textual markers are used; a plain HTTP 200 is never
 * treated as evidence of a capability.
 */
export function classifyApiErrorText(text: string): ErrorClassification {
  const haystack = text.toLowerCase();
  if (/content[_\s-]?(?:filter|policy)|refus|safety/.test(haystack)) {
    return { code: 'refused', retryable: false, reason: 'provider refused the request' };
  }
  if (/invalid[_\s-]?api[_\s-]?key|incorrect[_\s-]?api[_\s-]?key|authentication|unauthor|invalid[_\s-]?token|permission/.test(haystack)) {
    return { code: 'auth_error', retryable: false, reason: 'authentication failed' };
  }
  if (/rate[_\s-]?limit|too many requests|quota/.test(haystack)) {
    return { code: 'rate_limited', retryable: true, reason: 'provider rate limit was hit' };
  }
  if (/model[_\s-]?not[_\s-]?found|unknown[_\s-]?model|no such model|invalid[_\s-]?model|does not exist/.test(haystack)) {
    return { code: 'model_missing', retryable: false, reason: 'model was not found' };
  }
  if (/context[_\s-]?length|maximum context|too many tokens|reduce the length/.test(haystack)) {
    return { code: 'bad_request', retryable: false, reason: 'request exceeded the model context window' };
  }
  if (/server[_\s-]?error|internal[_\s-]?error|overloaded|temporar|unavailable/.test(haystack)) {
    return { code: 'server_error', retryable: true, reason: 'provider server error' };
  }
  if (/unsupported|not supported|invalid[_\s-]?request|bad[_\s-]?request|invalid[_\s-]?parameter|unknown[_\s-]?field/.test(haystack)) {
    return { code: 'bad_request', retryable: false, reason: 'provider rejected the request as invalid' };
  }
  return { code: 'invalid_response', retryable: false, reason: 'provider returned an error payload' };
}

export interface ApiPayloadErrorContext {
  secrets?: readonly string[];
  httpStatus?: number | null;
  providerRequestId?: string | null;
  retryAfterMs?: number | null;
}

/**
 * Convert a provider error payload (SSE `data: {"error": ...}` or a JSON error
 * body) into a normalized `ProviderError`. Returns null when the payload does
 * not look like an error.
 */
export function providerErrorFromApiPayload(payload: unknown, context: ApiPayloadErrorContext = {}): ProviderError | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const errorValue = record['error'];
  const hasErrorEnvelope = errorValue !== undefined && errorValue !== null;
  const typeValue = record['type'];
  const looksLikeError = hasErrorEnvelope || typeValue === 'error' || record['code'] === 'error';
  if (!looksLikeError) return null;
  const bodyText = safeJson(payload);
  const parsed = parseErrorPayload(bodyText);
  const classified = classifyApiErrorText(parsed.codeText);
  const message = sanitizeProviderMessage(parsed.message || classified.reason, {
    secrets: context.secrets,
    maxLength: 2000,
  });
  return new ProviderError(classified.code, message, {
    retryable: classified.retryable,
    httpStatus: context.httpStatus ?? null,
    retryAfterMs: context.retryAfterMs ?? null,
    providerRequestId: context.providerRequestId ?? null,
  });
}

/** Deterministic mapping of an unsuccessful HTTP response to a `ProviderError`. */
export function providerErrorFromHttpResponse(input: HttpErrorInput): ProviderError {
  const classified = classifyHttpStatus(input.status);
  const parsed = parseErrorPayload(input.bodyText);
  const message = sanitizeProviderMessage(parsed.message || classified.reason, {
    secrets: input.secrets,
    maxLength: 2000,
  });
  const retryAfterMs = parseRetryAfterMs(input.headers?.get('retry-after') ?? null);
  // An explicit content-filter rejection can arrive with 400; it must be surfaced
  // as `refused` rather than retried like a generic bad request.
  const explicit = classifyApiErrorText(parsed.codeText);
  const code = explicit.code === 'refused' ? 'refused' : classified.code;
  const retryable = code === 'refused' ? false : classified.retryable;
  return new ProviderError(code, `provider returned HTTP ${input.status}: ${message}`, {
    retryable,
    httpStatus: input.status,
    retryAfterMs,
    providerRequestId: extractProviderRequestId(input.headers ?? null),
  });
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED';
}

/** Convert any thrown value into a sanitized `ProviderError` (never throws). */
export function toProviderError(error: unknown, options: { secrets?: readonly string[] } = {}): ProviderError {
  if (error instanceof ProviderError) {
    if (!KNOWN_PROVIDER_ERROR_CODES.has(error.code)) {
      return new ProviderError(error.code, sanitizeProviderMessage(error.message, options), {
        retryable: error.retryable,
        httpStatus: error.httpStatus,
        retryAfterMs: error.retryAfterMs,
        providerRequestId: error.providerRequestId,
      });
    }
    return error;
  }
  const record = (error && typeof error === 'object' ? (error as Record<string, unknown>) : {}) as Record<string, unknown>;
  if (record['name'] === 'UrlPolicyError' || record['code'] === 'url_not_allowed') {
    return new ProviderError('bad_request', sanitizeProviderMessage(error, options), { retryable: false });
  }
  if (isAbortError(error)) {
    return new ProviderError('cancelled', 'provider request was cancelled', { retryable: false });
  }
  const cause = record['cause'];
  const causeCode =
    cause && typeof cause === 'object' ? String((cause as Record<string, unknown>)['code'] ?? '') : '';
  const detail = sanitizeProviderMessage(error, { ...options, maxLength: 1000 });
  if (error instanceof TypeError || causeCode.length > 0) {
    return new ProviderError('network_error', `network error${causeCode ? ` (${causeCode})` : ''}: ${detail}`, {
      retryable: true,
    });
  }
  return new ProviderError('unknown', detail || 'unknown provider failure', { retryable: false });
}

/** Serialize a `ProviderError` detail for a `ModelEvent` error event. */
export function providerErrorDetail(error: unknown, options: { secrets?: readonly string[] } = {}): ProviderErrorDetail {
  const normalized = toProviderError(error, options);
  const code = isKnownProviderErrorCode(normalized.code) ? normalized.code : 'unknown';
  return {
    code,
    message: sanitizeProviderMessage(normalized.message, options),
    retryable: normalized.retryable,
    httpStatus: normalized.httpStatus,
    retryAfterMs: normalized.retryAfterMs,
    providerRequestId: normalized.providerRequestId,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
