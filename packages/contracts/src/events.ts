/**
 * Business event contracts.
 *
 * Every persisted state change emits exactly one of these events. Each type has
 * its own payload schema; payloads are validated at the storage boundary so no
 * `any` can leak through the run boundary.
 */
import { z } from 'zod';
import {
  BlockerIdSchema,
  ContextSnapshotIdSchema,
  EventIdSchema,
  ArtifactVersionIdSchema,
  ModuleIdSchema,
  PatchIdSchema,
  RunIdSchema,
  SeqSchema,
  StepIdSchema,
  TaskIdSchema,
  ToolCallIdSchema,
  UtcTimestampSchema,
  ValidationReportIdSchema,
  EVENT_SCHEMA_VERSION,
  ModelCallIdSchema,
  RecipeIdSchema,
  type TaskId,
  type RunId,
  type StepId,
  type EventId,
  type UtcTimestamp,
} from './primitives';
import { RunStateSchema } from './states';
import { PlanSchema } from './plan';
import { BlockerSchema } from './entities';
import { ToolIdSchema } from './tools';
import { ModelUsageSchema, FinishReasonSchema, ProviderErrorDetailSchema } from './model';
import { ValidationCheckSchema } from './validation';
import { ChangeSummarySchema } from './patch';

export const EVENT_CATEGORIES = ['plan', 'execution', 'tool', 'blocker', 'artifact', 'recipe', 'control', 'usage', 'context'] as const;
export const EventCategorySchema = z.enum(EVENT_CATEGORIES);
export type EventCategory = z.infer<typeof EventCategorySchema>;

/* ------------------------------- payloads ------------------------------- */

export const RunCreatedPayloadSchema = z.object({
  runId: RunIdSchema,
  taskId: TaskIdSchema,
  moduleId: ModuleIdSchema,
  origin: z.enum(['intent', 'recipe', 'synthesis']),
  baseVersionId: ArtifactVersionIdSchema.nullable(),
  budget: z.object({ maxModelRequests: z.number().int().positive(), maxToolCalls: z.number().int().positive() }),
});
export type RunCreatedPayload = z.infer<typeof RunCreatedPayloadSchema>;

export const PlanProposedPayloadSchema = z.object({
  runId: RunIdSchema,
  planVersion: z.number().int().positive(),
  plan: PlanSchema,
});
export type PlanProposedPayload = z.infer<typeof PlanProposedPayloadSchema>;

export const PlanRevisedPayloadSchema = z.object({
  runId: RunIdSchema,
  planVersion: z.number().int().positive(),
  reason: z.string().min(1).max(2000),
  plan: PlanSchema,
});
export type PlanRevisedPayload = z.infer<typeof PlanRevisedPayloadSchema>;

export const PlanReadyPayloadSchema = z.object({
  runId: RunIdSchema,
  planVersion: z.number().int().positive(),
});
export type PlanReadyPayload = z.infer<typeof PlanReadyPayloadSchema>;

export const PlanCommittedPayloadSchema = z.object({
  runId: RunIdSchema,
  planVersion: z.number().int().positive(),
  contextSnapshotId: ContextSnapshotIdSchema,
  committedBy: z.string().min(1).max(100),
});
export type PlanCommittedPayload = z.infer<typeof PlanCommittedPayloadSchema>;

export const RunStartedPayloadSchema = z.object({
  runId: RunIdSchema,
  attempt: z.number().int().positive(),
  planVersion: z.number().int().positive(),
});
export type RunStartedPayload = z.infer<typeof RunStartedPayloadSchema>;

export const StepStartedPayloadSchema = z.object({
  stepId: StepIdSchema,
  kind: z.enum(['context', 'model', 'tool', 'validate', 'repair', 'commit']),
  title: z.string().min(1).max(300),
  attempt: z.number().int().positive(),
});
export type StepStartedPayload = z.infer<typeof StepStartedPayloadSchema>;

export const StepCompletedPayloadSchema = z.object({
  stepId: StepIdSchema,
  kind: z.enum(['context', 'model', 'tool', 'validate', 'repair', 'commit']),
  summary: z.string().max(2000),
  outputRefs: z.array(z.string().max(200)).max(64),
});
export type StepCompletedPayload = z.infer<typeof StepCompletedPayloadSchema>;

export const StepFailedPayloadSchema = z.object({
  stepId: StepIdSchema,
  kind: z.enum(['context', 'model', 'tool', 'validate', 'repair', 'commit']),
  error: z.object({ code: z.string().max(100), message: z.string().max(4000), retryable: z.boolean() }),
});
export type StepFailedPayload = z.infer<typeof StepFailedPayloadSchema>;

export const ModelStartedPayloadSchema = z.object({
  modelCallId: ModelCallIdSchema,
  stepId: StepIdSchema,
  attempt: z.number().int().positive(),
  model: z.string().max(200),
  profileId: z.string().max(100),
});
export type ModelStartedPayload = z.infer<typeof ModelStartedPayloadSchema>;

export const ModelDeltaBatchPayloadSchema = z.object({
  modelCallId: ModelCallIdSchema,
  text: z.string().max(200_000),
  kind: z.enum(['output']).default('output'),
});
export type ModelDeltaBatchPayload = z.infer<typeof ModelDeltaBatchPayloadSchema>;

export const ModelFinishedPayloadSchema = z.object({
  modelCallId: ModelCallIdSchema,
  finishReason: FinishReasonSchema,
  usage: ModelUsageSchema,
  textLength: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type ModelFinishedPayload = z.infer<typeof ModelFinishedPayloadSchema>;

export const ToolRequestedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  stepId: StepIdSchema,
  toolId: ToolIdSchema,
  argumentsPreview: z.string().max(4000),
  argumentsHash: z.string().min(16).max(128),
});
export type ToolRequestedPayload = z.infer<typeof ToolRequestedPayloadSchema>;

export const ToolAuthorizedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  decision: z.enum(['allow', 'deny', 'require_approval']),
  reason: z.string().max(2000),
  scopes: z.array(z.string().max(64)).max(16),
});
export type ToolAuthorizedPayload = z.infer<typeof ToolAuthorizedPayloadSchema>;

export const ToolStartedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolId: ToolIdSchema,
  attempt: z.number().int().positive(),
});
export type ToolStartedPayload = z.infer<typeof ToolStartedPayloadSchema>;

export const ToolSucceededPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolId: ToolIdSchema,
  resultSummary: z.string().max(2000),
  resultObjectHash: z.string().max(64).nullable(),
  resultBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type ToolSucceededPayload = z.infer<typeof ToolSucceededPayloadSchema>;

export const ToolFailedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolId: ToolIdSchema,
  error: z.object({ code: z.string().max(100), message: z.string().max(4000), retryable: z.boolean() }),
  durationMs: z.number().int().nonnegative(),
});
export type ToolFailedPayload = z.infer<typeof ToolFailedPayloadSchema>;

export const ToolOutcomeUnknownPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolId: ToolIdSchema,
  detail: z.string().max(2000),
  retryRefused: z.boolean().default(true),
});
export type ToolOutcomeUnknownPayload = z.infer<typeof ToolOutcomeUnknownPayloadSchema>;

export const BlockerDetectedPayloadSchema = z.object({ blocker: BlockerSchema });
export type BlockerDetectedPayload = z.infer<typeof BlockerDetectedPayloadSchema>;

export const InputRequestedPayloadSchema = z.object({
  blockerId: BlockerIdSchema,
  title: z.string().min(1).max(300),
  resolutionOptionIds: z.array(z.string().max(64)).max(16),
});
export type InputRequestedPayload = z.infer<typeof InputRequestedPayloadSchema>;

export const InputResolvedPayloadSchema = z.object({
  blockerId: BlockerIdSchema,
  optionId: z.string().max(64),
  valuePreview: z.string().max(1000),
  decidedBy: z.string().min(1).max(100),
});
export type InputResolvedPayload = z.infer<typeof InputResolvedPayloadSchema>;

export const BlockerClearedPayloadSchema = z.object({
  blockerId: BlockerIdSchema,
  invalidatedSteps: z.array(StepIdSchema).max(64).default([]),
});
export type BlockerClearedPayload = z.infer<typeof BlockerClearedPayloadSchema>;

export const ArtifactPatchProposedPayloadSchema = z.object({
  patchId: PatchIdSchema,
  moduleId: ModuleIdSchema,
  baseVersionId: ArtifactVersionIdSchema.nullable(),
  candidateHash: z.string().min(64).max(64),
  validationReportId: ValidationReportIdSchema.nullable(),
  changeSummary: ChangeSummarySchema,
});
export type ArtifactPatchProposedPayload = z.infer<typeof ArtifactPatchProposedPayloadSchema>;

export const ValidationCompletedPayloadSchema = z.object({
  validationReportId: ValidationReportIdSchema,
  moduleId: ModuleIdSchema,
  status: z.enum(['pass', 'fail', 'needs_review']),
  checks: z.array(ValidationCheckSchema).max(500),
  summary: z.string().max(4000),
});
export type ValidationCompletedPayload = z.infer<typeof ValidationCompletedPayloadSchema>;

export const ArtifactAcceptedPayloadSchema = z.object({
  versionId: ArtifactVersionIdSchema,
  patchId: PatchIdSchema.nullable(),
  moduleId: ModuleIdSchema,
  contentHash: z.string().min(64).max(64),
  acceptedBy: z.string().min(1).max(100),
  note: z.string().max(2000).default(''),
  route: z.enum(['user_accept', 'auto_accept_policy']),
});
export type ArtifactAcceptedPayload = z.infer<typeof ArtifactAcceptedPayloadSchema>;

export const ArtifactStalePayloadSchema = z.object({
  artifactId: z.string().max(100),
  moduleId: ModuleIdSchema,
  reason: z.string().min(1).max(2000),
  staleRefs: z.array(z.string().max(200)).max(64).default([]),
});
export type ArtifactStalePayload = z.infer<typeof ArtifactStalePayloadSchema>;

export const ArtifactRestoredPayloadSchema = z.object({
  versionId: ArtifactVersionIdSchema,
  moduleId: ModuleIdSchema,
  restoredFromVersionId: ArtifactVersionIdSchema,
  acceptedBy: z.string().min(1).max(100),
});
export type ArtifactRestoredPayload = z.infer<typeof ArtifactRestoredPayloadSchema>;

export const RecipeProposedPayloadSchema = z.object({
  recipeId: RecipeIdSchema,
  version: z.number().int().positive(),
  kind: z.enum(['deterministic', 'llm_assisted', 'cached_snapshot']),
  name: z.string().min(1).max(200),
});
export type RecipeProposedPayload = z.infer<typeof RecipeProposedPayloadSchema>;

export const RecipeValidatedPayloadSchema = z.object({
  recipeId: RecipeIdSchema,
  version: z.number().int().positive(),
  fingerprint: z.string().min(1).max(200),
  testSummary: z.string().max(2000),
  testCases: z.number().int().nonnegative(),
});
export type RecipeValidatedPayload = z.infer<typeof RecipeValidatedPayloadSchema>;

export const RecipeStalePayloadSchema = z.object({
  recipeId: RecipeIdSchema,
  version: z.number().int().positive(),
  reason: z.string().min(1).max(2000),
});
export type RecipeStalePayload = z.infer<typeof RecipeStalePayloadSchema>;

export const RecipeRunStartedPayloadSchema = z.object({
  recipeId: RecipeIdSchema,
  version: z.number().int().positive(),
  runId: RunIdSchema,
  cached: z.boolean().default(false),
});
export type RecipeRunStartedPayload = z.infer<typeof RecipeRunStartedPayloadSchema>;

export const RunStateChangedPayloadSchema = z.object({
  from: RunStateSchema,
  to: RunStateSchema,
  reason: z.string().max(2000),
});
export type RunStateChangedPayload = z.infer<typeof RunStateChangedPayloadSchema>;

export const RunQueuedPayloadSchema = z.object({
  runId: RunIdSchema,
  position: z.number().int().nonnegative(),
});
export type RunQueuedPayload = z.infer<typeof RunQueuedPayloadSchema>;

export const RunPauseRequestedPayloadSchema = z.object({
  runId: RunIdSchema,
  requestedBy: z.string().min(1).max(100),
  commandId: z.string().max(100),
});
export type RunPauseRequestedPayload = z.infer<typeof RunPauseRequestedPayloadSchema>;

export const RunPausedPayloadSchema = z.object({
  runId: RunIdSchema,
  returnState: RunStateSchema,
  completedSteps: z.number().int().nonnegative(),
  pendingSteps: z.number().int().nonnegative(),
  atSafeBoundary: z.boolean(),
  note: z.string().max(1000).default(''),
});
export type RunPausedPayload = z.infer<typeof RunPausedPayloadSchema>;

export const RunResumedPayloadSchema = z.object({
  runId: RunIdSchema,
  attempt: z.number().int().positive(),
  resumeMode: z.enum(['from_checkpoint', 'requires_revalidation', 'new_attempt']),
});
export type RunResumedPayload = z.infer<typeof RunResumedPayloadSchema>;

export const RunCancelRequestedPayloadSchema = z.object({
  runId: RunIdSchema,
  requestedBy: z.string().min(1).max(100),
  commandId: z.string().max(100),
});
export type RunCancelRequestedPayload = z.infer<typeof RunCancelRequestedPayloadSchema>;

export const RunCancelledPayloadSchema = z.object({
  runId: RunIdSchema,
  reason: z.string().max(2000),
  draftPreserved: z.boolean().default(true),
  acceptedVersionUnchanged: z.boolean().default(true),
});
export type RunCancelledPayload = z.infer<typeof RunCancelledPayloadSchema>;

export const RunInterruptedPayloadSchema = z.object({
  runId: RunIdSchema,
  lastCheckpointId: z.string().max(100).nullable(),
  unclearToolCalls: z.array(ToolCallIdSchema).max(64),
  reason: z.enum(['process_terminated', 'lease_expired', 'stream_lost']),
});
export type RunInterruptedPayload = z.infer<typeof RunInterruptedPayloadSchema>;

export const RunFailedPayloadSchema = z.object({
  runId: RunIdSchema,
  error: z.object({
    code: z.string().max(100),
    message: z.string().max(4000),
    retryable: z.boolean(),
    stage: z.enum(['planning', 'execution', 'validation', 'commit', 'recovery']),
  }),
  draftPreserved: z.boolean().default(true),
  acceptedVersionUnchanged: z.boolean().default(true),
});
export type RunFailedPayload = z.infer<typeof RunFailedPayloadSchema>;

export const RunCompletedPayloadSchema = z.object({
  runId: RunIdSchema,
  versionId: ArtifactVersionIdSchema,
  moduleId: ModuleIdSchema,
});
export type RunCompletedPayload = z.infer<typeof RunCompletedPayloadSchema>;

export const UsageUpdatedPayloadSchema = z.object({
  modelRequests: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
  usdCost: z.number().nonnegative().nullable(),
});
export type UsageUpdatedPayload = z.infer<typeof UsageUpdatedPayloadSchema>;

export const BudgetWarningPayloadSchema = z.object({
  resource: z.enum(['model_requests', 'tool_calls', 'run_duration', 'cost']),
  used: z.number().nonnegative(),
  limit: z.number().nonnegative(),
});
export type BudgetWarningPayload = z.infer<typeof BudgetWarningPayloadSchema>;

export const BudgetExhaustedPayloadSchema = z.object({
  resource: z.enum(['model_requests', 'tool_calls', 'run_duration', 'cost']),
  used: z.number().nonnegative(),
  limit: z.number().nonnegative(),
  message: z.string().max(1000),
});
export type BudgetExhaustedPayload = z.infer<typeof BudgetExhaustedPayloadSchema>;

export const ContextSnapshotCreatedPayloadSchema = z.object({
  contextSnapshotId: ContextSnapshotIdSchema,
  runId: RunIdSchema,
  stepId: StepIdSchema.nullable(),
  estimatedTokens: z.number().int().nonnegative(),
  fragmentCount: z.number().int().nonnegative(),
  omittedCount: z.number().int().nonnegative(),
});
export type ContextSnapshotCreatedPayload = z.infer<typeof ContextSnapshotCreatedPayloadSchema>;

export const ProviderErrorPayloadSchema = z.object({
  runId: RunIdSchema,
  stage: z.enum(['planning', 'execution', 'validation']),
  error: ProviderErrorDetailSchema,
});
export type ProviderErrorPayload = z.infer<typeof ProviderErrorPayloadSchema>;

/* ------------------------------ event table ------------------------------ */

export const EVENT_PAYLOAD_SCHEMAS = {
  'run.created': RunCreatedPayloadSchema,
  'plan.proposed': PlanProposedPayloadSchema,
  'plan.revised': PlanRevisedPayloadSchema,
  'plan.ready': PlanReadyPayloadSchema,
  'plan.committed': PlanCommittedPayloadSchema,
  'run.started': RunStartedPayloadSchema,
  'step.started': StepStartedPayloadSchema,
  'step.completed': StepCompletedPayloadSchema,
  'step.failed': StepFailedPayloadSchema,
  'model.started': ModelStartedPayloadSchema,
  'model.delta_batch': ModelDeltaBatchPayloadSchema,
  'model.finished': ModelFinishedPayloadSchema,
  'tool.requested': ToolRequestedPayloadSchema,
  'tool.authorized': ToolAuthorizedPayloadSchema,
  'tool.started': ToolStartedPayloadSchema,
  'tool.succeeded': ToolSucceededPayloadSchema,
  'tool.failed': ToolFailedPayloadSchema,
  'tool.outcome_unknown': ToolOutcomeUnknownPayloadSchema,
  'blocker.detected': BlockerDetectedPayloadSchema,
  'input.requested': InputRequestedPayloadSchema,
  'input.resolved': InputResolvedPayloadSchema,
  'blocker.cleared': BlockerClearedPayloadSchema,
  'artifact.patch_proposed': ArtifactPatchProposedPayloadSchema,
  'validation.completed': ValidationCompletedPayloadSchema,
  'artifact.accepted': ArtifactAcceptedPayloadSchema,
  'artifact.stale': ArtifactStalePayloadSchema,
  'artifact.restored': ArtifactRestoredPayloadSchema,
  'recipe.proposed': RecipeProposedPayloadSchema,
  'recipe.validated': RecipeValidatedPayloadSchema,
  'recipe.stale': RecipeStalePayloadSchema,
  'recipe.run_started': RecipeRunStartedPayloadSchema,
  'run.state_changed': RunStateChangedPayloadSchema,
  'run.queued': RunQueuedPayloadSchema,
  'run.pause_requested': RunPauseRequestedPayloadSchema,
  'run.paused': RunPausedPayloadSchema,
  'run.resumed': RunResumedPayloadSchema,
  'run.cancel_requested': RunCancelRequestedPayloadSchema,
  'run.cancelled': RunCancelledPayloadSchema,
  'run.interrupted': RunInterruptedPayloadSchema,
  'run.failed': RunFailedPayloadSchema,
  'run.completed': RunCompletedPayloadSchema,
  'usage.updated': UsageUpdatedPayloadSchema,
  'budget.warning': BudgetWarningPayloadSchema,
  'budget.exhausted': BudgetExhaustedPayloadSchema,
  'context.snapshot_created': ContextSnapshotCreatedPayloadSchema,
  'provider.error': ProviderErrorPayloadSchema,
} as const;

export type EventPayloads = {
  [K in keyof typeof EVENT_PAYLOAD_SCHEMAS]: z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>;
};

export const EVENT_TYPES = Object.keys(EVENT_PAYLOAD_SCHEMAS) as Array<keyof typeof EVENT_PAYLOAD_SCHEMAS>;
export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

export const EVENT_CATEGORY_BY_TYPE: Readonly<Record<EventType, EventCategory>> = {
  'run.created': 'plan',
  'plan.proposed': 'plan',
  'plan.revised': 'plan',
  'plan.ready': 'plan',
  'plan.committed': 'plan',
  'run.started': 'execution',
  'step.started': 'execution',
  'step.completed': 'execution',
  'step.failed': 'execution',
  'model.started': 'execution',
  'model.delta_batch': 'execution',
  'model.finished': 'execution',
  'tool.requested': 'tool',
  'tool.authorized': 'tool',
  'tool.started': 'tool',
  'tool.succeeded': 'tool',
  'tool.failed': 'tool',
  'tool.outcome_unknown': 'tool',
  'blocker.detected': 'blocker',
  'input.requested': 'blocker',
  'input.resolved': 'blocker',
  'blocker.cleared': 'blocker',
  'artifact.patch_proposed': 'artifact',
  'validation.completed': 'artifact',
  'artifact.accepted': 'artifact',
  'artifact.stale': 'artifact',
  'artifact.restored': 'artifact',
  'recipe.proposed': 'recipe',
  'recipe.validated': 'recipe',
  'recipe.stale': 'recipe',
  'recipe.run_started': 'recipe',
  'run.state_changed': 'control',
  'run.queued': 'control',
  'run.pause_requested': 'control',
  'run.paused': 'control',
  'run.resumed': 'control',
  'run.cancel_requested': 'control',
  'run.cancelled': 'control',
  'run.interrupted': 'control',
  'run.failed': 'control',
  'run.completed': 'control',
  'usage.updated': 'usage',
  'budget.warning': 'usage',
  'budget.exhausted': 'usage',
  'context.snapshot_created': 'context',
  'provider.error': 'usage',
};

/* -------------------------------- envelope -------------------------------- */

export const HarnessEventBaseSchema = z.object({
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  eventId: EventIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema.nullable(),
  stepId: StepIdSchema.nullable().default(null),
  seq: SeqSchema,
  causationId: z.string().min(1).max(100).nullable().default(null),
  type: z.enum(EVENT_TYPES as unknown as [EventType, ...EventType[]]),
  category: EventCategorySchema,
  payload: z.record(z.string(), z.unknown()),
  timestamp: UtcTimestampSchema,
});
export type HarnessEventBase = z.infer<typeof HarnessEventBaseSchema>;

export type HarnessEvent = {
  [K in EventType]: Omit<HarnessEventBase, 'type' | 'payload'> & { type: K; payload: EventPayloads[K] };
}[EventType];

/**
 * Validate an event at the storage/API boundary: envelope, category consistency
 * and the per-type payload schema.
 */
export const HarnessEventSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    eventId: EventIdSchema,
    taskId: TaskIdSchema,
    runId: RunIdSchema.nullable(),
    stepId: StepIdSchema.nullable(),
    seq: SeqSchema,
    causationId: z.string().min(1).max(200).nullable(),
    type: z.enum(EVENT_TYPES as unknown as [EventType, ...EventType[]]),
    category: EventCategorySchema,
    payload: z.record(z.string(), z.unknown()),
    timestamp: UtcTimestampSchema,
  })
  .superRefine((event, ctx) => {
    const expectedCategory = EVENT_CATEGORY_BY_TYPE[event.type];
    if (event.category !== expectedCategory) {
      ctx.addIssue({
        code: 'custom',
        path: ['category'],
        message: `category ${event.category} does not match event type ${event.type} (expected ${expectedCategory})`,
      });
    }
    const schema = EVENT_PAYLOAD_SCHEMAS[event.type] as z.ZodType<unknown>;
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', ...issue.path],
          message: issue.message,
        });
      }
    }
  });

export function parseHarnessEvent(raw: unknown): HarnessEvent {
  return HarnessEventSchema.parse(raw) as HarnessEvent;
}

/** Parse and validate a payload for a given event type (used by event builders). */
export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayloads[T] {
  const schema = EVENT_PAYLOAD_SCHEMAS[type] as unknown as z.ZodType<EventPayloads[T]>;
  return schema.parse(payload);
}

export interface HarnessEventInput<T extends EventType = EventType> {
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  readonly stepId: StepId | null;
  readonly seq: number;
  readonly causationId: string | null;
  readonly type: T;
  readonly payload: EventPayloads[T];
  readonly eventId: EventId;
  readonly timestamp: UtcTimestamp;
}

/** Build a fully validated event (categories and schemaVersion are derived). */
export function makeHarnessEvent<T extends EventType>(input: HarnessEventInput<T>): HarnessEvent {
  const event = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: input.eventId,
    taskId: input.taskId,
    runId: input.runId,
    stepId: input.stepId,
    seq: input.seq,
    causationId: input.causationId,
    type: input.type,
    category: EVENT_CATEGORY_BY_TYPE[input.type],
    payload: parseEventPayload(input.type, input.payload),
    timestamp: input.timestamp,
  } as HarnessEvent;
  return event;
}

/* -------------------------------- helpers -------------------------------- */

/** Event types that are pure view hints and never business events. */
export const NON_BUSINESS_EVENT_NOTE =
  'Perspective, panel expansion, selection and unsubmitted input MUST NOT enter the business event stream.';

export function eventsInCategory(events: readonly HarnessEvent[], category: EventCategory): HarnessEvent[] {
  return events.filter((event) => event.category === category);
}

/** Deduplicate by eventId; API consumers also ignore duplicate seq numbers. */
export function dedupeEvents<T extends { eventId: string; seq: number }>(events: readonly T[]): T[] {
  const seenIds = new Set<string>();
  const seenSeq = new Set<number>();
  const out: T[] = [];
  for (const event of events) {
    if (seenIds.has(event.eventId) || seenSeq.has(event.seq)) continue;
    seenIds.add(event.eventId);
    seenSeq.add(event.seq);
    out.push(event);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Detect holes in a task event stream (client-side resume guard). */
export function findSeqGaps(events: readonly { seq: number }[], fromSeq: number): number[] {
  const seqs = new Set(events.map((e) => e.seq));
  const gaps: number[] = [];
  if (events.length === 0) return gaps;
  const max = Math.max(...seqs);
  for (let seq = fromSeq; seq <= max; seq += 1) {
    if (!seqs.has(seq)) gaps.push(seq);
  }
  return gaps;
}

export const TERMINAL_EVENT_TYPES: readonly EventType[] = [
  'run.completed',
  'run.cancelled',
  'run.failed',
];
