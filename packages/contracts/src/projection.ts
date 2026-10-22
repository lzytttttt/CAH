/** Server-built spatial projection: the UI renders this, it never invents state. */
import { z } from 'zod';
import {
  ArtifactVersionIdSchema,
  LIMITS,
  ModuleIdSchema,
  PatchIdSchema,
  RunIdSchema,
  SourceIdSchema,
  SourceSpanIdSchema,
  StepIdSchema,
  BlockerIdSchema,
  UtcTimestampSchema,
  ValidationReportIdSchema,
} from './primitives';
import {
  ModuleStateSchema,
  PlanReviewPhaseSchema,
  ProspectStateSchema,
  RunStateSchema,
} from './states';

export const SPATIAL_LAYERS = ['global', 'execution', 'evidence', 'prospect'] as const;
export const SpatialLayerSchema = z.enum(SPATIAL_LAYERS);
export type SpatialLayer = z.infer<typeof SpatialLayerSchema>;

export const SPATIAL_NODE_KINDS = [
  'hub',
  'module',
  'run',
  'step',
  'tool',
  'patch',
  'blocker',
  'source',
  'span',
  'validation',
  'recipe',
  'prospect',
  'constraint',
] as const;
export const SpatialNodeKindSchema = z.enum(SPATIAL_NODE_KINDS);
export type SpatialNodeKind = z.infer<typeof SpatialNodeKindSchema>;

export const SPATIAL_EDGE_KINDS = ['dependency', 'flow', 'evidence', 'trace', 'binding'] as const;
export const SpatialEdgeKindSchema = z.enum(SPATIAL_EDGE_KINDS);
export type SpatialEdgeKind = z.infer<typeof SpatialEdgeKindSchema>;

/** Coarse status used for color + text labels. Never color alone. */
export const SPATIAL_NODE_STATUSES = [
  'idle',
  'empty',
  'draft',
  'ready_for_review',
  'accepted',
  'stale',
  'blocked',
  'running',
  'warning',
  'failed',
  'paused',
  'completed',
  'cancelled',
  'unknown',
] as const;
export const SpatialNodeStatusSchema = z.enum(SPATIAL_NODE_STATUSES);
export type SpatialNodeStatus = z.infer<typeof SpatialNodeStatusSchema>;

export const SpatialNodeSchema = z.object({
  id: z.string().min(1).max(200),
  kind: SpatialNodeKindSchema,
  layer: SpatialLayerSchema,
  title: z.string().min(1).max(300),
  status: SpatialNodeStatusSchema,
  summary: z.string().max(1000).default(''),
  moduleId: ModuleIdSchema.nullable().default(null),
  runId: RunIdSchema.nullable().default(null),
  stepId: StepIdSchema.nullable().default(null),
  refId: z.string().max(200).nullable().default(null),
  badgeCount: z.number().int().nonnegative().nullable().default(null),
  /** Short relative order inside its lane; layout positions stay in ViewState. */
  laneHint: z.number().int().nonnegative().default(0),
});
export type SpatialNode = z.infer<typeof SpatialNodeSchema>;

export const SpatialEdgeSchema = z.object({
  id: z.string().min(1).max(300),
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
  kind: SpatialEdgeKindSchema,
  label: z.string().max(200).default(''),
});
export type SpatialEdge = z.infer<typeof SpatialEdgeSchema>;

export const StageSummarySchema = z.object({
  phase: PlanReviewPhaseSchema,
  label: z.string().min(1).max(200),
  /** Step-based progress only; never a fabricated percentage of overall success. */
  completedSteps: z.number().int().nonnegative().nullable().default(null),
  totalSteps: z.number().int().nonnegative().nullable().default(null),
  activeStepTitle: z.string().max(300).nullable().default(null),
  note: z.string().max(1000).default(''),
});
export type StageSummary = z.infer<typeof StageSummarySchema>;

export const HiddenCountsSchema = z.object({
  branchCount: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  collapsedNodes: z.number().int().nonnegative().default(0),
  byKind: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type HiddenCounts = z.infer<typeof HiddenCountsSchema>;

export const SpatialProjectionSchema = z.object({
  nodes: z.array(SpatialNodeSchema).max(LIMITS.maxSpatialNodes * 12),
  edges: z.array(SpatialEdgeSchema).max(LIMITS.maxSpatialEdges * 12),
  stage: StageSummarySchema,
  counts: HiddenCountsSchema,
  activeBranchId: z.string().max(200).nullable().default(null),
  focusHint: z.string().max(500).default(''),
});
export type SpatialProjection = z.infer<typeof SpatialProjectionSchema>;

export const ModuleAcceptanceSummarySchema = z.object({
  moduleId: ModuleIdSchema,
  status: ModuleStateSchema,
  acceptedVersionId: ArtifactVersionIdSchema.nullable(),
  acceptedAt: UtcTimestampSchema.nullable(),
  acceptedSummary: z.string().max(500).nullable(),
  acceptedContentHash: z.string().max(64).nullable(),
  pendingPatchId: PatchIdSchema.nullable(),
  pendingValidationReportId: ValidationReportIdSchema.nullable(),
  pendingValidationStatus: z.enum(['pass', 'fail', 'needs_review']).nullable(),
  staleReason: z.string().max(500).nullable(),
  openBlockerIds: z.array(BlockerIdSchema).max(8).default([]),
});
export type ModuleAcceptanceSummary = z.infer<typeof ModuleAcceptanceSummarySchema>;

export const EvidenceSummarySchema = z.object({
  sourceId: SourceIdSchema,
  name: z.string().max(300),
  version: z.number().int().positive(),
  availability: z.enum(['available', 'missing', 'changed']),
  spanCount: z.number().int().nonnegative(),
  trustLevel: z.enum(['user_provided', 'synthetic_demo', 'unknown']),
  previewSpanIds: z.array(SourceSpanIdSchema).max(5).default([]),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;

export const ProspectProjectionSchema = z.object({
  id: z.string().max(100),
  title: z.string().max(300),
  state: ProspectStateSchema,
  valueStatement: z.string().max(1000).default(''),
  requiredInputs: z.array(
    z.object({
      moduleId: ModuleIdSchema,
      label: z.string().max(300),
      satisfied: z.boolean(),
      moduleStatus: ModuleStateSchema,
    }),
  ).max(8),
  missingInputs: z.array(z.string().max(300)).max(8).default([]),
  note: z.string().max(1000).default(''),
  candidateUnverified: z.boolean().default(false),
  targetModuleId: ModuleIdSchema.nullable().default(null),
  sourceModuleId: ModuleIdSchema.nullable().default(null),
});
export type ProspectProjection = z.infer<typeof ProspectProjectionSchema>;

export const RunControlProjectionSchema = z.object({
  runId: RunIdSchema.nullable(),
  state: RunStateSchema.nullable(),
  canPause: z.boolean(),
  canResume: z.boolean(),
  canCancel: z.boolean(),
  budgetLabel: z.string().max(500),
  providerLabel: z.string().max(300),
  connectionStatus: z.enum(['configured', 'unconfigured', 'error', 'unknown']),
  queuePosition: z.number().int().nonnegative().nullable().default(null),
  unsavedDraft: z.boolean().default(false),
});
export type RunControlProjection = z.infer<typeof RunControlProjectionSchema>;
