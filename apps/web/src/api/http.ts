/**
 * Real HTTP/SSE implementation of the workbench API client.
 *
 * Only the documented command routes in `API_ROUTES` are used. Requests carry
 * the idempotency `commandId` (and `expectedRevision` where the contract asks
 * for it) inside their JSON bodies. Business state is never derived here: the
 * client returns parsed contract responses and the core store refetches the
 * authoritative snapshot after every accepted command.
 */
import {
  API_ROUTES,
  AcceptPatchResponseSchema,
  CreateRecipeResponseSchema,
  CreateRunResponseSchema,
  CreateTaskResponseSchema,
  DemoResetResponseSchema,
  DemoTemplateSchema,
  ExportResponseSchema,
  ImportResponseSchema,
  ModuleContentResponseSchema,
  PatchReviewResponseSchema,
  ProposeRecipeResponseSchema,
  ProviderProfileResponseSchema,
  RecipeListResponseSchema,
  RecipeResponseSchema,
  RejectPatchResponseSchema,
  RestoreVersionResponseSchema,
  RunControlResponseSchema,
  RunDetailResponseSchema,
  RunRecipeResponseSchema,
  SessionInfoSchema,
  SourceImportResponseSchema,
  SwitchModeResponseSchema,
  TaskListResponseSchema,
  TaskSnapshotSchema,
  TestProviderResponseSchema,
  UpdateTaskResponseSchema,
  UpdateWorkspaceResponseSchema,
  ValidateRecipeResponseSchema,
  VersionListResponseSchema,
  WorkspaceViewSchema,
  type AcceptPatchRequest,
  type AcceptPatchResponse,
  type CommitPlanRequest,
  type CreateProviderProfileRequest,
  type CreateRecipeRequest,
  type CreateRecipeResponse,
  type CreateRunRequest,
  type CreateRunResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type DemoResetRequest,
  type DemoResetResponse,
  type DemoTemplate,
  type DisableRecipeRequest,
  type ExportRequest,
  type ExportResponse,
  type HarnessEvent,
  type ImportRequest,
  type ImportResponse,
  type ModuleContentResponse,
  type PatchReviewResponse,
  type ProposeRecipeRequest,
  type ProposeRecipeResponse,
  type ProviderProfileResponse,
  type RecipeListResponse,
  type RecipeResponse,
  type RejectPatchRequest,
  type RejectPatchResponse,
  type ResolveInputRequest,
  type RestoreVersionRequest,
  type RestoreVersionResponse,
  type RunControlRequest,
  type RunControlResponse,
  type RunDetailResponse,
  type RunRecipeRequest,
  type RunRecipeResponse,
  type SessionInfo,
  type SnapshotQuery,
  type SourceImportRequest,
  type SourceImportResponse,
  type SwitchModeRequest,
  type SwitchModeResponse,
  type TaskListResponse,
  type TaskSnapshot,
  type TestProviderRequest,
  type TestProviderResponse,
  type UpdateProviderProfileRequest,
  type UpdateTaskRequest,
  type UpdateTaskResponse,
  type UpdateWorkspaceRequest,
  type UpdateWorkspaceResponse,
  type ValidateRecipeRequest,
  type ValidateRecipeResponse,
  type VersionListResponse,
  type WorkspaceView,
} from '@ca/contracts';
import { abortFailure, failureFromResponse, invalidResponseFailure, networkFailure } from './errors';
import { createEventStreamTracker, createSseParser, lastEventIdHeader, reconnectDelayMs } from './sse';
import {
  ClientFailure,
  isClientFailure,
  type ApiClient,
  type EventSubscription,
  type SubscribeEventsOptions,
} from './types';

/** Structural subset of zod used to validate responses without adding deps. */
interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number | symbol>; message: string }> } };
}

export interface HttpApiClientOptions {
  /** '' means same-origin (Vite dev proxy / server-hosted build). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds without any SSE bytes before the client reconnects. */
  sseIdleTimeoutMs?: number;
  /** Hard cap on consecutive reconnect attempts (still keeps retrying on user action). */
  sseMaxReconnectAttempts?: number;
}

const DEFAULT_SSE_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_SSE_MAX_RECONNECTS = 8;

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export class HttpApiClient implements ApiClient {
  readonly kind = 'http' as const;
  readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;
  private readonly sseIdleTimeoutMs: number;
  private readonly sseMaxReconnectAttempts: number;
  private session: SessionInfo | null = null;
  private sessionPromise: Promise<SessionInfo> | null = null;

  constructor(options: HttpApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    const boundFetch = (options.fetchImpl ?? globalThis.fetch)?.bind(globalThis);
    if (!boundFetch) throw new Error('fetch 不可用，无法创建 HTTP 客户端');
    this.fetchImpl = boundFetch;
    this.sseIdleTimeoutMs = options.sseIdleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
    this.sseMaxReconnectAttempts = options.sseMaxReconnectAttempts ?? DEFAULT_SSE_MAX_RECONNECTS;
  }

  /* ------------------------------ transport ------------------------------ */

  private currentCsrfToken(): string | null {
    return this.session?.csrfToken ? this.session.csrfToken : null;
  }

  private headers(hasBody: boolean, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', 'x-ca-client': 'web' };
    if (hasBody) headers['Content-Type'] = 'application/json';
    const csrf = this.currentCsrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;
    return { ...headers, ...(extra ?? {}) };
  }

  /** Bootstrap the local browser session once per client instance. */
  async getSession(): Promise<SessionInfo> {
    if (this.session) return this.session;
    if (this.sessionPromise) return this.sessionPromise;
    const promise = (async () => {
      const response = await this.fetchJson('会话信息', 'GET', API_ROUTES.session, undefined, SessionInfoSchema);
      this.session = response;
      return response;
    })();
    this.sessionPromise = promise;
    try {
      return await promise;
    } finally {
      this.sessionPromise = null;
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    try {
      await this.getSession();
    } catch {
      // The write request below will surface the real error with its own trace id.
    }
  }

  private async rawFetch(label: string, method: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const url = joinUrl(this.baseUrl, path);
    const init: RequestInit = {
      method,
      headers: this.headers(body !== undefined),
      credentials: 'same-origin',
      cache: 'no-store',
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') throw abortFailure(label);
      throw networkFailure(error, label);
    }
  }

  private async readBody(response: Response, label: string): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') throw abortFailure(label);
      throw networkFailure(error, label);
    }
  }

  private parseResponse<T>(label: string, text: string, schema: ResponseSchema<T>): T {
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw invalidResponseFailure('响应不是合法 JSON', label);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw invalidResponseFailure(detail, label);
    }
    return parsed.data;
  }

  private async fetchJson<T>(label: string, method: string, path: string, body: unknown, schema: ResponseSchema<T>, signal?: AbortSignal): Promise<T> {
    const response = await this.rawFetch(label, method, path, body, signal);
    const text = await this.readBody(response, label);
    if (!response.ok) throw failureFromResponse(response.status, text, label);
    return this.parseResponse(label, text, schema);
  }

  /** Command endpoints whose response body is not part of the frozen contracts. */
  private async fetchAck(label: string, method: string, path: string, body: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.rawFetch(label, method, path, body, signal);
    const text = await this.readBody(response, label);
    if (!response.ok) throw failureFromResponse(response.status, text, label);
  }

  private async writeAck(label: string, method: string, path: string, body: unknown): Promise<void> {
    await this.ensureSession();
    try {
      await this.fetchAck(label, method, path, body);
    } catch (error) {
      if (isClientFailure(error) && error.code === 'session_required') {
        this.session = null;
        await this.ensureSession();
        await this.fetchAck(label, method, path, body);
        return;
      }
      throw error;
    }
  }

  private async writeJson<T>(label: string, method: string, path: string, body: unknown, schema: ResponseSchema<T>): Promise<T> {
    await this.ensureSession();
    try {
      return await this.fetchJson(label, method, path, body, schema);
    } catch (error) {
      if (isClientFailure(error) && error.code === 'session_required') {
        this.session = null;
        await this.ensureSession();
        return this.fetchJson(label, method, path, body, schema);
      }
      throw error;
    }
  }

  /* ------------------------------- session ------------------------------- */

  async getWorkspace(): Promise<WorkspaceView> {
    return this.fetchJson('工作区信息', 'GET', API_ROUTES.workspace, undefined, WorkspaceViewSchema);
  }

  async updateWorkspace(request: UpdateWorkspaceRequest): Promise<UpdateWorkspaceResponse> {
    return this.writeJson('更新工作区策略', 'PUT', API_ROUTES.workspace, request, UpdateWorkspaceResponseSchema);
  }

  async setWorkspaceMode(request: SwitchModeRequest): Promise<SwitchModeResponse> {
    return this.writeJson('切换工作区模式', 'POST', API_ROUTES.workspaceMode, request, SwitchModeResponseSchema);
  }

  /* -------------------------------- tasks -------------------------------- */

  async listTasks(): Promise<TaskListResponse> {
    return this.fetchJson('任务列表', 'GET', API_ROUTES.tasks, undefined, TaskListResponseSchema);
  }

  async createTask(request: CreateTaskRequest): Promise<CreateTaskResponse> {
    return this.writeJson('新建任务', 'POST', API_ROUTES.tasks, request, CreateTaskResponseSchema);
  }

  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<UpdateTaskResponse> {
    return this.writeJson('更新任务', 'PATCH', API_ROUTES.task(taskId), request, UpdateTaskResponseSchema);
  }

  async getSnapshot(taskId: string, query?: SnapshotQuery): Promise<TaskSnapshot> {
    const params = new URLSearchParams();
    if (query) {
      params.set('afterSeq', String(query.afterSeq ?? 0));
      params.set('includeEvents', query.includeEvents === false ? 'false' : 'true');
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.fetchJson('任务快照', 'GET', `${API_ROUTES.taskSnapshot(taskId)}${suffix}`, undefined, TaskSnapshotSchema);
  }

  subscribeEvents(taskId: string, options: SubscribeEventsOptions): EventSubscription {
    const tracker = createEventStreamTracker(options.afterSeq);
    let closed = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let lastByteAt = Date.now();

    const clearTimers = (): void => {
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (idleTimer != null) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (closed) return;
      clearTimers();
      if (attempt >= this.sseMaxReconnectAttempts) {
        options.onStateChange?.('closed');
        return;
      }
      attempt += 1;
      const delay = reconnectDelayMs(attempt);
      options.onStateChange?.('connecting');
      reconnectTimer = setTimeout(() => {
        void connect();
      }, delay);
    };

    const handleFrame = (frame: { id: string | null; event: string; data: string; retryMs: number | null }): void => {
      const result = tracker.receive(frame);
      switch (result.kind) {
        case 'event':
          attempt = 0;
          options.onEvent(result.event);
          break;
        case 'duplicate':
          break;
        case 'gap':
          options.onGap?.(result.fromSeq, result.toSeq);
          break;
        case 'invalid':
          options.onError?.(result.error);
          break;
      }
    };

    const connect = async (): Promise<void> => {
      if (closed) return;
      controller = new AbortController();
      options.onStateChange?.(attempt === 0 ? 'connecting' : 'connecting');
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        'x-ca-client': 'web',
        ...lastEventIdHeader(tracker.state.lastEventId),
      };
      const csrf = this.currentCsrfToken();
      if (csrf) headers['x-csrf-token'] = csrf;
      let response: Response;
      try {
        response = await this.fetchImpl(joinUrl(this.baseUrl, `${API_ROUTES.taskEvents(taskId)}?afterSeq=${tracker.state.lastSeq}`), {
          method: 'GET',
          headers,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch (error) {
        if (closed) return;
        if ((error as { name?: string } | null)?.name === 'AbortError') return;
        options.onError?.(networkFailure(error, '事件订阅'));
        scheduleReconnect();
        return;
      }
      if (!response.ok || !response.body) {
        const text = await this.readBody(response, '事件订阅').catch(() => '');
        options.onError?.(failureFromResponse(response.status, text, '事件订阅'));
        scheduleReconnect();
        return;
      }
      attempt = 0;
      options.onOpen?.();
      options.onStateChange?.('open');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      lastByteAt = Date.now();
      idleTimer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastByteAt > this.sseIdleTimeoutMs) {
          // Stale stream: abort so the reconnect loop re-attaches with Last-Event-ID.
          controller?.abort();
        }
      }, Math.min(15_000, Math.max(5_000, Math.floor(this.sseIdleTimeoutMs / 3))));
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          lastByteAt = Date.now();
          const text = decoder.decode(value, { stream: true });
          for (const frame of parser.push(text)) handleFrame(frame);
          if (closed) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
        lastByteAt = Date.now();
      } catch (error) {
        if (closed) return;
        if ((error as { name?: string } | null)?.name !== 'AbortError') {
          options.onError?.(networkFailure(error, '事件订阅'));
        }
      } finally {
        if (idleTimer != null) {
          clearInterval(idleTimer);
          idleTimer = null;
        }
      }
      scheduleReconnect();
    };

    void connect();

    return {
      close(): void {
        if (closed) return;
        closed = true;
        clearTimers();
        controller?.abort();
        options.onStateChange?.('closed');
      },
      isOpen(): boolean {
        return !closed && controller != null && !controller.signal.aborted;
      },
    };
  }

  /* ------------------------------- sources ------------------------------- */

  async importSource(taskId: string, request: SourceImportRequest): Promise<SourceImportResponse> {
    return this.writeJson('导入资料', 'POST', API_ROUTES.taskSources(taskId), request, SourceImportResponseSchema);
  }

  /* --------------------------------- runs --------------------------------- */

  async createRun(taskId: string, request: CreateRunRequest): Promise<CreateRunResponse> {
    return this.writeJson('创建运行', 'POST', API_ROUTES.taskRuns(taskId), request, CreateRunResponseSchema);
  }

  async commitPlan(runId: string, request: CommitPlanRequest): Promise<RunControlResponse> {
    return this.writeJson('提交计划', 'POST', API_ROUTES.runCommit(runId), request, RunControlResponseSchema);
  }

  async resolveInput(runId: string, request: ResolveInputRequest): Promise<RunControlResponse> {
    return this.writeJson('处理待决问题', 'POST', API_ROUTES.runResolve(runId), request, RunControlResponseSchema);
  }

  async pauseRun(runId: string, request: RunControlRequest): Promise<RunControlResponse> {
    return this.writeJson('暂停运行', 'POST', API_ROUTES.runPause(runId), request, RunControlResponseSchema);
  }

  async resumeRun(runId: string, request: RunControlRequest): Promise<RunControlResponse> {
    return this.writeJson('继续运行', 'POST', API_ROUTES.runResume(runId), request, RunControlResponseSchema);
  }

  async cancelRun(runId: string, request: RunControlRequest): Promise<RunControlResponse> {
    return this.writeJson('停止运行', 'POST', API_ROUTES.runCancel(runId), request, RunControlResponseSchema);
  }

  async getRunDetail(runId: string): Promise<RunDetailResponse> {
    return this.fetchJson('运行详情', 'GET', API_ROUTES.run(runId), undefined, RunDetailResponseSchema);
  }

  /* -------------------------------- patches -------------------------------- */

  async getPatchReview(patchId: string): Promise<PatchReviewResponse> {
    return this.fetchJson('差异审阅', 'GET', API_ROUTES.patch(patchId), undefined, PatchReviewResponseSchema);
  }

  async acceptPatch(patchId: string, request: AcceptPatchRequest): Promise<AcceptPatchResponse> {
    return this.writeJson('接受变更', 'POST', API_ROUTES.patchAccept(patchId), request, AcceptPatchResponseSchema);
  }

  async rejectPatch(patchId: string, request: RejectPatchRequest): Promise<RejectPatchResponse> {
    return this.writeJson('拒绝变更', 'POST', API_ROUTES.patchReject(patchId), request, RejectPatchResponseSchema);
  }

  async getModuleContent(taskId: string, moduleId: string): Promise<ModuleContentResponse> {
    return this.fetchJson('模块内容', 'GET', API_ROUTES.taskModuleContent(taskId, moduleId), undefined, ModuleContentResponseSchema);
  }

  async getVersions(taskId: string, moduleId: string): Promise<VersionListResponse> {
    return this.fetchJson('版本历史', 'GET', API_ROUTES.taskVersions(taskId, moduleId), undefined, VersionListResponseSchema);
  }

  async restoreVersion(artifactId: string, request: RestoreVersionRequest): Promise<RestoreVersionResponse> {
    return this.writeJson('恢复历史版本', 'POST', API_ROUTES.artifactRestore(artifactId), request, RestoreVersionResponseSchema);
  }

  /* ------------------------------- providers ------------------------------- */

  async createProviderProfile(request: CreateProviderProfileRequest): Promise<ProviderProfileResponse> {
    return this.writeJson('保存连接配置', 'POST', API_ROUTES.providerProfiles, request, ProviderProfileResponseSchema);
  }

  async updateProviderProfile(id: string, request: UpdateProviderProfileRequest): Promise<ProviderProfileResponse> {
    return this.writeJson('更新连接配置', 'PUT', API_ROUTES.providerProfile(id), request, ProviderProfileResponseSchema);
  }

  async testProviderProfile(id: string, request: TestProviderRequest): Promise<TestProviderResponse> {
    return this.writeJson('测试连接能力', 'POST', API_ROUTES.providerProfileTest(id), request, TestProviderResponseSchema);
  }

  /* -------------------------------- recipes -------------------------------- */

  async proposeRecipe(request: ProposeRecipeRequest): Promise<ProposeRecipeResponse> {
    return this.writeJson('提取候选配方', 'POST', API_ROUTES.recipePropose, request, ProposeRecipeResponseSchema);
  }

  async createRecipe(request: CreateRecipeRequest): Promise<CreateRecipeResponse> {
    return this.writeJson('保存配方', 'POST', API_ROUTES.recipes, request, CreateRecipeResponseSchema);
  }

  async listRecipes(taskId: string): Promise<RecipeListResponse> {
    return this.fetchJson('配方列表', 'GET', `${API_ROUTES.recipes}?taskId=${encodeURIComponent(taskId)}`, undefined, RecipeListResponseSchema);
  }

  async getRecipe(recipeId: string): Promise<RecipeResponse> {
    return this.fetchJson('配方详情', 'GET', API_ROUTES.recipe(recipeId), undefined, RecipeResponseSchema);
  }

  async validateRecipe(recipeId: string, request: ValidateRecipeRequest): Promise<ValidateRecipeResponse> {
    return this.writeJson('测试配方', 'POST', API_ROUTES.recipeValidate(recipeId), request, ValidateRecipeResponseSchema);
  }

  async runRecipe(recipeId: string, request: RunRecipeRequest): Promise<RunRecipeResponse> {
    return this.writeJson('运行配方', 'POST', API_ROUTES.recipeRun(recipeId), request, RunRecipeResponseSchema);
  }

  async disableRecipe(recipeId: string, request: DisableRecipeRequest): Promise<RecipeResponse> {
    return this.writeJson('禁用配方', 'POST', API_ROUTES.recipeDisable(recipeId), request, RecipeResponseSchema);
  }

  /* --------------------------- transfer / demo --------------------------- */

  async exportTask(taskId: string, request: ExportRequest): Promise<ExportResponse> {
    return this.writeJson('导出成果', 'POST', API_ROUTES.taskExport(taskId), request, ExportResponseSchema);
  }

  async importTask(request: ImportRequest): Promise<ImportResponse> {
    return this.writeJson('导入任务包', 'POST', API_ROUTES.imports, request, ImportResponseSchema);
  }

  async demoReset(request: DemoResetRequest): Promise<DemoResetResponse> {
    return this.writeJson('重置演示数据', 'POST', API_ROUTES.demoReset, request, DemoResetResponseSchema);
  }

  async getDemoScenario(): Promise<DemoTemplate> {
    return this.fetchJson('演示场景信息', 'GET', API_ROUTES.demoScenario, undefined, DemoTemplateSchema);
  }
}

export function createHttpClient(options: HttpApiClientOptions = {}): HttpApiClient {
  return new HttpApiClient(options);
}

/** Type guard used by UI error rendering. */
export function asClientFailure(error: unknown): ClientFailure | null {
  return isClientFailure(error) ? error : null;
}

/** Re-exported for the UI event inspector. */
export type { HarnessEvent };
