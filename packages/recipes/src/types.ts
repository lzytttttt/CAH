/**
 * Recipe runtime contracts: validation, deterministic execution, fingerprinting
 * and extraction of candidate recipes from a successful run trace.
 *
 * Recipes never execute arbitrary code: only registered deterministic operators
 * from @ca/tools and (for llm_assisted recipes) the fixed model step.
 *
 * Two execution surfaces exist:
 * - `validateInputs` is the synchronous schema gate over the JSON-ish parameter
 *   object. It does not touch any port (the RecipeRuntime port has no taskId at
 *   this point), so source existence/MIME checks happen in `preflightInputs`.
 * - `preflightInputs` is the asynchronous, source-backed gate: it resolves
 *   source parameters to an explicit `{sourceId, version}`, verifies task
 *   ownership through the task-scoped SourceReaderPort, checks accepted MIME
 *   types, and dry-runs the deterministic step pipeline (no object writes, no
 *   model calls) so data-shape mismatches are rejected as *input* errors before
 *   any output is produced or stored.
 */
import type {
  ArtifactVersion,
  JsonObject,
  ModuleContent,
  ModuleId,
  Recipe,
  RecipeProposalInput,
  RecipeRunOutput,
  RecipeRunResult,
  RecipeStep,
  RecipeTestCase,
  RunId,
  SourceId,
  TaskId,
} from '@ca/contracts';
import type { ArtifactAccessPort, ObjectWriterPort, SourceReaderPort, ValidatorPort } from '@ca/tools';

export interface RecipeExecutionDeps {
  sources: SourceReaderPort;
  artifacts: ArtifactAccessPort;
  objects: ObjectWriterPort;
  validator: ValidatorPort;
  now(): string;
  /**
   * Optional model executor used ONLY by llm_assisted recipes. It must be the
   * same kernel provider gateway; deterministic recipes never call it.
   */
  runModelStep?: (input: {
    taskId: TaskId;
    runId: RunId;
    promptTemplateId: string;
    promptVersion: string;
    instruction: string;
    inputSummary: string;
    maxOutputTokens: number;
  }) => Promise<{ text: string; modelCalls: number }>;
}

/**
 * A single observable step execution. Observers are a diagnostic channel only:
 * they never change business results and are optional.
 */
export interface RecipeStepObservation {
  stepId: string;
  kind: RecipeStep['kind'];
  status: 'executed' | 'skipped' | 'failed';
  /** Non-fatal data-quality issues recorded by the step (for example `require`). */
  issues: string[];
  objectHash: string | null;
  rowCount: number | null;
  durationMs: number;
}

export type RecipeRunObserver = (observation: RecipeStepObservation) => void;

export interface RecipeRunContext {
  taskId: TaskId;
  runId: RunId;
  moduleId: ModuleId | null;
  /** Validated parameter values keyed by parameter name. */
  params: Record<string, unknown>;
  signal: AbortSignal;
  /** Optional diagnostics sink (used by tests/CLI); never affects results. */
  observer?: RecipeRunObserver;
}

export interface RecipeInputValidation {
  ok: boolean;
  errors: string[];
  normalized: Record<string, unknown>;
  /**
   * Source parameters resolved as far as possible without any I/O. A `version`
   * of `0` means "unresolved; preflightInputs() must bind the latest version".
   */
  sourceBindings: Record<string, { sourceId: SourceId; version: number }>;
}

export interface RecipeInputPreflightContext {
  taskId: TaskId;
  signal?: AbortSignal;
}

export interface RecipeSourceMeta {
  sourceId: SourceId;
  name: string;
  mime: string;
  version: number;
  sizeBytes: number;
}

export interface RecipeInputPreflightResult {
  ok: boolean;
  errors: string[];
  /** Fully resolved source parameters (`version` is always positive here). */
  sourceBindings: Record<string, { sourceId: SourceId; version: number }>;
  sourceMeta: Record<string, RecipeSourceMeta>;
}

/**
 * Honest cache interface for `cached_snapshot` recipes. The runtime never
 * fabricates cache hits: a hit is reported only when a supplied port returns a
 * well-formed entry for the exact recipe fingerprint + normalized inputs key.
 */
export interface RecipeCacheEntry {
  outputs: RecipeRunOutput[];
  normalizedOutputHash: string;
  createdAt: string;
}

export interface RecipeCachePort {
  get(key: string): Promise<RecipeCacheEntry | null>;
  put(key: string, entry: RecipeCacheEntry): Promise<void>;
}

export interface RecipeRuntime {
  /** Synchronous schema gate over the input parameters (no I/O). */
  validateInputs(recipe: Recipe, inputs: JsonObject): RecipeInputValidation;
  /**
   * Async input preflight: resolves sources (existence, task ownership, MIME)
   * and dry-runs the deterministic steps to reject data-shape mismatches before
   * anything is executed for real.
   */
  preflightInputs(
    recipe: Recipe,
    inputs: JsonObject,
    ctx: RecipeInputPreflightContext,
  ): Promise<RecipeInputPreflightResult>;
  /** Execute a validated recipe; returns normalized outputs and an accounting ledger. */
  run(recipe: Recipe, ctx: RecipeRunContext): Promise<RecipeRunResult>;
  /** Run the registered test cases and update their statuses. */
  validate(recipe: Recipe, testCases: RecipeTestCase[], inputsByCase: Record<string, JsonObject>): Promise<Recipe>;
}

export interface RecipeRuntimeOptions {
  deps: RecipeExecutionDeps;
  toolVersions: Record<string, string>;
  promptHashes: Record<string, string>;
  validatorVersion: string;
  parserVersion: string;
  /** Optional honest cache for cached_snapshot recipes (server supplies it). */
  cache?: RecipeCachePort;
  /**
   * Operations/testing escape hatch. Production callers must keep this false so
   * only `validated` recipes can run (design 13.3/13.4). `validate()` re-tests
   * candidates through an internal path and does not need this flag.
   */
  allowUnvalidatedRuns?: boolean;
}

export interface RecipeTraceStep {
  kind: string;
  title: string;
  toolId: string | null;
  /** Structured summary of the step input (JSON text for extractable steps). */
  inputSummary: string;
  outputSummary: string;
  outputObjectHash: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface RecipeTrace {
  runId: RunId;
  taskId: TaskId;
  moduleId: ModuleId | null;
  moduleKind: 'markdown' | 'json' | 'csv';
  steps: RecipeTraceStep[];
  sourceRefs: Array<{ sourceId: SourceId; version: number }>;
  acceptedVersion: ArtifactVersion | null;
  producedContent: ModuleContent | null;
}

/** Stable fingerprint over the parts that invalidate a recipe when changed. */
export function recipeFingerprintInputs(recipe: Pick<Recipe, 'fingerprintInputs'>): Recipe['fingerprintInputs'] {
  return recipe.fingerprintInputs;
}

export type { RecipeProposalInput, Recipe, RecipeRunResult };
