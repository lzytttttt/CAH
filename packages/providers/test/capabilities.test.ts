/**
 * Capability test contract tests: two-step (auth+text first), explicit probes,
 * no capability claims from HTTP 200 alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelRequestSchema,
  type CapabilityProbeName,
  type ModelRequest,
  type ProviderProfile,
} from '@ca/contracts';
import {
  ProviderError,
  buildCapabilityRequestPlan,
  buildCapabilityRequests,
  probeTextModelRequest,
  runCapabilityTests,
} from '../src/index';
import {
  TEST_CREDENTIAL,
  chatChunk,
  chatCompletionPayload,
  jsonResponse,
  makeProfile,
  startFakeServer,
  startSse,
  usageChunk,
  writeSseDone,
  writeSseJson,
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

function lastUserMessage(json: Record<string, unknown> | null): string {
  const messages = (json?.['messages'] as Array<Record<string, unknown>> | undefined) ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message['role'] === 'user' && typeof message['content'] === 'string') {
      return message['content'] as string;
    }
  }
  return '';
}

function writeTextSse(res: Parameters<FakeHandler>[0]['res'], chunks: string[], finish = 'stop'): void {
  startSse(res);
  for (const chunk of chunks) writeSseJson(res, chatChunk({ content: chunk }));
  writeSseJson(res, chatChunk({}, finish));
}

/** Handler where every probe verifies, including provider usage reporting. */
const allVerifiedHandler: FakeHandler = ({ res, json }) => {
  const stream = json?.['stream'] === true;
  const user = lastUserMessage(json);
  if (!stream) {
    jsonResponse(res, chatCompletionPayload({ content: 'OK' }));
    return;
  }
  if (json?.['tools']) {
    startSse(res);
    writeSseJson(
      res,
      chatChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_probe',
            type: 'function',
            function: { name: 'record_probe_value', arguments: '{"value":42}' },
          },
        ],
      }),
    );
    writeSseJson(res, chatChunk({}, 'tool_calls'));
    writeSseDone(res);
    return;
  }
  if (json?.['response_format']) {
    startSse(res);
    writeSseJson(res, chatChunk({ content: '{"status":"ok"}' }));
    writeSseJson(res, chatChunk({}, 'stop'));
    writeSseJson(res, usageChunk(9, 3));
    writeSseDone(res);
    return;
  }
  if (user.includes('Probe streaming')) {
    startSse(res);
    writeSseJson(res, chatChunk({ content: '1' }));
    writeSseJson(res, chatChunk({ content: ' 2' }));
    writeSseJson(res, chatChunk({ content: ' 3' }));
    writeSseJson(res, chatChunk({}, 'stop'));
    writeSseDone(res);
    return;
  }
  if (user.includes('Probe usage')) {
    startSse(res);
    writeSseJson(res, chatChunk({ content: 'OK' }));
    writeSseJson(res, chatChunk({}, 'stop'));
    writeSseJson(res, usageChunk(12, 1));
    writeSseDone(res);
    return;
  }
  writeTextSse(res, ['unexpected']);
  writeSseDone(res);
};

const ALL_PROBES: readonly CapabilityProbeName[] = [
  'streaming',
  'tool_calling',
  'structured_output',
  'usage',
];

describe('runCapabilityTests', () => {
  it('runs the two-step test and only claims verified capabilities', async () => {
    const server = await fake(allVerifiedHandler);
    const profile = makeProfile(server.baseUrl);
    const { report } = await runCapabilityTests({
      profile,
      credential: TEST_CREDENTIAL,
      probes: ALL_PROBES,
      probeTimeoutMs: 3000,
    });

    expect(report.profileId).toBe(profile.id);
    expect(report.testedModel).toBe('test-model');
    expect(report.serviceLabel).toContain('127.0.0.1');
    expect(report.startedAt.endsWith('Z')).toBe(true);
    expect(report.finishedAt.endsWith('Z')).toBe(true);
    expect(report.requestCount).toBe(5); // auth + four probes
    expect(report.probes.map((probe) => probe.capability)).toEqual([
      'auth_and_text',
      'streaming',
      'tool_calling',
      'structured_output',
      'usage',
    ]);
    for (const probe of report.probes) {
      expect(probe.status).toBe('verified');
      expect(probe.testedModel).toBe('test-model');
      expect(probe.testedAt.endsWith('Z')).toBe(true);
      expect(probe.latencyMs).not.toBeNull();
      expect(probe.latencyMs ?? -1).toBeGreaterThanOrEqual(0);
      expect(probe.error).toBeNull();
    }
    expect(report.capabilities).toMatchObject({
      streaming: 'verified',
      toolCalling: 'verified',
      structuredOutput: 'verified',
      usageReporting: 'verified',
      vision: 'unknown',
      testedModel: 'test-model',
    });
    expect(report.capabilities.testedServiceLabel).toContain('127.0.0.1');
    expect(report.capabilities.notes ?? '').toContain('Vision was not tested');
    expect(report.estimatedCostUsd).toBeNull();
  });

  it('stops after a failed auth/basic-text step and reports the rest as unknown', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, { error: { message: 'bad key', code: 'invalid_api_key' } }, 401);
    });
    const { report } = await runCapabilityTests({
      profile: makeProfile(server.baseUrl),
      credential: TEST_CREDENTIAL,
      probes: ALL_PROBES,
      probeTimeoutMs: 3000,
    });
    expect(report.requestCount).toBe(1);
    const authProbe = report.probes[0];
    expect(authProbe?.capability).toBe('auth_and_text');
    expect(authProbe?.status).toBe('error');
    expect(authProbe?.error?.code).toBe('auth_error');
    for (const probe of report.probes.slice(1)) {
      expect(probe.status).toBe('unknown');
      expect(probe.detail).toContain('not run');
      expect(probe.error).toBeNull();
    }
    expect(report.capabilities.streaming).toBe('unknown');
    expect(report.capabilities.toolCalling).toBe('unknown');
    expect(report.capabilities.usageReporting).toBe('unknown');
  });

  it('does not claim streaming when the provider answers in a single chunk', async () => {
    const server = await fake(({ res, json }) => {
      if (json?.['stream'] === true) {
        // Provider ignores stream:true and returns one JSON document.
        jsonResponse(res, chatCompletionPayload({ content: '1 2 3' }));
        return;
      }
      jsonResponse(res, chatCompletionPayload({ content: 'OK' }));
    });
    const { report } = await runCapabilityTests({
      profile: makeProfile(server.baseUrl),
      credential: TEST_CREDENTIAL,
      probes: ['streaming'],
      probeTimeoutMs: 3000,
    });
    const streaming = report.probes.find((probe) => probe.capability === 'streaming');
    expect(streaming?.status).toBe('unknown');
    expect(streaming?.detail).toMatch(/single chunk/i);
    expect(report.capabilities.streaming).toBe('unknown');
  });

  it('marks explicitly rejected features unsupported and missing usage unsupported', async () => {
    const server = await fake(({ res, json }) => {
      const stream = json?.['stream'] === true;
      const user = lastUserMessage(json);
      if (!stream) {
        jsonResponse(res, chatCompletionPayload({ content: 'OK' }));
        return;
      }
      if (json?.['tools']) {
        jsonResponse(res, { error: { message: 'tools are not supported by this model' } }, 400);
        return;
      }
      if (json?.['response_format']) {
        jsonResponse(res, { error: { message: 'response_format json_schema is not supported' } }, 400);
        return;
      }
      if (user.includes('Probe streaming')) {
        startSse(res);
        writeSseJson(res, chatChunk({ content: '1' }));
        writeSseJson(res, chatChunk({ content: ' 2' }));
        writeSseJson(res, chatChunk({}, 'stop'));
        writeSseDone(res);
        return;
      }
      // usage probe: valid response but no usage chunk
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'OK' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    const { report } = await runCapabilityTests({
      profile: makeProfile(server.baseUrl),
      credential: TEST_CREDENTIAL,
      probes: ALL_PROBES,
      probeTimeoutMs: 3000,
    });
    const byCapability = new Map(report.probes.map((probe) => [probe.capability, probe]));
    expect(byCapability.get('auth_and_text')?.status).toBe('verified');
    expect(byCapability.get('streaming')?.status).toBe('verified');
    expect(byCapability.get('tool_calling')?.status).toBe('unsupported');
    expect(byCapability.get('structured_output')?.status).toBe('unsupported');
    expect(byCapability.get('usage')?.status).toBe('unsupported');
    expect(report.capabilities).toMatchObject({
      streaming: 'verified',
      toolCalling: 'unsupported',
      structuredOutput: 'unsupported',
      usageReporting: 'unsupported',
    });
  });

  it('maps transport failures to probe error without claiming unsupported', async () => {
    const server = await fake(({ res, json }) => {
      if (json?.['stream'] === true) {
        jsonResponse(res, { error: { message: 'boom' } }, 500);
        return;
      }
      jsonResponse(res, chatCompletionPayload({ content: 'OK' }));
    });
    const { report } = await runCapabilityTests({
      profile: makeProfile(server.baseUrl),
      credential: TEST_CREDENTIAL,
      probes: ['streaming'],
      probeTimeoutMs: 3000,
    });
    const streaming = report.probes.find((probe) => probe.capability === 'streaming');
    expect(streaming?.status).toBe('error');
    expect(streaming?.error?.code).toBe('server_error');
    expect(report.capabilities.streaming).toBe('unknown');
  });

  it('honors the abort signal by throwing cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCapabilityTests({
        profile: makeProfile('http://127.0.0.1:9'),
        credential: TEST_CREDENTIAL,
        probes: ['streaming'],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports a construction failure instead of sending requests', async () => {
    const profile = makeProfile('http://api.example.com/v1'); // plain HTTP remote is not allowed
    const { report } = await runCapabilityTests({
      profile,
      credential: TEST_CREDENTIAL,
      probes: ['streaming'],
    });
    expect(report.requestCount).toBe(0);
    expect(report.probes).toHaveLength(2);
    for (const probe of report.probes) {
      expect(probe.status).toBe('error');
      expect(probe.error?.code).toBe('bad_request');
    }
    expect(report.capabilities.streaming).toBe('unknown');
  });

  it('computes estimatedCostUsd from a complete price table', async () => {
    const server = await fake(allVerifiedHandler);
    const profile = makeProfile(server.baseUrl, {
      priceTable: { currency: 'USD', inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
    });
    const { report } = await runCapabilityTests({
      profile,
      credential: TEST_CREDENTIAL,
      probes: ['usage'],
      probeTimeoutMs: 3000,
    });
    expect(report.estimatedCostUsd).not.toBeNull();
    expect(report.estimatedCostUsd ?? 0).toBeGreaterThan(0);
  });

  it('retries once without stream_options when a provider rejects that optional field', async () => {
    const server = await fake(({ res, json }) => {
      const stream = json?.['stream'] === true;
      const user = lastUserMessage(json);
      if (!stream) {
        jsonResponse(res, chatCompletionPayload({ content: 'OK' }));
        return;
      }
      if (user.includes('Probe streaming')) {
        if (json?.['stream_options']) {
          jsonResponse(
            res,
            { error: { message: 'Unrecognized request argument supplied: stream_options' } },
            400,
          );
          return;
        }
        startSse(res);
        writeSseJson(res, chatChunk({ content: '1' }));
        writeSseJson(res, chatChunk({ content: ' 2' }));
        writeSseJson(res, chatChunk({}, 'stop'));
        writeSseDone(res);
        return;
      }
      startSse(res);
      writeSseJson(res, chatChunk({ content: 'OK' }));
      writeSseJson(res, chatChunk({}, 'stop'));
      writeSseDone(res);
    });
    const { report } = await runCapabilityTests({
      profile: makeProfile(server.baseUrl),
      credential: TEST_CREDENTIAL,
      probes: ['streaming'],
      probeTimeoutMs: 3000,
    });
    expect(report.capabilities.streaming).toBe('verified');
    expect(report.requestCount).toBe(3); // auth + rejected streaming attempt + retry
    expect(server.requests).toHaveLength(3);
    expect(server.requests[1]?.json?.['stream_options']).toEqual({ include_usage: true });
    expect(server.requests[2]?.json?.['stream_options']).toBeUndefined();
  });

  it('rejects an empty probe list', async () => {
    await expect(
      runCapabilityTests({
        profile: makeProfile('http://127.0.0.1:9'),
        credential: TEST_CREDENTIAL,
        probes: [],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('capability request builders', () => {
  it('builds deterministic, contract-valid probe requests with auth first', () => {
    const profile = makeProfile('https://api.example.com/v1');
    const requests = buildCapabilityRequests(profile, ['usage', 'streaming']);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(ModelRequestSchema.safeParse(request).success).toBe(true);
      expect(request.maxOutputTokens).toBeLessThanOrEqual(64);
    }
    expect(requests[0]?.stream).toBe(false);
    expect(requests[0]?.toolChoice).toBe('none');
    expect(requests[1]?.stream).toBe(true);
    expect(requests[2]?.stream).toBe(true);
    const again = buildCapabilityRequests(profile, ['usage', 'streaming']);
    expect(JSON.stringify(again)).toBe(JSON.stringify(requests));
    const plan = buildCapabilityRequestPlan(profile, ['structured_output']);
    expect(plan.map((entry) => entry.probe)).toEqual(['auth_and_text', 'structured_output']);
  });

  it('probeTextModelRequest is a small non-streaming text request', () => {
    const profile = makeProfile('https://api.example.com/v1');
    const request: ModelRequest = probeTextModelRequest(profile);
    expect(ModelRequestSchema.safeParse(request).success).toBe(true);
    expect(request.stream).toBe(false);
    expect(request.maxOutputTokens).toBeLessThanOrEqual(32);
    expect(request.responseFormat.kind).toBe('text');
    expect(request.messages[request.messages.length - 1]?.role).toBe('user');
  });

  it('keeps vision and unprobed capabilities unknown in reports', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(res, chatCompletionPayload({ content: 'OK' }));
    });
    const { report } = await runCapabilityTests({
      profile: makeProfile(server.baseUrl),
      credential: TEST_CREDENTIAL,
      probes: ['streaming'],
      probeTimeoutMs: 3000,
    });
    expect(report.capabilities.vision).toBe('unknown');
    expect(report.capabilities.toolCalling).toBe('unknown');
    expect(report.capabilities.structuredOutput).toBe('unknown');
  });

  it('never returns provider secrets in probe error details', async () => {
    const server = await fake(({ res }) => {
      jsonResponse(
        res,
        { error: { message: `Incorrect API key provided: ${TEST_CREDENTIAL}` } },
        401,
      );
    });
    const { report } = await runCapabilityTests({
      profile: makeProfile(server.baseUrl) as ProviderProfile,
      credential: TEST_CREDENTIAL,
      probes: ['streaming'],
      probeTimeoutMs: 3000,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(TEST_CREDENTIAL);
    expect(serialized).not.toContain('abc123456789');
  });
});
