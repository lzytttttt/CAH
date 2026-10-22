/**
 * Structured errors for the tool runtime and the deterministic data engine.
 *
 * Every failure that can cross the tool boundary is expressed as a
 * `ToolRuntimeError` with a stable machine-readable `code`; the harness/client
 * branches on `code`, never on human text. Data-engine errors (CSV/JSON/table)
 * are `DataFormatError`s and are converted at the tool boundary.
 */
import type { JsonValue } from '@ca/contracts';

/** Stable tool error codes (kept short, snake_case, and documented). */
export const TOOL_ERROR_CODES = [
  'invalid_arguments',
  'unknown_tool',
  'scope_denied',
  'aborted',
  'tool_timeout',
  'result_too_large',
  'source_not_found',
  'source_unavailable',
  'unsupported_encoding',
  'unsupported_format',
  'empty_query',
  'csv_parse_error',
  'json_parse_error',
  'data_format_error',
  'locator_invalid',
  'locator_out_of_range',
  'key_not_found',
  'json_pointer_not_found',
  'column_not_found',
  'duplicate_column',
  'invalid_operator_value',
  'unsafe_regex',
  'transform_failed',
  'limit_exceeded',
  'module_not_found',
  'module_kind_mismatch',
  'version_not_found',
  'version_conflict',
  'patch_invalid',
  'evidence_invalid',
  'validator_unavailable',
  'validation_mismatch',
  'object_write_failed',
  'internal_error',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorOptions {
  retryable?: boolean;
  details?: JsonValue;
}

/** Error thrown inside tool implementations and normalized by the runtime. */
export class ToolRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;

  constructor(code: string, message: string, options: ToolErrorOptions = {}) {
    super(message);
    this.name = 'ToolRuntimeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * Error from the pure data engine (CSV parser/writer, bounded JSON, table
 * operators). Codes overlap the tool error vocabulary so the runtime can pass
 * them through unchanged.
 */
export class DataFormatError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = 'DataFormatError';
    this.code = code;
    this.details = details;
  }
}

export class CsvParseError extends DataFormatError {
  constructor(code: string, message: string, details?: JsonValue) {
    super(code, message, details);
    this.name = 'CsvParseError';
  }
}

export class JsonDataError extends DataFormatError {
  constructor(code: string, message: string, details?: JsonValue) {
    super(code, message, details);
    this.name = 'JsonDataError';
  }
}

export class TableTransformError extends DataFormatError {
  constructor(code: string, message: string, details?: JsonValue) {
    super(code, message, details);
    this.name = 'TableTransformError';
  }
}

function boundedMessage(message: string, max = 3000): string {
  return message.length <= max ? message : `${message.slice(0, max - 1)}…`;
}

/** Normalize any thrown value into a ToolRuntimeError (never leaks internals). */
export function toToolRuntimeError(error: unknown): ToolRuntimeError {
  if (error instanceof ToolRuntimeError) return error;
  if (error instanceof DataFormatError) {
    return new ToolRuntimeError(error.code, boundedMessage(error.message), {
      retryable: false,
      details: error.details,
    });
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') {
    return new ToolRuntimeError('aborted', 'tool execution was aborted', { retryable: true });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ToolRuntimeError('internal_error', boundedMessage(message || 'unexpected tool failure'), {
    retryable: false,
  });
}

/** Wrap only into a ToolRuntimeError with an explicit code (used for port failures). */
export function wrapPortError(
  error: unknown,
  code: string,
  message: string,
  options: ToolErrorOptions = {},
): ToolRuntimeError {
  if (error instanceof ToolRuntimeError) return error;
  const cause = error instanceof Error ? error.message : String(error);
  return new ToolRuntimeError(code, boundedMessage(`${message}: ${cause}`), options);
}
