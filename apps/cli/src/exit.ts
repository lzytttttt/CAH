/**
 * Exit-code contract shared by every CLI command.
 *
 * The CLI is a real client of the same command API as the web workbench, so
 * business state must never be reported as success through the process exit
 * code. Errors are classified by machine-readable reason (never by parsing
 * human wording):
 *
 *   0  success
 *   1  usage / invalid local input (arguments, files, missing required fields)
 *   2  waiting_for_input: a run is blocked on a human decision (blockerId and
 *      resolution options are part of the output)
 *   3  configuration / connection / authentication / provider credential error
 *   4  command or state error (conflicts, illegal state, failed/cancelled run,
 *      validation rejected the command)
 *   5  unexpected internal or protocol error
 */

export const EXIT = {
  OK: 0,
  USAGE: 1,
  WAITING_INPUT: 2,
  CONFIG: 3,
  STATE: 4,
  UNEXPECTED: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type ErrorKind =
  | 'usage'
  | 'config'
  | 'connection'
  | 'auth'
  | 'api'
  | 'protocol'
  | 'internal'
  | 'integrity';

/** Machine-readable error record; goes to JSON output and stderr hints. */
export interface ErrorInfo {
  kind: ErrorKind;
  code: string;
  message: string;
  retryable?: boolean;
  traceId?: string;
  details?: unknown;
  hint?: string;
}

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly info: ErrorInfo;
  /** Extra human-readable lines appended after the message (e.g. how to fix). */
  readonly lines: string[];

  constructor(exitCode: ExitCode, info: ErrorInfo, lines: string[] = []) {
    super(info.message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.info = info;
    this.lines = lines;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(EXIT.USAGE, { kind: 'usage', code: 'usage_error', message, hint });
    this.name = 'UsageError';
  }
}

export class ConfigError extends CliError {
  constructor(message: string, hint?: string, code = 'config_error') {
    super(EXIT.CONFIG, { kind: 'config', code, message, hint });
    this.name = 'ConfigError';
  }
}

export class ConnectionError extends CliError {
  constructor(message: string, hint?: string, code = 'network_error', details?: unknown) {
    super(EXIT.CONFIG, { kind: 'connection', code, message, hint, details });
    this.name = 'ConnectionError';
  }
}

export class AuthError extends CliError {
  constructor(message: string, hint?: string, traceId?: string) {
    super(EXIT.CONFIG, { kind: 'auth', code: 'session_required', message, traceId, hint });
    this.name = 'AuthError';
  }
}

/** Structured API error body returned by the server (`ApiErrorBody` in contracts). */
export class ApiError extends CliError {
  readonly status: number;
  readonly apiCode: string;
  readonly details?: unknown;
  readonly traceId?: string;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
    traceId?: string;
    hint?: string;
  }) {
    const exitCode = exitCodeForApiError(input.status, input.code);
    super(exitCode, {
      kind: input.status === 401 || input.status === 403 ? 'auth' : 'api',
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      traceId: input.traceId,
      details: input.details,
      hint: input.hint ?? hintForApiError(input.status, input.code),
    });
    this.name = 'ApiError';
    this.status = input.status;
    this.apiCode = input.code;
    this.details = input.details;
    this.traceId = input.traceId;
    this.retryable = input.retryable;
  }
}

export class ProtocolError extends CliError {
  constructor(message: string, details?: unknown) {
    super(EXIT.UNEXPECTED, {
      kind: 'protocol',
      code: 'protocol_error',
      message,
      details,
      hint: '服务器响应不符合冻结的 @ca/contracts Schema，请检查客户端与服务端版本是否一致。',
    });
    this.name = 'ProtocolError';
  }
}

export class InternalError extends CliError {
  constructor(message: string, details?: unknown) {
    super(EXIT.UNEXPECTED, { kind: 'internal', code: 'internal_error', message, details });
    this.name = 'InternalError';
  }
}

export class IntegrityError extends CliError {
  constructor(message: string, details?: unknown) {
    super(EXIT.UNEXPECTED, {
      kind: 'integrity',
      code: 'integrity_error',
      message,
      details,
      hint: '校验失败的文件不会被声明为成功导出；请重试或联系维护者。',
    });
    this.name = 'IntegrityError';
  }
}

/**
 * Map an HTTP status + API error code to an exit code. Clients branch on
 * `code`, never on the Chinese message text.
 */
export function exitCodeForApiError(status: number, code: string): ExitCode {
  if (status === 401 || status === 403) return EXIT.CONFIG;
  switch (code) {
    case 'session_required':
    case 'forbidden':
    case 'origin_not_allowed':
    case 'provider_auth_error':
    case 'provider_model_missing':
    case 'provider_error':
      return EXIT.CONFIG;
    case 'internal_error':
      return EXIT.UNEXPECTED;
    case 'not_found':
    case 'conflict':
    case 'revision_conflict':
    case 'version_conflict':
    case 'validation_failed':
    case 'schema_invalid':
    case 'budget_exhausted':
    case 'state_not_allowed':
    case 'dependency_unavailable':
    case 'provider_rate_limited':
    case 'tool_error':
    case 'tool_timeout':
    case 'tool_outcome_unknown':
    case 'bad_request':
    case 'disk_full':
    case 'unsupported_media_type':
    case 'payload_too_large':
    case 'import_invalid':
      return EXIT.STATE;
    case 'snapshot_required':
      return EXIT.STATE;
    default:
      break;
  }
  if (status >= 500) return EXIT.UNEXPECTED;
  if (status === 409 || status === 422 || status === 404 || status === 400) return EXIT.STATE;
  return EXIT.STATE;
}

export function hintForApiError(status: number, code: string): string | undefined {
  if (status === 401) {
    return '会话未通过鉴权：请确认服务已启动并写出本地会话令牌（默认 <数据目录>/session-token），或使用 --token-file / 环境变量 CA_SESSION_TOKEN 指定令牌。';
  }
  if (code === 'session_required') {
    return '请使用 --token-file <路径> 指向服务写出的会话令牌文件。';
  }
  if (code === 'revision_conflict' || code === 'version_conflict') {
    return '当前状态已被其他命令改变（未覆盖任何数据）。请重新执行 status/review 获取最新版本后重试；可用 --expected-revision 显式指定期望修订号。';
  }
  if (code === 'snapshot_required') {
    return '事件游标已超出保留范围：请先执行 task status 重新获取快照，再继续。';
  }
  if (code === 'state_not_allowed') {
    return '当前状态不允许该操作；请先用 run status / task status 查看真实状态。';
  }
  if (code === 'budget_exhausted') {
    return '预算已用尽：可在新建运行时通过 --budget-file 提高预算，或调整工作区默认预算。';
  }
  if (code === 'provider_auth_error') {
    return '模型服务凭据无效：请检查 provider profile 的 credentialRef 与环境变量/密钥文件。';
  }
  if (code === 'provider_model_missing') {
    return '模型名称在该服务上不存在：请检查 provider profile 中的 model。';
  }
  if (code === 'disk_full') {
    return '磁盘空间不足：服务已停止新增写操作，请清理空间后重试。';
  }
  if (code === 'import_invalid') {
    return '导入包校验失败：包可能损坏、版本不兼容或包含非法路径；原包未被修改。';
  }
  return undefined;
}

/** Normalize any thrown value into a CliError (unknown values become exit 5). */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : undefined;
  return new InternalError(message, stack ? { stack } : undefined);
}
