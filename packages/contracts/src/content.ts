/** Artifact module content: markdown documents, bounded JSON and CSV tables. */
import { z } from 'zod';
import { JsonValueSchema, LIMITS } from './primitives';

/** Stable section id: lowercase slug, unique inside a markdown module. */
export const SectionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'section id must be a lowercase slug');

export const MarkdownSectionSchema = z.object({
  id: SectionIdSchema,
  title: z.string().min(1).max(200),
  markdown: z.string().max(200_000),
});
export type MarkdownSection = z.infer<typeof MarkdownSectionSchema>;

export const MarkdownContentSchema = z.object({
  kind: z.literal('markdown'),
  sections: z.array(MarkdownSectionSchema).max(LIMITS.maxMarkdownSections),
});
export type MarkdownContent = z.infer<typeof MarkdownContentSchema>;

export const CsvCellValueSchema = z.union([z.string().max(LIMITS.maxCsvFieldChars), z.number(), z.boolean(), z.null()]);
export type CsvCellValue = z.infer<typeof CsvCellValueSchema>;

export const CsvColumnSchema = z.object({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  type: z.enum(['string', 'number', 'date', 'boolean']),
  required: z.boolean().default(false),
  description: z.string().max(500).optional(),
});
export type CsvColumn = z.infer<typeof CsvColumnSchema>;

export const CsvRowSchema = z.record(z.string().max(128), CsvCellValueSchema);
export type CsvRow = z.infer<typeof CsvRowSchema>;

export const CsvContentSchema = z.object({
  kind: z.literal('csv'),
  columns: z.array(CsvColumnSchema).min(1).max(LIMITS.maxCsvColumns),
  rows: z.array(CsvRowSchema).max(LIMITS.maxCsvRows),
});
export type CsvContent = z.infer<typeof CsvContentSchema>;

export const JsonContentSchema = z.object({
  kind: z.literal('json'),
  value: JsonValueSchema,
});
export type JsonContent = z.infer<typeof JsonContentSchema>;

export const ModuleContentSchema = z.discriminatedUnion('kind', [
  MarkdownContentSchema,
  JsonContentSchema,
  CsvContentSchema,
]);
export type ModuleContent = z.infer<typeof ModuleContentSchema>;

export const ModuleKindSchema = z.enum(['markdown', 'json', 'csv']);
export type ModuleKind = z.infer<typeof ModuleKindSchema>;

export const MODULE_KIND_CONTENT_KIND: Readonly<Record<ModuleKind, ModuleContent['kind']>> = {
  markdown: 'markdown',
  json: 'json',
  csv: 'csv',
};

export function emptyContentForKind(kind: ModuleKind): ModuleContent {
  switch (kind) {
    case 'markdown':
      return { kind: 'markdown', sections: [] };
    case 'json':
      return { kind: 'json', value: null };
    case 'csv':
      return { kind: 'csv', columns: [], rows: [] };
  }
}

/** A bounded, human-readable summary of a module content for projections/diffs. */
export function summarizeModuleContent(content: ModuleContent, maxChars = 400): string {
  switch (content.kind) {
    case 'markdown': {
      const total = content.sections.reduce((n, s) => n + s.markdown.length, 0);
      const titles = content.sections.map((s) => s.title).join(' / ');
      const head = titles.length ? `章节：${titles}` : '空文档';
      return bound(`${head}（${content.sections.length} 节，${total} 字符）`, maxChars);
    }
    case 'json':
      return bound(`JSON 内容：${safeJsonPreview(content.value, maxChars)}`, maxChars);
    case 'csv': {
      const cols = content.columns.map((c) => c.label || c.key).join(', ');
      return bound(`${content.rows.length} 行 × ${content.columns.length} 列（${cols}）`, maxChars);
    }
  }
}

function safeJsonPreview(value: unknown, maxChars: number): string {
  try {
    return bound(JSON.stringify(value), Math.max(16, maxChars - 32));
  } catch {
    return '<unserializable>';
  }
}

function bound(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
