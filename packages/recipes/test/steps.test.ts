/**
 * Remaining DSL step coverage and defensive checks: source.search evidence
 * persistence, artifact.read content chaining, cache honesty, scope permission,
 * first-step binding order and defensive validation boundaries.
 */
import { describe, expect, it } from 'vitest';
import {
  ArtifactIdSchema,
  ArtifactModuleSchema,
  ArtifactVersionIdSchema,
  ArtifactVersionSchema,
  ModuleContentSchema,
  ModuleIdSchema,
  RecipeSchema,
  RecipeStepSchema,
  type ArtifactModule,
  type ArtifactVersion,
  type JsonObject,
} from '@ca/contracts';
import { contentHash, sha256Hex } from '@ca/tools';
import { RecipeExtractionError, buildRecipeFingerprint, extractRecipeCandidate } from '../src';
import {
  BASE_PINS,
  CLEANING_OPERATIONS,
  CREATED_AT,
  FakeRecipeCache,
  LEGACY_SOURCE_ID,
  TASK_ID,
  cleaningSteps,
  makeCleaningRecipe,
  makeHarness,
  makeRunContext,
  makeSyntheticTrace,
  sourceInputs,
  uuidFromSeed,
} from './helpers';

const ARTIFACT_ID = ArtifactIdSchema.parse(uuidFromSeed('artifact:upstream'));
const ARTIFACT_MODULE_ID = ModuleIdSchema.parse(uuidFromSeed('module:upstream'));
const ARTIFACT_VERSION_ID = ArtifactVersionIdSchema.parse(uuidFromSeed('version:upstream'));
const MISSING_MODULE_ID = ModuleIdSchema.parse(uuidFromSeed('module:missing'));

function makeArtifactFixture(): { module: ArtifactModule; version: ArtifactVersion } {
  const content = {
    kind: 'csv' as const,
    columns: [
      { key: 'system_id', label: 'system_id', type: 'string' as const, required: false },
      { key: 'name', label: 'name', type: 'string' as const, required: false },
    ],
    rows: [
      { system_id: 'U-1', name: ' A ' },
      { system_id: 'U-2', name: 'B' },
    ],
  };
  const module = ArtifactModuleSchema.parse({
    id: ARTIFACT_MODULE_ID,
    artifactId: ARTIFACT_ID,
    title: '上游清洗成果',
    kind: 'csv',
    order: 0,
    dependencies: [],
    acceptanceCriteria: [],
    status: 'accepted',
    blockedFrom: null,
    acceptedVersionId: ARTIFACT_VERSION_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const version = ArtifactVersionSchema.parse({
    id: ARTIFACT_VERSION_ID,
    artifactId: ARTIFACT_ID,
    moduleId: ARTIFACT_MODULE_ID,
    moduleKind: 'csv',
    contentHash: contentHash(content),
    content,
    parentId: null,
    baseVersionId: null,
    sourceRunId: null,
    patchId: null,
    validationReportId: null,
    acceptedBy: 'test-user',
    acceptedAt: CREATED_AT,
    note: '',
    restoredFromVersionId: null,
  });
  return { module, version };
}

function makeArtifactReadRecipe(moduleId = ARTIFACT_MODULE_ID, versionId: string | null = ARTIFACT_VERSION_ID) {
  const steps = [
    RecipeStepSchema.parse({
      id: 'a1',
      kind: 'artifact.read',
      title: '读取上游成果',
      module: { kind: 'literal', value: { moduleId, versionId } },
    }),
    RecipeStepSchema.parse({
      id: 'a2',
      kind: 'data.transform',
      title: '规范化名称',
      input: { kind: 'previous_step' },
      format: 'csv',
      operations: [
        { op: 'normalize', column: 'name', transforms: ['trim'] },
        { op: 'require', columns: ['system_id'] },
      ],
      outputName: 'upstream.csv',
    }),
    RecipeStepSchema.parse({
      id: 'a3',
      kind: 'emit_artifact',
      title: '产出清洗副本',
      moduleKind: 'csv',
      input: { kind: 'previous_step' },
      artifactName: 'upstream.csv',
    }),
  ];
  const { fingerprintInputs, fingerprint } = buildRecipeFingerprint({ steps }, BASE_PINS);
  return RecipeSchema.parse({
    id: uuidFromSeed('recipe:artifact-read'),
    version: 1,
    name: '基于上游成果的清洗副本',
    description: '',
    kind: 'deterministic',
    status: 'validated',
    dslVersion: '1',
    inputParameters: [
      {
        name: 'label',
        type: 'string',
        required: false,
        description: '仅用于说明',
        pattern: null,
        enumValues: [],
        acceptsMime: [],
        defaultValue: 'demo',
      },
    ],
    steps,
    outputArtifactKind: 'csv',
    validators: [],
    permissions: {
      tools: ['artifact.read', 'data.transform'],
      scopes: ['artifact:read', 'data:transform'],
      allowModelCalls: false,
      maxModelCallsPerRun: 0,
    },
    budget: { maxModelCalls: 0, maxToolCalls: 10, maxRuntimeMs: 10_000 },
    testCases: [
      {
        id: 'original',
        label: '原始输入',
        kind: 'original',
        inputs: { label: 'demo' },
        expectation: 'accept',
        status: 'untested',
        detail: '',
        normalizedOutputHash: null,
        lastRunAt: null,
      },
    ],
    fingerprint,
    fingerprintInputs,
    sourceRunId: uuidFromSeed('run:artifact-read'),
    sourceTaskId: TASK_ID,
    sourceModuleId: null,
    applicability: '',
    staleReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function makeSearchRecipe() {
  const steps = [
    RecipeStepSchema.parse({
      id: 'q1',
      kind: 'source.search',
      title: '搜索系统编号',
      source: { kind: 'parameter', name: 'source' },
      query: 'S-1001',
      limit: 3,
    }),
    RecipeStepSchema.parse({
      id: 'q2',
      kind: 'emit_artifact',
      title: '产出搜索结果',
      moduleKind: 'json',
      input: { kind: 'previous_step' },
      artifactName: 'search.json',
    }),
  ];
  const { fingerprintInputs, fingerprint } = buildRecipeFingerprint({ steps }, BASE_PINS);
  return RecipeSchema.parse({
    id: uuidFromSeed('recipe:search'),
    version: 1,
    name: '资料检索配方',
    description: '',
    kind: 'deterministic',
    status: 'validated',
    dslVersion: '1',
    inputParameters: [
      {
        name: 'source',
        type: 'source',
        required: true,
        description: '',
        pattern: null,
        enumValues: [],
        acceptsMime: [],
      },
    ],
    steps,
    outputArtifactKind: 'json',
    validators: [],
    permissions: {
      tools: ['source.search'],
      scopes: ['sources:read'],
      allowModelCalls: false,
      maxModelCallsPerRun: 0,
    },
    budget: { maxModelCalls: 0, maxToolCalls: 10, maxRuntimeMs: 10_000 },
    testCases: [
      {
        id: 'original',
        label: '原始输入',
        kind: 'original',
        inputs: sourceInputs(LEGACY_SOURCE_ID),
        expectation: 'accept',
        status: 'untested',
        detail: '',
        normalizedOutputHash: null,
        lastRunAt: null,
      },
    ],
    fingerprint,
    fingerprintInputs,
    sourceRunId: uuidFromSeed('run:search'),
    sourceTaskId: TASK_ID,
    sourceModuleId: null,
    applicability: '',
    staleReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

describe('source.search step', () => {
  it('produces deterministic hits and persists real evidence spans with quote hashes', async () => {
    const harness = makeHarness();
    const recipe = makeSearchRecipe();
    const result = await harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));

    expect(result.toolCalls).toBe(1);
    expect(result.llmCalls).toBe(0);
    expect(result.outputs[0]!.moduleKind).toBe('json');
    const stored = harness.objects.objects.get(result.outputs[0]!.objectHash);
    expect(stored).toBeDefined();
    const content = ModuleContentSchema.parse(JSON.parse(new TextDecoder().decode(stored!.bytes)));
    expect(content.kind).toBe('json');
    if (content.kind !== 'json') throw new Error('expected json content');
    const value = content.value as { query: string; hits: Array<{ spanId: string; excerpt: string; quoteHash: string }> };
    expect(value.query).toBe('S-1001');
    expect(value.hits.length).toBeGreaterThan(0);
    expect(value.hits[0]!.excerpt).toContain('S-1001');
    expect(value.hits[0]!.quoteHash).toBe(sha256Hex(value.hits[0]!.excerpt));

    // Evidence is persisted via the source port (never fabricated locally only).
    expect(harness.reader.saveSpanCalls).toBeGreaterThan(0);
    const span = harness.reader.spans[0]!;
    expect(span.id).toBe(value.hits[0]!.spanId);
    expect(span.quoteHash).toBe(sha256Hex(span.excerpt));
    expect(span.sourceId).toBe(LEGACY_SOURCE_ID);
    expect(span.locator.kind).toBe('text_lines');
  });
});

describe('artifact.read step', () => {
  it('reads the accepted upstream content, transforms it and emits a new output', async () => {
    const harness = makeHarness();
    const fixture = makeArtifactFixture();
    harness.artifacts.addVersion(fixture.module, fixture.version);
    const recipe = makeArtifactReadRecipe();

    const result = await harness.runtime.run(recipe, makeRunContext({ label: 'demo' }));

    expect(result.toolCalls).toBe(2); // artifact.read + data.transform
    expect(result.outputs[0]!.rowCount).toBe(2);
    const content = ModuleContentSchema.parse(
      JSON.parse(new TextDecoder().decode(harness.objects.objects.get(result.outputs[0]!.objectHash)!.bytes)),
    );
    expect(content.kind).toBe('csv');
    if (content.kind === 'csv') {
      expect(content.rows[0]!.name).toBe('A'); // normalized by the transform
      expect(content.rows[1]!.name).toBe('B');
    }
    expect(harness.artifacts.calls).toContain(`getVersion:${ARTIFACT_VERSION_ID}`);
  });

  it('fails explicitly when the referenced module does not exist', async () => {
    const harness = makeHarness();
    const recipe = makeArtifactReadRecipe(MISSING_MODULE_ID, null);
    await expect(harness.runtime.run(recipe, makeRunContext({ label: 'demo' }))).rejects.toMatchObject({
      message: expect.stringMatching(/does not exist/),
    });
    expect(harness.objects.puts).toHaveLength(0);
  });
});

describe('defensive runtime boundaries', () => {
  it('refuses to report a cache hit for a corrupt cache entry', async () => {
    const cache = new FakeRecipeCache();
    cache.forcedEntry = { outputs: [], normalizedOutputHash: 'not-a-hash', createdAt: CREATED_AT };
    const harness = makeHarness({ cache });
    const recipe = makeCleaningRecipe({ kind: 'cached_snapshot', budget: { maxModelCalls: 1 } });

    const result = await harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(result.cacheState).toBe('executed');
    expect(result.outputs[0]!.rowCount).toBe(22);
  });

  it('falls back to real execution when the cache port fails', async () => {
    const cache = new FakeRecipeCache();
    cache.failGets = true;
    const harness = makeHarness({ cache });
    const recipe = makeCleaningRecipe({ kind: 'cached_snapshot', budget: { maxModelCalls: 1 } });
    const result = await harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(result.cacheState).toBe('executed');
    expect(result.outputs[0]!.rowCount).toBe(22);
  });

  it('accepts a bare source id string as a source parameter value', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    const preflight = await harness.runtime.preflightInputs(
      recipe,
      { source: LEGACY_SOURCE_ID } as unknown as JsonObject,
      { taskId: TASK_ID },
    );
    expect(preflight.ok).toBe(true);
    expect(preflight.sourceBindings.source).toEqual({ sourceId: LEGACY_SOURCE_ID, version: 1 });
  });

  it('enforces declared scopes when a recipe narrows them', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe({ permissions: { tools: ['source.read', 'data.profile', 'data.transform'], scopes: ['sources:read'] } });
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'dsl_invalid',
      message: expect.stringMatching(/needs scope "data:transform"/),
    });
  });

  it('refuses a first step that binds previous_step', async () => {
    const harness = makeHarness();
    const steps = cleaningSteps();
    steps[0] = RecipeStepSchema.parse({
      id: 's1',
      kind: 'data.transform',
      title: '无来源转换',
      input: { kind: 'previous_step' },
      format: 'csv',
      operations: [{ op: 'require', columns: ['system_id'] }],
      outputName: 'x.csv',
    });
    const recipe = makeCleaningRecipe({ steps });
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'dsl_invalid',
      message: expect.stringMatching(/previous_step/),
    });
  });

  it('refuses a recipe whose stored fingerprint was tampered with', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    const tampered = RecipeSchema.parse({ ...recipe, fingerprint: sha256Hex('tampered') });
    await expect(harness.runtime.run(tampered, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)))).rejects.toMatchObject({
      code: 'recipe_stale',
      message: expect.stringMatching(/stored fingerprint/),
    });
  });

  it('refuses validate() with an empty or oversized test-case list', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    await expect(harness.runtime.validate(recipe, [], {})).rejects.toMatchObject({ code: 'invalid_input' });
    const tooMany = Array.from({ length: 17 }, (_value, index) => ({
      ...recipe.testCases[0]!,
      id: `case-${index}`,
    }));
    await expect(harness.runtime.validate(recipe, tooMany, {})).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects extraction when the folded path exceeds the bounded DSL', () => {
    const trace = makeSyntheticTrace();
    trace.steps = Array.from({ length: 34 }, (_value, index) => ({
      kind: 'tool',
      title: `转换 ${index}`,
      toolId: 'data.transform',
      inputSummary: JSON.stringify({ format: 'csv', operations: CLEANING_OPERATIONS, outputName: `step-${index}.csv` }),
      outputSummary: '{}',
      outputObjectHash: sha256Hex(`output-${index}`),
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
    }));
    let captured: unknown = null;
    try {
      extractRecipeCandidate(trace, { name: '过长路径', kind: 'deterministic', description: '', applicability: '' });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(RecipeExtractionError);
    expect((captured as RecipeExtractionError).code).toBe('trace_too_long');
  });
});
