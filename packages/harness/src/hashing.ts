/**
 * Deterministic hashing, token estimation and small async utilities.
 *
 * Harness Core is UI-independent: these helpers use Node's crypto module only,
 * never DOM/canvas/timers-that-decide-business-outcomes.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ca/contracts';

/** Lowercase sha256 hex of a UTF-8 string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable content hash for artifact/JSON payloads (sorted keys). */
export function contentHash(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

/** Hash of raw tool-call argument JSON (used in tool.requested events). */
export function argumentsHash(rawArgumentsJson: string): string {
  return sha256Hex(rawArgumentsJson);
}

/**
 * Deterministic token estimate used for context budgeting when the provider
 * does not report usage. Chinese characters count ~1 token, ASCII words ~1/4;
 * it is deliberately conservative (never under-estimates by much).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + Math.ceil(nonAscii * 1.15);
}

/** UTF-8 byte length (the limits in contracts are byte based). */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Truncate by characters, appending an explicit marker so truncation is visible. */
export function truncateChars(text: string, maxChars: number, marker = '…[已截断]'): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, keep)}${marker}`;
}

/** Truncate by UTF-8 bytes without splitting surrogate pairs. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buffer = Buffer.from(text, 'utf8');
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString('utf8')}…[已截断]`;
}

/** Deterministic short sha256 prefix (for ids/previews where a full hash is noisy). */
export function shortHash(value: string, length = 12): string {
  return sha256Hex(value).slice(0, length);
}

/** Sleep helper used only for bounded retry backoff (never for business outcomes). */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Exponential backoff with deterministic-seeded jitter in [0, base/4]. */
export function backoffDelay(attempt: number, baseMs = 120, maxMs = 4_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // Deterministic jitter: derived from the attempt number, not from Math.random,
  // so test runs and incident replays line up.
  const jitter = (attempt * 37) % (Math.max(1, Math.floor(exponential / 4)) + 1);
  return Math.min(maxMs, exponential + jitter);
}
