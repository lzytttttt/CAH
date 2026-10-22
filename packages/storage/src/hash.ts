/** Hashing helpers shared by the object store and artifact-version bookkeeping. */
import { createHash } from 'node:crypto';
import { canonicalJson, type ModuleContent } from '@ca/contracts';

/** Lowercase hex sha256 of raw bytes (object store content address). */
export function sha256Hex(bytes: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

/**
 * Canonical content hash for a module content payload: sha256 over the
 * key-sorted JSON serialization. Deterministic across processes and key order.
 *
 * Callers should use this when they compute `ArtifactVersion.contentHash` so the
 * hash stored alongside the immutable content can be re-verified later.
 */
export function hashModuleContent(content: ModuleContent): string {
  return sha256Hex(canonicalJson(content));
}
