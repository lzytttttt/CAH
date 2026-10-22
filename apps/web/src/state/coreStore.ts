/**
 * Business core store.
 *
 * Holds ONLY server-derived business state: session, workspace view, task list,
 * the authoritative TaskSnapshot and the merged event log. It never derives
 * success from local timers or animation callbacks (MC-01): commands are sent,
 * the server response is checked, and the authoritative snapshot is refetched.
 *
 * Implemented as a tiny external store subscribed through React's
 * useSyncExternalStore so that no business field lives in the Zustand store.
 */
import {
  type SessionInfo,
  type TaskListResponse,
  type TaskSnapshot,
  type WorkspaceView,
} from '@ca/contracts';
import { failureTitle, isConflictFailure, isSessionFailure } from '../api/errors';
import { ClientFailure, isClientFailure, type ApiClient, type BusinessEvent, type EventSubscription } from '../api/types';
import {
  INITIAL_CONNECTION,
  appendStreamEvent,
  maxEventSeq,
  mergeEventLog,
  mergeSnapshot,
  nextConnectionState,
  type ConnectionState,
} from './snapshot';

export type BootPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface Notice {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail: string;
  traceId: string | null;
  createdAt: string;
}

export interface CommandState {
  id: string;
  label: string;
  startedAt: string;
}

export interface CoreState {
  boot: BootPhase;
  bootError: ClientFailure | null;
  session: SessionInfo | null;
  workspace: WorkspaceView | null;
  workspaceError: ClientFailure | null;
  tasks: TaskListResponse | null;
  tasksError: ClientFailure | null;
  taskId: string | null;
  snapshot: TaskSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: ClientFailure | null;
  events: BusinessEvent[];
  lastSeq: number;
  connection: ConnectionState;
  command: CommandState | null;
  notices: Notice[];
  lastError: ClientFailure | null;
  /** Set when the previous snapshot was rejected as older than current state. */
  staleRejected: boolean;
  /** Reason for the last automatic resync (gap, conflict, reconnect). */
  resyncReason: string | null;
}

export interface CoreOptions {
  pollIntervalMs?: number;
  resyncDebounceMs?: number;
  now?: () => string;
}

function emptyState(): CoreState {
  return {
    boot: 'idle',
    bootError: null,
    session: null,
    workspace: null,
    workspaceError: null,
    tasks: null,
    tasksError: null,
    taskId: null,
    snapshot: null,
    snapshotLoading: false,
    snapshotError: null,
    events: [],
    lastSeq: 0,
    connection: { ...INITIAL_CONNECTION },
    command: null,
    notices: [],
    lastError: null,
    staleRejected: false,
    resyncReason: null,
  };
}

function toClientFailure(error: unknown, label: string): ClientFailure {
  if (isClientFailure(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ClientFailure({
    kind: 'invalid_response',
    code: 'internal_error',
    message: `${label}：${message}`,
    retryable: false,
    traceId: 'client-unexpected',
  });
}

export class WorkbenchCore {
  readonly client: ApiClient;

  private state: CoreState = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly pollIntervalMs: number;
  private readonly resyncDebounceMs: number;
  private readonly now: () => string;
  private subscription: EventSubscription | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private disposed = false;
  private noticeCounter = 0;
  private commandCounter = 0;

  constructor(client: ApiClient, options: CoreOptions = {}) {
    this.client = client;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.resyncDebounceMs = options.resyncDebounceMs ?? 150;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /* ----------------------------- external-store ----------------------------- */

  getState = (): CoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<CoreState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /* -------------------------------- notices -------------------------------- */

  pushNotice(tone: Notice['tone'], title: string, detail = '', traceId: string | null = null): void {
    this.noticeCounter += 1;
    const notice: Notice = {
      id: `notice-${this.noticeCounter}`,
      tone,
      title,
      detail,
      traceId,
      createdAt: this.now(),
    };
    this.set({ notices: [...this.state.notices.slice(-4), notice] });
  }

  dismissNotice(id: string): void {
    this.set({ notices: this.state.notices.filter((notice) => notice.id !== id) });
  }

  clearError(): void {
    this.set({ lastError: null, snapshotError: null });
  }

  /* --------------------------------- boot --------------------------------- */

  async boot(): Promise<void> {
    this.set({ boot: 'loading', bootError: null });
    try {
      const session = await this.client.getSession();
      const [workspace, tasks] = await Promise.all([this.client.getWorkspace(), this.client.listTasks()]);
      this.set({ boot: 'ready', session, workspace, tasks, workspaceError: null, tasksError: null });
    } catch (error) {
      const failure = toClientFailure(error, '初始化工作区');
      this.set({ boot: 'error', bootError: failure, lastError: failure });
    }
  }

  async refreshWorkspace(): Promise<void> {
    try {
      const [workspace, session] = await Promise.all([this.client.getWorkspace(), this.client.getSession()]);
      this.set({ workspace, session, workspaceError: null });
    } catch (error) {
      this.set({ workspaceError: toClientFailure(error, '读取工作区') });
    }
  }

  async loadTasks(): Promise<void> {
    try {
      this.set({ tasks: await this.client.listTasks(), tasksError: null });
    } catch (error) {
      this.set({ tasksError: toClientFailure(error, '读取任务列表') });
    }
  }

  /* ----------------------------- task lifecycle ----------------------------- */

  async openTask(taskId: string): Promise<void> {
    if (this.state.taskId === taskId && this.state.snapshot) {
      this.startPollingIfNeeded();
      return;
    }
    this.closeTask();
    this.set({
      taskId,
      snapshot: null,
      snapshotLoading: true,
      snapshotError: null,
      events: [],
      lastSeq: 0,
      staleRejected: false,
      resyncReason: null,
      connection: nextConnectionState(this.state.connection, { phase: 'connecting', detail: '正在读取任务快照…' }, this.now()),
    });
    await this.refreshSnapshot({ initial: true });
    if (this.disposed || this.state.taskId !== taskId) return;
    this.subscribeToTask(taskId);
    this.startPollingIfNeeded();
  }

  closeTask(): void {
    this.subscription?.close();
    this.subscription = null;
    this.stopPolling();
    if (this.refreshTimer != null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.set({ taskId: null, snapshot: null, events: [], lastSeq: 0, connection: { ...INITIAL_CONNECTION } });
  }

  private subscribeToTask(taskId: string): void {
    if (this.disposed) return;
    this.subscription = this.client.subscribeEvents(taskId, {
      afterSeq: this.state.lastSeq,
      lastEventId: this.state.lastSeq > 0 ? this.state.lastSeq : null,
      onOpen: () => {
        this.setConnection({ phase: 'connected', detail: '事件流已连接' });
      },
      onError: (error) => {
        this.setConnection({
          phase: 'reconnecting',
          detail: `${failureTitle(error)}：正在自动重连，同时使用快照轮询兜底`,
          lastError: error.message,
        });
        this.startPollingIfNeeded();
      },
      onStateChange: (streamState) => {
        if (streamState === 'connecting' && this.state.connection.phase === 'connected') {
          this.setConnection({ phase: 'reconnecting', detail: '事件流断开，正在重连' });
        }
        if (streamState === 'closed') {
          this.setConnection({ phase: 'offline', detail: '事件流已停止；使用快照轮询兜底' });
          this.startPollingIfNeeded();
        }
      },
      onGap: (fromSeq, toSeq) => {
        this.set({ resyncReason: `事件流序号缺口 ${fromSeq}–${toSeq}，已重新同步快照` });
        this.pushNotice('warning', '事件流出现缺口', `缺少 seq ${fromSeq}–${toSeq}，已重新获取快照以恢复一致状态。`);
        this.scheduleSnapshotRefresh(0);
      },
      onEvent: (event: BusinessEvent) => {
        const result = appendStreamEvent(this.state.events, this.state.lastSeq, event);
        if (result.duplicate) return;
        this.set({
          events: result.events,
          lastSeq: result.lastSeq,
          connection: { ...this.state.connection, lastEventAt: this.now() },
        });
        // Business fields are always taken from the authoritative snapshot;
        // the event only signals that a refresh is needed (never derives state).
        this.scheduleSnapshotRefresh();
      },
    });
    this.setConnection({
      phase: this.state.connection.phase === 'connected' ? 'connected' : 'connecting',
      detail: this.state.connection.phase === 'connected' ? '事件流已连接' : '正在连接事件流…',
    });
  }

  /* ----------------------------- snapshot sync ----------------------------- */

  async refreshSnapshot(options: { initial?: boolean; quiet?: boolean; afterSeq?: number } = {}): Promise<void> {
    const taskId = this.state.taskId;
    if (!taskId || this.disposed) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    if (options.initial) this.set({ snapshotLoading: true });
    const request = (async () => {
      try {
        const snapshot = await this.client.getSnapshot(taskId, {
          afterSeq: options.afterSeq ?? Math.max(0, this.state.lastSeq - 1),
          includeEvents: true,
        });
        if (this.disposed || this.state.taskId !== taskId) return;
        const merged = mergeSnapshot(this.state.snapshot, snapshot);
        const events = mergeEventLog(this.state.events, snapshot.events);
        const lastSeq = Math.max(this.state.lastSeq, maxEventSeq(snapshot.events), maxEventSeq(events));
        this.set({
          snapshot: merged.snapshot,
          snapshotLoading: false,
          snapshotError: null,
          events,
          lastSeq,
          staleRejected: merged.staleRejected ? true : this.state.staleRejected,
          resyncReason: merged.applied ? null : this.state.resyncReason,
        });
      } catch (error) {
        if (this.disposed || this.state.taskId !== taskId) return;
        const failure = toClientFailure(error, '读取任务快照');
        if (options.initial || !options.quiet) {
          this.set({ snapshotLoading: false, snapshotError: failure, lastError: failure });
          this.setConnection({ phase: 'offline', detail: `${failureTitle(failure)}：无法读取任务快照`, lastError: failure.message });
        } else {
          this.setConnection({ phase: 'offline', detail: '快照轮询失败，正在重试', lastError: failure.message });
        }
        if (isSessionFailure(failure)) {
          this.pushNotice('error', failureTitle(failure), failure.message, failure.traceId);
        }
      } finally {
        this.refreshInFlight = null;
      }
    })();
    this.refreshInFlight = request;
    return request;
  }

  scheduleSnapshotRefresh(delay = this.resyncDebounceMs): void {
    if (this.disposed) return;
    if (this.refreshTimer != null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSnapshot({ quiet: true });
    }, Math.max(0, delay));
  }

  private setConnection(update: Partial<ConnectionState> & { phase?: ConnectionState['phase'] }): void {
    this.set({ connection: nextConnectionState(this.state.connection, update, this.now()) });
    this.startPollingIfNeeded();
  }

  /* --------------------------- polling fallback --------------------------- */

  private startPollingIfNeeded(): void {
    const needsPoll =
      this.state.taskId != null &&
      this.state.connection.phase !== 'connected' &&
      this.state.connection.phase !== 'idle' &&
      !this.disposed;
    if (!needsPoll) {
      this.stopPolling();
      return;
    }
    if (this.pollTimer != null) return;
    this.pollTimer = setInterval(() => {
      void this.refreshSnapshot({ quiet: true });
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /* ------------------------------- commands ------------------------------- */

  /** Run one mutating command; refresh the authoritative snapshot afterwards. */
  async runCommand<T>(
    label: string,
    command: (client: ApiClient) => Promise<T>,
    options: { successNotice?: string; refresh?: boolean } = {},
  ): Promise<T | null> {
    if (this.state.command) {
      this.pushNotice('warning', '操作进行中', `请等待「${this.state.command.label}」完成后再试。`);
      return null;
    }
    this.commandCounter += 1;
    this.set({ command: { id: `command-${this.commandCounter}`, label, startedAt: this.now() }, lastError: null });
    try {
      const result = await command(this.client);
      if (options.successNotice) this.pushNotice('success', options.successNotice);
      if (options.refresh !== false) this.scheduleSnapshotRefresh(30);
      return result;
    } catch (error) {
      const failure = toClientFailure(error, label);
      this.set({ lastError: failure });
      this.pushNotice('error', failureTitle(failure), failure.message, failure.traceId);
      if (isConflictFailure(failure)) {
        this.pushNotice('warning', '已自动重新同步', '任务已被其他操作更新；已重新获取最新快照，请基于最新状态重试。');
        await this.refreshSnapshot({ quiet: true });
      }
      if (isSessionFailure(failure)) {
        try {
          const session = await this.client.getSession();
          this.set({ session });
        } catch {
          // The real connection error stays visible through the notice above.
        }
      }
      return null;
    } finally {
      this.set({ command: null });
    }
  }

  /** Read one server resource without a command envelope. */
  async read<T>(label: string, read: (client: ApiClient) => Promise<T>): Promise<T | null> {
    try {
      return await read(this.client);
    } catch (error) {
      const failure = toClientFailure(error, label);
      this.set({ lastError: failure });
      this.pushNotice('error', failureTitle(failure), failure.message, failure.traceId);
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.subscription?.close();
    this.subscription = null;
    this.stopPolling();
    if (this.refreshTimer != null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.listeners.clear();
  }
}

export function createCore(client: ApiClient, options?: CoreOptions): WorkbenchCore {
  return new WorkbenchCore(client, options);
}
