import { describe, expect, it } from 'vitest';
import { TaskSnapshotSchema, type HarnessEvent } from '@ca/contracts';
import { buildFixtureBundle } from '../src/api/fixture/data';
import { createEventStreamTracker, createSseParser, lastEventIdHeader, reconnectDelayMs } from '../src/api/sse';

/** Reuse a contract-valid event envelope from the fixture, overriding seq/id. */
function event(seq: number): HarnessEvent {
  const snapshot = TaskSnapshotSchema.parse(buildFixtureBundle('review').snapshot);
  const base = snapshot.events[0] as unknown as HarnessEvent;
  return {
    ...base,
    eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
  } as unknown as HarnessEvent;
}

function frame(id: number | null, data: unknown, eventName = 'run.created'): { id: string | null; event: string; data: string; retryMs: number | null } {
  return { id: id == null ? null : String(id), event: eventName, data: typeof data === 'string' ? data : JSON.stringify(data), retryMs: 3000 };
}

describe('SSE parser', () => {
  it('parses frames across arbitrary chunk boundaries (CRLF, comments, retry hint)', () => {
    const parser = createSseParser();
    const chunks = ['retry: 3000\r\n\r\n', ': heartbeat\r\n\r\n', 'id: 7\r\nevent: run.created\r\nretry: 3000\r\ndata: {"a":1}\r\n\r\n'];
    const frames = chunks.flatMap((chunk) => parser.push(chunk));
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ id: '7', event: 'run.created', data: '{"a":1}', retryMs: 3000 });
  });

  it('joins multi-line data and ignores comments', () => {
    const parser = createSseParser();
    const frames = parser.push(': ping\n\nid: 9\ndata: line-1\ndata: line-2\n\n');
    expect(frames[0]?.data).toBe('line-1\nline-2');
  });

  it('buffers a partial final frame until flushed', () => {
    const parser = createSseParser();
    expect(parser.push('id: 3\ndata: {"a":')).toEqual([]);
    const frames = parser.push('1}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('{"a":1}');
  });
});

describe('event stream tracker (resume + dedupe + gap detection)', () => {
  it('applies sequential events and updates lastSeq/lastEventId', () => {
    const tracker = createEventStreamTracker(0);
    const result = tracker.receive(frame(1, event(1)));
    expect(result.kind).toBe('event');
    expect(tracker.state.lastSeq).toBe(1);
    expect(tracker.state.lastEventId).toBe(1);
  });

  it('ignores duplicate seq numbers during reconnect overlap', () => {
    const tracker = createEventStreamTracker(0);
    tracker.receive(frame(1, event(1)));
    const duplicate = tracker.receive(frame(1, event(1)));
    expect(duplicate.kind).toBe('duplicate');
    expect(tracker.state.duplicates).toBe(1);
    expect(tracker.state.lastSeq).toBe(1);
  });

  it('reports a gap once, then resumes from just before the next event (snapshot resync handles the hole)', () => {
    const tracker = createEventStreamTracker(0);
    tracker.receive(frame(1, event(1)));
    const gap = tracker.receive(frame(4, event(4)));
    expect(gap.kind).toBe('gap');
    if (gap.kind === 'gap') {
      expect(gap.fromSeq).toBe(2);
      expect(gap.toSeq).toBe(3);
    }
    expect(tracker.state.gaps).toEqual([2]);
    expect(tracker.state.lastSeq).toBe(3);
    // After the gap is surfaced (and the caller refetches the snapshot) the
    // isolated event itself is applied exactly once.
    expect(tracker.receive(frame(4, event(4))).kind).toBe('event');
    expect(tracker.state.lastSeq).toBe(4);
  });

  it('accepts a first event with a high seq after a snapshot resume (no gap)', () => {
    const tracker = createEventStreamTracker(41);
    expect(tracker.receive(frame(42, event(42))).kind).toBe('event');
    expect(tracker.state.lastSeq).toBe(42);
  });

  it('rejects malformed JSON and schema-invalid payloads as invalid_response', () => {
    const tracker = createEventStreamTracker(0);
    const malformed = tracker.receive(frame(1, '{oops'));
    expect(malformed.kind).toBe('invalid');
    if (malformed.kind === 'invalid') expect(malformed.error.code).toBe('invalid_response');
    const wrongShape = tracker.receive(frame(1, { not: 'an event' }));
    expect(wrongShape.kind).toBe('invalid');
  });

  it('ignores [DONE] sentinels', () => {
    const tracker = createEventStreamTracker(5);
    expect(tracker.receive(frame(null, '[DONE]')).kind).toBe('duplicate');
  });
});

describe('resume helpers', () => {
  it('builds Last-Event-ID only for positive ids', () => {
    expect(lastEventIdHeader(42)).toEqual({ 'Last-Event-ID': '42' });
    expect(lastEventIdHeader(0)).toEqual({});
    expect(lastEventIdHeader(null)).toEqual({});
  });

  it('uses bounded exponential backoff', () => {
    expect(reconnectDelayMs(1)).toBeGreaterThan(0);
    expect(reconnectDelayMs(10)).toBeLessThanOrEqual(15_000);
    expect(reconnectDelayMs(2)).toBeGreaterThanOrEqual(reconnectDelayMs(1));
  });
});
