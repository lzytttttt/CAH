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
  /**
   * URL policy applied to the profile base URL and to every redirect target.
   * When omitted the adapter only accepts http(s) URLs and same-origin
   * redirects (an approved call site should always pass the policy).
   */
  urlPolicy?: UrlPolicy;
  /** Maximum number of method-preserving redirects to follow. Default 3. */
  maxRedirects?: number;
  /** Field used for the output token cap. Default 'max_tokens'. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Request `stream_options.include_usage` on streaming calls. Default true. */
  includeStreamUsage?: boolean;
  /**
   * One-shot adaptive serialization: if a streaming request is rejected with
   * 400/422 and the body explicitly complains about `stream_options` /
   * `include_usage`, retry once without that optional field. Default true.
   * This is never a fallback to another provider, model or mock.
   */
  retryWithoutStreamUsageOnBadRequest?: boolean;
  /** Hard cap for error response bodies read for diagnostics. Default 64 KiB. */
  maxErrorBodyBytes?: number;
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
  /**
   * Hard per-probe wall-clock guard. The adapter still applies the profile's
   * own first-event/idle/total timeouts; this guard prevents a connection test
   * from hanging when a provider trickles bytes forever. Default 45_000 ms.
   */
  probeTimeoutMs?: number;
  /** Endpoint policy used when constructing the adapter under test. */
  urlPolicy?: UrlPolicy;
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
  /** Provider-side request id (from response headers) when known. */
  readonly providerRequestId: string | null;
  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      httpStatus?: number | null;
      retryAfterMs?: number | null;
      providerRequestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.providerRequestId = options.providerRequestId ?? null;
  }
}

export interface ProviderCapabilitiesExplanation {
  capabilities: ProviderCapabilities;
  limitations: string[];
}
