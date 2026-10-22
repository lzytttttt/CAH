/**
 * Source tools: list authorized sources, read locator-scoped excerpts and run
 * keyword search that produces real SourceSpan evidence.
 *
 * All effects go through `ctx.sources` (SourceReaderPort); nothing here touches
 * the file system. Locators are resolved against the exact stored version bytes,
 * and spans persist the sha256 of the exact excerpt that was returned.
 */
import {
  LIMITS,
  SourceSpanIdSchema,
  canonicalJson,
  type SearchHit,
  type SourceId,
  type SourceItem,
  type SourceListItem,
  type SourceListResult,
  type SourceLocator,
  type SourceReadResult,
  type SourceSearchResult,
  type SourceSpan,
  type SourceSpanId,
  type SourceSpanRef,
  type SourceListArgs,
  type SourceReadArgs,
  type SourceSearchArgs,
} from '@ca/contracts';
import { csvRowsRegion, csvRowText, parseCsv, writeCsv } from './csv';
import { ToolRuntimeError, wrapPortError } from './errors';
import { sha256Hex } from './hash';
import { parseBoundedJson } from './json-data';
import { compareText, excerptAround, truncateText } from './table';
import type { ToolContext } from './types';

export type SourceFormat = 'csv' | 'json' | 'text';

const SEARCH_EXCERPT_CHARS = LIMITS.previewExcerptChars;
const MAX_LOCATOR_CHARS = 20_000;
const MAX_SEARCH_CANDIDATE_HITS = 500;

/** Detect the parse format from mime + file name (extension and MIME both checked). */
export function detectSourceFormat(source: Pick<SourceItem, 'name' | 'mime'>): SourceFormat {
  const name = source.name.toLowerCase();
  const mime = source.mime.toLowerCase();
  if (mime.includes('csv') || name.endsWith('.csv')) return 'csv';
  if (mime.includes('json') || name.endsWith('.json')) return 'json';
  return 'text';
}

/** Format for a data tool that declares its own format; mismatch is an error. */
export function resolveDataFormat(source: Pick<SourceItem, 'name' | 'mime'>, requested: 'csv' | 'json'): 'csv' | 'json' {
  const detected = detectSourceFormat(source);
  if (detected !== requested) {
    throw new ToolRuntimeError(
      'unsupported_format',
      `source "${source.name}" is ${detected === 'text' ? 'plain text' : detected}, not ${requested}; refusing to reinterpret it`,
      { details: { requested, detected } },
    );
  }
  return requested;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Decode stored source bytes as UTF-8 (BOM stripped by TextDecoder); reject others. */
export function decodeSourceText(bytes: Uint8Array, label = 'source'): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new ToolRuntimeError('unsupported_encoding', `${label} is not valid UTF-8 text`);
  }
}

/** Split text into physical lines and report the line count. */
export function splitSourceLines(text: string): { lines: string[]; lineCount: number } {
  if (text.length === 0) return { lines: [], lineCount: 0 };
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { lines, lineCount: lines.length };
}

/* ------------------------------ locators ------------------------------ */

/** Decode an RFC 6901 JSON pointer into reference tokens. */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new ToolRuntimeError('locator_invalid', `json pointer must be empty or start with "/": ${pointer}`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((token) => {
      if (/~(?:[^01]|$)/.test(token)) {
        throw new ToolRuntimeError('locator_invalid', `invalid JSON pointer escape in token: ${token}`);
      }
      return token.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;

function evaluateJsonPointer(root: unknown, tokens: readonly string[]): unknown {
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_PATTERN.test(token)) {
        throw new ToolRuntimeError('json_pointer_not_found', `array index is not valid: ${token}`);
      }
      const index = Number(token);
      if (index >= current.length) {
        throw new ToolRuntimeError('json_pointer_not_found', `array index ${index} is out of range`);
      }
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, token)) {
        throw new ToolRuntimeError('json_pointer_not_found', `json pointer segment not found: ${token}`);
      }
      current = record[token];
      continue;
    }
    throw new ToolRuntimeError('json_pointer_not_found', `cannot descend into a scalar at segment: ${token}`);
  }
  return current;
}

export interface LocatorRegion {
  locator: SourceLocator;
  region: string;
}

/**
 * Resolve a locator to its full (untruncated) region text.
 * Throws ToolRuntimeError with locator_* codes for invalid/out-of-range locators.
 */
export function resolveLocatorRegion(input: {
  text: string;
  format: SourceFormat;
  locator: SourceLocator;
}): LocatorRegion {
  const { text, format, locator } = input;
  switch (locator.kind) {
    case 'text_lines': {
      if (locator.endLine < locator.startLine) {
        throw new ToolRuntimeError(
          'locator_invalid',
          `text_lines locator endLine ${locator.endLine} is before startLine ${locator.startLine}`,
        );
      }
      const { lines, lineCount } = splitSourceLines(text);
      if (lineCount === 0) {
        if (locator.startLine === 1 && locator.endLine === 1) {
          return { locator: { kind: 'text_lines', startLine: 1, endLine: 1 }, region: '' };
        }
        throw new ToolRuntimeError('locator_out_of_range', 'source has no lines');
      }
      if (locator.startLine > lineCount) {
        throw new ToolRuntimeError(
          'locator_out_of_range',
          `startLine ${locator.startLine} is out of range (source has ${lineCount} line(s))`,
          { details: { startLine: locator.startLine, lineCount } },
        );
      }
      const end = Math.min(locator.endLine, lineCount);
      return {
        locator: { kind: 'text_lines', startLine: locator.startLine, endLine: end },
        region: lines.slice(locator.startLine - 1, end).join('\n'),
      };
    }
    case 'csv_rows': {
      if (format !== 'csv') {
        throw new ToolRuntimeError('locator_invalid', 'csv_rows locator requires a CSV source');
      }
      const parsed = parseCsv(text);
      const unique: number[] = [];
      for (const rowNumber of locator.rowNumbers) {
        if (!unique.includes(rowNumber)) unique.push(rowNumber);
      }
      let region: string;
      try {
        region = csvRowsRegion(parsed, unique);
      } catch (error) {
        throw wrapPortError(error, 'locator_out_of_range', 'csv_rows locator is out of range');
      }
      return { locator: { kind: 'csv_rows', rowNumbers: unique.slice(0, 1000) }, region };
    }
    case 'csv_key': {
      if (format !== 'csv') {
        throw new ToolRuntimeError('locator_invalid', 'csv_key locator requires a CSV source');
      }
      const parsed = parseCsv(text);
      const columnIndex = parsed.header.indexOf(locator.primaryKeyColumn);
      if (columnIndex < 0) {
        throw new ToolRuntimeError(
          'key_not_found',
          `primary key column "${locator.primaryKeyColumn}" does not exist in the CSV header`,
        );
      }
      const wanted = locator.primaryKeyValue;
      let matches = parsed.rows.filter((row) => (row[columnIndex] ?? '') === wanted);
      if (matches.length === 0) {
        matches = parsed.rows.filter((row) => (row[columnIndex] ?? '').trim() === wanted.trim());
      }
      if (matches.length === 0) {
        throw new ToolRuntimeError(
          'key_not_found',
          `no CSV row has ${locator.primaryKeyColumn} = "${truncateText(wanted, 100)}"`,
        );
      }
      return { locator, region: writeCsv(parsed.header, matches, { eol: parsed.eol }) };
    }
    case 'json_pointer': {
      if (format !== 'json') {
        throw new ToolRuntimeError('locator_invalid', 'json_pointer locator requires a JSON source');
      }
      const parsed = parseBoundedJson(text);
      const target = evaluateJsonPointer(parsed, parseJsonPointer(locator.pointer));
      return { locator, region: JSON.stringify(target, null, 2) };
    }
  }
}

export interface LocatorContent {
  locator: SourceLocator;
  content: string;
  totalChars: number;
  truncated: boolean;
}

/**
 * Resolve a locator and bound the returned content to `maxChars`.
 *
 * When no locator is given, the locator addresses the whole document (text
 * lines) and the content is a bounded prefix of the raw text. `totalChars` is
 * the size of the addressed region before truncation.
 */
export function resolveLocatorContent(input: {
  text: string;
  format: SourceFormat;
  locator: SourceLocator | undefined;
  maxChars: number;
}): LocatorContent {
  const maxChars = Math.max(1, Math.min(input.maxChars, MAX_LOCATOR_CHARS));
  if (!input.locator) {
    const { lineCount } = splitSourceLines(input.text);
    const content = truncateText(input.text, maxChars);
    return {
      locator: { kind: 'text_lines', startLine: 1, endLine: Math.max(1, lineCount) },
      content,
      totalChars: input.text.length,
      truncated: content.length < input.text.length,
    };
  }
  const resolved = resolveLocatorRegion({ text: input.text, format: input.format, locator: input.locator });
  const content = truncateText(resolved.region, maxChars);
  return {
    locator: resolved.locator,
    content,
    totalChars: resolved.region.length,
    truncated: content.length < resolved.region.length,
  };
}

/* ------------------------------ span ids ------------------------------ */

/**
 * Deterministic SourceSpanId for evidence refs. The id is derived from the
 * source version + locator + quote hash so a repeated search is idempotent and
 * the harness can rebuild a SourceSpanRef from a SearchHit without a lookup.
 */
export function sourceSpanIdFor(
  sourceId: SourceId,
  version: number,
  locator: SourceLocator,
  quoteHash: string,
): SourceSpanId {
  const digest = sha256Hex(canonicalJson({ kind: 'source_span.v1', sourceId, version, locator, quoteHash }));
  const hex = digest.slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return SourceSpanIdSchema.parse(uuid);
}

/** Build a typed evidence reference from a persisted search hit. */
export function spanRefFromHit(hit: SearchHit): SourceSpanRef {
  return {
    spanId: hit.spanId,
    sourceId: hit.sourceId,
    version: hit.version,
    locator: hit.locator,
    quoteHash: hit.quoteHash,
    excerpt: hit.excerpt,
  };
}

/* --------------------------- source version I/O --------------------------- */

export interface LoadedSource {
  source: SourceItem;
  text: string;
  format: SourceFormat;
}

/** Load one exact source version through the port, validating task ownership. */
export async function readSourceVersion(
  ctx: ToolContext,
  sourceId: SourceId,
  version: number,
): Promise<LoadedSource> {
  let loaded: { source: SourceItem; bytes: Uint8Array } | null;
  try {
    loaded = await ctx.sources.getSource(ctx.taskId, sourceId, version);
  } catch (error) {
    throw wrapPortError(error, 'source_unavailable', `could not read source ${sourceId} v${version}`);
  }
  if (!loaded) {
    throw new ToolRuntimeError('source_not_found', `source ${sourceId} version ${version} was not found`, {
      details: { sourceId, version },
    });
  }
  if (loaded.source.taskId !== ctx.taskId) {
    throw new ToolRuntimeError('source_not_found', 'source belongs to a different task');
  }
  if (loaded.source.availability !== 'available') {
    throw new ToolRuntimeError(
      'source_unavailable',
      `source "${loaded.source.name}" is ${loaded.source.availability} and cannot be read`,
      { details: { availability: loaded.source.availability } },
    );
  }
  if (loaded.source.version !== version) {
    throw new ToolRuntimeError(
      'source_unavailable',
      `requested source version ${version} but the port returned version ${loaded.source.version}`,
    );
  }
  if (loaded.bytes.length > LIMITS.maxSourceFileBytes) {
    throw new ToolRuntimeError(
      'limit_exceeded',
      `source "${loaded.source.name}" is ${loaded.bytes.length} bytes (limit ${LIMITS.maxSourceFileBytes})`,
    );
  }
  return {
    source: loaded.source,
    text: decodeSourceText(loaded.bytes, loaded.source.name),
    format: detectSourceFormat(loaded.source),
  };
}

/* ------------------------------- tools ------------------------------- */

export async function executeSourceList(ctx: ToolContext, args: SourceListArgs): Promise<SourceListResult> {
  let sources: SourceItem[];
  try {
    sources = await ctx.sources.listSources(ctx.taskId);
  } catch (error) {
    throw wrapPortError(error, 'source_unavailable', 'could not list task sources');
  }
  const items: SourceListItem[] = [];
  for (const source of sources) {
    if (source.taskId !== ctx.taskId) continue;
    if (!args.includeUnavailable && source.availability !== 'available') continue;
    items.push({
      sourceId: source.id,
      name: source.name,
      mime: source.mime,
      version: source.version,
      sizeBytes: source.sizeBytes,
      availability: source.availability,
      origin: source.origin,
      trustLevel: source.trustLevel,
    });
  }
  items.sort((a, b) => compareText(a.name, b.name) || compareText(a.sourceId, b.sourceId));
  return { items: items.slice(0, LIMITS.maxSourcesPerTask) };
}

export async function executeSourceRead(ctx: ToolContext, args: SourceReadArgs): Promise<SourceReadResult> {
  const loaded = await readSourceVersion(ctx, args.sourceId, args.version);
  const resolved = resolveLocatorContent({
    text: loaded.text,
    format: loaded.format,
    locator: args.locator,
    maxChars: args.maxChars,
  });
  return {
    sourceId: args.sourceId,
    version: args.version,
    locator: resolved.locator,
    content: resolved.content,
    truncated: resolved.truncated,
    totalChars: resolved.totalChars,
    trust: 'untrusted_content',
  };
}

interface ScoredHit {
  hit: SearchHit;
  order: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function makeHit(
  sourceId: SourceId,
  version: number,
  locator: SourceLocator,
  excerpt: string,
  score: number,
): SearchHit {
  const quoteHash = sha256Hex(excerpt);
  return {
    spanId: sourceSpanIdFor(sourceId, version, locator, quoteHash),
    sourceId,
    version,
    locator,
    excerpt,
    quoteHash,
    score,
  };
}

function collectTextHits(
  source: SourceItem,
  text: string,
  lowerQuery: string,
  sink: ScoredHit[],
): void {
  const { lines, lineCount } = splitSourceLines(text);
  for (let index = 0; index < lineCount; index += 1) {
    if (sink.length >= MAX_SEARCH_CANDIDATE_HITS) return;
    const line = lines[index]!;
    const occurrences = countOccurrences(line.toLowerCase(), lowerQuery);
    if (occurrences === 0) continue;
    const matchIndex = line.toLowerCase().indexOf(lowerQuery);
    const excerpt = excerptAround(line, matchIndex < 0 ? 0 : matchIndex, SEARCH_EXCERPT_CHARS);
    const locator: SourceLocator = { kind: 'text_lines', startLine: index + 1, endLine: index + 1 };
    sink.push({ hit: makeHit(source.id, source.version, locator, excerpt, occurrences), order: index + 1 });
  }
}

function collectCsvHits(source: SourceItem, text: string, lowerQuery: string, sink: ScoredHit[]): void {
  const parsed = parseCsv(text);
  // The header line is searchable too: field names are often what a user looks
  // for. It is addressed with a text_lines locator (raw physical line 1).
  const { lines } = splitSourceLines(text);
  const headerLine = lines[0] ?? '';
  const headerOccurrences = countOccurrences(headerLine.toLowerCase(), lowerQuery);
  if (headerOccurrences > 0 && sink.length < MAX_SEARCH_CANDIDATE_HITS) {
    const excerpt = excerptAround(headerLine, headerLine.toLowerCase().indexOf(lowerQuery), SEARCH_EXCERPT_CHARS);
    const locator: SourceLocator = { kind: 'text_lines', startLine: 1, endLine: 1 };
    sink.push({ hit: makeHit(source.id, source.version, locator, excerpt, headerOccurrences), order: 0 });
  }
  for (let index = 0; index < parsed.rows.length; index += 1) {
    if (sink.length >= MAX_SEARCH_CANDIDATE_HITS) return;
    const row = parsed.rows[index]!;
    let occurrences = 0;
    for (const cell of row) occurrences += countOccurrences(cell.toLowerCase(), lowerQuery);
    if (occurrences === 0) continue;
    const excerpt = truncateText(csvRowText(row), SEARCH_EXCERPT_CHARS);
    const locator: SourceLocator = { kind: 'csv_rows', rowNumbers: [index + 1] };
    sink.push({ hit: makeHit(source.id, source.version, locator, excerpt, occurrences), order: index + 1 });
  }
}

export async function executeSourceSearch(ctx: ToolContext, args: SourceSearchArgs): Promise<SourceSearchResult> {
  const query = args.query.trim();
  if (query.length === 0) {
    throw new ToolRuntimeError('empty_query', 'search query is empty');
  }
  if (/[\r\n]/.test(query)) {
    throw new ToolRuntimeError('invalid_arguments', 'search query must be a single line');
  }
  const lowerQuery = query.toLowerCase();
  const limit = args.limit ?? 5;

  let latest: Array<{ source: SourceItem; bytes: Uint8Array }>;
  try {
    latest = await ctx.sources.listLatestContents(ctx.taskId);
  } catch (error) {
    throw wrapPortError(error, 'source_unavailable', 'could not list latest source contents');
  }
  const byId = new Map<SourceId, { source: SourceItem; bytes: Uint8Array }>();
  for (const entry of latest) {
    if (entry.source.taskId !== ctx.taskId) continue;
    byId.set(entry.source.id, entry);
  }

  let candidates: Array<{ source: SourceItem; bytes: Uint8Array }>;
  if (args.sourceIds && args.sourceIds.length > 0) {
    candidates = [];
    for (const sourceId of args.sourceIds) {
      const entry = byId.get(sourceId);
      if (!entry) {
        throw new ToolRuntimeError('source_not_found', `source ${sourceId} is not part of this task`, {
          details: { sourceId },
        });
      }
      candidates.push(entry);
    }
  } else {
    candidates = [...byId.values()];
  }
  candidates = candidates
    .filter((entry) => entry.source.availability === 'available')
    .sort((a, b) => compareText(a.source.id, b.source.id));

  const hits: ScoredHit[] = [];
  const searchedSources: SourceId[] = [];
  for (const entry of candidates) {
    if (hits.length >= MAX_SEARCH_CANDIDATE_HITS) break;
    const text = decodeSourceText(entry.bytes, entry.source.name);
    searchedSources.push(entry.source.id);
    if (detectSourceFormat(entry.source) === 'csv') collectCsvHits(entry.source, text, lowerQuery, hits);
    else collectTextHits(entry.source, text, lowerQuery, hits);
  }

  hits.sort(
    (a, b) =>
      b.hit.score - a.hit.score ||
      compareText(a.hit.sourceId, b.hit.sourceId) ||
      a.order - b.order,
  );
  const top = hits.slice(0, Math.max(1, Math.min(limit, 20)));
  const createdAt = ctx.now();

  for (const scored of top) {
    const span: SourceSpan = {
      id: scored.hit.spanId,
      sourceId: scored.hit.sourceId,
      version: scored.hit.version,
      locator: scored.hit.locator,
      quoteHash: scored.hit.quoteHash,
      excerpt: scored.hit.excerpt,
      createdAt,
    };
    try {
      await ctx.sources.saveSpan(span);
    } catch (error) {
      throw wrapPortError(error, 'source_unavailable', 'could not persist source span evidence');
    }
  }

  return {
    query,
    hits: top.map((scored) => scored.hit),
    searchedSources,
  };
}
