import type { ValidatorPort } from '@ca/tools';

/**
 * Placeholder replaced by the harness workstream: deterministic L0-L3 artifact
 * validation. It is injected into both the kernel and the tool runtime.
 */
export function createArtifactValidator(): ValidatorPort {
  throw new Error('artifact validator not implemented yet (createArtifactValidator)');
}
