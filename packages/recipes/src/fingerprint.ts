/**
 * Recipe fingerprinting.
 *
 * A recipe is only valid for the exact dependency pins it was tested against
 * (design 13.4): tool implementations, prompt templates, the deterministic
 * validator bundle and the CSV/JSON parser versions. The fingerprint is a
 * sha256 over the canonical JSON of those parts plus the DSL version and a
 * digest of the steps themselves.
 *
 * The tool/prompt maps are filtered to what the recipe actually uses, so an
 * unrelated tool upgrade does not wrongly force every recipe stale while a real
 * change to a used tool always does.
 */
import {
  RECIPE_DSL_VERSION,
  RecipeStepSchema,
  canonicalJson,
  type Recipe,
  type RecipeFingerprintInputs,
  type RecipeStep,
} from '@ca/contracts';
import { sha256Hex } from '@ca/tools';
import { RecipeRuntimeError } from './errors';

export const RECIPE_FINGERPRINT_VERSION = 'recipe-fingerprint-1';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The non-step dependency pins a recipe is bound to. */
export interface RecipeDependencyPins {
  toolVersions: Record<string, string>;
  promptHashes: Record<string, string>;
  validatorVersion: string;
  parserVersion: string;
}

type FingerprintParts = Omit<RecipeFingerprintInputs, 'stepFingerprint'> & { stepFingerprint: string };

/** sha256 of the canonical DSL step list (defaults normalized by the schema). */
export function computeStepFingerprint(steps: readonly RecipeStep[]): string {
  const normalized: unknown[] = [];
  const problems: string[] = [];
  steps.forEach((step, index) => {
    const parsed = RecipeStepSchema.safeParse(step);
    if (parsed.success) {
      normalized.push(parsed.data);
    } else {
      for (const issue of parsed.error.issues.slice(0, 3)) {
        problems.push(`step ${index + 1}: ${issue.path.join('.') || '<root>'}: ${issue.message}`);
      }
    }
  });
  if (problems.length > 0) {
    throw new RecipeRuntimeError('dsl_invalid', `cannot fingerprint invalid recipe steps: ${problems.slice(0, 10).join('; ')}`, {
      details: { problems: problems.slice(0, 20) },
    });
  }
  return sha256Hex(canonicalJson(normalized));
}

/**
 * sha256 over the canonical JSON of
 * `{dslVersion, stepFingerprint, toolVersions, promptHashes, validatorVersion, parserVersion}`.
 *
 * Changing any part changes the fingerprint.
 */
export function computeRecipeFingerprint(parts: FingerprintParts): string {
  const problems = validateFingerprintParts(parts);
  if (problems.length > 0) {
    throw new RecipeRuntimeError('dsl_invalid', `invalid fingerprint inputs: ${problems.slice(0, 10).join('; ')}`, {
      details: { problems: problems.slice(0, 20) },
    });
  }
  return sha256Hex(
    canonicalJson({
      dslVersion: parts.dslVersion,
      stepFingerprint: parts.stepFingerprint,
      toolVersions: normalizedStringMap(parts.toolVersions),
      promptHashes: normalizedStringMap(parts.promptHashes),
      validatorVersion: parts.validatorVersion,
      parserVersion: parts.parserVersion,
    }),
  );
}

function validateFingerprintParts(parts: FingerprintParts): string[] {
  const problems: string[] = [];
  if (parts.dslVersion !== RECIPE_DSL_VERSION) {
    problems.push(`dslVersion must be "${RECIPE_DSL_VERSION}"`);
  }
  if (!SHA256_HEX.test(parts.stepFingerprint)) {
    problems.push('stepFingerprint must be a lowercase sha256 hex digest');
  }
  for (const [key, value] of Object.entries(parts.toolVersions ?? {})) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
      problems.push(`toolVersions["${key}"] must be a non-empty string of <= 64 chars`);
    }
  }
  for (const [key, value] of Object.entries(parts.promptHashes ?? {})) {
    if (!SHA256_HEX.test(value)) problems.push(`promptHashes["${key}"] must be a lowercase sha256 hex digest`);
  }
  if (typeof parts.validatorVersion !== 'string' || parts.validatorVersion.length === 0 || parts.validatorVersion.length > 64) {
    problems.push('validatorVersion must be a non-empty string of <= 64 chars');
  }
  if (typeof parts.parserVersion !== 'string' || parts.parserVersion.length === 0 || parts.parserVersion.length > 64) {
    problems.push('parserVersion must be a non-empty string of <= 64 chars');
  }
  return problems;
}

function normalizedStringMap(map: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map ?? {}).sort()) {
    const value = (map ?? {})[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Tool ids referenced by the recipe steps (deterministic step kinds only). */
export function recipeUsedToolIds(recipe: Pick<Recipe, 'steps'>): string[] {
  const ids = new Set<string>();
  for (const step of recipe.steps) {
    switch (step.kind) {
      case 'source.read':
      case 'source.search':
      case 'data.profile':
      case 'data.transform':
      case 'artifact.read':
        ids.add(step.kind);
        break;
      default:
        break;
    }
  }
  return [...ids].sort();
}

/** Prompt template ids referenced by the recipe's llm.step entries. */
export function recipeUsedPromptIds(recipe: Pick<Recipe, 'steps'>): string[] {
  const ids = new Set<string>();
  for (const step of recipe.steps) {
    if (step.kind === 'llm.step') ids.add(step.promptTemplateId);
  }
  return [...ids].sort();
}

function filterPinsForRecipe(
  recipe: Pick<Recipe, 'steps'>,
  pins: RecipeDependencyPins,
): Pick<RecipeDependencyPins, 'toolVersions' | 'promptHashes'> {
  const usedTools = new Set(recipeUsedToolIds(recipe));
  const toolVersions: Record<string, string> = {};
  for (const toolId of Object.keys(pins.toolVersions).sort()) {
    if (usedTools.has(toolId)) toolVersions[toolId] = pins.toolVersions[toolId]!;
  }
  const usedPrompts = recipeUsedPromptIds(recipe);
  const promptHashes: Record<string, string> = {};
  for (const key of Object.keys(pins.promptHashes).sort()) {
    const relevant = usedPrompts.some(
      (promptId) => key === promptId || key.startsWith(`${promptId}@`) || key.startsWith(`${promptId}:`),
    );
    if (relevant) promptHashes[key] = pins.promptHashes[key]!;
  }
  return { toolVersions, promptHashes };
}

/** Build the fingerprint inputs a recipe should have for the given runtime pins. */
export function buildRecipeFingerprintInputs(
  recipe: Pick<Recipe, 'steps'>,
  pins: RecipeDependencyPins,
): RecipeFingerprintInputs {
  const filtered = filterPinsForRecipe(recipe, pins);
  return {
    dslVersion: RECIPE_DSL_VERSION,
    stepFingerprint: computeStepFingerprint(recipe.steps),
    toolVersions: filtered.toolVersions,
    promptHashes: filtered.promptHashes,
    validatorVersion: pins.validatorVersion,
    parserVersion: pins.parserVersion,
  };
}

/** Convenience: build the inputs and the fingerprint together. */
export function buildRecipeFingerprint(
  recipe: Pick<Recipe, 'steps'>,
  pins: RecipeDependencyPins,
): { fingerprintInputs: RecipeFingerprintInputs; fingerprint: string } {
  const fingerprintInputs = buildRecipeFingerprintInputs(recipe, pins);
  return { fingerprintInputs, fingerprint: computeRecipeFingerprint(fingerprintInputs) };
}

/**
 * Compare the dependency pins only (not the steps). This is what "unchanged
 * pins" means for staleness: the recipe DSL is compared separately through
 * `stepFingerprint`.
 */
export function unchangedPins(previous: RecipeFingerprintInputs, next: RecipeDependencyPins): boolean {
  return fingerprintChangeReasons(previous, next).length === 0;
}

/** Human-readable reasons why dependency pins changed (empty when unchanged). */
export function fingerprintChangeReasons(previous: RecipeFingerprintInputs, next: RecipeDependencyPins): string[] {
  const reasons: string[] = [];
  if (previous.dslVersion !== RECIPE_DSL_VERSION) {
    reasons.push(`recipe DSL version ${previous.dslVersion} differs from runtime DSL version ${RECIPE_DSL_VERSION}`);
  }
  const previousTools = normalizedStringMap(previous.toolVersions);
  // `previous` already contains only the tool ids the recipe uses; compare the
  // same subset of the new pins so unrelated runtime tools do not create noise.
  const nextTools = pickKeys(normalizedStringMap(next.toolVersions), Object.keys(previousTools));
  for (const key of unionSorted(Object.keys(previousTools), Object.keys(nextTools))) {
    const before = previousTools[key];
    const after = nextTools[key];
    if (before === undefined) reasons.push(`tool "${key}" is pinned but no longer available in this runtime`);
    else if (after === undefined) reasons.push(`pinned tool "${key}" is missing from the current runtime`);
    else if (before !== after) reasons.push(`tool "${key}" version changed: ${before} -> ${after}`);
  }
  const previousPrompts = normalizedStringMap(previous.promptHashes);
  const nextPrompts = normalizedStringMap(next.promptHashes);
  const relevantNextPrompts: Record<string, string> = {};
  for (const key of Object.keys(nextPrompts)) {
    const relevant = Object.keys(previousPrompts).some(
      (pinned) => key === pinned || key.startsWith(`${pinned}@`) || key.startsWith(`${pinned}:`),
    );
    if (relevant) relevantNextPrompts[key] = nextPrompts[key]!;
  }
  for (const key of unionSorted(Object.keys(previousPrompts), Object.keys(relevantNextPrompts))) {
    const before = previousPrompts[key];
    const after = relevantNextPrompts[key];
    if (before === undefined) reasons.push(`prompt "${key}" is pinned but no longer available in this runtime`);
    else if (after === undefined) reasons.push(`pinned prompt "${key}" is missing from the current runtime`);
    else if (before !== after) reasons.push(`prompt "${key}" hash changed`);
  }
  if (previous.validatorVersion !== next.validatorVersion) {
    reasons.push(`validator version changed: ${previous.validatorVersion} -> ${next.validatorVersion}`);
  }
  if (previous.parserVersion !== next.parserVersion) {
    reasons.push(`parser version changed: ${previous.parserVersion} -> ${next.parserVersion}`);
  }
  return reasons;
}

function pickKeys(map: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (map[key] !== undefined) out[key] = map[key];
  }
  return out;
}

function unionSorted(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

export interface RecipeStalenessReport {
  stale: boolean;
  reasons: string[];
  expectedFingerprint: string;
  expectedStepFingerprint: string;
}

/**
 * Full staleness evaluation used before running a recipe: compares dependency
 * pins, the step DSL digest and the recomputed fingerprint with the stored one.
 */
export function evaluateRecipeStaleness(
  recipe: Pick<Recipe, 'steps' | 'fingerprint' | 'fingerprintInputs'>,
  pins: RecipeDependencyPins,
): RecipeStalenessReport {
  const reasons: string[] = [];
  const filtered = filterPinsForRecipe(recipe, pins);
  const expectedStepFingerprint = computeStepFingerprint(recipe.steps);
  if (expectedStepFingerprint !== recipe.fingerprintInputs.stepFingerprint) {
    reasons.push(
      `recipe steps changed since validation (${recipe.fingerprintInputs.stepFingerprint.slice(0, 12)}… -> ${expectedStepFingerprint.slice(0, 12)}…)`,
    );
  }
  reasons.push(...fingerprintChangeReasons(recipe.fingerprintInputs, { ...pins, ...filtered }));
  const expectedFingerprint = computeRecipeFingerprint({
    ...recipe.fingerprintInputs,
    stepFingerprint: expectedStepFingerprint,
    toolVersions: filtered.toolVersions,
    promptHashes: filtered.promptHashes,
    validatorVersion: pins.validatorVersion,
    parserVersion: pins.parserVersion,
  });
  if (expectedFingerprint !== recipe.fingerprint) {
    reasons.push('stored fingerprint does not match the current dependency fingerprint; re-validation is required');
  }
  return {
    stale: reasons.length > 0,
    reasons: [...new Set(reasons)],
    expectedFingerprint,
    expectedStepFingerprint,
  };
}
