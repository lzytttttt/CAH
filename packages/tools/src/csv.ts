/**
 * RFC 4180-style CSV parser and writer.
 *
 * Rules implemented:
 * - UTF-8 BOM is stripped on read; written files never contain a BOM.
 * - Records are separated by CRLF or LF (a lone CR is also accepted as a break).
 * - Fields may be quoted with `"`; inside quotes `""` is an escaped quote and
 *   commas / newlines are literal data.
 * - Writing quotes a field only when it contains `"`, `,`, CR or LF.
 * - Hard limits from `@ca/contracts` LIMITS are enforced with predictable errors.
 */
import { LIMITS } from '@ca/contracts';
import { CsvParseError } from './errors';
import {
  cellToText,
  FORBIDDEN_OBJECT_KEYS,
  formatNumberStable,
  MAX_COLUMN_KEY_CHARS,
  type CellValue,
  type TableColumn,
  type TableData,
  type TableRow,
} from './table';

export type CsvEol = '\n' | '\r\n';

export interface CsvParseOptions {
  /** Treat the first record as the header (default true). */
  header?: boolean;
  /** Maximum data rows (excluding header). Defaults to LIMITS.maxCsvRows. */
  maxRows?: number;
  /** Maximum columns. Defaults to LIMITS.maxCsvColumns. */
  maxColumns?: number;
  /** Maximum characters per field. Defaults to LIMITS.maxCsvFieldChars. */
  maxFieldChars?: number;
}

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  /** 1-based physical line number where each data row starts. */
  rowStartLines: number[];
  /** True when the input started with a UTF-8 BOM. */
  hadBom: boolean;
  /** First record terminator observed (used when re-serializing). */
  eol: CsvEol;
  /** 1-based data row numbers whose field count differs from the header. */
  fieldCountMismatchRows: number[];
  /** Header names that occur more than once (in first-appearance order). */
  duplicateHeaders: string[];
}

const DEFAULT_MAX_ROWS = LIMITS.maxCsvRows;
const DEFAULT_MAX_COLUMNS = LIMITS.maxCsvColumns;
const DEFAULT_MAX_FIELD_CHARS = LIMITS.maxCsvFieldChars;

/** Parse CSV text. Throws CsvParseError for structural problems and limit breaks. */
export function parseCsv(text: string, options: CsvParseOptions = {}): ParsedCsv {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;
  const useHeader = options.header ?? true;

  const hadBom = text.startsWith('\uFEFF');
  const input = hadBom ? text.slice(1) : text;

  const records: string[][] = [];
  const recordStartLines: number[] = [];
  let eol: CsvEol = '\n';

  let i = 0;
  let line = 1;
  let recordStartLine = 1;
  let field = '';
  let fieldWasQuoted = false;
  let inQuoted = false;
  let fields: string[] = [];
  let sawEol = false;

  const ensureFieldLimit = (): void => {
    if (field.length > maxFieldChars) {
      throw new CsvParseError(
        'limit_exceeded',
        `csv field exceeds ${maxFieldChars} characters (line ${line})`,
        { limit: maxFieldChars, line },
      );
    }
  };

  const endField = (): void => {
    ensureFieldLimit();
    fields.push(field);
    field = '';
    fieldWasQuoted = false;
  };

  const endRecord = (): void => {
    endField();
    if (fields.length > maxColumns) {
      throw new CsvParseError('limit_exceeded', `csv record has ${fields.length} columns (limit ${maxColumns})`, {
        limit: maxColumns,
        line: recordStartLine,
      });
    }
    records.push(fields);
    recordStartLines.push(recordStartLine);
    if (!useHeader && records.length > maxRows) {
      throw new CsvParseError('limit_exceeded', `csv has more than ${maxRows} rows`, { limit: maxRows });
    }
    if (useHeader && records.length - 1 > maxRows) {
      throw new CsvParseError('limit_exceeded', `csv has more than ${maxRows} data rows`, { limit: maxRows });
    }
    fields = [];
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          ensureFieldLimit();
          continue;
        }
        inQuoted = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      ensureFieldLimit();
      continue;
    }

    if (ch === '"') {
      if (field.length === 0 && !fieldWasQuoted) {
        inQuoted = true;
        fieldWasQuoted = true;
        i += 1;
        continue;
      }
      throw new CsvParseError('malformed_quote', `unexpected '"' inside an unquoted field at line ${line}`, {
        line,
      });
    }

    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      endRecord();
      if (!sawEol) {
        eol = ch === '\r' && input[i + 1] === '\n' ? '\r\n' : '\n';
        sawEol = true;
      }
      if (ch === '\r' && input[i + 1] === '\n') i += 2;
      else i += 1;
      line += 1;
      recordStartLine = line;
      continue;
    }

    if (fieldWasQuoted) {
      throw new CsvParseError(
        'malformed_quote',
        `unexpected character '${ch}' after a closing quote at line ${line}`,
        { line },
      );
    }

    field += ch;
    i += 1;
    ensureFieldLimit();
  }

  if (inQuoted) {
    throw new CsvParseError('unterminated_quote', `unterminated quoted field starting at line ${recordStartLine}`, {
      line: recordStartLine,
    });
  }

  if (field.length > 0 || fieldWasQuoted || fields.length > 0) {
    endRecord();
  }

  if (useHeader && records.length === 0) {
    return {
      header: [],
      rows: [],
      rowStartLines: [],
      hadBom,
      eol,
      fieldCountMismatchRows: [],
      duplicateHeaders: [],
    };
  }

  const header = useHeader ? (records.shift() ?? []) : [];
  const dataStartLines = useHeader ? recordStartLines.slice(1) : recordStartLines;

  if (header.length > maxColumns) {
    throw new CsvParseError('limit_exceeded', `csv header has ${header.length} columns (limit ${maxColumns})`, {
      limit: maxColumns,
    });
  }
  if (!useHeader && records.length > 0) {
    const maxWidth = records.reduce((max, row) => Math.max(max, row.length), 0);
    if (maxWidth > maxColumns) {
      throw new CsvParseError('limit_exceeded', `csv record has ${maxWidth} columns (limit ${maxColumns})`, {
        limit: maxColumns,
      });
    }
  }

  const expectedArity = useHeader ? header.length : (records[0]?.length ?? 0);
  const fieldCountMismatchRows: number[] = [];
  records.forEach((record, index) => {
    if (record.length !== expectedArity) fieldCountMismatchRows.push(index + 1);
  });

  const duplicateHeaders: string[] = [];
  if (useHeader) {
    const counts = new Map<string, number>();
    for (const name of header) counts.set(name, (counts.get(name) ?? 0) + 1);
    const reported = new Set<string>();
    for (const name of header) {
      if ((counts.get(name) ?? 0) > 1 && !reported.has(name)) {
        reported.add(name);
        duplicateHeaders.push(name);
      }
    }
  }

  return {
    header,
    rows: records,
    rowStartLines: dataStartLines,
    hadBom,
    eol,
    fieldCountMismatchRows,
    duplicateHeaders,
  };
}

export interface CsvWriteOptions {
  eol?: CsvEol;
}

/** Serialize one record (no trailing line break). */
export function serializeCsvRecord(cells: readonly CellValue[], maxFieldChars = DEFAULT_MAX_FIELD_CHARS): string {
  const parts: string[] = [];
  for (const cell of cells) {
    parts.push(encodeCsvField(cellToText(cell), maxFieldChars));
  }
  return parts.join(',');
}

function encodeCsvField(text: string, maxFieldChars: number): string {
  if (text.length > maxFieldChars) {
    throw new CsvParseError('limit_exceeded', `csv field exceeds ${maxFieldChars} characters`, {
      limit: maxFieldChars,
    });
  }
  if (text.includes('"') || text.includes(',') || text.includes('\r') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize a header + rows as RFC 4180 CSV text (CRLF by default). */
export function writeCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly CellValue[]>,
  options: CsvWriteOptions = {},
): string {
  const eol = options.eol ?? '\r\n';
  const lines: string[] = [];
  if (header.length > 0) {
    lines.push(serializeCsvRecord(header.map((name) => String(name))));
  }
  for (const row of rows) lines.push(serializeCsvRecord(row));
  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
}

/** Serialize a normalized table as CSV. */
export function tableToCsv(table: TableData, options: CsvWriteOptions = {}): string {
  return writeCsv(
    table.columns.map((column) => column.key),
    table.rows.map((row) => table.columns.map((column) => row[column.key] ?? null)),
    options,
  );
}

export interface TableFromCsvOptions {
  /** Pad/truncate ragged rows instead of failing (used by profiling). */
  lenient?: boolean;
  /** Collect human-readable data-quality notes (lenient mode). */
  issues?: string[];
}

const MAX_COLLECTED_ISSUES = 100;

function pushIssue(issues: string[] | undefined, message: string): void {
  if (!issues) return;
  if (issues.length >= MAX_COLLECTED_ISSUES) return;
  issues.push(message);
}

/** Convert parsed CSV into a normalized table. */
export function tableFromParsedCsv(parsed: ParsedCsv, options: TableFromCsvOptions = {}): TableData {
  const lenient = options.lenient ?? false;
  const issues = options.issues;

  if (parsed.header.length === 0) {
    return { columns: [], rows: [] };
  }

  const usedKeys = new Set<string>();
  const columns: TableColumn[] = parsed.header.map((rawName, index) => {
    let key = rawName;
    if (key.length === 0) {
      if (!lenient) {
        throw new CsvParseError('csv_parse_error', `csv header column ${index + 1} has an empty name`, {
          column: index + 1,
        });
      }
      key = `column_${index + 1}`;
      pushIssue(issues, `csv header column ${index + 1} is empty; renamed to ${key}`);
    }
    if (key.length > MAX_COLUMN_KEY_CHARS) {
      throw new CsvParseError(
        'csv_parse_error',
        `csv header name is longer than ${MAX_COLUMN_KEY_CHARS} chars: ${key.slice(0, 40)}…`,
        { column: index + 1 },
      );
    }
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new CsvParseError('csv_parse_error', `csv header name is not allowed: ${key}`, { column: index + 1 });
    }
    if (usedKeys.has(key)) {
      if (!lenient) {
        throw new CsvParseError('csv_parse_error', `duplicate csv header name: ${key}`, { column: key });
      }
      let suffix = 2;
      while (usedKeys.has(`${key}__${suffix}`)) suffix += 1;
      const unique = `${key}__${suffix}`.slice(0, MAX_COLUMN_KEY_CHARS);
      pushIssue(issues, `duplicate csv header ${key} renamed to ${unique}`);
      key = unique;
    }
    usedKeys.add(key);
    return { key, label: key };
  });

  const rows: TableRow[] = parsed.rows.map((record, index) => {
    const rowNumber = index + 1;
    if (record.length !== columns.length) {
      if (!lenient) {
        throw new CsvParseError(
          'csv_parse_error',
          `csv data row ${rowNumber} has ${record.length} fields but the header has ${columns.length}`,
          { row: rowNumber, expected: columns.length, actual: record.length },
        );
      }
      pushIssue(
        issues,
        `csv data row ${rowNumber} has ${record.length} fields (expected ${columns.length}); padded/truncated`,
      );
    }
    const row: TableRow = {};
    columns.forEach((column, columnIndex) => {
      row[column.key] = record[columnIndex] ?? '';
    });
    return row;
  });

  if (parsed.duplicateHeaders.length > 0 && lenient) {
    for (const name of parsed.duplicateHeaders) {
      if (!issues?.some((issue) => issue.includes(`duplicate csv header ${name}`))) {
        pushIssue(issues, `duplicate csv header name: ${name}`);
      }
    }
  }

  return { columns, rows };
}

/** Parse CSV text and convert it into a normalized table in one step. */
export function tableFromCsv(text: string, options: TableFromCsvOptions & CsvParseOptions = {}): TableData {
  const parsed = parseCsv(text, options);
  return tableFromParsedCsv(parsed, options);
}

/** Parse CSV text into a table plus any lenient-mode data-quality issues. */
export function tableFromCsvLenient(text: string, issues: string[]): TableData {
  const parsed = parseCsv(text);
  return tableFromParsedCsv(parsed, { lenient: true, issues });
}

/** Re-serialize selected 1-based data rows (header included) for evidence reads. */
export function csvRowsRegion(parsed: ParsedCsv, rowNumbers: readonly number[]): string {
  const selected: string[][] = [];
  for (const rowNumber of rowNumbers) {
    const row = parsed.rows[rowNumber - 1];
    if (!row) {
      throw new CsvParseError('locator_out_of_range', `csv row ${rowNumber} is out of range (1..${parsed.rows.length})`, {
        row: rowNumber,
        rowCount: parsed.rows.length,
      });
    }
    selected.push(row);
  }
  return writeCsv(parsed.header, selected, { eol: parsed.eol });
}

/** Serialize a single parsed row the same way `csvRowsRegion` would. */
export function csvRowText(row: readonly string[]): string {
  return serializeCsvRecord(row.map((value) => value));
}

/** Format a numeric cell the same way the table/CSV layers do. */
export function formatCsvNumber(value: number): string {
  return formatNumberStable(value);
}
