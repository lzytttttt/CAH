/**
 * Runtime behavior tests: schema gates, deterministic zero-LLM proof, guards,
 * budgets, permissions, staleness, status gating and honest failure modes.
 */
import { describe, expect, it } from 'vitest';
import { RecipeSchema, RecipeStepSchema, type RecipeStep } from '@ca/contracts';
import { createRecipeRuntime } from '../src';
import {
  BASE_PINS,
  CLEANING_OPERATIONS,
  LEGACY_SOURCE_ID,
  makeCleaningRecipe,
  makeGuardedRecipe,
  makeHarness,
  makeLlmAssistedRecipe,
  makeObserver,
  makeRunContext,
  sourceInputs,
  TASK_ID,
} from './helpers';

describe('recipe input validation (synchronous schema gate)', () => {
  it('reports missing, unknown, mistyped, pattern and enum errors without rewriting rules', () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();

    const missing = harness.runtime.validateInputs(recipe, {});
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toMatch(/missing required input parameter "source"/);

    const extra = harness.runtime.validateInputs(recipe, {
      ...sourceInputs(LEGACY_SOURCE_ID),
      extra: 1,
    });
    expect(extra.ok).toBe(false);
    expect(extra.errors.join(' ')).toMatch(/unknown input parameter "extra"/);

    const badSource = harness.runtime.validateInputs(recipe, { source: 'not-a-uuid' });
    expect(badSource.ok).toBe(false);
    expect(badSource.errors.join(' ')).toMatch(/source/i);

    const patternRecipe = RecipeSchema.parse({
      ...recipe,
      inputParameters: [
        {
          name: 'code',
          type: 'string',
          required: true,
          description: '',
          pattern: '^S-[0-9]{4}$',
          enumValues: [],
          acceptsMime: [],
        },
      ],
    });
    expect(harness.runtime.validateInputs(patternRecipe, { code: 'S-1001' }).ok).toBe(true);
    const badPattern = harness.runtime.validateInputs(patternRecipe, { code: 'bad-code' });
    expect(badPattern.ok).toBe(false);
    expect(badPattern.errors.join(' ')).toMatch(/does not match pattern/);

    const enumRecipe = RecipeSchema.parse({
      ...recipe,
      inputParameters: [
        {
          name: 'mode',
          type: 'string',
          required: true,
          description: '',
          pattern: null,
          enumValues: ['fast', 'safe'],
          acceptsMime: [],
        },
      ],
    });
    expect(harness.runtime.validateInputs(enumRecipe, { mode: 'safe' }).ok).toBe(true);
    expect(harness.runtime.validateInputs(enumRecipe, { mode: 'other' }).errors.join(' ')).toMatch(/must be one of/);

    const guarded = makeGuardedRecipe();
    const withDefault = harness.runtime.validateInputs(guarded, sourceInputs(LEGACY_SOURCE_ID));
    expect(withDefault.ok).toBe(true);
    expect(withDefault.normalized.read_source).toBe(true);
    const wrongBoolean = harness.runtime.validateInputs(guarded, {
      ...sourceInputs(LEGACY_SOURCE_ID),
      read_source: 'yes',
    });
    expect(wrongBoolean.ok).toBe(false);
    expect(wrongBoolean.errors.join(' ')).toMatch(/expected a boolean/);

    const objectRecipe = RecipeSchema.parse({
      ...recipe,
      inputParameters: [
        {
          name: 'payload',
          type: 'object',
          required: true,
          description: '',
          pattern: null,
          enumValues: [],
          acceptsMime: [],
        },
      ],
    });
    expect(harness.runtime.validateInputs(objectRecipe, { payload: { a: 1 } }).ok).toBe(true);
    expect(harness.runtime.validateInputs(objectRecipe, { payload: [1, 2] }).ok).toBe(false);
  });
});

describe('deterministic recipes are provably zero-LLM', () => {
  it('never calls the injected model executor and reports llmCalls = 0', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    const result = await harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(result.llmCalls).toBe(0);
    expect(result.cacheState).toBe('executed');
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('refuses a deterministic recipe that contains an llm.step', async () => {
    const harness = makeHarness();
    const llmRecipe = makeLlmAssistedRecipe();
    const invalid = RecipeSchema.parse({ ...llmRecipe, kind: 'deterministic', budget: { ...llmRecipe.budget, maxModelCalls: 0 } });
    await expect(harness.runtime.run(invalid, makeRunContext({ topic: 'x' }))).rejects.toMatchObject({
      code: 'dsl_invalid',
      message: expect.stringMatching(/deterministic recipe contains an llm\.step|model/i),
    });
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('refuses a deterministic recipe that allows model calls', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe({
      permissions: { allowModelCalls: true, maxModelCallsPerRun: 1 },
    });
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'dsl_invalid',
      message: expect.stringMatching(/deterministic recipe must not allow model calls/),
    });
    expect(harness.modelCalls).toHaveLength(0);
  });
});

describe('llm_assisted recipes', () => {
  it('fails loudly with model_step_unavailable when no executor is injected', async () => {
    const harness = makeHarness({ includeModelStep: false });
    const recipe = makeLlmAssistedRecipe();
    await expect(harness.runtime.run(recipe, makeRunContext({ topic: '清洗' }))).rejects.toMatchObject({
      code: 'model_step_unavailable',
    });
    expect(harness.objects.puts).toHaveLength(0);
  });

  it('calls the model executor only for llm.step and records real model calls', async () => {
    const harness = makeHarness();
    const recipe = makeLlmAssistedRecipe();
    const result = await harness.runtime.run(recipe, makeRunContext({ topic: '清洗' }));
    expect(result.llmCalls).toBe(1);
    expect(harness.modelCalls).toHaveLength(1);
    expect(harness.modelCalls[0]!.promptTemplateId).toBe('executor.v1');
    expect(harness.modelCalls[0]!.taskId).toBe(TASK_ID);
    expect(result.outputs[0]!.moduleKind).toBe('markdown');
    expect(result.outputs[0]!.preview).toMatch(/section/);
  });

  it('enforces the maxModelCalls budget before starting a second model call', async () => {
    const harness = makeHarness();
    const recipe = makeLlmAssistedRecipe({ extraLlmStep: true, budgetMaxModelCalls: 1 });
    await expect(harness.runtime.run(recipe, makeRunContext({ topic: '清洗' }))).rejects.toMatchObject({
      code: 'budget_exhausted',
      message: expect.stringMatching(/maxModelCalls/),
    });
    expect(harness.modelCalls).toHaveLength(1);
  });

  it('aborts during a model step without faking success', async () => {
    const harness = makeHarness({ modelDelayMs: 50 });
    const recipe = makeLlmAssistedRecipe();
    const controller = new AbortController();
    const pending = harness.runtime.run(recipe, makeRunContext({ topic: '清洗' }, controller.signal));
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(harness.objects.puts).toHaveLength(0);
  });
});

describe('budgets, failures and guards', () => {
  it('enforces maxToolCalls with real accounting', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe({ budget: { maxToolCalls: 1 } });
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'budget_exhausted',
      message: expect.stringMatching(/maxToolCalls/),
    });
    expect(harness.objects.puts).toHaveLength(0);
  });

  it('enforces maxRuntimeMs with measured time', async () => {
    const harness = makeHarness({ modelDelayMs: 40 });
    const recipe = makeLlmAssistedRecipe({ budgetMaxRuntimeMs: 1 });
    await expect(harness.runtime.run(recipe, makeRunContext({ topic: '清洗' }))).rejects.toMatchObject({
      code: 'budget_exhausted',
      message: expect.stringMatching(/maxRuntimeMs/),
    });
  });

  it('only runs validated recipes by default (candidate/stale refused)', async () => {
    const harness = makeHarness();
    for (const status of ['candidate', 'stale', 'disabled'] as const) {
      const recipe = makeCleaningRecipe({ status });
      await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
        code: 'recipe_not_validated',
      });
    }
    const overridden = createRecipeRuntime({
      deps: harness.deps,
      toolVersions: BASE_PINS.toolVersions,
      promptHashes: BASE_PINS.promptHashes,
      validatorVersion: BASE_PINS.validatorVersion,
      parserVersion: BASE_PINS.parserVersion,
      allowUnvalidatedRuns: true,
    });
    const candidate = makeCleaningRecipe({ status: 'candidate' });
    const result = await overridden.run(candidate, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(result.outputs[0]!.rowCount).toBe(22);
  });

  it('refuses a stale recipe when dependency pins changed (and writes nothing)', async () => {
    const stalePins = {
      ...BASE_PINS,
      toolVersions: { ...BASE_PINS.toolVersions, 'data.transform': '2.0.0' },
    };
    const harness = makeHarness({ pins: stalePins });
    const recipe = makeCleaningRecipe(); // pinned to BASE_PINS
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'recipe_stale',
      message: expect.stringMatching(/data\.transform/),
    });
    expect(harness.objects.puts).toHaveLength(0);
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('skips guarded steps and records the skip', async () => {
    const harness = makeHarness();
    const recipe = makeGuardedRecipe();
    const { steps: skippedSteps, observer } = makeObserver();
    const skipped = await harness.runtime.run(recipe, {
      ...makeRunContext({ ...sourceInputs(LEGACY_SOURCE_ID), read_source: false }),
      observer,
    });
    expect(skipped.toolCalls).toBe(1); // only data.transform; source.read skipped
    expect(skippedSteps.map((step) => step.status)).toEqual(['skipped', 'executed', 'executed']);

    const { steps: executedSteps, observer: observer2 } = makeObserver();
    const executed = await harness.runtime.run(recipe, {
      ...makeRunContext({ ...sourceInputs(LEGACY_SOURCE_ID), read_source: true }),
      observer: observer2,
    });
    expect(executed.toolCalls).toBe(2);
    expect(executedSteps.map((step) => step.status)).toEqual(['executed', 'executed', 'executed']);
    expect(executed.normalizedOutputHash).toBe(skipped.normalizedOutputHash);
  });

  it('fails a run without emitted output instead of returning empty success', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe({ steps: [cleaningStepsOnlyRead()] });
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'missing_output',
    });
  });

  it('rejects invalid DSL: undeclared guard parameter, unsupported validator, tool permission', async () => {
    const harness = makeHarness();

    const badGuard = makeGuardedRecipe();
    const badGuardSteps = cleaningStepsGuardUndeclared(badGuard.steps);
    const guardRecipe = RecipeSchema.parse({ ...badGuard, steps: badGuardSteps });
    await expect(harness.runtime.run(guardRecipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'dsl_invalid',
      message: expect.stringMatching(/guard references undeclared parameter/),
    });

    const badValidatorSteps = cleaningStepsBadValidator();
    const badValidatorRecipe = makeCleaningRecipe({ steps: badValidatorSteps });
    await expect(harness.runtime.run(badValidatorRecipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'dsl_invalid',
      message: expect.stringMatching(/unsupported validator/),
    });

    const noPermission = makeCleaningRecipe({
      permissions: { tools: ['source.read'], scopes: ['sources:read'] },
    });
    await expect(harness.runtime.run(noPermission, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'dsl_invalid',
      message: expect.stringMatching(/needs tool permission/),
    });
  });

  it('turns a deterministic validator failure into an explicit rejected input', async () => {
    const harness = makeHarness();
    const steps = cleaningStepsWithoutDedupe();
    const recipe = makeCleaningRecipe({ steps });
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/validation_failed/),
    });
    expect(harness.objects.puts).toHaveLength(0);
  });

  it('honours a pre-aborted signal', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    const controller = new AbortController();
    controller.abort();
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID), controller.signal))).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(harness.objects.puts).toHaveLength(0);
  });
});

/* ---------------------- local recipe-shape helpers ---------------------- */

import { cleaningSteps } from './helpers';

function cleaningStepsOnlyRead() {
  return cleaningSteps()[0]!;
}

function cleaningStepsGuardUndeclared(steps: RecipeStep[]) {
  const clone = steps.map((step) => ({ ...step }));
  clone[0] = RecipeStepSchema.parse({ ...clone[0], when: { parameter: 'not_declared', operator: 'exists' } });
  return clone;
}

function cleaningStepsBadValidator() {
  const steps = cleaningSteps();
  steps[3] = RecipeStepSchema.parse({ ...steps[3], validators: ['does.not.exist'] });
  return steps;
}

function cleaningStepsWithoutDedupe() {
  const steps = cleaningSteps();
  const transform = steps[2]!;
  const operations = CLEANING_OPERATIONS.filter((operation) => operation.op !== 'dedupe');
  steps[2] = RecipeStepSchema.parse({ ...transform, operations });
  return steps;
}
