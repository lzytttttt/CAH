import type { JsonValue } from '@ca/contracts';

/**
 * Placeholder replaced by the tools workstream: pure deterministic transform
 * operators shared by data.transform and the recipe runtime.
 */
export function applyTransformOperations(_input: unknown, _operations: readonly unknown[]): JsonValue {
  throw new Error('transform operators not implemented yet (applyTransformOperations)');
}
