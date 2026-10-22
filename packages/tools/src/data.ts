/**
 * Data tools: deterministic CSV/JSON profiling and declarative transforms.
 *
 * `data.transform` only writes NEW content objects through the injected object
 * writer; the original source version is never modified and no arbitrary code or
 * expressions are evaluated (only the registered operator vocabulary).
 */
import {
  LIMITS,
  type DataProfileArgs,
  type DataProfileResult,
  type DataTransformArgs,
  type DataTransformResult,
  type JsonValue,
} from '@ca/contracts';
import { parseCsv, tableFromParsedCsv, tableToCsv } from './csv';
import { ToolRuntimeError, wrapPortError } from './errors';
import { utf8Encode } from './hash';
import { parseBoundedJson, tableFromJsonValue, tableToJsonValue } from './json-data';
import { buildDataProfile } from './profile';
import { resolveDataFormat, readSourceVersion } from './source';
import { truncateText, type TableData } from './table';
import { applyTransformOperations } from './transform';
import type { ToolContext } from './types';

export async function executeDataProfile(ctx: ToolContext, args: DataProfileArgs): Promise<DataProfileResult> {
  const loaded = await readSourceVersion(ctx, args.sourceId, args.version);
  if (loaded.format === 'text') {
    throw new ToolRuntimeError(
      'unsupported_format',
      `source "${loaded.source.name}" is not CSV or JSON; data.profile only supports structured table sources`,
      { details: { mime: loaded.source.mime } },
    );
  }
  return buildDataProfile({
    sourceId: args.sourceId,
    version: args.version,
    format: loaded.format,
    text: loaded.text,
  });
}

/** Parse a source into a normalized table for data.transform. */
export function parseSourceTable(text: string, format: 'csv' | 'json'): { table: TableData; issues: string[] } {
  const issues: string[] = [];
  if (format === 'json') {
    const value = parseBoundedJson(text);
    return { table: tableFromJsonValue(value, { issues }), issues };
  }
  const parsed = parseCsv(text);
  return { table: tableFromParsedCsv(parsed, { lenient: false, issues }), issues };
}

/** Serialize the transform output bytes for the requested format. */
export function serializeTransformedTable(
  table: TableData,
  format: 'csv' | 'json',
): { bytes: Uint8Array; mime: string } {
  if (format === 'csv') {
    return { bytes: utf8Encode(tableToCsv(table)), mime: 'text/csv' };
  }
  return { bytes: utf8Encode(JSON.stringify(tableToJsonValue(table))), mime: 'application/json' };
}

export async function executeDataTransform(
  ctx: ToolContext,
  args: DataTransformArgs,
): Promise<DataTransformResult> {
  const loaded = await readSourceVersion(ctx, args.sourceId, args.version);
  resolveDataFormat(loaded.source, args.format);

  const parsedSource = parseSourceTable(loaded.text, args.format);
  const outcome = applyTransformOperations(parsedSource.table, args.operations);
  const issues = [...parsedSource.issues, ...outcome.issues].slice(0, 200);

  const { bytes, mime } = serializeTransformedTable(outcome.table, args.format);
  if (bytes.length > LIMITS.maxSourceFileBytes) {
    throw new ToolRuntimeError(
      'limit_exceeded',
      `transformed output is ${bytes.length} bytes (limit ${LIMITS.maxSourceFileBytes})`,
    );
  }
  if (issues.some((issue) => issue.length > 500)) {
    // The contract bounds each issue string; the tracker already bounds them,
    // this is a defensive guard against caller-provided issue lists.
    throw new ToolRuntimeError('internal_error', 'transform issue text exceeded 500 characters');
  }

  let stored: { hash: string; sizeBytes: number; mime: string };
  try {
    stored = await ctx.objects.put(bytes, mime);
  } catch (error) {
    throw wrapPortError(error, 'object_write_failed', 'could not write the transformed output object');
  }

  const preview: Array<Record<string, JsonValue>> = outcome.table.rows.slice(0, 20).map((row) => {
    const previewRow: Record<string, JsonValue> = {};
    for (const column of outcome.table.columns) previewRow[column.key] = (row[column.key] ?? null) as JsonValue;
    return previewRow;
  });

  return {
    sourceId: args.sourceId,
    version: args.version,
    format: args.format,
    columns: outcome.table.columns.map((column) => ({ key: column.key, label: column.label })),
    rowCount: outcome.table.rows.length,
    preview,
    objectHash: stored.hash,
    outputName: truncateText(args.outputName, 200),
    issues,
    deterministic: true,
  };
}
