/**
 * Deterministic, declarative table transform operators.
 *
 * This module is pure (no I/O, no randomness, no locale/timezone dependence) so
 * the same code powers the `data.transform` tool and deterministic recipes.
 * Non-fatal data anomalies (cast failures, unmapped enum values, empty required
 * cells, ragged normalization) are recorded in `issues`; structurally invalid
 * operations (unknown column, duplicate column, unsafe regex) throw a
 * `TableTransformError` so the caller can correct the request.
 */
import { LIMITS, type JsonValue, type NormalizeOp, type TransformOperation } from '@ca/contracts';
import { TableTransformError } from './errors';
import {
  bound,
  cellToText,
  cloneTable,
  compareText,
  isBlankCell,
  isEmptyCell,
  normalizeTableData,
  parseBooleanCell,
  parseDateCell,
  parseNumberCell,
  type CellValue,
  type TableColumn,
  type TableData,
  type TableRow,
} from './table';

export interface TransformOutcome {
  table: TableData;
  issues: string[];
}

export interface TransformOptions {
  /** Maximum number of recorded issues (contract schema caps at 200). */
  maxIssues?: number;
}

const DEFAULT_MAX_ISSUES = 200;
const MAX_ISSUE_CHARS = 500;

class IssueTracker {
  private readonly issues: string[] = [];
  private readonly maxIssues: number;
  private omitted = 0;

  constructor(maxIssues: number) {
    this.maxIssues = Math.max(1, Math.min(maxIssues, 200));
  }

  add(message: string): void {
    if (this.issues.length >= this.maxIssues) {
      this.omitted += 1;
      return;
    }
    this.issues.push(bound(message, MAX_ISSUE_CHARS));
  }

  finish(): string[] {
    if (this.omitted > 0) {
      const note = bound(`…and ${this.omitted} more data issue(s) were omitted`, MAX_ISSUE_CHARS);
      if (this.issues.length >= this.maxIssues && this.issues.length > 0) {
        this.issues[this.issues.length - 1] = note;
      } else {
        this.issues.push(note);
      }
    }
    return this.issues;
  }
}

interface TransformState {
  columns: TableColumn[];
  rows: TableRow[];
}

function columnIndex(state: TransformState, key: string): number {
  return state.columns.findIndex((column) => column.key === key);
}

function requireColumn(state: TransformState, key: string, operation: string): void {
  if (columnIndex(state, key) < 0) {
    const available = state.columns.map((column) => column.key).join(', ');
    throw new TableTransformError(
      'column_not_found',
      `operation "${operation}" references unknown column "${key}" (available: ${bound(available, 300)})`,
      { column: key, operation },
    );
  }
}

function projectRows(columns: readonly TableColumn[], rows: readonly TableRow[]): TableRow[] {
  return rows.map((row) => {
    const next: TableRow = {};
    for (const column of columns) next[column.key] = row[column.key] ?? null;
    return next;
  });
}

function assertUniqueColumns(columns: readonly TableColumn[], context: string): void {
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.key)) {
      throw new TableTransformError('duplicate_column', `${context}: duplicate column "${column.key}"`);
    }
    seen.add(column.key);
  }
}

/**
 * Apply a sequence of declarative operators to a table.
 *
 * Throws `TableTransformError` for structurally invalid operations. Never
 * mutates the input table.
 */
export function applyTransformOperations(
  input: TableData,
  operations: readonly TransformOperation[],
  options: TransformOptions = {},
): TransformOutcome {
  const tracker = new IssueTracker(options.maxIssues ?? DEFAULT_MAX_ISSUES);
  const source = normalizeTableData(input);
  let state: TransformState = cloneTable(source);

  for (const operation of operations) {
    state = applyOne(state, operation, tracker);
  }

  assertUniqueColumns(state.columns, 'transform result');
  if (state.columns.length > LIMITS.maxCsvColumns) {
    throw new TableTransformError(
      'limit_exceeded',
      `transform result has ${state.columns.length} columns (limit ${LIMITS.maxCsvColumns})`,
    );
  }
  if (state.rows.length > LIMITS.maxCsvRows) {
    throw new TableTransformError(
      'limit_exceeded',
      `transform result has ${state.rows.length} rows (limit ${LIMITS.maxCsvRows})`,
    );
  }

  return {
    table: {
      columns: state.columns.map((column) => ({ key: column.key, label: column.label })),
      rows: state.rows,
    },
    issues: tracker.finish(),
  };
}

function applyOne(state: TransformState, operation: TransformOperation, tracker: IssueTracker): TransformState {
  switch (operation.op) {
    case 'select':
      return selectColumns(state, operation.columns);
    case 'rename':
      return renameColumns(state, operation.mapping);
    case 'filter':
      return filterRows(state, operation);
    case 'sort':
      return sortRows(state, operation, tracker);
    case 'dedupe':
      return dedupeRows(state, operation);
    case 'normalize':
      return normalizeColumn(state, operation);
    case 'cast':
      return castColumn(state, operation, tracker);
    case 'fill':
      return fillColumn(state, operation);
    case 'map':
      return mapColumn(state, operation, tracker);
    case 'limit':
      return { columns: state.columns, rows: state.rows.slice(0, operation.count) };
    case 'require':
      return requireColumns(state, operation.columns, tracker);
  }
}

/* -------------------------------- select -------------------------------- */

function selectColumns(state: TransformState, keys: readonly string[]): TransformState {
  const selected: TableColumn[] = keys.map((key) => {
    requireColumn(state, key, 'select');
    return state.columns[columnIndex(state, key)]!;
  });
  assertUniqueColumns(selected, 'select');
  return { columns: selected, rows: projectRows(selected, state.rows) };
}

/* -------------------------------- rename -------------------------------- */

function renameColumns(state: TransformState, mapping: Readonly<Record<string, string>>): TransformState {
  for (const oldKey of Object.keys(mapping)) {
    requireColumn(state, oldKey, 'rename');
  }
  const columns = state.columns.map((column) => {
    const nextKey = mapping[column.key];
    if (nextKey === undefined) return { key: column.key, label: column.label };
    return { key: nextKey, label: column.label === column.key ? nextKey : column.label };
  });
  assertUniqueColumns(columns, 'rename');
  const rows = state.rows.map((row) => {
    const next: TableRow = {};
    for (const column of state.columns) {
      const target = mapping[column.key] ?? column.key;
      next[target] = row[column.key] ?? null;
    }
    return next;
  });
  return { columns, rows };
}

/* -------------------------------- filter -------------------------------- */

type FilterOperation = Extract<TransformOperation, { op: 'filter' }>;

function filterRows(state: TransformState, operation: FilterOperation): TransformState {
  requireColumn(state, operation.column, 'filter');
  const value = operation.value;
  let predicate: (cell: CellValue) => boolean;

  switch (operation.operator) {
    case 'eq': {
      const expected = requireOperatorValue(operation, value);
      predicate = (cell) => cellEqualsValue(cell, expected);
      break;
    }
    case 'neq': {
      const expected = requireOperatorValue(operation, value);
      predicate = (cell) => !cellEqualsValue(cell, expected);
      break;
    }
    case 'in': {
      const list = requireOperatorArray(operation, value);
      predicate = (cell) => list.some((item) => cellEqualsValue(cell, item));
      break;
    }
    case 'not_in': {
      const list = requireOperatorArray(operation, value);
      predicate = (cell) => !list.some((item) => cellEqualsValue(cell, item));
      break;
    }
    case 'gt':
    case 'lt': {
      if (value === undefined || Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        throw new TableTransformError(
          'invalid_operator_value',
          `filter "${operation.operator}" requires a scalar comparison value`,
        );
      }
      const direction = operation.operator === 'gt' ? 1 : -1;
      predicate = (cell) => {
        if (isBlankCell(cell)) return false;
        const comparison = compareCellValue(cell, value);
        return comparison !== null && comparison * direction > 0;
      };
      break;
    }
    case 'contains': {
      if (value === undefined || Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        throw new TableTransformError('invalid_operator_value', 'filter "contains" requires a scalar needle value');
      }
      const needle = valueToText(value);
      predicate = (cell) => cellToText(cell).includes(needle);
      break;
    }
    case 'not_empty':
      predicate = (cell) => !isBlankCell(cell);
      break;
    case 'matches': {
      if (typeof value !== 'string') {
        throw new TableTransformError('invalid_operator_value', 'filter "matches" requires a string regex pattern');
      }
      const pattern = compileSafeRegExp(value);
      predicate = (cell) => pattern.test(cellToText(cell));
      break;
    }
  }

  return { columns: state.columns, rows: state.rows.filter((row) => predicate(row[operation.column] ?? null)) };
}

function requireOperatorValue(operation: FilterOperation, value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    throw new TableTransformError(
      'invalid_operator_value',
      `filter "${operation.operator}" requires a "value" argument`,
    );
  }
  return value;
}

function requireOperatorArray(operation: FilterOperation, value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new TableTransformError(
      'invalid_operator_value',
      `filter "${operation.operator}" requires an array "value" argument`,
    );
  }
  if (value.length > 1000) {
    throw new TableTransformError('invalid_operator_value', 'filter value array is too large (max 1000)');
  }
  return value;
}

function valueToText(value: JsonValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

/** Typed equality between a scalar cell and a JSON argument value. */
function cellEqualsValue(cell: CellValue, value: JsonValue): boolean {
  if (value === null) return isEmptyCell(cell);
  if (typeof value === 'number') {
    if (typeof cell === 'number') return cell === value;
    const parsed = parseNumberCell(cellToText(cell));
    return parsed !== null && parsed === value;
  }
  if (typeof value === 'boolean') {
    if (typeof cell === 'boolean') return cell === value;
    return parseBooleanCell(cellToText(cell)) === value;
  }
  if (typeof value === 'string') return cellToText(cell) === value;
  // Objects/arrays: compare their compact JSON text (cells are scalar).
  return cellToText(cell) === JSON.stringify(value);
}

/** Numeric when both sides are numeric, otherwise a code-unit text comparison. */
function compareCellValue(cell: CellValue, value: JsonValue): number | null {
  if (value === null) return null;
  const cellText = cellToText(cell);
  const valueText = valueToText(value);
  const cellNumber = typeof cell === 'number' ? cell : parseNumberCell(cellText);
  const valueNumber = typeof value === 'number' ? value : parseNumberCell(valueText);
  if (cellNumber !== null && valueNumber !== null) {
    if (cellNumber === valueNumber) return 0;
    return cellNumber < valueNumber ? -1 : 1;
  }
  if (typeof value === 'boolean') {
    const cellBoolean = typeof cell === 'boolean' ? cell : parseBooleanCell(cellText);
    if (cellBoolean === null) return null;
    if (cellBoolean === value) return 0;
    return cellBoolean ? 1 : -1;
  }
  return compareText(cellText, valueText);
}

const MAX_REGEX_PATTERN_CHARS = 256;

/** Compile a bounded, non-catastrophic regular expression. */
export function compileSafeRegExp(pattern: string): RegExp {
  if (pattern.length === 0) {
    throw new TableTransformError('invalid_operator_value', 'regular expression pattern is empty');
  }
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
    throw new TableTransformError(
      'unsafe_regex',
      `regular expression is longer than ${MAX_REGEX_PATTERN_CHARS} characters`,
    );
  }
  if (/\\[1-9]/.test(pattern)) {
    throw new TableTransformError('unsafe_regex', 'backreferences are not allowed in filter patterns');
  }
  // Reject nested quantifiers such as (a+)+ or (a*){2,}, the classic ReDoS shape.
  if (/\((?:\?:)?[^()]*[+*][^()]*\)[+*{]/.test(pattern)) {
    throw new TableTransformError('unsafe_regex', 'nested quantifiers are not allowed in filter patterns');
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TableTransformError('invalid_operator_value', `invalid regular expression: ${bound(message, 200)}`);
  }
}

/* --------------------------------- sort --------------------------------- */

type SortOperation = Extract<TransformOperation, { op: 'sort' }>;

function sortRows(state: TransformState, operation: SortOperation, tracker: IssueTracker): TransformState {
  requireColumn(state, operation.column, 'sort');
  const numeric = operation.numeric ?? false;

  if (numeric) {
    let nonNumeric = 0;
    for (const row of state.rows) {
      const cell = row[operation.column] ?? null;
      if (isEmptyCell(cell)) continue;
      const parsed = typeof cell === 'number' ? cell : parseNumberCell(cellToText(cell));
      if (parsed === null) nonNumeric += 1;
    }
    if (nonNumeric > 0) {
      tracker.add(
        `sort: column "${operation.column}" has ${nonNumeric} non-numeric value(s); they are ordered after numbers and before empty cells`,
      );
    }
  }

  const direction = (operation.direction ?? 'asc') === 'desc' ? -1 : 1;
  const decorated = state.rows.map((row, index) => ({ row, index }));
  decorated.sort((a, b) => {
    const cellA = a.row[operation.column] ?? null;
    const cellB = b.row[operation.column] ?? null;
    const rankA = sortRank(cellA, numeric);
    const rankB = sortRank(cellB, numeric);
    // Empty cells always sort last and non-numeric values in numeric mode always
    // sort after numbers, independent of the requested direction.
    if (rankA !== rankB) return rankA - rankB;
    if (rankA === SORT_RANK_EMPTY) return a.index - b.index;
    const comparison = compareSortCells(cellA, cellB, numeric);
    if (comparison !== 0) return comparison * direction;
    return a.index - b.index;
  });
  return { columns: state.columns, rows: decorated.map((item) => item.row) };
}

const SORT_RANK_EMPTY = 2;

function sortRank(cell: CellValue, numeric: boolean): number {
  if (isBlankCell(cell)) return SORT_RANK_EMPTY;
  if (!numeric) return 0;
  if (typeof cell === 'number') return 0;
  return parseNumberCell(cellToText(cell)) !== null ? 0 : 1;
}

function compareSortCells(a: CellValue, b: CellValue, numeric: boolean): number {
  if (numeric) {
    const numberA = typeof a === 'number' ? a : parseNumberCell(cellToText(a));
    const numberB = typeof b === 'number' ? b : parseNumberCell(cellToText(b));
    if (numberA !== null && numberB !== null) {
      if (numberA === numberB) return 0;
      return numberA < numberB ? -1 : 1;
    }
  }
  return compareText(cellToText(a), cellToText(b));
}

/* -------------------------------- dedupe -------------------------------- */

type DedupeOperation = Extract<TransformOperation, { op: 'dedupe' }>;

function dedupeNormalized(cell: CellValue, mode: DedupeOperation['normalize']): string {
  const text = cellToText(cell);
  switch (mode) {
    case 'none':
      return text;
    case 'trim':
      return text.trim();
    case 'lower':
      return text.toLowerCase();
    case 'trim_lower':
      return text.trim().toLowerCase();
  }
}

function dedupeRows(state: TransformState, operation: DedupeOperation): TransformState {
  for (const key of operation.keys) requireColumn(state, key, 'dedupe');
  const normalizeMode = operation.normalize ?? 'trim_lower';
  const keep = operation.keep ?? 'first';
  const keyOf = (row: TableRow): string =>
    JSON.stringify(operation.keys.map((key) => dedupeNormalized(row[key] ?? null, normalizeMode)));

  if (keep === 'first') {
    const seen = new Set<string>();
    const rows: TableRow[] = [];
    for (const row of state.rows) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    return { columns: state.columns, rows };
  }

  const lastIndex = new Map<string, number>();
  state.rows.forEach((row, index) => lastIndex.set(keyOf(row), index));
  const rows = state.rows.filter((row, index) => lastIndex.get(keyOf(row)) === index);
  return { columns: state.columns, rows };
}

/* ------------------------------- normalize ------------------------------- */

type NormalizeOperation = Extract<TransformOperation, { op: 'normalize' }>;

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['`', '`'],
];

function stripOneQuoteLayer(text: string): string {
  if (text.length < 2) return text;
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      return text.slice(open.length, text.length - close.length);
    }
  }
  return text;
}

function applyNormalizeTransforms(text: string, transforms: readonly NormalizeOp[]): string {
  let current = text;
  for (const transform of transforms) {
    switch (transform) {
      case 'trim':
        current = current.trim();
        break;
      case 'lower':
        current = current.toLowerCase();
        break;
      case 'upper':
        current = current.toUpperCase();
        break;
      case 'collapse_space':
        current = current.replace(/\s+/g, ' ').trim();
        break;
      case 'strip_quotes':
        current = stripOneQuoteLayer(current.trim());
        break;
    }
  }
  return current;
}

function normalizeColumn(state: TransformState, operation: NormalizeOperation): TransformState {
  requireColumn(state, operation.column, 'normalize');
  const nullTokens = new Set(operation.nullTokens ?? []);
  const transforms = operation.transforms ?? [];
  const rows = state.rows.map((row) => {
    const cell = row[operation.column] ?? null;
    if (cell === null) return row;
    const text = cellToText(cell);
    if (nullTokens.has(text)) {
      return { ...row, [operation.column]: null };
    }
    const normalized = applyNormalizeTransforms(text, transforms);
    return normalized === text ? row : { ...row, [operation.column]: normalized };
  });
  return { columns: state.columns, rows };
}

/* --------------------------------- cast --------------------------------- */

type CastOperation = Extract<TransformOperation, { op: 'cast' }>;

interface CastResult {
  value: CellValue;
  failed: boolean;
  message?: string;
}

function castCell(cell: CellValue, to: CastOperation['to']): CastResult {
  if (isBlankCell(cell)) {
    return { value: null, failed: false };
  }
  const text = cellToText(cell);
  switch (to) {
    case 'string':
      return { value: text, failed: false };
    case 'number': {
      if (typeof cell === 'number') return { value: cell, failed: false };
      const parsed = parseNumberCell(text);
      return parsed === null
        ? { value: null, failed: true, message: `"${bound(text, 80)}" is not a number` }
        : { value: parsed, failed: false };
    }
    case 'date': {
      if (typeof cell === 'number' || typeof cell === 'boolean') {
        return { value: null, failed: true, message: `"${bound(text, 80)}" is not a date` };
      }
      const parsed = parseDateCell(text);
      return parsed === null
        ? { value: null, failed: true, message: `"${bound(text, 80)}" is not an ISO date (YYYY-MM-DD)` }
        : { value: parsed, failed: false };
    }
    case 'boolean': {
      if (typeof cell === 'boolean') return { value: cell, failed: false };
      const parsed = parseBooleanCell(text);
      return parsed === null
        ? { value: null, failed: true, message: `"${bound(text, 80)}" is not a boolean` }
        : { value: parsed, failed: false };
    }
  }
}

function castColumn(state: TransformState, operation: CastOperation, tracker: IssueTracker): TransformState {
  requireColumn(state, operation.column, 'cast');
  const rows = state.rows.map((row, index) => {
    const cell = row[operation.column] ?? null;
    const result = castCell(cell, operation.to);
    if (!result.failed) {
      return cell === result.value ? row : { ...row, [operation.column]: result.value };
    }
    if (operation.strict) {
      throw new TableTransformError(
        'cast_failed',
        `cast: column "${operation.column}" row ${index + 1} ${result.message ?? 'cannot be cast'} to ${operation.to}`,
        { column: operation.column, row: index + 1, to: operation.to },
      );
    }
    tracker.add(
      `cast: column "${operation.column}" row ${index + 1} ${result.message ?? 'cannot be cast'} to ${operation.to}; value set to null`,
    );
    return { ...row, [operation.column]: null };
  });
  return { columns: state.columns, rows };
}

/* --------------------------------- fill --------------------------------- */

type FillOperation = Extract<TransformOperation, { op: 'fill' }>;

function scalarCellValue(value: JsonValue, operation: string): CellValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TableTransformError(
    'invalid_operator_value',
    `${operation} value must be a string, finite number, boolean or null`,
  );
}

function fillColumn(state: TransformState, operation: FillOperation): TransformState {
  requireColumn(state, operation.column, 'fill');
  const fillValue = scalarCellValue(operation.value, 'fill');
  const onlyEmpty = operation.onlyEmpty ?? true;
  const rows = state.rows.map((row) => {
    const cell = row[operation.column] ?? null;
    const shouldFill = onlyEmpty ? isBlankCell(cell) : true;
    if (!shouldFill || cell === fillValue) return row;
    return { ...row, [operation.column]: fillValue };
  });
  return { columns: state.columns, rows };
}

/* ---------------------------------- map --------------------------------- */

type MapOperation = Extract<TransformOperation, { op: 'map' }>;

function mapColumn(state: TransformState, operation: MapOperation, tracker: IssueTracker): TransformState {
  requireColumn(state, operation.column, 'map');
  const mapping = operation.mapping;
  const fallback = operation.fallback ?? null;
  const recordIssueOnUnknown = operation.recordIssueOnUnknown ?? true;
  const rows = state.rows.map((row, index) => {
    const cell = row[operation.column] ?? null;
    const raw = cellToText(cell);
    if (Object.prototype.hasOwnProperty.call(mapping, raw)) {
      const mapped = mapping[raw]!;
      return mapped === raw ? row : { ...row, [operation.column]: mapped };
    }
    if (fallback !== null) {
      return fallback === raw ? row : { ...row, [operation.column]: fallback };
    }
    if (recordIssueOnUnknown) {
      tracker.add(
        `map: column "${operation.column}" row ${index + 1} value "${bound(raw, 80)}" has no mapping; original value kept`,
      );
    }
    return row;
  });
  return { columns: state.columns, rows };
}

/* -------------------------------- require -------------------------------- */

function requireColumns(state: TransformState, keys: readonly string[], tracker: IssueTracker): TransformState {
  for (const key of keys) requireColumn(state, key, 'require');
  for (const key of keys) {
    const emptyRows: number[] = [];
    state.rows.forEach((row, index) => {
      if (isBlankCell(row[key] ?? null)) emptyRows.push(index + 1);
    });
    if (emptyRows.length === 0) continue;
    const shown = emptyRows.slice(0, 10).join(', ');
    const suffix = emptyRows.length > 10 ? `, … (${emptyRows.length} total)` : '';
    tracker.add(`require: column "${key}" has ${emptyRows.length} empty value(s) at row(s) ${shown}${suffix}`);
  }
  return { columns: state.columns, rows: state.rows };
}
