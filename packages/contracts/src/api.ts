/** HTTP command API contracts (design document section 18.1). */
import { z } from 'zod';
import {
  ArtifactIdSchema,
  ArtifactVersionIdSchema,
  BlockerIdSchema,
  CommandIdSchema,
  ContextSnapshotIdSchema,
  EngineModeSchema,
  JsonObjectSchema,
  ModuleIdSchema,
  PatchIdSchema,
  ProviderProfileIdSchema,
  RecipeIdSchema,
  RevisionSchema,
  RunIdSchema,
  TaskIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
  POLICY_VERSION,
  LIMITS,
} from './primitives';
import { BudgetUsageSchema } from './budget';
import {
  ArtifactModuleSchema,
  ArtifactSchema,
  ArtifactVersionSchema,
  BlockerSchema,
  ConstraintSchema,
  ContextSnapshotSchema,
  ModuleTemplateSchema,
  PatchQueueItemSchema,
  SourceItemSchema,
  SourceSpanSchema,
  TaskRunSummarySchema,
  TaskSchema,
  ValidationSummarySchema,
  WorkspaceSchema,
  WorkspaceSettingsSchema,
} from './entities';
import { PlanSchema } from './plan';
import { PatchProposalSchema, ContentDiffSchema } from './patch';
import { ValidationReportSchema } from './validation';
import {
  ModuleAcceptanceSummarySchema,
  EvidenceSummarySchema,
  ProspectProjectionSchema,
  RunControlProjectionSchema,
  SpatialProjectionSchema,
} from './projection';
import { HarnessEventSchema } from './events';
import { CapabilityReportSchema, ProviderProfileSchema, ProviderProfilePublicSchema } from './model';
import { RecipeProposalInputSchema, RecipeSchema, RecipeRunResultSchema } from './recipes';
import { BudgetPolicySchema } from './budget';

/* -------------------------------- session -------------------------------- */

export const SessionInfoSchema = z.object({
  authenticated: z.boolean(),
  mode: EngineModeSchema,
  csrfToken: z.string().max(200),
  serverVersion: z.string().max(50),
  policyVersion: z.string().max(64).default(POLICY_VERSION),
  liveProviderConfigured: z.boolean(),
  demoAvailable: z.boolean(),
  serverTime: UtcTimestampSchema,
  uptimeSeconds: z.number().int().nonnegative(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const WorkspaceViewSchema = z.object({
  workspace: WorkspaceSchema,
  providerProfiles: z.array(ProviderProfilePublicSchema).max(20),
  demoAvailable: z.boolean(),
  liveAvailable: z.boolean(),
  appVersion: z.string().max(50),
  policyVersion: z.string().max(64),
  limits: z.record(z.string(), z.number()),
});
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;

export const UpdateWorkspaceRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema.optional(),
  settings: WorkspaceSettingsSchema.partial(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

/* -------------------------------- provider -------------------------------- */

export const CreateProviderProfileRequestSchema = z.object({
  commandId: CommandIdSchema,
  profileName: z.string().min(1).max(100),
  adapterType: z.enum(['openai_compatible', 'anthropic_native', 'openai_responses']),
  baseURL: z.string().url().max(2048),
  model: z.string().min(1).max(200),
  credentialRef: z.string().min(1).max(100),
  /** Write-only credential value. Never returned by any read endpoint. */
  credentialValue: z.string().max(4000).optional(),
  timeouts: ProviderProfileSchema.shape.timeouts.optional(),
  contextWindowOverride: z.number().int().positive().max(10_000_000).nullable().optional(),
  priceTable: ProviderProfileSchema.shape.priceTable.optional(),
  enabled: z.boolean().default(true),
});
export type CreateProviderProfileRequest = z.infer<typeof CreateProviderProfileRequestSchema>;

export const UpdateProviderProfileRequestSchema = CreateProviderProfileRequestSchema.extend({
  commandId: CommandIdSchema,
  credentialValue: z.string().max(4000).optional(),
});
export type UpdateProviderProfileRequest = z.infer<typeof UpdateProviderProfileRequestSchema>;

export const ProviderProfileResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  profileId: ProviderProfileIdSchema,
  profile: ProviderProfilePublicSchema,
});
export type ProviderProfileResponse = z.infer<typeof ProviderProfileResponseSchema>;

export const CAPABILITY_PROBES = ['auth_and_text', 'streaming', 'tool_calling', 'structured_output', 'usage'] as const;
export const CapabilityProbeNameSchema = z.enum(CAPABILITY_PROBES);
export type CapabilityProbeName = z.infer<typeof CapabilityProbeNameSchema>;

export const TestProviderRequestSchema = z.object({
  commandId: CommandIdSchema,
  probes: z.array(CapabilityProbeNameSchema).min(1).max(5).default(['auth_and_text']),
  confirmCharges: z.boolean().default(false),
});
export type TestProviderRequest = z.infer<typeof TestProviderRequestSchema>;

export const TestProviderResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  report: CapabilityReportSchema,
});
export type TestProviderResponse = z.infer<typeof TestProviderResponseSchema>;

/* ---------------------------------- task ---------------------------------- */

export const TaskModuleInputSchema = ModuleTemplateSchema.omit({ dependsOnKeys: true }).extend({
  dependsOnKeys: z.array(z.string().min(1).max(64)).max(7).default([]),
});
export type TaskModuleInput = z.infer<typeof TaskModuleInputSchema>;

export const CreateTaskRequestSchema = z.object({
  commandId: CommandIdSchema,
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(8000),
  artifactTitle: z.string().min(1).max(200),
  constraints: z.array(ConstraintSchema.omit({ status: true })).max(64).default([]),
  templateId: z.string().min(1).max(100).nullable().default(null),
  modules: z.array(TaskModuleInputSchema).min(1).max(LIMITS.maxModulesPerArtifact).default([]),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const CreateTaskResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  taskId: TaskIdSchema,
  artifactId: ArtifactIdSchema,
  revision: RevisionSchema,
  moduleIds: z.array(ModuleIdSchema).min(1).max(LIMITS.maxModulesPerArtifact),
});
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;

export const UpdateTaskRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema,
  title: z.string().min(1).max(200).optional(),
  intent: z.string().min(1).max(8000).optional(),
  constraints: z.array(ConstraintSchema).max(64).optional(),
  modules: z
    .array(
      z.object({
        moduleId: ModuleIdSchema,
        title: z.string().min(1).max(200).optional(),
        acceptanceCriteria: z.array(z.object({ id: z.string().max(64).optional(), text: z.string().min(1).max(2000), layer: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']).default('L3') })).max(32).optional(),
        dependencies: z.array(ModuleIdSchema).max(7).optional(),
        order: z.number().int().nonnegative().max(7).optional(),
      }),
    )
    .max(LIMITS.maxModulesPerArtifact)
    .optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const TaskListResponseSchema = z.object({
  tasks: z
    .array(
      z.object({
        taskId: TaskIdSchema,
        title: TaskSchema.shape.title,
        status: TaskSchema.shape.status,
        revision: RevisionSchema,
        createdAt: UtcTimestampSchema,
        updatedAt: UtcTimestampSchema,
        moduleCount: z.number().int().nonnegative(),
        activeRunState: z.string().max(30).nullable(),
        acceptedCount: z.number().int().nonnegative(),
      }),
    )
    .max(200),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const SourceImportRequestSchema = z.object({
  commandId: CommandIdSchema,
  fileName: z.string().min(1).max(300),
  mime: z.string().min(1).max(200),
  /** Base64 encoded raw bytes. Validated against size limits before decoding. */
  contentBase64: z.string().min(1).max(Math.ceil((LIMITS.maxSourceFileBytes * 4) / 3) + 16),
  origin: z.enum(['upload', 'demo_seed', 'task_package']).default('upload'),
});
export type SourceImportRequest = z.infer<typeof SourceImportRequestSchema>;

export const SourceImportResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  sourceId: z.string().uuid(),
  version: z.number().int().positive(),
  parseStatus: z.enum(['parsed', 'unsupported', 'failed']),
  parseNote: z.string().max(2000),
  warnings: z.array(z.string().max(500)).max(20).default([]),
});
export type SourceImportResponse = z.infer<typeof SourceImportResponseSchema>;

/* ---------------------------------- runs ---------------------------------- */

export const CreateRunRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema,
  moduleId: ModuleIdSchema,
  intent: z.string().min(1).max(8000),
  planFirst: z.boolean().default(true),
  budgetOverrides: BudgetPolicySchema.partial().optional(),
  sourceIds: z.array(z.string().uuid()).max(LIMITS.maxSourcesPerTask).optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const CreateRunResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  runId: RunIdSchema,
  state: z.string().min(1).max(30),
  revision: RevisionSchema,
  plan: PlanSchema.nullable().default(null),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export const CommitPlanRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema,
  planVersion: z.number().int().positive(),
  contextSnapshotId: ContextSnapshotIdSchema,
});
export type CommitPlanRequest = z.infer<typeof CommitPlanRequestSchema>;

export const ResolveInputRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema,
  blockerId: BlockerIdSchema,
  optionId: z.string().min(1).max(64),
  value: z.unknown(),
  note: z.string().max(2000).default(''),
});
export type ResolveInputRequest = z.infer<typeof ResolveInputRequestSchema>;

export const RunControlRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema,
  reason: z.string().max(2000).default(''),
});
export type RunControlRequest = z.infer<typeof RunControlRequestSchema>;

export const RunControlResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  runId: RunIdSchema,
  state: z.string().min(1).max(30),
  revision: RevisionSchema,
});
export type RunControlResponse = z.infer<typeof RunControlResponseSchema>;

/* -------------------------------- patches -------------------------------- */

export const AcceptPatchRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema,
  validationReportId: z.string().uuid(),
  acceptMode: z.enum(['all', 'sections']).default('all'),
  sectionIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  note: z.string().max(2000).default(''),
});
export type AcceptPatchRequest = z.infer<typeof AcceptPatchRequestSchema>;

export const AcceptPatchResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  patchId: PatchIdSchema,
  versionId: ArtifactVersionIdSchema,
  moduleId: ModuleIdSchema,
  runState: z.string().max(30).nullable(),
  artifactRevision: RevisionSchema,
});
export type AcceptPatchResponse = z.infer<typeof AcceptPatchResponseSchema>;

export const RejectPatchRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema.optional(),
  reason: z.string().max(2000),
});
export type RejectPatchRequest = z.infer<typeof RejectPatchRequestSchema>;

export const PatchReviewResponseSchema = z.object({
  patch: PatchProposalSchema,
  diff: ContentDiffSchema,
  validation: ValidationReportSchema.nullable(),
  baseContent: z.unknown().nullable(),
});
export type PatchReviewResponse = z.infer<typeof PatchReviewResponseSchema>;

/* -------------------------------- artifacts -------------------------------- */

export const RestoreVersionRequestSchema = z.object({
  commandId: CommandIdSchema,
  expectedRevision: RevisionSchema,
  moduleId: ModuleIdSchema,
  versionId: ArtifactVersionIdSchema,
  note: z.string().max(2000).default(''),
});
export type RestoreVersionRequest = z.infer<typeof RestoreVersionRequestSchema>;

export const RestoreVersionResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  versionId: ArtifactVersionIdSchema,
  moduleId: ModuleIdSchema,
  artifactRevision: RevisionSchema,
});
export type RestoreVersionResponse = z.infer<typeof RestoreVersionResponseSchema>;

export const ModuleContentResponseSchema = z.object({
  moduleId: ModuleIdSchema,
  versionId: ArtifactVersionIdSchema.nullable(),
  contentHash: z.string().max(64).nullable(),
  moduleKind: z.enum(['markdown', 'json', 'csv']),
  content: z.unknown(),
  acceptedAt: UtcTimestampSchema.nullable(),
  acceptedBy: z.string().max(100).nullable(),
});
export type ModuleContentResponse = z.infer<typeof ModuleContentResponseSchema>;

export const VersionListResponseSchema = z.object({
  moduleId: ModuleIdSchema,
  versions: z
    .array(
      z.object({
        versionId: ArtifactVersionIdSchema,
        contentHash: z.string().max(64),
        acceptedAt: UtcTimestampSchema,
        acceptedBy: z.string().max(100),
        parentId: ArtifactVersionIdSchema.nullable(),
        sourceRunId: RunIdSchema.nullable(),
        note: z.string().max(2000),
        isCurrent: z.boolean(),
      }),
    )
    .max(200),
});
export type VersionListResponse = z.infer<typeof VersionListResponseSchema>;

/* --------------------------------- recipes --------------------------------- */

export const CreateRecipeRequestSchema = z.object({
  commandId: CommandIdSchema,
  proposal: RecipeProposalInputSchema,
});
export type CreateRecipeRequest = z.infer<typeof CreateRecipeRequestSchema>;

export const CreateRecipeResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  recipeId: RecipeIdSchema,
  version: z.number().int().positive(),
  status: z.enum(['candidate', 'validated', 'stale', 'disabled']),
  recipe: RecipeSchema,
});
export type CreateRecipeResponse = z.infer<typeof CreateRecipeResponseSchema>;

export const ValidateRecipeRequestSchema = z.object({
  commandId: CommandIdSchema,
  testInputs: z
    .array(z.object({ testCaseId: z.string().min(1).max(100), inputs: JsonObjectSchema }))
    .min(1)
    .max(16),
});
export type ValidateRecipeRequest = z.infer<typeof ValidateRecipeRequestSchema>;

export const ValidateRecipeResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  recipeId: RecipeIdSchema,
  version: z.number().int().positive(),
  status: z.enum(['candidate', 'validated', 'stale', 'disabled']),
  testCases: RecipeSchema.shape.testCases,
});
export type ValidateRecipeResponse = z.infer<typeof ValidateRecipeResponseSchema>;

export const RunRecipeRequestSchema = z.object({
  commandId: CommandIdSchema,
  inputs: JsonObjectSchema,
  expectedRevision: RevisionSchema.optional(),
});
export type RunRecipeRequest = z.infer<typeof RunRecipeRequestSchema>;

export const RunRecipeResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  recipeId: RecipeIdSchema,
  runId: RunIdSchema,
  cacheState: z.enum(['executed', 'cache_hit']),
  result: RecipeRunResultSchema.nullable(),
});
export type RunRecipeResponse = z.infer<typeof RunRecipeResponseSchema>;

/* --------------------------------- snapshot --------------------------------- */

export const ModuleViewSchema = z.object({
  module: ArtifactModuleSchema,
  acceptance: ModuleAcceptanceSummarySchema,
  acceptedContent: z.unknown().nullable(),
  acceptedVersion: ArtifactVersionSchema.nullable(),
  pendingCandidateSummary: z.string().max(1000).nullable().default(null),
});
export type ModuleView = z.infer<typeof ModuleViewSchema>;

export const RunDetailResponseSchema = z.object({
  run: z.object({
    runId: RunIdSchema,
    taskId: TaskIdSchema,
    moduleId: ModuleIdSchema,
    state: z.string().max(30),
    attempt: z.number().int().positive(),
    budgetUsage: BudgetUsageSchema,
    error: z.unknown().nullable(),
    interrupted: z.unknown().nullable(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    startedAt: UtcTimestampSchema.nullable(),
    finishedAt: UtcTimestampSchema.nullable(),
  }),
  plan: PlanSchema.nullable(),
  steps: z.array(z.object({ stepId: z.string().uuid(), kind: z.string().max(30), title: z.string().max(300), status: z.string().max(30), summary: z.string().max(2000), startedAt: UtcTimestampSchema.nullable(), finishedAt: UtcTimestampSchema.nullable() })).max(200),
  blockers: z.array(BlockerSchema).max(100),
  contextSnapshot: ContextSnapshotSchema.nullable(),
  validationReport: ValidationReportSchema.nullable(),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export const TaskSnapshotSchema = z.object({
  snapshotSeq: z.number().int().nonnegative(),
  serverTime: UtcTimestampSchema,
  workspace: z.object({
    workspaceId: WorkspaceIdSchema,
    mode: EngineModeSchema,
    name: z.string().max(100),
    settings: WorkspaceSettingsSchema,
    policyVersion: z.string().max(64),
  }),
  task: TaskSchema,
  artifact: ArtifactSchema,
  modules: z.array(ModuleViewSchema).max(LIMITS.maxModulesPerArtifact),
  plan: PlanSchema.nullable(),
  runs: z.array(TaskRunSummarySchema).max(100),
  activeRun: z
    .object({
      runId: RunIdSchema,
      moduleId: ModuleIdSchema,
      state: z.string().max(30),
      attempt: z.number().int().positive(),
      budgetUsage: BudgetUsageSchema,
      planVersion: z.number().int().nonnegative(),
      error: z.unknown().nullable(),
      interrupted: z.unknown().nullable(),
    })
    .nullable(),
  blockers: z.array(BlockerSchema).max(100),
  patches: z.array(PatchQueueItemSchema).max(100),
  validations: z.array(ValidationSummarySchema).max(100),
  sources: z.array(EvidenceSummarySchema).max(LIMITS.maxSourcesPerTask),
  spans: z.array(SourceSpanSchema).max(100),
  prospects: z.array(ProspectProjectionSchema).max(8),
  recipes: z.array(z.object({ recipeId: RecipeIdSchema, name: z.string().max(200), kind: z.string().max(30), status: z.string().max(20), version: z.number().int().positive(), fingerprint: z.string().max(200) })).max(50),
  spatial: SpatialProjectionSchema,
  control: RunControlProjectionSchema,
  usage: BudgetUsageSchema.nullable(),
  events: z.array(HarnessEventSchema).max(LIMITS.maxEventPageSize),
  limits: z.object({ maxSpatialBranches: z.number().int().positive(), maxSpatialNodes: z.number().int().positive(), maxSpatialEdges: z.number().int().positive() }),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

export const SnapshotQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  includeEvents: z.coerce.boolean().default(true),
});
export type SnapshotQuery = z.infer<typeof SnapshotQuerySchema>;

/* ---------------------------------- export ---------------------------------- */

export const EXPORT_FORMATS = ['markdown', 'json', 'csv', 'task_package'] as const;
export const ExportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const ExportRequestSchema = z.object({
  commandId: CommandIdSchema,
  format: ExportFormatSchema,
  moduleIds: z.array(ModuleIdSchema).max(LIMITS.maxModulesPerArtifact).default([]),
  includeSources: z.boolean().default(false),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const ExportResponseSchema = z.object({
  commandId: CommandIdSchema,
  fileName: z.string().min(1).max(300),
  mime: z.string().min(1).max(200),
  contentBase64: z.string().max(Math.ceil((LIMITS.maxExportBytes * 4) / 3) + 16),
  sha256: z.string().min(64).max(64),
  bytes: z.number().int().nonnegative(),
  redacted: z.boolean(),
  warnings: z.array(z.string().max(500)).max(20).default([]),
});
export type ExportResponse = z.infer<typeof ExportResponseSchema>;

export const ImportRequestSchema = z.object({
  commandId: CommandIdSchema,
  fileName: z.string().min(1).max(300),
  contentBase64: z.string().min(1).max(Math.ceil((LIMITS.maxImportPackageBytes * 4) / 3) + 16),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const ImportResponseSchema = z.object({
  commandId: CommandIdSchema,
  duplicate: z.boolean().default(false),
  taskId: TaskIdSchema,
  warnings: z.array(z.string().max(500)).max(50).default([]),
  sourcesNeedRebinding: z.boolean(),
});
export type ImportResponse = z.infer<typeof ImportResponseSchema>;

/* ---------------------------------- demo ---------------------------------- */

export const DemoTemplateSchema = z.object({
  templateId: z.string().max(100),
  name: z.string().max(200),
  description: z.string().max(2000),
  modules: z.array(z.object({ key: z.string(), title: z.string(), kind: z.enum(['markdown', 'json', 'csv']), status: z.string().max(30) })).max(8),
  seedSourceNames: z.array(z.string().max(300)).max(20),
  fixtureVersion: z.string().max(50),
});
export type DemoTemplate = z.infer<typeof DemoTemplateSchema>;

export const DemoResetRequestSchema = z.object({
  commandId: CommandIdSchema,
});
export type DemoResetRequest = z.infer<typeof DemoResetRequestSchema>;

export const DemoResetResponseSchema = z.object({
  commandId: CommandIdSchema,
  taskId: TaskIdSchema,
  template: DemoTemplateSchema,
});
export type DemoResetResponse = z.infer<typeof DemoResetResponseSchema>;

/* -------------------------------- route map -------------------------------- */

export const API_PREFIX = '/api';

export const API_ROUTES = {
  health: '/api/health',
  session: '/api/session',
  workspace: '/api/workspace',
  providerProfiles: '/api/provider-profiles',
  providerProfile: (id: string) => `/api/provider-profiles/${id}`,
  providerProfileTest: (id: string) => `/api/provider-profiles/${id}/test`,
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${id}`,
  taskSources: (id: string) => `/api/tasks/${id}/sources`,
  taskRuns: (id: string) => `/api/tasks/${id}/runs`,
  taskSnapshot: (id: string) => `/api/tasks/${id}/snapshot`,
  taskEvents: (id: string) => `/api/tasks/${id}/events`,
  taskExport: (id: string) => `/api/tasks/${id}/export`,
  taskModuleContent: (taskId: string, moduleId: string) => `/api/tasks/${taskId}/modules/${moduleId}/content`,
  taskVersions: (taskId: string, moduleId: string) => `/api/tasks/${taskId}/modules/${moduleId}/versions`,
  run: (id: string) => `/api/runs/${id}`,
  runCommit: (id: string) => `/api/runs/${id}/commit`,
  runResolve: (id: string) => `/api/runs/${id}/resolve`,
  runPause: (id: string) => `/api/runs/${id}/pause`,
  runResume: (id: string) => `/api/runs/${id}/resume`,
  runCancel: (id: string) => `/api/runs/${id}/cancel`,
  patch: (id: string) => `/api/patches/${id}`,
  patchAccept: (id: string) => `/api/patches/${id}/accept`,
  patchReject: (id: string) => `/api/patches/${id}/reject`,
  artifactRestore: (id: string) => `/api/artifacts/${id}/restore`,
  recipes: '/api/recipes',
  recipeValidate: (id: string) => `/api/recipes/${id}/validate`,
  recipeRun: (id: string) => `/api/recipes/${id}/run`,
  imports: '/api/imports',
  demoReset: '/api/demo/reset',
  demoScenario: '/api/demo/scenario',
} as const;

export const SSE_HEARTBEAT_MS = 15_000;

export interface CommandMeta {
  commandId: string;
  expectedRevision?: number;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
  traceId: string;
}
