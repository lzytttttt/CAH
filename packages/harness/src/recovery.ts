/**
 * Recovery matrix (design section 19.2).
 *
 * After a process restart, runs that were actively executing in this storage are
 * marked INTERRUPTED with their last checkpoint and any tool calls whose outcome
 * is unknown. The kernel never auto-replays unknown side effects: read-only calls
 * may be retried safely, everything else requires human reconciliation.
 */
import { isTerminalRunState, newRunId, type Run, type RunState } from '@ca/contracts';
import type { Runtime } from './runtime';
import { findTerminalEventForRun } from './events-tx';
import type { RecoveryReport } from './types';

const RECOVERABLE_ACTIVE_STATES: readonly RunState[] = [
  'PLANNING',
  'RUNNING',
  'PAUSING',
  'VALIDATING',
  'COMMITTING',
];

export interface RecoveryOptions {
  ownerId: string;
  leaseTtlMs: number;
  /** Runs currently executing in this process are not touched. */
  isActive: (runId: string) => boolean;
}

export async function recoverInterruptedRuns(runtime: Runtime, options: RecoveryOptions): Promise<RecoveryReport> {
  const report: RecoveryReport = { interrupted: [], recovered: 0, skipped: 0 };
  const tasks = await runtime.storage.listTasks();
  for (const task of tasks) {
    const runs = await runtime.storage.listRuns(task.id);
    for (const run of runs) {
      if (isTerminalRunState(run.state)) continue;
      if (!RECOVERABLE_ACTIVE_STATES.includes(run.state)) continue;
      if (options.isActive(run.id)) {
        report.skipped += 1;
        continue;
      }
      const leaseOwner = await runtime.storage.listLeaseOwner(run.id);
      if (leaseOwner && leaseOwner !== options.ownerId) {
        report.skipped += 1;
        continue;
      }
      const acquired = await runtime.storage.acquireRunLease(run.id, options.ownerId, options.leaseTtlMs);
      if (!acquired) {
        report.skipped += 1;
        continue;
      }
      try {
        // A crash after the acceptance transaction but before the run row update:
        // the committed terminal event is the source of truth, so reconcile.
        if (run.state === 'COMMITTING') {
          const terminal = await findTerminalEventForRun(runtime.storage, task.id, run.id);
          if (terminal && terminal.type === 'run.completed') {
            await reconcileCompletedRun(runtime, run);
            report.recovered += 1;
            continue;
          }
        }
        const lastCheckpoint = await runtime.storage.latestCheckpoint(run.id);
        const unclear = await runtime.storage.findUnclearToolInvocations(run.id);
        const unclearIds = unclear.map((record) => record.toolCallId);
        const interrupted = await markInterrupted(runtime, run, lastCheckpoint?.id ?? null, unclearIds);
        report.interrupted.push({
          runId: interrupted.id,
          lastCheckpointId: lastCheckpoint?.id ?? null,
          unclearToolCalls: unclearIds,
        });
        report.recovered += 1;
      } finally {
        await runtime.storage.releaseRunLease(run.id, options.ownerId).catch(() => undefined);
      }
    }
  }
  return report;
}

async function reconcileCompletedRun(runtime: Runtime, run: Run): Promise<void> {
  await runtime.txn(
    run.taskId,
    async () => {
      const fresh = await runtime.storage.getRun(run.id);
      if (!fresh || fresh.state === 'COMPLETED') return;
      const next: Run = {
        ...fresh,
        state: 'COMPLETED',
        finishedAt: fresh.finishedAt ?? runtime.now(),
        updatedAt: runtime.now(),
        revision: fresh.revision + 1,
        returnState: null,
      };
      await runtime.storage.updateRun(next, fresh.revision);
    },
    { runId: run.id },
  );
}

async function markInterrupted(
  runtime: Runtime,
  run: Run,
  lastCheckpointId: string | null,
  unclearToolCalls: readonly string[],
): Promise<Run> {
  return runtime.txn(
    run.taskId,
    async (tx) => {
      const fresh = await runtime.storage.getRun(run.id);
      if (!fresh || isTerminalRunState(fresh.state)) return fresh ?? run;
      const now = runtime.now();
      const next: Run = {
        ...fresh,
        state: 'INTERRUPTED',
        interrupted: {
          reason: 'lease_expired',
          lastCheckpointId: lastCheckpointId as never,
          unclearToolCalls: unclearToolCalls.slice(0, 64) as never,
          interruptedAt: now,
        },
        updatedAt: now,
        revision: fresh.revision + 1,
        returnState: fresh.state,
      };
      await runtime.storage.updateRun(next, fresh.revision);
      tx.emit('run.interrupted', {
        runId: next.id,
        lastCheckpointId,
        unclearToolCalls: unclearToolCalls.slice(0, 64) as never,
        reason: 'lease_expired',
      });
      tx.emit('run.state_changed', {
        from: fresh.state,
        to: 'INTERRUPTED',
        reason: '进程中断/租约失效，已保存最后检查点；不会自动重放未知副作用',
      });
      for (const record of await runtime.storage.findUnclearToolInvocations(fresh.id)) {
        await runtime.storage.updateToolInvocation({ ...record, status: 'outcome_unknown' });
        tx.emit('tool.outcome_unknown', {
          toolCallId: record.toolCallId,
          toolId: record.toolId,
          detail: '进程中断时该调用结果未知；是否可安全重试取决于工具是否只读',
          retryRefused: true,
        });
      }
      return next;
    },
    { runId: run.id },
  );
}

/** True when a run can be safely resumed without human reconciliation. */
export function hasUnsafeUnknownCalls(
  unclear: ReadonlyArray<{ toolId: string; status: string }>,
  ids: ReadonlySet<string>,
): boolean {
  return unclear.some((record) => !ids.has(record.toolId) && record.status !== 'succeeded');
}

/** Re-export for tests/CLI diagnostics. */
export function newRecoveryRunId(): string {
  return newRunId();
}
