import type { RunState } from '@ca/contracts';
import type { HarnessEngine } from '@ca/harness';
import type { StoragePort } from '@ca/storage';

export interface RunSchedulerOptions {
  storage: StoragePort;
  harness: HarnessEngine;
  maxActiveRuns: number;
  log?: (message: string, details?: Record<string, unknown>) => void;
  tickIntervalMs?: number;
}

/**
 * Server-side capacity scheduler (design 5.3): per task 1 writing run, globally
 * max 2 active runs, the rest queue with a visible position. Scheduling is
 * infrastructure only: it never fakes progress or completes work.
 */
export class RunScheduler {
  private readonly storage: StoragePort;
  private readonly harness: HarnessEngine;
  private readonly maxActiveRuns: number;
  private readonly log: (message: string, details?: Record<string, unknown>) => void;
  private readonly tickIntervalMs: number;
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: RunSchedulerOptions) {
    this.storage = options.storage;
    this.harness = options.harness;
    this.maxActiveRuns = Math.max(1, options.maxActiveRuns);
    this.log = options.log ?? (() => {});
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  hasCapacity(): boolean {
    return this.running.size < this.maxActiveRuns;
  }

  activeCount(): number {
    return this.running.size;
  }

  /** Start a committed run immediately if capacity allows, otherwise queue it visibly. */
  async submit(runId: string): Promise<{ queued: boolean; position: number | null }> {
    if (this.hasCapacity() && !this.running.has(runId)) {
      this.launch(runId);
      return { queued: false, position: null };
    }
    const run = await this.storage.getRun(runId);
    if (!run) return { queued: false, position: null };
    const queued = await this.storage.listQueuedRuns();
    const position = queued.length + 1;
    await this.storage.updateRun({ ...run, queuePosition: position, updatedAt: new Date().toISOString() }, run.revision);
    this.log('run queued', { runId, position });
    return { queued: true, position };
  }

  /** Called by the harness when a run settles. */
  onRunFinished(runId: string, state: RunState): void {
    this.running.delete(runId);
    this.log('run finished', { runId, state });
    void this.tick();
  }

  /** Start queued READY runs while capacity remains. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      while (this.hasCapacity()) {
        const queued = await this.storage.listQueuedRuns();
        const next = queued.find((run) => !this.running.has(run.id) && run.state === 'READY');
        if (!next) return;
        await this.launchQueued(next.id, next.planVersion, next.contextSnapshotId);
      }
    } catch (error) {
      this.log('scheduler tick failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async launchQueued(runId: string, planVersion: number, contextSnapshotId: string | null): Promise<void> {
    const run = await this.storage.getRun(runId);
    if (!run) return;
    if (!contextSnapshotId || planVersion < 1) {
      // Cannot safely resume a commit without its snapshot; leave it for the user.
      await this.storage.updateRun({ ...run, queuePosition: null, updatedAt: new Date().toISOString() }, run.revision);
      return;
    }
    const task = await this.storage.getTask(run.taskId);
    this.running.add(runId);
    await this.storage.updateRun({ ...run, queuePosition: null, updatedAt: new Date().toISOString() }, run.revision);
    try {
      await this.harness.commit({
        commandId: `queue-${runId}-${run.attempt}`,
        runId: run.id,
        expectedRevision: task?.revision ?? 0,
        planVersion,
        contextSnapshotId,
        actor: 'system',
      });
      this.launch(runId);
    } catch (error) {
      this.running.delete(runId);
      this.log('queued commit failed', { runId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private launch(runId: string): void {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    this.harness
      .startRun(runId as never)
      .catch((error) => {
        this.log('run loop crashed', { runId, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.running.delete(runId);
        void this.tick();
      });
  }
}
