/**
 * Tabular cell utilities shared by the CSV, JSON, profile and transform layers.
 *
 * All helpers are pure and locale/timezone independent: comparisons use UTF-16
 * code units, dates are validated and formatted in UTC, numbers use the
 * ECMAScript shortest round-trip representation.
 */
import { DataFormatError } from './errors';

export type CellValue = string | number | boolean | null;

/** Alias kept for callers that name a single table cell `TableCell`. */
export type TableCell = CellValue;

export interface TableColumn {
  key: string;
  label: string;
}

export type TableRow = Record<string, CellValue>;

export interface TableData {
  columns: TableColumn[];
  rows: TableRow[];
}

/** Keys that must never become object properties (prototype pollution guard). */
export const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const MAX_COLUMN_KEY_CHARS = 128;

export function isForbiddenObjectKey(key: string): boolean {
  return FORBIDDEN_OBJECT_KEYS.has(key);
}

export function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCellValue(value: unknown): value is CellValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Validate a table-shaped value supplied by another package (recipes/tests). */
export function normalizeTableData(input: unknown): TableData {
  if (!isPlainObjectValue(input)) {
    throw new DataFormatError('transform_failed', 'table input must be an object with columns and rows');
  }
  const columnsRaw = (input as { columns?: unknown }).columns;
  const rowsRaw = (input as { rows?: unknown }).rows;
  if (!Array.isArray(columnsRaw)) {
    throw new DataFormatError('transform_failed', 'table input must have a columns array');
  }
  if (!Array.isArray(rowsRaw)) {
    throw new DataFormatError('transform_failed', 'table input must have a rows array');
  }
  const columns: TableColumn[] = columnsRaw.map((column, index) => {
    if (!isPlainObjectValue(column) || typeof column.key !== 'string' || column.key.length === 0) {
      throw new DataFormatError('transform_failed', `column ${index} must have a non-empty string key`);
    }
    const key = column.key;
    if (key.length > MAX_COLUMN_KEY_CHARS) {
      throw new DataFormatError('transform_failed', `column key is longer than ${MAX_COLUMN_KEY_CHARS} chars: ${bound(key)}`);
    }
    if (isForbiddenObjectKey(key)) {
      throw new DataFormatError('transform_failed', `column key is not allowed: ${key}`);
    }
    const label = typeof column.label === 'string' && column.label.length > 0 ? column.label : key;
    return { key, label };
  });
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.key)) {
      throw new DataFormatError('duplicate_column', `duplicate column key: ${column.key}`);
    }
    seen.add(column.key);
  }
  const rows: TableRow[] = rowsRaw.map((row, index) => {
    if (!isPlainObjectValue(row)) {
      throw new DataFormatError('transform_failed', `row ${index + 1} must be an object`);
    }
    const out: TableRow = {};
    for (const column of columns) {
      const value = (row as Record<string, unknown>)[column.key];
      if (value === undefined) continue;
      if (!isCellValue(value)) {
        throw new DataFormatError(
          'transform_failed',
          `row ${index + 1} column ${column.key} must be a string, finite number, boolean or null`,
        );
      }
      out[column.key] = value;
    }
    return out;
  });
  return { columns, rows };
}

export function isEmptyCell(value: CellValue | undefined): boolean {
  return value === null || value === undefined || value === '';
}

/** An empty value under data-quality rules: null/empty/whitespace-only. */
export function isBlankCell(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

export function formatNumberStable(value: number): string {
  if (!Number.isFinite(value)) {
    throw new DataFormatError('transform_failed', `cannot format non-finite number: ${String(value)}`);
  }
  if (Object.is(value, -0)) return '0';
  return String(value);
}

export function cellToText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumberStable(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

export function cellFromText(text: string): CellValue {
  return text;
}

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Strict decimal number parse (no grouping separators, no locale formats). */
export function parseNumberCell(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (!NUMBER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE_PATTERN = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const ISO_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Date.UTC is timezone independent (fixed epoch) and validates the day by
  // rolling over invalid dates; compare the components back.
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Parse a calendar date into canonical `YYYY-MM-DD`; null when invalid. */
export function parseDateCell(text: string): string | null {
  const trimmed = text.trim();
  let year: number;
  let month: number;
  let day: number;
  const iso = ISO_DATE_PATTERN.exec(trimmed);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const slash = SLASH_DATE_PATTERN.exec(trimmed);
    if (slash) {
      year = Number(slash[1]);
      month = Number(slash[2]);
      day = Number(slash[3]);
    } else {
      const datetime = ISO_DATETIME_PATTERN.exec(trimmed);
      if (!datetime) return null;
      year = Number(datetime[1]);
      month = Number(datetime[2]);
      day = Number(datetime[3]);
      const hour = Number(datetime[4]);
      const minute = Number(datetime[5]);
      const second = datetime[6] === undefined ? 0 : Number(datetime[6]);
      if (hour > 23 || minute > 59 || second > 59) return null;
    }
  }
  if (!validCalendarDate(year, month, day)) return null;
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}

const TRUE_TOKENS: ReadonlySet<string> = new Set(['true', 'yes', 'y', 't', '1', '是', '真']);
const FALSE_TOKENS: ReadonlySet<string> = new Set(['false', 'no', 'n', 'f', '0', '否', '假']);

/** Parse a boolean token; null when the text is not a recognized boolean. */
export function parseBooleanCell(text: string): boolean | null {
  const token = text.trim().toLowerCase();
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  return null;
}

/** Truncate to at most `maxChars` UTF-16 units without splitting a surrogate pair. */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

/** Excerpt of at most `maxChars` around `center`; always an exact substring. */
export function excerptAround(text: string, center: number, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const safeCenter = Math.min(Math.max(center, 0), text.length);
  const half = Math.floor((maxChars - 1) / 2);
  let start = Math.max(0, safeCenter - half);
  let end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  if (end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  if (start > 0) {
    const first = text.charCodeAt(start);
    const previous = text.charCodeAt(start - 1);
    if (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) start += 1;
  }
  return text.slice(start, end);
}

/** Deterministic, locale-independent text comparison on UTF-16 code units. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function cloneTable(table: TableData): TableData {
  return {
    columns: table.columns.map((column) => ({ key: column.key, label: column.label })),
    rows: table.rows.map((row) => ({ ...row })),
  };
}

export function columnKeys(table: TableData): string[] {
  return table.columns.map((column) => column.key);
}

export function hasColumn(table: TableData, key: string): boolean {
  return table.columns.some((column) => column.key === key);
}

export function bound(text: string, maxChars = 200): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}
