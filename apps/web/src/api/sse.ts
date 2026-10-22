/**
 * Server-sent-events parsing and resume/dedupe bookkeeping.
 *
 * The parser is DOM-free and pure so it can be unit-tested under vitest's Node
 * environment. The connection wrapper (http.ts) owns fetch/AbortController.
 */
import { HarnessEventSchema } from '@ca/contracts';
import { invalidResponseFailure } from './errors';
import type { BusinessEvent, ClientFailure } from './types';

export interface SseFrame {
  /** SSE `id:` field. The server uses the task-local event seq. */
  id: string | null;
  /** SSE `event:` field; defaults to "message". */
  event: string;
  /** Unparsed `data:` payload (multi-line data joined with "\n"). */
  data: string;
  /** Server-provided reconnect hint from a `retry:` field, if present. */
  retryMs: number | null;
}

/**
 * Incremental SSE text parser. Handles CRLF/CR/LF, multi-line data, comments
 * (heartbeats start with `:`), `id`, `event`, `retry` and buffers partial
 * frames across chunk boundaries.
 */
export function createSseParser(): { push(chunk: string): SseFrame[]; flush(): SseFrame[] } {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName = 'message';
  let id: string | null = null;
  let retryMs: number | null = null;
  let firstChunk = true;
  let pendingLine = '';

  function dispatch(out: SseFrame[]): void {
    if (dataLines.length > 0 || id !== null || eventName !== 'message') {
      out.push({ id, event: eventName, data: dataLines.join('\n'), retryMs });
    }
    dataLines = [];
    eventName = 'message';
    retryMs = null;
    // Per the SSE spec the last event id persists across frames; keep `id`.
  }

  function consumeLine(line: string, out: SseFrame[]): void {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'id':
        id = value;
        break;
      case 'event':
        eventName = value || 'message';
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'retry': {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) retryMs = parsed;
        break;
      }
      default:
        break;
    }
  }

  function feed(text: string): SseFrame[] {
    const out: SseFrame[] = [];
    if (firstChunk) {
      firstChunk = false;
      if (text.startsWith('\uFEFF')) text = text.slice(1);
    }
    buffer += text;
    for (;;) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match) break;
      const index = match.index ?? buffer.length;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + match[0].length);
      pendingLine = line;
      consumeLine(line, out);
    }
    return out;
  }

  return {
    push: feed,
    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (buffer.length > 0) {
        consumeLine(buffer, out);
        buffer = '';
      }
      if (pendingLine !== '') dispatch(out);
      return out;
    },
  };
}

/**
 * Pure resume tracker for one task event stream.
 *
 * - duplicate seq numbers are ignored (reconnect overlap),
 * - a seq jump is reported as a gap so the caller refetches the snapshot,
 * - a non-JSON / schema-invalid frame surfaces as an invalid_response failure
 *   instead of silently desynchronizing the UI.
 */
export interface EventStreamTrackerState {
  lastSeq: number;
  lastEventId: number | null;
  seen: number[];
  applied: number;
  duplicates: number;
  gaps: number[];
}

export type EventStreamResult =
  | { kind: 'event'; event: BusinessEvent; seq: number }
  | { kind: 'duplicate'; seq: number }
  | { kind: 'gap'; fromSeq: number; toSeq: number }
  | { kind: 'invalid'; error: ClientFailure };

export function createEventStreamTracker(afterSeq = 0): {
  state: EventStreamTrackerState;
  receive(frame: SseFrame): EventStreamResult;
} {
  const state: EventStreamTrackerState = {
    lastSeq: Math.max(0, afterSeq),
    lastEventId: afterSeq > 0 ? afterSeq : null,
    seen: [],
    applied: 0,
    duplicates: 0,
    gaps: [],
  };

  return {
    state,
    receive(frame: SseFrame): EventStreamResult {
      const raw = frame.data.trim();
      if (!raw || raw === '[DONE]') return { kind: 'duplicate', seq: state.lastSeq };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return { kind: 'invalid', error: invalidResponseFailure('SSE data 不是合法 JSON', '事件流') };
      }
      // Accept a bare HarnessEvent, or an envelope of shape { event: HarnessEvent }.
      const candidate =
        parsed && typeof parsed === 'object' && 'event' in (parsed as Record<string, unknown>)
          ? (parsed as Record<string, unknown>).event
          : parsed;
      const result = HarnessEventSchema.safeParse(candidate);
      if (!result.success) {
        const detail = result.error.issues.slice(0, 2).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        return { kind: 'invalid', error: invalidResponseFailure(detail || '事件 schema 校验失败', '事件流') };
      }
      const event = result.data as unknown as BusinessEvent;
      const frameId = frame.id != null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
      const seq = event.seq || frameId || 0;
      if (seq === 0) return { kind: 'invalid', error: invalidResponseFailure('事件缺少 seq', '事件流') };

      if (state.seen.includes(seq) || seq <= state.lastSeq) {
        state.duplicates += 1;
        return { kind: 'duplicate', seq };
      }
      if (seq > state.lastSeq + 1 && state.lastSeq > 0) {
        state.gaps.push(state.lastSeq + 1);
        // The caller refetches the authoritative snapshot (which supersedes the
        // missing events), so resume right before this event instead of
        // reporting the same gap forever on every reconnect.
        state.lastSeq = seq - 1;
        return { kind: 'gap', fromSeq: state.gaps[state.gaps.length - 1]!, toSeq: seq - 1 };
      }
      state.lastSeq = seq;
      state.lastEventId = frameId ?? seq;
      state.applied += 1;
      state.seen.push(seq);
      if (state.seen.length > 2000) state.seen.splice(0, state.seen.length - 2000);
      return { kind: 'event', event, seq };
    },
  };
}

/** Resume header used by the fetch-based SSE reader. */
export function lastEventIdHeader(lastEventId: number | null): Record<string, string> {
  return lastEventId != null && lastEventId > 0 ? { 'Last-Event-ID': String(lastEventId) } : {};
}

/** Reconnect backoff (network layer only; never decides business state). */
export function reconnectDelayMs(attempt: number): number {
  const base = Math.min(15_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 4)));
  return Math.round(base * 0.8 + (base * 0.2 * deterministicJitter(attempt)));
}

function deterministicJitter(attempt: number): number {
  // Deterministic so unit tests are stable; jitter is only to avoid thundering herds.
  const x = Math.sin(attempt * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
