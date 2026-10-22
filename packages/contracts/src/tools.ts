/** Tool registry contracts: parameters, policies and normalized results. */
import { z } from 'zod';
import {
  JsonObjectSchema,
  JsonValueSchema,
  LIMITS,
  ModuleIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  SourceIdSchema,
  StepIdSchema,
  ToolCallIdSchema,
  UtcTimestampSchema,
  ArtifactVersionIdSchema,
  ValidationReportIdSchema,
} from './primitives';
import { SourceLocatorSchema } from './refs';
import { ModuleContentSchema } from './content';
import { PatchOperationSchema, PatchProposalSchema } from './patch';
import { ValidationReportSchema } from './validation';

export const TOOL_IDS = [
  'source.list',
  'source.read',
  'source.search',
  'data.profile',
  'data.transform',
  'artifact.read',
  'artifact.propose_patch',
  'artifact.validate',
] as const;
export const ToolIdSchema = z.enum(TOOL_IDS);
export type ToolId = z.infer<typeof ToolIdSchema>;

export const TOOL_SCOPES = [
  'sources:read',
  'artifact:read',
  'artifact:draft_write',
  'artifact:validate',
  'data:profile',
  'data:transform',
] as const;
export const ToolScopeSchema = z.enum(TOOL_SCOPES);
export type ToolScope = z.infer<typeof ToolScopeSchema>;

export const ToolEffectSchema = z.enum(['read', 'draft_write', 'external_write']);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

export const ToolIdempotencySchema = z.enum(['safe', 'keyed', 'unsafe']);
export type ToolIdempotency = z.infer<typeof ToolIdempotencySchema>;

export const ToolPolicySchema = z.object({
  effect: ToolEffectSchema,
  idempotency: ToolIdempotencySchema,
  timeoutMs: z.number().int().positive().max(600_000),
  maxResultBytes: z.number().int().positive(),
  requiredScopes: z.array(ToolScopeSchema).max(16),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/** Model-facing tool descriptor (JSON Schema derived from the zod arguments). */
export const ToolDescriptorSchema = z.object({
  id: ToolIdSchema,
  version: z.string().min(1).max(32),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  policy: ToolPolicySchema,
  parameters: JsonObjectSchema,
  modelFacing: z.boolean(),
  resultDescription: z.string().max(2000),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/* ------------------------------ arguments ------------------------------ */

const MaxCharsSchema = z.number().int().positive().max(20_000).default(8_000);

export const SourceListArgsSchema = z.strictObject({
  includeUnavailable: z.boolean().default(false),
});
export type SourceListArgs = z.infer<typeof SourceListArgsSchema>;

export const SourceReadArgsSchema = z.strictObject({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  locator: SourceLocatorSchema.optional(),
  maxChars: MaxCharsSchema,
});
export type SourceReadArgs = z.infer<typeof SourceReadArgsSchema>;

export const SourceSearchArgsSchema = z.strictObject({
  query: z.string().min(1).max(200),
  limit: z.number().int().positive().max(20).default(5),
  sourceIds: z.array(SourceIdSchema).max(20).optional(),
});
export type SourceSearchArgs = z.infer<typeof SourceSearchArgsSchema>;

export const DataFormatSchema = z.enum(['csv', 'json']);
export type DataFormat = z.infer<typeof DataFormatSchema>;

export const DataProfileArgsSchema = z.strictObject({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
});
export type DataProfileArgs = z.infer<typeof DataProfileArgsSchema>;

export const TRANSFORM_OPERATORS = [
  'select',
  'rename',
  'filter',
  'sort',
  'dedupe',
  'normalize',
  'cast',
  'fill',
  'map',
  'limit',
  'require',
] as const;

export const NormalizeOpSchema = z.enum(['trim', 'lower', 'upper', 'collapse_space', 'strip_quotes']);
export type NormalizeOp = z.infer<typeof NormalizeOpSchema>;

export const TransformOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('select'), columns: z.array(z.string().min(1).max(128)).min(1).max(200) }),
  z.object({ op: z.literal('rename'), mapping: z.record(z.string().min(1).max(128), z.string().min(1).max(128)) }),
  z.object({
    op: z.literal('filter'),
    column: z.string().min(1).max(128),
    operator: z.enum(['eq', 'neq', 'in', 'not_in', 'gt', 'lt', 'contains', 'not_empty', 'matches']),
    value: JsonValueSchema.optional(),
  }),
  z.object({
    op: z.literal('sort'),
    column: z.string().min(1).max(128),
    direction: z.enum(['asc', 'desc']).default('asc'),
    numeric: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('dedupe'),
    keys: z.array(z.string().min(1).max(128)).min(1).max(16),
    keep: z.enum(['first', 'last']).default('first'),
    normalize: z.enum(['none', 'trim', 'lower', 'trim_lower']).default('trim_lower'),
  }),
  z.object({
    op: z.literal('normalize'),
    column: z.string().min(1).max(128),
    transforms: z.array(NormalizeOpSchema).min(1).max(8),
    nullTokens: z.array(z.string().max(100)).max(16).default([]),
  }),
  z.object({
    op: z.literal('cast'),
    column: z.string().min(1).max(128),
    to: z.enum(['string', 'number', 'date', 'boolean']),
    strict: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('fill'),
    column: z.string().min(1).max(128),
    value: JsonValueSchema,
    onlyEmpty: z.boolean().default(true),
  }),
  z.object({
    op: z.literal('map'),
    column: z.string().min(1).max(128),
    mapping: z.record(z.string().max(500), z.string().max(500)),
    fallback: z.string().max(500).nullable().default(null),
    recordIssueOnUnknown: z.boolean().default(true),
  }),
  z.object({ op: z.literal('limit'), count: z.number().int().positive().max(LIMITS.maxCsvRows) }),
  z.object({ op: z.literal('require'), columns: z.array(z.string().min(1).max(128)).min(1).max(64) }),
]);
export type TransformOperation = z.infer<typeof TransformOperationSchema>;

export const DataTransformArgsSchema = z.strictObject({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  format: DataFormatSchema,
  operations: z.array(TransformOperationSchema).min(1).max(32),
  outputName: z.string().min(1).max(200).default('transformed.csv'),
});
export type DataTransformArgs = z.infer<typeof DataTransformArgsSchema>;

export const ArtifactReadArgsSchema = z.strictObject({
  moduleId: ModuleIdSchema,
  versionId: ArtifactVersionIdSchema.nullable().default(null),
});
export type ArtifactReadArgs = z.infer<typeof ArtifactReadArgsSchema>;

export const ArtifactProposePatchArgsSchema = z.strictObject({
  moduleId: ModuleIdSchema,
  baseVersionId: ArtifactVersionIdSchema.nullable(),
  description: z.string().min(1).max(4000),
  operations: z.array(PatchOperationSchema).min(1).max(LIMITS.maxPatchOperations),
  evidenceRefs: z.array(z.record(z.string(), JsonValueSchema)).max(256).default([]),
});
export type ArtifactProposePatchArgs = z.infer<typeof ArtifactProposePatchArgsSchema>;

export const ArtifactValidateArgsSchema = z.strictObject({
  moduleId: ModuleIdSchema,
  baseVersionId: ArtifactVersionIdSchema.nullable().default(null),
  candidate: ModuleContentSchema,
  evidenceRefs: z.array(z.record(z.string(), JsonValueSchema)).max(256).default([]),
});
export type ArtifactValidateArgs = z.infer<typeof ArtifactValidateArgsSchema>;

export interface ToolArgumentsById {
  'source.list': SourceListArgs;
  'source.read': SourceReadArgs;
  'source.search': SourceSearchArgs;
  'data.profile': DataProfileArgs;
  'data.transform': DataTransformArgs;
  'artifact.read': ArtifactReadArgs;
  'artifact.propose_patch': ArtifactProposePatchArgs;
  'artifact.validate': ArtifactValidateArgs;
}

/* ------------------------------- results ------------------------------- */

export const SourceListItemSchema = z.object({
  sourceId: SourceIdSchema,
  name: z.string(),
  mime: z.string(),
  version: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  availability: z.enum(['available', 'missing', 'changed']),
  origin: z.enum(['upload', 'demo_seed', 'task_package']),
  trustLevel: z.enum(['user_provided', 'synthetic_demo', 'unknown']),
});
export type SourceListItem = z.infer<typeof SourceListItemSchema>;

export const SourceListResultSchema = z.object({ items: z.array(SourceListItemSchema).max(LIMITS.maxSourcesPerTask) });
export type SourceListResult = z.infer<typeof SourceListResultSchema>;

export const SourceReadResultSchema = z.object({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  locator: SourceLocatorSchema,
  content: z.string().max(20_000),
  truncated: z.boolean(),
  totalChars: z.number().int().nonnegative(),
  trust: z.literal('untrusted_content'),
});
export type SourceReadResult = z.infer<typeof SourceReadResultSchema>;

export const SearchHitSchema = z.object({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  locator: SourceLocatorSchema,
  excerpt: z.string().max(LIMITS.previewExcerptChars),
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SourceSearchResultSchema = z.object({
  query: z.string(),
  hits: z.array(SearchHitSchema).max(20),
  searchedSources: z.array(SourceIdSchema).max(LIMITS.maxSourcesPerTask),
});
export type SourceSearchResult = z.infer<typeof SourceSearchResultSchema>;

export const ColumnProfileSchema = z.object({
  key: z.string(),
  inferredType: z.enum(['string', 'number', 'date', 'boolean', 'mixed', 'empty']),
  missing: z.number().int().nonnegative(),
  distinct: z.number().int().nonnegative(),
  samples: z.array(z.string().max(200)).max(5),
  issues: z.array(z.string().max(300)).max(20),
});
export type ColumnProfile = z.infer<typeof ColumnProfileSchema>;

export const DataProfileResultSchema = z.object({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  format: DataFormatSchema,
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  columns: z.array(ColumnProfileSchema).max(LIMITS.maxCsvColumns),
  duplicateRowCount: z.number().int().nonnegative(),
  missingRequiredCount: z.number().int().nonnegative(),
  issues: z.array(z.string().max(500)).max(100),
});
export type DataProfileResult = z.infer<typeof DataProfileResultSchema>;

export const DataTransformResultSchema = z.object({
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  format: DataFormatSchema,
  columns: z.array(z.object({ key: z.string(), label: z.string() })).max(LIMITS.maxCsvColumns),
  rowCount: z.number().int().nonnegative(),
  preview: z.array(z.record(z.string(), JsonValueSchema)).max(20),
  objectHash: Sha256HexSchema,
  outputName: z.string(),
  issues: z.array(z.string().max(500)).max(200),
  deterministic: z.boolean(),
});
export type DataTransformResult = z.infer<typeof DataTransformResultSchema>;

export const ArtifactReadResultSchema = z.object({
  moduleId: ModuleIdSchema,
  versionId: ArtifactVersionIdSchema.nullable(),
  content: ModuleContentSchema,
  contentHash: Sha256HexSchema.nullable(),
  moduleKind: z.enum(['markdown', 'json', 'csv']),
  dependencies: z.array(ModuleIdSchema),
});
export type ArtifactReadResult = z.infer<typeof ArtifactReadResultSchema>;

export const ProposePatchResultSchema = z.object({
  patch: PatchProposalSchema,
  validation: ValidationReportSchema.nullable(),
});
export type ProposePatchResult = z.infer<typeof ProposePatchResultSchema>;

export const ValidateToolResultSchema = z.object({
  validation: ValidationReportSchema,
  status: z.enum(['pass', 'fail', 'needs_review']),
  reportId: ValidationReportIdSchema,
});
export type ValidateToolResult = z.infer<typeof ValidateToolResultSchema>;

/* ------------------------------- runtime ------------------------------- */

export const TOOL_CALL_STATUSES = [
  'planned',
  'authorized',
  'denied',
  'started',
  'succeeded',
  'failed',
  'outcome_unknown',
] as const;
export const ToolCallStatusSchema = z.enum(TOOL_CALL_STATUSES);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallRequestSchema = z.object({
  toolCallId: ToolCallIdSchema,
  runId: RunIdSchema,
  stepId: StepIdSchema,
  toolId: ToolIdSchema,
  arguments: JsonObjectSchema,
  requestedAt: UtcTimestampSchema,
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export const ToolErrorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().max(4000),
  retryable: z.boolean(),
  details: JsonValueSchema.optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const ToolInvocationRecordSchema = z.object({
  toolCallId: ToolCallIdSchema,
  runId: RunIdSchema,
  stepId: StepIdSchema,
  toolId: ToolIdSchema,
  status: ToolCallStatusSchema,
  argumentsJson: z.string().max(400_000),
  resultSummary: z.string().max(2000).nullable(),
  resultObjectHash: Sha256HexSchema.nullable(),
  resultBytes: z.number().int().nonnegative().nullable(),
  error: ToolErrorSchema.nullable(),
  attempt: z.number().int().positive(),
  plannedAt: UtcTimestampSchema,
  authorizedAt: UtcTimestampSchema.nullable(),
  startedAt: UtcTimestampSchema.nullable(),
  finishedAt: UtcTimestampSchema.nullable(),
});
export type ToolInvocationRecord = z.infer<typeof ToolInvocationRecordSchema>;

export const ToolResultSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolId: ToolIdSchema,
  status: z.enum(['succeeded', 'failed', 'outcome_unknown']),
  result: JsonValueSchema.optional(),
  resultObjectHash: Sha256HexSchema.nullable().default(null),
  resultBytes: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative(),
  error: ToolErrorSchema.nullable().default(null),
  trust: z.literal('untrusted_content'),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Authorization decision for P0: reads are auto-allowed, scopes are enforced. */
export const ToolAuthorizationSchema = z.object({
  toolCallId: ToolCallIdSchema,
  decision: z.enum(['allow', 'deny', 'require_approval']),
  reason: z.string().max(2000),
  scopes: z.array(ToolScopeSchema),
  policyVersion: z.string().max(64),
});
export type ToolAuthorization = z.infer<typeof ToolAuthorizationSchema>;
