/**
 * Deterministic data profiling for CSV and JSON sources (read-only).
 *
 * The profile reports structure, per-column inferred types, missing/distinct
 * counts, duplicate rows and data-quality issues. It never rewrites data and
 * never guesses a canonical schema: required-field rules come from the field
 * mapping applied by a recipe/transform, so the profile additionally reports
 * the number of rows containing at least one empty cell.
 */
import {
  type ColumnProfile,
  type DataFormat,
  type DataProfileResult,
  type SourceId,
} from '@ca/contracts';
import { parseCsv, tableFromParsedCsv } from './csv';
import { parseBoundedJson, tableFromJsonValue } from './json-data';
import {
  bound,
  cellToText,
  isBlankCell,
  parseBooleanCell,
  parseDateCell,
  parseNumberCell,
  type CellValue,
  type TableData,
} from './table';

export interface ProfileSourceInput {
  sourceId: SourceId;
  version: number;
  format: DataFormat;
  text: string;
}

type InferredType = ColumnProfile['inferredType'];
type ConcreteType = Exclude<InferredType, 'empty' | 'mixed'>;

const TYPE_ORDER: readonly ConcreteType[] = ['number', 'date', 'boolean', 'string'];
const MAX_COLUMN_ISSUES = 20;
const MAX_PROFILE_ISSUES = 100;

function classifyCell(cell: CellValue): ConcreteType | null {
  if (isBlankCell(cell)) return null;
  const text = cellToText(cell);
  if (typeof cell === 'number' || parseNumberCell(text) !== null) return 'number';
  if (parseDateCell(text) !== null) return 'date';
  if (typeof cell === 'boolean' || parseBooleanCell(text) !== null) return 'boolean';
  return 'string';
}

function orderedTypes(types: ReadonlySet<ConcreteType>): ConcreteType[] {
  return TYPE_ORDER.filter((type) => types.has(type));
}

export interface TableProfileSummary {
  columns: ColumnProfile[];
  duplicateRowCount: number;
  missingRequiredCount: number;
  issues: string[];
}

/** Profile a normalized table (pure; used by data.profile and tests). */
export function profileTableData(table: TableData): TableProfileSummary {
  const issues: string[] = [];
  const keyOfRow = (row: (typeof table.rows)[number]): string =>
    JSON.stringify(table.columns.map((column) => cellToText(row[column.key] ?? null)));

  const seenRows = new Set<string>();
  let duplicateRowCount = 0;
  let missingRequiredCount = 0;
  for (const row of table.rows) {
    const key = keyOfRow(row);
    if (seenRows.has(key)) duplicateRowCount += 1;
    else seenRows.add(key);
    if (table.columns.some((column) => isBlankCell(row[column.key] ?? null))) missingRequiredCount += 1;
  }

  const columns: ColumnProfile[] = table.columns.map((column) => {
    const columnIssues: string[] = [];
    const types = new Set<ConcreteType>();
    const distinct = new Set<string>();
    const samples: string[] = [];
    let missing = 0;
    let whitespaceOnly = 0;
    let padded = 0;
    for (const row of table.rows) {
      const cell = row[column.key] ?? null;
      if (isBlankCell(cell)) {
        missing += 1;
        if (typeof cell === 'string' && cell.length > 0) whitespaceOnly += 1;
        continue;
      }
      const text = cellToText(cell);
      distinct.add(text);
      if (samples.length < 5 && !samples.includes(bound(text, 200))) samples.push(bound(text, 200));
      if (typeof cell === 'string' && cell.trim() !== cell) padded += 1;
      const type = classifyCell(cell);
      if (type) types.add(type);
    }

    const ordered = orderedTypes(types);
    const inferredType: InferredType =
      ordered.length === 0 ? 'empty' : ordered.length === 1 ? ordered[0]! : 'mixed';

    if (inferredType === 'mixed') {
      columnIssues.push(`mixed value types: ${ordered.join(', ')}`);
    }
    if (whitespaceOnly > 0) {
      columnIssues.push(`${whitespaceOnly} whitespace-only value(s)`);
    }
    if (padded > 0) {
      columnIssues.push(`${padded} value(s) have leading/trailing whitespace`);
    }
    if (inferredType === 'number' && missing > 0) {
      columnIssues.push(`${missing} empty value(s) in a numeric column`);
    }

    if (inferredType === 'mixed') {
      issues.push(`column "${column.key}" has mixed value types: ${ordered.join(', ')}`);
    }
    return {
      key: column.key,
      inferredType,
      missing,
      distinct: distinct.size,
      samples,
      issues: columnIssues.slice(0, MAX_COLUMN_ISSUES).map((issue) => bound(issue, 300)),
    };
  });

  if (duplicateRowCount > 0) {
    issues.push(`${duplicateRowCount} duplicate data row(s) (identical values in all columns)`);
  }
  if (missingRequiredCount > 0) {
    issues.push(
      `${missingRequiredCount} row(s) contain at least one empty cell (required-field rules come from the field mapping at transform time)`,
    );
  }

  return {
    columns,
    duplicateRowCount,
    missingRequiredCount,
    issues: issues.slice(0, MAX_PROFILE_ISSUES).map((issue) => bound(issue, 500)),
  };
}

/** Build the `data.profile` result for a stored source version. */
export function buildDataProfile(input: ProfileSourceInput): DataProfileResult {
  const issues: string[] = [];
  let table: TableData;

  if (input.format === 'csv') {
    const parsed = parseCsv(input.text);
    table = tableFromParsedCsv(parsed, { lenient: true, issues });
    if (table.columns.length === 0) {
      issues.push('csv source has no header row; row/column counts are zero');
    }
  } else {
    const value = parseBoundedJson(input.text);
    table = tableFromJsonValue(value, { issues });
  }

  const summary = profileTableData(table);
  const merged = [...issues, ...summary.issues];
  return {
    sourceId: input.sourceId,
    version: input.version,
    format: input.format,
    rowCount: table.rows.length,
    columnCount: table.columns.length,
    columns: summary.columns,
    duplicateRowCount: summary.duplicateRowCount,
    missingRequiredCount: summary.missingRequiredCount,
    issues: merged.slice(0, MAX_PROFILE_ISSUES).map((issue) => bound(issue, 500)),
  };
}
