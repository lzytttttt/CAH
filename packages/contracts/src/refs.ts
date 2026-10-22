/** Evidence and input references. Every factual claim must point at one of these. */
import { z } from 'zod';
import {
  LIMITS,
  ModuleIdSchema,
  Sha256HexSchema,
  SourceIdSchema,
  SourceSpanIdSchema,
  ToolCallIdSchema,
  ArtifactVersionIdSchema,
} from './primitives';

/** A specific immutable version of a task source. */
export const SourceRefSchema = z.object({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** A locator inside a source version. */
export const SourceLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text_lines'), startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
  z.object({ kind: z.literal('csv_rows'), rowNumbers: z.array(z.number().int().positive()).min(1).max(1000) }),
  z.object({ kind: z.literal('csv_key'), primaryKeyColumn: z.string().min(1), primaryKeyValue: z.string().max(LIMITS.maxCsvFieldChars) }),
  z.object({ kind: z.literal('json_pointer'), pointer: z.string().max(2048) }),
]);
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

/** Persisted span: locator plus the hash of the exact quoted content. */
export const SourceSpanRefSchema = z.object({
  spanId: SourceSpanIdSchema,
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  locator: SourceLocatorSchema,
  quoteHash: Sha256HexSchema,
  excerpt: z.string().max(LIMITS.previewExcerptChars),
});
export type SourceSpanRef = z.infer<typeof SourceSpanRefSchema>;

export const ToolResultRefSchema = z.object({
  toolCallId: ToolCallIdSchema,
  summary: z.string().max(500),
});
export type ToolResultRef = z.infer<typeof ToolResultRefSchema>;

/**
 * Evidence attached to a plan, patch or validation check.
 * A user assumption is the only non-observed evidence type and must be explicit.
 */
export const EvidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source_span'), span: SourceSpanRefSchema }),
  z.object({
    kind: z.literal('artifact_version'),
    versionId: ArtifactVersionIdSchema,
    moduleId: ModuleIdSchema,
  }),
  z.object({
    kind: z.literal('user_assumption'),
    assumptionId: z.string().min(1).max(64),
    text: z.string().min(1).max(1000),
  }),
  z.object({ kind: z.literal('tool_result'), toolResult: ToolResultRefSchema }),
]);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Input bound to a run step: either a source version or an accepted artifact version. */
export const InputRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), source: SourceRefSchema }),
  z.object({
    kind: z.literal('artifact_version'),
    versionId: ArtifactVersionIdSchema,
    moduleId: ModuleIdSchema,
  }),
]);
export type InputRef = z.infer<typeof InputRefSchema>;

export const ConstraintRefSchema = z.object({
  constraintId: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  hard: z.boolean(),
});
export type ConstraintRef = z.infer<typeof ConstraintRefSchema>;

export const SectionRefSchema = z.object({
  moduleId: ModuleIdSchema,
  sectionId: z.string().min(1).max(64),
});
export type SectionRef = z.infer<typeof SectionRefSchema>;
