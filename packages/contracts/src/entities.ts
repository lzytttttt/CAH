/** Core persisted entities (design document section 4.1). */
import { z } from 'zod';
import {
  ArtifactIdSchema,
  ArtifactVersionIdSchema,
  BlockerIdSchema,
  CheckpointIdSchema,
  CommandIdSchema,
  ContentHashSchema,
  ContextSnapshotIdSchema,
  DecisionIdSchema,
  LIMITS,
  ModelCallIdSchema,
  ModuleIdSchema,
  PatchIdSchema,
  POLICY_VERSION,
  RevisionSchema,
  RunIdSchema,
  Sha256HexSchema,
  SourceIdSchema,
  SourceSpanIdSchema,
  StepIdSchema,
  TaskIdSchema,
  ToolCallIdSchema,
  UtcTimestampSchema,
  ValidationReportIdSchema,
  WorkspaceIdSchema,
  ActorSchema,
  EngineModeSchema,
  TrustLevelSchema,
  SeveritySchema,
  SourceOriginSchema,
} from './primitives';
import {
  BlockerStatusSchema,
  BlockerTypeSchema,
  ModuleStateSchema,
  RunStateSchema,
  StepKindSchema,
  StepStatusSchema,
  ProspectStateSchema,
} from './states';
import { BudgetPolicySchema, BudgetUsageSchema } from './budget';
import { EvidenceRefSchema, SourceLocatorSchema } from './refs';
import { ModuleContentSchema, ModuleKindSchema } from './content';

/* ------------------------------- workspace ------------------------------- */

export const WorkspaceSettingsSchema = z.object({
  /** Default off: auto-accept is an explicit, auditable policy (section 5.1). */
  autoAcceptVerifiedDrafts: z.boolean().default(false),
  pauseWhenPageCloses: z.boolean().default(false),
  defaultBudget: BudgetPolicySchema.optional(),
  providerProfileIds: z.array(z.string().min(1).max(100)).max(20).default([]),
  reducedMotion: z.boolean().default(false),
  theme: z.enum(['dark', 'system']).default('dark'),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  mode: EngineModeSchema,
  name: z.string().min(1).max(100),
  settings: WorkspaceSettingsSchema,
  policyVersion: z.string().min(1).max(64).default(POLICY_VERSION),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/* --------------------------------- task --------------------------------- */

export const ConstraintKindSchema = z.enum(['hard', 'preference', 'assumption']);
export type ConstraintKind = z.infer<typeof ConstraintKindSchema>;

export const ConstraintStatusSchema = z.enum(['open', 'confirmed', 'conflicted', 'waived']);
export type ConstraintStatus = z.infer<typeof ConstraintStatusSchema>;

export const ConstraintSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  kind: ConstraintKindSchema,
  status: ConstraintStatusSchema.default('open'),
  sourceRefs: z.array(z.object({ sourceId: SourceIdSchema, version: z.number().int().positive() })).max(8).default([]),
  note: z.string().max(1000).default(''),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const TASK_STATUSES = ['active', 'archived'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(8000),
  constraints: z.array(ConstraintSchema).max(64),
  artifactId: ArtifactIdSchema,
  revision: RevisionSchema,
  templateId: z.string().max(100).nullable().default(null),
  status: TaskStatusSchema.default('active'),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

/* ------------------------------- artifact ------------------------------- */

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  layer: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']).default('L3'),
  validatorId: z.string().max(100).nullable().default(null),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const ArtifactModuleSchema = z.object({
  id: ModuleIdSchema,
  artifactId: ArtifactIdSchema,
  title: z.string().min(1).max(200),
  kind: ModuleKindSchema,
  order: z.number().int().nonnegative().max(LIMITS.maxModulesPerArtifact),
  dependencies: z.array(ModuleIdSchema).max(LIMITS.maxModulesPerArtifact - 1).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(32).default([]),
  status: ModuleStateSchema.default('empty'),
  /** Restored when a blocker clears. */
  blockedFrom: ModuleStateSchema.nullable().default(null),
  acceptedVersionId: ArtifactVersionIdSchema.nullable().default(null),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});
export type ArtifactModule = z.infer<typeof ArtifactModuleSchema>;

export const ARTIFACT_STATUSES = ['draft', 'active', 'archived'] as const;
export const ArtifactStatusSchema = z.enum(ARTIFACT_STATUSES);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactSchema = z.object({
  id: ArtifactIdSchema,
  taskId: TaskIdSchema,
  title: z.string().min(1).max(200),
  moduleIds: z.array(ModuleIdSchema).min(1).max(LIMITS.maxModulesPerArtifact),
  /** Most recent accepted change across modules; module versions are per module. */
  acceptedVersionId: ArtifactVersionIdSchema.nullable().default(null),
  status: ArtifactStatusSchema.default('draft'),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Immutable module-scoped artifact version. Restore always creates a new version. */
export const ArtifactVersionSchema = z.object({
  id: ArtifactVersionIdSchema,
  artifactId: ArtifactIdSchema,
  moduleId: ModuleIdSchema,
  moduleKind: ModuleKindSchema,
  contentHash: ContentHashSchema,
  content: ModuleContentSchema,
  parentId: ArtifactVersionIdSchema.nullable(),
  baseVersionId: ArtifactVersionIdSchema.nullable(),
  sourceRunId: RunIdSchema.nullable(),
  patchId: PatchIdSchema.nullable(),
  validationReportId: ValidationReportIdSchema.nullable(),
  acceptedBy: z.string().min(1).max(100),
  acceptedAt: UtcTimestampSchema,
  note: z.string().max(2000).default(''),
  restoredFromVersionId: ArtifactVersionIdSchema.nullable().default(null),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

/* ---------------------------------- run ---------------------------------- */

export const RUN_ORIGINS = ['intent', 'recipe', 'synthesis'] as const;
export const RunOriginSchema = z.enum(RUN_ORIGINS);
export type RunOrigin = z.infer<typeof RunOriginSchema>;

export const RunErrorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().max(4000),
  retryable: z.boolean(),
  stage: z.enum(['planning', 'execution', 'validation', 'commit', 'recovery']),
  details: z.string().max(4000).default(''),
});
export type RunError = z.infer<typeof RunErrorSchema>;

export const InterruptionSchema = z.object({
  reason: z.enum(['process_terminated', 'lease_expired', 'stream_lost']),
  lastCheckpointId: CheckpointIdSchema.nullable(),
  unclearToolCalls: z.array(ToolCallIdSchema).max(64).default([]),
  interruptedAt: UtcTimestampSchema,
});
export type Interruption = z.infer<typeof InterruptionSchema>;

export const RunSchema = z.object({
  id: RunIdSchema,
  taskId: TaskIdSchema,
  moduleId: ModuleIdSchema,
  mode: EngineModeSchema,
  origin: RunOriginSchema.default('intent'),
  state: RunStateSchema,
  planVersion: z.number().int().nonnegative().default(0),
  contextSnapshotId: ContextSnapshotIdSchema.nullable().default(null),
  budgetPolicy: BudgetPolicySchema,
  budgetUsage: BudgetUsageSchema,
  baseVersionId: ArtifactVersionIdSchema.nullable().default(null),
  revision: RevisionSchema.default(0),
  /** State to restore when resuming from pause/input. */
  returnState: RunStateSchema.nullable().default(null),
  interrupted: InterruptionSchema.nullable().default(null),
  error: RunErrorSchema.nullable().default(null),
  checkpointId: CheckpointIdSchema.nullable().default(null),
  attempt: z.number().int().positive().default(1),
  autoAcceptPolicyApplied: z.boolean().default(false),
  queuePosition: z.number().int().nonnegative().nullable().default(null),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  startedAt: UtcTimestampSchema.nullable().default(null),
  finishedAt: UtcTimestampSchema.nullable().default(null),
});
export type Run = z.infer<typeof RunSchema>;

export const RUN_CHECKPOINT_KINDS = ['state', 'before_model', 'after_model', 'before_tool', 'after_tool', 'before_commit'] as const;
export const RunCheckpointKindSchema = z.enum(RUN_CHECKPOINT_KINDS);
export type RunCheckpointKind = z.infer<typeof RunCheckpointKindSchema>;

export const RunCheckpointSchema = z.object({
  id: CheckpointIdSchema,
  runId: RunIdSchema,
  kind: RunCheckpointKindSchema,
  stepId: StepIdSchema.nullable(),
  seqAtCheckpoint: z.number().int().nonnegative(),
  /** Bounded resume data: pending tool call ids, model call ids, last output refs. */
  dataJson: z.string().max(200_000),
  createdAt: UtcTimestampSchema,
});
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;

export const StepSchema = z.object({
  id: StepIdSchema,
  runId: RunIdSchema,
  kind: StepKindSchema,
  title: z.string().min(1).max(300),
  dependencies: z.array(StepIdSchema).max(16).default([]),
  inputRefsJson: z.string().max(20_000).default('[]'),
  outputRefs: z.array(z.string().max(200)).max(64).default([]),
  status: StepStatusSchema.default('pending'),
  attempt: z.number().int().positive().default(1),
  modelCallId: ModelCallIdSchema.nullable().default(null),
  toolCallIds: z.array(ToolCallIdSchema).max(32).default([]),
  summary: z.string().max(2000).default(''),
  errorJson: z.string().max(10_000).nullable().default(null),
  startedAt: UtcTimestampSchema.nullable().default(null),
  finishedAt: UtcTimestampSchema.nullable().default(null),
});
export type Step = z.infer<typeof StepSchema>;

/* -------------------------------- blocker -------------------------------- */

export const ResolutionOptionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal('choose'),
    label: z.string().min(1).max(200),
    detail: z.string().max(1000).default(''),
    options: z
      .array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1).max(200), description: z.string().max(500).default('') }))
      .min(2)
      .max(10),
  }),
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal('text'),
    label: z.string().min(1).max(200),
    detail: z.string().max(1000).default(''),
    placeholder: z.string().max(500).default(''),
    multiline: z.boolean().default(false),
    maxChars: z.number().int().positive().max(20_000).default(2000),
    required: z.boolean().default(true),
  }),
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal('bind_source'),
    label: z.string().min(1).max(200),
    detail: z.string().max(1000).default(''),
    acceptsMime: z.array(z.string().max(100)).max(16).default([]),
    purpose: z.string().max(500).default(''),
  }),
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal('confirm_mapping'),
    label: z.string().min(1).max(200),
    detail: z.string().max(1000).default(''),
    mappingPreview: z.array(z.object({ from: z.string().max(200), to: z.string().max(200), note: z.string().max(300).default('') })).max(100),
  }),
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal('exclude'),
    label: z.string().min(1).max(200),
    detail: z.string().max(1000).default(''),
    itemLabel: z.string().max(500),
    itemRef: z.string().max(500).default(''),
  }),
]);
export type ResolutionOption = z.infer<typeof ResolutionOptionSchema>;

export const BlockerResolutionSchema = z.object({
  optionId: z.string().min(1).max(64),
  value: z.unknown(),
  note: z.string().max(2000).default(''),
  decidedBy: z.string().min(1).max(100),
  decidedAt: UtcTimestampSchema,
});
export type BlockerResolution = z.infer<typeof BlockerResolutionSchema>;

export const BlockerSchema = z.object({
  id: BlockerIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  type: BlockerTypeSchema,
  severity: SeveritySchema,
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(4000),
  evidenceRefs: z.array(EvidenceRefSchema).max(32).default([]),
  affectedSteps: z.array(StepIdSchema).max(32).default([]),
  affectedModuleIds: z.array(ModuleIdSchema).max(8).default([]),
  resolutions: z.array(ResolutionOptionSchema).min(1).max(16),
  status: BlockerStatusSchema.default('open'),
  resolution: BlockerResolutionSchema.nullable().default(null),
  returnState: RunStateSchema.default('READY'),
  createdAt: UtcTimestampSchema,
  resolvedAt: UtcTimestampSchema.nullable().default(null),
  clearedAt: UtcTimestampSchema.nullable().default(null),
});
export type Blocker = z.infer<typeof BlockerSchema>;

export const DecisionSchema = z.object({
  id: DecisionIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  blockerId: BlockerIdSchema.nullable().default(null),
  planVersion: z.number().int().nonnegative().nullable().default(null),
  key: z.string().min(1).max(200),
  valueJson: z.string().max(20_000),
  note: z.string().max(2000).default(''),
  actor: ActorSchema,
  createdAt: UtcTimestampSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

/* --------------------------------- source --------------------------------- */

export const PARSE_STATUSES = ['parsed', 'unsupported', 'failed'] as const;
export const ParseStatusSchema = z.enum(PARSE_STATUSES);
export type ParseStatus = z.infer<typeof ParseStatusSchema>;

export const SourceItemSchema = z.object({
  id: SourceIdSchema,
  taskId: TaskIdSchema,
  name: z.string().min(1).max(300),
  mime: z.string().min(1).max(200),
  version: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  hash: Sha256HexSchema,
  origin: SourceOriginSchema,
  trustLevel: TrustLevelSchema,
  availability: z.enum(['available', 'missing', 'changed']).default('available'),
  parseStatus: ParseStatusSchema,
  parseNote: z.string().max(2000).default(''),
  createdAt: UtcTimestampSchema,
});
export type SourceItem = z.infer<typeof SourceItemSchema>;

export const SourceSpanSchema = z.object({
  id: SourceSpanIdSchema,
  sourceId: SourceIdSchema,
  version: z.number().int().positive(),
  locator: SourceLocatorSchema,
  quoteHash: Sha256HexSchema,
  excerpt: z.string().max(LIMITS.previewExcerptChars),
  createdAt: UtcTimestampSchema,
});
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

/* ----------------------------- context snapshot ----------------------------- */

export const CONTEXT_FRAGMENT_KINDS = [
  'system_policy',
  'user_goal',
  'hard_constraint',
  'confirmed_decision',
  'accepted_baseline',
  'source_span',
  'tool_result',
  'module_summary',
  'history',
] as const;
export const ContextFragmentKindSchema = z.enum(CONTEXT_FRAGMENT_KINDS);
export type ContextFragmentKind = z.infer<typeof ContextFragmentKindSchema>;

export const ContextFragmentSchema = z.object({
  id: z.string().min(1).max(100),
  priority: z.number().int().min(1).max(6),
  kind: ContextFragmentKindSchema,
  ref: z.string().max(500).nullable().default(null),
  contentHash: Sha256HexSchema.nullable().default(null),
  estimatedTokens: z.number().int().nonnegative(),
  included: z.boolean(),
  note: z.string().max(500).default(''),
});
export type ContextFragment = z.infer<typeof ContextFragmentSchema>;

export const ContextSnapshotSchema = z.object({
  id: ContextSnapshotIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  stepId: StepIdSchema.nullable().default(null),
  promptBundleVersion: z.string().min(1).max(64),
  promptTemplateHashes: z.record(z.string(), Sha256HexSchema).default({}),
  fragments: z.array(ContextFragmentSchema).max(1000),
  estimatedInputTokens: z.number().int().nonnegative(),
  omitted: z.array(z.object({ kind: z.string().max(100), reason: z.string().max(500) })).max(100).default([]),
  createdAt: UtcTimestampSchema,
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

/* -------------------------------- templates -------------------------------- */

export const ModuleTemplateSchema = z.object({
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  kind: ModuleKindSchema,
  order: z.number().int().nonnegative(),
  acceptanceCriteria: z.array(z.object({ text: z.string().min(1).max(2000), layer: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']).default('L3') })).max(32),
  dependsOnKeys: z.array(z.string().min(1).max(64)).max(LIMITS.maxModulesPerArtifact - 1).default([]),
  intentHint: z.string().max(2000).default(''),
});
export type ModuleTemplate = z.infer<typeof ModuleTemplateSchema>;

export const TaskTemplateSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  modules: z.array(ModuleTemplateSchema).min(1).max(LIMITS.maxModulesPerArtifact),
});
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

/* ------------------------------- projections ------------------------------- */

export const PatchQueueItemSchema = z.object({
  patchId: PatchIdSchema,
  moduleId: ModuleIdSchema,
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded', 'conflicted']),
  validationStatus: z.enum(['pass', 'fail', 'needs_review']).nullable(),
  createdAt: UtcTimestampSchema,
});
export type PatchQueueItem = z.infer<typeof PatchQueueItemSchema>;

export const ProspectPreviewSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  state: ProspectStateSchema,
  valueStatement: z.string().max(1000).default(''),
  requiredInputs: z.array(z.object({ moduleId: ModuleIdSchema, label: z.string().max(300), satisfied: z.boolean() })).max(8),
  missingInputs: z.array(z.string().max(300)).max(8).default([]),
  note: z.string().max(1000).default(''),
  /** True when the preview text is model-generated and therefore unverified. */
  candidateUnverified: z.boolean().default(false),
});
export type ProspectPreview = z.infer<typeof ProspectPreviewSchema>;

export const TaskRunSummarySchema = z.object({
  runId: RunIdSchema,
  moduleId: ModuleIdSchema,
  state: RunStateSchema,
  origin: RunOriginSchema,
  attempt: z.number().int().positive(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  activeStepTitle: z.string().max(300).nullable().default(null),
  errorSummary: z.string().max(1000).nullable().default(null),
});
export type TaskRunSummary = z.infer<typeof TaskRunSummarySchema>;

export const ValidationSummarySchema = z.object({
  validationReportId: ValidationReportIdSchema,
  moduleId: ModuleIdSchema,
  status: z.enum(['pass', 'fail', 'needs_review']),
  checkCounts: z.object({ pass: z.number().int().nonnegative(), fail: z.number().int().nonnegative(), needsReview: z.number().int().nonnegative(), notApplicable: z.number().int().nonnegative() }),
  blockingFindings: z.array(z.string().max(1000)).max(20),
  createdAt: UtcTimestampSchema,
});
export type ValidationSummary = z.infer<typeof ValidationSummarySchema>;

export const CommandMutexRecordSchema = z.object({
  commandId: CommandIdSchema,
  commandType: z.string().min(1).max(100),
  taskId: TaskIdSchema.nullable(),
  createdAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
  responseJson: z.string().max(1_000_000).nullable(),
});
export type CommandMutexRecord = z.infer<typeof CommandMutexRecordSchema>;


