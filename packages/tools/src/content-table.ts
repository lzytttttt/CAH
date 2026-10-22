/**
 * Bridges between artifact module content (CSV / JSON) and the normalized
 * `TableData` used by the deterministic transform engine.
 *
 * Used by `data.transform` and by deterministic recipes that clean a CSV module
 * or build a JSON candidate from a table.
 */
import {
  CsvContentSchema,
  type CsvCellValue,
  type CsvColumn,
  type CsvContent,
  type CsvRow,
  type JsonContent,
  type ModuleContent,
} from '@ca/contracts';
import { DataFormatError } from './errors';
import { tableFromJsonValue, tableToJsonValue } from './json-data';
import {
  cellToText,
  isBlankCell,
  normalizeTableData,
  parseBooleanCell,
  parseDateCell,
  parseNumberCell,
  type CellValue,
  type TableColumn,
  type TableData,
  type TableRow,
} from './table';

/** Convert a CSV module content value into a normalized table. */
export function tableFromCsvContent(content: CsvContent): TableData {
  const keys = content.columns.map((column) => column.key);
  const rows: TableRow[] = content.rows.map((row, index) => {
    const next: TableRow = {};
    for (const key of keys) {
      const value = row[key];
      if (value === undefined) {
        throw new DataFormatError('data_format_error', `csv module row ${index + 1} is missing column "${key}"`);
      }
      next[key] = value;
    }
    return next;
  });
  const table: TableData = {
    columns: content.columns.map((column) => ({ key: column.key, label: column.label })),
    rows,
  };
  return normalizeTableData(table);
}

/** Convert a JSON module content value into a normalized table. */
export function tableFromJsonContent(content: JsonContent, issues: string[] = []): TableData {
  return tableFromJsonValue(content.value, { issues });
}

/** Convert CSV or JSON module content into a table; markdown has no table shape. */
export function tableFromModuleContent(content: ModuleContent, issues: string[] = []): TableData {
  switch (content.kind) {
    case 'csv':
      return tableFromCsvContent(content);
    case 'json':
      return tableFromJsonContent(content, issues);
    case 'markdown':
      throw new DataFormatError('unsupported_format', 'markdown module content cannot be represented as a table');
  }
}

export type InferredColumnType = 'string' | 'number' | 'date' | 'boolean';

/**
 * Infer a column type deterministically: a column is typed when every non-blank
 * cell parses as that type; otherwise it is a string column.
 */
export function inferColumnType(cells: readonly CellValue[]): InferredColumnType {
  let nonBlank = 0;
  let numbers = 0;
  let dates = 0;
  let booleans = 0;
  for (const cell of cells) {
    if (isBlankCell(cell)) continue;
    nonBlank += 1;
    const text = cellToText(cell);
    if (typeof cell === 'number' || parseNumberCell(text) !== null) {
      numbers += 1;
    } else if (parseDateCell(text) !== null) {
      dates += 1;
    } else if (typeof cell === 'boolean' || parseBooleanCell(text) !== null) {
      booleans += 1;
    }
  }
  if (nonBlank === 0) return 'string';
  if (numbers === nonBlank) return 'number';
  if (dates === nonBlank) return 'date';
  if (booleans === nonBlank) return 'boolean';
  return 'string';
}

export interface CsvContentFromTableOptions {
  /** Column keys that must be non-empty (copied into CsvColumn.required). */
  required?: readonly string[];
  /** Override inferred column types. */
  columnTypes?: Readonly<Record<string, InferredColumnType>>;
  /** Column descriptions (optional). */
  descriptions?: Readonly<Record<string, string>>;
}

/** Build a validated CsvContent value from a table. */
export function csvContentFromTable(table: TableData, options: CsvContentFromTableOptions = {}): CsvContent {
  const required = new Set(options.required ?? []);
  const columns: CsvColumn[] = table.columns.map((column: TableColumn) => {
    const cells = table.rows.map((row) => row[column.key] ?? null);
    const type = options.columnTypes?.[column.key] ?? inferColumnType(cells);
    const description = options.descriptions?.[column.key];
    return {
      key: column.key,
      label: column.label,
      type: type === 'date' ? 'date' : type,
      required: required.has(column.key),
      ...(description ? { description } : {}),
    };
  });
  const rows: CsvRow[] = table.rows.map((row) => {
    const next: CsvRow = {};
    for (const column of table.columns) {
      const value = row[column.key] ?? null;
      if (value !== null && typeof value === 'string' && value.length > 32_768) {
        throw new DataFormatError('limit_exceeded', `csv cell for column "${column.key}" is too large`);
      }
      next[column.key] = value as CsvCellValue;
    }
    return next;
  });
  const parsed = CsvContentSchema.safeParse({ kind: 'csv', columns, rows });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DataFormatError(
      'data_format_error',
      `cannot build csv module content: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'schema violation'}`,
    );
  }
  return parsed.data;
}

/** Build a validated JSON module content value from a table. */
export function jsonContentFromTable(table: TableData): JsonContent {
  return { kind: 'json', value: tableToJsonValue(normalizeTableData(table)) };
}
