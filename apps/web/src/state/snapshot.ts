/**
 * Pure snapshot / event-log reducers for the business core store.
 *
 * Business state only ever comes from the server: a newer snapshot always wins
 * over an older one, and stream events are deduplicated by seq/eventId. These
 * helpers are DOM-free so they can be unit-tested under Node.
 */
import { dedupeEvents, type TaskSnapshot } from '@ca/contracts';
import type { BusinessEvent } from '../api/types';

export const MAX_EVENT_LOG = 500;

export interface SnapshotMergeResult {
  snapshot: TaskSnapshot;
  /** True when the incoming snapshot was applied. */
  applied: boolean;
  /** True when an older snapshot was rejected (never allowed to override newer state). */
  staleRejected: boolean;
}

/** Newer snapshotSeq wins; ties keep the existing snapshot and report not-applied. */
export function mergeSnapshot(previous: TaskSnapshot | null, incoming: TaskSnapshot): SnapshotMergeResult {
  if (!previous) return { snapshot: incoming, applied: true, staleRejected: false };
  if (incoming.snapshotSeq > previous.snapshotSeq) return { snapshot: incoming, applied: true, staleRejected: false };
  if (incoming.snapshotSeq === previous.snapshotSeq && incoming.serverTime > previous.serverTime) {
    return { snapshot: incoming, applied: true, staleRejected: false };
  }
  return { snapshot: previous, applied: false, staleRejected: true };
}

/** Union of event logs, deduplicated by eventId/seq, ascending and capped. */
export function mergeEventLog(previous: readonly BusinessEvent[], incoming: readonly BusinessEvent[], max = MAX_EVENT_LOG): BusinessEvent[] {
  const merged = dedupeEvents([...previous, ...incoming]);
  const tail = merged.length > max ? merged.slice(merged.length - max) : merged;
  return tail;
}

export function maxEventSeq(events: readonly BusinessEvent[]): number {
  let max = 0;
  for (const event of events) if (event.seq > max) max = event.seq;
  return max;
}

export interface AppendEventResult {
  events: BusinessEvent[];
  lastSeq: number;
  duplicate: boolean;
}

/** Apply one live stream event; duplicates (seq <= lastSeq) are ignored. */
export function appendStreamEvent(
  events: readonly BusinessEvent[],
  lastSeq: number,
  event: BusinessEvent,
  max = MAX_EVENT_LOG,
): AppendEventResult {
  if (event.seq <= lastSeq || events.some((existing) => existing.seq === event.seq || existing.eventId === event.eventId)) {
    return { events: [...events], lastSeq, duplicate: true };
  }
  const merged = mergeEventLog(events, [event], max);
  return { events: merged, lastSeq: event.seq, duplicate: false };
}

export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface ConnectionState {
  phase: ConnectionPhase;
  /** Human-readable extra context (attempts, last error, fallback polling). */
  detail: string;
  attempt: number;
  lastError: string | null;
  lastEventAt: string | null;
}

export const INITIAL_CONNECTION: ConnectionState = {
  phase: 'idle',
  detail: '未连接',
  attempt: 0,
  lastError: null,
  lastEventAt: null,
};

export function nextConnectionState(
  state: ConnectionState,
  update: Partial<ConnectionState> & { phase?: ConnectionPhase },
  now: string,
): ConnectionState {
  const next: ConnectionState = { ...state, ...update };
  if (update.phase === 'connected') {
    next.attempt = 0;
    next.lastError = null;
  }
  if (update.phase === 'reconnecting' || update.phase === 'offline') {
    next.attempt = update.attempt ?? state.attempt + 1;
    next.lastEventAt = state.lastEventAt;
  }
  if (update.lastEventAt === undefined && update.phase === 'connected' && !state.lastEventAt) {
    next.lastEventAt = now;
  }
  return next;
}

/** Whether the UI should show the polling fallback indicator. */
export function usesPollingFallback(state: ConnectionState): boolean {
  return state.phase === 'offline' || state.phase === 'reconnecting';
}
