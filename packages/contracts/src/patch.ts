/** Draft patch proposals: isolated until a user (or an explicit policy) accepts them. */
import { z } from 'zod';
import {
  ArtifactVersionIdSchema,
  LIMITS,
  ModuleIdSchema,
  PatchIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  TaskIdSchema,
  UtcTimestampSchema,
  ValidationReportIdSchema,
} from './primitives';
import { ModuleContentSchema, ModuleKindSchema } from './content';
import { EvidenceRefSchema } from './refs';
import { JsonValueSchema } from './primitives';

/* ------------------------------ operations ------------------------------ */

export const JsonPatchOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    path: z.string().min(1).max(2048).regex(/^\//, 'JSON pointer must start with /'),
    value: JsonValueSchema,
  }),
  z.object({
    op: z.literal('replace'),
    path: z.string().min(1).max(2048).regex(/^\//, 'JSON pointer must start with /'),
    value: JsonValueSchema,
  }),
  z.object({
    op: z.literal('remove'),
    path: z.string().min(1).max(2048).regex(/^\//, 'JSON pointer must start with /'),
  }),
]);
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;

export const PatchOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replace_module'), content: ModuleContentSchema }),
  z.object({
    kind: z.literal('markdown.replace_section'),
    sectionId: z.string().min(1).max(64),
    title: z.string().min(1).max(200).optional(),
    markdown: z.string().max(200_000),
  }),
  z.object({
    kind: z.literal('markdown.insert_section'),
    afterSectionId: z.string().min(1).max(64).nullable(),
    title: z.string().min(1).max(200),
    markdown: z.string().max(200_000),
    id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
  }),
  z.object({ kind: z.literal('markdown.remove_section'), sectionId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('json.patch'), operations: z.array(JsonPatchOperationSchema).min(1).max(128) }),
  z.object({
    kind: z.literal('csv.replace_rows'),
    columns: z.array(z.record(z.string().max(128), JsonValueSchema)).max(LIMITS.maxCsvColumns),
    rows: z.array(z.array(JsonValueSchema)).max(LIMITS.maxCsvRows),
  }),
]);
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

export const PATCH_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded', 'conflicted'] as const;
export const PatchStatusSchema = z.enum(PATCH_STATUSES);
export type PatchStatus = z.infer<typeof PatchStatusSchema>;

export const ChangeSummarySchema = z.object({
  addedLines: z.number().int().nonnegative().default(0),
  removedLines: z.number().int().nonnegative().default(0),
  changedSections: z.array(z.string().max(200)).max(100).default([]),
  addedSections: z.array(z.string().max(200)).max(100).default([]),
  removedSections: z.array(z.string().max(200)).max(100).default([]),
  affectedRows: z.number().int().nonnegative().default(0),
  note: z.string().max(1000).default(''),
});
export type ChangeSummary = z.infer<typeof ChangeSummarySchema>;

/** A reviewable proposal. It never mutates the artifact's accepted version. */
export const PatchProposalSchema = z.object({
  id: PatchIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  moduleId: ModuleIdSchema,
  moduleKind: ModuleKindSchema,
  baseVersionId: ArtifactVersionIdSchema.nullable(),
  operations: z.array(PatchOperationSchema).min(1).max(LIMITS.maxPatchOperations),
  evidenceRefs: z.array(EvidenceRefSchema).max(256).default([]),
  validationReportId: ValidationReportIdSchema.nullable().default(null),
  candidateHash: Sha256HexSchema,
  candidate: ModuleContentSchema,
  status: PatchStatusSchema,
  description: z.string().max(4000),
  changeSummary: ChangeSummarySchema,
  createdAt: UtcTimestampSchema,
  acceptedVersionId: ArtifactVersionIdSchema.nullable().default(null),
});
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

/* -------------------------------- diff -------------------------------- */

export const DiffEntrySchema = z.object({
  sectionId: z.string().max(64).nullable(),
  title: z.string().max(200),
  change: z.enum(['added', 'removed', 'changed', 'unchanged']),
  beforeExcerpt: z.string().max(4000).nullable(),
  afterExcerpt: z.string().max(4000).nullable(),
  summary: z.string().max(500),
});
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

export const ContentDiffSchema = z.object({
  moduleId: ModuleIdSchema,
  moduleKind: ModuleKindSchema,
  baseVersionId: ArtifactVersionIdSchema.nullable(),
  candidateHash: Sha256HexSchema,
  entries: z.array(DiffEntrySchema).max(1000),
  stats: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
});
export type ContentDiff = z.infer<typeof ContentDiffSchema>;
