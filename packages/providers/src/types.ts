/**
 * Provider package contracts: adapters, capability probes and credential access.
 *
 * Credentials never leave the server process. Results are always reported per
 * concrete service/model with an explicit checkedAt timestamp; no product claim
 * of broad compatibility is allowed.
 */
import type {
  CapabilityProbeName,
  CapabilityReport,
  ModelEvent,
  ModelRequest,
  ProviderAdapter,
  ProviderAdapterType,
  ProviderCapabilities,
  ProviderProfile,
} from '@ca/contracts';

export interface ProviderCredentials {
  readonly value: string;
  /** Never log this; used only for masked hints like `sk-…abcd`. */
  readonly hint: string;
}

export interface CredentialStatus {
  configured: boolean;
  hint: string | null;
  error: string | null;
}

export interface CredentialStore {
  /** Resolve a credential reference to a secret value (server-side only). */
  get(ref: string): Promise<ProviderCredentials | null>;
  status(ref: string): Promise<CredentialStatus>;
  /** Persist a credential value (encrypted at rest). Empty string clears it. */
  set(ref: string, value: string): Promise<void>;
}

export interface AdapterOptions {
  fetchImpl?: typeof fetch;
  /** Overrides from the profile's timeout configuration. */
  firstEventTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  now?: () => number;
}

export interface AdapterFactory {
  adapterType: ProviderAdapterType;
  create(profile: ProviderProfile, credential: string, options?: AdapterOptions): ProviderAdapter;
}

export interface CapabilityTestInput {
  profile: ProviderProfile;
  credential: string;
  probes: readonly CapabilityProbeName[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Abort the whole capability test (does not abort a single probe silently). */
  signal?: AbortSignal;
}

export interface CapabilityTestOutput {
  report: CapabilityReport;
}

export interface UrlPolicy {
  allowHttpLoopback: boolean;
  allowedProviderHosts: readonly string[];
}

export interface ProviderPackageExports {
  createAdapter(profile: ProviderProfile, credential: string, options?: AdapterOptions): ProviderAdapter;
  runCapabilityTests(input: CapabilityTestInput): Promise<CapabilityTestOutput>;
  assertProviderUrlAllowed(url: string, policy: UrlPolicy): void;
  maskCredential(value: string): string;
  probeTextModelRequest(profile: ProviderProfile): ModelRequest;
  /** Internal event used by tests to assert provider behavior. */
  buildCapabilityRequests(profile: ProviderProfile, probes: readonly CapabilityProbeName[]): ModelRequest[];
  streamEventsFromAdapter(adapter: ProviderAdapter, request: ModelRequest, signal: AbortSignal): Promise<ModelEvent[]>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  constructor(code: string, message: string, options: { retryable?: boolean; httpStatus?: number | null; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface ProviderCapabilitiesExplanation {
  capabilities: ProviderCapabilities;
  limitations: string[];
}
