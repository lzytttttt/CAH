import type { Recipe } from '@ca/contracts';

/**
 * Placeholder replaced by the recipes workstream: sha256 over DSL + tool versions
 * + prompt hashes + validator/parser versions.
 */
export function computeRecipeFingerprint(
  _parts: Omit<Recipe['fingerprintInputs'], 'stepFingerprint'> & { stepFingerprint: string },
): string {
  throw new Error('fingerprint not implemented yet (computeRecipeFingerprint)');
}
