/**
 * @ca/harness — UI-independent execution kernel. See ./types.ts.
 *
 * Public API:
 * - createHarnessEngine / createArtifactValidator
 * - context builder + versioned prompt bundle exports
 * - deterministic hashing/token helpers used by the server and tests
 */
export * from './types';
export * from './engine';
export * from './validator';
export * from './prompts';

export { buildContext, summarizeContent, renderModuleContent, type ContextBuildOptions } from './context';
export { contentHash, estimateTokens, sha256Hex, truncateBytes, truncateChars } from './hashing';
export {
  detectConstraintConflicts,
  deterministicRisks,
  constraintConflictDecisionKey,
  type ConstraintConflict,
} from './risk-rules';
export {
  parseCandidateOutput,
  type ExecutorCheckpoint,
  type ExecutorOutcome,
} from './executor';
export {
  parsePlannerOutput,
  buildPlanBlockerSpecs,
  revisePlanAfterDecisions,
  validatePlanDocument,
  PlannerOutputSchema,
  type PlanStageOutcome,
} from './planner';
export {
  recoverInterruptedRuns,
  type RecoveryOptions,
} from './recovery';
