/**
 * Atomic business-event emission.
 *
 * Contract: every persisted business state change is written in the same
 * `storage.transaction()` as its event(s). `EventTx` buffers the event drafts and
 * flushes them at the end of the transaction, so a failed transaction never
 * leaves a committed event behind.
 */
import {
  canTransitionRun,
  EVENT_CATEGORY_BY_TYPE,
  illegalRunTransitionMessage,
  newUuid,
  type EventPayloads,
  type EventType,
  type HarnessEvent,
  type Plan,
  type Run,
  type RunState,
  type TaskId,
} from '@ca/contracts';
import type { EventDraft, StoragePort } from '@ca/storage';
import { HarnessError } from './types';
import type { Clock } from './types';

export class EventTx {
  readonly drafts: EventDraft[] = [];
  runId: string | null;
  stepId: string | null;
  causationId: string | null = null;

  constructor(
    readonly taskId: TaskId,
    private readonly clock: Clock,
    runId: string | null = null,
    stepId: string | null = null,
  ) {
    this.runId = runId;
    this.stepId = stepId;
  }

  emit<T extends EventType>(
    type: T,
    payload: EventPayloads[T],
    options: { runId?: string | null; stepId?: string | null; causationId?: string | null } = {},
  ): void {
    this.drafts.push({
      runId: options.runId !== undefined ? options.runId : this.runId,
      stepId: options.stepId !== undefined ? options.stepId : this.stepId,
      causationId: options.causationId ?? this.causationId,
      type,
      payload,
      timestamp: this.clock.now(),
    } as EventDraft);
  }

  /** True when the transaction already emitted an event of this type. */
  has(type: EventType): boolean {
    return this.drafts.some((draft) => draft.type === type);
  }
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) {
    throw new HarnessError('state_not_allowed', illegalRunTransitionMessage(from, to), {
      details: { from, to },
    });
  }
}

/** Mutate a run: bump revision/updatedAt and push the matching state-change event. */
export function transitionRun(
  run: Run,
  to: RunState,
  reason: string,
  now: string,
  patch: Partial<Run> = {},
): Run {
  assertRunTransition(run.state, to);
  return {
    ...run,
    ...patch,
    state: to,
    revision: run.revision + 1,
    updatedAt: now,
  };
}

/** Build the run.state_changed payload for a transition. */
export function stateChangedPayload(from: RunState, to: RunState, reason: string): EventPayloads['run.state_changed'] {
  return { from, to, reason: reason.slice(0, 2000) };
}

export interface TransactionHost {
  storage: StoragePort;
  clock: Clock;
}

/**
 * Run `fn` inside a storage transaction; event drafts buffered on the tx are
 * appended before the transaction commits.
 */
export async function runInTransaction<T>(
  host: TransactionHost,
  taskId: TaskId,
  fn: (tx: EventTx) => Promise<T>,
  options: { runId?: string | null; stepId?: string | null } = {},
): Promise<T> {
  return host.storage.transaction(async () => {
    const tx = new EventTx(taskId, host.clock, options.runId ?? null, options.stepId ?? null);
    const result = await fn(tx);
    if (tx.drafts.length > 0) {
      await host.storage.appendEvents(taskId, tx.drafts);
    }
    return result;
  });
}

/* ------------------------------ event queries ------------------------------ */

/** Read the complete task event log (bounded by the storage page size). */
export async function readAllEvents(storage: StoragePort, taskId: TaskId, pageSize = 500): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await storage.eventsAfter(taskId, afterSeq, pageSize);
    if (page.length === 0) break;
    out.push(...page);
    const last = page[page.length - 1];
    if (!last) break;
    afterSeq = last.seq;
    if (page.length < pageSize) break;
  }
  return out;
}

/** Latest plan (highest planVersion) recorded for a run, reconstructed from events. */
export async function loadLatestPlanFromEvents(
  storage: StoragePort,
  taskId: TaskId,
  runId: string,
): Promise<Plan | null> {
  const events = await readAllEvents(storage, taskId);
  let best: Plan | null = null;
  for (const event of events) {
    if (event.runId !== runId) continue;
    if (event.type !== 'plan.proposed' && event.type !== 'plan.revised') continue;
    const payload = event.payload as EventPayloads['plan.proposed'] | EventPayloads['plan.revised'];
    if (!best || payload.planVersion >= best.version) best = payload.plan;
  }
  return best;
}

export async function findPlanVersionFromEvents(
  storage: StoragePort,
  taskId: TaskId,
  runId: string,
  planVersion: number,
): Promise<Plan | null> {
  const events = await readAllEvents(storage, taskId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.runId !== runId) continue;
    if (event.type !== 'plan.proposed' && event.type !== 'plan.revised') continue;
    const payload = event.payload as EventPayloads['plan.proposed'] | EventPayloads['plan.revised'];
    if (payload.planVersion === planVersion) return payload.plan;
  }
  return null;
}

/** True when a terminal run event was already committed for this run. */
export async function findTerminalEventForRun(
  storage: StoragePort,
  taskId: TaskId,
  runId: string,
): Promise<HarnessEvent | null> {
  const events = await readAllEvents(storage, taskId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.runId !== runId) continue;
    if (event.type === 'run.completed' || event.type === 'run.cancelled' || event.type === 'run.failed') {
      return event;
    }
  }
  return null;
}

/** Latest validation report id recorded for a run (from validation.completed). */
export async function loadLatestValidationReportId(
  storage: StoragePort,
  taskId: TaskId,
  runId: string,
): Promise<string | null> {
  const events = await readAllEvents(storage, taskId);
  let reportId: string | null = null;
  for (const event of events) {
    if (event.runId !== runId) continue;
    if (event.type !== 'validation.completed') continue;
    reportId = (event.payload as EventPayloads['validation.completed']).validationReportId;
  }
  return reportId;
}

/** Validate that an event draft's payload/category agree (used by fakes and tests). */
export function categoryFor(type: EventType): string {
  return EVENT_CATEGORY_BY_TYPE[type];
}

export function eventIdFor(): string {
  return newUuid();
}
