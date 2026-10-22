/**
 * Shared recipe-test harness: real fixture bytes from scenarios/cognitive-atrium
 * (read-only), deterministic fake ports and a cleaning recipe that mirrors
 * field-mapping.json. Nothing here writes into the fixtures: the runtime only
 * ever reads source bytes through the injected SourceReaderPort.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RecipeSchema,
  RecipeStepSchema,
  SourceIdSchema,
  SourceItemSchema,
  RunIdSchema,
  TaskIdSchema,
  RecipeIdSchema,
  ModuleIdSchema,
  type JsonObject,
  type ModuleId,
  type Recipe,
  type RecipeStep,
  type RecipeTestCase,
  type RunId,
  type SourceId,
  type SourceItem,
  type SourceSpan,
  type TaskId,
} from '@ca/contracts';
import { sha256Hex, type ArtifactAccessPort, type ObjectWriterPort, type SourceReaderPort, type ValidatorPort } from '@ca/tools';
import {
  RECIPE_VALIDATOR_VERSION,
  buildRecipeFingerprint,
  createRecipeRuntime,
  type RecipeDependencyPins,
  type RecipeExecutionDeps,
  type RecipeRunContext,
  type RecipeRuntime,
  type RecipeRuntimeOptions,
} from '../src';

/* ------------------------------------------------------------------ */
/* Deterministic ids / clocks                                          */
/* ------------------------------------------------------------------ */

export function uuidFromSeed(seed: string): string {
  const hex = sha256Hex(seed);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const TASK_ID: TaskId = TaskIdSchema.parse(uuidFromSeed('task:cleaning'));
export const OTHER_TASK_ID: TaskId = TaskIdSchema.parse(uuidFromSeed('task:other'));
export const RUN_ID: RunId = RunIdSchema.parse(uuidFromSeed('run:cleaning'));
export const RECIPE_ID = RecipeIdSchema.parse(uuidFromSeed('recipe:cleaning'));
export const LEGACY_SOURCE_ID: SourceId = SourceIdSchema.parse(uuidFromSeed('source:legacy'));
export const NEW_SOURCE_ID: SourceId = SourceIdSchema.parse(uuidFromSeed('source:new'));
export const INVALID_SOURCE_ID: SourceId = SourceIdSchema.parse(uuidFromSeed('source:invalid'));
export const PDF_SOURCE_ID: SourceId = SourceIdSchema.parse(uuidFromSeed('source:pdf'));
export const OUTPUT_MODULE_ID: ModuleId = ModuleIdSchema.parse(uuidFromSeed('module:cleaned'));

export const CREATED_AT = '2026-01-01T00:00:00.000Z';

export function makeClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)): { now(): string } {
  let cursor = startMs;
  return {
    now(): string {
      const value = new Date(cursor).toISOString();
      cursor += 1_000;
      return value;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures (read-only)                                                */
/* ------------------------------------------------------------------ */

const FIXTURE_DIR = fileURLToPath(new URL('../../../scenarios/cognitive-atrium/', import.meta.url));

export function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURE_DIR}${name}`));
}

export function readFixtureText(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, 'utf8');
}

export const LEGACY_CSV = readFixtureText('legacy-systems.csv');
export const NEW_CSV = readFixtureText('legacy-systems-new.csv');
export const INVALID_CSV = readFixtureText('legacy-systems-invalid.csv');

export function makeSourceItem(input: {
  taskId: TaskId;
  id: SourceId;
  name: string;
  mime?: string;
  version?: number;
  bytes?: Uint8Array;
  text?: string;
}): SourceItem {
  const bytes = input.bytes ?? new TextEncoder().encode(input.text ?? '');
  return SourceItemSchema.parse({
    id: input.id,
    taskId: input.taskId,
    name: input.name,
    mime: input.mime ?? 'text/csv',
    version: input.version ?? 1,
    sizeBytes: bytes.length,
    hash: sha256Hex(bytes),
    origin: 'demo_seed',
    trustLevel: 'synthetic_demo',
    availability: 'available',
    parseStatus: 'parsed',
    parseNote: '',
    createdAt: CREATED_AT,
  });
}

/* ------------------------------------------------------------------ */
/* Fake ports                                                          */
/* ------------------------------------------------------------------ */

interface SourceRecord {
  taskId: TaskId;
  item: SourceItem;
  bytes: Uint8Array;
}

export class FakeSourceReader implements SourceReaderPort {
  readonly records: SourceRecord[] = [];
  readonly spans: SourceSpan[] = [];
  readonly reads: Array<{ taskId: TaskId; sourceId: SourceId; version: number }> = [];
  saveSpanCalls = 0;

  add(taskId: TaskId, item: SourceItem, bytes: Uint8Array): void {
    this.records.push({ taskId, item, bytes });
  }

  addText(taskId: TaskId, item: SourceItem, text: string): void {
    this.add(taskId, item, new TextEncoder().encode(text));
  }

  async listSources(taskId: TaskId): Promise<SourceItem[]> {
    return this.records
      .filter((record) => record.taskId === taskId)
      .map((record) => record.item)
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  async getSource(taskId: TaskId, sourceId: SourceId, version: number): Promise<{ source: SourceItem; bytes: Uint8Array } | null> {
    this.reads.push({ taskId, sourceId, version });
    const record = this.records.find(
      (candidate) => candidate.taskId === taskId && candidate.item.id === sourceId && candidate.item.version === version,
    );
    return record ? { source: record.item, bytes: record.bytes } : null;
  }

  async listLatestContents(taskId: TaskId): Promise<Array<{ source: SourceItem; bytes: Uint8Array }>> {
    const latest = new Map<string, SourceRecord>();
    for (const record of this.records) {
      if (record.taskId !== taskId) continue;
      const current = latest.get(record.item.id);
      if (!current || current.item.version < record.item.version) latest.set(record.item.id, record);
    }
    return [...latest.values()].map((record) => ({ source: record.item, bytes: record.bytes }));
  }

  async listSpans(taskId: TaskId, limit = 1000): Promise<SourceSpan[]> {
    void taskId;
    return this.spans.slice(0, limit);
  }

  async saveSpan(span: SourceSpan): Promise<void> {
    this.saveSpanCalls += 1;
    this.spans.push(span);
  }
}

export class FakeObjectWriter implements ObjectWriterPort {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  readonly puts: Array<{ hash: string; mime: string; sizeBytes: number; bytes: Uint8Array }> = [];

  async put(bytes: Uint8Array, mime: string): Promise<{ hash: string; sizeBytes: number; mime: string }> {
    const hash = sha256Hex(bytes);
    this.objects.set(hash, { bytes, mime });
    this.puts.push({ hash, mime, sizeBytes: bytes.length, bytes });
    return { hash, sizeBytes: bytes.length, mime };
  }
}

export class FakeArtifactAccess implements ArtifactAccessPort {
  readonly modules = new Map<string, import('@ca/contracts').ArtifactModule>();
  readonly versions = new Map<string, import('@ca/contracts').ArtifactVersion>();
  readonly calls: string[] = [];

  addVersion(artifactModule: import('@ca/contracts').ArtifactModule, version: import('@ca/contracts').ArtifactVersion): void {
    this.modules.set(artifactModule.id, artifactModule);
    this.versions.set(version.id, version);
  }

  async getModule(moduleId: string): Promise<import('@ca/contracts').ArtifactModule | null> {
    this.calls.push(`getModule:${moduleId}`);
    return this.modules.get(moduleId) ?? null;
  }

  async getAcceptedVersion(moduleId: string): Promise<import('@ca/contracts').ArtifactVersion | null> {
    this.calls.push(`getAcceptedVersion:${moduleId}`);
    const artifactModule = this.modules.get(moduleId);
    if (!artifactModule?.acceptedVersionId) return null;
    return this.versions.get(artifactModule.acceptedVersionId) ?? null;
  }

  async getVersion(versionId: string): Promise<import('@ca/contracts').ArtifactVersion | null> {
    this.calls.push(`getVersion:${versionId}`);
    return this.versions.get(versionId) ?? null;
  }

  async saveProposal(): Promise<never> {
    throw new Error('FakeArtifactAccess.saveProposal is not part of the recipe runtime surface');
  }

  async saveValidationReport(): Promise<never> {
    throw new Error('FakeArtifactAccess.saveValidationReport is not part of the recipe runtime surface');
  }
}

export const throwingValidator: ValidatorPort = {
  async validate(): Promise<never> {
    throw new Error('the recipe runtime must not call ValidatorPort for deterministic recipes');
  },
};

export class FakeRecipeCache {
  readonly entries = new Map<string, import('../src').RecipeCacheEntry>();
  gets = 0;
  puts = 0;
  /** Deliberately corrupt/absent entry a test can force to prove no fake hits. */
  forcedEntry: import('../src').RecipeCacheEntry | null = null;
  /** When true every get() throws (the runtime must fall back to real execution). */
  failGets = false;

  async get(key: string): Promise<import('../src').RecipeCacheEntry | null> {
    this.gets += 1;
    if (this.failGets) throw new Error('cache unavailable');
    return this.forcedEntry ?? this.entries.get(key) ?? null;
  }

  async put(key: string, entry: import('../src').RecipeCacheEntry): Promise<void> {
    this.puts += 1;
    this.entries.set(key, entry);
  }
}

/* ------------------------------------------------------------------ */
/* Runtime pins + harness                                              */
/* ------------------------------------------------------------------ */

export const BASE_TOOL_VERSIONS: Record<string, string> = {
  'source.read': '1.0.0',
  'source.search': '1.0.0',
  'data.profile': '1.0.0',
  'data.transform': '1.0.0',
  'artifact.read': '1.0.0',
};

export const BASE_PINS: RecipeDependencyPins = {
  toolVersions: { ...BASE_TOOL_VERSIONS },
  promptHashes: { 'executor.v1': sha256Hex('executor.v1 prompt') },
  validatorVersion: RECIPE_VALIDATOR_VERSION,
  parserVersion: 'csv-parser-1',
};

export interface HarnessOptions {
  pins?: RecipeDependencyPins;
  includeModelStep?: boolean;
  modelDelayMs?: number;
  cache?: import('../src').RecipeCachePort;
}

export interface Harness {
  reader: FakeSourceReader;
  objects: FakeObjectWriter;
  artifacts: FakeArtifactAccess;
  cache: FakeRecipeCache | null;
  modelCalls: Array<Parameters<NonNullable<RecipeExecutionDeps['runModelStep']>>[0]>;
  deps: RecipeExecutionDeps;
  runtime: RecipeRuntime;
  pins: RecipeDependencyPins;
  clock: { now(): string };
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const reader = new FakeSourceReader();
  reader.add(TASK_ID, makeSourceItem({ taskId: TASK_ID, id: LEGACY_SOURCE_ID, name: 'legacy-systems.csv', text: LEGACY_CSV }), new TextEncoder().encode(LEGACY_CSV));
  reader.add(TASK_ID, makeSourceItem({ taskId: TASK_ID, id: NEW_SOURCE_ID, name: 'legacy-systems-new.csv', text: NEW_CSV }), new TextEncoder().encode(NEW_CSV));
  reader.add(
    TASK_ID,
    makeSourceItem({ taskId: TASK_ID, id: INVALID_SOURCE_ID, name: 'legacy-systems-invalid.csv', text: INVALID_CSV }),
    new TextEncoder().encode(INVALID_CSV),
  );
  reader.add(
    TASK_ID,
    makeSourceItem({
      taskId: TASK_ID,
      id: PDF_SOURCE_ID,
      name: 'unsupported.pdf',
      mime: 'application/pdf',
      text: '%PDF-1.4 synthetic',
    }),
    new TextEncoder().encode('%PDF-1.4 synthetic'),
  );
  // Same source id is deliberately NOT registered for OTHER_TASK_ID: the
  // preflight must refuse it (task ownership / existence check).
  reader.add(
    OTHER_TASK_ID,
    makeSourceItem({ taskId: OTHER_TASK_ID, id: LEGACY_SOURCE_ID, name: 'other-task-file.csv', text: 'id\nX-1\n' }),
    new TextEncoder().encode('id\nX-1\n'),
  );

  const objects = new FakeObjectWriter();
  const artifacts = new FakeArtifactAccess();
  const clock = makeClock();
  const modelCalls: Harness['modelCalls'] = [];
  const pins = options.pins ?? BASE_PINS;

  const deps: RecipeExecutionDeps = {
    sources: reader,
    artifacts,
    objects,
    validator: throwingValidator,
    now: () => clock.now(),
    ...(options.includeModelStep === false
      ? {}
      : {
          runModelStep: async (input: Parameters<NonNullable<RecipeExecutionDeps['runModelStep']>>[0]) => {
            modelCalls.push(input);
            if (options.modelDelayMs && options.modelDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, options.modelDelayMs));
            }
            return { text: `模型输出：${input.instruction || input.promptTemplateId}`, modelCalls: 1 };
          },
        }),
  };

  const runtimeOptions: RecipeRuntimeOptions = {
    deps,
    toolVersions: pins.toolVersions,
    promptHashes: pins.promptHashes,
    validatorVersion: pins.validatorVersion,
    parserVersion: pins.parserVersion,
    ...(options.cache ? { cache: options.cache } : {}),
  };

  return {
    reader,
    objects,
    artifacts,
    cache: options.cache instanceof FakeRecipeCache ? options.cache : null,
    modelCalls,
    deps,
    runtime: createRecipeRuntime(runtimeOptions),
    pins,
    clock,
  };
}

/* ------------------------------------------------------------------ */
/* Cleaning recipe (mirrors scenarios field-mapping.json)              */
/* ------------------------------------------------------------------ */

export const CLEANING_OPERATIONS = [
  { op: 'rename' as const, mapping: { sys_id: 'system_id', owner: 'owner_dept', protocol_type: 'protocol' } },
  { op: 'normalize' as const, column: 'system_id', transforms: ['trim' as const] },
  { op: 'normalize' as const, column: 'name', transforms: ['trim' as const] },
  { op: 'normalize' as const, column: 'status', transforms: ['trim' as const, 'lower' as const] },
  { op: 'dedupe' as const, keys: ['system_id'], keep: 'last' as const, normalize: 'trim_lower' as const },
  { op: 'require' as const, columns: ['system_id', 'name'] },
];

export function cleaningSteps(): RecipeStep[] {
  return [
    RecipeStepSchema.parse({
      id: 's1',
      kind: 'source.read',
      title: '读取存量系统 CSV',
      source: { kind: 'parameter', name: 'source' },
      locator: null,
      maxChars: 20_000,
    }),
    RecipeStepSchema.parse({
      id: 's2',
      kind: 'data.profile',
      title: '剖析输入数据',
      input: { kind: 'parameter', name: 'source' },
    }),
    RecipeStepSchema.parse({
      id: 's3',
      kind: 'data.transform',
      title: '别名重命名 / 规范化 / 主键去重 / 必填校验',
      input: { kind: 'parameter', name: 'source' },
      format: 'csv',
      operations: CLEANING_OPERATIONS,
      outputName: 'cleaned.csv',
    }),
    RecipeStepSchema.parse({
      id: 's4',
      kind: 'validate',
      title: '确定性校验：非空与主键唯一',
      validators: ['table.nonempty', 'table.unique_primary_key'],
    }),
    RecipeStepSchema.parse({
      id: 's5',
      kind: 'emit_artifact',
      title: '产出 cleaned.csv',
      moduleKind: 'csv',
      input: { kind: 'previous_step' },
      artifactName: 'cleaned.csv',
    }),
  ];
}

export function sourceInputs(sourceId: SourceId): JsonObject {
  return { source: { sourceId, version: 1 } };
}

export function cleaningTestCases(): RecipeTestCase[] {
  return [
    {
      id: 'original',
      label: '原始输入 legacy-systems.csv',
      kind: 'original',
      inputs: sourceInputs(LEGACY_SOURCE_ID),
      expectation: 'accept',
      status: 'untested',
      detail: '',
      normalizedOutputHash: null,
      lastRunAt: null,
    },
    {
      id: 'new-valid',
      label: '新有效输入 legacy-systems-new.csv',
      kind: 'new_valid',
      inputs: sourceInputs(NEW_SOURCE_ID),
      expectation: 'accept',
      status: 'untested',
      detail: '',
      normalizedOutputHash: null,
      lastRunAt: null,
    },
    {
      id: 'invalid',
      label: '无效输入 legacy-systems-invalid.csv（缺少 system_id 映射）',
      kind: 'invalid',
      inputs: sourceInputs(INVALID_SOURCE_ID),
      expectation: 'reject',
      status: 'untested',
      detail: '',
      normalizedOutputHash: null,
      lastRunAt: null,
    },
  ];
}

export interface CleaningRecipeOverrides {
  status?: Recipe['status'];
  kind?: Recipe['kind'];
  steps?: RecipeStep[];
  testCases?: RecipeTestCase[];
  budget?: Partial<Recipe['budget']>;
  permissions?: Partial<Recipe['permissions']>;
  outputArtifactKind?: Recipe['outputArtifactKind'];
  validators?: Recipe['validators'];
  sourceModuleId?: ModuleId | null;
  name?: string;
  pins?: RecipeDependencyPins;
}

export function makeCleaningRecipe(overrides: CleaningRecipeOverrides = {}): Recipe {
  const steps = overrides.steps ?? cleaningSteps();
  const pins = overrides.pins ?? BASE_PINS;
  const { fingerprintInputs, fingerprint } = buildRecipeFingerprint({ steps }, pins);
  const base = {
    id: RECIPE_ID,
    version: 1,
    name: overrides.name ?? '存量系统清洗配方',
    description: '确定性清洗：别名映射、空白/大小写规范化、主键 keep=last 去重、必填检查。',
    kind: overrides.kind ?? 'deterministic',
    status: overrides.status ?? 'validated',
    dslVersion: '1',
    inputParameters: [
      {
        name: 'source',
        type: 'source',
        required: true,
        description: '待清洗的存量系统 CSV（合成演示数据）',
        pattern: null,
        enumValues: [],
        acceptsMime: ['text/csv'],
      },
    ],
    steps,
    outputArtifactKind: overrides.outputArtifactKind ?? 'csv',
    validators: overrides.validators ?? [
      { id: 'table.nonempty', description: '输出至少一行', supported: true },
      { id: 'table.unique_primary_key', description: '主键唯一', supported: true },
    ],
    permissions: {
      tools: ['source.read', 'data.profile', 'data.transform'],
      scopes: ['sources:read', 'data:profile', 'data:transform'],
      allowModelCalls: false,
      maxModelCallsPerRun: 0,
      ...overrides.permissions,
    },
    budget: { maxModelCalls: 0, maxToolCalls: 10, maxRuntimeMs: 10_000, ...overrides.budget },
    testCases: overrides.testCases ?? cleaningTestCases(),
    fingerprint,
    fingerprintInputs,
    sourceRunId: RUN_ID,
    sourceTaskId: TASK_ID,
    sourceModuleId: overrides.sourceModuleId ?? null,
    applicability: '适用于列名经 field-mapping.json 别名映射后的存量系统清单；输出不超过 50k 行。',
    staleReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  return RecipeSchema.parse(base);
}

/* ------------------------------------------------------------------ */
/* Small recipe variants used by runtime tests                         */
/* ------------------------------------------------------------------ */

export function makeGuardedRecipe(): Recipe {
  const steps = [
    RecipeStepSchema.parse({
      id: 'g1',
      kind: 'source.read',
      title: '可选读取',
      source: { kind: 'parameter', name: 'source' },
      when: { parameter: 'read_source', operator: 'equals', value: true },
    }),
    RecipeStepSchema.parse({
      id: 'g2',
      kind: 'data.transform',
      title: '转换',
      input: { kind: 'parameter', name: 'source' },
      format: 'csv',
      operations: CLEANING_OPERATIONS,
      outputName: 'guarded.csv',
    }),
    RecipeStepSchema.parse({
      id: 'g3',
      kind: 'emit_artifact',
      title: '产出',
      moduleKind: 'csv',
      input: { kind: 'previous_step' },
      artifactName: 'guarded.csv',
    }),
  ];
  const { fingerprintInputs, fingerprint } = buildRecipeFingerprint({ steps }, BASE_PINS);
  return RecipeSchema.parse({
    id: RECIPE_ID,
    version: 1,
    name: '带守卫的清洗配方',
    description: '',
    kind: 'deterministic',
    status: 'validated',
    dslVersion: '1',
    inputParameters: [
      {
        name: 'source',
        type: 'source',
        required: true,
        description: '输入',
        pattern: null,
        enumValues: [],
        acceptsMime: ['text/csv'],
      },
      {
        name: 'read_source',
        type: 'boolean',
        required: false,
        description: '是否先做一次 source.read',
        pattern: null,
        enumValues: [],
        acceptsMime: [],
        defaultValue: true,
      },
    ],
    steps,
    outputArtifactKind: 'csv',
    validators: [],
    permissions: {
      tools: ['source.read', 'data.transform'],
      scopes: ['sources:read', 'data:transform'],
      allowModelCalls: false,
      maxModelCallsPerRun: 0,
    },
    budget: { maxModelCalls: 0, maxToolCalls: 10, maxRuntimeMs: 10_000 },
    testCases: cleaningTestCases(),
    fingerprint,
    fingerprintInputs,
    sourceRunId: RUN_ID,
    sourceTaskId: TASK_ID,
    sourceModuleId: null,
    applicability: '',
    staleReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

export function makeLlmAssistedRecipe(overrides: { budgetMaxRuntimeMs?: number; budgetMaxModelCalls?: number; extraLlmStep?: boolean } = {}): Recipe {
  const steps = [
    RecipeStepSchema.parse({
      id: 'l1',
      kind: 'llm.step',
      title: '固定模型步骤',
      promptTemplateId: 'executor.v1',
      promptVersion: 'executor.v1',
      input: { kind: 'parameter', name: 'topic' },
      instruction: '请输出清洗说明',
      maxOutputTokens: 512,
    }),
    RecipeStepSchema.parse({
      id: 'l2',
      kind: 'emit_artifact',
      title: '产出说明',
      moduleKind: 'markdown',
      input: { kind: 'previous_step' },
      artifactName: 'cleaning-report.md',
    }),
  ];
  if (overrides.extraLlmStep) {
    steps.splice(1, 0, RecipeStepSchema.parse({
      id: 'l1b',
      kind: 'llm.step',
      title: '第二次模型步骤',
      promptTemplateId: 'executor.v1',
      promptVersion: 'executor.v1',
      input: { kind: 'previous_step' },
      instruction: '继续输出',
      maxOutputTokens: 256,
    }));
  }
  const { fingerprintInputs, fingerprint } = buildRecipeFingerprint({ steps }, BASE_PINS);
  return RecipeSchema.parse({
    id: RECIPE_ID,
    version: 1,
    name: '清洗说明（模型辅助）',
    description: '',
    kind: 'llm_assisted',
    status: 'validated',
    dslVersion: '1',
    inputParameters: [
      {
        name: 'topic',
        type: 'string',
        required: true,
        description: '说明主题',
        pattern: null,
        enumValues: [],
        acceptsMime: [],
      },
    ],
    steps,
    outputArtifactKind: 'markdown',
    validators: [],
    permissions: {
      tools: [],
      scopes: [],
      allowModelCalls: true,
      maxModelCallsPerRun: 2,
    },
    budget: {
      maxModelCalls: overrides.budgetMaxModelCalls ?? 2,
      maxToolCalls: 5,
      maxRuntimeMs: overrides.budgetMaxRuntimeMs ?? 10_000,
    },
    testCases: [
      {
        id: 'original',
        label: '原始输入',
        kind: 'original',
        inputs: { topic: '清洗' },
        expectation: 'accept',
        status: 'untested',
        detail: '',
        normalizedOutputHash: null,
        lastRunAt: null,
      },
    ],
    fingerprint,
    fingerprintInputs,
    sourceRunId: RUN_ID,
    sourceTaskId: TASK_ID,
    sourceModuleId: null,
    applicability: '',
    staleReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

export function makeRunContext(params: Record<string, unknown>, signal?: AbortSignal): RecipeRunContext {
  return {
    taskId: TASK_ID,
    runId: RUN_ID,
    moduleId: null,
    params,
    signal: signal ?? new AbortController().signal,
  };
}

export interface ObservedStep {
  stepId: string;
  kind: string;
  status: string;
  issues: string[];
  objectHash: string | null;
  rowCount: number | null;
}

export function makeObserver(): { steps: ObservedStep[]; observer: (observation: ObservedStep) => void } {
  const steps: ObservedStep[] = [];
  return {
    steps,
    observer: (observation: ObservedStep) => {
      steps.push(observation);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Synthetic trace used by extraction tests                            */
/* ------------------------------------------------------------------ */

export function makeSyntheticTrace(overrides: Partial<import('../src').RecipeTrace> = {}): import('../src').RecipeTrace {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    moduleId: null,
    moduleKind: 'csv',
    sourceRefs: [{ sourceId: LEGACY_SOURCE_ID, version: 1 }],
    acceptedVersion: null,
    producedContent: {
      kind: 'csv',
      columns: [
        { key: 'system_id', label: 'system_id', type: 'string', required: false },
        { key: 'name', label: 'name', type: 'string', required: false },
      ],
      rows: [{ system_id: 'S-1001', name: 'ERP 财务核心' }],
    },
    steps: [
      {
        kind: 'tool',
        title: '读取输入',
        toolId: 'source.read',
        inputSummary: JSON.stringify({ sourceId: LEGACY_SOURCE_ID, version: 1 }),
        outputSummary: JSON.stringify({ totalChars: 1604 }),
        outputObjectHash: null,
        startedAt: timestamp,
        finishedAt: timestamp,
      },
      {
        kind: 'tool',
        title: '剖析数据',
        toolId: 'data.profile',
        inputSummary: JSON.stringify({ sourceId: LEGACY_SOURCE_ID, version: 1 }),
        outputSummary: JSON.stringify({ rowCount: 24, columnCount: 8 }),
        outputObjectHash: null,
        startedAt: timestamp,
        finishedAt: timestamp,
      },
      {
        kind: 'tool',
        title: '清洗转换',
        toolId: 'data.transform',
        inputSummary: JSON.stringify({ format: 'csv', operations: CLEANING_OPERATIONS, outputName: 'cleaned.csv' }),
        outputSummary: JSON.stringify({ rowCount: 22, issues: 1 }),
        outputObjectHash: sha256Hex('synthetic-transform-output'),
        startedAt: timestamp,
        finishedAt: timestamp,
      },
      {
        kind: 'tool',
        title: '校验',
        toolId: null,
        inputSummary: '{}',
        outputSummary: 'pass',
        outputObjectHash: null,
        startedAt: timestamp,
        finishedAt: timestamp,
      },
    ],
    ...overrides,
  };
}
