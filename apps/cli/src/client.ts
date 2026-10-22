/**
 * Typed HTTP/SSE client for the Cognitive Atrium command API.
 *
 * Contract points enforced here:
 *  - every request carries `X-CA-Client: cli`;
 *  - the local session token is sent as `Authorization: Bearer <token>` when
 *    available (missing token still attempts the request, as the design allows
 *    same-machine CLI access);
 *  - only idempotent reads are retried; POST commands are never replayed
 *    automatically (an unsafe retry could duplicate a real side effect);
 *  - responses are validated against the frozen `@ca/contracts` schemas, and a
 *    mismatch is a protocol error (exit 5) rather than a silent partial success;
 *  - API errors are parsed structurally (code/message/retryable/details/traceId)
 *    and mapped to exit codes without inspecting human wording.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ApiErrorBodySchema,
  type ApiErrorBody,
  type CommandId,
} from '@ca/contracts';
import type { Globals } from './args';
import { parseSse, type SseMessage } from './sse';
import {
  ApiError,
  AuthError,
  CliError,
  ConfigError,
  ConnectionError,
  ProtocolError,
  toCliError,
} from './exit';

/** Structural subset of a zod schema so this module does not import zod directly. */
export interface ResponseSchema<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

export interface AuthState {
  token: string | null;
  source: 'token-file' | 'environment' | 'none';
  tokenFile: string | null;
  /** Human-readable diagnostics, e.g. "令牌文件不存在". */
  notes: string[];
}

export interface LoadAuthOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  globals: Globals;
  log?: (line: string) => void;
}

/**
 * Resolve the CLI session token. Order:
 *   1. --token-file <path>
 *   2. $CA_TOKEN_FILE
 *   3. $CA_SESSION_TOKEN (direct value)
 *   4. <CA_DATA_DIR or ./data>/session-token
 * A missing file is not fatal: we still attempt the request and let the server
 * decide (401 => exit 3 with an actionable message).
 */
export function loadAuth(options: LoadAuthOptions): AuthState {
  const { env, cwd, globals } = options;
  const notes: string[] = [];
  const explicitFile = globals.tokenFile ?? (env.CA_TOKEN_FILE && env.CA_TOKEN_FILE.trim() !== '' ? env.CA_TOKEN_FILE.trim() : null);
  if (explicitFile) {
    const resolved = path.resolve(cwd, explicitFile);
    return readTokenFile(resolved, notes, true);
  }
  const envToken = env.CA_SESSION_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: 'environment', tokenFile: null, notes };
  }
  const dataDir = env.CA_DATA_DIR && env.CA_DATA_DIR.trim() !== '' ? env.CA_DATA_DIR.trim() : 'data';
  const defaultFile = path.resolve(cwd, dataDir, 'session-token');
  return readTokenFile(defaultFile, notes, false);
}

function readTokenFile(file: string, notes: string[], explicit: boolean): AuthState {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const token = normalizeTokenFileContent(raw);
    if (!token) {
      notes.push(`会话令牌文件为空：${file}`);
      return { token: null, source: 'none', tokenFile: file, notes };
    }
    return { token, source: 'token-file', tokenFile: file, notes };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      notes.push(explicit ? `指定的会话令牌文件不存在：${file}` : `未找到本地会话令牌文件（服务可能尚未启动或写入）：${file}`);
      return { token: null, source: 'none', tokenFile: file, notes };
    }
    notes.push(`读取会话令牌文件失败：${file}（${(error as Error).message}）`);
    return { token: null, source: 'none', tokenFile: file, notes };
  }
}

function normalizeTokenFileContent(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ['token', 'sessionToken', 'cliToken']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
      }
    } catch {
      // fall through: treat the file as a plain token
    }
  }
  return raw.trim();
}

export interface ApiClientOptions {
  serverUrl: string;
  timeoutMs: number;
  auth: AuthState;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Total attempts for idempotent GET requests (default 3). */
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ApiClient {
  readonly baseUrl: string;
  readonly auth: AuthState;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeServerUrl(options.serverUrl);
    this.auth = options.auth;
    this.timeoutMs = options.timeoutMs;
    this.log = options.log;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryAttempts = Math.max(1, options.retryAttempts ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 200);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = options.userAgent ?? 'cognitive-atrium-cli/0.1.0';
  }

  /** Diagnostics: where the session token came from (never prints the token). */
  describeAuth(): string {
    if (this.auth.token && this.auth.source === 'token-file') return `会话令牌：${this.auth.tokenFile}`;
    if (this.auth.token && this.auth.source === 'environment') return '会话令牌：环境变量 CA_SESSION_TOKEN';
    return `未提供会话令牌${this.auth.tokenFile ? `（期望文件 ${this.auth.tokenFile}）` : ''}`;
  }

  commandId(): CommandId {
    return randomUUID() as CommandId;
  }

  async get<T>(schema: ResponseSchema<T>, route: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithRetry('GET', route, schema, undefined, options);
  }

  /** POST commands are never retried automatically: a replay could duplicate a side effect. */
  async post<T>(schema: ResponseSchema<T>, route: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.requestWithRetry('POST', route, schema, body, options);
  }

  private async requestWithRetry<T>(
    method: 'GET' | 'POST',
    route: string,
    schema: ResponseSchema<T>,
    body: unknown,
    options: RequestOptions,
  ): Promise<T> {
    const attempts = method === 'GET' ? this.retryAttempts : 1;
    let lastError: CliError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.requestOnce(method, route, schema, body, options);
      } catch (error) {
        const cliError = toCliError(error);
        lastError = cliError;
        if (attempt >= attempts || !isRetryableRead(cliError)) throw cliError;
        const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
        this.log(`只读请求失败（${cliError.info.message}），${delay}ms 后重试 ${attempt}/${attempts - 1}`);
        await this.sleep(delay);
      }
    }
    throw lastError ?? new ConnectionError('请求失败', undefined);
  }

  private async requestOnce<T>(
    method: 'GET' | 'POST',
    route: string,
    schema: ResponseSchema<T>,
    body: unknown,
    options: RequestOptions,
  ): Promise<T> {
    const url = this.resolveUrl(route);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const unlink = linkSignals(options.signal, controller);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-CA-Client': 'cli',
      'User-Agent': this.userAgent,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.auth.token) headers.Authorization = `Bearer ${this.auth.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (error) {
      throw this.normalizeTransportError(error, method, route, timedOut, options.signal);
    } finally {
      clearTimeout(timer);
      unlink();
    }
    if (!response.ok) throw await this.toApiError(response, method, route);
    const text = await response.text();
    if (text.trim() === '') throw new ProtocolError(`服务器返回空响应（${method} ${route}）`);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProtocolError(`服务器响应不是合法 JSON（${method} ${route}）`, { body: text.slice(0, 500) });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 8).map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
      throw new ProtocolError(`服务器响应不符合冻结契约（${method} ${route}）`, { issues });
    }
    return parsed.data;
  }

  /**
   * Open the task event stream. The caller owns reconnection (Last-Event-ID) and
   * de-duplication by seq; this method only maps transport/idle failures.
   */
  async *sse(
    route: string,
    options: { signal?: AbortSignal; idleTimeoutMs?: number; lastEventId?: string | null } = {},
  ): AsyncGenerator<SseMessage> {
    const url = this.resolveUrl(route);
    const controller = new AbortController();
    const idleTimeoutMs = options.idleTimeoutMs ?? this.timeoutMs;
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    resetIdle();
    const unlink = linkSignals(options.signal, controller);
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-CA-Client': 'cli',
      'User-Agent': this.userAgent,
    };
    if (this.auth.token) headers.Authorization = `Bearer ${this.auth.token}`;
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
      } catch (error) {
        throw this.normalizeTransportError(error, 'GET', route, idle, options.signal);
      }
      if (!response.ok) throw await this.toApiError(response, 'GET', route);
      if (!response.body) throw new ProtocolError('SSE 响应没有响应体');
      try {
        for await (const message of parseSse(response.body, { signal: controller.signal })) {
          resetIdle();
          yield message;
        }
      } catch (error) {
        throw this.normalizeTransportError(error, 'GET', route, idle, options.signal);
      }
    } finally {
      if (timer) clearTimeout(timer);
      unlink();
      controller.abort();
    }
  }

  private resolveUrl(route: string): string {
    if (!route.startsWith('/')) throw new ConfigError(`内部路由必须是以 / 开头的绝对路径：${route}`);
    return `${this.baseUrl}${route}`;
  }

  private async toApiError(response: Response, method: string, route: string): Promise<CliError> {
    let text = '';
    try {
      text = await response.text();
    } catch {
      // Response body is optional for error mapping.
    }
    let parsedBody: unknown;
    if (text.trim() !== '') {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = undefined;
      }
    }
    const parsed = ApiErrorBodySchema.safeParse(parsedBody);
    if (parsed.success) {
      const body: ApiErrorBody = parsed.data;
      if (response.status === 401) {
        return new AuthError(
          `服务端拒绝了本次请求（401 ${body.code}）：${body.message}`,
          hintForAuth(this.auth),
          body.traceId,
        );
      }
      return new ApiError({
        status: response.status,
        code: body.code,
        message: body.message,
        retryable: body.retryable,
        details: body.details,
        traceId: body.traceId,
      });
    }
    if (response.status === 401) {
      return new AuthError(
        `服务端拒绝了本次请求（401）：未通过会话鉴权。请求路径 ${method} ${route}`,
        hintForAuth(this.auth),
        response.headers.get('x-trace-id') ?? undefined,
      );
    }
    const snippet = text.trim().slice(0, 300);
    return new ApiError({
      status: response.status,
      code: `http_${response.status}`,
      message: `服务器返回 HTTP ${response.status}${snippet ? `：${snippet}` : ''}`,
      retryable: response.status >= 500 || response.status === 429,
      traceId: response.headers.get('x-trace-id') ?? undefined,
    });
  }

  private normalizeTransportError(
    error: unknown,
    method: string,
    route: string,
    timedOut: boolean,
    externalSignal: AbortSignal | undefined,
  ): CliError {
    if (error instanceof CliError) return error;
    if (externalSignal?.aborted) {
      return new ConnectionError('请求已取消', undefined, 'cancelled');
    }
    if (timedOut) {
      return new ConnectionError(
        `请求超时（${this.timeoutMs}ms 内未完成）：${method} ${route}`,
        `服务 ${this.baseUrl} 可能未启动、过载，或该操作耗时较长；可用 --timeout 提高超时时间。`,
        'timeout',
      );
    }
    const name = (error as Error).name;
    if (name === 'AbortError') {
      return new ConnectionError(`请求被中断：${method} ${route}`, undefined, 'aborted');
    }
    if (name === 'TimeoutError') {
      return new ConnectionError(`请求超时：${method} ${route}`, undefined, 'timeout');
    }
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : (error as Error).message;
    return new ConnectionError(
      `无法连接服务器 ${this.baseUrl}：${causeMessage}`,
      '请确认服务已启动（pnpm dev:server 或 pnpm start），并且 --server 指向正确地址。',
      'network_error',
    );
  }
}

function hintForAuth(auth: AuthState): string {
  const file = auth.tokenFile ? `（默认：${auth.tokenFile}）` : '';
  return [
    '未通过本地会话鉴权。请确认服务已启动，并让 CLI 能读取服务写出的会话令牌：',
    `  --token-file <路径>${file}，或设置环境变量 CA_SESSION_TOKEN；`,
    '也可用浏览器打开工作台建立会话后重试。',
  ].join('\n');
}

function isRetryableRead(error: CliError): boolean {
  if (error instanceof ConnectionError) {
    return error.info.code === 'network_error' || error.info.code === 'timeout' || error.info.code === 'http_error';
  }
  if (error instanceof ApiError) {
    return error.status >= 500 || (error.status === 429 && error.retryable);
  }
  return false;
}

function linkSignals(source: AbortSignal | undefined, controller: AbortController): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    controller.abort(source.reason);
    return () => {};
  }
  const onAbort = (): void => controller.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(`--server 不是合法 URL：${raw}`, '示例：--server http://127.0.0.1:4310');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`--server 仅支持 http/https：${raw}`);
  }
  if (url.username || url.password) {
    throw new ConfigError('--server 不允许在 URL 中携带凭据');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function formatPath(parts: ReadonlyArray<PropertyKey>): string {
  if (parts.length === 0) return '<root>';
  return parts.map((part) => String(part)).join('.');
}

/** Create the client for a command invocation. */
export function createClient(input: {
  globals: Globals;
  env: NodeJS.ProcessEnv;
  cwd: string;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  retryBaseDelayMs?: number;
}): ApiClient {
  const auth = loadAuth({
    env: input.env,
    cwd: input.cwd,
    globals: input.globals,
    log: input.log,
  });
  for (const note of auth.notes) input.log(note);
  return new ApiClient({
    serverUrl: input.globals.serverUrl,
    timeoutMs: input.globals.timeoutMs,
    auth,
    log: input.log,
    fetchImpl: input.fetchImpl,
    retryBaseDelayMs: input.retryBaseDelayMs,
  });
}
