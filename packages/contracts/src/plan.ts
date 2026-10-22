/** Plan documents: explainable plan summary with schema-validated steps and risks. */
import { z } from 'zod';
import {
  LIMITS,
  ModuleIdSchema,
  RunIdSchema,
  UtcTimestampSchema,
} from './primitives';
import { BudgetPolicySchema } from './budget';
import { EvidenceRefSchema, InputRefSchema } from './refs';
import { ModuleKindSchema } from './content';
import { ToolIdSchema } from './tools';
import { ValidationLayerSchema } from './states';

export const PlanStepSchema = z.object({
  /** Stable id inside a plan, e.g. `s1`. Never a canvas coordinate. */
  id: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  title: z.string().min(1).max(200),
  kind: z.enum(['tool', 'model', 'validate', 'compose']),
  dependencies: z.array(z.string().min(1).max(64)).max(32).default([]),
  toolId: ToolIdSchema.nullable().default(null),
  description: z.string().max(2000).default(''),
  expectedOutput: z.string().max(1000).default(''),
  inputRefs: z.array(InputRefSchema).max(32).default([]),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanToolRequirementSchema = z.object({
  toolId: ToolIdSchema,
  reason: z.string().min(1).max(1000),
  effect: z.enum(['read', 'draft_write', 'external_write']),
});
export type PlanToolRequirement = z.infer<typeof PlanToolRequirementSchema>;

export const PlanSkeletonItemSchema = z.object({
  moduleId: ModuleIdSchema,
  moduleKind: ModuleKindSchema,
  sections: z.array(z.string().min(1).max(200)).max(64).default([]),
  expectedContentSummary: z.string().max(1000).default(''),
});
export type PlanSkeletonItem = z.infer<typeof PlanSkeletonItemSchema>;

export const AssumptionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  needsConfirmation: z.boolean().default(true),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const OpenQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  question: z.string().min(1).max(2000),
  blocking: z.boolean().default(false),
  /** Why the kernel cannot decide this without the user. */
  reason: z.string().max(1000).default(''),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const PLAN_RISK_TYPES = [
  'constraint_conflict',
  'missing_input',
  'permission',
  'scope_overrun',
  'budget',
  'unverified_assumption',
  'irreversible_change',
  'explicit_unknown',
] as const;
export const PlanRiskTypeSchema = z.enum(PLAN_RISK_TYPES);
export type PlanRiskType = z.infer<typeof PlanRiskTypeSchema>;

export const RiskHandlingOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(1000).default(''),
});
export type RiskHandlingOption = z.infer<typeof RiskHandlingOptionSchema>;

/**
 * A risk proposed by the model or the deterministic rule engine.
 * Risks without evidence must be declared as `explicit_unknown`; the UI never
 * hides risks that block commit.
 */
export const PlanRiskSchema = z.object({
  id: z.string().min(1).max(64),
  type: PlanRiskTypeSchema,
  basis: z.enum(['evidence', 'constraint_conflict', 'explicit_unknown']),
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(2000),
  severity: z.enum(['info', 'warning', 'blocking']).default('warning'),
  affectedModuleIds: z.array(ModuleIdSchema).max(8).default([]),
  evidenceRefs: z.array(EvidenceRefSchema).max(32).default([]),
  handlingOptions: z.array(RiskHandlingOptionSchema).min(1).max(8),
  /** Id of the decision that resolved this risk, if any. */
  resolvedByDecisionId: z.string().max(64).nullable().default(null),
});
export type PlanRisk = z.infer<typeof PlanRiskSchema>;

export const PlanValidatorRefSchema = z.object({
  id: z.string().min(1).max(100),
  layer: ValidationLayerSchema,
  description: z.string().max(500).default(''),
});
export type PlanValidatorRef = z.infer<typeof PlanValidatorRefSchema>;

export const PlanSchema = z.object({
  runId: RunIdSchema,
  version: z.number().int().positive(),
  goal: z.string().min(1).max(4000),
  targetModuleId: ModuleIdSchema,
  artifactSkeleton: z.array(PlanSkeletonItemSchema).max(LIMITS.maxModulesPerArtifact),
  inputRefs: z.array(InputRefSchema).max(64),
  constraintRefs: z.array(z.object({ constraintId: z.string().min(1).max(64), text: z.string().min(1).max(2000) })).max(64),
  assumptions: z.array(AssumptionSchema).max(32).default([]),
  openQuestions: z.array(OpenQuestionSchema).max(32).default([]),
  steps: z.array(PlanStepSchema).min(1).max(LIMITS.maxRecipeSteps),
  tools: z.array(PlanToolRequirementSchema).max(16),
  validators: z.array(PlanValidatorRefSchema).max(32),
  budget: BudgetPolicySchema,
  risks: z.array(PlanRiskSchema).max(32).default([]),
  promptVersion: z.string().min(1).max(64),
  modelProfileId: z.string().max(100).nullable().default(null),
  createdAt: UtcTimestampSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

/* ------------------------------ utilities ------------------------------ */

/** Returns the first dependency cycle found, or null when the plan is acyclic. */
export function findPlanCycle(steps: readonly Pick<PlanStep, 'id' | 'dependencies'>[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 in stack, 2 done
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    const mark = state.get(id) ?? 0;
    if (mark === 2) return null;
    if (mark === 1) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 1);
    stack.push(id);
    const step = byId.get(id);
    for (const dep of step?.dependencies ?? []) {
      if (!byId.has(dep)) {
        // Unknown dependency is a structural error reported separately.
        continue;
      }
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return null;
}

export function findUnknownPlanDependencies(steps: readonly Pick<PlanStep, 'id' | 'dependencies'>[]): string[] {
  const ids = new Set(steps.map((s) => s.id));
  const unknown: string[] = [];
  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!ids.has(dep)) unknown.push(`${step.id}->${dep}`);
    }
  }
  return unknown;
}

/** Only risks that block commit are surfaced as mandatory; the count is real. */
export function blockingRisks(risks: readonly PlanRisk[]): PlanRisk[] {
  return risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null);
}

export function planRiskCountLabel(risks: readonly PlanRisk[]): string {
  const blocking = blockingRisks(risks).length;
  return risks.length === 0 ? '未发现风险' : `${risks.length} 个风险（${blocking} 个阻止提交）`;
}

/** Positive plan precondition for a run to leave READY. */
export function planReadyForCommit(plan: Plan): boolean {
  return findPlanCycle(plan.steps) === null && findUnknownPlanDependencies(plan.steps).length === 0;
}
