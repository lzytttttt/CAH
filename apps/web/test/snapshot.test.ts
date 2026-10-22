import { describe, expect, it } from 'vitest';
import { TaskSnapshotSchema, type HarnessEvent } from '@ca/contracts';
import { buildFixtureBundle } from '../src/api/fixture/data';
import type { BusinessEvent } from '../src/api/types';
import {
  appendStreamEvent,
  INITIAL_CONNECTION,
  maxEventSeq,
  mergeEventLog,
  mergeSnapshot,
  nextConnectionState,
  usesPollingFallback,
} from '../src/state/snapshot';

function snapshotFixture(): ReturnType<typeof TaskSnapshotSchema.parse> {
  return TaskSnapshotSchema.parse(buildFixtureBundle('review').snapshot);
}

function cloneWith(seq: number, serverTime: string, titleSuffix = ''): ReturnType<typeof TaskSnapshotSchema.parse> {
  const snapshot = snapshotFixture();
  snapshot.snapshotSeq = seq;
  snapshot.serverTime = serverTime;
  snapshot.task.title = `${snapshot.task.title}${titleSuffix}`;
  return snapshot;
}

function businessEvent(seq: number, eventIdSuffix = ''): BusinessEvent {
  const snapshot = snapshotFixture();
  const base = snapshot.events[0] as unknown as HarnessEvent;
  return { ...base, seq, eventId: `00000000-0000-4000-8000-${String(seq).padStart(8, '0')}${eventIdSuffix.slice(0, 4)}` } as unknown as BusinessEvent;
}

describe('mergeSnapshot — old snapshots never override newer state', () => {
  it('applies a newer snapshot', () => {
    const previous = cloneWith(10, '2026-10-20T02:00:00.000Z');
    const incoming = cloneWith(11, '2026-10-20T02:00:01.000Z', ' v2');
    const result = mergeSnapshot(previous, incoming);
    expect(result.applied).toBe(true);
    expect(result.staleRejected).toBe(false);
    expect(result.snapshot.task.title).toContain('v2');
  });

  it('rejects an older snapshot and keeps the current one', () => {
    const previous = cloneWith(11, '2026-10-20T02:00:01.000Z', ' current');
    const incoming = cloneWith(10, '2026-10-20T02:00:00.000Z', ' stale');
    const result = mergeSnapshot(previous, incoming);
    expect(result.applied).toBe(false);
    expect(result.staleRejected).toBe(true);
    expect(result.snapshot.task.title).toContain('current');
  });

  it('accepts equal seq when serverTime is newer', () => {
    const previous = cloneWith(11, '2026-10-20T02:00:01.000Z');
    const incoming = cloneWith(11, '2026-10-20T02:00:02.000Z', ' tie');
    expect(mergeSnapshot(previous, incoming).applied).toBe(true);
  });

  it('applies the first snapshot unconditionally', () => {
    const incoming = cloneWith(0, '2026-10-20T02:00:00.000Z');
    expect(mergeSnapshot(null, incoming)).toMatchObject({ applied: true, staleRejected: false });
  });
});

describe('event log reducers', () => {
  it('merges logs, deduplicates by seq/eventId, sorts and caps', () => {
    const first = [businessEvent(1), businessEvent(2)];
    const second = [businessEvent(2), businessEvent(3)];
    const merged = mergeEventLog(first, second);
    expect(merged.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(maxEventSeq(merged)).toBe(3);
    const capped = mergeEventLog(Array.from({ length: 501 }, (_, index) => businessEvent(index + 1)), [], 500);
    expect(capped.length).toBe(500);
    expect(capped[0]!.seq).toBe(2);
  });

  it('ignores duplicate stream events and advances lastSeq once', () => {
    const applied = appendStreamEvent([], 5, businessEvent(6));
    expect(applied.duplicate).toBe(false);
    expect(applied.lastSeq).toBe(6);
    const duplicate = appendStreamEvent(applied.events, applied.lastSeq, businessEvent(6));
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.lastSeq).toBe(6);
    expect(duplicate.events.length).toBe(1);
  });

  it('ignores out-of-order events', () => {
    const result = appendStreamEvent([businessEvent(6)], 6, businessEvent(4));
    expect(result.duplicate).toBe(true);
    expect(result.lastSeq).toBe(6);
  });
});

describe('connection reducer', () => {
  it('resets attempts on connect and tracks reconnects for the polling fallback', () => {
    const reconnecting = nextConnectionState({ ...INITIAL_CONNECTION, phase: 'connected' }, { phase: 'reconnecting', detail: '重连' }, '2026-10-20T02:00:00.000Z');
    expect(reconnecting.attempt).toBe(1);
    expect(usesPollingFallback(reconnecting)).toBe(true);
    const connected = nextConnectionState(reconnecting, { phase: 'connected', detail: '已连接' }, '2026-10-20T02:00:01.000Z');
    expect(connected.attempt).toBe(0);
    expect(connected.lastError).toBeNull();
    expect(usesPollingFallback(connected)).toBe(false);
    const offline = nextConnectionState(connected, { phase: 'offline', lastError: '断线' }, '2026-10-20T02:00:02.000Z');
    expect(usesPollingFallback(offline)).toBe(true);
    expect(offline.lastError).toBe('断线');
  });
});
