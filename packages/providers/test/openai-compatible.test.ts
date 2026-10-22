/**
 * Contract tests for the OpenAI-compatible adapter (design section 6.2 matrix).
 * Uses a local node:http fake server only — no real network, no real credentials.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelEvent, ModelRequest, ProviderProfile } from '@ca/contracts';
import {
  ProviderError,
  buildChatCompletionsUrl,
  createAdapter,
  mapFinishReason,
  serializeOpenAIRequest,
  streamEventsFromAdapter,
  type AdapterOptions,
} from '../src/index';
import {
  TEST_CREDENTIAL,
  chatChunk,
  chatCompletionPayload,
  collectEvents,
  errorCodeOf,
  eventsOfType,
  jsonResponse,
  lastError,
  makeProfile,
  makeRequest,
  rawResponse,
  startFakeServer,
  startSse,
  usageChunk,
  writeSseDone,
  writeSseJson,
  writeSseRaw,
  endSse,
  type FakeHandler,
  type FakeServer,
} from './helpers';

const servers: FakeServer[] = [];

async function fake(handler: FakeHandler): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0, servers.length).map((server) => server.close()));
});

function makeAdapter(
  server: FakeServer,
  profileOverrides: Partial<ProviderProfile> = {},
  options: AdapterOptions = {},
) {
  // Generous defaults so a loaded CI machine cannot turn a fast fake server into
  // a spurious timeout; timeout-specific tests pass small explicit values.
  return createAdapter(makeProfile(server.baseUrl, profileOverrides), TEST_CREDENTIAL, {
    firstEventTimeoutMs: 2000,
    idleTimeoutMs: 2000,
    totalTimeoutMs: 15000,
    ...options,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

describe('OpenAI-compatible request serialization', () => {
  it('serializes messages, tool definitions, tool choice and response format', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload({ content: 'ok' }));
    });
    const request = makeRequest({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Look it up.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ callId: 'call_abc', name: 'lookup', argumentsJson: '{"q":"x"}' }],
        },
        { role: 'tool', toolCallId: 'call_abc', content: '{"ok":true}' },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Looks something up',
          parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          strict: true,
        },
      ],
      toolChoice: 'required',
      temperature: 0.5,
      maxOutputTokens: 128,
      responseFormat: {
        kind: 'json_schema',
        name: 'answer',
        schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        strict: true,
      },
      stream: false,
    });
    const events = await collectEvents(makeAdapter(server), request);
    expect(errorCodeOf(events)).toBeNull();
    expect(eventsOfType(events, 'text_delta').map((event) => event.text).join('')).toBe('ok');

    expect(server.requests).toHaveLength(1);
    const sent = asRecord(server.requests[0]?.json);
    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.url).toBe('/chat/completions');
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${TEST_CREDENTIAL}`);
    expect(sent['model']).toBe('test-model');
    expect(sent['stream']).toBe(false);
    expect(sent['stream_options']).toBeUndefined();
    expect(sent['temperature']).toBe(0.5);
    expect(sent['max_tokens']).toBe(128);
    expect(sent['tool_choice']).toBe('required');
    const messages = sent['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Look it up.' });
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_abc', content: '{"ok":true}' });
    const tools = sent['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Looks something up',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        strict: true,
      },
    });
    expect(sent['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        strict: true,
      },
    });
  });

  it('omits default/empty fields and requests streaming usage', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'ok' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    const events = await collectEvents(
      makeAdapter(server),
      makeRequest({ tools: [], temperature: null, toolChoice: 'auto' }),
    );
    expect(lastError(events)).toBeNull();
    const sent = asRecord(server.requests[0]?.json);
    expect(sent['temperature']).toBeUndefined();
    expect(sent['tools']).toBeUndefined();
    expect(sent['tool_choice']).toBeUndefined();
    expect(sent['response_format']).toBeUndefined();
    expect(sent['stream']).toBe(true);
    expect(sent['stream_options']).toEqual({ include_usage: true });
  });

  it('honors maxTokensField and includeStreamUsage overrides', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'ok' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    await collectEvents(
      makeAdapter(server, {}, { maxTokensField: 'max_completion_tokens', includeStreamUsage: false }),
      makeRequest(),
    );
    const sent = asRecord(server.requests[0]?.json);
    expect(sent['max_completion_tokens']).toBe(8192);
    expect(sent['max_tokens']).toBeUndefined();
    expect(sent['stream_options']).toBeUndefined();
  });

  it('rejects toolChoice required without tools', () => {
    expect(() => serializeOpenAIRequest(makeRequest({ tools: [], toolChoice: 'required' }))).toThrowError(
      ProviderError,
    );
    try {
      serializeOpenAIRequest(makeRequest({ tools: [], toolChoice: 'required' }));
    } catch (error) {
      expect((error as ProviderError).code).toBe('bad_request');
    }
  });

  it('builds the Chat Completions URL from profile baseURL variants', () => {
    expect(buildChatCompletionsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
    expect(buildChatCompletionsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/chat/completions');
    expect(buildChatCompletionsUrl('https://api.example.com')).toBe('https://api.example.com/chat/completions');
    expect(buildChatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
    expect(buildChatCompletionsUrl('http://127.0.0.1:8080/v1/chat/completions/')).toBe(
      'http://127.0.0.1:8080/v1/chat/completions',
    );
    // Query parameters must survive (Azure-style endpoints need ?api-version=).
    expect(buildChatCompletionsUrl('https://host.example/v1?api-version=2024-06-01')).toBe(
      'https://host.example/v1/chat/completions?api-version=2024-06-01',
    );
    expect(
      buildChatCompletionsUrl(
        'https://host.example/openai/deployments/d/chat/completions?api-version=2024-06-01',
      ),
    ).toBe('https://host.example/openai/deployments/d/chat/completions?api-version=2024-06-01');
    expect(() => buildChatCompletionsUrl('ftp://example.com')).toThrowError(ProviderError);
    expect(() => buildChatCompletionsUrl('https://user:pass@example.com/v1')).toThrowError(ProviderError);
  });

  it('maps finish reasons deterministically', () => {
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapFinishReason('length')).toBe('length');
    expect(mapFinishReason('max_tokens')).toBe('length');
    expect(mapFinishReason('tool_calls')).toBe('tool_calls');
    expect(mapFinishReason('function_call')).toBe('tool_calls');
    expect(mapFinishReason('content_filter')).toBe('content_filter');
    expect(mapFinishReason('something_new')).toBe('unknown');
    expect(mapFinishReason(null)).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/* Non-streaming responses                                             */
/* ------------------------------------------------------------------ */

describe('non-streaming responses', () => {
  it('parses text, tool calls, finish reason and provider usage', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(
        res,
        chatCompletionPayload({
          content: 'Answer',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: 'lookup', argumentsJson: '{"q":"x"}' }],
          usage: { prompt: 11, completion: 7 },
        }),
      );
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    expect(lastError(events)).toBeNull();
    expect(eventsOfType(events, 'text_delta').map((event) => event.text).join('')).toBe('Answer');
    const completes = eventsOfType(events, 'tool_call_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({
      index: 0,
      callId: 'call_1',
      name: 'lookup',
      argumentsJson: '{"q":"x"}',
    });
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('tool_calls');
    const usage = eventsOfType(events, 'usage')[0]?.usage;
    expect(usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      source: 'provider',
      costUsd: null,
    });
  });

  it('emits explicit estimated usage when the provider omits usage', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload({ content: 'Some answer text', usage: null }));
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    const usage = eventsOfType(events, 'usage')[0]?.usage;
    expect(usage?.source).toBe('estimated');
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
    expect(usage?.totalTokens).toBe((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
    expect(usage?.costUsd).toBeNull();
  });

  it('computes cost from the price table only when the table is complete', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload({ content: 'x', usage: { prompt: 1000, completion: 500 } }));
    });
    const priced = await collectEvents(
      makeAdapter(server, {
        priceTable: { currency: 'USD', inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      }),
      makeRequest({ stream: false }),
    );
    const usage = eventsOfType(priced, 'usage')[0]?.usage;
    expect(usage?.source).toBe('provider');
    expect(usage?.costUsd).toBeCloseTo(0.002, 9);
  });

  it('maps a refusal in a non-stream payload to refused', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(
        res,
        chatCompletionPayload({ content: '', refusal: 'I cannot help with that.', finishReason: 'stop' }),
      );
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('content_filter');
    const error = lastError(events)?.error;
    expect(error?.code).toBe('refused');
    expect(error?.retryable).toBe(false);
    expect(error?.message).toContain('I cannot help with that.');
  });

  it('maps a length finish reason to truncated', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload({ content: 'partial', finishReason: 'length' }));
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    expect(
      eventsOfType(events, 'text_delta')
        .map((event) => event.text)
        .join(''),
      JSON.stringify(events),
    ).toBe('partial');
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('length');
    const error = lastError(events)?.error;
    expect(error?.code).toBe('truncated');
    expect(error?.retryable).toBe(false);
  });

  it('maps a non-JSON success body to invalid_response', async () => {
    const server = await fake(({ res }) => {
      rawResponse(res, 'this is not json');
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    expect(lastError(events)?.error.code).toBe('invalid_response');
    expect(eventsOfType(events, 'text_delta')).toHaveLength(0);
  });

  it('maps a response without choices to invalid_response', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, { id: 'x', choices: [] });
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    expect(lastError(events)?.error.code).toBe('invalid_response');
  });
});

/* ------------------------------------------------------------------ */
/* Streaming responses                                                 */
/* ------------------------------------------------------------------ */

describe('streaming SSE responses', () => {
  it('parses multi-delta text, finish reason and provider usage in order', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ role: 'assistant', content: '' }));
      writeSseJson(res, chatChunk({ content: 'Hel' }));
      writeSseJson(res, chatChunk({ content: 'lo ' }));
      writeSseJson(res, chatChunk({ content: 'world' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseJson(res, usageChunk(11, 5));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(lastError(events)).toBeNull();
    expect(eventsOfType(events, 'text_delta').map((event) => event.text)).toEqual(['Hel', 'lo ', 'world']);
    const finishIndex = events.findIndex((event) => event.type === 'finish');
    const usageIndex = events.findIndex((event) => event.type === 'usage');
    expect(events[finishIndex]).toEqual({ type: 'finish', reason: 'stop' });
    expect(usageIndex).toBeGreaterThan(finishIndex);
    const usage = eventsOfType(events, 'usage')[0]?.usage;
    expect(usage?.source).toBe('provider');
    expect(usage?.inputTokens).toBe(11);
    expect(usage?.outputTokens).toBe(5);
  });

  it('treats a JSON body returned for a stream request as one honest delta', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload({ content: 'buffered answer' }));
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(lastError(events)).toBeNull();
    const deltas = eventsOfType(events, 'text_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.text).toBe('buffered answer');
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('stop');
  });

  it('emits estimated usage when a stream omits usage', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'no usage here' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const usage = eventsOfType(events, 'usage')[0]?.usage;
    expect(usage?.source).toBe('estimated');
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
    expect(usage?.costUsd).toBeNull();
  });

  it('marks partially reported usage as mixed instead of fabricating provider numbers', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'text' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseJson(res, {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 9 },
      });
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const usage = eventsOfType(events, 'usage')[0]?.usage;
    expect(usage?.source).toBe('mixed');
    expect(usage?.inputTokens).toBe(9);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });

  it('assembles interleaved tool call deltas per index', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(
        res,
        chatChunk({
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'get_', arguments: '' } },
          ],
        }),
      );
      writeSseJson(
        res,
        chatChunk({
          tool_calls: [
            { index: 1, id: 'call_b', type: 'function', function: { name: 'other', arguments: '{"n":' } },
          ],
        }),
      );
      writeSseJson(
        res,
        chatChunk({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"q":' } }] }),
      );
      writeSseJson(res, chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }));
      writeSseJson(res, chatChunk({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] }));
      writeSseJson(res, chatChunk({}, 'tool_calls'));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(lastError(events)).toBeNull();
    const completes = eventsOfType(events, 'tool_call_complete');
    expect(completes).toHaveLength(2);
    expect(completes[0]).toMatchObject({
      index: 0,
      callId: 'call_a',
      name: 'get_weather',
      argumentsJson: '{"q":"x"}',
    });
    expect(completes[1]).toMatchObject({ index: 1, callId: 'call_b', name: 'other', argumentsJson: '{"n":2}' });
    expect(eventsOfType(events, 'tool_call_delta').length).toBeGreaterThanOrEqual(4);
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('tool_calls');
  });

  it('emits an assembled tool call with malformed JSON without throwing or executing it', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(
        res,
        chatChunk({
          tool_calls: [
            { index: 0, id: 'call_broken', type: 'function', function: { name: 'do_it', arguments: '{"a":' } },
          ],
        }),
      );
      writeSseJson(res, chatChunk({}, 'tool_calls'));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(lastError(events)).toBeNull();
    const completes = eventsOfType(events, 'tool_call_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.argumentsJson).toBe('{"a":');
    expect(() => JSON.parse(completes[0]?.argumentsJson ?? '')).toThrow();
  });

  it('preserves partial text before surfacing a length truncation', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'partial output' }));
      writeSseJson(res, chatChunk({}, 'length'));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const text = eventsOfType(events, 'text_delta').map((event) => event.text).join('');
    expect(text, JSON.stringify(events)).toBe('partial output');
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('length');
    const error = lastError(events)?.error;
    expect(error?.code).toBe('truncated');
    expect(error?.retryable).toBe(false);
  });

  it('treats an abrupt stream close as truncated and keeps partial text', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'cut off' }));
      endSse(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(eventsOfType(events, 'text_delta').map((event) => event.text).join('')).toBe('cut off');
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('error');
    const error = lastError(events)?.error;
    expect(error?.code).toBe('truncated');
    expect(error?.retryable).toBe(true);
  });

  it('surfaces a content-filter refusal with the public reason', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ refusal: 'I cannot help with that.' }));
      writeSseJson(res, chatChunk({}, 'content_filter'));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('content_filter');
    const error = lastError(events)?.error;
    expect(error?.code).toBe('refused');
    expect(error?.retryable).toBe(false);
    expect(error?.message).toContain('I cannot help with that.');
  });

  it('ignores SSE keep-alive comments and keeps the stream open', async () => {
    const server = await fake(async ({ res }) => {
      startSse(res);
      writeSseRaw(res, ': keep-alive\n\n');
      await delay(150);
      writeSseJson(res, chatChunk({ content: 'ok' }));
      await delay(150);
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    const events = await collectEvents(
      makeAdapter(server, {}, { firstEventTimeoutMs: 3000, idleTimeoutMs: 600 }),
      makeRequest(),
    );
    expect(lastError(events)).toBeNull();
    expect(eventsOfType(events, 'text_delta').map((event) => event.text).join('')).toBe('ok');
    // The keep-alive comment must not be parsed as a data event.
    expect(JSON.stringify(events)).not.toContain('keep-alive');
  });

  it('maps an invalid SSE JSON chunk to invalid_response', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseRaw(res, 'data: this-is-not-json\n\n');
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(lastError(events)?.error.code).toBe('invalid_response');
  });

  it('maps an error payload inside a 200 SSE stream and redacts credentials', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseRaw(
        res,
        `data: ${JSON.stringify({ error: { message: `invalid api key: ${TEST_CREDENTIAL}`, code: 'invalid_api_key' } })}\n\n`,
      );
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const error = lastError(events)?.error;
    expect(error?.code).toBe('auth_error');
    expect(error?.retryable).toBe(false);
    expect(error?.message).not.toContain(TEST_CREDENTIAL);
    expect(error?.message).toContain('6789');
  });

  it('never puts the credential into emitted events', async () => {
    const errorServer = await fake(({ res }) => {
      startSse(res);
      writeSseRaw(
        res,
        `data: ${JSON.stringify({ error: { message: `invalid api key ${TEST_CREDENTIAL}`, code: 'invalid_api_key' } })}\n\n`,
      );
      writeSseDone(res);
    });
    const errorEvents = await collectEvents(makeAdapter(errorServer), makeRequest());
    const errorSerialized = JSON.stringify(errorEvents);
    expect(errorSerialized).not.toContain(TEST_CREDENTIAL);
    expect(errorSerialized).not.toContain('abc123456789');

    const successServer = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'safe' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    const successEvents = await collectEvents(makeAdapter(successServer), makeRequest());
    const successSerialized = JSON.stringify(successEvents);
    expect(successSerialized).not.toContain(TEST_CREDENTIAL);
    expect(successSerialized).not.toContain('abc123456789');
  });

  it('captures a usage-only chunk with empty choices', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'x' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseJson(res, usageChunk(4, 2));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const usage = eventsOfType(events, 'usage')[0]?.usage;
    expect(usage?.source).toBe('provider');
    expect(usage?.inputTokens).toBe(4);
    expect(usage?.outputTokens).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* HTTP error mapping                                                  */
/* ------------------------------------------------------------------ */

describe('HTTP error mapping', () => {
  const httpCases: Array<{ status: number; code: string; retryable: boolean }> = [
    { status: 401, code: 'auth_error', retryable: false },
    { status: 403, code: 'auth_error', retryable: false },
    { status: 404, code: 'model_missing', retryable: false },
    { status: 400, code: 'bad_request', retryable: false },
    { status: 422, code: 'bad_request', retryable: false },
    { status: 500, code: 'server_error', retryable: true },
    { status: 502, code: 'server_error', retryable: true },
    { status: 503, code: 'server_error', retryable: true },
  ];
  for (const testCase of httpCases) {
    it(`maps HTTP ${testCase.status} to ${testCase.code}`, async () => {
      const server = await fake(({ res }) => {
        jsonResponse(res, { error: { message: `provider said ${testCase.status}`, type: 'test_error' } }, testCase.status);
      });
      const events = await collectEvents(makeAdapter(server), makeRequest());
      const error = lastError(events)?.error;
      expect(error?.code).toBe(testCase.code);
      expect(error?.retryable).toBe(testCase.retryable);
      expect(error?.httpStatus).toBe(testCase.status);
      expect(error?.message).toContain(`provider said ${testCase.status}`);
      // The adapter never retries providers on its own (retry policy belongs to
      // the caller's budget) and never switches provider.
      expect(server.requests).toHaveLength(1);
    });
  }

  it('maps 429 with Retry-After and provider request id', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(
        res,
        { error: { message: 'Rate limit reached', type: 'rate_limit_error' } },
        429,
        { 'retry-after': '2', 'x-request-id': 'req_abc123' },
      );
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const error = lastError(events)?.error;
    expect(error?.code).toBe('rate_limited');
    expect(error?.retryable).toBe(true);
    expect(error?.httpStatus).toBe(429);
    expect(error?.retryAfterMs).toBe(2000);
    expect(error?.providerRequestId).toBe('req_abc123');
  });

  it('never leaks the credential from a provider error message', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(
        res,
        { error: { message: `Incorrect API key provided: ${TEST_CREDENTIAL}`, code: 'invalid_api_key' } },
        401,
      );
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const error = lastError(events)?.error;
    expect(error?.code).toBe('auth_error');
    expect(error?.message ?? '').not.toContain(TEST_CREDENTIAL);
    expect(error?.message ?? '').not.toContain('abc123456789');
    expect(error?.message ?? '').toContain('6789');
  });

  it('maps an unreadable non-JSON error body using the status reason', async () => {
    const server = await fake(({ res }) => {
      rawResponse(res, '<html>bad gateway</html>', 500, 'text/html');
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    const error = lastError(events)?.error;
    expect(error?.code).toBe('server_error');
    expect(error?.message).toContain('HTTP 500');
  });
});

/* ------------------------------------------------------------------ */
/* Timeouts and cancellation                                           */
/* ------------------------------------------------------------------ */

describe('timeouts and cancellation', () => {
  it('surfaces idle timeout after partial text', async () => {
    const server = await fake(async ({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'partial' }));
      await delay(600);
      endSse(res);
    });
    const events = await collectEvents(
      makeAdapter(server, {}, { firstEventTimeoutMs: 2000, idleTimeoutMs: 150 }),
      makeRequest(),
    );
    const textIndex = events.findIndex((event) => event.type === 'text_delta');
    const errorIndex = events.findIndex((event) => event.type === 'error');
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(textIndex);
    const error = lastError(events)?.error;
    expect(error?.code).toBe('idle_timeout');
    expect(error?.retryable).toBe(true);
  });

  it('surfaces first-event timeout when no stream event arrives', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      // deliberately never write a data chunk
    });
    const events = await collectEvents(
      makeAdapter(server, {}, { firstEventTimeoutMs: 120, idleTimeoutMs: 2000 }),
      makeRequest(),
    );
    expect(eventsOfType(events, 'text_delta')).toHaveLength(0);
    const error = lastError(events)?.error;
    expect(error?.code).toBe('first_event_timeout');
    expect(error?.retryable).toBe(true);
  });

  it('surfaces total timeout for a stalled stream', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
    });
    const events = await collectEvents(
      makeAdapter(server, {}, { firstEventTimeoutMs: 2000, idleTimeoutMs: 2000, totalTimeoutMs: 150 }),
      makeRequest(),
    );
    const error = lastError(events)?.error;
    expect(error?.code).toBe('total_timeout');
    expect(error?.retryable).toBe(true);
  });

  it('keeps partial text when the total timeout fires mid-stream', async () => {
    const server = await fake(async ({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'partial before total timeout' }));
      await delay(600);
      endSse(res);
    });
    const events = await collectEvents(
      makeAdapter(server, {}, { firstEventTimeoutMs: 2000, idleTimeoutMs: 2000, totalTimeoutMs: 150 }),
      makeRequest(),
    );
    const textIndex = events.findIndex((event) => event.type === 'text_delta');
    const errorIndex = events.findIndex((event) => event.type === 'error');
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(textIndex);
    expect(lastError(events)?.error.code).toBe('total_timeout');
  });

  it('maps an unknown finish reason to unknown without failing the call', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'ok' }));
      writeSseJson(res, chatChunk({}, 'some_future_reason'));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(lastError(events)).toBeNull();
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('unknown');
  });

  it('maps an error finish reason to a retryable server_error', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'ok' }));
      writeSseJson(res, chatChunk({}, 'error'));
      writeSseDone(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest());
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('error');
    const error = lastError(events)?.error;
    expect(error?.code).toBe('server_error');
    expect(error?.retryable).toBe(true);
  });

  it('honors an AbortSignal mid-stream and maps it to cancelled', async () => {
    const server = await fake(async ({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'first' }));
      await delay(1000);
      endSse(res);
    });
    const events = await collectEvents(makeAdapter(server), makeRequest(), {
      onEvent: (event, controller) => {
        if (event.type === 'text_delta') controller.abort();
      },
    });
    expect(eventsOfType(events, 'text_delta').map((event) => event.text).join('')).toBe('first');
    const error = lastError(events)?.error;
    expect(error?.code).toBe('cancelled');
    expect(error?.retryable).toBe(false);
  });

  it('does not send a request for an already-aborted signal', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload());
    });
    const controller = new AbortController();
    controller.abort();
    const events = await collectEvents(makeAdapter(server), makeRequest(), { signal: controller.signal });
    expect(server.requests).toHaveLength(0);
    expect(lastError(events)?.error.code).toBe('cancelled');
  });
});

/* ------------------------------------------------------------------ */
/* Redirects and URL policy                                            */
/* ------------------------------------------------------------------ */

describe('redirect handling', () => {
  it('follows a same-origin 307 redirect', async () => {
    let server!: FakeServer;
    server = await fake(({ res, url }) => {
      if (url.includes('redirected=1')) {
        jsonResponse(res, chatCompletionPayload({ content: 'after redirect' }));
        return;
      }
      res.writeHead(307, { location: '/chat/completions?redirected=1' });
      res.end();
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    expect(lastError(events)).toBeNull();
    expect(eventsOfType(events, 'text_delta').map((event) => event.text).join('')).toBe('after redirect');
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.url).toBe('/chat/completions?redirected=1');
  });

  it('rejects a redirect to a cloud metadata endpoint', async () => {
    const server = await fake(({ res }) => {
      res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    const error = lastError(events)?.error;
    expect(error?.code).toBe('invalid_response');
    expect(error?.message).toMatch(/redirect/i);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects a cross-origin redirect by default', async () => {
    const target = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload());
    });
    const server = await fake(({ res }) => {
      res.writeHead(307, { location: target.baseUrl });
      res.end();
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    expect(lastError(events)?.error.code).toBe('invalid_response');
    expect(target.requests).toHaveLength(0);
  });

  it('does not follow method-changing 301/302 redirects for POST', async () => {
    const server = await fake(({ res }) => {
      res.writeHead(301, { location: '/chat/completions' });
      res.end();
    });
    const events = await collectEvents(makeAdapter(server), makeRequest({ stream: false }));
    const error = lastError(events)?.error;
    expect(error?.code).toBe('invalid_response');
    expect(error?.message).toMatch(/method/i);
  });
});

/* ------------------------------------------------------------------ */
/* Construction / configuration                                        */
/* ------------------------------------------------------------------ */

describe('adapter construction and configuration', () => {
  it('rejects missing credentials', () => {
    expect(() => createAdapter(makeProfile('https://api.example.com/v1'), '')).toThrowError(ProviderError);
    try {
      createAdapter(makeProfile('https://api.example.com/v1'), '   ');
    } catch (error) {
      expect((error as ProviderError).code).toBe('auth_error');
    }
  });

  it('rejects adapter types that are not implemented instead of falling back', () => {
    const profile = makeProfile('https://api.example.com/v1', { adapterType: 'anthropic_native' });
    try {
      createAdapter(profile, TEST_CREDENTIAL);
      throw new Error('adapter creation should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe('unsupported_feature');
    }
  });

  it('rejects plain HTTP to a remote host by default', () => {
    try {
      createAdapter(makeProfile('http://api.example.com/v1'), TEST_CREDENTIAL);
      throw new Error('adapter creation should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe('bad_request');
    }
  });

  it('allows internal HTTPS hosts only through the explicit allow-list', () => {
    expect(() => createAdapter(makeProfile('https://10.0.0.5/v1'), TEST_CREDENTIAL)).toThrowError(ProviderError);
    const adapter = createAdapter(makeProfile('https://10.0.0.5/v1'), TEST_CREDENTIAL, {
      urlPolicy: { allowHttpLoopback: false, allowedProviderHosts: ['10.0.0.5'] },
    });
    expect((adapter as unknown as { describe(): { requestUrl: string } }).describe().requestUrl).toBe(
      'https://10.0.0.5/v1/chat/completions',
    );
  });

  it('reports stored capabilities without inventing new claims', async () => {
    const profile = makeProfile('https://api.example.com/v1', {
      capabilities: {
        streaming: 'verified',
        toolCalling: 'unsupported',
        structuredOutput: 'unknown',
        vision: 'unknown',
        usageReporting: 'verified',
        checkedAt: '2026-01-02T00:00:00.000Z',
        testedModel: 'test-model',
        testedServiceLabel: 'api.example.com/v1',
      },
    });
    const adapter = createAdapter(profile, TEST_CREDENTIAL);
    await expect(adapter.capabilities('any-id')).resolves.toEqual(profile.capabilities);
  });

  it('resolves effective timeouts from options over profile values', () => {
    const profile = makeProfile('https://api.example.com/v1', {
      timeouts: { firstEventTimeoutMs: 11_000, idleTimeoutMs: 12_000, totalTimeoutMs: 13_000 },
    });
    const adapter = createAdapter(profile, TEST_CREDENTIAL) as unknown as {
      describe(): { firstEventTimeoutMs: number; idleTimeoutMs: number; totalTimeoutMs: number };
    };
    expect(adapter.describe().firstEventTimeoutMs).toBe(11_000);
    expect(adapter.describe().idleTimeoutMs).toBe(12_000);
    expect(adapter.describe().totalTimeoutMs).toBe(13_000);
  });
});

/* ------------------------------------------------------------------ */
/* Request validation / stream collection helper                        */
/* ------------------------------------------------------------------ */

describe('request validation and helpers', () => {
  it('rejects an invalid model request before sending it', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload());
    });
    const invalid = { ...makeRequest(), model: '' } as ModelRequest;
    const events = await collectEvents(makeAdapter(server), invalid);
    expect(server.requests).toHaveLength(0);
    const error = lastError(events)?.error;
    expect(error?.code).toBe('bad_request');
    expect(error?.message).toContain('model');
  });

  it('streamEventsFromAdapter collects the same events', async () => {
    const server = await fake(({ res }) => {
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'collected' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    const controller = new AbortController();
    const events: ModelEvent[] = await streamEventsFromAdapter(
      makeAdapter(server),
      makeRequest(),
      controller.signal,
    );
    expect(eventsOfType(events, 'text_delta').map((event) => event.text).join('')).toBe('collected');
    expect(eventsOfType(events, 'finish')[0]?.reason).toBe('stop');
  });
});
