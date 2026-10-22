/**
 * Pure patch application and diff helpers, shared by the tool runtime, the
 * artifact service and the review UI. No I/O, no Node.js APIs.
 */
import type {
  ContentDiff,
  DiffEntry,
  JsonPatchOperation,
  PatchOperation,
} from './patch';
import type { CsvContent, CsvRow, MarkdownContent, MarkdownSection, ModuleContent } from './content';
import { emptyContentForKind, type ModuleKind } from './content';

export class PatchApplyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PatchApplyError';
    this.code = code;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Apply a proposal's operations on top of a base module content. */
export function applyPatchOperations(
  base: ModuleContent | null,
  moduleKind: ModuleKind,
  operations: readonly PatchOperation[],
): ModuleContent {
  if (operations.length === 0) throw new PatchApplyError('empty_patch', 'patch has no operations');
  let current: ModuleContent = base ?? emptyContentForKind(moduleKind);
  if (current.kind !== moduleKind) {
    throw new PatchApplyError('module_kind_mismatch', `base content kind ${current.kind} does not match module kind ${moduleKind}`);
  }
  for (const operation of operations) {
    current = applyOne(current, operation);
  }
  return current;
}

function applyOne(base: ModuleContent, operation: PatchOperation): ModuleContent {
  switch (operation.kind) {
    case 'replace_module':
      if (operation.content.kind !== base.kind) {
        throw new PatchApplyError('module_kind_mismatch', `replace_module content kind ${operation.content.kind} does not match ${base.kind}`);
      }
      return operation.content;
    case 'markdown.replace_section': {
      const doc = requireMarkdown(base);
      const sections = doc.sections.map((section) =>
        section.id === operation.sectionId
          ? { ...section, markdown: operation.markdown, ...(operation.title ? { title: operation.title } : {}) }
          : section,
      );
      if (!sections.some((section) => section.id === operation.sectionId)) {
        throw new PatchApplyError('section_not_found', `markdown section not found: ${operation.sectionId}`);
      }
      return { ...doc, sections };
    }
    case 'markdown.insert_section': {
      const doc = requireMarkdown(base);
      if (doc.sections.length >= 200) throw new PatchApplyError('too_many_sections', 'markdown section limit reached');
      const id = operation.id ?? uniqueSectionId(doc.sections, slugify(operation.title));
      if (doc.sections.some((section) => section.id === id)) {
        throw new PatchApplyError('section_exists', `markdown section id already exists: ${id}`);
      }
      const next: MarkdownSection = { id, title: operation.title, markdown: operation.markdown };
      const sections = [...doc.sections];
      if (operation.afterSectionId == null) {
        sections.push(next);
      } else {
        const index = sections.findIndex((section) => section.id === operation.afterSectionId);
        if (index < 0) throw new PatchApplyError('section_not_found', `cannot insert after missing section: ${operation.afterSectionId}`);
        sections.splice(index + 1, 0, next);
      }
      return { ...doc, sections };
    }
    case 'markdown.remove_section': {
      const doc = requireMarkdown(base);
      const sections = doc.sections.filter((section) => section.id !== operation.sectionId);
      if (sections.length === doc.sections.length) {
        throw new PatchApplyError('section_not_found', `markdown section not found: ${operation.sectionId}`);
      }
      return { ...doc, sections };
    }
    case 'json.patch': {
      const doc = base.kind === 'json' ? base : null;
      if (!doc) throw new PatchApplyError('module_kind_mismatch', 'json.patch requires a json module');
      let value = doc.value;
      for (const op of operation.operations) value = applyJsonPatch(value, op) as typeof value;
      return { kind: 'json', value };
    }
    case 'csv.replace_rows': {
      if (base.kind !== 'csv') throw new PatchApplyError('module_kind_mismatch', 'csv.replace_rows requires a csv module');
      if (operation.columns.length !== base.columns.length) {
        throw new PatchApplyError('column_mismatch', 'csv.replace_rows must keep the declared column set; use replace_module to change columns');
      }
      const keys = base.columns.map((c) => c.key);
      const rows: CsvRow[] = operation.rows.map((cells) => {
        if (cells.length !== keys.length) {
          throw new PatchApplyError('row_arity_mismatch', `csv row has ${cells.length} cells but ${keys.length} columns are declared`);
        }
        const row: CsvRow = {};
        keys.forEach((key, i) => {
          const cell = cells[i];
          if (typeof cell === 'object' && cell !== null) {
            throw new PatchApplyError('cell_not_scalar', `csv cell for column ${key} must be a scalar`);
          }
          row[key] = cell ?? null;
        });
        return row;
      });
      return { ...base, rows };
    }
  }
}

function requireMarkdown(content: ModuleContent): MarkdownContent {
  if (content.kind !== 'markdown') throw new PatchApplyError('module_kind_mismatch', 'markdown operation requires a markdown module');
  return content;
}

export function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (ascii.length >= 2) return ascii;
  // Non-Latin titles: deterministic short hash of the raw title.
  return `sec-${hash32(title).toString(16).padStart(8, '0')}`;
}

function uniqueSectionId(sections: readonly MarkdownSection[], baseId: string): string {
  const used = new Set(sections.map((s) => s.id));
  if (!used.has(baseId)) return baseId;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${baseId}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new PatchApplyError('section_id_exhausted', 'could not allocate a unique section id');
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ----------------------------- JSON Patch ----------------------------- */

function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new PatchApplyError('invalid_pointer', `invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) throw new PatchApplyError('forbidden_pointer', `forbidden JSON pointer segment: ${key}`);
}

type JsonContainer = Record<string, unknown> | unknown[];

function getParent(root: unknown, segments: readonly string[], createMissing: boolean): { parent: JsonContainer; key: string } | null {
  if (segments.length === 0) return null;
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    assertSafeKey(segment);
    if (current === null || typeof current !== 'object') return null;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
    } else {
      const record = current as Record<string, unknown>;
      if (!(segment in record)) {
        if (!createMissing) return null;
        record[segment] = {};
      }
      current = record[segment];
    }
  }
  if (current === null || typeof current !== 'object') return null;
  const last = segments[segments.length - 1]!;
  assertSafeKey(last);
  return { parent: current as JsonContainer, key: last };
}

function applyJsonPatch(root: unknown, op: JsonPatchOperation): unknown {
  const segments = parseJsonPointer(op.path);
  if (segments.length === 0) {
    // Replacing the root value is allowed only for `replace` on a JSON module.
    if (op.op === 'replace') return op.value;
    throw new PatchApplyError('invalid_pointer', 'root pointer only supports replace');
  }
  const located = getParent(root, segments, op.op === 'add');
  if (!located) throw new PatchApplyError('path_not_found', `JSON pointer does not resolve: ${op.path}`);
  const { parent, key } = located;
  if (Array.isArray(parent)) {
    if (key === '-') {
      if (op.op !== 'add') throw new PatchApplyError('path_not_found', 'array "-" only supports add');
      parent.push(op.value);
      return root;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) throw new PatchApplyError('invalid_pointer', `invalid array index: ${key}`);
    if (op.op === 'add') {
      if (index > parent.length) throw new PatchApplyError('path_not_found', `array index out of bounds: ${key}`);
      parent.splice(index, 0, op.value);
    } else if (op.op === 'replace') {
      if (index >= parent.length) throw new PatchApplyError('path_not_found', `array index out of bounds: ${key}`);
      parent[index] = op.value;
    } else {
      if (index >= parent.length) throw new PatchApplyError('path_not_found', `array index out of bounds: ${key}`);
      parent.splice(index, 1);
    }
    return root;
  }
  const record = parent as Record<string, unknown>;
  if (op.op === 'remove') {
    if (!(key in record)) throw new PatchApplyError('path_not_found', `path not found: ${op.path}`);
    delete record[key];
    return root;
  }
  if (op.op === 'replace' && !(key in record)) {
    throw new PatchApplyError('path_not_found', `path not found: ${op.path}`);
  }
  record[key] = op.value;
  return root;
}

/* -------------------------------- diff -------------------------------- */

function excerpt(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function jsonPreview(value: unknown): string {
  try {
    return excerpt(JSON.stringify(value) ?? 'null', 500);
  } catch {
    return '<unserializable>';
  }
}

function diffCsv(base: CsvContent, next: CsvContent): DiffEntry[] {
  const baseRows = base.rows.map((row) => JSON.stringify(row)).join('\n');
  const nextRows = next.rows.map((row) => JSON.stringify(row)).join('\n');
  const changed = baseRows !== nextRows;
  return [
    {
      sectionId: null,
      title: '表格数据',
      change: changed ? 'changed' : 'unchanged',
      beforeExcerpt: excerpt(`${base.rows.length} 行 × ${base.columns.length} 列\n${baseRows}`, 800),
      afterExcerpt: excerpt(`${next.rows.length} 行 × ${next.columns.length} 列\n${nextRows}`, 800),
      summary:
        `${base.rows.length} 行 → ${next.rows.length} 行，` +
        `${base.columns.length} 列 → ${next.columns.length} 列` +
        (changed ? '（数据有变化）' : '（数据无变化）'),
    },
  ];
}

/** Compute a review-oriented diff between the accepted base and a candidate. */
export function diffModuleContent(
  moduleId: string,
  moduleKind: ModuleKind,
  base: ModuleContent | null,
  next: ModuleContent,
  metadata: { baseVersionId: string | null; candidateHash: string },
): ContentDiff {
  const entries: DiffEntry[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  if (!base) {
    if (moduleKind === 'markdown' && next.kind === 'markdown') {
      for (const section of next.sections) {
        entries.push({
          sectionId: section.id,
          title: section.title,
          change: 'added',
          beforeExcerpt: null,
          afterExcerpt: excerpt(section.markdown),
          summary: `新增章节（${section.markdown.length} 字符）`,
        });
        added += 1;
      }
    } else if (moduleKind === 'csv' && next.kind === 'csv') {
      entries.push(...diffCsv({ kind: 'csv', columns: next.columns, rows: [] }, next));
      added += 1;
    } else if (moduleKind === 'json' && next.kind === 'json') {
      entries.push({
        sectionId: null,
        title: 'JSON 内容',
        change: 'added',
        beforeExcerpt: null,
        afterExcerpt: jsonPreview(next.value),
        summary: '新建 JSON 内容',
      });
      added += 1;
    }
  } else if (base.kind === 'markdown' && next.kind === 'markdown') {
    const baseById = new Map(base.sections.map((s) => [s.id, s]));
    const nextById = new Map(next.sections.map((s) => [s.id, s]));
    for (const section of next.sections) {
      const previous = baseById.get(section.id);
      if (!previous) {
        added += 1;
        entries.push({
          sectionId: section.id,
          title: section.title,
          change: 'added',
          beforeExcerpt: null,
          afterExcerpt: excerpt(section.markdown),
          summary: '新增章节',
        });
      } else if (previous.title !== section.title || previous.markdown !== section.markdown) {
        changed += 1;
        entries.push({
          sectionId: section.id,
          title: section.title,
          change: 'changed',
          beforeExcerpt: excerpt(previous.markdown),
          afterExcerpt: excerpt(section.markdown),
          summary: previous.title !== section.title ? '标题与内容变更' : '内容变更',
        });
      } else {
        unchanged += 1;
        entries.push({
          sectionId: section.id,
          title: section.title,
          change: 'unchanged',
          beforeExcerpt: null,
          afterExcerpt: null,
          summary: '未变',
        });
      }
    }
    for (const previous of base.sections) {
      if (!nextById.has(previous.id)) {
        removed += 1;
        entries.push({
          sectionId: previous.id,
          title: previous.title,
          change: 'removed',
          beforeExcerpt: excerpt(previous.markdown),
          afterExcerpt: null,
          summary: '删除章节',
        });
      }
    }
  } else if (base.kind === 'csv' && next.kind === 'csv') {
    const csvEntries = diffCsv(base, next);
    entries.push(...csvEntries);
    if (csvEntries[0]!.change === 'changed') changed += 1;
    else unchanged += 1;
  } else if (base.kind === 'json' && next.kind === 'json') {
    const same = JSON.stringify(base.value) === JSON.stringify(next.value);
    if (same) unchanged += 1;
    else changed += 1;
    entries.push({
      sectionId: null,
      title: 'JSON 内容',
      change: same ? 'unchanged' : 'changed',
      beforeExcerpt: same ? null : jsonPreview(base.value),
      afterExcerpt: same ? null : jsonPreview(next.value),
      summary: same ? '未变' : 'JSON 结构或值发生变化',
    });
  } else {
    // Kind changed: represent as a full replacement.
    entries.push({
      sectionId: null,
      title: '模块类型变化',
      change: 'changed',
      beforeExcerpt: excerpt(`kind: ${base.kind}`),
      afterExcerpt: excerpt(`kind: ${next.kind}`),
      summary: '模块内容类型发生变化',
    });
    changed += 1;
  }

  return {
    moduleId: moduleId as never,
    moduleKind,
    baseVersionId: metadata.baseVersionId as never,
    candidateHash: metadata.candidateHash as never,
    entries,
    stats: { added, removed, changed, unchanged },
  };
}
