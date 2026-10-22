/**
 * @ca/providers — model provider adapters and capability probes.
 *
 * Public contract: see ./types.ts. Design reference: sections 6 / 18.2 / 21.3.
 *
 * Nothing in this package logs credentials; provider-controlled text is
 * sanitized before it becomes an error message or event payload.
 */
import type { ProviderPackageExports } from './types';
import { createAdapter, streamEventsFromAdapter } from './openai-compatible';
import { buildCapabilityRequests, probeTextModelRequest, runCapabilityTests } from './capabilities';
import { assertProviderUrlAllowed, maskCredential } from './url-policy';

export * from './types';
export * from './errors';
export * from './sse';
export * from './token-estimate';
export * from './openai-compatible';
export * from './capabilities';
export * from './credentials';
export * from './url-policy';
export { redactSecrets } from './mask';

export const PROVIDERS_PACKAGE_VERSION = '0.1.0';

/**
 * Concrete implementation of the frozen `ProviderPackageExports` port, for the
 * composition root (`apps/server`) and integration tests.
 */
export const providerPackageExports: ProviderPackageExports = {
  createAdapter,
  runCapabilityTests,
  assertProviderUrlAllowed,
  maskCredential,
  probeTextModelRequest,
  buildCapabilityRequests,
  streamEventsFromAdapter,
};
