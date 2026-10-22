/**
 * OpenAI-compatible Chat Completions adapter (design sections 6.2 / 6.3).
 *
 * Implements a real streaming adapter against `POST {baseURL}/chat/completions`:
 * full OpenAI-compatible message/tool/response-format serialization, SSE parsing
 * with per-index tool-call assembly, deterministic error mapping, first-event /
 * idle / total timeouts, abort support, redirect approval and usage accounting.
 *
 * It never executes tools, never fabricates provider usage and never falls back
 * to another provider, model or mock. Failures are surfaced as one terminal
 * `error` event (partial text/tool deltas that were already produced remain
 * valid and have been yielded before the error).
 */
import {
  ModelRequestSchema,
  TIME_LIMITS,
  type FinishReason,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
  type ProviderAdapter,
  type ProviderAdapterType,
  type ProviderCapabilities,
  type ProviderErrorDetail,
  type ProviderProfile,
  type ResponseFormat,
  type ToolDefinition,
} from '@ca/contracts';
import type { AdapterOptions, UrlPolicy } from './types';
import { ProviderError } from './types';
import {
  extractProviderRequestId,
  isAbortError,
  providerErrorDetail,
  providerErrorFromApiPayload,
  providerErrorFromHttpResponse,
  sanitizeProviderMessage,
  toProviderError,
} from './errors';
import { SseDecoder, type SseRecord } from './sse';
import { computeCostUsd, estimateRequestTokens, estimateTokens } from './token-estimate';
import { assertProviderUrlAllowed, assertRedirectAllowed } from './url-policy';

/* ------------------------------------------------------------------ */
/* Constants / defaults                                                */
/* ------------------------------------------------------------------ */

/** Timeout defaults from the design (contracts TIME_LIMITS, section 21.2). */
export const DEFAULT_PROVIDER_TIMEOUTS = {
  firstEventTimeoutMs: TIME_LIMITS.firstEventTimeoutMs,
  idleTimeoutMs: TIME_LIMITS.idleTimeoutMs,
  totalTimeoutMs: TIME_LIMITS.totalModelRequestTimeoutMs,
} as const;

/**
 * Conservative default endpoint policy for a directly constructed adapter:
 * HTTPS for remote/internal targets, plain HTTP only for explicit loopback.
 * Call sites that need internal hosts must pass an explicit `urlPolicy`.
 */
export const DEFAULT_ADAPTER_URL_POLICY: UrlPolicy = {
  allowHttpLoopback: true,
  allowedProviderHosts: [],
};

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SSE_CHUNK_CHARS = 4 * 1024 * 1024;
const MAX_TEXT_EVENT_CHARS = 200_000;
const MAX_TOOL_ARGUMENT_CHARS = 200_000;
const MAX_TOOL_CALLS = 32;
const USER_AGENT = 'cognitive-atrium-providers/0.1.0';

/* ------------------------------------------------------------------ */
/* Wire types                                                          */
/* ------------------------------------------------------------------ */

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface WireToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown>; strict: boolean };
}

type WireToolChoice = 'auto' | 'none' | 'required';

interface WireResponseFormat {
  type: 'json_schema';
  json_schema: { name: string; schema: Record<string, unknown>; strict: boolean };
}

export interface OpenAIChatRequestPayload {
  model: string;
  messages: WireMessage[];
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  tools?: WireToolDefinition[];
  tool_choice?: WireToolChoice;
  response_format?: WireResponseFormat;
  stream_options?: { include_usage: boolean };
}

export interface SerializeOptions {
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  includeStreamUsage?: boolean;
}

/* ------------------------------------------------------------------ */
/* Request serialization                                               */
/* ------------------------------------------------------------------ */

/** Build the Chat Completions URL from a profile baseURL. */
export function buildChatCompletionsUrl(baseURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new ProviderError('bad_request', 'provider baseURL is not a valid absolute URL', { retryable: false });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProviderError('bad_request', 'provider baseURL must use http or https', { retryable: false });
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ProviderError('bad_request', 'provider baseURL must not embed credentials', { retryable: false });
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function serializeMessage(message: ModelRequest['messages'][number]): WireMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      const toolCalls = message.toolCalls ?? [];
      const wire: WireMessage = {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : toolCalls.length > 0 ? null : '',
      };
      if (toolCalls.length > 0) {
        wire.tool_calls = toolCalls.map((call) => ({
          id: call.callId,
          type: 'function',
          function: { name: call.name, arguments: call.argumentsJson },
        }));
      }
      return wire;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}

function serializeTool(tool: ToolDefinition): WireToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      strict: tool.strict,
    },
  };
}

function serializeResponseFormat(format: ResponseFormat): WireResponseFormat | null {
  if (format.kind === 'text') return null;
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      schema: format.schema as Record<string, unknown>,
      strict: format.strict,
    },
  };
}

/**
 * Serialize a contract `ModelRequest` into an OpenAI Chat Completions payload.
 * Field names not supported by a given vendor can be adapted here (section 6.2).
 */
export function serializeOpenAIRequest(request: ModelRequest, options: SerializeOptions = {}): OpenAIChatRequestPayload {
  if (request.toolChoice === 'required' && request.tools.length === 0) {
    throw new ProviderError('bad_request', 'toolChoice "required" needs at least one tool definition', {
      retryable: false,
    });
  }
  const payload: OpenAIChatRequestPayload = {
    model: request.model,
    messages: request.messages.map(serializeMessage),
    stream: request.stream,
  };
  const maxTokensField = options.maxTokensField ?? 'max_tokens';
  if (maxTokensField === 'max_completion_tokens') payload.max_completion_tokens = request.maxOutputTokens;
  else payload.max_tokens = request.maxOutputTokens;
  if (request.temperature !== null) payload.temperature = request.temperature;
  if (request.tools.length > 0) {
    payload.tools = request.tools.map(serializeTool);
    if (request.toolChoice !== 'auto') payload.tool_choice = request.toolChoice;
  }
  const responseFormat = serializeResponseFormat(request.responseFormat);
  if (responseFormat) payload.response_format = responseFormat;
  if (request.stream && options.includeStreamUsage !== false) {
    payload.stream_options = { include_usage: true };
  }
  return payload;
}

/** Map an OpenAI finish_reason string onto the contract enum. */
export function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    case null:
    case undefined:
    case '':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

interface RequestRuntime {
  startedAt: number;
  abortReason: 'cancelled' | 'total_timeout' | null;
  firstEventDelivered: boolean;
  totalTimer: NodeJS.Timeout | null;
}

interface ToolCallAccumulator {
  index: number;
  callId: string;
  name: string;
  arguments: string;
  sawArguments: boolean;
}

interface RequestAccumulator {
  request: ModelRequest;
  text: string;
  refusal: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  providerUsage: ModelUsage | null;
  finishReason: FinishReason | null;
  doneSeen: boolean;
  emittedDelta: boolean;
  terminalEmitted: boolean;
  requestId: string | null;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly adapterType: ProviderAdapterType = 'openai_compatible';
  readonly profile: ProviderProfile;

  readonly #credential: string;
  readonly #options: AdapterOptions;
  readonly #fetchImpl: typeof fetch;
  readonly #requestUrl: string;
  readonly #firstEventTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #maxRedirects: number;
  readonly #urlPolicy: UrlPolicy;
  readonly #maxErrorBodyBytes: number;
  readonly #maxTokensField: 'max_tokens' | 'max_completion_tokens';
  readonly #includeStreamUsage: boolean;
  readonly #retryWithoutStreamUsage: boolean;

  constructor(profile: ProviderProfile, credential: string, options: AdapterOptions = {}) {
    if (profile.adapterType !== 'openai_compatible') {
      throw new ProviderError(
        'unsupported_feature',
        `OpenAICompatibleAdapter cannot handle adapterType ${profile.adapterType}`,
        { retryable: false },
      );
    }
    const normalizedCredential = typeof credential === 'string' ? credential.trim() : '';
    if (normalizedCredential.length === 0) {
      throw new ProviderError('auth_error', 'no credential is configured for this provider profile', {
        retryable: false,
      });
    }
    if (/[\r\n]/.test(normalizedCredential)) {
      throw new ProviderError('auth_error', 'provider credential contains invalid characters', { retryable: false });
    }
    this.profile = profile;
    this.#credential = normalizedCredential;
    this.#options = options;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    if (typeof this.#fetchImpl !== 'function') {
      throw new ProviderError('unknown', 'no fetch implementation is available in this runtime', { retryable: false });
    }
    this.#firstEventTimeoutMs = resolveTimeout(
      options.firstEventTimeoutMs,
      profile.timeouts?.firstEventTimeoutMs,
      DEFAULT_PROVIDER_TIMEOUTS.firstEventTimeoutMs,
      'firstEventTimeoutMs',
    );
    this.#idleTimeoutMs = resolveTimeout(
      options.idleTimeoutMs,
      profile.timeouts?.idleTimeoutMs,
      DEFAULT_PROVIDER_TIMEOUTS.idleTimeoutMs,
      'idleTimeoutMs',
    );
    this.#totalTimeoutMs = resolveTimeout(
      options.totalTimeoutMs,
      profile.timeouts?.totalTimeoutMs,
      DEFAULT_PROVIDER_TIMEOUTS.totalTimeoutMs,
      'totalTimeoutMs',
    );
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#maxRedirects = Number.isInteger(maxRedirects) && maxRedirects >= 0 ? Math.min(maxRedirects, 10) : DEFAULT_MAX_REDIRECTS;
    this.#urlPolicy = options.urlPolicy ?? DEFAULT_ADAPTER_URL_POLICY;
    const maxErrorBodyBytes = options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES;
    this.#maxErrorBodyBytes =
      Number.isInteger(maxErrorBodyBytes) && maxErrorBodyBytes > 0
        ? Math.min(maxErrorBodyBytes, 1024 * 1024)
        : DEFAULT_MAX_ERROR_BODY_BYTES;
    this.#maxTokensField = options.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
    this.#includeStreamUsage = options.includeStreamUsage !== false;
    this.#retryWithoutStreamUsage = options.retryWithoutStreamUsageOnBadRequest !== false;
    this.#requestUrl = buildChatCompletionsUrl(profile.baseURL);
    try {
      assertProviderUrlAllowed(this.#requestUrl, this.#urlPolicy);
    } catch (error) {
      throw new ProviderError(
        'bad_request',
        `provider endpoint is not allowed by URL policy: ${sanitizeProviderMessage(error, {
          secrets: [this.#credential],
        })}`,
        { retryable: false },
      );
    }
  }

  async capabilities(_profileId: string): Promise<ProviderCapabilities> {
    // Never infer capabilities: report exactly what was stored after an explicit
    // capability test (defaults are 'unknown').
    return { ...this.profile.capabilities };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const secrets = [this.#credential];
    const controller = new AbortController();
    const runtime: RequestRuntime = {
      startedAt: Date.now(),
      abortReason: null,
      firstEventDelivered: false,
      totalTimer: null,
    };
    const onExternalAbort = (): void => {
      if (runtime.abortReason === null) runtime.abortReason = 'cancelled';
      controller.abort();
    };
    if (signal.aborted) {
      if (runtime.abortReason === null) runtime.abortReason = 'cancelled';
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    runtime.totalTimer = setTimeout(() => {
      if (runtime.abortReason === null) runtime.abortReason = 'total_timeout';
      controller.abort();
    }, this.#totalTimeoutMs);
    runtime.totalTimer.unref?.();

    let accumulator: RequestAccumulator | null = null;
    try {
      if (signal.aborted) {
        throw new ProviderError('cancelled', 'model request was cancelled before it started', { retryable: false });
      }
      const parsed = ModelRequestSchema.safeParse(request);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new ProviderError('bad_request', `invalid model request: ${issues}`, { retryable: false });
      }
      const validRequest = parsed.data;
      accumulator = createAccumulator(validRequest);
      if (validRequest.stream) {
        yield* this.#streamViaSse(validRequest, controller, runtime, signal, accumulator);
      } else {
        yield* this.#streamViaJson(validRequest, controller, runtime, signal, accumulator);
      }
      accumulator.terminalEmitted = true;
    } catch (error) {
      const normalized = this.#normalizeRequestError(error, runtime, signal, secrets);
      if (accumulator && accumulator.emittedDelta && !accumulator.terminalEmitted) {
        accumulator.terminalEmitted = true;
        for (const event of buildFailureTerminalEvents(accumulator, this.profile)) yield event;
      }
      yield { type: 'error', error: providerErrorDetail(normalized, { secrets }) };
    } finally {
      if (runtime.totalTimer) clearTimeout(runtime.totalTimer);
      signal.removeEventListener('abort', onExternalAbort);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  /* ------------------------- streaming (SSE) ------------------------- */

  async *#streamViaSse(
    request: ModelRequest,
    controller: AbortController,
    runtime: RequestRuntime,
    externalSignal: AbortSignal,
    accumulator: RequestAccumulator,
  ): AsyncGenerator<ModelEvent, void, void> {
    const response = await this.#openChatResponse(request, controller, runtime, externalSignal, accumulator);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/event-stream')) {
      // Some "compatible" servers ignore `stream: true` and answer with a single
      // JSON document. Emit its content honestly as one delta (never fake a
      // token-by-token stream) — capability probes will notice the missing
      // progressive chunks.
      yield* this.#streamCompletedJsonPayload(response, request, runtime, externalSignal, accumulator);
      return;
    }

    const decoder = new SseDecoder();
    let sawDone = false;
    for await (const chunk of this.#iterateBody(response, controller, runtime, externalSignal)) {
      const records = decoder.push(chunk);
      for (const record of records) {
        if (record.data.trim().length > 0) runtime.firstEventDelivered = true;
        for (const event of this.#handleSseRecord(record, accumulator)) {
          if (isDeltaEvent(event)) accumulator.emittedDelta = true;
          yield event;
        }
        if (accumulator.doneSeen) {
          sawDone = true;
          break;
        }
      }
      if (sawDone) break;
    }
    if (!sawDone) {
      for (const record of decoder.end()) {
        if (record.data.trim().length > 0) runtime.firstEventDelivered = true;
        for (const event of this.#handleSseRecord(record, accumulator)) {
          if (isDeltaEvent(event)) accumulator.emittedDelta = true;
          yield event;
        }
        if (accumulator.doneSeen) break;
      }
    }
    accumulator.terminalEmitted = true;
    for (const event of finalizeStreamEvents(accumulator, this.profile)) yield event;
  }

  #handleSseRecord(record: SseRecord, accumulator: RequestAccumulator): ModelEvent[] {
    const data = record.data.trim();
    if (data.length === 0) return [];
    if (data === '[DONE]') {
      accumulator.doneSeen = true;
      return [];
    }
    if (data.length > MAX_SSE_CHUNK_CHARS) {
      throw new ProviderError('invalid_response', 'provider stream chunk is too large', {
        retryable: false,
        providerRequestId: accumulator.requestId,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new ProviderError('invalid_response', 'provider stream contained a chunk that is not valid JSON', {
        retryable: false,
        providerRequestId: accumulator.requestId,
      });
    }
    const apiError = providerErrorFromApiPayload(payload, {
      secrets: [this.#credential],
      httpStatus: 200,
      providerRequestId: accumulator.requestId,
    });
    if (apiError) throw apiError;
    if (!payload || typeof payload !== 'object') {
      throw new ProviderError('invalid_response', 'provider stream chunk is not a JSON object', {
        retryable: false,
        providerRequestId: accumulator.requestId,
      });
    }
    const recordObject = payload as Record<string, unknown>;
    const usageRaw = recordObject['usage'];
    if (usageRaw && typeof usageRaw === 'object') {
      const usage = normalizeProviderUsage(usageRaw, this.profile);
      if (usage) accumulator.providerUsage = usage;
    }
    const events: ModelEvent[] = [];
    const choices = recordObject['choices'];
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0];
      if (choice && typeof choice === 'object') {
        const choiceObject = choice as Record<string, unknown>;
        const delta = choiceObject['delta'] ?? choiceObject['message'];
        if (delta && typeof delta === 'object') {
          events.push(...this.#applyDelta(delta as Record<string, unknown>, accumulator));
        }
        const legacyText = choiceObject['text'];
        if ((!delta || typeof delta !== 'object') && typeof legacyText === 'string' && legacyText.length > 0) {
          events.push(...textDeltaEvents(legacyText));
          accumulator.text += legacyText;
        }
        const rawFinish = choiceObject['finish_reason'];
        if (typeof rawFinish === 'string' && rawFinish.length > 0) {
          accumulator.finishReason = mapFinishReason(rawFinish);
        }
      }
    }
    return events;
  }

  #applyDelta(delta: Record<string, unknown>, accumulator: RequestAccumulator): ModelEvent[] {
    const events: ModelEvent[] = [];
    const content = delta['content'];
    if (typeof content === 'string' && content.length > 0) {
      events.push(...textDeltaEvents(content));
      accumulator.text += content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const partObject = part as Record<string, unknown>;
        const text = partObject['text'];
        if (typeof text === 'string' && text.length > 0) {
          events.push(...textDeltaEvents(text));
          accumulator.text += text;
        }
      }
    }
    const refusal = delta['refusal'];
    if (typeof refusal === 'string' && refusal.length > 0) accumulator.refusal += refusal;
    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const rawCall of toolCalls) {
        events.push(...this.#applyToolCallDelta(rawCall, accumulator));
      }
    }
    return events;
  }

  #applyToolCallDelta(rawCall: unknown, accumulator: RequestAccumulator): ModelEvent[] {
    if (!rawCall || typeof rawCall !== 'object') {
      throw new ProviderError('invalid_response', 'provider sent a tool call delta that is not an object', {
        retryable: false,
        providerRequestId: accumulator.requestId,
      });
    }
    const callRecord = rawCall as Record<string, unknown>;
    const rawIndex = callRecord['index'];
    const index =
      typeof rawIndex === 'number'
        ? rawIndex
        : typeof rawIndex === 'string' && /^\d+$/.test(rawIndex)
          ? Number(rawIndex)
          : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_TOOL_CALLS) {
      throw new ProviderError('invalid_response', 'provider sent a tool call delta without a valid index', {
        retryable: false,
        providerRequestId: accumulator.requestId,
      });
    }
    const existing = accumulator.toolCalls.get(index);
    const call: ToolCallAccumulator = existing ?? {
      index,
      callId: '',
      name: '',
      arguments: '',
      sawArguments: false,
    };
    accumulator.toolCalls.set(index, call);

    let idFragment = '';
    const rawId = callRecord['id'];
    if (typeof rawId === 'string' && rawId.length > 0) idFragment = rawId;
    let nameFragment = '';
    let argumentsFragment = '';
    const rawFunction = callRecord['function'];
    if (rawFunction && typeof rawFunction === 'object') {
      const functionObject = rawFunction as Record<string, unknown>;
      const rawName = functionObject['name'];
      if (typeof rawName === 'string' && rawName.length > 0) nameFragment = rawName;
      const rawArguments = functionObject['arguments'];
      if (rawArguments !== undefined && rawArguments !== null) {
        if (typeof rawArguments !== 'string') {
          throw new ProviderError('invalid_response', 'provider sent non-string tool call arguments', {
            retryable: false,
            providerRequestId: accumulator.requestId,
          });
        }
        argumentsFragment = rawArguments;
      }
    }

    if (idFragment.length > 0) {
      const normalizedId = idFragment.slice(0, 200);
      if (call.callId.length === 0) call.callId = normalizedId;
      else if (call.callId !== normalizedId) {
        throw new ProviderError('invalid_response', 'provider sent inconsistent tool call ids for one call', {
          retryable: false,
          providerRequestId: accumulator.requestId,
        });
      }
    }
    if (nameFragment.length > 0) {
      if (call.name.length === 0) call.name = nameFragment.slice(0, 100);
      else if (!call.name.endsWith(nameFragment)) call.name = `${call.name}${nameFragment}`.slice(0, 100);
    }
    if (argumentsFragment.length > 0) {
      call.arguments += argumentsFragment;
      call.sawArguments = true;
      if (call.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
        throw new ProviderError('invalid_response', 'provider tool call arguments exceeded the allowed size', {
          retryable: false,
          providerRequestId: accumulator.requestId,
        });
      }
    }
    const events: ModelEvent[] = [];
    if (idFragment.length > 0 || nameFragment.length > 0 || argumentsFragment.length > 0) {
      events.push(...toolCallDeltaEvents(index, idFragment || undefined, nameFragment || undefined, argumentsFragment));
    }
    return events;
  }

  /* ----------------------- streaming (JSON body) --------------------- */

  async *#streamCompletedJsonPayload(
    response: Response,
    request: ModelRequest,
    runtime: RequestRuntime,
    externalSignal: AbortSignal,
    accumulator: RequestAccumulator,
  ): AsyncGenerator<ModelEvent, void, void> {
    const bodyText = await this.#readFullBody(response, runtime, externalSignal);
    const payload = parseJsonResponseBody(bodyText, accumulator.requestId);
    accumulator.emittedDelta = true;
    const apiError = providerErrorFromApiPayload(payload, {
      secrets: [this.#credential],
      httpStatus: 200,
      providerRequestId: accumulator.requestId,
    });
    if (apiError) throw apiError;
    accumulator.terminalEmitted = true;
    for (const event of eventsFromCompletedPayload(payload, request, accumulator, this.profile)) yield event;
  }

  /* --------------------------- non-streaming ------------------------- */

  async *#streamViaJson(
    request: ModelRequest,
    controller: AbortController,
    runtime: RequestRuntime,
    externalSignal: AbortSignal,
    accumulator: RequestAccumulator,
  ): AsyncGenerator<ModelEvent, void, void> {
    const response = await this.#openChatResponse(request, controller, runtime, externalSignal, accumulator);
    const bodyText = await this.#readFullBody(response, runtime, externalSignal);
    const payload = parseJsonResponseBody(bodyText, accumulator.requestId);
    accumulator.emittedDelta = true;
    const apiError = providerErrorFromApiPayload(payload, {
      secrets: [this.#credential],
      httpStatus: 200,
      providerRequestId: accumulator.requestId,
    });
    if (apiError) throw apiError;
    accumulator.terminalEmitted = true;
    for (const event of eventsFromCompletedPayload(payload, request, accumulator, this.profile)) yield event;
  }

  /* ----------------------------- HTTP layer -------------------------- */

  async #openChatResponse(
    request: ModelRequest,
    controller: AbortController,
    runtime: RequestRuntime,
    externalSignal: AbortSignal,
    accumulator: RequestAccumulator,
  ): Promise<Response> {
    const secrets = [this.#credential];
    let includeStreamUsage = this.#includeStreamUsage;
    for (let attempt = 0; ; attempt += 1) {
      const payload = serializeOpenAIRequest(request, {
        maxTokensField: this.#maxTokensField,
        includeStreamUsage: includeStreamUsage && request.stream,
      });
      const { response, requestId } = await this.#fetchWithRedirects(payload, controller, runtime, externalSignal);
      accumulator.requestId = requestId ?? accumulator.requestId;
      if (response.ok) return response;
      const bodyText = await readResponseTextLimited(response, this.#maxErrorBodyBytes);
      const httpError = providerErrorFromHttpResponse({
        status: response.status,
        bodyText,
        headers: response.headers,
        secrets,
      });
      const retryableFieldRejection =
        attempt === 0 &&
        includeStreamUsage &&
        request.stream &&
        this.#retryWithoutStreamUsage &&
        (response.status === 400 || response.status === 422) &&
        /stream_options|include_usage/i.test(bodyText);
      if (retryableFieldRejection) {
        includeStreamUsage = false;
        continue;
      }
      throw httpError;
    }
  }

  async #fetchWithRedirects(
    payload: OpenAIChatRequestPayload,
    controller: AbortController,
    runtime: RequestRuntime,
    externalSignal: AbortSignal,
  ): Promise<{ response: Response; requestId: string | null }> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: payload.stream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${this.#credential}`,
      'user-agent': USER_AGENT,
    };
    let currentUrl = this.#requestUrl;
    for (let hop = 0; hop <= this.#maxRedirects; hop += 1) {
      if (externalSignal.aborted || controller.signal.aborted) {
        throw this.#abortError(runtime);
      }
      const elapsed = Date.now() - runtime.startedAt;
      const remainingFirst = this.#firstEventTimeoutMs - elapsed;
      const requestBudget = Math.max(1, Math.min(remainingFirst > 0 ? remainingFirst : 1, this.#idleTimeoutMs));
      let response: Response;
      try {
        response = await withDeadline(
          this.#fetchImpl(currentUrl, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            redirect: 'manual',
          }),
          requestBudget,
          () => {
            controller.abort();
            return this.#timeoutError('first_event_timeout');
          },
        );
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (isAbortError(error)) throw this.#abortError(runtime);
        throw toProviderError(error, { secrets: [this.#credential] });
      }
      if (response.status === 307 || response.status === 308) {
        const location = response.headers.get('location');
        await cancelResponseBody(response);
        if (!location) {
          throw new ProviderError('invalid_response', `provider returned HTTP ${response.status} without a Location header`, {
            retryable: false,
            httpStatus: response.status,
          });
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new ProviderError('invalid_response', 'provider returned an invalid redirect location', {
            retryable: false,
            httpStatus: response.status,
          });
        }
        try {
          assertRedirectAllowed(currentUrl, nextUrl, this.#urlPolicy);
        } catch (error) {
          throw new ProviderError(
            'invalid_response',
            `provider redirect was not followed: ${sanitizeProviderMessage(error, { secrets: [this.#credential] })}`,
            { retryable: false, httpStatus: response.status },
          );
        }
        currentUrl = nextUrl;
        continue;
      }
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        await cancelResponseBody(response);
        throw new ProviderError(
          'invalid_response',
          `provider returned HTTP ${response.status} redirect for a POST request; method-changing redirects are not followed`,
          { retryable: false, httpStatus: response.status },
        );
      }
      return { response, requestId: extractProviderRequestId(response.headers) };
    }
    throw new ProviderError('invalid_response', `provider redirect limit (${this.#maxRedirects}) was exceeded`, {
      retryable: false,
    });
  }

  /* --------------------------- body iteration ------------------------ */

  async *#iterateBody(
    response: Response,
    controller: AbortController,
    runtime: RequestRuntime,
    externalSignal: AbortSignal,
  ): AsyncGenerator<string, void, void> {
    const body = response.body;
    if (!body) {
      throw new ProviderError('invalid_response', 'provider response has no readable body', {
        retryable: false,
      });
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let lastActivityAt = Date.now();
    try {
      while (true) {
        if (externalSignal.aborted || controller.signal.aborted) throw this.#abortError(runtime);
        const nowMs = Date.now();
        const idleRemaining = this.#idleTimeoutMs - (nowMs - lastActivityAt);
        const firstRemaining = runtime.firstEventDelivered
          ? Number.POSITIVE_INFINITY
          : this.#firstEventTimeoutMs - (nowMs - runtime.startedAt);
        const budget = Math.min(idleRemaining, firstRemaining);
        if (budget <= 0) {
          controller.abort();
          throw this.#timeoutError(runtime.firstEventDelivered ? 'idle_timeout' : 'first_event_timeout');
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await withDeadline(reader.read(), budget, () => {
            controller.abort();
            return this.#timeoutError(runtime.firstEventDelivered ? 'idle_timeout' : 'first_event_timeout');
          });
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          if (isAbortError(error)) throw this.#abortError(runtime);
          throw toProviderError(error, { secrets: [this.#credential] });
        }
        if (result.done) return;
        lastActivityAt = Date.now();
        const text = decoder.decode(result.value, { stream: true });
        if (text.length > 0) yield text;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* the stream may already be closed */
      }
    }
  }

  async #readFullBody(response: Response, runtime: RequestRuntime, externalSignal: AbortSignal): Promise<string> {
    let collected = '';
    const decoder = new TextDecoder('utf-8');
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ProviderError('invalid_response', 'provider response has no readable body', { retryable: false });
    }
    let totalBytes = 0;
    let lastActivityAt = Date.now();
    try {
      while (true) {
        if (externalSignal.aborted) throw this.#abortError(runtime);
        const nowMs = Date.now();
        const idleRemaining = this.#idleTimeoutMs - (nowMs - lastActivityAt);
        const firstRemaining = runtime.firstEventDelivered
          ? Number.POSITIVE_INFINITY
          : this.#firstEventTimeoutMs - (nowMs - runtime.startedAt);
        const budget = Math.min(idleRemaining, firstRemaining);
        if (budget <= 0) {
          throw this.#timeoutError(runtime.firstEventDelivered ? 'idle_timeout' : 'first_event_timeout');
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await withDeadline(reader.read(), budget, () =>
            this.#timeoutError(runtime.firstEventDelivered ? 'idle_timeout' : 'first_event_timeout'),
          );
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          if (isAbortError(error)) throw this.#abortError(runtime);
          throw toProviderError(error, { secrets: [this.#credential] });
        }
        if (result.done) return collected;
        lastActivityAt = Date.now();
        runtime.firstEventDelivered = true;
        totalBytes += result.value.byteLength;
        if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
          throw new ProviderError('invalid_response', 'provider response body exceeded the allowed size', {
            retryable: false,
          });
        }
        collected += decoder.decode(result.value, { stream: true });
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  /* ----------------------------- errors ------------------------------ */

  #normalizeRequestError(
    error: unknown,
    runtime: RequestRuntime,
    externalSignal: AbortSignal,
    secrets: readonly string[],
  ): ProviderError {
    if (error instanceof ProviderError) return error;
    if (runtime.abortReason === 'total_timeout') return this.#totalTimeoutError();
    if (runtime.abortReason === 'cancelled' || externalSignal.aborted) return this.#abortError(runtime);
    if (isAbortError(error)) return this.#abortError(runtime);
    return toProviderError(error, { secrets });
  }

  #abortError(runtime: RequestRuntime): ProviderError {
    if (runtime.abortReason === 'total_timeout') return this.#totalTimeoutError();
    return new ProviderError('cancelled', 'provider request was cancelled', { retryable: false });
  }

  #totalTimeoutError(): ProviderError {
    return new ProviderError('total_timeout', `provider request exceeded the total timeout of ${this.#totalTimeoutMs}ms`, {
      retryable: true,
    });
  }

  #timeoutError(code: 'first_event_timeout' | 'idle_timeout'): ProviderError {
    if (code === 'first_event_timeout') {
      return new ProviderError(
        'first_event_timeout',
        `provider did not produce a first stream event within ${this.#firstEventTimeoutMs}ms`,
        { retryable: true },
      );
    }
    return new ProviderError('idle_timeout', `provider stream was idle for more than ${this.#idleTimeoutMs}ms`, {
      retryable: true,
    });
  }

  /** Exposed for diagnostics/tests: resolved endpoint and effective timeouts. */
  describe(): {
    requestUrl: string;
    firstEventTimeoutMs: number;
    idleTimeoutMs: number;
    totalTimeoutMs: number;
    maxRedirects: number;
  } {
    return {
      requestUrl: this.#requestUrl,
      firstEventTimeoutMs: this.#firstEventTimeoutMs,
      idleTimeoutMs: this.#idleTimeoutMs,
      totalTimeoutMs: this.#totalTimeoutMs,
      maxRedirects: this.#maxRedirects,
    };
  }

  /** Kept for parity with the contract; the options object is read-only. */
  get options(): Readonly<AdapterOptions> {
    return this.#options;
  }
}

/* ------------------------------------------------------------------ */
/* Payload -> events helpers                                           */
/* ------------------------------------------------------------------ */

function createAccumulator(request: ModelRequest): RequestAccumulator {
  return {
    request,
    text: '',
    refusal: '',
    toolCalls: new Map(),
    providerUsage: null,
    finishReason: null,
    doneSeen: false,
    emittedDelta: false,
    terminalEmitted: false,
    requestId: null,
  };
}

function isDeltaEvent(event: ModelEvent): boolean {
  return event.type === 'text_delta' || event.type === 'tool_call_delta' || event.type === 'tool_call_complete';
}

function textDeltaEvents(text: string): ModelEvent[] {
  if (text.length === 0) return [];
  const events: ModelEvent[] = [];
  for (let offset = 0; offset < text.length; offset += MAX_TEXT_EVENT_CHARS) {
    events.push({ type: 'text_delta', text: text.slice(offset, offset + MAX_TEXT_EVENT_CHARS) });
  }
  return events;
}

function toolCallDeltaEvents(
  index: number,
  callId: string | undefined,
  name: string | undefined,
  argumentsDelta: string,
): ModelEvent[] {
  const events: ModelEvent[] = [];
  const chunks: string[] = [];
  if (argumentsDelta.length === 0) chunks.push('');
  else {
    for (let offset = 0; offset < argumentsDelta.length; offset += 100_000) {
      chunks.push(argumentsDelta.slice(offset, offset + 100_000));
    }
  }
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const event: ModelEvent = {
      type: 'tool_call_delta',
      index,
      argumentsDelta: chunks[chunkIndex] ?? '',
    };
    if (chunkIndex === 0 && callId !== undefined) event.callId = callId;
    if (chunkIndex === 0 && name !== undefined) event.name = name;
    events.push(event);
  }
  return events;
}

function normalizeProviderUsage(raw: unknown, profile: ProviderProfile): ModelUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const readNonNegativeInt = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
    }
    return null;
  };
  const inputTokens = readNonNegativeInt('prompt_tokens', 'input_tokens');
  const outputTokens = readNonNegativeInt('completion_tokens', 'output_tokens');
  const totalRaw = readNonNegativeInt('total_tokens');
  if (inputTokens === null && outputTokens === null && totalRaw === null) return null;
  const totalTokens = totalRaw ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source: 'provider',
    costUsd: computeCostUsd(profile.priceTable, inputTokens, outputTokens),
  };
}

function estimatedOutputText(accumulator: RequestAccumulator): string {
  const toolText = [...accumulator.toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .map((call) => `${call.name}${call.arguments}`)
    .join('');
  return `${accumulator.text}${accumulator.refusal}${toolText}`;
}

/** Usage for a completed/truncated stream: provider numbers when present, else
 * explicit local estimates; mixed when only part of the provider data exists. */
function buildUsage(accumulator: RequestAccumulator, profile: ProviderProfile): ModelUsage {
  const inputEstimate = estimateRequestTokens(accumulator.request);
  const outputEstimate = estimateTokens(estimatedOutputText(accumulator));
  const provider = accumulator.providerUsage;
  if (!provider) {
    return {
      inputTokens: inputEstimate,
      outputTokens: outputEstimate,
      totalTokens: inputEstimate + outputEstimate,
      source: 'estimated',
      costUsd: computeCostUsd(profile.priceTable, inputEstimate, outputEstimate),
    };
  }
  if (provider.inputTokens !== null && provider.outputTokens !== null) return provider;
  const inputTokens = provider.inputTokens ?? inputEstimate;
  const outputTokens = provider.outputTokens ?? outputEstimate;
  return {
    inputTokens,
    outputTokens,
    totalTokens: provider.totalTokens ?? inputTokens + outputTokens,
    source: 'mixed',
    costUsd: computeCostUsd(profile.priceTable, inputTokens, outputTokens),
  };
}

function usageEvent(accumulator: RequestAccumulator, profile: ProviderProfile): ModelEvent {
  return { type: 'usage', usage: buildUsage(accumulator, profile) };
}

function truncatedError(message: string, retryable: boolean, providerRequestId: string | null): ProviderError {
  return new ProviderError('truncated', message, { retryable, providerRequestId });
}

function refusedError(accumulator: RequestAccumulator, requestId: string | null): ProviderError {
  const reason = accumulator.refusal.trim();
  const message =
    reason.length > 0
      ? `provider refused the request: ${reason.slice(0, 500)}`
      : 'provider refused the request (content filter)';
  return new ProviderError('refused', message, { retryable: false, providerRequestId: requestId });
}

function toolCallCompleteEvents(accumulator: RequestAccumulator): { events: ModelEvent[]; assemblyError: ProviderError | null } {
  const events: ModelEvent[] = [];
  let assemblyError: ProviderError | null = null;
  const calls = [...accumulator.toolCalls.values()].sort((a, b) => a.index - b.index);
  for (const call of calls) {
    if (call.callId.length === 0 || call.name.length === 0) {
      assemblyError = new ProviderError('invalid_response', 'provider tool call was missing an id or function name', {
        retryable: false,
        providerRequestId: accumulator.requestId,
      });
      continue;
    }
    if (call.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
      assemblyError = new ProviderError('invalid_response', 'provider tool call arguments exceeded the allowed size', {
        retryable: false,
        providerRequestId: accumulator.requestId,
      });
      continue;
    }
    events.push({
      type: 'tool_call_complete',
      index: call.index,
      callId: call.callId,
      name: call.name,
      argumentsJson: call.arguments,
    });
  }
  return { events, assemblyError };
}

/** Terminal events for a cleanly (or explicitly) closed stream. */
function finalizeStreamEvents(accumulator: RequestAccumulator, profile: ProviderProfile): ModelEvent[] {
  const events: ModelEvent[] = [];
  const requestId = accumulator.requestId;
  const finishReason = accumulator.finishReason;
  const refusal = accumulator.refusal.trim().length > 0;
  const hasToolCalls = accumulator.toolCalls.size > 0;

  if (refusal || finishReason === 'content_filter') {
    events.push({ type: 'finish', reason: 'content_filter' });
    events.push(usageEvent(accumulator, profile));
    events.push({ type: 'error', error: providerErrorDetail(refusedError(accumulator, requestId), { secrets: [] }) });
    return events;
  }

  if (!accumulator.doneSeen && finishReason === null) {
    // Provider closed the connection without [DONE] or a finish_reason.
    events.push({ type: 'finish', reason: 'error' });
    events.push(usageEvent(accumulator, profile));
    events.push({
      type: 'error',
      error: providerErrorDetail(
        truncatedError(
          'provider stream ended before a finish reason or [DONE]; partial output was preserved',
          true,
          requestId,
        ),
      ),
    });
    return events;
  }

  const effectiveReason: FinishReason = finishReason ?? 'stop';
  if (effectiveReason === 'length') {
    events.push({ type: 'finish', reason: 'length' });
    events.push(usageEvent(accumulator, profile));
    events.push({
      type: 'error',
      error: providerErrorDetail(
        truncatedError(
          'response was truncated because the output token limit was reached (finish_reason=length); partial output was preserved',
          false,
          requestId,
        ),
      ),
    });
    return events;
  }
  if (effectiveReason === 'error') {
    events.push({ type: 'finish', reason: 'error' });
    events.push(usageEvent(accumulator, profile));
    events.push({
      type: 'error',
      error: providerErrorDetail(
        new ProviderError('server_error', 'provider reported an error finish reason', {
          retryable: true,
          providerRequestId: requestId,
        }),
      ),
    });
    return events;
  }

  const { events: completeEvents, assemblyError } = toolCallCompleteEvents(accumulator);
  events.push(...completeEvents);
  events.push({ type: 'finish', reason: hasToolCalls && effectiveReason === 'stop' ? 'tool_calls' : effectiveReason });
  events.push(usageEvent(accumulator, profile));
  if (assemblyError) events.push({ type: 'error', error: providerErrorDetail(assemblyError) });
  return events;
}

/** Terminal events emitted when an unexpected error interrupts a stream mid-way. */
function buildFailureTerminalEvents(accumulator: RequestAccumulator, profile: ProviderProfile): ModelEvent[] {
  return [
    { type: 'finish', reason: 'error' },
    usageEvent(accumulator, profile),
  ];
}

/**
 * Convert a complete non-streaming Chat Completions response payload into
 * normalized events (single text delta, assembled tool calls, finish, usage).
 */
function eventsFromCompletedPayload(
  payload: unknown,
  request: ModelRequest,
  accumulator: RequestAccumulator,
  profile: ProviderProfile,
): ModelEvent[] {
  const events: ModelEvent[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProviderError('invalid_response', 'provider response is not a JSON object', {
      retryable: false,
      providerRequestId: accumulator.requestId,
    });
  }
  const record = payload as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError('invalid_response', 'provider response contained no choices', {
      retryable: false,
      providerRequestId: accumulator.requestId,
    });
  }
  const choice = choices[0];
  if (!choice || typeof choice !== 'object') {
    throw new ProviderError('invalid_response', 'provider response choice is not an object', {
      retryable: false,
      providerRequestId: accumulator.requestId,
    });
  }
  const choiceObject = choice as Record<string, unknown>;
  const message = choiceObject['message'];
  const messageObject = message && typeof message === 'object' ? (message as Record<string, unknown>) : {};

  const usageRaw = record['usage'];
  if (usageRaw && typeof usageRaw === 'object') {
    const usage = normalizeProviderUsage(usageRaw, profile);
    if (usage) accumulator.providerUsage = usage;
  }

  // Content (string or content-parts array).
  const content = messageObject['content'];
  if (typeof content === 'string' && content.length > 0) {
    accumulator.text += content;
    events.push(...textDeltaEvents(content));
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>)['text'];
      if (typeof text === 'string' && text.length > 0) {
        accumulator.text += text;
        events.push(...textDeltaEvents(text));
      }
    }
  } else if (typeof choiceObject['text'] === 'string' && (choiceObject['text'] as string).length > 0) {
    const legacyText = choiceObject['text'] as string;
    accumulator.text += legacyText;
    events.push(...textDeltaEvents(legacyText));
  }
  const refusal = messageObject['refusal'];
  if (typeof refusal === 'string' && refusal.length > 0) accumulator.refusal += refusal;

  // Tool calls.
  const toolCalls = messageObject['tool_calls'];
  if (Array.isArray(toolCalls)) {
    for (let index = 0; index < toolCalls.length; index += 1) {
      const rawCall = toolCalls[index];
      if (!rawCall || typeof rawCall !== 'object') continue;
      const callRecord = rawCall as Record<string, unknown>;
      const rawFn = callRecord['function'];
      const fnObject = rawFn && typeof rawFn === 'object' ? (rawFn as Record<string, unknown>) : {};
      const rawId = callRecord['id'];
      const rawName = fnObject['name'];
      const rawArguments = fnObject['arguments'];
      const call: ToolCallAccumulator = {
        index,
        callId: typeof rawId === 'string' ? rawId.slice(0, 200) : '',
        name: typeof rawName === 'string' ? rawName.slice(0, 100) : '',
        arguments: typeof rawArguments === 'string' ? rawArguments : '',
        sawArguments: typeof rawArguments === 'string',
      };
      accumulator.toolCalls.set(index, call);
      if (call.arguments.length > 0) {
        events.push(...toolCallDeltaEvents(index, call.callId || undefined, call.name || undefined, call.arguments));
      }
    }
  }

  const rawFinish = choiceObject['finish_reason'];
  if (typeof rawFinish === 'string' && rawFinish.length > 0) accumulator.finishReason = mapFinishReason(rawFinish);
  else if (accumulator.toolCalls.size > 0) accumulator.finishReason = 'tool_calls';
  else accumulator.finishReason = 'unknown';
  accumulator.doneSeen = true;

  events.push(...finalizeStreamEvents(accumulator, profile));
  void request;
  return events;
}

function parseJsonResponseBody(bodyText: string, requestId: string | null): unknown {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    throw new ProviderError('invalid_response', 'provider returned an empty response body', {
      retryable: false,
      providerRequestId: requestId,
    });
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ProviderError('invalid_response', 'provider returned a body that is not valid JSON', {
      retryable: false,
      providerRequestId: requestId,
    });
  }
}

function resolveTimeout(
  optionValue: number | undefined,
  profileValue: number | undefined,
  fallback: number,
  label: string,
): number {
  const candidate = optionValue ?? profileValue ?? fallback;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
    throw new ProviderError('bad_request', `invalid provider timeout configuration: ${label}`, { retryable: false });
  }
  return Math.trunc(candidate);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
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

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (total >= maxBytes) {
        text = text.slice(0, maxBytes);
        break;
      }
    }
  } catch {
    /* an unreadable error body is not fatal for diagnostics */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Package-level helpers                                              */
/* ------------------------------------------------------------------ */

/** Create the adapter for a profile. Unsupported adapter types fail loudly. */
export function createAdapter(
  profile: ProviderProfile,
  credential: string,
  options: AdapterOptions = {},
): ProviderAdapter {
  switch (profile.adapterType) {
    case 'openai_compatible':
      return new OpenAICompatibleAdapter(profile, credential, options);
    case 'anthropic_native':
    case 'openai_responses':
      throw new ProviderError(
        'unsupported_feature',
        `provider adapter type "${profile.adapterType}" is not implemented in this build; no fallback adapter is used`,
        { retryable: false },
      );
    default:
      throw new ProviderError('unsupported_feature', 'unknown provider adapter type', { retryable: false });
  }
}

/** Collect the full event stream of an adapter call (tests/diagnostics). */
export async function streamEventsFromAdapter(
  adapter: ProviderAdapter,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of adapter.stream(request, signal)) events.push(event);
  return events;
}

/** Map an OpenAI-style error payload to the public error detail shape. */
export function toProviderErrorEvent(error: unknown, secrets: readonly string[] = []): ModelEvent {
  return { type: 'error', error: providerErrorDetail(error, { secrets }) };
}
