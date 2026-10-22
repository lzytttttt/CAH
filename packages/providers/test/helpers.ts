/**
 * Test helpers: a local `node:http` fake provider server, SSE writers and
 * profile/request builders. No real network access, no real credentials.
 */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  ModelRequestSchema,
  ProviderProfileSchema,
  type ModelEvent,
  type ModelRequest,
  type ProviderAdapter,
  type ProviderProfile,
} from '@ca/contracts';

/** Obviously fake credential; tests assert it never leaks into errors/logs. */
export const TEST_CREDENTIAL = 'sk-test-secret-abc123456789';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, unknown> | null;
}

export interface FakeHandlerContext {
  res: ServerResponse;
  url: string;
  method: string;
  body: string;
  json: Record<string, unknown> | null;
  requestIndex: number;
}

export type FakeHandler = (context: FakeHandlerContext) => void | Promise<void>;

export interface FakeServer {
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function listenOnEphemeralLoopbackPort(server: ReturnType<typeof createServer>): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Rapid repeated local test runs can transiently exhaust the Windows
      // ephemeral port range; retry briefly instead of failing unrelated tests.
      if ((code === 'EADDRINUSE' || code === 'EADDRNOTAVAIL' || code === 'EACCES') && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        json = null;
      }
      const requestIndex = requests.length;
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
        json,
      });
      Promise.resolve(
        handler({
          res: response,
          url: request.url ?? '',
          method: request.method ?? '',
          body,
          json,
          requestIndex,
        }),
      ).catch(() => {
        try {
          response.destroy();
        } catch {
          /* ignore */
        }
      });
    });
  });
  await listenOnEphemeralLoopbackPort(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          server.closeAllConnections();
        } catch {
          /* ignore */
        }
        const timer = setTimeout(() => resolve(), 500);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

/* ------------------------------- SSE ---------------------------------- */

export function startSse(res: ServerResponse, status = 200): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders?.();
}

export function writeSseJson(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeSseRaw(res: ServerResponse, raw: string): void {
  if (res.writableEnded) return;
  res.write(raw);
}

export function writeSseDone(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.end('data: [DONE]\n\n');
}

export function endSse(res: ServerResponse): void {
  if (!res.writableEnded) res.end();
}

/** OpenAI-compatible streaming chunk. */
export function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
}

export function usageChunk(promptTokens: number, completionTokens: number): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function jsonResponse(
  res: ServerResponse,
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

export function rawResponse(
  res: ServerResponse,
  body: string,
  status = 200,
  contentType = 'application/json',
): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

/** Standard successful non-streaming Chat Completions JSON payload. */
export function chatCompletionPayload(options: {
  content?: string | null;
  finishReason?: string | null;
  toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  usage?: { prompt: number; completion: number } | null;
  refusal?: string;
} = {}): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: options.content ?? 'Hello' };
  if (options.toolCalls && options.toolCalls.length > 0) {
    message['tool_calls'] = options.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson },
    }));
  }
  if (options.refusal) message['refusal'] = options.refusal;
  const payload: Record<string, unknown> = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, message, finish_reason: options.finishReason ?? 'stop' }],
  };
  if (options.usage !== null) {
    const usage = options.usage ?? { prompt: 11, completion: 5 };
    payload['usage'] = {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    };
  }
  return payload;
}

/* --------------------------- model fixtures --------------------------- */

export function makeProfile(baseURL: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return ProviderProfileSchema.parse({
    id: randomUUID(),
    profileName: 'fake-provider',
    adapterType: 'openai_compatible',
    baseURL,
    model: 'test-model',
    credentialRef: 'CA_TEST_PROVIDER_KEY',
    enabled: true,
    timeouts: {},
    contextWindowOverride: null,
    priceTable: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

export function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return ModelRequestSchema.parse({
    modelCallId: 'call-1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  });
}

export interface CollectOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: ModelEvent, controller: AbortController) => void;
}

/** Drain an adapter stream with a hard test guard. */
export async function collectEvents(
  adapter: ProviderAdapter,
  request: ModelRequest,
  options: CollectOptions = {},
): Promise<ModelEvent[]> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const events: ModelEvent[] = [];
  const guard = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  guard.unref?.();
  try {
    for await (const event of adapter.stream(request, signal)) {
      events.push(event);
      options.onEvent?.(event, controller);
    }
  } finally {
    clearTimeout(guard);
  }
  return events;
}

export function eventsOfType<T extends ModelEvent['type']>(
  events: readonly ModelEvent[],
  type: T,
): Array<Extract<ModelEvent, { type: T }>> {
  return events.filter((event): event is Extract<ModelEvent, { type: T }> => event.type === type);
}

/** The terminal error event of a stream (if any). */
export function lastError(events: readonly ModelEvent[]): Extract<ModelEvent, { type: 'error' }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'error') return event;
  }
  return null;
}

export function errorCodeOf(events: readonly ModelEvent[]): string | null {
  return lastError(events)?.error.code ?? null;
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
