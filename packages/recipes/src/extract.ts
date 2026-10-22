/**
 * Server-side recipe extraction: turn a successful run trace into a bounded,
 * parameterized `RecipeProposalInput` (design 13.3).
 *
 * A recipe is not a chat transcript:
 * - sources become typed `source` parameters (never inlined file content);
 * - only replayable deterministic steps are kept (exploratory search/validation
 *   chatter is dropped and counted, not silently replayed);
 * - transform operators are recovered from the structured `inputSummary` of
 *   recorded tool calls, never invented from prose;
 * - outputs/model answers are NEVER embedded: the proposal contains no cells,
 *   text or object hashes from the historical result;
 * - when the trace lacks the structure needed to rebuild a step, extraction
 *   fails explicitly with `RecipeExtractionError` instead of fabricating a
 *   plausible-looking step.
 */
import {
  LIMITS,
  RecipeProposalInputSchema,
  RecipeStepSchema,
  TransformOperationSchema,
  type JsonObject,
  type RecipeParameter,
  type RecipeProposalInput,
  type RecipeStep,
  type RecipeTestCase,
  type TransformOperation,
} from '@ca/contracts';
import { RecipeExtractionError } from './errors';
import type { RecipeTrace, RecipeTraceStep } from './types';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ExtractRecipeOptions {
  name: string;
  kind: 'deterministic' | 'llm_assisted' | 'cached_snapshot';
  description: string;
  applicability: string;
}

const DETERMINISTIC_STEP_KINDS = new Set(['source.read', 'source.search', 'data.profile', 'data.transform', 'artifact.read']);
const MODEL_STEP_KINDS = new Set(['llm.step', 'model', 'model_step']);
const VALIDATION_CHATTER_KINDS = new Set(['validate', 'validation', 'repair', 'commit', 'context']);

interface StepSummary {
  value: JsonObject;
}

function normalizeKind(step: RecipeTraceStep): string {
  const byKind = step.kind.trim().toLowerCase();
  if (DETERMINISTIC_STEP_KINDS.has(byKind) || MODEL_STEP_KINDS.has(byKind) || VALIDATION_CHATTER_KINDS.has(byKind)) {
    return byKind;
  }
  const byTool = (step.toolId ?? '').trim().toLowerCase();
  if (byTool.length > 0) return byTool;
  return byKind;
}

function parseStepSummary(raw: string): StepSummary | null {
  const text = raw.trim();
  if (text.length === 0 || !text.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { value: parsed as JsonObject };
  } catch {
    return null;
  }
}

function describeStep(step: RecipeTraceStep, index: number): string {
  return `trace step ${index + 1} "${step.title || step.kind}"`;
}

function artifactExtension(moduleKind: 'markdown' | 'json' | 'csv'): string {
  switch (moduleKind) {
    case 'csv':
      return 'csv';
    case 'json':
      return 'json';
    case 'markdown':
      return 'md';
  }
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : fallback;
}

function boundedText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Turn a finished run trace into a parameterized candidate recipe proposal.
 *
 * Throws `RecipeExtractionError` when the trace is not structurally sufficient.
 */
export function extractRecipeCandidate(trace: RecipeTrace, options: ExtractRecipeOptions): RecipeProposalInput {
  if (!Array.isArray(trace.steps) || trace.steps.length === 0) {
    throw new RecipeExtractionError('trace_insufficient', 'trace has no steps; nothing can be extracted', [
      'the successful run must record at least one finalized step',
    ]);
  }
  if (!Array.isArray(trace.sourceRefs) || trace.sourceRefs.length === 0) {
    throw new RecipeExtractionError('trace_insufficient', 'trace has no source references; inputs cannot be parameterized', [
      'a reusable recipe needs at least one parameterizable source input',
    ]);
  }
  if (trace.sourceRefs.length > 32) {
    throw new RecipeExtractionError('trace_insufficient', 'trace references more than 32 sources', [
      `found ${trace.sourceRefs.length} source references, the DSL allows at most 32 input parameters`,
    ]);
  }

  // ----- input parameters: one typed source parameter per bound source -----
  const sourceParamNames: string[] = [];
  const inputParameters: RecipeParameter[] = [];
  const originalInputs: JsonObject = {};
  trace.sourceRefs.forEach((ref, index) => {
    const name = `source_${index + 1}`;
    sourceParamNames.push(name);
    const acceptsMime =
      trace.moduleKind === 'csv'
        ? ['text/csv']
        : trace.moduleKind === 'json'
          ? ['application/json']
          : [];
    inputParameters.push({
      name,
      type: 'source',
      required: true,
      description: `成功运行 ${trace.runId} 使用的输入资料（版本 ${ref.version}）；复用时需重新绑定新版来源`,
      pattern: null,
      enumValues: [],
      acceptsMime,
    });
    originalInputs[name] = { sourceId: ref.sourceId, version: ref.version };
  });

  // ----- steps: deterministic replay only -----
  const steps: RecipeStep[] = [];
  let droppedChatter = 0;
  let droppedSourceReads = 0;
  let llmStepCount = 0;

  // One explicit source.read per parameter so the replay pipeline starts from a
  // declared, bounded read instead of an implicit source side channel.
  sourceParamNames.forEach((name, index) => {
    steps.push(
      RecipeStepSchema.parse({
        id: `s${steps.length + 1}`,
        kind: 'source.read',
        title: `读取输入资料 ${index + 1}（${name}）`,
        source: { kind: 'parameter', name },
        locator: null,
        maxChars: 8_000,
      }),
    );
  });

  for (const [index, traceStep] of trace.steps.entries()) {
    const kind = normalizeKind(traceStep);
    if (MODEL_STEP_KINDS.has(kind)) {
      if (options.kind !== 'llm_assisted') {
        throw new RecipeExtractionError(
          'trace_not_deterministic',
          `trace contains a model step (${describeStep(traceStep, index)}) but the requested recipe kind is "${options.kind}"`,
          ['use kind "llm_assisted" to extract a workflow that still calls the model'],
        );
      }
      steps.push(extractLlmStep(traceStep, index, steps.length));
      llmStepCount += 1;
      continue;
    }
    if (kind === 'source.read' || kind === 'source.search' || kind === 'source_search') {
      // Source reads are re-derived from the parameter list above.
      droppedSourceReads += 1;
      continue;
    }
    if (VALIDATION_CHATTER_KINDS.has(kind)) {
      // Validation/repair chatter is run-specific noise: replay re-validates.
      droppedChatter += 1;
      continue;
    }
    if (kind === 'data.transform') {
      steps.push(extractTransformStep(traceStep, index, steps.length, trace.moduleKind));
      continue;
    }
    if (kind === 'data.profile') {
      steps.push(
        RecipeStepSchema.parse({
          id: `s${steps.length + 1}`,
          kind: 'data.profile',
          title: boundedText(traceStep.title || '数据画像', 200),
          input: { kind: 'previous_step' },
        }),
      );
      continue;
    }
    if (kind === 'artifact.read') {
      steps.push(extractArtifactReadStep(traceStep, index, steps.length));
      continue;
    }
    // Unknown/exploratory kind: drop it, but count it so the applicability text
    // is honest about what was left out.
    droppedChatter += 1;
  }

  if (llmStepCount === 0 && options.kind === 'llm_assisted') {
    throw new RecipeExtractionError(
      'trace_not_deterministic',
      'the requested kind is "llm_assisted" but the trace contains no model step',
      ['extract as "deterministic" instead, or include a run that actually called the model'],
    );
  }
  const deterministicStepCount = steps.filter((step) => step.kind === 'data.transform').length;
  if (deterministicStepCount === 0) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      'trace contains no structured data.transform step; there is no replayable deterministic path to extract',
      [
        'a cleaning/reusable recipe needs recorded transform operations (inputSummary JSON with an "operations" array)',
        'saving only an artifact or a prose answer is not enough for an executable recipe',
      ],
    );
  }

  // ----- emit the final artifact (kind comes from the run, not invented) -----
  const extension = artifactExtension(trace.moduleKind);
  const baseName = slugify(options.name, 'recipe-output');
  steps.push(
    RecipeStepSchema.parse({
      id: `s${steps.length + 1}`,
      kind: 'emit_artifact',
      title: `产出 ${trace.moduleKind} 成果`,
      moduleKind: trace.moduleKind,
      input: { kind: 'previous_step' },
      artifactName: `${baseName}.${extension}`,
    }),
  );
  if (steps.length > LIMITS.maxRecipeSteps) {
    throw new RecipeExtractionError(
      'trace_too_long',
      `extracted path has ${steps.length} steps but the DSL allows at most ${LIMITS.maxRecipeSteps}`,
      ['the run explored too many tool calls to fold into one bounded recipe; keep the successful path shorter'],
    );
  }

  // ----- test case placeholders (never generated outputs) -----
  const testCases: RecipeTestCase[] = [
    {
      id: 'original-1',
      label: '原始输入（提取自来源运行）',
      kind: 'original',
      inputs: originalInputs,
      expectation: 'accept',
      status: 'untested',
      detail: `placeholder from run ${trace.runId}; the original bound source version must still be available`,
      normalizedOutputHash: null,
      lastRunAt: null,
    },
    {
      id: 'invalid-1',
      label: '无效输入（缺少必填来源绑定）',
      kind: 'invalid',
      // An empty input object deterministically fails the required source
      // parameter check; no historical answer is embedded anywhere.
      inputs: {},
      expectation: 'reject',
      status: 'untested',
      detail:
        'placeholder: expects rejection because the required source parameter is missing; replace with a real out-of-range sample',
      normalizedOutputHash: null,
      lastRunAt: null,
    },
  ];

  const droppedNotes: string[] = [];
  if (droppedChatter > 0) droppedNotes.push(`忽略 ${droppedChatter} 个探索/校验步骤`);
  if (droppedSourceReads > 0) droppedNotes.push(`${droppedSourceReads} 个来源读取步骤已参数化`);
  const kindLabel = options.kind === 'deterministic' ? '确定性' : options.kind === 'llm_assisted' ? '模型辅助' : '缓存快照';
  const defaultApplicability = [
    `从运行 ${trace.runId} 成功路径提取的${kindLabel}配方。`,
    `输入参数：${sourceParamNames.join(', ')}；输出类型：${trace.moduleKind}。`,
    droppedNotes.length > 0 ? `${droppedNotes.join('；')}。` : '',
    '注册前需补充一个 new_valid（新有效输入）测试样例，并通过 original + new_valid + invalid 三类测试。',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  const proposal: RecipeProposalInput = {
    runId: trace.runId,
    name: boundedText(options.name, 200),
    description: boundedText(options.description, 4000),
    kind: options.kind,
    inputParameters,
    steps,
    testCases,
    applicability: boundedText(options.applicability || defaultApplicability, 2000),
  };

  const parsed = RecipeProposalInputSchema.safeParse(proposal);
  if (!parsed.success) {
    throw new RecipeExtractionError(
      'trace_invalid',
      'extracted proposal does not satisfy RecipeProposalInputSchema',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function extractTransformStep(
  traceStep: RecipeTraceStep,
  index: number,
  position: number,
  moduleKind: 'markdown' | 'json' | 'csv',
): RecipeStep {
  const summary = parseStepSummary(traceStep.inputSummary);
  if (!summary) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} is a data.transform call without a structured inputSummary JSON object`,
      [
        'expected inputSummary JSON: {"format":"csv"|"json","operations":[...],"outputName":"..."}',
        'refusing to invent transform operators from prose',
      ],
    );
  }
  const operationsRaw = summary.value.operations;
  if (!Array.isArray(operationsRaw) || operationsRaw.length === 0) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} inputSummary has no non-empty "operations" array`,
      ['the recorded tool call must contain the exact TransformOperation list so the replay is provably the same path'],
    );
  }
  const operations: TransformOperation[] = [];
  for (const [opIndex, rawOperation] of operationsRaw.entries()) {
    const parsedOperation = TransformOperationSchema.safeParse(rawOperation);
    if (!parsedOperation.success) {
      throw new RecipeExtractionError(
        'trace_insufficient',
        `${describeStep(traceStep, index)} inputSummary contains an invalid transform operation at index ${opIndex}`,
        parsedOperation.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '<op>'}: ${issue.message}`),
      );
    }
    operations.push(parsedOperation.data);
  }
  if (operations.length > 32) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} recorded ${operations.length} operations; the DSL allows at most 32 per step`,
      ['split the transform into several recorded steps instead'],
    );
  }
  if (traceStep.outputObjectHash === null || !SHA256_HEX.test(traceStep.outputObjectHash)) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} did not record a valid outputObjectHash; the transform result is not verifiable`,
      ['refusing to extract a transform whose deterministic output was not content-addressed'],
    );
  }
  const formatRaw = summary.value.format;
  let format: 'csv' | 'json';
  if (formatRaw === 'csv' || formatRaw === 'json') {
    format = formatRaw;
  } else if (moduleKind === 'json') {
    format = 'json';
  } else if (moduleKind === 'csv') {
    format = 'csv';
  } else {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} does not record a data format and the run output is ${moduleKind}`,
      ['add "format":"csv"|"json" to the recorded tool input summary'],
    );
  }
  const outputNameRaw = summary.value.outputName;
  return RecipeStepSchema.parse({
    id: `s${position + 1}`,
    kind: 'data.transform',
    title: boundedText(traceStep.title || '确定性数据转换', 200),
    input: { kind: 'previous_step' },
    format,
    operations,
    outputName:
      typeof outputNameRaw === 'string' && outputNameRaw.length > 0 ? boundedText(outputNameRaw, 200) : 'transformed.csv',
  });
}

function extractLlmStep(traceStep: RecipeTraceStep, index: number, position: number): RecipeStep {
  const summary = parseStepSummary(traceStep.inputSummary);
  if (!summary) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} is a model call without a structured inputSummary JSON object`,
      ['expected {"promptTemplateId":"...","promptVersion":"...","instruction":"...","maxOutputTokens":N}'],
    );
  }
  const promptTemplateId = summary.value.promptTemplateId;
  const promptVersion = summary.value.promptVersion;
  if (typeof promptTemplateId !== 'string' || promptTemplateId.length === 0) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} does not record the prompt template id it used`,
      ['a replayed model step must reference the fixed prompt template version'],
    );
  }
  if (typeof promptVersion !== 'string' || promptVersion.length === 0) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} does not record the prompt template version it used`,
    );
  }
  const instruction = typeof summary.value.instruction === 'string' ? boundedText(summary.value.instruction, 4000) : '';
  const maxOutputTokensRaw = summary.value.maxOutputTokens;
  const maxOutputTokens =
    typeof maxOutputTokensRaw === 'number' && Number.isInteger(maxOutputTokensRaw) && maxOutputTokensRaw > 0
      ? Math.min(maxOutputTokensRaw, LIMITS.maxModelOutputTokens)
      : 4096;
  return RecipeStepSchema.parse({
    id: `s${position + 1}`,
    kind: 'llm.step',
    title: boundedText(traceStep.title || '固定模型步骤', 200),
    promptTemplateId: boundedText(promptTemplateId, 100),
    promptVersion: boundedText(promptVersion, 64),
    input: { kind: 'previous_step' },
    instruction,
    maxOutputTokens,
  });
}

function extractArtifactReadStep(traceStep: RecipeTraceStep, index: number, position: number): RecipeStep {
  const summary = parseStepSummary(traceStep.inputSummary);
  if (!summary) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} is an artifact.read call without a structured inputSummary JSON object`,
      ['expected {"moduleId":"<uuid>","versionId":"<uuid>|null"}'],
    );
  }
  const moduleId = summary.value.moduleId;
  const versionId = summary.value.versionId;
  if (typeof moduleId !== 'string' || moduleId.length === 0) {
    throw new RecipeExtractionError(
      'trace_insufficient',
      `${describeStep(traceStep, index)} does not record which module it read`,
    );
  }
  return RecipeStepSchema.parse({
    id: `s${position + 1}`,
    kind: 'artifact.read',
    title: boundedText(traceStep.title || '读取上游成果', 200),
    module: {
      kind: 'literal',
      value: { moduleId, versionId: typeof versionId === 'string' ? versionId : null },
    },
  });
}

/** True when the trace can be folded into a deterministic path. */
export function traceIsDeterministic(trace: Pick<RecipeTrace, 'steps'>): boolean {
  return trace.steps.every((step) => !MODEL_STEP_KINDS.has(normalizeKind(step)));
}

/** Number of replayable tool steps kept by extraction (diagnostics/API response). */
export function countReplayableSteps(trace: Pick<RecipeTrace, 'steps'>): number {
  return trace.steps.filter((step) => {
    const kind = normalizeKind(step);
    return kind === 'data.transform' || kind === 'data.profile' || kind === 'artifact.read';
  }).length;
}
