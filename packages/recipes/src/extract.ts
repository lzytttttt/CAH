import type { RecipeProposalInput } from '@ca/contracts';
import type { RecipeTrace } from './types';

/**
 * Placeholder replaced by the recipes workstream: turn a successful run trace
 * into a bounded, parameterized candidate recipe (never a chat transcript).
 */
export function extractRecipeCandidate(
  _trace: RecipeTrace,
  _options: { name: string; kind: 'deterministic' | 'llm_assisted' | 'cached_snapshot'; description: string; applicability: string },
): RecipeProposalInput {
  throw new Error('recipe extraction not implemented yet (extractRecipeCandidate)');
}
