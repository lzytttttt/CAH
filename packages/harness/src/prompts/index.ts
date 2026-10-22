/**
 * Versioned prompt bundle. Template code, variables, output schemas and hash
 * exports ship together; the runtime records the actual hash with every
 * ContextSnapshot (design section 7.4).
 */
export * from './render';
export * from './planner.v1';
export * from './executor.v1';
export * from './repair.v1';
export * from './compressor.v1';
export * from './recipe-extractor.v1';

import { COMPRESSOR_V1_HASH } from './compressor.v1';
import { EXECUTOR_V1_HASH } from './executor.v1';
import { PLANNER_V1_HASH } from './planner.v1';
import { RECIPE_EXTRACTOR_V1_HASH } from './recipe-extractor.v1';
import { REPAIR_V1_HASH } from './repair.v1';

/** Stable template id -> SHA-256 of the template source. */
export const PROMPT_TEMPLATE_HASHES: Readonly<Record<string, string>> = {
  'planner.v1': PLANNER_V1_HASH,
  'executor.v1': EXECUTOR_V1_HASH,
  'repair.v1': REPAIR_V1_HASH,
  'compressor.v1': COMPRESSOR_V1_HASH,
  'recipe-extractor.v1': RECIPE_EXTRACTOR_V1_HASH,
};
