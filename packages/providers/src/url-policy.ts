import type { UrlPolicy } from './types';

/**
 * Placeholder replaced by the providers workstream: HTTPS-only remote endpoints,
 * explicit loopback HTTP opt-in and exact host allow-listing.
 */
export function assertProviderUrlAllowed(_url: string, _policy: UrlPolicy): void {
  throw new Error('url policy not implemented yet (assertProviderUrlAllowed)');
}

export function maskCredential(_value: string): string {
  throw new Error('maskCredential not implemented yet');
}
