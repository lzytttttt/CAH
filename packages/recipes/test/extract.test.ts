/**
 * Extraction tests: a run trace is folded into a bounded, parameterized recipe
 * proposal — never a chat transcript, never with historical answers embedded.
 * The extracted proposal is also executed end-to-end to prove it is replayable.
 */
import { describe, expect, it } from 'vitest';
import {
  RecipeExtractionError,
  buildRecipeFingerprint,
  countReplayableSteps,
  evaluateRecipeStaleness,
  extractRecipeCandidate,
  traceIsDeterministic,
  type ExtractRecipeOptions,
  type RecipeProposalInput,
} from '../src';
import { RecipeSchema, TransformOperationSchema, recipeStepOrderErrors, type Recipe } from '@ca/contracts';
import { sha256Hex } from '@ca/tools';
import {
  BASE_PINS,
  CLEANING_OPERATIONS,
  CREATED_AT,
  LEGACY_SOURCE_ID,
  RECIPE_ID,
  TASK_ID,
  makeHarness,
  makeRunContext,
  makeSyntheticTrace,
} from './helpers';

const BASE_OPTIONS: ExtractRecipeOptions = {
  name: '清理存量系统',
  kind: 'deterministic',
  description: '从成功支线提取的确定性清洗路径',
  applicability: '',
};

function captureExtractionError(run: () => unknown): RecipeExtractionError {
  try {
    run();
  } catch (error) {
    if (error instanceof RecipeExtractionError) return error;
    throw error;
  }
  throw new Error('expected the extraction to fail, but it returned a proposal');
}

const TIMESTAMP = '2026-01-01T00:00:00.000Z';

function modelTraceStep(promptTemplateId = 'executor.v1'): import('../src').RecipeTraceStep {
  return {
    kind: 'llm.step',
    title: '生成说明',
    toolId: null,
    inputSummary: JSON.stringify({ promptTemplateId, promptVersion: 'executor.v1', instruction: '写说明', maxOutputTokens: 256 }),
    outputSummary: '模型输出文本',
    outputObjectHash: null,
    startedAt: TIMESTAMP,
    finishedAt: TIMESTAMP,
  };
}

function recipeFromProposal(proposal: RecipeProposalInput): Recipe {
  const { fingerprintInputs, fingerprint } = buildRecipeFingerprint({ steps: proposal.steps }, BASE_PINS);
  return RecipeSchema.parse({
    id: RECIPE_ID,
    version: 1,
    name: proposal.name,
    description: proposal.description,
    kind: proposal.kind,
    status: 'validated',
    dslVersion: '1',
    inputParameters: proposal.inputParameters,
    steps: proposal.steps,
    outputArtifactKind: 'csv',
    validators: [],
    permissions: {
      tools: ['source.read', 'data.profile', 'data.transform'],
      scopes: ['sources:read', 'data:profile', 'data:transform'],
      allowModelCalls: false,
      maxModelCallsPerRun: 0,
    },
    budget: { maxModelCalls: 0, maxToolCalls: 10, maxRuntimeMs: 10_000 },
    testCases: proposal.testCases,
    fingerprint,
    fingerprintInputs,
    sourceRunId: proposal.runId,
    sourceTaskId: TASK_ID,
    sourceModuleId: null,
    applicability: proposal.applicability,
    staleReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

describe('extractRecipeCandidate', () => {
  it('builds a bounded parameterized proposal from a real-shaped deterministic trace', () => {
    const trace = makeSyntheticTrace();
    const proposal = extractRecipeCandidate(trace, BASE_OPTIONS);

    expect(proposal.runId).toBe(trace.runId);
    expect(proposal.kind).toBe('deterministic');
    expect(proposal.name).toBe('清理存量系统');

    // Sources are parameters, not inlined file content.
    expect(proposal.inputParameters).toHaveLength(1);
    expect(proposal.inputParameters[0]).toMatchObject({
      name: 'source_1',
      type: 'source',
      required: true,
      acceptsMime: ['text/csv'],
    });

    // Replayable steps only; validation chatter and exploratory reads are dropped.
    expect(proposal.steps[0]!.kind).toBe('source.read');
    expect(proposal.steps.some((step) => step.kind === 'data.profile')).toBe(true);
    const transform = proposal.steps.find((step) => step.kind === 'data.transform')!;
    expect(transform.kind).toBe('data.transform');
    if (transform.kind === 'data.transform') {
      expect(transform.operations).toEqual(CLEANING_OPERATIONS.map((operation) => TransformOperationSchema.parse(operation)));
      expect(transform.format).toBe('csv');
      expect(transform.outputName).toBe('cleaned.csv');
    }
    expect(proposal.steps.some((step) => step.kind === 'validate')).toBe(false);
    expect(proposal.steps.at(-1)!.kind).toBe('emit_artifact');
    const emit = proposal.steps.at(-1)!;
    if (emit.kind === 'emit_artifact') {
      expect(emit.moduleKind).toBe('csv');
      expect(emit.artifactName).toMatch(/\.csv$/);
    }
    expect(proposal.steps.map((step) => step.id)).toEqual(proposal.steps.map((_step, index) => `s${index + 1}`));
    expect(recipeStepOrderErrors(proposal.steps)).toEqual([]);

    // Historical answers/results are never embedded as constants.
    const serialized = JSON.stringify(proposal);
    expect(serialized).not.toContain('S-1001');
    expect(serialized).not.toContain('ERP 财务核心');
    expect(serialized).not.toContain(sha256Hex('synthetic-transform-output'));

    // Test cases: original from the trace + a deterministic invalid placeholder.
    const original = proposal.testCases.find((testCase) => testCase.kind === 'original')!;
    expect(original.expectation).toBe('accept');
    expect(original.inputs).toMatchObject({ source_1: { sourceId: LEGACY_SOURCE_ID, version: 1 } });
    const invalid = proposal.testCases.find((testCase) => testCase.kind === 'invalid')!;
    expect(invalid.expectation).toBe('reject');
    expect(invalid.inputs).toEqual({});
    expect(proposal.applicability).toMatch(/new_valid/);
  });

  it('produces a proposal that actually replays 24 -> 22 rows with zero LLM calls', async () => {
    const harness = makeHarness();
    const proposal = extractRecipeCandidate(makeSyntheticTrace(), BASE_OPTIONS);
    const recipe = recipeFromProposal(proposal);
    expect(evaluateRecipeStaleness(recipe, BASE_PINS).stale).toBe(false);

    const result = await harness.runtime.run(
      recipe,
      makeRunContext({ source_1: { sourceId: LEGACY_SOURCE_ID, version: 1 } }),
    );
    expect(result.llmCalls).toBe(0);
    expect(result.toolCalls).toBe(3); // source.read + data.profile + data.transform
    expect(result.outputs[0]!.rowCount).toBe(22);
    expect(harness.modelCalls).toHaveLength(0);
    expect(harness.reader.reads.some((read) => read.sourceId === LEGACY_SOURCE_ID)).toBe(true);
  });

  it('refuses traces that lack structured transform operations instead of inventing steps', () => {
    const noOperations = makeSyntheticTrace();
    noOperations.steps[2] = { ...noOperations.steps[2]!, inputSummary: JSON.stringify({ format: 'csv' }) };
    const missingOps = captureExtractionError(() => extractRecipeCandidate(noOperations, BASE_OPTIONS));
    expect(missingOps.code).toBe('trace_insufficient');
    expect(missingOps.message).toMatch(/operations/);

    const proseOnly = makeSyntheticTrace();
    proseOnly.steps[2] = { ...proseOnly.steps[2]!, inputSummary: 'renamed the columns and removed duplicates' };
    expect(captureExtractionError(() => extractRecipeCandidate(proseOnly, BASE_OPTIONS)).code).toBe('trace_insufficient');

    const invalidOps = makeSyntheticTrace();
    invalidOps.steps[2] = {
      ...invalidOps.steps[2]!,
      inputSummary: JSON.stringify({ format: 'csv', operations: [{ op: 'explode' }] }),
    };
    expect(captureExtractionError(() => extractRecipeCandidate(invalidOps, BASE_OPTIONS)).code).toBe('trace_insufficient');

    const noOutputHash = makeSyntheticTrace();
    noOutputHash.steps[2] = { ...noOutputHash.steps[2]!, outputObjectHash: null };
    expect(captureExtractionError(() => extractRecipeCandidate(noOutputHash, BASE_OPTIONS)).message).toMatch(
      /outputObjectHash/,
    );

    const noSteps = captureExtractionError(() => extractRecipeCandidate(makeSyntheticTrace({ steps: [] }), BASE_OPTIONS));
    expect(noSteps.code).toBe('trace_insufficient');

    const noSources = captureExtractionError(() =>
      extractRecipeCandidate(makeSyntheticTrace({ sourceRefs: [] }), BASE_OPTIONS),
    );
    expect(noSources.code).toBe('trace_insufficient');
  });

  it('refuses to extract a deterministic recipe from a trace that used the model', () => {
    const trace = makeSyntheticTrace();
    trace.steps.push(modelTraceStep());
    const error = captureExtractionError(() => extractRecipeCandidate(trace, BASE_OPTIONS));
    expect(error.code).toBe('trace_not_deterministic');
    expect(error.message).toMatch(/model step/);

    const cached = captureExtractionError(() =>
      extractRecipeCandidate(trace, { ...BASE_OPTIONS, kind: 'cached_snapshot' }),
    );
    expect(cached.code).toBe('trace_not_deterministic');
  });

  it('extracts llm_assisted workflows with fixed prompt references', () => {
    const trace = makeSyntheticTrace();
    trace.steps.push(modelTraceStep());
    const proposal = extractRecipeCandidate(trace, { ...BASE_OPTIONS, kind: 'llm_assisted' });
    const llmStep = proposal.steps.find((step) => step.kind === 'llm.step');
    expect(llmStep).toBeDefined();
    if (llmStep && llmStep.kind === 'llm.step') {
      expect(llmStep.promptTemplateId).toBe('executor.v1');
      expect(llmStep.promptVersion).toBe('executor.v1');
      expect(llmStep.maxOutputTokens).toBe(256);
      expect(llmStep.input.kind).toBe('previous_step');
    }
    expect(proposal.steps.at(-1)!.kind).toBe('emit_artifact');

    // A trace without model steps cannot become an llm_assisted recipe.
    const noModel = captureExtractionError(() =>
      extractRecipeCandidate(makeSyntheticTrace(), { ...BASE_OPTIONS, kind: 'llm_assisted' }),
    );
    expect(noModel.code).toBe('trace_not_deterministic');
    expect(noModel.message).toMatch(/no model step/);
  });

  it('exposes deterministic-path diagnostics helpers', () => {
    const trace = makeSyntheticTrace();
    expect(traceIsDeterministic(trace)).toBe(true);
    expect(countReplayableSteps(trace)).toBe(2); // data.profile + data.transform
    const withModel = makeSyntheticTrace();
    withModel.steps.push(modelTraceStep());
    expect(traceIsDeterministic(withModel)).toBe(false);
  });
});
