import type { CredentialStatus, CredentialStore, ProviderCredentials } from './types';

/**
 * Placeholder replaced by the providers workstream: env/key-file credential
 * resolution with masked hints, plus encrypted-at-rest storage for UI-saved keys.
 */
export class EnvCredentialStore implements CredentialStore {
  async get(_ref: string): Promise<ProviderCredentials | null> {
    throw new Error('credential store not implemented yet (EnvCredentialStore.get)');
  }
  async status(_ref: string): Promise<CredentialStatus> {
    throw new Error('credential store not implemented yet (EnvCredentialStore.status)');
  }
  async set(_ref: string, _value: string): Promise<void> {
    throw new Error('credential store not implemented yet (EnvCredentialStore.set)');
  }
}
