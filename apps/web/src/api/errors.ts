/** Error normalization and human-readable Chinese descriptions for the workbench. */
import { ApiErrorBodySchema } from '@ca/contracts';
import { ClientFailure, isClientFailure, type ApiErrorMeta } from './types';

let traceCounter = 0;

function fallbackTraceId(): string {
  traceCounter += 1;
  return `client-${Date.now().toString(36)}-${traceCounter}`;
}

/** Build a ClientFailure from an HTTP response body (contract: code/message/retryable/traceId). */
export function failureFromResponse(status: number, bodyText: string, requestLabel: string): ClientFailure {
  let meta: ApiErrorMeta | null = null;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      const result = ApiErrorBodySchema.safeParse(parsed);
      if (result.success) {
        meta = {
          code: result.data.code,
          message: result.data.message,
          retryable: result.data.retryable,
          traceId: result.data.traceId,
          status,
          details: result.data.details,
        };
      }
    } catch {
      // Non-JSON error body: fall through to the generic mapping below.
    }
  }
  if (!meta) {
    meta = {
      code: status === 401 ? 'session_required' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'internal_error',
      message: `${requestLabel} 失败（HTTP ${status}）`,
      retryable: status >= 500 || status === 429,
      traceId: fallbackTraceId(),
      status,
    };
  }
  return new ClientFailure({ ...meta, kind: 'http' });
}

export function networkFailure(error: unknown, requestLabel: string): ClientFailure {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return new ClientFailure({
    kind: 'network',
    code: 'network_error',
    message: `${requestLabel}：无法连接后端服务（${message}）`,
    retryable: true,
    traceId: fallbackTraceId(),
  });
}

export function invalidResponseFailure(detail: string, requestLabel: string): ClientFailure {
  return new ClientFailure({
    kind: 'invalid_response',
    code: 'invalid_response',
    message: `${requestLabel}：后端返回的数据不符合契约（${detail}）`,
    retryable: false,
    traceId: fallbackTraceId(),
  });
}

export function abortFailure(requestLabel: string): ClientFailure {
  return new ClientFailure({
    kind: 'aborted',
    code: 'aborted',
    message: `${requestLabel}已取消`,
    retryable: false,
    traceId: fallbackTraceId(),
  });
}

/** Revision/system conflicts trigger an automatic resync in the core store. */
export function isConflictFailure(error: unknown): boolean {
  return isClientFailure(error) && (error.code === 'revision_conflict' || error.code === 'conflict' || error.code === 'version_conflict' || error.status === 409);
}

export function isSessionFailure(error: unknown): boolean {
  return isClientFailure(error) && (error.code === 'session_required' || error.status === 401);
}

/** A short, actionable label for a failure. Never parse Chinese message text for logic. */
export function failureTitle(error: unknown): string {
  if (!isClientFailure(error)) return '未知错误';
  switch (error.code) {
    case 'network_error':
      return '后端不可达';
    case 'invalid_response':
      return '响应不符合契约';
    case 'session_required':
      return '会话未建立';
    case 'forbidden':
      return '无权限';
    case 'origin_not_allowed':
      return '来源校验失败';
    case 'not_found':
      return '资源不存在';
    case 'conflict':
    case 'revision_conflict':
      return '版本冲突';
    case 'version_conflict':
      return '基线版本冲突';
    case 'validation_failed':
      return '校验未通过';
    case 'schema_invalid':
      return '请求结构不合法';
    case 'budget_exhausted':
      return '预算已用尽';
    case 'state_not_allowed':
      return '当前状态不允许该操作';
    case 'dependency_unavailable':
      return '依赖不可用';
    case 'provider_error':
      return '模型服务错误';
    case 'provider_auth_error':
      return '模型鉴权失败';
    case 'provider_rate_limited':
      return '模型服务限流';
    case 'provider_model_missing':
      return '模型不存在';
    case 'tool_error':
      return '工具执行失败';
    case 'tool_timeout':
      return '工具超时';
    case 'tool_outcome_unknown':
      return '工具结果未知';
    case 'snapshot_required':
      return '需要重新同步';
    case 'disk_full':
      return '磁盘空间不足';
    case 'unsupported_media_type':
      return '不支持的文件类型';
    case 'payload_too_large':
      return '内容超过大小限制';
    case 'import_invalid':
      return '任务包不合法';
    case 'internal_error':
      return '后端内部错误';
    default:
      return '请求失败';
  }
}

/** Explanation of what was preserved and what the user can do next. */
export function failureGuidance(error: unknown): string[] {
  if (!isClientFailure(error)) return ['请稍后重试；如果持续出现，请查看后端日志。'];
  const tips: string[] = [];
  if (error.retryable) tips.push('这是可重试错误，可以稍后重试。');
  switch (error.code) {
    case 'network_error':
      tips.push('检查后端是否在 127.0.0.1:4310 运行，或稍后重试。已接受的成果与运行记录保存在后端，不会因断线丢失。');
      break;
    case 'session_required':
      tips.push('本地会话未建立，刷新页面会重新建立会话；未提交的输入保存在本地视图存储中。');
      break;
    case 'revision_conflict':
    case 'conflict':
      tips.push('任务已被其他操作更新。界面会自动重新同步快照，请基于最新状态重试。');
      break;
    case 'version_conflict':
      tips.push('候选基于的基线已变化。已接受版本未被覆盖，可重新生成差异或人工合并。');
      break;
    case 'validation_failed':
    case 'schema_invalid':
      tips.push('本次请求没有改变正式成果。请按提示修正输入后重新提交。');
      break;
    case 'budget_exhausted':
      tips.push('运行在安全边界保留检查点，已接受成果不变；可在运行控制中调整预算后继续。');
      break;
    case 'state_not_allowed':
      tips.push('当前 Run 状态不接受该命令；请等待状态更新或先取消当前运行。');
      break;
    case 'provider_auth_error':
      tips.push('检查设置中的连接配置与后端凭据引用；不要在前端保存密钥。');
      break;
    case 'provider_rate_limited':
      tips.push('服务限流，可稍后重试；重试会计入预算。');
      break;
    case 'unsupported_media_type':
      tips.push('首版仅支持 UTF-8 TXT / Markdown / JSON / CSV。');
      break;
    case 'payload_too_large':
      tips.push('单文件上限 10 MiB，单任务资料上限 50 MiB。');
      break;
    default:
      break;
  }
  if (!tips.length) tips.push('已提交的成果版本与运行记录保持不变。');
  return tips;
}

export function failureTrace(error: unknown): string | null {
  return isClientFailure(error) && error.traceId ? error.traceId : null;
}
