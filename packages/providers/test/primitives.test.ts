/**
 * Unit tests for the small shared building blocks: SSE decoding, token
 * estimation/cost math, error mapping/sanitization and package exports.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_TIMEOUTS,
  PROVIDERS_PACKAGE_VERSION,
  SseDecoder,
  classifyHttpStatus,
  computeCostUsd,
  estimateRequestTokens,
  estimateTokens,
  maskCredential,
  parseRetryAfterMs,
  parseSseBlock,
  providerErrorDetail,
  providerErrorFromApiPayload,
  providerErrorFromHttpResponse,
  providerPackageExports,
  redactSecrets,
  sanitizeProviderMessage,
  toProviderError,
} from '../src/index';
import { ProviderError } from '../src/index';
import { TEST_CREDENTIAL, makeRequest } from './helpers';

describe('SseDecoder', () => {
  it('reassembles records split across arbitrary chunk boundaries', () => {
    const decoder = new SseDecoder();
    const pieces = ['da', 'ta: {"a"', ':1}\n\ndata: [DO', 'NE]\n\n'];
    const records = pieces.flatMap((piece) => decoder.push(piece));
    expect(records).toHaveLength(2);
    expect(records[0]?.data).toBe('{"a":1}');
    expect(records[1]?.data).toBe('[DONE]');
    expect(decoder.pending).toBe('');
  });

  it('supports CRLF, comments, multi-line data, event/id/retry fields and a BOM', () => {
    const decoder = new SseDecoder();
    const raw =
      '\uFEFF: keep-alive\r\n' +
      'event: message\r\n' +
      'id: 7\r\n' +
      'retry: 1500\r\n' +
      'data: line one\r\n' +
      'data: line two\r\n' +
      '\r\n';
    const records = decoder.push(raw);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      event: 'message',
      data: 'line one\nline two',
      id: '7',
      retry: 1500,
    });
  });

  it('ignores comment-only blocks and flushes a final record without a blank line', () => {
    const decoder = new SseDecoder();
    expect(decoder.push(': ping\n\n')).toHaveLength(0);
    expect(decoder.push('data: {"done":true}')).toHaveLength(0);
    const flushed = decoder.end();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.data).toBe('{"done":true}');
    expect(parseSseBlock(': only a comment')).toBeNull();
  });

  it('handles unknown fields and empty data values', () => {
    const decoder = new SseDecoder();
    const records = decoder.push('unknown: x\ndata:\n\n');
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toBe('');
  });
});

describe('token estimation and cost math', () => {
  it('estimates tokens deterministically', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('\u4f60\u597d')).toBe(2);
    expect(estimateTokens('hello \u4e16\u754c')).toBe(estimateTokens('hello \u4e16\u754c'));
  });

  it('estimates full request tokens as a positive integer', () => {
    const tokens = estimateRequestTokens(makeRequest());
    expect(Number.isInteger(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns null cost when pricing or token data is incomplete', () => {
    const complete = { currency: 'USD' as const, inputPerMillionUsd: 1, outputPerMillionUsd: 2 };
    expect(computeCostUsd(null, 1000, 1000)).toBeNull();
    expect(computeCostUsd({ ...complete, inputPerMillionUsd: null }, 1000, 1000)).toBeNull();
    expect(computeCostUsd({ ...complete, outputPerMillionUsd: null }, 1000, 1000)).toBeNull();
    expect(computeCostUsd(complete, null, 1000)).toBeNull();
    expect(computeCostUsd(complete, 1000, null)).toBeNull();
    expect(computeCostUsd(complete, 1_000_000, 500_000)).toBeCloseTo(2, 9);
  });
});

describe('error mapping and sanitization', () => {
  it('classifies HTTP statuses deterministically', () => {
    expect(classifyHttpStatus(401).code).toBe('auth_error');
    expect(classifyHttpStatus(403).code).toBe('auth_error');
    expect(classifyHttpStatus(404).code).toBe('model_missing');
    expect(classifyHttpStatus(400).code).toBe('bad_request');
    expect(classifyHttpStatus(422).code).toBe('bad_request');
    expect(classifyHttpStatus(429)).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(classifyHttpStatus(408)).toMatchObject({ code: 'network_error', retryable: true });
    expect(classifyHttpStatus(500)).toMatchObject({ code: 'server_error', retryable: true });
    expect(classifyHttpStatus(503)).toMatchObject({ code: 'server_error', retryable: true });
    expect(classifyHttpStatus(418).code).toBe('bad_request');
    expect(classifyHttpStatus(302).code).toBe('invalid_response');
  });

  it('parses Retry-After as seconds or HTTP date', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
  });

  it('redacts known secrets and credential-shaped tokens from text', () => {
    const message = `bad key ${TEST_CREDENTIAL} and Bearer abcdefghijklmnop and api_key=supersecretvalue123`;
    const sanitized = sanitizeProviderMessage(message, { secrets: [TEST_CREDENTIAL] });
    expect(sanitized).not.toContain(TEST_CREDENTIAL);
    expect(sanitized).not.toContain('abcdefghijklmnop');
    expect(sanitized).not.toContain('supersecretvalue123');
    expect(redactSecrets('x sk-abcdefgh12345678 y')).not.toContain('abcdefgh12345678');
  });

  it('bounds message length and strips control characters', () => {
    const sanitized = sanitizeProviderMessage(`a\u0000b\u001b[31mc ${'x'.repeat(100)}`, { maxLength: 20 });
    expect(sanitized.length).toBeLessThanOrEqual(20);
    expect(sanitized).not.toContain('\u0000');
    expect(maskCredential(TEST_CREDENTIAL)).not.toBe(TEST_CREDENTIAL);
  });

  it('normalizes arbitrary thrown values into ProviderError', () => {
    expect(toProviderError(new TypeError('fetch failed')).code).toBe('network_error');
    expect(toProviderError(new TypeError('fetch failed')).retryable).toBe(true);
    expect(toProviderError({ weird: true }).code).toBe('unknown');
    const detail = providerErrorDetail(new ProviderError('rate_limited', 'slow down', { retryable: true, retryAfterMs: 5 }));
    expect(detail).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 5 });
    const unknownCode = providerErrorDetail(new ProviderError('not_a_contract_code', 'x'));
    expect(unknownCode.code).toBe('unknown');
  });

  it('extracts provider API error payloads and maps their codes', () => {
    expect(providerErrorFromApiPayload({ choices: [] })).toBeNull();
    const auth = providerErrorFromApiPayload({
      error: { message: 'invalid api key', code: 'invalid_api_key', type: 'invalid_request_error' },
    });
    expect(auth?.code).toBe('auth_error');
    const rate = providerErrorFromApiPayload({ error: { message: 'rate limit exceeded' } });
    expect(rate?.code).toBe('rate_limited');
    expect(rate?.retryable).toBe(true);
    const refused = providerErrorFromApiPayload({ error: { message: 'content_policy_violation' } });
    expect(refused?.code).toBe('refused');
  });

  it('builds HTTP errors with status, retry policy and redacted messages', () => {
    const error = providerErrorFromHttpResponse({
      status: 401,
      bodyText: JSON.stringify({ error: { message: `bad key ${TEST_CREDENTIAL}` } }),
      headers: new Headers({ 'x-request-id': 'req_1' }),
      secrets: [TEST_CREDENTIAL],
    });
    expect(error.code).toBe('auth_error');
    expect(error.httpStatus).toBe(401);
    expect(error.providerRequestId).toBe('req_1');
    expect(error.message).not.toContain(TEST_CREDENTIAL);
  });
});

describe('package exports', () => {
  it('exposes the design timeout defaults', () => {
    expect(DEFAULT_PROVIDER_TIMEOUTS).toEqual({
      firstEventTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      totalTimeoutMs: 180_000,
    });
  });

  it('exposes the frozen ProviderPackageExports port implementation', () => {
    expect(PROVIDERS_PACKAGE_VERSION).toBe('0.1.0');
    expect(typeof providerPackageExports.createAdapter).toBe('function');
    expect(typeof providerPackageExports.runCapabilityTests).toBe('function');
    expect(typeof providerPackageExports.assertProviderUrlAllowed).toBe('function');
    expect(typeof providerPackageExports.maskCredential).toBe('function');
    expect(typeof providerPackageExports.probeTextModelRequest).toBe('function');
    expect(typeof providerPackageExports.buildCapabilityRequests).toBe('function');
    expect(typeof providerPackageExports.streamEventsFromAdapter).toBe('function');
  });
});
