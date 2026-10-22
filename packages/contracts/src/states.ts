/**
 * Explicit state machines and their transition tables.
 *
 * The same tables are used by the server (persistence guards), the harness
 * (scheduler) and tests (illegal transition coverage). No UI animation or
 * timer may alter these transitions.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* RunState                                                            */
/* ------------------------------------------------------------------ */

export const RUN_STATES = [
  'CREATED',
  'PLANNING',
  'AWAITING_INPUT',
  'READY',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'VALIDATING',
  'AWAITING_REVIEW',
  'COMMITTING',
  'COMPLETED',
  'CANCELLING',
  'CANCELLED',
  'FAILED',
  'INTERRUPTED',
] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

export const TERMINAL_RUN_STATES: readonly RunState[] = ['COMPLETED', 'CANCELLED', 'FAILED'];
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  'CREATED',
  'PLANNING',
  'AWAITING_INPUT',
  'READY',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'VALIDATING',
  'AWAITING_REVIEW',
  'COMMITTING',
  'CANCELLING',
  'INTERRUPTED',
];

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/** States from which a user-visible pause request is meaningful. */
export const PAUSABLE_RUN_STATES: readonly RunState[] = ['PLANNING', 'READY', 'RUNNING', 'VALIDATING'];

/** States in which a cancel request is accepted. */
export const CANCELLABLE_RUN_STATES: readonly RunState[] = [
  'CREATED',
  'PLANNING',
  'AWAITING_INPUT',
  'READY',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'VALIDATING',
  'AWAITING_REVIEW',
  'CANCELLING',
  'INTERRUPTED',
];

/**
 * Allowed state transitions. Keys are source states; values are the states the
 * kernel may enter. CREATED is entered by task command, COMMITTED etc. are not
 * reachable outside the table.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  CREATED: ['PLANNING', 'CANCELLING', 'FAILED'],
  PLANNING: ['AWAITING_INPUT', 'READY', 'CANCELLING', 'FAILED'],
  AWAITING_INPUT: ['READY', 'RUNNING', 'PAUSING', 'CANCELLING', 'FAILED'],
  READY: ['RUNNING', 'AWAITING_INPUT', 'PAUSING', 'CANCELLING', 'FAILED'],
  RUNNING: [
    'AWAITING_INPUT',
    'VALIDATING',
    'PAUSING',
    'CANCELLING',
    'FAILED',
    'INTERRUPTED',
  ],
  PAUSING: ['PAUSED', 'FAILED'],
  PAUSED: ['READY', 'RUNNING', 'VALIDATING', 'CANCELLING', 'FAILED'],
  VALIDATING: ['RUNNING', 'AWAITING_REVIEW', 'AWAITING_INPUT', 'PAUSING', 'CANCELLING', 'FAILED', 'INTERRUPTED'],
  AWAITING_REVIEW: ['COMMITTING', 'RUNNING', 'CANCELLING', 'FAILED'],
  COMMITTING: ['COMPLETED', 'AWAITING_REVIEW', 'FAILED'],
  COMPLETED: [],
  CANCELLING: ['CANCELLED', 'FAILED'],
  CANCELLED: [],
  FAILED: [],
  INTERRUPTED: ['READY', 'RUNNING', 'PAUSED', 'CANCELLING', 'FAILED'],
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/** Reason used when a transition is rejected; callers surface this verbatim. */
export function illegalRunTransitionMessage(from: RunState, to: RunState): string {
  return `run state transition not allowed: ${from} -> ${to}`;
}

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

export const MODULE_STATES = ['empty', 'draft', 'ready_for_review', 'accepted', 'stale', 'blocked'] as const;
export const ModuleStateSchema = z.enum(MODULE_STATES);
export type ModuleState = z.infer<typeof ModuleStateSchema>;

export const MODULE_TRANSITIONS: Readonly<Record<ModuleState, readonly ModuleState[]>> = {
  empty: ['draft', 'blocked'],
  draft: ['ready_for_review', 'empty', 'stale', 'blocked'],
  ready_for_review: ['accepted', 'draft', 'stale', 'blocked'],
  accepted: ['stale', 'blocked'],
  stale: ['draft', 'empty', 'blocked'],
  blocked: ['empty', 'draft', 'ready_for_review', 'accepted', 'stale'],
};

/** States a module may be blocked from; used to restore after the blocker clears. */
export const MODULE_BLOCKABLE_FROM: readonly ModuleState[] = ['empty', 'draft', 'ready_for_review', 'accepted', 'stale'];

export function canTransitionModule(from: ModuleState, to: ModuleState): boolean {
  return MODULE_TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ */
/* Blocker state                                                       */
/* ------------------------------------------------------------------ */

export const BLOCKER_TYPES = [
  'info_missing',
  'constraint_conflict',
  'validation_failed',
  'no_progress',
  'service_failure',
  'permission_denied',
] as const;
export const BlockerTypeSchema = z.enum(BLOCKER_TYPES);
export type BlockerType = z.infer<typeof BlockerTypeSchema>;

export const BLOCKER_STATUSES = ['open', 'resolved', 'cleared', 'cancelled'] as const;
export const BlockerStatusSchema = z.enum(BLOCKER_STATUSES);
export type BlockerStatus = z.infer<typeof BlockerStatusSchema>;

/** Blockers from technical failures must never be presented as business choices. */
export const TECHNICAL_BLOCKER_TYPES: readonly BlockerType[] = ['service_failure', 'permission_denied'];

/* ------------------------------------------------------------------ */
/* Recipe state                                                        */
/* ------------------------------------------------------------------ */

export const RECIPE_STATUSES = ['candidate', 'validated', 'stale', 'disabled'] as const;
export const RecipeStatusSchema = z.enum(RECIPE_STATUSES);
export type RecipeStatus = z.infer<typeof RecipeStatusSchema>;

/** Only validated recipes may run. */
export function canRunRecipe(status: RecipeStatus): boolean {
  return status === 'validated';
}

export const RECIPE_TRANSITIONS: Readonly<Record<RecipeStatus, readonly RecipeStatus[]>> = {
  candidate: ['validated', 'disabled'],
  validated: ['stale', 'disabled'],
  stale: ['validated', 'disabled'],
  disabled: ['validated'],
};

export const RECIPE_KINDS = ['deterministic', 'llm_assisted', 'cached_snapshot'] as const;
export const RecipeKindSchema = z.enum(RECIPE_KINDS);
export type RecipeKind = z.infer<typeof RecipeKindSchema>;

/* ------------------------------------------------------------------ */
/* Plan review state (mechanism A; UI-local, not a business state)     */
/* ------------------------------------------------------------------ */

export const PLAN_REVIEW_PHASES = ['idle', 'planning', 'peeking', 'resolving', 'ready', 'executing', 'review', 'failed'] as const;
export const PlanReviewPhaseSchema = z.enum(PLAN_REVIEW_PHASES);
export type PlanReviewPhase = z.infer<typeof PlanReviewPhaseSchema>;

/* ------------------------------------------------------------------ */
/* High-ledge candidate state                                          */
/* ------------------------------------------------------------------ */

export const PROSPECT_STATES = ['proposed', 'missing_inputs', 'ready', 'generating', 'review', 'accepted', 'stale'] as const;
export const ProspectStateSchema = z.enum(PROSPECT_STATES);
export type ProspectState = z.infer<typeof ProspectStateSchema>;

/* ------------------------------------------------------------------ */
/* Validation layers                                                   */
/* ------------------------------------------------------------------ */

export const VALIDATION_LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export const ValidationLayerSchema = z.enum(VALIDATION_LAYERS);
export type ValidationLayer = z.infer<typeof ValidationLayerSchema>;

export const CHECK_STATUSES = ['pass', 'fail', 'needs_review', 'not_applicable'] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** Deterministic gate: only L0-L3 failures block commit automatically. */
export function isBlockingCheck(layer: ValidationLayer, status: CheckStatus): boolean {
  return layer !== 'L4' && (status === 'fail' || status === 'needs_review');
}

/* ------------------------------------------------------------------ */
/* Step kinds                                                          */
/* ------------------------------------------------------------------ */

export const STEP_KINDS = ['context', 'model', 'tool', 'validate', 'repair', 'commit'] as const;
export const StepKindSchema = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof StepKindSchema>;

export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;
