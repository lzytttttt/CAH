/**
 * `recipeRuntime.validate()` executes the registered test cases for real:
 * acceptance is only granted after the original sample, a new valid sample and
 * an expected-rejection sample all pass (design 13.3 gating).
 */
import { describe, expect, it } from 'vitest';
import { RecipeSchema, validateRecipeForRegistration } from '@ca/contracts';
import {
  BASE_PINS,
  LEGACY_SOURCE_ID,
  NEW_SOURCE_ID,
  INVALID_SOURCE_ID,
  cleaningTestCases,
  makeCleaningRecipe,
  makeHarness,
  makeRunContext,
  sourceInputs,
} from './helpers';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

describe('recipe test-case validation', () => {
  it('promotes a candidate only after original + new_valid + invalid cases pass, recording hashes and timestamps', async () => {
    const harness = makeHarness();
    const candidate = makeCleaningRecipe({ status: 'candidate' });
    expect(candidate.status).toBe('candidate');

    const updated = await harness.runtime.validate(candidate, candidate.testCases, {});

    expect(updated.status).toBe('validated');
    expect(updated.staleReason).toBeNull();
    expect(updated.testCases.map((testCase) => testCase.status)).toEqual(['passed', 'passed', 'passed']);
    for (const testCase of updated.testCases) {
      expect(testCase.lastRunAt).toMatch(ISO_UTC);
    }

    const original = updated.testCases.find((testCase) => testCase.kind === 'original')!;
    const newValid = updated.testCases.find((testCase) => testCase.kind === 'new_valid')!;
    const invalid = updated.testCases.find((testCase) => testCase.kind === 'invalid')!;

    expect(original.normalizedOutputHash).toMatch(SHA256_HEX);
    expect(newValid.normalizedOutputHash).toMatch(SHA256_HEX);
    // Different input data => different normalized output.
    expect(newValid.normalizedOutputHash).not.toBe(original.normalizedOutputHash);
    expect(original.detail).toMatch(/accepted case executed deterministically/);
    expect(newValid.detail).toMatch(/accepted case executed deterministically/);

    expect(invalid.status).toBe('passed');
    expect(invalid.normalizedOutputHash).toBeNull();
    expect(invalid.detail).toMatch(/rejected at deterministic input preflight/);
    expect(invalid.detail).toMatch(/system_id/);

    // The contract registry invariants are now satisfied and no model was called.
    expect(validateRecipeForRegistration(updated)).toEqual([]);
    expect(harness.modelCalls).toHaveLength(0);
    // Validation itself must not write artifacts (only accepted test runs may emit).
    expect(harness.objects.puts.length).toBeGreaterThan(0); // test runs execute emit_artifact
  });

  it('keeps the recipe candidate with explicit reasons when no new_valid accept case is present', async () => {
    const harness = makeHarness();
    const cases = cleaningTestCases().filter((testCase) => testCase.kind !== 'new_valid');
    const candidate = makeCleaningRecipe({ status: 'candidate', testCases: cases });

    const updated = await harness.runtime.validate(candidate, cases, {});

    expect(updated.status).toBe('candidate');
    expect(updated.staleReason).toMatch(/new_valid/);
    expect(updated.staleReason).toMatch(/2 passed accept/);
  });

  it('does not mark an invalid case passed when its input is actually accepted', async () => {
    const harness = makeHarness();
    const cases = cleaningTestCases().map((testCase) =>
      testCase.kind === 'invalid' ? { ...testCase, inputs: sourceInputs(LEGACY_SOURCE_ID) } : testCase,
    );
    const candidate = makeCleaningRecipe({ status: 'candidate', testCases: cases });

    const updated = await harness.runtime.validate(candidate, cases, {});
    const invalid = updated.testCases.find((testCase) => testCase.kind === 'invalid')!;

    expect(invalid.status).toBe('failed');
    expect(invalid.detail).toMatch(/expected rejection/);
    expect(updated.status).toBe('candidate');
  });

  it('fails an accept case whose input data is rejected by the deterministic preflight', async () => {
    const harness = makeHarness();
    const cases = cleaningTestCases().map((testCase) =>
      testCase.kind === 'new_valid' ? { ...testCase, inputs: sourceInputs(INVALID_SOURCE_ID) } : testCase,
    );
    const candidate = makeCleaningRecipe({ status: 'candidate', testCases: cases });

    const updated = await harness.runtime.validate(candidate, cases, {});
    const failed = updated.testCases.find((testCase) => testCase.kind === 'new_valid')!;

    expect(failed.status).toBe('failed');
    expect(failed.detail).toMatch(/preflight|system_id|failed/i);
    expect(updated.status).toBe('candidate');
  });

  it('marks a previously validated recipe stale when a test run fails, preserving reasons', async () => {
    const harness = makeHarness();
    // maxToolCalls=1 makes the accept cases fail deterministically.
    const recipe = makeCleaningRecipe({ budget: { maxToolCalls: 1 } });
    expect(recipe.status).toBe('validated');

    const updated = await harness.runtime.validate(recipe, recipe.testCases, {});

    expect(updated.testCases.some((testCase) => testCase.status === 'failed')).toBe(true);
    expect(updated.status).toBe('stale');
    expect(updated.staleReason).not.toBeNull();
  });

  it('re-tests a stale recipe against the current pins and re-pins its fingerprint', async () => {
    const stalePins = {
      ...BASE_PINS,
      toolVersions: { ...BASE_PINS.toolVersions, 'data.transform': '2.0.0' },
    };
    const staleHarness = makeHarness({ pins: stalePins });
    const recipe = makeCleaningRecipe(); // pinned to data.transform 1.0.0

    const updated = await staleHarness.runtime.validate(recipe, recipe.testCases, {});

    expect(updated.status).toBe('validated');
    expect(updated.fingerprintInputs.toolVersions['data.transform']).toBe('2.0.0');
    expect(updated.fingerprint).not.toBe(recipe.fingerprint);

    // The re-tested recipe now runs under the new pins…
    const result = await staleHarness.runtime.run(updated, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(result.outputs[0]!.rowCount).toBe(22);

    // …while the old runtime correctly refuses it as stale.
    const oldHarness = makeHarness();
    await expect(oldHarness.runtime.run(updated, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'recipe_stale',
    });
  });

  it('accepts per-case input overrides (server re-binding) and records the matching output hash', async () => {
    const harness = makeHarness();
    const cases = cleaningTestCases();
    const candidate = makeCleaningRecipe({ status: 'candidate', testCases: cases });

    const updated = await harness.runtime.validate(candidate, cases, {
      original: sourceInputs(NEW_SOURCE_ID),
      'new-valid': sourceInputs(LEGACY_SOURCE_ID),
      invalid: sourceInputs(INVALID_SOURCE_ID),
    });

    expect(updated.status).toBe('validated');
    const original = updated.testCases.find((testCase) => testCase.kind === 'original')!;
    const direct = await harness.runtime.run(makeCleaningRecipe(), makeRunContext(sourceInputs(NEW_SOURCE_ID)));
    expect(original.normalizedOutputHash).toBe(direct.normalizedOutputHash);
  });

  it('rejects an invalid recipe before executing any of its test cases', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    const broken = RecipeSchema.parse({
      ...recipe,
      permissions: { ...recipe.permissions, tools: ['source.read'] },
    });

    const updated = await harness.runtime.validate(broken, broken.testCases, {});
    expect(updated.testCases.every((testCase) => testCase.status === 'failed')).toBe(true);
    expect(updated.testCases[0]!.detail).toMatch(/recipe is invalid/);
    expect(updated.status).toBe('stale');
  });
});
