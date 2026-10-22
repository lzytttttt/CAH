/**
 * Bounded JSON parsing and deterministic JSON <-> table projection.
 *
 * JSON sources are never trusted blindly: parsing enforces the contract limits
 * (max depth / max nodes) and rejects non-finite numbers that JSON text can
 * express (e.g. `1e999`) plus prototype-polluting object keys.
 */
import { LIMITS, type JsonValue } from '@ca/contracts';
import { JsonDataError } from './errors';
import {
  FORBIDDEN_OBJECT_KEYS,
  MAX_COLUMN_KEY_CHARS,
  type CellValue,
  type TableColumn,
  type TableData,
  type TableRow,
} from './table';

export interface BoundedJsonOptions {
  maxDepth?: number;
  maxNodes?: number;
}

const DEFAULT_MAX_DEPTH: number = LIMITS.maxJsonDepth;
const DEFAULT_MAX_NODES: number = LIMITS.maxJsonNodes;

/** Parse JSON text with bounded depth/node count. Throws JsonDataError. */
export function parseBoundedJson(text: string, options: BoundedJsonOptions = {}): JsonValue {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const stripped = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (stripped.trim().length === 0) {
    throw new JsonDataError('json_parse_error', 'json source is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new JsonDataError('json_parse_error', `invalid JSON: ${bound(message, 300)}`);
  }
  assertBoundedJson(parsed, maxDepth, maxNodes);
  return parsed as JsonValue;
}

interface WalkFrame {
  value: unknown;
  depth: number;
  path: string;
}

/** Iterative structure guard (avoids recursion limits on hostile input). */
export function assertBoundedJson(root: unknown, maxDepth = DEFAULT_MAX_DEPTH, maxNodes = DEFAULT_MAX_NODES): void {
  let nodes = 0;
  const stack: WalkFrame[] = [{ value: root, depth: 0, path: '$' }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) {
      throw new JsonDataError('limit_exceeded', `json value has more than ${maxNodes} nodes`, { limit: maxNodes });
    }
    const value = frame.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new JsonDataError('json_parse_error', `json number is not finite at ${frame.path}`);
      }
      continue;
    }
    if (typeof value !== 'object') {
      throw new JsonDataError('json_parse_error', `json value is not serializable at ${frame.path}`);
    }
    if (Array.isArray(value)) {
      if (frame.depth + 1 > maxDepth) {
        throw new JsonDataError('limit_exceeded', `json nesting depth exceeds ${maxDepth} at ${frame.path}`, {
          limit: maxDepth,
        });
      }
      for (let i = value.length - 1; i >= 0; i -= 1) {
        stack.push({ value: value[i], depth: frame.depth + 1, path: `${frame.path}[${i}]` });
      }
      continue;
    }
    if (frame.depth + 1 > maxDepth) {
      throw new JsonDataError('limit_exceeded', `json nesting depth exceeds ${maxDepth} at ${frame.path}`, {
        limit: maxDepth,
      });
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const key of keys) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new JsonDataError('json_parse_error', `json object has a forbidden key at ${frame.path}: ${key}`);
      }
      stack.push({ value: record[key], depth: frame.depth + 1, path: `${frame.path}.${key}` });
    }
  }
}

function isPlainRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonPrimitiveToCell(value: JsonValue): CellValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JsonDataError('json_parse_error', 'json number is not finite');
    }
    return value;
  }
  // Nested objects/arrays have no scalar CSV representation: keep a stable,
  // compact JSON text so nothing is silently dropped.
  return JSON.stringify(value);
}

export interface TableFromJsonOptions {
  /** Collect human-readable notes (e.g. nested values flattened to text). */
  issues?: string[];
}

/**
 * Project a JSON value onto a deterministic table:
 * - array of objects -> one row per object, columns = union of keys in first-appearance order;
 * - array of other values -> single `value` column;
 * - object -> single row with its keys;
 * - scalar/null -> single `value` cell.
 * Nested objects/arrays become compact JSON text cells and are reported as issues.
 */
export function tableFromJsonValue(value: JsonValue, options: TableFromJsonOptions = {}): TableData {
  const issues = options.issues;
  if (Array.isArray(value)) {
    if (value.length === 0) return { columns: [], rows: [] };
    const allObjects = value.every((item) => isPlainRecord(item));
    if (allObjects) {
      const keys: string[] = [];
      const seen = new Set<string>();
      for (const item of value) {
        for (const key of Object.keys(item as Record<string, JsonValue>)) {
          if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
        }
      }
      const columns = buildJsonColumns(keys);
      let nestedCount = 0;
      const rows: TableRow[] = value.map((item) => {
        const row: TableRow = {};
        for (const column of columns) {
          const cell = (item as Record<string, JsonValue>)[column.key];
          if (cell === undefined) {
            row[column.key] = null;
            continue;
          }
          if (typeof cell === 'object' && cell !== null) nestedCount += 1;
          row[column.key] = jsonPrimitiveToCell(cell);
        }
        return row;
      });
      if (nestedCount > 0 && issues) {
        issues.push(`${nestedCount} nested JSON value(s) were flattened to compact JSON text cells`);
      }
      return { columns, rows };
    }
    const columns = buildJsonColumns(['value']);
    let nestedCount = 0;
    const rows: TableRow[] = value.map((item) => {
      if (typeof item === 'object' && item !== null) nestedCount += 1;
      return { value: jsonPrimitiveToCell(item) };
    });
    if (nestedCount > 0 && issues) {
      issues.push(`${nestedCount} nested JSON value(s) were flattened to compact JSON text cells`);
    }
    return { columns, rows };
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    const columns = buildJsonColumns(keys);
    const row: TableRow = {};
    let nestedCount = 0;
    for (const column of columns) {
      const cell = value[column.key]!;
      if (typeof cell === 'object' && cell !== null) nestedCount += 1;
      row[column.key] = jsonPrimitiveToCell(cell);
    }
    if (nestedCount > 0 && issues) {
      issues.push(`${nestedCount} nested JSON value(s) were flattened to compact JSON text cells`);
    }
    return { columns, rows: [row] };
  }
  return { columns: buildJsonColumns(['value']), rows: [{ value: jsonPrimitiveToCell(value) }] };
}

function buildJsonColumns(keys: readonly string[]): TableColumn[] {
  if (keys.length > LIMITS.maxCsvColumns) {
    throw new JsonDataError('limit_exceeded', `json object has ${keys.length} keys (limit ${LIMITS.maxCsvColumns})`, {
      limit: LIMITS.maxCsvColumns,
    });
  }
  return keys.map((key) => {
    if (key.length === 0) {
      throw new JsonDataError('json_parse_error', 'json object has an empty key');
    }
    if (key.length > MAX_COLUMN_KEY_CHARS) {
      throw new JsonDataError(
        'json_parse_error',
        `json object key is longer than ${MAX_COLUMN_KEY_CHARS} chars: ${key.slice(0, 40)}…`,
      );
    }
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new JsonDataError('json_parse_error', `json object key is not allowed: ${key}`);
    }
    return { key, label: key };
  });
}

/** Convert a normalized table to a deterministic JSON array of row objects. */
export function tableToJsonValue(table: TableData): JsonValue {
  return table.rows.map((row) => {
    const out: { [key: string]: JsonValue } = {};
    for (const column of table.columns) {
      out[column.key] = (row[column.key] ?? null) as JsonValue;
    }
    return out;
  });
}

function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
