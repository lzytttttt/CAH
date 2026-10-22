/** Provider adapter contracts: capabilities, requests, streaming events, errors. */
import { z } from 'zod';
import {
  JsonObjectSchema,
  JsonValueSchema,
  UtcTimestampSchema,
  ProviderProfileIdSchema,
} from './primitives';

export const CapabilityStatusSchema = z.enum(['verified', 'unsupported', 'unknown']);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const ProviderCapabilitiesSchema = z.object({
  streaming: CapabilityStatusSchema,
  toolCalling: CapabilityStatusSchema,
  structuredOutput: CapabilityStatusSchema,
  vision: CapabilityStatusSchema,
  usageReporting: CapabilityStatusSchema,
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  checkedAt: UtcTimestampSchema.optional(),
  /** Which concrete service/model was actually tested. Never inferred from the product name. */
  testedServiceLabel: z.string().max(200).optional(),
  testedModel: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderAdapterTypeSchema = z.enum(['openai_compatible', 'anthropic_native', 'openai_responses']);
export type ProviderAdapterType = z.infer<typeof ProviderAdapterTypeSchema>;

export const PriceTableSchema = z.object({
  currency: z.literal('USD'),
  inputPerMillionUsd: z.number().nonnegative().nullable(),
  outputPerMillionUsd: z.number().nonnegative().nullable(),
  effectiveFrom: UtcTimestampSchema.optional(),
  sourceNote: z.string().max(500).optional(),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

/**
 * Stored provider profile. Credentials never appear here: `credentialRef` is a
 * logical name resolved by the server from env/key-file storage.
 */
export const ProviderProfileSchema = z.object({
  id: ProviderProfileIdSchema,
  profileName: z.string().min(1).max(100),
  adapterType: ProviderAdapterTypeSchema,
  baseURL: z.string().url().max(2048),
  model: z.string().min(1).max(200),
  credentialRef: z.string().min(1).max(100),
  enabled: z.boolean(),
  timeouts: z
    .object({
      firstEventTimeoutMs: z.number().int().positive().max(600_000).optional(),
      idleTimeoutMs: z.number().int().positive().max(600_000).optional(),
      totalTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    })
    .default({}),
  contextWindowOverride: z.number().int().positive().max(10_000_000).nullish(),
  priceTable: PriceTableSchema.nullable().default(null),
  capabilities: ProviderCapabilitiesSchema.default({
    streaming: 'unknown',
    toolCalling: 'unknown',
    structuredOutput: 'unknown',
    vision: 'unknown',
    usageReporting: 'unknown',
  }),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/** Browser-safe view of a provider profile: no credential reference or secret material. */
export const ProviderProfilePublicSchema = ProviderProfileSchema.omit({ credentialRef: true }).extend({
  credentialConfigured: z.boolean(),
  credentialHint: z.string().max(64).nullable(),
  /** True when the credential is currently unresolved (e.g. env var missing). */
  credentialError: z.string().max(500).nullable(),
});
export type ProviderProfilePublic = z.infer<typeof ProviderProfilePublicSchema>;

/* ------------------------------ messages ------------------------------ */

export const ModelMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type ModelMessageRole = z.infer<typeof ModelMessageRoleSchema>;

export const ModelToolCallSchema = z.object({
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  argumentsJson: z.string().max(200_000),
});
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;

export const ModelMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string().max(400_000) }),
  z.object({ role: z.literal('user'), content: z.string().max(400_000) }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().max(400_000),
    toolCalls: z.array(ModelToolCallSchema).max(32).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string().min(1).max(200),
    content: z.string().max(400_000),
  }),
]);
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(4000),
  parameters: JsonObjectSchema,
  strict: z.boolean().default(true),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ResponseFormatSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }),
  z.object({
    kind: z.literal('json_schema'),
    name: z.string().min(1).max(100),
    schema: JsonObjectSchema,
    strict: z.boolean().default(true),
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const ModelRequestSchema = z.object({
  modelCallId: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  messages: z.array(ModelMessageSchema).min(1).max(200),
  tools: z.array(ToolDefinitionSchema).max(32).default([]),
  toolChoice: z.enum(['auto', 'none', 'required']).default('auto'),
  temperature: z.number().min(0).max(2).nullable().default(null),
  maxOutputTokens: z.number().int().positive().max(200_000).default(8192),
  responseFormat: ResponseFormatSchema.default({ kind: 'text' }),
  stream: z.boolean().default(true),
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

/* --------------------------- stream events --------------------------- */

export const FinishReasonSchema = z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'error', 'unknown']);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  /** `provider` when reported by the service; `estimated` when counted locally. */
  source: z.enum(['provider', 'estimated', 'mixed']),
  costUsd: z.number().nonnegative().nullable().default(null),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const ProviderErrorDetailSchema = z.object({
  code: z.enum([
    'auth_error',
    'rate_limited',
    'model_missing',
    'bad_request',
    'server_error',
    'network_error',
    'first_event_timeout',
    'idle_timeout',
    'total_timeout',
    'cancelled',
    'truncated',
    'refused',
    'invalid_response',
    'unsupported_feature',
    'unknown',
  ]),
  message: z.string().max(4000),
  retryable: z.boolean(),
  httpStatus: z.number().int().nullable().default(null),
  retryAfterMs: z.number().int().nonnegative().nullable().default(null),
  providerRequestId: z.string().max(200).nullable().default(null),
});
export type ProviderErrorDetail = z.infer<typeof ProviderErrorDetailSchema>;

export const ModelEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string().max(200_000) }),
  z.object({
    type: z.literal('tool_call_delta'),
    index: z.number().int().nonnegative(),
    callId: z.string().max(200).optional(),
    name: z.string().max(100).optional(),
    argumentsDelta: z.string().max(100_000),
  }),
  z.object({
    type: z.literal('tool_call_complete'),
    index: z.number().int().nonnegative(),
    callId: z.string().min(1).max(200),
    name: z.string().min(1).max(100),
    argumentsJson: z.string().max(200_000),
  }),
  z.object({ type: z.literal('usage'), usage: ModelUsageSchema }),
  z.object({ type: z.literal('finish'), reason: FinishReasonSchema }),
  z.object({ type: z.literal('error'), error: ProviderErrorDetailSchema }),
]);
export type ModelEvent = z.infer<typeof ModelEventSchema>;

/** Capability probe result for the two-step connection test (section 6.1). */
export const CapabilityProbeSchema = z.object({
  capability: z.enum(['auth_and_text', 'streaming', 'tool_calling', 'structured_output', 'usage']),
  status: z.enum(['verified', 'unsupported', 'unknown', 'error']),
  detail: z.string().max(2000),
  latencyMs: z.number().int().nonnegative().nullable().default(null),
  testedModel: z.string().max(200).nullable().default(null),
  testedAt: UtcTimestampSchema,
  error: ProviderErrorDetailSchema.nullable().default(null),
});
export type CapabilityProbe = z.infer<typeof CapabilityProbeSchema>;

export const CapabilityReportSchema = z.object({
  profileId: ProviderProfileIdSchema,
  serviceLabel: z.string().max(200),
  testedModel: z.string().max(200),
  probes: z.array(CapabilityProbeSchema).max(16),
  capabilities: ProviderCapabilitiesSchema,
  requestCount: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  startedAt: UtcTimestampSchema,
  finishedAt: UtcTimestampSchema,
});
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>;

/** Adapter internal state that must round-trip opaquely (e.g. reasoning items). */
export const ProviderContinuationSchema = z.object({
  profileId: ProviderProfileIdSchema,
  model: z.string().max(200),
  payload: JsonValueSchema,
  expiresAt: UtcTimestampSchema.nullable(),
  encrypted: z.boolean().default(false),
});
export type ProviderContinuation = z.infer<typeof ProviderContinuationSchema>;

export interface ProviderAdapter {
  readonly adapterType: ProviderAdapterType;
  capabilities(profileId: string): Promise<ProviderCapabilities>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ProviderAdapterFactory {
  create(profile: ProviderProfile, credential: string): ProviderAdapter;
}
