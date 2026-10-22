/**
 * Shared primitives for the Cognitive Atrium contracts package.
 *
 * This package is browser-safe: it must not import Node.js built-ins, so the
 * spatial UI can validate snapshots with the exact same schemas as the server.
 */
import { z } from 'zod';

export const CONTRACT_SCHEMA_VERSION = '1' as const;
export const EVENT_SCHEMA_VERSION = '1' as const;
export const POLICY_VERSION = 'p0-policy-1' as const;
export const RECIPE_SCHEMA_VERSION = '1' as const;
export const PROMPT_BUNDLE_VERSION = 'prompts-1' as const;

/* ------------------------------------------------------------------ */
/* Stable IDs                                                          */
/* ------------------------------------------------------------------ */

type Brand<T, B extends string> = T & { readonly __brand: B };

export function newUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Deterministic fallback is never acceptable for production IDs; fail loudly.
  throw new Error('crypto.randomUUID is unavailable in this runtime');
}

function idSchema<B extends string>() {
  return z.uuid().brand<B>();
}

export const WorkspaceIdSchema = idSchema<'WorkspaceId'>();
export const TaskIdSchema = idSchema<'TaskId'>();
export const ArtifactIdSchema = idSchema<'ArtifactId'>();
export const ModuleIdSchema = idSchema<'ModuleId'>();
export const ArtifactVersionIdSchema = idSchema<'ArtifactVersionId'>();
export const RunIdSchema = idSchema<'RunId'>();
export const StepIdSchema = idSchema<'StepId'>();
export const BlockerIdSchema = idSchema<'BlockerId'>();
export const SourceIdSchema = idSchema<'SourceId'>();
export const SourceSpanIdSchema = idSchema<'SourceSpanId'>();
export const PatchIdSchema = idSchema<'PatchId'>();
export const RecipeIdSchema = idSchema<'RecipeId'>();
export const EventIdSchema = idSchema<'EventId'>();
export const ModelCallIdSchema = idSchema<'ModelCallId'>();
export const ToolCallIdSchema = idSchema<'ToolCallId'>();
export const ValidationReportIdSchema = idSchema<'ValidationReportId'>();
export const ContextSnapshotIdSchema = idSchema<'ContextSnapshotId'>();
export const CheckpointIdSchema = idSchema<'CheckpointId'>();
export const CommandIdSchema = idSchema<'CommandId'>();
export const DecisionIdSchema = idSchema<'DecisionId'>();
export const ProviderProfileIdSchema = idSchema<'ProviderProfileId'>();

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type ModuleId = z.infer<typeof ModuleIdSchema>;
export type ArtifactVersionId = z.infer<typeof ArtifactVersionIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type StepId = z.infer<typeof StepIdSchema>;
export type BlockerId = z.infer<typeof BlockerIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;
export type SourceSpanId = z.infer<typeof SourceSpanIdSchema>;
export type PatchId = z.infer<typeof PatchIdSchema>;
export type RecipeId = z.infer<typeof RecipeIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type ModelCallId = z.infer<typeof ModelCallIdSchema>;
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;
export type ValidationReportId = z.infer<typeof ValidationReportIdSchema>;
export type ContextSnapshotId = z.infer<typeof ContextSnapshotIdSchema>;
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;
export type ProviderProfileId = z.infer<typeof ProviderProfileIdSchema>;

export const newTaskId = (): TaskId => TaskIdSchema.parse(newUuid());
export const newArtifactId = (): ArtifactId => ArtifactIdSchema.parse(newUuid());
export const newModuleId = (): ModuleId => ModuleIdSchema.parse(newUuid());
export const newRunId = (): RunId => RunIdSchema.parse(newUuid());
export const newStepId = (): StepId => StepIdSchema.parse(newUuid());
export const newBlockerId = (): BlockerId => BlockerIdSchema.parse(newUuid());
export const newSourceId = (): SourceId => SourceIdSchema.parse(newUuid());
export const newSourceSpanId = (): SourceSpanId => SourceSpanIdSchema.parse(newUuid());
export const newPatchId = (): PatchId => PatchIdSchema.parse(newUuid());
export const newRecipeId = (): RecipeId => RecipeIdSchema.parse(newUuid());
export const newEventId = (): EventId => EventIdSchema.parse(newUuid());
export const newModelCallId = (): ModelCallId => ModelCallIdSchema.parse(newUuid());
export const newToolCallId = (): ToolCallId => ToolCallIdSchema.parse(newUuid());
export const newValidationReportId = (): ValidationReportId => ValidationReportIdSchema.parse(newUuid());
export const newContextSnapshotId = (): ContextSnapshotId => ContextSnapshotIdSchema.parse(newUuid());
export const newCheckpointId = (): CheckpointId => CheckpointIdSchema.parse(newUuid());
export const newCommandId = (): CommandId => CommandIdSchema.parse(newUuid());
export const newDecisionId = (): DecisionId => DecisionIdSchema.parse(newUuid());
export const newProviderProfileId = (): ProviderProfileId => ProviderProfileIdSchema.parse(newUuid());

/* ------------------------------------------------------------------ */
/* Time, hashes, sizes                                                 */
/* ------------------------------------------------------------------ */

/** UTC timestamp, always serialized as an ISO-8601 string ending in `Z`. */
export const UtcTimestampSchema = z.iso.datetime();
export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>;

export function utcNow(): UtcTimestamp {
  return new Date().toISOString();
}

/** Lowercase hex sha256 digest, no prefix. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase sha256 hex');
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

export const ContentHashSchema = Sha256HexSchema;

/** Byte size with a hard non-negative bound. */
export const ByteSizeSchema = z.number().int().nonnegative();

/** Sequence number inside a single task event stream (1-based, monotonic). */
export const SeqSchema = z.number().int().positive();
export type Seq = z.infer<typeof SeqSchema>;

/** Optimistic concurrency revision of an aggregate (task/run/artifact). */
export const RevisionSchema = z.number().int().nonnegative();
export type Revision = z.infer<typeof RevisionSchema>;

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

/** Serialize with sorted object keys so hashes are stable across runs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Small shared enums                                                  */
/* ------------------------------------------------------------------ */

export const EngineModeSchema = z.enum(['demo', 'live']);
export type EngineMode = z.infer<typeof EngineModeSchema>;

/** Replay is a read-only projection over recorded events, not a run mode. */
export const ViewModeSchema = z.enum(['live', 'demo', 'replay']);
export type ViewMode = z.infer<typeof ViewModeSchema>;

export const WorkspaceModeSchema = EngineModeSchema;

export const TrustLevelSchema = z.enum(['user_provided', 'synthetic_demo', 'unknown']);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const SeveritySchema = z.enum(['info', 'warning', 'blocking']);
export type Severity = z.infer<typeof SeveritySchema>;

export const SourceOriginSchema = z.enum(['upload', 'demo_seed', 'task_package']);
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

export const ActorSchema = z.enum(['user', 'system', 'recipe']);
export type Actor = z.infer<typeof ActorSchema>;

/* ------------------------------------------------------------------ */
/* Physical limits (design document section 5.3 / 7.1 / 21.2)          */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  maxSourceFileBytes: 10 * 1024 * 1024,
  maxTaskSourceBytes: 50 * 1024 * 1024,
  maxSourcesPerTask: 40,
  maxModulesPerArtifact: 8,
  maxMarkdownSections: 200,
  maxCsvRows: 50_000,
  maxCsvColumns: 200,
  maxCsvFieldChars: 32_768,
  maxJsonDepth: 32,
  maxJsonNodes: 200_000,
  maxToolResultBytes: 2 * 1024 * 1024,
  maxModelOutputTokens: 8_192,
  maxPatchOperations: 512,
  maxRecipeSteps: 32,
  maxSpatialBranches: 3,
  maxSpatialNodes: 12,
  maxSpatialEdges: 16,
  maxEventPageSize: 500,
  maxExportBytes: 64 * 1024 * 1024,
  maxImportPackageBytes: 128 * 1024 * 1024,
  maxImportUnzippedBytes: 512 * 1024 * 1024,
  maxImportEntries: 5_000,
  previewExcerptChars: 400,
  modelDeltaBatchIntervalMs: 100,
} as const;

export const TIME_LIMITS = {
  firstEventTimeoutMs: 30_000,
  idleTimeoutMs: 45_000,
  totalModelRequestTimeoutMs: 180_000,
  toolTimeoutMs: 30_000,
  runActiveDurationMs: 10 * 60_000,
  maxRetries: 2,
  maxStructureRepairs: 2,
  maxModelRequestsPerRun: 12,
  maxToolCallsPerRun: 20,
  maxActiveRunsGlobal: 2,
  runLeaseTtlMs: 30_000,
  heartbeatIntervalMs: 5_000,
  spatialTransitionMs: 220,
} as const;

/** Public error codes; clients branch on `code`, never on human text. */
export const API_ERROR_CODES = [
  'bad_request',
  'origin_not_allowed',
  'session_required',
  'not_found',
  'forbidden',
  'conflict',
  'revision_conflict',
  'version_conflict',
  'validation_failed',
  'schema_invalid',
  'budget_exhausted',
  'state_not_allowed',
  'dependency_unavailable',
  'provider_error',
  'provider_auth_error',
  'provider_rate_limited',
  'provider_model_missing',
  'tool_error',
  'tool_timeout',
  'tool_outcome_unknown',
  'snapshot_required',
  'disk_full',
  'unsupported_media_type',
  'payload_too_large',
  'import_invalid',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorBodySchema = z.object({
  code: z.enum(API_ERROR_CODES),
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  details: JsonValueSchema.optional(),
  traceId: z.string().min(1).max(128),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
