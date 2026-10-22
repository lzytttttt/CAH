/**
 * Two-step provider capability test (design sections 6.1 / 6.2).
 *
 * Step 1 is always a small non-streaming auth + basic-text probe. Only when it
 * succeeds are the explicitly requested feature probes executed. Each probe is
 * a real bounded request; a capability is marked `verified` only when observed
 * behavior proves it (HTTP 200, a model name or an "OpenAI compatible" claim are
 * never enough), `unsupported` only when the provider explicitly rejects the
 * feature, and `unknown` otherwise.
 */
import {
  CapabilityReportSchema,
  ModelRequestSchema,
  type CapabilityProbe,
  type CapabilityProbeName,
  type CapabilityReport,
  type CapabilityStatus,
  type ModelEvent,
  type ModelRequest,
  type ProviderCapabilities,
  type ProviderErrorDetail,
  type ProviderProfile,
} from '@ca/contracts';
import type { CapabilityTestInput, CapabilityTestOutput } from './types';
import { ProviderError } from './types';
import { createAdapter } from './openai-compatible';
import { providerErrorDetail, sanitizeProviderMessage, toProviderError } from './errors';
import { computeCostUsd, estimateRequestTokens, estimateTokens } from './token-estimate';

const DEFAULT_PROBE_TIMEOUT_MS = 45_000;
const CAPABILITY_PROBE_ORDER: readonly CapabilityProbeName[] = [
  'auth_and_text',
  'streaming',
  'tool_calling',
  'structured_output',
  'usage',
];
const PROBE_MAX_OUTPUT_TOKENS = 64;
const MAX_DETAIL_CHARS = 2000;

export interface CapabilityProbePlanEntry {
  probe: CapabilityProbeName;
  request: ModelRequest;
}

function shortProfileId(profile: ProviderProfile): string {
  return profile.id.replace(/-/g, '').slice(0, 8) || 'profile';
}

function probeModelCallId(profile: ProviderProfile, probe: CapabilityProbeName): string {
  return `cap_${probe}_${shortProfileId(profile)}`.slice(0, 100);
}

function baseMessages(userContent: string): ModelRequest['messages'] {
  return [
    {
      role: 'system',
      content: 'You are a provider connection test. Follow the instruction exactly and answer briefly.',
    },
    { role: 'user', content: userContent },
  ];
}

/** The step-1 request: minimal non-streaming text round trip. */
export function probeTextModelRequest(profile: ProviderProfile): ModelRequest {
  return ModelRequestSchema.parse({
    modelCallId: probeModelCallId(profile, 'auth_and_text'),
    model: profile.model,
    messages: baseMessages('Reply with the single word: OK'),
    tools: [],
    toolChoice: 'none',
    temperature: 0,
    maxOutputTokens: 16,
    responseFormat: { kind: 'text' },
    stream: false,
  });
}

function buildProbeRequest(profile: ProviderProfile, probe: CapabilityProbeName): ModelRequest {
  switch (probe) {
    case 'auth_and_text':
      return probeTextModelRequest(profile);
    case 'streaming':
      return ModelRequestSchema.parse({
        modelCallId: probeModelCallId(profile, probe),
        model: profile.model,
        messages: baseMessages('Probe streaming: count from 1 to 5 separated by single spaces. Do not add other text.'),
        tools: [],
        toolChoice: 'none',
        temperature: 0,
        maxOutputTokens: 32,
        responseFormat: { kind: 'text' },
        stream: true,
      });
    case 'tool_calling':
      return ModelRequestSchema.parse({
        modelCallId: probeModelCallId(profile, probe),
        model: profile.model,
        messages: baseMessages('Probe tool calling: call record_probe_value with value 42.'),
        tools: [
          {
            name: 'record_probe_value',
            description: 'Records a probe value for the provider capability test.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'integer' } },
              required: ['value'],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
        toolChoice: 'required',
        temperature: 0,
        maxOutputTokens: 64,
        responseFormat: { kind: 'text' },
        stream: true,
      });
    case 'structured_output':
      return ModelRequestSchema.parse({
        modelCallId: probeModelCallId(profile, probe),
        model: profile.model,
        messages: baseMessages('Probe structured output: return exactly the JSON object {"status":"ok"}.'),
        tools: [],
        toolChoice: 'none',
        temperature: 0,
        maxOutputTokens: 48,
        responseFormat: {
          kind: 'json_schema',
          name: 'capability_probe',
          schema: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
            additionalProperties: false,
          },
          strict: true,
        },
        stream: true,
      });
    case 'usage':
      return ModelRequestSchema.parse({
        modelCallId: probeModelCallId(profile, probe),
        model: profile.model,
        messages: baseMessages('Probe usage: reply with the single word OK.'),
        tools: [],
        toolChoice: 'none',
        temperature: 0,
        maxOutputTokens: 16,
        responseFormat: { kind: 'text' },
        stream: true,
      });
    default: {
      const exhaustive: never = probe;
      throw new ProviderError('bad_request', `unknown capability probe ${String(exhaustive)}`, { retryable: false });
    }
  }
}

/**
 * Canonical probe plan: `auth_and_text` always runs first, requested probes are
 * appended in the documented order and deduplicated.
 */
export function buildCapabilityRequestPlan(
  profile: ProviderProfile,
  probes: readonly CapabilityProbeName[],
): CapabilityProbePlanEntry[] {
  const requested = new Set<CapabilityProbeName>();
  for (const probe of probes) {
    if (!CAPABILITY_PROBE_ORDER.includes(probe)) {
      throw new ProviderError('bad_request', `unknown capability probe: ${String(probe)}`, { retryable: false });
    }
    requested.add(probe);
  }
  requested.add('auth_and_text'); // step 1 is mandatory
  return CAPABILITY_PROBE_ORDER.filter((probe) => requested.has(probe)).map((probe) => ({
    probe,
    request: buildProbeRequest(profile, probe),
  }));
}

/** Deterministic probe requests used by the two-step connection test. */
export function buildCapabilityRequests(
  profile: ProviderProfile,
  probes: readonly CapabilityProbeName[],
): ModelRequest[] {
  return buildCapabilityRequestPlan(profile, probes).map((entry) => entry.request);
}

/* ------------------------------------------------------------------ */
/* Probe execution                                                     */
/* ------------------------------------------------------------------ */

interface ProbeExecution {
  probe: CapabilityProbe;
  inputTokens: number;
  outputTokens: number;
  providerUsageSeen: boolean;
}

interface ProbeRunContext {
  profile: ProviderProfile;
  credential: string;
  probeTimeoutMs: number;
  now: () => number;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function truncateDetail(text: string, max = MAX_DETAIL_CHARS): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}\u2026` : text;
}

function makeProbe(
  capability: CapabilityProbeName,
  status: CapabilityProbe['status'],
  detail: string,
  latencyMs: number | null,
  testedModel: string | null,
  testedAt: string,
  error: ProviderErrorDetail | null,
): CapabilityProbe {
  return {
    capability,
    status,
    detail: truncateDetail(detail),
    latencyMs,
    testedModel,
    testedAt,
    error,
  };
}

function errorDetailFrom(event: ModelEvent | undefined, thrown: ProviderError | null, credential: string): ProviderErrorDetail | null {
  if (event && event.type === 'error') return event.error;
  if (thrown) return providerErrorDetail(thrown, { secrets: [credential] });
  return null;
}

function classifyRejection(
  error: ProviderErrorDetail,
  featurePattern: RegExp,
  featureName: string,
): CapabilityProbe['status'] {
  if (error.code === 'unsupported_feature') return 'unsupported';
  if (error.code === 'bad_request' || error.code === 'refused') {
    // The provider explicitly rejected the request. Only claim `unsupported`
    // when the message points at the feature that was probed; otherwise the
    // rejection is not valid evidence about the capability.
    if (featurePattern.test(error.message)) return 'unsupported';
    return 'error';
  }
  void featureName;
  return 'error';
}

function analyzeProbe(
  capability: CapabilityProbeName,
  events: readonly ModelEvent[],
  thrown: ProviderError | null,
  credential: string,
  latencyMs: number,
  testedModel: string,
  testedAt: string,
): CapabilityProbe {
  const errorEvent = events.find((event) => event.type === 'error');
  const error = errorDetailFrom(errorEvent, thrown, credential);
  const text = events
    .filter((event): event is Extract<ModelEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
  const textDeltaCount = events.filter((event) => event.type === 'text_delta').length;
  const completes = events.filter(
    (event): event is Extract<ModelEvent, { type: 'tool_call_complete' }> => event.type === 'tool_call_complete',
  );
  const usageEvents = events.filter(
    (event): event is Extract<ModelEvent, { type: 'usage' }> => event.type === 'usage',
  );
  const finishEvent = [...events].reverse().find((event) => event.type === 'finish');
  const finishReason = finishEvent && finishEvent.type === 'finish' ? finishEvent.reason : null;

  const failed = (detail: string): CapabilityProbe =>
    makeProbe(capability, 'error', detail, latencyMs, testedModel, testedAt, error);
  const unknown = (detail: string): CapabilityProbe =>
    makeProbe(capability, 'unknown', detail, latencyMs, testedModel, testedAt, error);
  const unsupported = (detail: string): CapabilityProbe =>
    makeProbe(capability, 'unsupported', detail, latencyMs, testedModel, testedAt, error);
  const verified = (detail: string): CapabilityProbe =>
    makeProbe(capability, 'verified', detail, latencyMs, testedModel, testedAt, null);

  switch (capability) {
    case 'auth_and_text': {
      if (error) return failed(`basic text probe failed: ${error.message}`);
      if (text.trim().length === 0) return unknown('provider returned a successful response without text content');
      return verified(
        `basic text returned (${text.trim().length} chars, finish_reason=${finishReason ?? 'none'})`,
      );
    }
    case 'streaming': {
      if (error) {
        return classifyRejection(error, /stream|sse|event[- ]?stream/i, 'streaming') === 'unsupported'
          ? unsupported(`provider rejected streaming: ${error.message}`)
          : failed(`streaming probe failed: ${error.message}`);
      }
      if (textDeltaCount >= 2) {
        return verified(`received ${textDeltaCount} progressive text deltas (finish_reason=${finishReason ?? 'none'})`);
      }
      if (textDeltaCount === 1) {
        return unknown(
          'provider delivered the response as a single chunk, so progressive streaming was not demonstrated',
        );
      }
      return unknown('provider returned no text deltas');
    }
    case 'tool_calling': {
      if (error) {
        const status = classifyRejection(error, /tool|function/i, 'tool calling');
        return status === 'unsupported'
          ? unsupported(`provider rejected native tool calling: ${error.message}`)
          : failed(`tool calling probe failed: ${error.message}`);
      }
      const first = completes[0];
      if (!first) {
        if (text.trim().length > 0) {
          return unsupported('model replied with text instead of a tool call; native tool calling was not demonstrated');
        }
        return unknown('no tool call and no text were returned');
      }
      try {
        const parsed: unknown = JSON.parse(first.argumentsJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'value' in (parsed as Record<string, unknown>)) {
          return verified(`native tool call received (${first.name}, call id present, valid JSON arguments)`);
        }
        return unknown('tool call was returned but its arguments did not match the probe schema');
      } catch {
        return unknown('tool call was returned but its arguments were not valid JSON');
      }
    }
    case 'structured_output': {
      if (error) {
        const status = classifyRejection(error, /response[_-]?format|json[_-]?schema|structured|schema/i, 'structured output');
        return status === 'unsupported'
          ? unsupported(`provider rejected structured output: ${error.message}`)
          : failed(`structured output probe failed: ${error.message}`);
      }
      if (text.trim().length === 0) return unknown('provider returned no text for the structured output probe');
      try {
        const parsed: unknown = JSON.parse(text.trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>)['status'] === 'string') {
          return verified('provider honored the JSON schema response format with a conforming object');
        }
        return unknown('provider returned JSON that did not conform to the probe schema');
      } catch {
        return unknown('provider ignored the JSON schema response format and returned non-JSON text');
      }
    }
    case 'usage': {
      if (error) {
        const status = classifyRejection(error, /usage|stream_options|include_usage|token/i, 'usage reporting');
        return status === 'unsupported'
          ? unsupported(`provider rejected the usage probe: ${error.message}`)
          : failed(`usage probe failed: ${error.message}`);
      }
      const usageEvent = usageEvents[usageEvents.length - 1];
      if (!usageEvent) return unknown('provider returned no usage event');
      if (usageEvent.usage.source === 'provider') {
        if (usageEvent.usage.inputTokens !== null && usageEvent.usage.outputTokens !== null) {
          return verified(
            `provider reported usage (input=${usageEvent.usage.inputTokens}, output=${usageEvent.usage.outputTokens})`,
          );
        }
        return unknown('provider reported partial usage only');
      }
      if (usageEvent.usage.source === 'mixed') return unknown('provider reported only partial usage');
      return unsupported('provider did not report usage; only local estimates are available');
    }
    default: {
      const exhaustive: never = capability;
      return unknown(`unhandled probe ${String(exhaustive)}`);
    }
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(onTimeout());
    }, Math.max(0, timeoutMs));
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function runProbe(
  adapter: ReturnType<typeof createAdapter>,
  entry: CapabilityProbePlanEntry,
  context: ProbeRunContext,
  externalSignal: AbortSignal | undefined,
): Promise<ProbeExecution> {
  const testedAt = nowIso(context.now);
  const startedAt = Date.now();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new ProviderError('cancelled', 'capability test was cancelled', { retryable: false });
    }
    externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const events: ModelEvent[] = [];
  let thrown: ProviderError | null = null;
  const iterator = adapter.stream(entry.request, controller.signal)[Symbol.asyncIterator]();
  const deadline = startedAt + context.probeTimeoutMs;
  try {
    while (true) {
      if (externalSignal?.aborted) {
        controller.abort();
        throw new ProviderError('cancelled', 'capability test was cancelled', { retryable: false });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        controller.abort();
        throw new ProviderError(
          'total_timeout',
          `capability probe exceeded the ${context.probeTimeoutMs}ms guard`,
          { retryable: true },
        );
      }
      let next: IteratorResult<ModelEvent>;
      try {
        next = await withDeadline(iterator.next(), remaining, () => {
          controller.abort();
          return new ProviderError(
            'total_timeout',
            `capability probe exceeded the ${context.probeTimeoutMs}ms guard`,
            { retryable: true },
          );
        });
      } catch (error) {
        thrown = toProviderError(error, { secrets: [context.credential] });
        break;
      }
      if (next.done) break;
      if (next.value) events.push(next.value);
    }
  } finally {
    externalSignal?.removeEventListener('abort', onAbort);
    try {
      await withDeadline(Promise.resolve(iterator.return?.(undefined)), 1_000, () => new Error('cleanup timeout'));
    } catch {
      /* cleanup is best effort */
    }
  }
  const latencyMs = Math.max(0, Date.now() - startedAt);
  const probe = analyzeProbe(
    entry.probe,
    events,
    thrown,
    context.credential,
    latencyMs,
    context.profile.model,
    testedAt,
  );

  const usageEvent = [...events].reverse().find((event) => event.type === 'usage');
  const text = events
    .filter((event): event is Extract<ModelEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
  const toolArguments = events
    .filter((event): event is Extract<ModelEvent, { type: 'tool_call_complete' }> => event.type === 'tool_call_complete')
    .map((event) => `${event.name}${event.argumentsJson}`)
    .join('');
  let inputTokens: number;
  let outputTokens: number;
  let providerUsageSeen = false;
  if (usageEvent && usageEvent.type === 'usage') {
    inputTokens = usageEvent.usage.inputTokens ?? estimateRequestTokens(entry.request);
    outputTokens = usageEvent.usage.outputTokens ?? estimateTokens(`${text}${toolArguments}`);
    providerUsageSeen = usageEvent.usage.source === 'provider' || usageEvent.usage.source === 'mixed';
  } else {
    inputTokens = estimateRequestTokens(entry.request);
    outputTokens = estimateTokens(`${text}${toolArguments}`);
  }
  return { probe, inputTokens, outputTokens, providerUsageSeen };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function serviceLabelFor(profile: ProviderProfile): string {
  try {
    const url = new URL(profile.baseURL);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.host}${path}`.slice(0, 200) || profile.profileName.slice(0, 200);
  } catch {
    return profile.profileName.slice(0, 200);
  }
}

function statusFromProbe(probe: CapabilityProbe | undefined): CapabilityStatus {
  if (!probe) return 'unknown';
  switch (probe.status) {
    case 'verified':
      return 'verified';
    case 'unsupported':
      return 'unsupported';
    default:
      // `unknown` and transport `error` never become a capability claim.
      return 'unknown';
  }
}

function resolveProbeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProviderError('bad_request', 'invalid capability probe timeout', { retryable: false });
  }
  return Math.trunc(value);
}

/**
 * Execute the two-step connection test. Returns a self-contained report with
 * per-probe evidence; throws `ProviderError('cancelled')` only when the caller
 * aborts the whole test.
 */
export async function runCapabilityTests(input: CapabilityTestInput): Promise<CapabilityTestOutput> {
  const secrets = [input.credential];
  const now = input.now ?? Date.now;
  const probeTimeoutMs = resolveProbeTimeout(input.probeTimeoutMs);
  if (input.signal?.aborted) {
    throw new ProviderError('cancelled', 'capability test was cancelled before it started', { retryable: false });
  }
  if (input.probes.length === 0) {
    throw new ProviderError('bad_request', 'capability test needs at least one probe', { retryable: false });
  }
  const plan = buildCapabilityRequestPlan(input.profile, input.probes);
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  let requestCount = 0;
  const baseFetch = input.fetchImpl ?? fetch;
  const countingFetch: typeof fetch = (resource, init) => {
    requestCount += 1;
    return baseFetch(resource, init);
  };

  let adapter: ReturnType<typeof createAdapter> | null = null;
  let constructionError: ProviderError | null = null;
  try {
    adapter = createAdapter(input.profile, input.credential, {
      fetchImpl: countingFetch,
      urlPolicy: input.urlPolicy,
    });
  } catch (error) {
    constructionError = toProviderError(error, { secrets });
  }

  const context: ProbeRunContext = {
    profile: input.profile,
    credential: input.credential,
    probeTimeoutMs,
    now,
  };
  const probes: CapabilityProbe[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let basicTextVerified = false;
  for (const entry of plan) {
    if (input.signal?.aborted) {
      throw new ProviderError('cancelled', 'capability test was cancelled', { retryable: false });
    }
    if (constructionError || !adapter) {
      const detail = constructionError ?? new ProviderError('unknown', 'provider adapter could not be created');
      probes.push(
        makeProbe(
          entry.probe,
          'error',
          `provider adapter could not be created: ${detail.message}`,
          null,
          input.profile.model,
          nowIso(now),
          providerErrorDetail(detail, { secrets }),
        ),
      );
      continue;
    }
    if (entry.probe !== 'auth_and_text' && !basicTextVerified) {
      probes.push(
        makeProbe(
          entry.probe,
          'unknown',
          'not run: the auth_and_text probe did not verify basic text output',
          null,
          input.profile.model,
          nowIso(now),
          null,
        ),
      );
      continue;
    }
    const execution = await runProbe(adapter, entry, context, input.signal);
    probes.push(execution.probe);
    totalInputTokens += execution.inputTokens;
    totalOutputTokens += execution.outputTokens;
    if (entry.probe === 'auth_and_text') basicTextVerified = execution.probe.status === 'verified';
  }
  if (input.signal?.aborted) {
    throw new ProviderError('cancelled', 'capability test was cancelled', { retryable: false });
  }

  const finishedAtMs = now();
  const finishedAt = new Date(finishedAtMs).toISOString();
  const findProbe = (capability: CapabilityProbeName): CapabilityProbe | undefined =>
    probes.find((probe) => probe.capability === capability);
  const capabilities: ProviderCapabilities = {
    streaming: statusFromProbe(findProbe('streaming')),
    toolCalling: statusFromProbe(findProbe('tool_calling')),
    structuredOutput: statusFromProbe(findProbe('structured_output')),
    vision: 'unknown',
    usageReporting: statusFromProbe(findProbe('usage')),
    checkedAt: finishedAt,
    testedServiceLabel: serviceLabelFor(input.profile),
    testedModel: input.profile.model,
  };
  if (input.profile.contextWindowOverride) {
    capabilities.contextWindow = input.profile.contextWindowOverride;
  }
  const noteParts = [
    'Two-step connection test: basic text first, then explicit feature probes.',
    'Capabilities without a verified probe remain unknown.',
    'Vision was not tested.',
  ];
  if (input.profile.contextWindowOverride) {
    noteParts.push('contextWindow is the configured override, not a measured value.');
  }
  if (constructionError) noteParts.push('The adapter could not be constructed; no probe request was sent.');
  capabilities.notes = truncateDetail(noteParts.join(' '));

  const estimatedCostUsd = input.profile.priceTable
    ? computeCostUsd(input.profile.priceTable, totalInputTokens, totalOutputTokens)
    : null;
  const report: CapabilityReport = CapabilityReportSchema.parse({
    profileId: input.profile.id,
    serviceLabel: serviceLabelFor(input.profile),
    testedModel: input.profile.model,
    probes,
    capabilities,
    requestCount,
    estimatedCostUsd,
    startedAt,
    finishedAt,
  });
  return { report };
}

/** Exposed for callers that want to display error text without secrets. */
export function describeProviderErrorForUser(error: unknown, secrets: readonly string[] = []): string {
  return sanitizeProviderMessage(error, { secrets, maxLength: 500 });
}
