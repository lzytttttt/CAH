/**
 * Bounded conversions between recipe step values and artifact module content.
 *
 * Recipe step values are internal (they never leave the runtime except through
 * `emit_artifact`), but every emitted output must be a schema-valid
 * `ModuleContent` value. This module centralizes that projection so the runtime
 * and extraction stay small and the behavior is testable in isolation.
 */
import {
  LIMITS,
  ModuleContentSchema,
  canonicalJson,
  type JsonValue,
  type MarkdownContent,
  type ModuleContent,
  type ModuleKind,
} from '@ca/contracts';
import {
  canonicalJsonHash,
  contentHash,
  csvContentFromTable,
  jsonContentFromTable,
  normalizeTableData,
  parseSourceTable,
  tableFromJsonValue,
  tableFromModuleContent,
  tableToCsv,
  tableToJsonValue,
  truncateText,
  utf8Encode,
  type TableData,
} from '@ca/tools';
import { RecipeRuntimeError, errorMessage } from './errors';
import type { RecipeRunOutput } from './types';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTableData(value: unknown): value is TableData {
  if (!isPlainRecord(value)) return false;
  const columns = value.columns;
  const rows = value.rows;
  return Array.isArray(columns) && Array.isArray(rows);
}

export function isModuleContent(value: unknown): value is ModuleContent {
  if (!isPlainRecord(value)) return false;
  const kind = value.kind;
  if (kind === 'markdown') return Array.isArray(value.sections);
  if (kind === 'csv') return Array.isArray(value.columns) && Array.isArray(value.rows);
  if (kind === 'json') return Object.prototype.hasOwnProperty.call(value, 'value');
  return false;
}

/** Serialize a module content value exactly as the object writer stores it. */
export function serializeModuleContent(content: ModuleContent): Uint8Array {
  // canonical JSON bytes: sha256(bytes) === contentHash(content), so the object
  // store hash and the artifact contentHash are the same value by construction.
  return utf8Encode(canonicalJson(content));
}

export function contentFromTableForKind(table: TableData, moduleKind: ModuleKind): ModuleContent {
  switch (moduleKind) {
    case 'csv':
      return csvContentFromTable(table);
    case 'json':
      return jsonContentFromTable(table);
    case 'markdown': {
      const csv = tableToCsv(table);
      return markdownFromText(csv, 'transformed-table');
    }
  }
}

export interface CoerceTableOptions {
  /** Format used when the value is raw text (`csv` or `json`). */
  format: 'csv' | 'json';
  /** Accumulates non-fatal parse issues (ragged rows, flattened nested JSON). */
  issues?: string[];
}

/**
 * Convert a step value into a deterministic TableData value.
 *
 * Supported shapes: TableData, {table}, ModuleContent, {content}, {text},
 * raw CSV/JSON text and plain JSON values (for `format: 'json'`).
 */
export function coerceTable(value: unknown, options: CoerceTableOptions): TableData {
  const issues = options.issues;
  if (isTableData(value)) {
    return safeNormalizeTable(value);
  }
  if (isModuleContent(value)) {
    return safeTableFromModuleContent(value, issues);
  }
  if (isPlainRecord(value)) {
    if (isTableData(value.table)) return safeNormalizeTable(value.table);
    if (isModuleContent(value.content)) return safeTableFromModuleContent(value.content, issues);
    if (typeof value.text === 'string') return parseTextTable(value.text, options.format, issues);
  }
  if (typeof value === 'string') {
    return parseTextTable(value, options.format, issues);
  }
  if (options.format === 'json') {
    return tableFromJsonValueSafe(value, issues);
  }
  throw new RecipeRuntimeError(
    'invalid_input',
    `data.transform expects a table, module content or ${options.format} text; received ${describeValue(value)}`,
  );
}

export function coerceTableFromText(text: string, format: 'csv' | 'json', issues?: string[]): TableData {
  return parseTextTable(text, format, issues);
}

function parseTextTable(text: string, format: 'csv' | 'json', issues?: string[]): TableData {
  try {
    const parsed = parseSourceTable(text, format);
    if (issues) issues.push(...parsed.issues);
    return parsed.table;
  } catch (error) {
    throw new RecipeRuntimeError(
      'invalid_input',
      `cannot parse ${format} input: ${errorMessage(error)}`,
      { details: { format } },
    );
  }
}

function tableFromJsonValueSafe(value: unknown, issues?: string[]): TableData {
  let normalized: JsonValue;
  try {
    normalized = JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch (error) {
    throw new RecipeRuntimeError('invalid_input', `value is not JSON-serializable: ${errorMessage(error)}`);
  }
  return tableFromJsonValue(normalized, issues ? { issues } : {});
}

function safeNormalizeTable(value: unknown): TableData {
  try {
    return normalizeTableData(value);
  } catch (error) {
    throw new RecipeRuntimeError('invalid_input', `invalid table value: ${errorMessage(error)}`);
  }
}

function safeTableFromModuleContent(content: ModuleContent, issues?: string[]): TableData {
  try {
    return tableFromModuleContent(content, issues ?? []);
  } catch (error) {
    throw new RecipeRuntimeError(
      'invalid_input',
      `module content of kind "${content.kind}" cannot become a table: ${errorMessage(error)}`,
    );
  }
}

export function markdownFromText(text: string, title: string, sectionId = 'content'): MarkdownContent {
  const id = sectionId.replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'content';
  return {
    kind: 'markdown',
    sections: [{ id: id.slice(0, 64), title: truncateText(title, 200) || 'Content', markdown: text }],
  };
}

/** Throw when an emitted content kind does not match the recipe output kind. */
export function assertModuleKind(content: ModuleContent, expected: ModuleKind, artifactName: string): void {
  if (content.kind !== expected) {
    throw new RecipeRuntimeError(
      'output_kind_mismatch',
      `emit_artifact "${artifactName}" produced ${content.kind} content but the recipe declares outputArtifactKind "${expected}"`,
      { details: { expected, actual: content.kind, artifactName } },
    );
  }
}

/**
 * Build the emitted module content from a step value.
 *
 * No historical answer is ever embedded: everything comes from the bound value
 * (transform output, artifact content or model text) at run time.
 */
export function coerceModuleContent(
  value: unknown,
  moduleKind: ModuleKind,
  artifactName: string,
): ModuleContent {
  let content: ModuleContent;
  if (isModuleContent(value) && value.kind === moduleKind) {
    content = parseContent(value, artifactName);
  } else if (isTableData(value) || hasTableWrapper(value)) {
    const table = coerceTable(value, { format: 'csv' });
    content = contentFromTableForKind(table, moduleKind);
  } else if (isModuleContent(value)) {
    // Wrong kind: report the mismatch instead of silently reinterpreting data.
    throw new RecipeRuntimeError(
      'output_kind_mismatch',
      `emit_artifact "${artifactName}" received ${value.kind} content but the recipe declares outputArtifactKind "${moduleKind}"`,
      { details: { expected: moduleKind, actual: value.kind, artifactName } },
    );
  } else if (moduleKind === 'markdown') {
    const text =
      typeof value === 'string'
        ? value
        : isPlainRecord(value) && typeof value.text === 'string'
          ? value.text
          : isPlainRecord(value) && typeof value.markdown === 'string'
            ? value.markdown
            : null;
    if (text === null) {
      throw new RecipeRuntimeError(
        'output_kind_mismatch',
        `emit_artifact "${artifactName}" cannot build markdown from ${describeValue(value)}`,
      );
    }
    content = markdownFromText(text, artifactName);
  } else if (moduleKind === 'csv' && typeof value === 'string') {
    const table = parseTextTable(value, 'csv');
    content = csvContentFromTable(table);
  } else if (moduleKind === 'json') {
    let jsonValue: JsonValue;
    try {
      jsonValue = JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch (error) {
      throw new RecipeRuntimeError('invalid_input', `emit_artifact value is not JSON-serializable: ${errorMessage(error)}`);
    }
    content = { kind: 'json', value: jsonValue };
  } else {
    throw new RecipeRuntimeError(
      'output_kind_mismatch',
      `emit_artifact "${artifactName}" cannot build ${moduleKind} content from ${describeValue(value)}`,
    );
  }
  assertModuleKind(content, moduleKind, artifactName);
  return content;
}

function hasTableWrapper(value: unknown): boolean {
  return isPlainRecord(value) && isTableData(value.table);
}

/** Re-parse content through the contract schema so outputs are provably valid. */
export function parseContent(content: ModuleContent, artifactName: string): ModuleContent {
  const parsed = ModuleContentSchema.safeParse(content);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new RecipeRuntimeError(
      'output_kind_mismatch',
      `emitted content for "${artifactName}" violates ModuleContentSchema: ${
        first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'schema violation'
      }`,
    );
  }
  return parsed.data;
}

export function rowCountOfContent(content: ModuleContent): number | null {
  switch (content.kind) {
    case 'csv':
      return content.rows.length;
    case 'json':
      return Array.isArray(content.value) ? content.value.length : null;
    case 'markdown':
      return null;
  }
}

/** Bounded, human-readable output preview (contract: max 1000 chars). */
export function previewOfContent(content: ModuleContent, maxChars = LIMITS.previewExcerptChars): string {
  const limit = Math.min(Math.max(maxChars, 16), 1000);
  switch (content.kind) {
    case 'csv': {
      const head = content.columns.map((column) => column.key);
      const rows = content.rows.slice(0, 3).map((row) => head.map((key) => row[key] ?? null));
      const table: TableData = { columns: head.map((key) => ({ key, label: key })), rows: rows as never };
      const text = tableToCsv(table);
      return truncateText(text, limit);
    }
    case 'json':
      return truncateText(JSON.stringify(content.value) ?? 'null', limit);
    case 'markdown': {
      const titles = content.sections.map((section) => section.title).join(' / ');
      return truncateText(
        `${content.sections.length} section(s)${titles ? `: ${titles}` : ''}`,
        limit,
      );
    }
  }
}

/** Build the contract output descriptor for an emitted module content value. */
export function outputFromContent(content: ModuleContent, artifactName: string): RecipeRunOutput {
  return {
    name: truncateText(artifactName, 200),
    moduleKind: content.kind,
    objectHash: contentHash(content),
    preview: previewOfContent(content),
    rowCount: rowCountOfContent(content),
  };
}

/** Deterministic normalized hash of an emitted content (columns + values). */
export function normalizedContentHash(content: ModuleContent): string {
  if (content.kind === 'csv') {
    return canonicalJsonHash({ kind: 'csv', columns: content.columns, rows: content.rows });
  }
  return contentHash(content);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') {
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind === 'string') return `object(kind=${kind})`;
    const keys = Object.keys(value as Record<string, unknown>);
    return `object(${keys.slice(0, 6).join(',')}${keys.length > 6 ? ',…' : ''})`;
  }
  return typeof value === 'string' ? `string(${value.length} chars)` : typeof value;
}

export { tableToJsonValue };
