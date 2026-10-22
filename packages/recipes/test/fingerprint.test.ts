/**
 * Fingerprint + staleness tests: changing any pinned dependency invalidates a
 * recipe, while unrelated runtime tools do not create noise.
 */
import { describe, expect, it } from 'vitest';
import { RecipeSchema } from '@ca/contracts';
import { sha256Hex } from '@ca/tools';
import {
  buildRecipeFingerprint,
  buildRecipeFingerprintInputs,
  computeRecipeFingerprint,
  computeStepFingerprint,
  evaluateRecipeStaleness,
  recipeUsedPromptIds,
  recipeUsedToolIds,
  unchangedPins,
} from '../src';
import { BASE_PINS, cleaningSteps, makeCleaningRecipe, makeLlmAssistedRecipe } from './helpers';

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe('computeRecipeFingerprint', () => {
  const steps = cleaningSteps();
  const baseParts = {
    dslVersion: '1' as const,
    stepFingerprint: computeStepFingerprint(steps),
    toolVersions: { 'data.profile': '1.0.0', 'data.transform': '1.0.0', 'source.read': '1.0.0' },
    promptHashes: {},
    validatorVersion: 'recipe-validators-1',
    parserVersion: 'csv-parser-1',
  };

  it('is a stable lowercase sha256 that ignores map key order', () => {
    const fingerprint = computeRecipeFingerprint(baseParts);
    expect(fingerprint).toMatch(SHA256_HEX);
    expect(computeRecipeFingerprint(baseParts)).toBe(fingerprint);
    expect(
      computeRecipeFingerprint({
        ...baseParts,
        toolVersions: { 'source.read': '1.0.0', 'data.transform': '1.0.0', 'data.profile': '1.0.0' },
      }),
    ).toBe(fingerprint);
  });

  it('changes when any part changes', () => {
    const fingerprint = computeRecipeFingerprint(baseParts);
    const variants = [
      { ...baseParts, stepFingerprint: computeStepFingerprint(cleaningSteps().slice(0, 2)) },
      { ...baseParts, toolVersions: { ...baseParts.toolVersions, 'data.transform': '1.0.1' } },
      { ...baseParts, promptHashes: { 'executor.v1': sha256Hex('prompt') } },
      { ...baseParts, validatorVersion: 'recipe-validators-2' },
      { ...baseParts, parserVersion: 'csv-parser-2' },
    ];
    for (const variant of variants) {
      expect(computeRecipeFingerprint(variant)).not.toBe(fingerprint);
    }
  });

  it('rejects malformed fingerprint inputs instead of hashing garbage', () => {
    expect(() => computeRecipeFingerprint({ ...baseParts, stepFingerprint: 'not-a-hash' })).toThrow(/stepFingerprint/);
    expect(() => computeRecipeFingerprint({ ...baseParts, parserVersion: '' })).toThrow(/parserVersion/);
    expect(() => computeRecipeFingerprint({ ...baseParts, promptHashes: { p: 'nope' } })).toThrow(/promptHashes/);
    expect(() => computeStepFingerprint([{ kind: 'not-a-step' } as never])).toThrow(/invalid recipe steps/);
  });
});

describe('recipe staleness', () => {
  it('pins only the tools/prompts the recipe actually uses', () => {
    const recipe = makeCleaningRecipe();
    expect(recipeUsedToolIds(recipe)).toEqual(['data.profile', 'data.transform', 'source.read']);
    expect(Object.keys(recipe.fingerprintInputs.toolVersions).sort()).toEqual([
      'data.profile',
      'data.transform',
      'source.read',
    ]);
    expect(computeRecipeFingerprint(recipe.fingerprintInputs)).toBe(recipe.fingerprint);

    const llmRecipe = makeLlmAssistedRecipe();
    expect(recipeUsedPromptIds(llmRecipe)).toEqual(['executor.v1']);
    expect(Object.keys(llmRecipe.fingerprintInputs.promptHashes)).toEqual(['executor.v1']);
    expect(computeRecipeFingerprint(llmRecipe.fingerprintInputs)).toBe(llmRecipe.fingerprint);
  });

  it('ignores unrelated tool versions and detects used ones', () => {
    const recipe = makeCleaningRecipe();
    const unrelated = {
      ...BASE_PINS,
      toolVersions: { ...BASE_PINS.toolVersions, 'artifact.read': '9.9.9' },
    };
    expect(unchangedPins(recipe.fingerprintInputs, unrelated)).toBe(true);
    expect(evaluateRecipeStaleness(recipe, unrelated).stale).toBe(false);

    const changed = {
      ...BASE_PINS,
      toolVersions: { ...BASE_PINS.toolVersions, 'data.transform': '2.0.0' },
    };
    expect(unchangedPins(recipe.fingerprintInputs, changed)).toBe(false);
    const report = evaluateRecipeStaleness(recipe, changed);
    expect(report.stale).toBe(true);
    expect(report.reasons.join(' ')).toMatch(/data\.transform/);
    expect(report.expectedFingerprint).not.toBe(recipe.fingerprint);
    expect(report.expectedStepFingerprint).toBe(recipe.fingerprintInputs.stepFingerprint);
  });

  it('detects validator, parser, prompt and DSL changes', () => {
    const recipe = makeCleaningRecipe();
    expect(evaluateRecipeStaleness(recipe, { ...BASE_PINS, validatorVersion: 'v2' }).reasons.join(' ')).toMatch(
      /validator version changed/,
    );
    expect(evaluateRecipeStaleness(recipe, { ...BASE_PINS, parserVersion: 'p2' }).reasons.join(' ')).toMatch(
      /parser version changed/,
    );

    const llm = makeLlmAssistedRecipe();
    expect(
      evaluateRecipeStaleness(llm, { ...BASE_PINS, promptHashes: { 'executor.v1': sha256Hex('changed') } }).reasons.join(' '),
    ).toMatch(/prompt "executor\.v1" hash changed/);

    const mutatedSteps = RecipeSchema.parse({ ...recipe, steps: recipe.steps.slice(0, 4) });
    const report = evaluateRecipeStaleness(mutatedSteps, BASE_PINS);
    expect(report.stale).toBe(true);
    expect(report.reasons.join(' ')).toMatch(/steps changed|fingerprint/);
  });

  it('buildRecipeFingerprintInputs matches the fingerprint stored on a registered recipe', () => {
    const recipe = makeCleaningRecipe();
    const rebuilt = buildRecipeFingerprintInputs(recipe, BASE_PINS);
    expect(rebuilt).toEqual(recipe.fingerprintInputs);
    expect(buildRecipeFingerprint(recipe, BASE_PINS).fingerprint).toBe(recipe.fingerprint);
  });
});
