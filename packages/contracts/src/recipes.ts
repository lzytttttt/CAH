/**
 * Recipe DSL: bounded, sequential steps with parameter binding and guards.
 * No arbitrary code, no unbounded loops, no model-authored operators.
 */
import { z } from 'zod';
import {
  LIMITS,
  ModuleIdSchema,
  RecipeIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  TaskIdSchema,
  UtcTimestampSchema,
} from './primitives';
import { RecipeKindSchema, RecipeStatusSchema } from './states';
import { JsonObjectSchema, JsonValueSchema } from './primitives';
import { ToolIdSchema, TransformOperationSchema } from './tools';
import { ModuleKindSchema } from './content';

export const RECIPE_DSL_VERSION = '1' as const;

export const RecipeParamTypeSchema = z.enum(['string', 'number', 'boolean', 'source', 'object']);
export type RecipeParamType = z.infer<typeof RecipeParamTypeSchema>;

export const RecipeParameterSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'parameter names must be identifiers'),
  type: RecipeParamTypeSchema,
  required: z.boolean().default(true),
  description: z.string().max(1000).default(''),
  pattern: z.string().max(500).nullable().default(null),
  enumValues: z.array(z.string().max(200)).max(64).default([]),
  defaultValue: JsonValueSchema.optional(),
  /** For type=source: accepted mime types; for others: ignored. */
  acceptsMime: z.array(z.string().max(100)).max(16).default([]),
});
export type RecipeParameter = z.infer<typeof RecipeParameterSchema>;

export const RecipeBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('parameter'), name: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('previous_step') }),
  z.object({ kind: z.literal('literal'), value: JsonValueSchema }),
]);
export type RecipeBinding = z.infer<typeof RecipeBindingSchema>;

export const RecipeStepGuardSchema = z.object({
  parameter: z.string().min(1).max(64),
  operator: z.enum(['equals', 'not_equals', 'in', 'exists']),
  value: JsonValueSchema.optional(),
});
export type RecipeStepGuard = z.infer<typeof RecipeStepGuardSchema>;

const RecipeStepBase = {
  id: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  title: z.string().min(1).max(200).default(''),
  when: RecipeStepGuardSchema.nullable().default(null),
};

export const RecipeStepSchema = z.discriminatedUnion('kind', [
  z.object({
    ...RecipeStepBase,
    kind: z.literal('source.read'),
    source: RecipeBindingSchema,
    locator: z.string().max(500).nullable().default(null),
    maxChars: z.number().int().positive().max(20_000).default(8_000),
  }),
  z.object({
    ...RecipeStepBase,
    kind: z.literal('source.search'),
    source: RecipeBindingSchema,
    query: z.string().min(1).max(200),
    limit: z.number().int().positive().max(20).default(5),
  }),
  z.object({
    ...RecipeStepBase,
    kind: z.literal('data.profile'),
    input: RecipeBindingSchema,
  }),
  z.object({
    ...RecipeStepBase,
    kind: z.literal('data.transform'),
    input: RecipeBindingSchema,
    format: z.enum(['csv', 'json']),
    operations: z.array(TransformOperationSchema).min(1).max(32),
    outputName: z.string().min(1).max(200).default('transformed.csv'),
  }),
  z.object({
    ...RecipeStepBase,
    kind: z.literal('artifact.read'),
    module: RecipeBindingSchema,
  }),
  z.object({
    ...RecipeStepBase,
    kind: z.literal('llm.step'),
    promptTemplateId: z.string().min(1).max(100),
    promptVersion: z.string().min(1).max(64),
    input: RecipeBindingSchema,
    instruction: z.string().max(4000).default(''),
    maxOutputTokens: z.number().int().positive().max(200_000).default(4096),
  }),
  z.object({
    ...RecipeStepBase,
    kind: z.literal('validate'),
    validators: z.array(z.string().min(1).max(100)).min(1).max(32),
  }),
  z.object({
    ...RecipeStepBase,
    kind: z.literal('emit_artifact'),
    moduleKind: ModuleKindSchema,
    input: RecipeBindingSchema,
    artifactName: z.string().min(1).max(200),
  }),
]);
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const RecipeValidatorSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  /** Deterministic checks shipped with the runtime; referenced by id only. */
  supported: z.boolean().default(true),
});
export type RecipeValidator = z.infer<typeof RecipeValidatorSchema>;

export const RecipePermissionsSchema = z.object({
  tools: z.array(ToolIdSchema).max(16),
  scopes: z.array(z.string().max(64)).max(32),
  allowModelCalls: z.boolean(),
  maxModelCallsPerRun: z.number().int().nonnegative().max(100).default(0),
});
export type RecipePermissions = z.infer<typeof RecipePermissionsSchema>;

export const RECIPE_TEST_EXPECTATIONS = ['accept', 'reject'] as const;
export const RecipeTestExpectationSchema = z.enum(RECIPE_TEST_EXPECTATIONS);
export type RecipeTestExpectation = z.infer<typeof RecipeTestExpectationSchema>;

export const RecipeTestCaseSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  kind: z.enum(['original', 'new_valid', 'invalid']),
  inputs: JsonObjectSchema,
  expectation: RecipeTestExpectationSchema,
  status: z.enum(['untested', 'passed', 'failed']).default('untested'),
  detail: z.string().max(2000).default(''),
  normalizedOutputHash: Sha256HexSchema.nullable().default(null),
  lastRunAt: UtcTimestampSchema.nullable().default(null),
});
export type RecipeTestCase = z.infer<typeof RecipeTestCaseSchema>;

export const RecipeFingerprintInputsSchema = z.object({
  dslVersion: z.literal(RECIPE_DSL_VERSION),
  stepFingerprint: Sha256HexSchema,
  toolVersions: z.record(z.string(), z.string().max(64)).default({}),
  promptHashes: z.record(z.string(), Sha256HexSchema).default({}),
  validatorVersion: z.string().max(64),
  parserVersion: z.string().max(64),
});
export type RecipeFingerprintInputs = z.infer<typeof RecipeFingerprintInputsSchema>;

export const RecipeSchema = z.object({
  id: RecipeIdSchema,
  version: z.number().int().positive(),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  kind: RecipeKindSchema,
  status: RecipeStatusSchema,
  dslVersion: z.literal(RECIPE_DSL_VERSION),
  inputParameters: z.array(RecipeParameterSchema).min(1).max(32),
  steps: z.array(RecipeStepSchema).min(1).max(LIMITS.maxRecipeSteps),
  outputArtifactKind: ModuleKindSchema,
  validators: z.array(RecipeValidatorSchema).max(32).default([]),
  permissions: RecipePermissionsSchema,
  budget: z
    .object({
      maxModelCalls: z.number().int().nonnegative().max(100).default(0),
      maxToolCalls: z.number().int().nonnegative().max(100).default(20),
      maxRuntimeMs: z.number().int().positive().max(600_000).default(60_000),
    })
    .default({ maxModelCalls: 0, maxToolCalls: 20, maxRuntimeMs: 60_000 }),
  testCases: z.array(RecipeTestCaseSchema).min(1).max(16),
  fingerprint: z.string().min(1).max(200),
  fingerprintInputs: RecipeFingerprintInputsSchema,
  sourceRunId: RunIdSchema,
  sourceTaskId: TaskIdSchema,
  sourceModuleId: ModuleIdSchema.nullable().default(null),
  applicability: z.string().max(2000).default(''),
  staleReason: z.string().max(2000).nullable().default(null),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});
export type Recipe = z.infer<typeof RecipeSchema>;

/** Compile-time check that every `previous_step` binding has an earlier step. */
export function recipeStepOrderErrors(steps: readonly RecipeStep[]): string[] {
  const errors: string[] = [];
  let seen = 0;
  steps.forEach((step, index) => {
    if (index === 0 && containsPreviousStep(step)) {
      errors.push(`step ${step.id} references previous_step but is the first step`);
    }
    if (containsPreviousStep(step)) {
      const previous = steps[index - 1];
      if (!previous) errors.push(`step ${step.id} has no previous step`);
      void previous;
      seen += 1;
    }
  });
  void seen;
  return errors;
}

function containsPreviousStep(step: RecipeStep): boolean {
  switch (step.kind) {
    case 'source.read':
    case 'source.search':
      return step.source.kind === 'previous_step';
    case 'data.profile':
    case 'data.transform':
    case 'llm.step':
    case 'emit_artifact':
      return step.input.kind === 'previous_step';
    case 'artifact.read':
      return step.module.kind === 'previous_step';
    case 'validate':
      return false;
  }
}

/** A model-assisted recipe must have a fixed workflow; deterministic ones must not call models. */
export function recipeKindConsistencyErrors(recipe: Pick<Recipe, 'kind' | 'permissions' | 'steps'>): string[] {
  const errors: string[] = [];
  const hasLlmStep = recipe.steps.some((step) => step.kind === 'llm.step');
  if (recipe.kind === 'deterministic') {
    if (hasLlmStep) errors.push('deterministic recipe contains an llm.step');
    if (recipe.permissions.allowModelCalls) errors.push('deterministic recipe must not allow model calls');
  }
  if (recipe.kind === 'llm_assisted' && !hasLlmStep) {
    errors.push('llm_assisted recipe must contain at least one llm.step');
  }
  return errors;
}

export const RecipeRunOutputSchema = z.object({
  name: z.string().max(200),
  moduleKind: ModuleKindSchema,
  objectHash: Sha256HexSchema,
  preview: z.string().max(1000),
  rowCount: z.number().int().nonnegative().nullable().default(null),
});

export const RECIPE_RUN_CACHE_STATES = ['executed', 'cache_hit'] as const;
export const RecipeRunCacheStateSchema = z.enum(RECIPE_RUN_CACHE_STATES);

export const RecipeRunResultSchema = z.object({
  recipeId: RecipeIdSchema,
  recipeVersion: z.number().int().positive(),
  runId: RunIdSchema,
  cacheState: RecipeRunCacheStateSchema,
  outputs: z.array(RecipeRunOutputSchema).min(1),
  normalizedOutputHash: Sha256HexSchema,
  llmCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  startedAt: UtcTimestampSchema,
  finishedAt: UtcTimestampSchema,
});
export type RecipeRunResult = z.infer<typeof RecipeRunResultSchema>;

/** Request to save the successful path of a finished run as a candidate recipe. */
export const RecipeProposalInputSchema = z.object({
  runId: RunIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  kind: RecipeKindSchema,
  inputParameters: z.array(RecipeParameterSchema).min(1).max(32),
  steps: z.array(RecipeStepSchema).min(1).max(LIMITS.maxRecipeSteps),
  testCases: z.array(RecipeTestCaseSchema).min(1).max(16),
  applicability: z.string().max(2000).default(''),
});
export type RecipeProposalInput = z.infer<typeof RecipeProposalInputSchema>;

/** Recipe registry invariants checked before registration. */
export function validateRecipeForRegistration(recipe: Recipe): string[] {
  const errors = [
    ...recipeStepOrderErrors(recipe.steps),
    ...recipeKindConsistencyErrors(recipe),
  ];
  if (recipe.kind !== 'deterministic' && recipe.budget.maxModelCalls === 0) {
    errors.push('non-deterministic recipe needs a positive model call budget');
  }
  if (recipe.testCases.filter((t) => t.status === 'passed').length < 2) {
    errors.push('recipe needs at least 2 passed test cases (original + new valid input)');
  }
  if (!recipe.testCases.some((t) => t.kind === 'invalid')) {
    errors.push('recipe needs an invalid-input rejection test case');
  }
  return errors;
}
