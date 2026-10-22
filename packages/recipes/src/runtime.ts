/**
 * Deterministic recipe runtime.
 *
 * A recipe is a bounded, sequential DSL — never a chat transcript and never
 * arbitrary code. This runtime executes only the eight registered step kinds:
 *
 *   source.read · source.search · data.profile · data.transform ·
 *   artifact.read · llm.step · validate · emit_artifact
 *
 * Guarantees enforced here (design document section 13, 9.3, 17.1):
 * - deterministic recipes never call the model (ledger.llmCalls === 0 and the
 *   injected `runModelStep` is not touched);
 * - llm_assisted recipes fail loudly with `model_step_unavailable` when no model
 *   executor was injected — never a fake success;
 * - budgets (`maxToolCalls`, `maxModelCalls`, `maxRuntimeMs`) and permissions
 *   (`allowModelCalls`, tool ids, scopes) are accounted for real;
 * - abort signals are honoured between every step;
 * - data.transform uses the pure operators from @ca/tools (no duplicate logic);
 * - emitted outputs are schema-valid ModuleContent values whose object hash is
 *   the contract content hash of the content;
 * - `cached_snapshot` executes like a normal run and only reports `cache_hit`
 *   when a supplied cache port returns a well-formed entry for the exact
 *   fingerprint + inputs key.
 */
import {
  LIMITS,
  ModuleContentSchema,
  RecipeRunOutputSchema,
  RecipeRunResultSchema,
  RecipeSchema,
  SourceIdSchema,
  SourceSpanIdSchema,
  ModuleIdSchema,
  canonicalJson,
  recipeKindConsistencyErrors,
  recipeStepOrderErrors,
  type JsonObject,
  type JsonValue,
  type ModuleContent,
  type ModuleId,
  type Recipe,
  type RecipeBinding,
  type RecipeParameter,
  type RecipeRunResult,
  type RecipeStep,
  type RecipeStepGuard,
  type RecipeTestCase,
  type RunId,
  type SourceId,
  type SourceItem,
  type SourceLocator,
  type SourceSpan,
  type TaskId,
  type ToolId,
} from '@ca/contracts';
import {
  DataFormatError,
  TableTransformError,
  applyTransformOperations,
  canonicalJsonHash,
  compileSafeRegExp,
  contentHash,
  csvRowsRegion,
  excerptAround,
  parseBoundedJson,
  parseCsv,
  profileTableData,
  sha256Hex,
  tableToCsv,
  tableToJsonValue,
  truncateText,
  utf8Encode,
  type TableData,
} from '@ca/tools';
import {
  RecipeRuntimeError,
  errorMessage,
  isRecipeRuntimeError,
  type RecipeErrorCode,
} from './errors';
import {
  buildRecipeFingerprintInputs,
  computeRecipeFingerprint,
  evaluateRecipeStaleness,
  type RecipeDependencyPins,
} from './fingerprint';
import {
  assertModuleKind,
  coerceModuleContent,
  coerceTable,
  coerceTableFromText,
  isModuleContent,
  isPlainRecord,
  isTableData,
  outputFromContent,
  parseContent,
  rowCountOfContent,
  serializeModuleContent,
} from './content';
import type {
  RecipeCacheEntry,
  RecipeExecutionDeps,
  RecipeInputPreflightContext,
  RecipeInputPreflightResult,
  RecipeInputValidation,
  RecipeRunContext,
  RecipeRunObserver,
  RecipeRunOutput,
  RecipeRuntime,
  RecipeRuntimeOptions,
  RecipeSourceMeta,
  RecipeStepObservation,
} from './types';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Built-in deterministic validators (referenced by id from `validate` steps). */
export const RECIPE_VALIDATOR_VERSION = 'recipe-validators-1';

interface BuiltinValidator {
  id: string;
  description: string;
  check(value: unknown): { ok: boolean; findings: string[] };
}

function moduleContentFromValidatorValue(value: unknown): ModuleContent | null {
  if (isModuleContent(value)) return value;
  if (isPlainRecord(value) && isModuleContent(value.content)) return value.content;
  return null;
}

function tableFromValidatorValue(value: unknown): TableData | null {
  try {
    return coerceTable(value, { format: 'csv' });
  } catch {
    return null;
  }
}

const BUILTIN_VALIDATORS: Readonly<Record<string, BuiltinValidator>> = {
  'table.nonempty': {
    id: 'table.nonempty',
    description: 'The previous step produced a table with at least one data row.',
    check(value) {
      const table = tableFromValidatorValue(value);
      if (!table) return { ok: false, findings: ['previous step value is not a table'] };
      return table.rows.length > 0
        ? { ok: true, findings: [] }
        : { ok: false, findings: ['table has zero data rows'] };
    },
  },
  'table.unique_primary_key': {
    id: 'table.unique_primary_key',
    description: 'First column (the primary key) has no duplicate and no blank values.',
    check(value) {
      const table = tableFromValidatorValue(value);
      if (!table) return { ok: false, findings: ['previous step value is not a table'] };
      if (table.columns.length === 0) return { ok: false, findings: ['table has no columns'] };
      const key = table.columns[0]!.key;
      const findings: string[] = [];
      const seen = new Set<string>();
      table.rows.forEach((row, index) => {
        const raw = row[key] ?? null;
        const text = raw === null ? '' : String(raw).trim();
        if (text === '') findings.push(`primary key "${key}" is empty at row ${index + 1}`);
        else if (seen.has(text)) findings.push(`primary key "${key}" is duplicated at row ${index + 1}: ${text}`);
        else seen.add(text);
      });
      return { ok: findings.length === 0, findings: findings.slice(0, 20) };
    },
  },
  'table.no_duplicate_rows': {
    id: 'table.no_duplicate_rows',
    description: 'The previous table contains no fully duplicated rows.',
    check(value) {
      const table = tableFromValidatorValue(value);
      if (!table) return { ok: false, findings: ['previous step value is not a table'] };
      const seen = new Set<string>();
      const findings: string[] = [];
      table.rows.forEach((row, index) => {
        const signature = canonicalJson(table.columns.map((column) => row[column.key] ?? null));
        if (seen.has(signature)) findings.push(`duplicate row at position ${index + 1}`);
        else seen.add(signature);
      });
      return { ok: findings.length === 0, findings: findings.slice(0, 20) };
    },
  },
  'content.schema': {
    id: 'content.schema',
    description: 'The previous step value is a schema-valid ModuleContent.',
    check(value) {
      const content = moduleContentFromValidatorValue(value);
      if (!content) return { ok: false, findings: ['previous step value is not a ModuleContent'] };
      const parsed = ModuleContentSchema.safeParse(content);
      if (parsed.success) return { ok: true, findings: [] };
      return {
        ok: false,
        findings: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
      };
    },
  },
  'content.limits': {
    id: 'content.limits',
    description: 'The previous ModuleContent value is inside the contract size limits.',
    check(value) {
      const rawContent = moduleContentFromValidatorValue(value);
      if (!rawContent) return { ok: false, findings: ['value is not a ModuleContent'] };
      const parsed = ModuleContentSchema.safeParse(rawContent);
      if (!parsed.success) return { ok: false, findings: ['value is not a ModuleContent'] };
      const content = parsed.data;
      const findings: string[] = [];
      if (content.kind === 'csv') {
        if (content.rows.length > LIMITS.maxCsvRows) findings.push(`csv rows exceed ${LIMITS.maxCsvRows}`);
        if (content.columns.length > LIMITS.maxCsvColumns) findings.push(`csv columns exceed ${LIMITS.maxCsvColumns}`);
      }
      if (content.kind === 'markdown' && content.sections.length > LIMITS.maxMarkdownSections) {
        findings.push(`markdown sections exceed ${LIMITS.maxMarkdownSections}`);
      }
      const bytes = utf8Encode(canonicalJson(content)).length;
      if (bytes > LIMITS.maxToolResultBytes) findings.push(`content is ${bytes} bytes (limit ${LIMITS.maxToolResultBytes})`);
      return { ok: findings.length === 0, findings };
    },
  },
};

export const RECIPE_VALIDATOR_IDS: readonly string[] = Object.keys(BUILTIN_VALIDATORS).sort();

const TOOL_ID_BY_STEP_KIND: Readonly<Partial<Record<RecipeStep['kind'], ToolId>>> = {
  'source.read': 'source.read',
  'source.search': 'source.search',
  'data.profile': 'data.profile',
  'data.transform': 'data.transform',
  'artifact.read': 'artifact.read',
};

const SCOPE_BY_STEP_KIND: Readonly<Partial<Record<RecipeStep['kind'], string>>> = {
  'source.read': 'sources:read',
  'source.search': 'sources:read',
  'data.profile': 'data:profile',
  'data.transform': 'data:transform',
  'artifact.read': 'artifact:read',
};

const MAX_OBSERVED_ISSUES = 50;
const DEFAULT_ARTIFACT_MIME = 'application/json';

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function nowMs(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value));
}

/** Deterministic UUID (v5-style) derived from a sha256 digest, for validation runs. */
function deterministicUuid(seed: string): string {
  const hex = sha256Hex(seed);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function bound(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function isAbortLike(error: unknown): boolean {
  return isRecipeRuntimeError(error) && error.code === 'aborted';
}

function mapDataErrorCode(code: string): RecipeErrorCode {
  switch (code) {
    case 'column_not_found':
    case 'duplicate_column':
    case 'invalid_operator_value':
    case 'unsafe_regex':
    case 'transform_failed':
    case 'csv_parse_error':
    case 'json_parse_error':
    case 'data_format_error':
    case 'limit_exceeded':
      return 'invalid_input';
    default:
      return 'step_failed';
  }
}

function sourceKey(sourceId: string, version: number): string {
  return `${sourceId}@${version}`;
}

function currentPins(options: RecipeRuntimeOptions): RecipeDependencyPins {
  return {
    toolVersions: { ...options.toolVersions },
    promptHashes: { ...options.promptHashes },
    validatorVersion: options.validatorVersion,
    parserVersion: options.parserVersion,
  };
}

/* ------------------------------------------------------------------ */
/* Compile-time recipe checks                                          */
/* ------------------------------------------------------------------ */

interface CompiledRecipe {
  recipe: Recipe;
  errors: string[];
}

function compileRecipe(recipe: Recipe, options: { promptHashes?: Record<string, string> }): CompiledRecipe {
  const errors: string[] = [];
  const parsed = RecipeSchema.safeParse(recipe);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      errors.push(`schema: ${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
    return { recipe, errors };
  }
  const value = parsed.data;

  // DSL invariants shipped by the frozen contract package.
  errors.push(...recipeStepOrderErrors(value.steps));
  errors.push(...recipeKindConsistencyErrors(value));

  const paramNames = new Set<string>();
  for (const parameter of value.inputParameters) {
    if (paramNames.has(parameter.name)) errors.push(`duplicate input parameter name "${parameter.name}"`);
    paramNames.add(parameter.name);
  }
  const stepIds = new Set<string>();
  for (const step of value.steps) {
    if (stepIds.has(step.id)) errors.push(`duplicate step id "${step.id}"`);
    stepIds.add(step.id);
    if (step.when) errors.push(...guardErrors(step, paramNames));
    if (step.kind === 'validate') {
      for (const validatorId of step.validators) {
        if (!BUILTIN_VALIDATORS[validatorId]) {
          errors.push(`step "${step.id}" references unsupported validator "${validatorId}" (supported: ${RECIPE_VALIDATOR_IDS.join(', ')})`);
        }
      }
    }
    if (step.kind === 'emit_artifact' && step.moduleKind !== value.outputArtifactKind) {
      errors.push(
        `step "${step.id}" emits ${step.moduleKind} but the recipe declares outputArtifactKind "${value.outputArtifactKind}"`,
      );
    }
    if (step.kind === 'llm.step' && !value.permissions.allowModelCalls) {
      errors.push(`step "${step.id}" is an llm.step but the recipe permissions do not allow model calls`);
    }
    const toolId = TOOL_ID_BY_STEP_KIND[step.kind];
    if (toolId && !value.permissions.tools.includes(toolId)) {
      errors.push(`step "${step.id}" (${step.kind}) needs tool permission "${toolId}" but recipe.permissions.tools does not include it`);
    }
    const scope = SCOPE_BY_STEP_KIND[step.kind];
    if (scope && value.permissions.scopes.length > 0 && !value.permissions.scopes.includes(scope)) {
      errors.push(`step "${step.id}" (${step.kind}) needs scope "${scope}" but recipe.permissions.scopes does not include it`);
    }
  }
  for (const validator of value.validators) {
    if (!BUILTIN_VALIDATORS[validator.id]) {
      errors.push(`recipe declares unsupported validator "${validator.id}"`);
    }
  }
  if (value.kind !== 'deterministic' && value.budget.maxModelCalls === 0) {
    errors.push('non-deterministic recipes need a positive model call budget');
  }
  if (value.kind === 'llm_assisted' && !value.steps.some((step) => step.kind === 'llm.step')) {
    errors.push('llm_assisted recipe has no llm.step');
  }
  // Prompt pins must exist for every fixed prompt the workflow uses.
  const promptHashes = options.promptHashes ?? {};
  for (const step of value.steps) {
    if (step.kind !== 'llm.step') continue;
    const pinned = Object.keys(promptHashes).some(
      (key) =>
        key === step.promptTemplateId ||
        key.startsWith(`${step.promptTemplateId}@`) ||
        key.startsWith(`${step.promptTemplateId}:`),
    );
    if (!pinned) {
      errors.push(
        `step "${step.id}" uses prompt "${step.promptTemplateId}" but no prompt hash is pinned in RecipeRuntimeOptions.promptHashes`,
      );
    }
  }
  return { recipe: value, errors };
}

function guardErrors(step: RecipeStep, paramNames: ReadonlySet<string>): string[] {
  const guard = step.when;
  if (!guard) return [];
  const errors: string[] = [];
  if (!paramNames.has(guard.parameter)) {
    errors.push(`step "${step.id}" guard references undeclared parameter "${guard.parameter}"`);
  }
  if ((guard.operator === 'equals' || guard.operator === 'not_equals' || guard.operator === 'in') && guard.value === undefined) {
    errors.push(`step "${step.id}" guard operator "${guard.operator}" requires a value`);
  }
  if (guard.operator === 'in' && !Array.isArray(guard.value)) {
    errors.push(`step "${step.id}" guard operator "in" requires an array value`);
  }
  return errors;
}

/**
 * Public DSL/registry compile check used by the recipe registry before
 * registration (design 13.3). Returns human-readable errors; an empty array
 * means the recipe is structurally executable (registration additionally needs
 * the test cases to pass and the fingerprint pins to be current).
 */
export function recipeCompileErrors(recipe: Recipe, promptHashes: Record<string, string> = {}): string[] {
  return compileRecipe(recipe, { promptHashes }).errors;
}

function hasModelStep(recipe: Recipe): boolean {
  return recipe.steps.some((step) => step.kind === 'llm.step');
}

/* ------------------------------------------------------------------ */
/* Input validation (synchronous schema gate)                          */
/* ------------------------------------------------------------------ */

function boundedJsonProblem(value: unknown, maxDepth = LIMITS.maxJsonDepth, maxNodes = LIMITS.maxJsonNodes): string | null {
  interface Frame {
    value: unknown;
    depth: number;
  }
  const stack: Frame[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) return `value has more than ${maxNodes} nodes`;
    const current = frame.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return 'value contains a non-finite number';
      continue;
    }
    if (typeof current !== 'object') return `value contains an unsupported ${typeof current}`;
    if (frame.depth + 1 > maxDepth) return `value nesting depth exceeds ${maxDepth}`;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) stack.push({ value: current[i], depth: frame.depth + 1 });
      continue;
    }
    for (const child of Object.values(current as Record<string, unknown>)) {
      stack.push({ value: child, depth: frame.depth + 1 });
    }
  }
  return null;
}

interface ParsedSourceInput {
  sourceId: SourceId;
  version: number | null;
}

function parseSourceInput(raw: unknown): { ok: true; value: ParsedSourceInput } | { ok: false; error: string } {
  if (typeof raw === 'string') {
    const parsed = SourceIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'expected a source id (uuid string)' };
    return { ok: true, value: { sourceId: parsed.data, version: null } };
  }
  if (!isPlainRecord(raw)) {
    return { ok: false, error: 'expected a source reference: uuid string or {sourceId, version?} object' };
  }
  const sourceIdRaw = raw.sourceId;
  if (typeof sourceIdRaw !== 'string') return { ok: false, error: 'source reference is missing a string sourceId' };
  const parsedId = SourceIdSchema.safeParse(sourceIdRaw);
  if (!parsedId.success) return { ok: false, error: 'sourceId is not a valid uuid' };
  const versionRaw = raw.version;
  if (versionRaw === undefined || versionRaw === null) return { ok: true, value: { sourceId: parsedId.data, version: null } };
  if (typeof versionRaw !== 'number' || !Number.isInteger(versionRaw) || versionRaw <= 0) {
    return { ok: false, error: 'source version must be a positive integer' };
  }
  return { ok: true, value: { sourceId: parsedId.data, version: versionRaw } };
}

function validateParamValue(
  parameter: RecipeParameter,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (parameter.type) {
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, error: 'expected a string' };
      if (raw.length > LIMITS.maxCsvFieldChars) return { ok: false, error: `string is longer than ${LIMITS.maxCsvFieldChars} chars` };
      if (parameter.enumValues.length > 0 && !parameter.enumValues.includes(raw)) {
        return { ok: false, error: `value must be one of: ${parameter.enumValues.join(', ')}` };
      }
      if (parameter.pattern) {
        let expression: RegExp;
        try {
          expression = compileSafeRegExp(`^(?:${parameter.pattern})$`);
        } catch (error) {
          return { ok: false, error: `parameter pattern is invalid: ${errorMessage(error)}` };
        }
        if (!expression.test(raw)) return { ok: false, error: `value does not match pattern /${parameter.pattern}/` };
      }
      return { ok: true, value: raw };
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false, error: 'expected a finite number' };
      return { ok: true, value: raw };
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return { ok: false, error: 'expected a boolean' };
      return { ok: true, value: raw };
    }
    case 'object': {
      if (!isPlainRecord(raw)) return { ok: false, error: 'expected a JSON object' };
      const problem = boundedJsonProblem(raw);
      if (problem) return { ok: false, error: problem };
      return { ok: true, value: raw };
    }
    case 'source': {
      const parsed = parseSourceInput(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, value: parsed.value };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Execution environment + step state                                  */
/* ------------------------------------------------------------------ */

interface SourceCacheEntry {
  source: SourceItem;
  version: number;
  text: string;
}

type SourceCache = Map<string, SourceCacheEntry>;

interface SourceBindings {
  [param: string]: { sourceId: SourceId; version: number };
}

interface ExecutionEnvironment {
  deps: RecipeExecutionDeps;
  recipe: Recipe;
  taskId: TaskId;
  runId: RunId;
  moduleId: ModuleId | null;
  params: Record<string, unknown>;
  signal: AbortSignal;
  observer?: RecipeRunObserver;
  cache: SourceCache;
  bindings: SourceBindings;
  dryRun: boolean;
  startedMs: number;
}

interface ExecutionState {
  lastValue: unknown;
  lastStepId: string | null;
  values: Map<string, unknown>;
  outputs: RecipeRunOutput[];
  toolCalls: number;
  llmCalls: number;
}

interface StepResult {
  value: unknown;
  issues: string[];
  objectHash: string | null;
  rowCount: number | null;
  toolCalls: number;
  modelCalls: number;
}

class StopPreflight extends Error {
  constructor() {
    super('preflight cannot execute model steps');
    this.name = 'StopPreflight';
  }
}

function createExecutionState(): ExecutionState {
  return { lastValue: undefined, lastStepId: null, values: new Map(), outputs: [], toolCalls: 0, llmCalls: 0 };
}

function emitObservation(env: ExecutionEnvironment, observation: RecipeStepObservation): void {
  if (!env.observer) return;
  try {
    env.observer(observation);
  } catch {
    // Diagnostics must never change business results.
  }
}

function checkAborted(signal: AbortSignal, stepId?: string): void {
  if (signal.aborted) {
    throw new RecipeRuntimeError('aborted', 'recipe run was aborted', { retryable: true, stepId });
  }
}

/* ------------------------------------------------------------------ */
/* Guards and bindings                                                 */
/* ------------------------------------------------------------------ */

function jsonEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Evaluate a bounded step guard against validated parameters. */
export function evaluateRecipeGuard(guard: RecipeStepGuard, params: Record<string, unknown>): boolean {
  const value = params[guard.parameter];
  const exists = value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
  switch (guard.operator) {
    case 'exists':
      return exists;
    case 'equals':
      return exists && jsonEquals(value, guard.value);
    case 'not_equals':
      return !exists || !jsonEquals(value, guard.value);
    case 'in': {
      if (!exists) return false;
      const list = Array.isArray(guard.value) ? guard.value : [];
      return list.some((candidate) => jsonEquals(candidate, value));
    }
  }
}

function resolveBinding(
  binding: RecipeBinding,
  env: ExecutionEnvironment,
  state: ExecutionState,
  step: RecipeStep,
): unknown {
  switch (binding.kind) {
    case 'parameter': {
      if (!Object.prototype.hasOwnProperty.call(env.params, binding.name)) {
        throw new RecipeRuntimeError(
          'binding_unresolved',
          `step "${step.id}" references parameter "${binding.name}" but it has no value for this run`,
          { stepId: step.id },
        );
      }
      return env.params[binding.name];
    }
    case 'previous_step': {
      if (state.lastValue === undefined) {
        throw new RecipeRuntimeError(
          'binding_unresolved',
          `step "${step.id}" references previous_step but no earlier step has produced a value`,
          { stepId: step.id },
        );
      }
      return state.lastValue;
    }
    case 'literal':
      return binding.value;
  }
}

/* ------------------------------------------------------------------ */
/* Source resolution                                                   */
/* ------------------------------------------------------------------ */

function decodeSourceText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { ok: true, text: decoder.decode(bytes) };
  } catch {
    return { ok: false, error: 'source bytes are not valid UTF-8 text' };
  }
}

function normalizeMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

function mimeAccepted(mime: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  const base = normalizeMime(mime);
  return patterns.some((pattern) => {
    const candidate = normalizeMime(pattern);
    if (candidate === base || candidate === '*/*') return true;
    if (candidate.endsWith('/*')) return base.startsWith(candidate.slice(0, -1));
    return false;
  });
}

async function resolveSourceBindings(
  recipe: Recipe,
  validation: RecipeInputValidation,
  taskId: TaskId,
  deps: RecipeExecutionDeps,
): Promise<{
  errors: string[];
  bindings: SourceBindings;
  cache: SourceCache;
  meta: Record<string, RecipeSourceMeta>;
}> {
  const errors: string[] = [];
  const bindings: SourceBindings = {};
  const cache: SourceCache = new Map();
  const meta: Record<string, RecipeSourceMeta> = {};

  const sourceParams = recipe.inputParameters.filter(
    (parameter) => parameter.type === 'source' && validation.normalized[parameter.name] !== undefined,
  );
  if (sourceParams.length === 0) return { errors, bindings, cache, meta };

  let items: SourceItem[] | null = null;
  let listFailure: string | null = null;
  try {
    items = await deps.sources.listSources(taskId);
  } catch (error) {
    listFailure = `source list could not be read: ${errorMessage(error)}`;
  }

  for (const parameter of sourceParams) {
    const parsed = parseSourceInput(validation.normalized[parameter.name]);
    if (!parsed.ok) {
      errors.push(`source parameter "${parameter.name}": ${parsed.error}`);
      continue;
    }
    if (listFailure !== null) {
      errors.push(`source parameter "${parameter.name}": ${listFailure}`);
      continue;
    }
    const item = (items ?? []).find((candidate) => candidate.id === parsed.value.sourceId);
    if (!item) {
      errors.push(
        `source parameter "${parameter.name}": source ${parsed.value.sourceId} does not exist in task ${taskId} (task ownership check)`,
      );
      continue;
    }
    const version = parsed.value.version ?? item.version;
    if (item.availability !== 'available') {
      errors.push(`source parameter "${parameter.name}": source "${item.name}" is ${item.availability}`);
      continue;
    }
    if (!mimeAccepted(item.mime, parameter.acceptsMime)) {
      errors.push(
        `source parameter "${parameter.name}": source "${item.name}" has mime "${item.mime}" but the parameter only accepts ${parameter.acceptsMime.join(', ')}`,
      );
      continue;
    }
    let loaded: { source: SourceItem; bytes: Uint8Array } | null = null;
    try {
      loaded = await deps.sources.getSource(taskId, item.id, version);
    } catch (error) {
      errors.push(`source parameter "${parameter.name}": reading source failed: ${errorMessage(error)}`);
      continue;
    }
    if (!loaded) {
      errors.push(
        `source parameter "${parameter.name}": source "${item.name}" version ${version} is not readable`,
      );
      continue;
    }
    if (loaded.bytes.length > LIMITS.maxSourceFileBytes) {
      errors.push(`source parameter "${parameter.name}": source is larger than ${LIMITS.maxSourceFileBytes} bytes`);
      continue;
    }
    const decoded = decodeSourceText(loaded.bytes);
    if (!decoded.ok) {
      errors.push(`source parameter "${parameter.name}": ${decoded.error}`);
      continue;
    }
    cache.set(sourceKey(item.id, version), { source: loaded.source, version, text: decoded.text });
    bindings[parameter.name] = { sourceId: item.id, version };
    meta[parameter.name] = {
      sourceId: item.id,
      name: item.name,
      mime: item.mime,
      version,
      sizeBytes: loaded.bytes.length,
    };
  }
  return { errors, bindings, cache, meta };
}

interface ResolvedSourceRef {
  sourceId: SourceId;
  version: number;
  paramName: string | null;
}

async function ensureSourceEntry(env: ExecutionEnvironment, ref: ResolvedSourceRef): Promise<SourceCacheEntry> {
  const cached = env.cache.get(sourceKey(ref.sourceId, ref.version));
  if (cached) return cached;
  let version = ref.version;
  if (!version || version <= 0) {
    let items: SourceItem[] = [];
    try {
      items = await env.deps.sources.listSources(env.taskId);
    } catch (error) {
      throw new RecipeRuntimeError('step_failed', `could not list sources: ${errorMessage(error)}`, { retryable: true });
    }
    const item = items.find((candidate) => candidate.id === ref.sourceId);
    if (!item) {
      throw new RecipeRuntimeError(
        'invalid_input',
        `source ${ref.sourceId} does not exist in task ${env.taskId}`,
      );
    }
    version = item.version;
  }
  let loaded: { source: SourceItem; bytes: Uint8Array } | null = null;
  try {
    loaded = await env.deps.sources.getSource(env.taskId, ref.sourceId, version);
  } catch (error) {
    throw new RecipeRuntimeError('step_failed', `reading source ${ref.sourceId} failed: ${errorMessage(error)}`, {
      retryable: true,
    });
  }
  if (!loaded) {
    throw new RecipeRuntimeError('invalid_input', `source ${ref.sourceId} version ${version} is not readable`);
  }
  const decoded = decodeSourceText(loaded.bytes);
  if (!decoded.ok) throw new RecipeRuntimeError('invalid_input', decoded.error);
  const entry: SourceCacheEntry = { source: loaded.source, version, text: decoded.text };
  env.cache.set(sourceKey(ref.sourceId, version), entry);
  return entry;
}

async function resolveSourceRef(
  binding: RecipeBinding,
  env: ExecutionEnvironment,
  state: ExecutionState,
  step: RecipeStep,
): Promise<ResolvedSourceRef> {
  if (binding.kind === 'parameter') {
    const bound = env.bindings[binding.name];
    if (bound && bound.version > 0) return { ...bound, paramName: binding.name };
    const raw = env.params[binding.name];
    if (raw === undefined) {
      throw new RecipeRuntimeError('binding_unresolved', `step "${step.id}" needs source parameter "${binding.name}" but it has no value`, {
        stepId: step.id,
      });
    }
    const parsed = parseSourceInput(raw);
    if (!parsed.ok) {
      throw new RecipeRuntimeError('invalid_input', `step "${step.id}": ${parsed.error}`, { stepId: step.id });
    }
    return { sourceId: parsed.value.sourceId, version: parsed.value.version ?? 0, paramName: binding.name };
  }
  const value = resolveBinding(binding, env, state, step);
  if (isPlainRecord(value) && typeof value.sourceId === 'string') {
    const parsed = parseSourceInput(value);
    if (parsed.ok) return { ...parsed.value, version: parsed.value.version ?? 0, paramName: null };
  }
  throw new RecipeRuntimeError(
    'binding_unresolved',
    `step "${step.id}" source binding did not resolve to a source reference`,
    { stepId: step.id },
  );
}

/* ------------------------------------------------------------------ */
/* Source read / search helpers                                        */
/* ------------------------------------------------------------------ */

const LOCATOR_PATTERN = /^(text_lines|lines|csv_rows|csv_key|json_pointer)\s*:\s*(.*)$/i;

function lineCount(text: string): number {
  if (text.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
  return count;
}

function newlinePositions(text: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') positions.push(i);
  return positions;
}

function lineNumberAt(positions: readonly number[], offset: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (positions[mid]! < offset) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

interface SourceRegion {
  locator: SourceLocator;
  content: string;
  truncated: boolean;
  totalChars: number;
}

function readSourceRegion(entry: SourceCacheEntry, locatorText: string | null, maxChars: number): SourceRegion {
  const text = entry.text;
  if (locatorText === null || locatorText.trim() === '') {
    const content = truncateText(text, maxChars);
    return {
      locator: { kind: 'text_lines', startLine: 1, endLine: lineCount(text) },
      content,
      truncated: text.length > content.length,
      totalChars: text.length,
    };
  }
  const match = LOCATOR_PATTERN.exec(locatorText.trim());
  if (!match) {
    throw new RecipeRuntimeError(
      'invalid_input',
      `unsupported locator "${locatorText}"; expected text_lines:a-b, csv_rows:1,2, json_pointer:/a/b or csv_key:column=value`,
    );
  }
  const kind = match[1]!.toLowerCase();
  const body = match[2]!.trim();
  try {
    if (kind === 'text_lines' || kind === 'lines') {
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(body);
      if (!range) throw new RecipeRuntimeError('invalid_input', `invalid text_lines locator "${body}"`);
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start) throw new RecipeRuntimeError('invalid_input', `invalid line range ${body}`);
      const lines = text.split(/\r?\n/);
      if (start > lines.length) throw new RecipeRuntimeError('invalid_input', `line ${start} is out of range (1..${lines.length})`);
      const slice = lines.slice(start - 1, Math.min(end, lines.length)).join('\n');
      const content = truncateText(slice, maxChars);
      return {
        locator: { kind: 'text_lines', startLine: start, endLine: Math.min(end, lines.length) },
        content,
        truncated: slice.length > content.length,
        totalChars: slice.length,
      };
    }
    if (kind === 'csv_rows') {
      const rowNumbers = body
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((part) => Number(part));
      if (rowNumbers.length === 0 || rowNumbers.some((row) => !Number.isInteger(row) || row <= 0)) {
        throw new RecipeRuntimeError('invalid_input', `invalid csv_rows locator "${body}"`);
      }
      const parsed = parseCsv(text);
      const region = csvRowsRegion(parsed, rowNumbers);
      const content = truncateText(region, maxChars);
      return {
        locator: { kind: 'csv_rows', rowNumbers: rowNumbers.slice(0, 1000) },
        content,
        truncated: region.length > content.length,
        totalChars: region.length,
      };
    }
    if (kind === 'csv_key') {
      const split = /^([^=]+)=(.*)$/.exec(body);
      if (!split) throw new RecipeRuntimeError('invalid_input', `invalid csv_key locator "${body}"`);
      const column = split[1]!.trim();
      const value = split[2]!;
      const parsed = parseCsv(text);
      const columnIndex = parsed.header.indexOf(column);
      if (columnIndex < 0) {
        throw new RecipeRuntimeError('invalid_input', `csv_key column "${column}" does not exist in the source header`);
      }
      const rowIndex = parsed.rows.findIndex((row) => (row[columnIndex] ?? '').trim() === value.trim());
      if (rowIndex < 0) throw new RecipeRuntimeError('invalid_input', `csv_key ${column}=${value} was not found`);
      const region = csvRowsRegion(parsed, [rowIndex + 1]);
      const content = truncateText(region, maxChars);
      return {
        locator: { kind: 'csv_key', primaryKeyColumn: column, primaryKeyValue: value.slice(0, LIMITS.maxCsvFieldChars) },
        content,
        truncated: region.length > content.length,
        totalChars: region.length,
      };
    }
    // json_pointer
    const pointer = body;
    if (pointer !== '' && !pointer.startsWith('/')) {
      throw new RecipeRuntimeError('invalid_input', `invalid json_pointer "${pointer}"`);
    }
    const parsedJson = parseBoundedJson(text);
    let current: JsonValue = parsedJson;
    if (pointer.length > 0) {
      for (const rawToken of pointer.slice(1).split('/')) {
        const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
        if (Array.isArray(current)) {
          const index = Number(token);
          if (!Number.isInteger(index) || index < 0 || index >= current.length) {
            throw new RecipeRuntimeError('invalid_input', `json_pointer segment "${token}" is out of range`);
          }
          current = current[index]!;
        } else if (isPlainRecord(current)) {
          if (!Object.prototype.hasOwnProperty.call(current, token)) {
            throw new RecipeRuntimeError('invalid_input', `json_pointer segment "${token}" does not exist`);
          }
          current = current[token] as JsonValue;
        } else {
          throw new RecipeRuntimeError('invalid_input', `json_pointer segment "${token}" cannot be resolved`);
        }
      }
    }
    const serialized = JSON.stringify(current) ?? 'null';
    const content = truncateText(serialized, maxChars);
    return {
      locator: { kind: 'json_pointer', pointer: pointer.slice(0, 2048) },
      content,
      truncated: serialized.length > content.length,
      totalChars: serialized.length,
    };
  } catch (error) {
    if (error instanceof RecipeRuntimeError) throw error;
    throw new RecipeRuntimeError('invalid_input', `locator "${locatorText}" could not be resolved: ${errorMessage(error)}`);
  }
}

interface SearchHitValue {
  spanId: string;
  sourceId: SourceId;
  version: number;
  locator: SourceLocator;
  excerpt: string;
  quoteHash: string;
  score: number;
}

function searchSourceText(entry: SourceCacheEntry, query: string, limit: number): { hits: SearchHitValue[]; spans: SourceSpan[] } {
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new RecipeRuntimeError('invalid_input', 'source.search query must not be empty');
  const positions = newlinePositions(entry.text);
  const lowerText = entry.text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const hits: SearchHitValue[] = [];
  const spans: SourceSpan[] = [];
  let cursor = 0;
  while (hits.length < limit) {
    const index = lowerText.indexOf(lowerQuery, cursor);
    if (index < 0) break;
    const line = lineNumberAt(positions, index);
    const excerpt = excerptAround(entry.text, index, LIMITS.previewExcerptChars);
    const quoteHash = sha256Hex(excerpt);
    const spanId = SourceSpanIdSchema.parse(deterministicUuid(`span|${entry.source.id}|${entry.version}|${line}|${quoteHash}`));
    const locator: SourceLocator = { kind: 'text_lines', startLine: line, endLine: line };
    hits.push({
      spanId,
      sourceId: entry.source.id,
      version: entry.version,
      locator,
      excerpt,
      quoteHash,
      score: Number((1 / (hits.length + 1)).toFixed(6)),
    });
    spans.push({ id: spanId, sourceId: entry.source.id, version: entry.version, locator, quoteHash, excerpt, createdAt: new Date(0).toISOString() });
    cursor = index + Math.max(1, lowerQuery.length);
  }
  return { hits, spans };
}

/* ------------------------------------------------------------------ */
/* Table materialization for data.profile / data.transform             */
/* ------------------------------------------------------------------ */

function lookupParameter(env: ExecutionEnvironment, name: string): RecipeParameter | null {
  return env.recipe.inputParameters.find((parameter) => parameter.name === name) ?? null;
}

function sniffFormat(value: unknown): 'csv' | 'json' {
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'csv';
  }
  if (Array.isArray(value)) return 'json';
  if (isModuleContent(value)) return value.kind === 'json' ? 'json' : 'csv';
  if (isPlainRecord(value) && ('kind' in value || 'value' in value) && !isTableData(value)) return 'json';
  return 'csv';
}

function inferFormatFromSource(entry: SourceCacheEntry, parameterName: string): 'csv' | 'json' {
  const mime = normalizeMime(entry.source.mime);
  if (mime === 'text/csv' || mime === 'application/csv') return 'csv';
  if (mime === 'application/json' || mime === 'text/json') return 'json';
  const name = entry.source.name.toLowerCase();
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.json')) return 'json';
  throw new RecipeRuntimeError(
    'invalid_input',
    `source parameter "${parameterName}": cannot infer a table format from mime "${entry.source.mime}" and name "${entry.source.name}"`,
  );
}

interface MaterializedTable {
  table: TableData;
  sourceRef: { sourceId: SourceId; version: number } | null;
  format: 'csv' | 'json';
}

async function materializeTable(
  binding: RecipeBinding,
  env: ExecutionEnvironment,
  state: ExecutionState,
  step: RecipeStep,
  formatHint: 'csv' | 'json' | null,
  issues: string[],
): Promise<MaterializedTable> {
  if (binding.kind === 'parameter') {
    const parameter = lookupParameter(env, binding.name);
    const raw = env.params[binding.name];
    if (raw === undefined) {
      throw new RecipeRuntimeError('binding_unresolved', `step "${step.id}" references parameter "${binding.name}" without a value`, {
        stepId: step.id,
      });
    }
    if (parameter?.type === 'source') {
      const ref = await resolveSourceRef(binding, env, state, step);
      const entry = await ensureSourceEntry(env, ref);
      const format = formatHint ?? inferFormatFromSource(entry, binding.name);
      const table = coerceTableFromText(entry.text, format, issues);
      return { table, sourceRef: { sourceId: entry.source.id, version: entry.version }, format };
    }
    const format = formatHint ?? sniffFormat(raw);
    return { table: coerceTable(raw, { format, issues }), sourceRef: null, format };
  }
  const value = resolveBinding(binding, env, state, step);
  const format = formatHint ?? sniffFormat(value);
  return { table: coerceTable(value, { format, issues }), sourceRef: null, format };
}

/* ------------------------------------------------------------------ */
/* Data-shape preflight (field mapping gate)                           */
/* ------------------------------------------------------------------ */

/**
 * Deterministic field-mapping preflight for source-bound transform steps.
 *
 * A rename operation that silently matches nothing would leave the canonical
 * columns missing and each later operator would fail with a generic "unknown
 * column" message. This gate explains the real problem instead: the source
 * header contains none of the expected aliases for a required canonical field
 * (for example a CSV without a `system_id` mapping).
 */
function transformColumnPreflight(
  recipe: Recipe,
  cache: SourceCache,
  bindings: SourceBindings,
): string[] {
  const errors: string[] = [];
  for (const step of recipe.steps) {
    if (step.kind !== 'data.transform' || step.input.kind !== 'parameter') continue;
    const inputBinding = step.input;
    const parameter = recipe.inputParameters.find((candidate) => candidate.name === inputBinding.name);
    if (!parameter || parameter.type !== 'source') continue;
    const bound = bindings[parameter.name];
    if (!bound) continue;
    const entry = cache.get(sourceKey(bound.sourceId, bound.version));
    if (!entry) continue;
    let header: string[];
    try {
      header = coerceTableFromText(entry.text, step.format).columns.map((column) => column.key);
    } catch {
      // Parsing problems are reported by the dry-run pipeline itself.
      continue;
    }
    const rename = step.operations.find((operation) => operation.op === 'rename');
    if (!rename || rename.op !== 'rename') continue;
    const aliasesFor = new Map<string, string[]>();
    for (const [alias, target] of Object.entries(rename.mapping)) {
      const list = aliasesFor.get(target) ?? [];
      list.push(alias);
      aliasesFor.set(target, list);
    }
    const afterRename = new Set(header);
    for (const [alias, target] of Object.entries(rename.mapping)) {
      if (afterRename.has(alias)) {
        afterRename.delete(alias);
        afterRename.add(target);
      }
    }
    const required = new Set<string>();
    for (const operation of step.operations) {
      switch (operation.op) {
        case 'dedupe':
          for (const key of operation.keys) required.add(key);
          break;
        case 'require':
          for (const column of operation.columns) required.add(column);
          break;
        case 'normalize':
        case 'cast':
        case 'fill':
        case 'map':
        case 'sort':
        case 'filter':
          required.add(operation.column);
          break;
        case 'select':
          for (const column of operation.columns) required.add(column);
          break;
        default:
          break;
      }
    }
    for (const target of [...required].sort()) {
      if (afterRename.has(target)) continue;
      const aliases = aliasesFor.get(target) ?? [];
      if (aliases.length > 0) {
        errors.push(
          `step "${step.id}" (data.transform): missing ${target} mapping — the source header has none of the expected aliases (${aliases.join(', ')}); available columns: ${header.join(', ')}`,
        );
      } else {
        errors.push(
          `step "${step.id}" (data.transform): required column "${target}" is missing from the source header; available columns: ${header.join(', ')}`,
        );
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Validators                                                          */
/* ------------------------------------------------------------------ */

interface ValidatorRunResult {
  id: string;
  ok: boolean;
  findings: string[];
}

function runBuiltinValidators(ids: readonly string[], value: unknown): ValidatorRunResult[] {
  return ids.map((id) => {
    const validator = BUILTIN_VALIDATORS[id];
    if (!validator) {
      throw new RecipeRuntimeError('validator_unavailable', `validator "${id}" is not shipped by this runtime`, {
        details: { validatorId: id },
      });
    }
    try {
      const result = validator.check(value);
      return { id, ok: result.ok, findings: result.findings.slice(0, 20).map((finding) => bound(finding, 500)) };
    } catch (error) {
      return { id, ok: false, findings: [`validator crashed: ${errorMessage(error)}`] };
    }
  });
}

/* ------------------------------------------------------------------ */
/* Step execution                                                      */
/* ------------------------------------------------------------------ */

function checkStepBudget(recipe: Recipe, state: ExecutionState, step: RecipeStep): void {
  const toolId = TOOL_ID_BY_STEP_KIND[step.kind];
  if (toolId) {
    const limit = recipe.budget.maxToolCalls;
    if (state.toolCalls + 1 > limit) {
      throw new RecipeRuntimeError(
        'budget_exhausted',
        `tool call budget exhausted: step "${step.id}" would be call ${state.toolCalls + 1} of maxToolCalls=${limit}`,
        { details: { budget: 'maxToolCalls', limit, used: state.toolCalls, stepId: step.id }, stepId: step.id },
      );
    }
  }
  if (step.kind === 'llm.step') {
    const permissionLimit = recipe.permissions.allowModelCalls ? recipe.permissions.maxModelCallsPerRun : 0;
    const effectiveLimit = Math.min(recipe.budget.maxModelCalls, permissionLimit);
    if (state.llmCalls + 1 > effectiveLimit) {
      throw new RecipeRuntimeError(
        'budget_exhausted',
        `model call budget exhausted: step "${step.id}" would be call ${state.llmCalls + 1} of maxModelCalls=${effectiveLimit}`,
        { details: { budget: 'maxModelCalls', limit: effectiveLimit, used: state.llmCalls, stepId: step.id }, stepId: step.id },
      );
    }
  }
}

function summarizeForModel(value: unknown, maxChars: number): string {
  if (typeof value === 'string') return truncateText(value, maxChars);
  if (isTableData(value)) {
    return truncateText(
      `${value.rows.length} rows × ${value.columns.length} columns; columns: ${value.columns.map((column) => column.key).join(', ')}`,
      maxChars,
    );
  }
  if (isPlainRecord(value)) {
    if (isModuleContent(value)) {
      return summarizeForModel(
        value.kind === 'markdown'
          ? value.sections.map((section) => `${section.title}\n${section.markdown}`).join('\n')
          : value.kind === 'csv'
            ? { columns: value.columns, rows: value.rows }
            : value.value,
        maxChars,
      );
    }
    if (typeof value.text === 'string') return truncateText(value.text, maxChars);
    try {
      return truncateText(canonicalJson(value), maxChars);
    } catch {
      return '<unserializable object>';
    }
  }
  if (value === undefined) return '';
  return truncateText(String(value), maxChars);
}

async function callModelStep(
  step: Extract<RecipeStep, { kind: 'llm.step' }>,
  env: ExecutionEnvironment,
  state: ExecutionState,
): Promise<{ text: string; modelCalls: number }> {
  if (!env.deps.runModelStep) {
    throw new RecipeRuntimeError(
      'model_step_unavailable',
      'this llm_assisted recipe requires a model executor, but RecipeExecutionDeps.runModelStep was not provided',
      { details: { stepId: step.id, promptTemplateId: step.promptTemplateId }, stepId: step.id },
    );
  }
  checkAborted(env.signal, step.id);
  const inputValue = resolveBinding(step.input, env, state, step);
  const inputSummary = summarizeForModel(inputValue, 4000);
  const abortController = new AbortController();
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      reject(new RecipeRuntimeError('aborted', 'recipe run was aborted during a model step', { retryable: true, stepId: step.id }));
    };
    if (env.signal.aborted) onAbort();
    else env.signal.addEventListener('abort', onAbort, { once: true });
    abortController.signal.addEventListener('abort', () => env.signal.removeEventListener('abort', onAbort), { once: true });
  });
  let result: { text: string; modelCalls: number };
  try {
    result = await Promise.race([
      env.deps.runModelStep({
        taskId: env.taskId,
        runId: env.runId,
        promptTemplateId: step.promptTemplateId,
        promptVersion: step.promptVersion,
        instruction: step.instruction,
        inputSummary,
        maxOutputTokens: step.maxOutputTokens,
      }),
      abortPromise,
    ]);
  } finally {
    abortController.abort();
  }
  if (!result || typeof result.text !== 'string' || !Number.isInteger(result.modelCalls) || result.modelCalls < 0) {
    throw new RecipeRuntimeError('step_failed', `model step "${step.id}" returned an invalid result`, { stepId: step.id });
  }
  return result;
}

async function executeStep(step: RecipeStep, env: ExecutionEnvironment, state: ExecutionState): Promise<StepResult> {
  switch (step.kind) {
    case 'source.read': {
      const ref = await resolveSourceRef(step.source, env, state, step);
      const entry = await ensureSourceEntry(env, ref);
      const maxChars = Math.min(Math.max(step.maxChars, 1), 20_000);
      const region = readSourceRegion(entry, step.locator, maxChars);
      return {
        value: {
          sourceId: entry.source.id,
          version: entry.version,
          locator: region.locator,
          content: region.content,
          truncated: region.truncated,
          totalChars: region.totalChars,
          trust: 'untrusted_content',
        },
        issues: [],
        objectHash: null,
        rowCount: null,
        toolCalls: 1,
        modelCalls: 0,
      };
    }
    case 'source.search': {
      const ref = await resolveSourceRef(step.source, env, state, step);
      const entry = await ensureSourceEntry(env, ref);
      const { hits, spans } = searchSourceText(entry, step.query, step.limit);
      if (!env.dryRun) {
        for (const span of spans) {
          try {
            await env.deps.sources.saveSpan({ ...span, createdAt: env.deps.now() });
          } catch (error) {
            throw new RecipeRuntimeError('step_failed', `persisting source evidence span failed: ${errorMessage(error)}`, {
              retryable: true,
              stepId: step.id,
            });
          }
        }
      }
      return {
        value: { query: step.query, hits, searchedSources: [entry.source.id] },
        issues: [],
        objectHash: null,
        rowCount: null,
        toolCalls: 1,
        modelCalls: 0,
      };
    }
    case 'data.profile': {
      const issues: string[] = [];
      const materialized = await materializeTable(step.input, env, state, step, null, issues);
      const summary = profileTableData(materialized.table);
      const value = {
        format: materialized.format,
        sourceId: materialized.sourceRef?.sourceId ?? null,
        version: materialized.sourceRef?.version ?? null,
        rowCount: materialized.table.rows.length,
        columnCount: materialized.table.columns.length,
        columns: summary.columns,
        duplicateRowCount: summary.duplicateRowCount,
        missingRequiredCount: summary.missingRequiredCount,
        issues: [...issues, ...summary.issues].slice(0, 100),
        // Keep the parsed table so a downstream data.transform can bind
        // previous_step without re-reading the source or inventing a format.
        table: materialized.table,
      };
      return {
        value,
        issues: value.issues.slice(0, MAX_OBSERVED_ISSUES),
        objectHash: null,
        rowCount: materialized.table.rows.length,
        toolCalls: 1,
        modelCalls: 0,
      };
    }
    case 'data.transform': {
      const issues: string[] = [];
      const materialized = await materializeTable(step.input, env, state, step, step.format, issues);
      // Structural operator errors (unknown column, unsafe regex, ...) are
      // mapped to a structured recipe error once by executePipeline.
      const outcome = applyTransformOperations(materialized.table, step.operations);
      const allIssues = [...issues, ...outcome.issues].slice(0, 200).map((issue) => bound(issue, 500));
      const serialized = serializeTransformedTable(outcome.table, step.format);
      if (serialized.bytes.length > LIMITS.maxSourceFileBytes) {
        throw new RecipeRuntimeError(
          'invalid_input',
          `transformed output is ${serialized.bytes.length} bytes (limit ${LIMITS.maxSourceFileBytes})`,
          { stepId: step.id },
        );
      }
      const normalizedHash = canonicalJsonHash({ columns: outcome.table.columns, rows: outcome.table.rows });
      let objectHash = normalizedHash;
      if (!env.dryRun) {
        try {
          const stored = await env.deps.objects.put(serialized.bytes, serialized.mime);
          objectHash = stored.hash;
        } catch (error) {
          throw new RecipeRuntimeError('step_failed', `writing transformed output object failed: ${errorMessage(error)}`, {
            retryable: true,
            stepId: step.id,
          });
        }
      }
      return {
        value: {
          table: outcome.table,
          issues: allIssues,
          format: step.format,
          outputName: step.outputName,
          rowCount: outcome.table.rows.length,
          objectHash,
          normalizedHash,
        },
        issues: allIssues.slice(0, MAX_OBSERVED_ISSUES),
        objectHash,
        rowCount: outcome.table.rows.length,
        toolCalls: 1,
        modelCalls: 0,
      };
    }
    case 'artifact.read': {
      const reference = resolveModuleBinding(step.module, env, state, step);
      const module = await env.deps.artifacts.getModule(reference.moduleId);
      if (!module) {
        throw new RecipeRuntimeError('step_failed', `artifact module ${reference.moduleId} does not exist`, { stepId: step.id });
      }
      const version = reference.versionId
        ? await env.deps.artifacts.getVersion(reference.versionId)
        : await env.deps.artifacts.getAcceptedVersion(reference.moduleId);
      if (!version) {
        throw new RecipeRuntimeError(
          'step_failed',
          reference.versionId
            ? `artifact version ${reference.versionId} does not exist`
            : `artifact module ${reference.moduleId} has no accepted version`,
          { stepId: step.id },
        );
      }
      const hash = contentHash(version.content);
      return {
        value: {
          moduleId: reference.moduleId,
          versionId: version.id,
          content: version.content,
          contentHash: hash,
          moduleKind: version.content.kind,
          dependencies: module.dependencies,
        },
        issues: [],
        objectHash: hash,
        rowCount: rowCountOfContent(version.content),
        toolCalls: 1,
        modelCalls: 0,
      };
    }
    case 'llm.step': {
      if (env.dryRun) throw new StopPreflight();
      const result = await callModelStep(step, env, state);
      return {
        value: { text: result.text, modelCalls: result.modelCalls },
        issues: [],
        objectHash: null,
        rowCount: null,
        toolCalls: 0,
        modelCalls: result.modelCalls,
      };
    }
    case 'validate': {
      const results = runBuiltinValidators(step.validators, state.lastValue);
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        throw new RecipeRuntimeError(
          'validation_failed',
          `deterministic validation failed: ${failed
            .map((result) => `${result.id}${result.findings.length > 0 ? ` (${result.findings.slice(0, 3).join('; ')})` : ''}`)
            .join(' | ')}`,
          {
            stepId: step.id,
            details: { validatorIds: failed.map((result) => result.id) },
          },
        );
      }
      // validate is a transparent pass-through: downstream steps keep binding
      // the same value while the validation findings stay in the run ledger.
      return {
        value: state.lastValue,
        issues: [],
        objectHash: null,
        rowCount: null,
        toolCalls: 0,
        modelCalls: 0,
      };
    }
    case 'emit_artifact': {
      if (step.moduleKind !== env.recipe.outputArtifactKind) {
        throw new RecipeRuntimeError(
          'output_kind_mismatch',
          `step "${step.id}" emits ${step.moduleKind} but the recipe declares outputArtifactKind "${env.recipe.outputArtifactKind}"`,
          { stepId: step.id },
        );
      }
      const raw = await resolveEmitValue(step, env, state);
      const content = parseContent(coerceModuleContent(raw, step.moduleKind, step.artifactName), step.artifactName);
      assertModuleKind(content, step.moduleKind, step.artifactName);
      const expectedHash = contentHash(content);
      if (!env.dryRun) {
        let stored: { hash: string };
        try {
          stored = await env.deps.objects.put(serializeModuleContent(content), DEFAULT_ARTIFACT_MIME);
        } catch (error) {
          throw new RecipeRuntimeError('step_failed', `writing emitted artifact object failed: ${errorMessage(error)}`, {
            retryable: true,
            stepId: step.id,
          });
        }
        if (stored.hash !== expectedHash) {
          throw new RecipeRuntimeError(
            'internal_error',
            `object store hash ${stored.hash} does not match the content hash ${expectedHash}`,
            { stepId: step.id },
          );
        }
      }
      const output = outputFromContent(content, step.artifactName);
      return {
        value: { content, output },
        issues: [],
        objectHash: output.objectHash,
        rowCount: output.rowCount,
        toolCalls: 0,
        modelCalls: 0,
      };
    }
  }
}

function resolveModuleBinding(
  binding: RecipeBinding,
  env: ExecutionEnvironment,
  state: ExecutionState,
  step: RecipeStep,
): { moduleId: ModuleId; versionId: string | null } {
  const value = resolveBinding(binding, env, state, step);
  let moduleIdRaw: unknown;
  let versionId: string | null = null;
  if (typeof value === 'string') {
    moduleIdRaw = value;
  } else if (isPlainRecord(value)) {
    moduleIdRaw = value.moduleId;
    if (typeof value.versionId === 'string') versionId = value.versionId;
  }
  const parsed = ModuleIdSchema.safeParse(moduleIdRaw);
  if (!parsed.success) {
    throw new RecipeRuntimeError('binding_unresolved', `step "${step.id}" module binding is not a valid module id`, {
      stepId: step.id,
    });
  }
  return { moduleId: parsed.data, versionId };
}

/** Resolve the value of an emit_artifact step, including a direct source read. */
async function resolveEmitValue(
  step: Extract<RecipeStep, { kind: 'emit_artifact' }>,
  env: ExecutionEnvironment,
  state: ExecutionState,
): Promise<unknown> {
  const binding = step.input;
  if (binding.kind === 'parameter') {
    const parameter = lookupParameter(env, binding.name);
    if (parameter?.type === 'source') {
      const ref = await resolveSourceRef(binding, env, state, step);
      const entry = await ensureSourceEntry(env, ref);
      if (step.moduleKind === 'csv') {
        const issues: string[] = [];
        return coerceTableFromText(entry.text, 'csv', issues);
      }
      if (step.moduleKind === 'json') {
        try {
          return parseBoundedJson(entry.text);
        } catch (error) {
          throw new RecipeRuntimeError('invalid_input', `emit source is not valid JSON: ${errorMessage(error)}`, {
            stepId: step.id,
          });
        }
      }
      return { text: entry.text };
    }
  }
  return resolveBinding(binding, env, state, step);
}

function serializeTransformedTable(table: TableData, format: 'csv' | 'json'): { bytes: Uint8Array; mime: string } {
  if (format === 'csv') return { bytes: utf8Encode(tableToCsv(table)), mime: 'text/csv' };
  return { bytes: utf8Encode(canonicalJson(tableToJsonValue(table))), mime: 'application/json' };
}

function normalizeStepError(step: RecipeStep, error: unknown): RecipeRuntimeError {
  if (error instanceof RecipeRuntimeError) {
    if (error.code === 'aborted') return error;
    return new RecipeRuntimeError(error.code, `step "${step.id}" (${step.kind}): ${error.message}`, {
      retryable: error.retryable,
      details: error.details,
      stepId: step.id,
      cause: error,
    });
  }
  if (error instanceof DataFormatError || error instanceof TableTransformError) {
    return new RecipeRuntimeError(mapDataErrorCode(error.code), `step "${step.id}" (${step.kind}) failed: ${error.message}`, {
      details: { stepId: step.id, cause: error.code },
      stepId: step.id,
      cause: error,
    });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new RecipeRuntimeError('aborted', `step "${step.id}" was aborted`, { retryable: true, stepId: step.id });
  }
  return new RecipeRuntimeError('step_failed', `step "${step.id}" (${step.kind}) failed: ${errorMessage(error)}`, {
    stepId: step.id,
    cause: error,
  });
}

/* ------------------------------------------------------------------ */
/* Pipeline execution                                                  */
/* ------------------------------------------------------------------ */

async function executePipeline(recipe: Recipe, env: ExecutionEnvironment, state: ExecutionState): Promise<void> {
  for (const step of recipe.steps) {
    checkAborted(env.signal, step.id);
    if (!env.dryRun) {
      const elapsed = nowMs() - env.startedMs;
      if (elapsed > recipe.budget.maxRuntimeMs) {
        throw new RecipeRuntimeError(
          'budget_exhausted',
          `runtime budget exhausted after ${Math.round(elapsed)}ms (maxRuntimeMs=${recipe.budget.maxRuntimeMs}) before step "${step.id}"`,
          {
            stepId: step.id,
            details: { budget: 'maxRuntimeMs', limit: recipe.budget.maxRuntimeMs, stepId: step.id },
          },
        );
      }
      checkStepBudget(recipe, state, step);
    }
    if (step.when && !evaluateRecipeGuard(step.when, env.params)) {
      emitObservation(env, {
        stepId: step.id,
        kind: step.kind,
        status: 'skipped',
        issues: [],
        objectHash: null,
        rowCount: null,
        durationMs: 0,
      });
      continue;
    }
    const started = nowMs();
    try {
      const result = await executeStep(step, env, state);
      state.lastValue = result.value;
      state.lastStepId = step.id;
      state.values.set(step.id, result.value);
      if (result.toolCalls > 0) state.toolCalls += result.toolCalls;
      if (result.modelCalls > 0) state.llmCalls += result.modelCalls;
      if (step.kind === 'emit_artifact') {
        const output = (result.value as { output: RecipeRunOutput }).output;
        state.outputs.push(output);
      }
      emitObservation(env, {
        stepId: step.id,
        kind: step.kind,
        status: 'executed',
        issues: result.issues.slice(0, MAX_OBSERVED_ISSUES),
        objectHash: result.objectHash,
        rowCount: result.rowCount,
        durationMs: roundMs(nowMs() - started),
      });
    } catch (error) {
      if (error instanceof StopPreflight) throw error;
      const wrapped = normalizeStepError(step, error);
      emitObservation(env, {
        stepId: step.id,
        kind: step.kind,
        status: 'failed',
        issues: [],
        objectHash: null,
        rowCount: null,
        durationMs: roundMs(nowMs() - started),
      });
      throw wrapped;
    }
  }
  if (!env.dryRun && state.outputs.length === 0) {
    throw new RecipeRuntimeError(
      'missing_output',
      'recipe run finished without emitting an artifact output; a run must produce at least one output',
    );
  }
}

/* ------------------------------------------------------------------ */
/* Result assembly                                                     */
/* ------------------------------------------------------------------ */

function normalizedOutputsHash(outputs: readonly RecipeRunOutput[]): string {
  return canonicalJsonHash(
    outputs.map((output) => ({
      name: output.name,
      moduleKind: output.moduleKind,
      objectHash: output.objectHash,
      rowCount: output.rowCount,
      // Preview is deliberately excluded: it is bounded presentation text.
    })),
  );
}

interface AssembleInput {
  recipe: Recipe;
  runId: RunId;
  outputs: RecipeRunOutput[];
  cacheState: 'executed' | 'cache_hit';
  llmCalls: number;
  toolCalls: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

function assembleRunResult(input: AssembleInput): RecipeRunResult {
  const candidate = {
    recipeId: input.recipe.id,
    recipeVersion: input.recipe.version,
    runId: input.runId,
    cacheState: input.cacheState,
    outputs: input.outputs,
    normalizedOutputHash: normalizedOutputsHash(input.outputs),
    llmCalls: input.llmCalls,
    toolCalls: input.toolCalls,
    durationMs: roundMs(input.durationMs),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
  const parsed = RecipeRunResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RecipeRuntimeError(
      'internal_error',
      `recipe run result violated RecipeRunResultSchema: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

function validateCacheEntry(entry: RecipeCacheEntry | null): entry is RecipeCacheEntry {
  if (!entry || typeof entry !== 'object') return false;
  if (!Array.isArray(entry.outputs) || entry.outputs.length === 0) return false;
  if (typeof entry.normalizedOutputHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.normalizedOutputHash)) return false;
  if (typeof entry.createdAt !== 'string') return false;
  return entry.outputs.every((output) => RecipeRunOutputSchema.safeParse(output).success);
}

/* ------------------------------------------------------------------ */
/* Runtime factory                                                     */
/* ------------------------------------------------------------------ */

interface PreflightInternal {
  ok: boolean;
  errors: string[];
  validation: RecipeInputValidation;
  bindings: SourceBindings;
  cache: SourceCache;
  sourceMeta: Record<string, RecipeSourceMeta>;
  recipe: Recipe;
}

const EMPTY_VALIDATION: RecipeInputValidation = { ok: false, errors: [], normalized: {}, sourceBindings: {} };

export function createRecipeRuntime(options: RecipeRuntimeOptions): RecipeRuntime {
  const deps = options.deps;

  function validateInputs(recipe: Recipe, inputs: JsonObject): RecipeInputValidation {
    const errors: string[] = [];
    const normalized: Record<string, unknown> = {};
    const sourceBindings: RecipeInputValidation['sourceBindings'] = {};
    const declared = new Map(recipe.inputParameters.map((parameter) => [parameter.name, parameter]));
    for (const key of Object.keys(inputs)) {
      if (!declared.has(key)) errors.push(`unknown input parameter "${key}"`);
    }
    for (const parameter of recipe.inputParameters) {
      let raw: unknown = inputs[parameter.name];
      if (raw === undefined || raw === null) {
        if (parameter.defaultValue !== undefined) {
          raw = parameter.defaultValue;
        } else {
          if (parameter.required) errors.push(`missing required input parameter "${parameter.name}"`);
          continue;
        }
      }
      const result = validateParamValue(parameter, raw);
      if (!result.ok) {
        errors.push(`input parameter "${parameter.name}": ${result.error}`);
        continue;
      }
      normalized[parameter.name] = result.value;
      if (parameter.type === 'source') {
        const parsed = parseSourceInput(result.value);
        if (parsed.ok) {
          sourceBindings[parameter.name] = { sourceId: parsed.value.sourceId, version: parsed.value.version ?? 0 };
        }
      }
    }
    return { ok: errors.length === 0, errors, normalized, sourceBindings };
  }

  async function preflightInternal(
    recipe: Recipe,
    inputs: JsonObject,
    ctx: RecipeInputPreflightContext,
  ): Promise<PreflightInternal> {
    const compiled = compileRecipe(recipe, options);
    if (compiled.errors.length > 0) {
      return {
        ok: false,
        errors: compiled.errors,
        validation: { ...EMPTY_VALIDATION, errors: compiled.errors },
        bindings: {},
        cache: new Map(),
        sourceMeta: {},
        recipe: compiled.recipe,
      };
    }
    const normalized = compiled.recipe;
    const validation = validateInputs(normalized, inputs);
    if (!validation.ok) {
      return {
        ok: false,
        errors: validation.errors,
        validation,
        bindings: {},
        cache: new Map(),
        sourceMeta: {},
        recipe: normalized,
      };
    }
    const resolved = await resolveSourceBindings(normalized, validation, ctx.taskId, deps);
    if (resolved.errors.length > 0) {
      return {
        ok: false,
        errors: resolved.errors,
        validation,
        bindings: resolved.bindings,
        cache: resolved.cache,
        sourceMeta: resolved.meta,
        recipe: normalized,
      };
    }
    const shapeErrors = transformColumnPreflight(normalized, resolved.cache, resolved.bindings);
    if (shapeErrors.length > 0) {
      return {
        ok: false,
        errors: shapeErrors,
        validation,
        bindings: resolved.bindings,
        cache: resolved.cache,
        sourceMeta: resolved.meta,
        recipe: normalized,
      };
    }
    const drySignal = ctx.signal ?? new AbortController().signal;
    const env: ExecutionEnvironment = {
      deps,
      recipe: normalized,
      taskId: ctx.taskId,
      runId: deterministicUuid(`preflight|${normalized.id}|${normalized.version}`) as RunId,
      moduleId: normalized.sourceModuleId,
      params: validation.normalized,
      signal: drySignal,
      cache: resolved.cache,
      bindings: resolved.bindings,
      dryRun: true,
      startedMs: nowMs(),
    };
    const state = createExecutionState();
    const errors: string[] = [];
    if (!drySignal.aborted) {
      try {
        await executePipeline(normalized, env, state);
      } catch (error) {
        if (error instanceof StopPreflight) {
          // Preflight cannot execute model steps; everything deterministic before
          // the first model step has already been checked.
        } else if (isAbortLike(error)) {
          throw error;
        } else {
          errors.push(isRecipeRuntimeError(error) ? `${error.code}: ${error.message}` : errorMessage(error));
        }
      }
    }
    return {
      ok: errors.length === 0,
      errors,
      validation,
      bindings: resolved.bindings,
      cache: resolved.cache,
      sourceMeta: resolved.meta,
      recipe: normalized,
    };
  }

  async function preflightInputs(
    recipe: Recipe,
    inputs: JsonObject,
    ctx: RecipeInputPreflightContext,
  ): Promise<RecipeInputPreflightResult> {
    const internal = await preflightInternal(recipe, inputs, ctx);
    return {
      ok: internal.ok,
      errors: internal.errors,
      sourceBindings: internal.bindings,
      sourceMeta: internal.sourceMeta,
    };
  }

  function assertRunnable(recipe: Recipe): void {
    const compiled = compileRecipe(recipe, options);
    if (compiled.errors.length > 0) {
      throw new RecipeRuntimeError(
        'dsl_invalid',
        `recipe "${recipe.id}" cannot run: ${compiled.errors.slice(0, 10).join('; ')}`,
        { details: { errors: compiled.errors.slice(0, 20) } },
      );
    }
    const normalized = compiled.recipe;
    if (!options.allowUnvalidatedRuns && normalized.status !== 'validated') {
      throw new RecipeRuntimeError(
        'recipe_not_validated',
        `recipe "${normalized.name}" has status "${normalized.status}"; only validated recipes may run (design 13.3/13.4)`,
        { details: { status: normalized.status } },
      );
    }
    const staleness = evaluateRecipeStaleness(normalized, currentPins(options));
    if (staleness.stale) {
      throw new RecipeRuntimeError(
        'recipe_stale',
        `recipe "${normalized.name}" is stale and must be re-tested before running: ${staleness.reasons.slice(0, 5).join('; ')}`,
        { details: { reasons: staleness.reasons.slice(0, 20), expectedFingerprint: staleness.expectedFingerprint } },
      );
    }
    if (hasModelStep(normalized) && !deps.runModelStep) {
      throw new RecipeRuntimeError(
        'model_step_unavailable',
        'this recipe contains an llm.step but RecipeExecutionDeps.runModelStep was not provided; the run cannot succeed',
      );
    }
  }

  async function executeRun(
    recipe: Recipe,
    normalizedInputs: Record<string, unknown>,
    ctx: RecipeRunContext,
    pre: PreflightInternal,
  ): Promise<RecipeRunResult> {
    const startedAt = deps.now();
    const startedMs = nowMs();
    const env: ExecutionEnvironment = {
      deps,
      recipe,
      taskId: ctx.taskId,
      runId: ctx.runId,
      moduleId: ctx.moduleId,
      params: normalizedInputs,
      signal: ctx.signal,
      observer: ctx.observer,
      cache: pre.cache,
      bindings: pre.bindings,
      dryRun: false,
      startedMs,
    };
    const state = createExecutionState();
    await executePipeline(recipe, env, state);
    const finishedAt = deps.now();
    return assembleRunResult({
      recipe,
      runId: ctx.runId,
      outputs: state.outputs,
      cacheState: 'executed',
      llmCalls: state.llmCalls,
      toolCalls: state.toolCalls,
      durationMs: nowMs() - startedMs,
      startedAt,
      finishedAt,
    });
  }

  function recipeCacheKey(recipe: Recipe, normalizedParams: Record<string, unknown>, bindings: SourceBindings): string {
    return sha256Hex(
      canonicalJson({
        fingerprint: recipe.fingerprint,
        recipeKind: recipe.kind,
        inputs: normalizedParams,
        sources: bindings,
      }),
    );
  }

  async function run(recipe: Recipe, ctx: RecipeRunContext): Promise<RecipeRunResult> {
    assertRunnable(recipe);
    const compiled = compileRecipe(recipe, options);
    const normalized = compiled.recipe;
    const inputs = (ctx.params ?? {}) as unknown as JsonObject;
    const validation = validateInputs(normalized, inputs);
    if (!validation.ok) {
      throw new RecipeRuntimeError('invalid_input', `recipe inputs are invalid: ${validation.errors.slice(0, 10).join('; ')}`, {
        details: { errors: validation.errors.slice(0, 50) },
      });
    }
    const pre = await preflightInternal(normalized, inputs, { taskId: ctx.taskId, signal: ctx.signal });
    if (!pre.ok) {
      throw new RecipeRuntimeError(
        'invalid_input',
        `recipe input was rejected by deterministic preflight: ${pre.errors.slice(0, 10).join('; ')}`,
        { details: { errors: pre.errors.slice(0, 50) } },
      );
    }
    checkAborted(ctx.signal);
    if (normalized.kind === 'cached_snapshot' && options.cache) {
      const key = recipeCacheKey(normalized, validation.normalized, pre.bindings);
      let entry: RecipeCacheEntry | null = null;
      try {
        entry = await options.cache.get(key);
      } catch {
        entry = null;
      }
      if (validateCacheEntry(entry)) {
        const startedAt = deps.now();
        const startedMs = nowMs();
        const finishedAt = deps.now();
        return assembleRunResult({
          recipe: normalized,
          runId: ctx.runId,
          outputs: entry.outputs,
          cacheState: 'cache_hit',
          llmCalls: 0,
          toolCalls: 0,
          durationMs: nowMs() - startedMs,
          startedAt,
          finishedAt,
        });
      }
    }
    const result = await executeRun(normalized, validation.normalized, ctx, pre);
    if (normalized.kind === 'cached_snapshot' && options.cache) {
      const key = recipeCacheKey(normalized, validation.normalized, pre.bindings);
      try {
        await options.cache.put(key, {
          outputs: result.outputs,
          normalizedOutputHash: result.normalizedOutputHash,
          createdAt: result.finishedAt,
        });
      } catch {
        // Cache writes are an optimization; the executed result stays truthful.
      }
    }
    return result;
  }

  async function validate(
    recipe: Recipe,
    testCases: RecipeTestCase[],
    inputsByCase: Record<string, JsonObject>,
  ): Promise<Recipe> {
    if (!Array.isArray(testCases) || testCases.length === 0 || testCases.length > 16) {
      throw new RecipeRuntimeError(
        'invalid_input',
        `validate() needs 1..16 test cases, received ${Array.isArray(testCases) ? testCases.length : 0}`,
      );
    }
    const compiled = compileRecipe(recipe, options);
    const base = compiled.recipe;
    const compileErrors = compiled.errors;
    const updated: RecipeTestCase[] = [];

    for (const testCase of testCases) {
      const lastRunAt = deps.now();
      const inputs = inputsByCase[testCase.id] ?? testCase.inputs;
      const mismatchedExpectation =
        (testCase.kind === 'invalid' && testCase.expectation !== 'reject') ||
        (testCase.kind !== 'invalid' && testCase.expectation !== 'accept');
      if (compileErrors.length > 0) {
        updated.push({
          ...testCase,
          status: 'failed',
          detail: bound(`recipe is invalid and cannot be tested: ${compileErrors.slice(0, 5).join('; ')}`, 2000),
          normalizedOutputHash: null,
          lastRunAt,
        });
        continue;
      }
      if (mismatchedExpectation) {
        updated.push({
          ...testCase,
          status: 'failed',
          detail: bound(
            `test case kind "${testCase.kind}" does not match expectation "${testCase.expectation}"; invalid cases must expect reject and valid cases must expect accept`,
            2000,
          ),
          normalizedOutputHash: null,
          lastRunAt,
        });
        continue;
      }
      const validation = validateInputs(base, inputs);
      if (!validation.ok) {
        if (testCase.expectation === 'reject') {
          updated.push({
            ...testCase,
            status: 'passed',
            detail: bound(`rejected at input schema validation: ${validation.errors.slice(0, 8).join('; ')}`, 2000),
            normalizedOutputHash: null,
            lastRunAt,
          });
        } else {
          updated.push({
            ...testCase,
            status: 'failed',
            detail: bound(`accept case failed input validation: ${validation.errors.slice(0, 8).join('; ')}`, 2000),
            normalizedOutputHash: null,
            lastRunAt,
          });
        }
        continue;
      }
      const pre = await preflightInternal(base, inputs, {
        taskId: base.sourceTaskId,
        signal: new AbortController().signal,
      });
      if (!pre.ok) {
        if (testCase.expectation === 'reject') {
          updated.push({
            ...testCase,
            status: 'passed',
            detail: bound(`rejected at deterministic input preflight: ${pre.errors.slice(0, 8).join('; ')}`, 2000),
            normalizedOutputHash: null,
            lastRunAt,
          });
        } else {
          updated.push({
            ...testCase,
            status: 'failed',
            detail: bound(`accept case failed input preflight: ${pre.errors.slice(0, 8).join('; ')}`, 2000),
            normalizedOutputHash: null,
            lastRunAt,
          });
        }
        continue;
      }
      if (testCase.expectation === 'reject') {
        updated.push({
          ...testCase,
          status: 'failed',
          detail: 'expected rejection but the deterministic input checks accepted this case; add a genuinely invalid input',
          normalizedOutputHash: null,
          lastRunAt,
        });
        continue;
      }
      try {
        const runCtx: RecipeRunContext = {
          taskId: base.sourceTaskId,
          runId: deterministicUuid(`validate|${base.id}|${base.version}|${testCase.id}`) as RunId,
          moduleId: base.sourceModuleId,
          params: validation.normalized,
          signal: new AbortController().signal,
        };
        const result = await executeRun(base, validation.normalized, runCtx, pre);
        updated.push({
          ...testCase,
          status: 'passed',
          detail: bound(
            `accepted case executed deterministically: ${result.outputs.length} output(s), toolCalls=${result.toolCalls}, llmCalls=${result.llmCalls}, normalizedOutputHash=${result.normalizedOutputHash}`,
            2000,
          ),
          normalizedOutputHash: result.normalizedOutputHash,
          lastRunAt: deps.now(),
        });
      } catch (error) {
        updated.push({
          ...testCase,
          status: 'failed',
          detail: bound(`accept case failed during execution: ${errorMessage(error)}`, 2000),
          normalizedOutputHash: null,
          lastRunAt: deps.now(),
        });
      }
    }

    const passedOriginal = updated.filter((testCase) => testCase.status === 'passed' && testCase.kind === 'original' && testCase.expectation === 'accept').length;
    const passedNewValid = updated.filter((testCase) => testCase.status === 'passed' && testCase.kind === 'new_valid' && testCase.expectation === 'accept').length;
    const passedAccept = updated.filter((testCase) => testCase.status === 'passed' && testCase.expectation === 'accept').length;
    const passedInvalid = updated.filter((testCase) => testCase.status === 'passed' && testCase.kind === 'invalid' && testCase.expectation === 'reject').length;
    const gateReasons: string[] = [];
    if (passedOriginal < 1) gateReasons.push('no passed original accept case');
    if (passedNewValid < 1) gateReasons.push('no passed new_valid accept case (test generalization with a different valid input)');
    if (passedAccept < 2) gateReasons.push('needs at least 2 passed accept cases (original + new_valid)');
    if (passedInvalid < 1) gateReasons.push('no passed invalid reject case');
    const validated = gateReasons.length === 0;

    let status: Recipe['status'];
    if (validated) status = 'validated';
    else if (base.status === 'validated') status = 'stale';
    else if (base.status === 'disabled') status = 'disabled';
    else status = 'candidate';

    const pins = currentPins(options);
    const fingerprintInputs = buildRecipeFingerprintInputs(base, pins);
    const fingerprint = computeRecipeFingerprint(fingerprintInputs);
    const next: Recipe = {
      ...base,
      testCases: updated,
      status,
      staleReason: validated ? null : gateReasons.join('; '),
      fingerprintInputs,
      fingerprint,
      updatedAt: deps.now(),
    };
    const parsedNext = RecipeSchema.safeParse(next);
    if (!parsedNext.success) {
      throw new RecipeRuntimeError(
        'internal_error',
        `validated recipe did not satisfy RecipeSchema: ${parsedNext.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return parsedNext.data;
  }

  return { validateInputs, preflightInputs, run, validate };
}

export { MAX_OBSERVED_ISSUES };
