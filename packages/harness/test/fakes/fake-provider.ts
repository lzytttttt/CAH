/**
 * Deterministic ProviderGateway fake for kernel tests.
 *
 * Script contract (also documented in ../README.md):
 *   gateway.enqueue(events)                 // one response: array of ModelEvent
 *   gateway.enqueueHandler(fn)              // fn(request, signal, index) => ModelEvent[]
 *   gateway.enqueueAbortable()              // streams one text_delta then waits for abort
 * Requests are recorded in `requests` for assertions.
 */
import {
  ModelEventSchema,
  ModelRequestSchema,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
  type ProviderCapabilities,
  type ProviderErrorDetail,
  type ProviderProfile,
} from '@ca/contracts';
import type { ProviderGateway } from '../../src/types';
import { sleep } from '../../src/hashing';

export type ProviderScript =
  | { kind: 'events'; events: ModelEvent[] }
  | { kind: 'handler'; handler: (request: ModelRequest, signal: AbortSignal, index: number) => ModelEvent[] | Promise<ModelEvent[]> }
  | { kind: 'abortable' };

export interface FakeProviderOptions {
  profile?: Partial<ProviderProfile>;
  capabilities?: Partial<ProviderCapabilities>;
}

export class FakeProviderGateway implements ProviderGateway {
  readonly profile: ProviderProfile;
  readonly capabilitiesValue: ProviderCapabilities;
  readonly scripts: ProviderScript[] = [];
  readonly requests: ModelRequest[] = [];
  readonly abortedRequests: number[] = [];
  closed = false;

  constructor(options: FakeProviderOptions = {}) {
    const now = '2026-01-01T00:00:00.000Z';
    this.profile = {
      id: '00000000-0000-4000-8000-0000000000aa' as never,
      profileName: 'fake-provider',
      adapterType: 'openai_compatible',
      baseURL: 'http://127.0.0.1:9/v1',
      model: 'fake-model',
      credentialRef: 'fake',
      enabled: true,
      timeouts: {},
      contextWindowOverride: null,
      priceTable: null,
      capabilities: {
        streaming: 'verified',
        toolCalling: 'verified',
        structuredOutput: 'unknown',
        vision: 'unsupported',
        usageReporting: 'verified',
      },
      createdAt: now,
      updatedAt: now,
      ...options.profile,
    };
    this.capabilitiesValue = {
      streaming: 'verified',
      toolCalling: 'verified',
      structuredOutput: 'unknown',
      vision: 'unsupported',
      usageReporting: 'verified',
      ...options.capabilities,
    };
  }

  enqueue(events: ModelEvent[]): this {
    this.scripts.push({ kind: 'events', events });
    return this;
  }

  enqueueHandler(handler: (request: ModelRequest, signal: AbortSignal, index: number) => ModelEvent[] | Promise<ModelEvent[]>): this {
    this.scripts.push({ kind: 'handler', handler });
    return this;
  }

  enqueueAbortable(): this {
    this.scripts.push({ kind: 'abortable' });
    return this;
  }

  enqueueText(text: string, options: { finish?: boolean } = {}): this {
    const events: ModelEvent[] = [];
    for (const chunk of chunkText(text)) events.push({ type: 'text_delta', text: chunk });
    events.push({ type: 'finish', reason: options.finish === false ? 'length' : 'stop' });
    return this.enqueue(events);
  }

  enqueueToolCall(
    name: string,
    args: unknown,
    options: { callId?: string; text?: string; finishReason?: 'tool_calls' | 'stop' } = {},
  ): this {
    return this.enqueue(toolCallEvents(name, args, options));
  }

  enqueueCandidate(candidate: unknown, options: { evidenceRefs?: unknown[]; description?: string } = {}): this {
    return this.enqueueText(
      JSON.stringify({
        candidate,
        evidenceRefs: options.evidenceRefs ?? [],
        description: options.description ?? '候选成果',
      }),
    );
  }

  remaining(): number {
    return this.scripts.length;
  }

  async getProfile(profileId: string): Promise<ProviderProfile | null> {
    return profileId === this.profile.id ? this.profile : null;
  }

  async listEnabledProfiles(): Promise<ProviderProfile[]> {
    return [this.profile];
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.capabilitiesValue;
  }

  async *stream(profileId: string, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (profileId !== this.profile.id) throw new Error(`unknown profile ${profileId}`);
    const parsedRequest = ModelRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new Error(`fake provider received invalid ModelRequest: ${parsedRequest.error.message}`);
    }
    const index = this.requests.length;
    this.requests.push(parsedRequest.data);
    const script = this.scripts.shift();
    if (!script) {
      throw new Error(`FakeProviderGateway: no scripted response left for request #${index} (${request.modelCallId})`);
    }
    let events: ModelEvent[];
    if (script.kind === 'events') {
      events = script.events;
    } else if (script.kind === 'handler') {
      events = await script.handler(parsedRequest.data, signal, index);
    } else {
      // Abortable: stream one delta, then wait until the kernel aborts the request.
      yield validated({ type: 'text_delta', text: '正在生成…' });
      for (let i = 0; i < 200; i += 1) {
        if (signal.aborted) {
          this.abortedRequests.push(index);
          throw abortError(signal);
        }
        await sleep(5);
      }
      throw new Error('FakeProviderGateway: abortable script was never aborted');
    }
    for (const event of events) {
      if (signal.aborted) {
        this.abortedRequests.push(index);
        throw abortError(signal);
      }
      yield validated(event);
      // Yield to the event loop so pause/cancel commands can interleave.
      await sleep(0);
    }
  }
}

function validated(event: ModelEvent): ModelEvent {
  const parsed = ModelEventSchema.safeParse(event);
  if (!parsed.success) throw new Error(`fake provider script emitted invalid ModelEvent: ${parsed.error.message}`);
  return parsed.data;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error('aborted');
}

function chunkText(text: string, size = 24): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length > 0 ? chunks : [''];
}

export function toolCallEvents(
  name: string,
  args: unknown,
  options: { callId?: string; text?: string; finishReason?: 'tool_calls' | 'stop' } = {},
): ModelEvent[] {
  const callId = options.callId ?? `call_${Math.random().toString(36).slice(2, 10)}`;
  const argumentsJson = typeof args === 'string' ? args : JSON.stringify(args);
  const events: ModelEvent[] = [];
  if (options.text) events.push({ type: 'text_delta', text: options.text });
  events.push({ type: 'tool_call_delta', index: 0, callId, name, argumentsDelta: argumentsJson.slice(0, 12) });
  events.push({ type: 'tool_call_delta', index: 0, argumentsDelta: argumentsJson.slice(12) });
  events.push({ type: 'tool_call_complete', index: 0, callId, name, argumentsJson });
  events.push({ type: 'finish', reason: options.finishReason ?? 'tool_calls' });
  return events;
}

export function usageEvent(usage: ModelUsage): ModelEvent {
  return { type: 'usage', usage };
}

export function providerErrorEvent(error: Partial<ProviderErrorDetail> & { message: string }): ModelEvent {
  return {
    type: 'error',
    error: {
      code: 'server_error',
      retryable: true,
      httpStatus: null,
      retryAfterMs: null,
      providerRequestId: null,
      ...error,
    },
  };
}
