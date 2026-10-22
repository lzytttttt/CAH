import {
  newProviderProfileId,
  utcNow,
  type ModelEvent,
  type ModelRequest,
  type ProviderCapabilities,
  type ProviderProfile,
  type ProviderProfilePublic,
} from '@ca/contracts';
import { createAdapter, assertProviderUrlAllowed } from '@ca/providers';
import type { CredentialStore, ProviderCredentials } from '@ca/providers';
import type { ProviderGateway } from '@ca/harness';
import type { StoragePort } from '@ca/storage';
import type { ServerConfig } from './config';
import { urlPolicyFor } from './config';
import { fail } from './errors';

const ENV_PROFILE_NAME = '环境变量连接（env-default）';

/**
 * Live provider gateway: profiles come from storage, secrets from the credential
 * store, adapters from @ca/providers. No fallback to Demo data is possible here.
 */
export class LiveProviderGateway implements ProviderGateway {
  private readonly adapters = new Map<string, ReturnType<typeof createAdapter>>();
  private readonly config: ServerConfig;
  private readonly storage: StoragePort;
  private readonly credentials: CredentialStore;

  constructor(storage: StoragePort, credentials: CredentialStore, config: ServerConfig) {
    this.storage = storage;
    this.credentials = credentials;
    this.config = config;
  }

  /** Ensure the env-configured profile exists so the UI can select it immediately. */
  async ensureEnvProfile(): Promise<ProviderProfile | null> {
    const env = this.config.providerEnv;
    if (!env.model) return null;
    const existing = (await this.storage.listProviderProfiles()).find((p) => p.profileName === ENV_PROFILE_NAME);
    if (existing) return existing;
    const now = utcNow();
    const profile: ProviderProfile = {
      id: newProviderProfileId(),
      profileName: ENV_PROFILE_NAME,
      adapterType: 'openai_compatible',
      baseURL: env.baseURL,
      model: env.model,
      credentialRef: env.credentialRef,
      enabled: true,
      timeouts: {},
      contextWindowOverride: null,
      priceTable: null,
      capabilities: {
        streaming: 'unknown',
        toolCalling: 'unknown',
        structuredOutput: 'unknown',
        vision: 'unsupported',
        usageReporting: 'unknown',
      },
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.upsertProviderProfile(profile);
    return profile;
  }

  async getProfile(profileId: string): Promise<ProviderProfile | null> {
    const stored = await this.storage.getProviderProfile(profileId);
    if (stored) return stored;
    if (profileId === 'env-default') {
      return this.ensureEnvProfile();
    }
    return null;
  }

  async listEnabledProfiles(): Promise<ProviderProfile[]> {
    const profiles = await this.storage.listProviderProfiles();
    return profiles.filter((p) => p.enabled);
  }

  async capabilities(profileId: string): Promise<ProviderCapabilities> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw fail.notFound('模型连接配置');
    return profile.capabilities;
  }

  async defaultProfileId(): Promise<string | null> {
    const env = await this.ensureEnvProfile();
    if (env) return env.id;
    const enabled = await this.listEnabledProfiles();
    return enabled[0]?.id ?? null;
  }

  async *stream(profileId: string, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw fail.notFound('模型连接配置');
    if (!profile.enabled) throw fail.badRequest('模型连接已被禁用');
    assertProviderUrlAllowed(profile.baseURL, urlPolicyFor(this.config));
    const credential = await this.credentials.get(profile.credentialRef);
    if (!credential) {
      throw fail.provider(`模型凭据 ${profile.credentialRef} 未配置`);
    }
    const adapter = this.adapterFor(profile, credential.value);
    yield* adapter.stream(request, signal);
  }

  private adapterFor(profile: ProviderProfile, credential: string) {
    const cacheKey = `${profile.id}:${profile.updatedAt}:${profile.model}`;
    const cached = this.adapters.get(cacheKey);
    if (cached) return cached;
    const adapter = createAdapter(profile, credential, this.fetchOptions());
    this.adapters.set(cacheKey, adapter);
    return adapter;
  }

  private fetchOptions(): Parameters<typeof createAdapter>[2] {
    return {
      firstEventTimeoutMs: this.config.providerEnv ? undefined : undefined,
      idleTimeoutMs: undefined,
      totalTimeoutMs: undefined,
    };
  }

  /** Public browser-safe projection: never includes credential refs or secrets. */
  async publicProfiles(): Promise<ProviderProfilePublic[]> {
    const profiles = await this.storage.listProviderProfiles();
    const out: ProviderProfilePublic[] = [];
    for (const profile of profiles) {
      const status = await this.credentials.status(profile.credentialRef);
      const { credentialRef: _hidden, ...rest } = profile;
      void _hidden;
      out.push({
        ...rest,
        credentialConfigured: status.configured,
        credentialHint: status.hint,
        credentialError: status.error,
      });
    }
    return out;
  }

  async credentialStatus(ref: string): Promise<{ configured: boolean; hint: string | null; error: string | null }> {
    return this.credentials.status(ref);
  }

  async resolveCredential(ref: string): Promise<ProviderCredentials | null> {
    return this.credentials.get(ref);
  }
}
