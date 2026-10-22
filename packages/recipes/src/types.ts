/**
 * Recipe runtime contracts: validation, deterministic execution, fingerprinting
 * and extraction of candidate recipes from a successful run trace.
 *
 * Recipes never execute arbitrary code: only registered deterministic operators
 * from @ca/tools and (for llm_assisted recipes) the fixed model step.
 */
import type {
  ArtifactVersion,
  JsonObject,
  ModuleContent,
  ModuleId,
  Recipe,
  RecipeProposalInput,
  RecipeRunResult,
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

export interface RecipeRunContext {
  taskId: TaskId;
  runId: RunId;
  moduleId: ModuleId | null;
  /** Validated parameter values keyed by parameter name. */
  params: Record<string, unknown>;
  signal: AbortSignal;
}

export interface RecipeInputValidation {
  ok: boolean;
  errors: string[];
  normalized: Record<string, unknown>;
  sourceBindings: Record<string, { sourceId: SourceId; version: number }>;
}

export interface RecipeTraceStep {
  kind: string;
  title: string;
  toolId: string | null;
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

export interface RecipeRuntime {
  validateInputs(recipe: Recipe, inputs: JsonObject): RecipeInputValidation;
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
}

/** Stable fingerprint over the parts that invalidate a recipe when changed. */
export function recipeFingerprintInputs(recipe: Pick<Recipe, 'fingerprintInputs'>): Recipe['fingerprintInputs'] {
  return recipe.fingerprintInputs;
}

export type { RecipeProposalInput, Recipe, RecipeRunResult };
