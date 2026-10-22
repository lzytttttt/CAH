import { describe, expect, it } from 'vitest';
import {
  TOOL_IDS,
  ToolDescriptorSchema,
  ToolPolicySchema,
  type JsonObject,
  type SourceId,
  type ToolDefinition,
  type ToolId,
  type ToolResult,
} from '@ca/contracts';
import { createToolRuntime, TOOL_ERROR_CODES, modelToolName, toolIdForModelName } from '@ca/tools';
import { createTestWorld, failureOf, jsonArg, succeededData, type TestWorld } from './helpers';
import { SOURCE_ID_A, SOURCE_ID_B } from './source-ids';

const MODULE_ID = '66666666-6666-4666-8666-666666666666';

function schemaOf(parameters: JsonObject): Record<string, unknown> {
  return parameters as unknown as Record<string, unknown>;
}

describe('tool descriptors', () => {
  const runtime = createToolRuntime();
  const descriptors = runtime.descriptors();

  it('exposes all eight P0 tools exactly once', () => {
    expect(descriptors).toHaveLength(8);
    expect(descriptors.map((descriptor) => descriptor.id).sort()).toEqual([...TOOL_IDS].sort());
    for (const descriptor of descriptors) {
      expect(ToolDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(ToolPolicySchema.safeParse(descriptor.policy).success).toBe(true);
      expect(descriptor.modelFacing).toBe(true);
      expect(descriptor.version.length).toBeGreaterThan(0);
    }
  });

  it('declares strict object JSON schemas with the required argument keys', () => {
    const requiredByTool: Record<string, string[]> = {
      'source.list': ['includeUnavailable'],
      'source.read': ['sourceId', 'version', 'maxChars'],
      'source.search': ['query', 'limit'],
      'data.profile': ['sourceId', 'version'],
      'data.transform': ['sourceId', 'version', 'format', 'operations', 'outputName'],
      'artifact.read': ['moduleId', 'versionId'],
      'artifact.propose_patch': ['moduleId', 'baseVersionId', 'description', 'operations', 'evidenceRefs'],
      'artifact.validate': ['moduleId', 'baseVersionId', 'candidate', 'evidenceRefs'],
    };
    for (const descriptor of descriptors) {
      const schema = schemaOf(descriptor.parameters);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      const required = schema.required as string[];
      for (const key of requiredByTool[descriptor.id]!) {
        expect(required).toContain(key);
      }
    }
    const transform = descriptors.find((descriptor) => descriptor.id === 'data.transform')!;
    const operations = (schemaOf(transform.parameters).properties as Record<string, JsonObject>).operations!;
    const operationItems = schemaOf(operations).items as Record<string, unknown>;
    const operationVariants = operationItems.oneOf as Array<Record<string, unknown>>;
    expect(operationVariants.length).toBe(11);
    for (const variant of operationVariants) expect(variant.additionalProperties).toBe(false);
  });

  it('enforces sensible policies', () => {
    for (const descriptor of descriptors) {
      const policy = descriptor.policy;
      expect(policy.requiredScopes.length).toBeGreaterThan(0);
      expect(policy.timeoutMs).toBeGreaterThan(0);
      expect(policy.timeoutMs).toBeLessThanOrEqual(600_000);
      expect(policy.maxResultBytes).toBeGreaterThan(0);
      expect(['read', 'draft_write', 'external_write']).toContain(policy.effect);
    }
    const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
    expect(byId.get('source.read')!.policy).toMatchObject({ effect: 'read', idempotency: 'safe' });
    expect(byId.get('data.transform')!.policy).toMatchObject({ effect: 'draft_write', idempotency: 'keyed' });
    expect(byId.get('artifact.propose_patch')!.policy.requiredScopes).toContain('artifact:draft_write');
  });

  it('builds model-facing definitions only for allowed tools', () => {
    const allowed: ToolId[] = ['source.read', 'artifact.validate'];
    const definitions = runtime.modelTools(allowed);
    expect(definitions.map((definition: ToolDefinition) => definition.name)).toEqual(allowed);
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeLessThanOrEqual(4000);
      expect(definition.strict).toBe(true);
      expect(schemaOf(definition.parameters).type).toBe('object');
    }
    expect(runtime.modelTools([])).toEqual([]);
  });

  it('maps model function names back to tool ids', () => {
    expect(modelToolName('source.read')).toBe('source.read');
    expect(toolIdForModelName('source.read')).toBe('source.read');
    expect(toolIdForModelName('source_read')).toBe('source.read');
    expect(toolIdForModelName('source__read')).toBe('source.read');
    expect(toolIdForModelName('artifact_propose_patch')).toBe('artifact.propose_patch');
    expect(toolIdForModelName('nope')).toBeNull();
  });

  it('exposes deterministic argument schema info', () => {
    const first = runtime.descriptors();
    const second = runtime.descriptors();
    expect(first).toEqual(second);
  });
});

describe('validateArguments', () => {
  const runtime = createToolRuntime();

  it('accepts valid JSON and applies documented defaults', () => {
    const result = runtime.validateArguments('source.search', '{"query":"budget"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toMatchObject({ query: 'budget', limit: 5 });
    }
    const read = runtime.validateArguments('source.read', '{"sourceId":"' + SOURCE_ID_A + '","version":1}');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.args.maxChars).toBe(8000);
  });

  it('rejects malformed, incomplete and empty streaming JSON', () => {
    for (const raw of ['', '   ', '{', '{"query":', '{"query":"x"', 'not json', '{"query":"x"} trailing']) {
      const result = runtime.validateArguments('source.search', raw);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects non-object roots and structurally hostile arguments', () => {
    for (const raw of ['[]', '"text"', '42', 'null']) {
      expect(runtime.validateArguments('source.list', raw).ok).toBe(false);
    }
    const polluted = runtime.validateArguments('source.search', '{"query":"x","__proto__":{"bad":1}}');
    expect(polluted.ok).toBe(false);
    if (!polluted.ok) expect(polluted.error).toContain('forbidden property');
    const deep = JSON.stringify({ query: 'x', extra: JSON.parse('{"a":1}') });
    expect(runtime.validateArguments('source.search', deep).ok).toBe(false);
  });

  it('rejects unknown top-level and nested keys (no silent stripping)', () => {
    const unknownTop = runtime.validateArguments('source.search', '{"query":"x","evil":true}');
    expect(unknownTop.ok).toBe(false);
    if (!unknownTop.ok) expect(unknownTop.error).toContain('unknown property "evil"');

    const unknownNested = runtime.validateArguments(
      'data.transform',
      JSON.stringify({
        sourceId: SOURCE_ID_A,
        version: 1,
        format: 'csv',
        operations: [{ op: 'limit', count: 2, bogus: 1 }],
      }),
    );
    expect(unknownNested.ok).toBe(false);
    if (!unknownNested.ok) expect(unknownNested.error).toContain('unknown property "bogus"');

    const unknownCandidate = runtime.validateArguments(
      'artifact.validate',
      JSON.stringify({
        moduleId: MODULE_ID,
        baseVersionId: null,
        candidate: { kind: 'markdown', sections: [{ id: 'a', title: 'A', markdown: 'x', extra: 1 }] },
        evidenceRefs: [],
      }),
    );
    expect(unknownCandidate.ok).toBe(false);
    if (!unknownCandidate.ok) expect(unknownCandidate.error).toContain('unknown property "extra"');
  });

  it('rejects schema violations with readable paths', () => {
    const result = runtime.validateArguments('source.read', '{"sourceId":"not-a-uuid","version":0}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('sourceId');
    const transform = runtime.validateArguments(
      'data.transform',
      JSON.stringify({ sourceId: SOURCE_ID_A, version: 1, format: 'csv', operations: [] }),
    );
    expect(transform.ok).toBe(false);
  });

  it('reports unknown tools', () => {
    const result = runtime.validateArguments('nope.tool' as ToolId, '{}');
    expect(result.ok).toBe(false);
  });
});

describe('execute guards', () => {
  function makeWorld(): TestWorld {
    const world = createTestWorld();
    world.addSource({ id: SOURCE_ID_A, name: 'a.txt', mime: 'text/plain', text: 'hello' });
    return world;
  }

  it('never executes malformed arguments', async () => {
    const world = makeWorld();
    const runtime = createToolRuntime();
    const result = await runtime.execute('source.read', '{"sourceId":', world.ctx());
    expect(result.status).toBe('failed');
    expect(failureOf(result).code).toBe('invalid_arguments');
    expect(result.trust).toBe('untrusted_content');
    expect(world.calls.getSource).toBe(0);
  });

  it('never executes unknown keys', async () => {
    const world = makeWorld();
    const runtime = createToolRuntime();
    const result = await runtime.execute(
      'source.read',
      jsonArg({ sourceId: SOURCE_ID_A, version: 1, maxChars: 100, scope: 'sources:read' }),
      world.ctx(),
    );
    expect(failureOf(result).code).toBe('invalid_arguments');
    expect(world.calls.getSource).toBe(0);
  });

  it('reports unknown tools without executing', async () => {
    const world = makeWorld();
    const runtime = createToolRuntime();
    const result = await runtime.execute('nope.tool' as ToolId, '{}', world.ctx());
    expect(failureOf(result).code).toBe('unknown_tool');
  });

  it('denies calls when a required scope is missing, and model args cannot widen scopes', async () => {
    const world = makeWorld();
    world.setGrantedScopes(['artifact:read']);
    const runtime = createToolRuntime();
    const result = await runtime.execute(
      'source.read',
      jsonArg({ sourceId: SOURCE_ID_A, version: 1, maxChars: 100 }),
      world.ctx(),
    );
    const failure = failureOf(result);
    expect(failure.code).toBe('scope_denied');
    expect(failure.details).toMatchObject({ missingScopes: ['sources:read'] });
    expect(world.calls.getSource).toBe(0);
  });

  it('normalizes successful results with hashes, byte counts and trust marker', async () => {
    const world = makeWorld();
    const runtime = createToolRuntime();
    const result = await runtime.execute('source.list', '{}', world.ctx());
    expect(result.status).toBe('succeeded');
    expect(result.trust).toBe('untrusted_content');
    expect(result.error).toBeNull();
    expect(result.resultObjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.resultBytes).toBeGreaterThan(0);
    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.toolCallId).toBe(world.toolCallId);
    expect(result.toolId).toBe('source.list');
  });

  it('enforces the timeout with a structured tool_timeout failure', async () => {
    const world = makeWorld();
    const ctx = world.ctx();
    const readDelayMs = 60;
    ctx.sources.getSource = async () => {
      await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      return null;
    };
    const runtime = createToolRuntime({ policyOverrides: { 'source.read': { timeoutMs: 10 } } });
    const startedAt = Date.now();
    const result = await runtime.execute(
      'source.read',
      jsonArg({ sourceId: SOURCE_ID_A, version: 1, maxChars: 100 }),
      ctx,
    );
    const elapsed = Date.now() - startedAt;
    expect(result.status).toBe('failed');
    const failure = failureOf(result);
    expect(failure.code).toBe('tool_timeout');
    expect(failure.retryable).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it('marks a timed-out draft-write call as outcome_unknown (effect may have happened)', async () => {
    const world = createTestWorld();
    world.addSource({ id: SOURCE_ID_A, name: 'table.csv', mime: 'text/csv', text: 'id\n1\n' });
    const ctx = world.ctx();
    ctx.objects = {
      async put() {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { hash: '0'.repeat(64), sizeBytes: 1, mime: 'text/csv' };
      },
    };
    const runtime = createToolRuntime({ policyOverrides: { 'data.transform': { timeoutMs: 10 } } });
    const result = await runtime.execute(
      'data.transform',
      jsonArg({
        sourceId: SOURCE_ID_A,
        version: 1,
        format: 'csv',
        operations: [{ op: 'limit', count: 1 }],
      }),
      ctx,
    );
    expect(result.status).toBe('outcome_unknown');
    expect(failureOf(result).code).toBe('tool_timeout');
    expect(failureOf(result).retryable).toBe(true);
  });

  it('honors caller abort signals before starting work', async () => {
    const world = makeWorld();
    const runtime = createToolRuntime();
    world.abortController.abort();
    const result = await runtime.execute(
      'source.read',
      jsonArg({ sourceId: SOURCE_ID_A, version: 1, maxChars: 100 }),
      world.ctx(),
    );
    expect(failureOf(result).code).toBe('aborted');
    expect(world.calls.getSource).toBe(0);
  });

  it('enforces maxResultBytes', async () => {
    const world = makeWorld();
    world.addSource({ id: SOURCE_ID_B, name: 'b.txt', mime: 'text/plain', text: 'world' });
    const runtime = createToolRuntime({ policyOverrides: { 'source.list': { maxResultBytes: 40 } } });
    const result = await runtime.execute('source.list', '{}', world.ctx());
    expect(failureOf(result).code).toBe('result_too_large');
    expect(result.resultBytes).toBe(0);
  });

  it('keeps policy overrides validated', () => {
    expect(() => createToolRuntime({ policyOverrides: { 'source.read': { timeoutMs: 0 } } })).toThrow();
    expect(() => createToolRuntime({ policyOverrides: { 'source.read': { requiredScopes: ['invalid:scope' as never] } } })).toThrow();
  });

  it('uses only structured tool error codes', async () => {
    const world = makeWorld();
    const runtime = createToolRuntime();
    const result = await runtime.execute(
      'source.read',
      jsonArg({ sourceId: '99999999-9999-4999-8999-999999999999' as SourceId, version: 1, maxChars: 100 }),
      world.ctx(),
    );
    const failure = failureOf(result);
    expect(TOOL_ERROR_CODES).toContain(failure.code as (typeof TOOL_ERROR_CODES)[number]);
  });

  it('returns contract-shaped results for every tool path', async () => {
    const world = makeWorld();
    world.addSource({
      id: SOURCE_ID_B,
      name: 'table.csv',
      mime: 'text/csv',
      text: 'id,name\n1,A\n',
    });
    const runtime = createToolRuntime();
    const listResult = succeededData<unknown>(await runtime.execute('source.list', '{}', world.ctx()));
    expect(listResult).toBeDefined();
    const search = succeededData<unknown>(
      await runtime.execute('source.search', jsonArg({ query: 'hello' }), world.ctx()),
    );
    expect(search).toBeDefined();
    const read = succeededData<unknown>(
      await runtime.execute(
        'source.read',
        jsonArg({ sourceId: SOURCE_ID_B, version: 1, locator: { kind: 'csv_rows', rowNumbers: [1] }, maxChars: 100 }),
        world.ctx(),
      ),
    );
    expect(read).toBeDefined();
  });
});

describe('argument validation result typing', () => {
  it('validateArguments returns JsonObject args on success', () => {
    const runtime = createToolRuntime();
    const result = runtime.validateArguments('artifact.read', `{"moduleId":"${MODULE_ID}","versionId":null}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ moduleId: MODULE_ID, versionId: null });
    }
  });

  it('executes with defaults applied for omitted optional arguments', async () => {
    const world = createTestWorld();
    world.addSource({ id: SOURCE_ID_A, name: 'a.txt', mime: 'text/plain', text: 'hello world' });
    const runtime = createToolRuntime();
    const result: ToolResult = await runtime.execute('source.search', '{"query":"hello"}', world.ctx());
    expect(result.status).toBe('succeeded');
  });
});
