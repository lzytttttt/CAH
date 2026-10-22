import type { ProviderAdapter, ProviderProfile, ModelRequest, ModelEvent } from '@ca/contracts';
import type { AdapterOptions } from './types';

/**
 * Placeholder replaced by the providers workstream.
 */
export function createAdapter(
  _profile: ProviderProfile,
  _credential: string,
  _options?: AdapterOptions,
): ProviderAdapter {
  throw new Error('openai-compatible adapter not implemented yet (createAdapter)');
}

export const _typeHelpers = {
  _request: null as unknown as ModelRequest,
  _event: null as unknown as ModelEvent,
};
