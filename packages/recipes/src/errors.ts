/**
 * Structured errors for the recipe runtime and recipe extraction.
 *
 * The server branches on `code`, never on human-readable text (same convention
 * as @ca/tools / @ca/harness). A failed recipe run is always an explicit error,
 * never a syntactically successful result with an empty output.
 */
import type { JsonValue } from '@ca/contracts';

export const RECIPE_ERROR_CODES = [
  /** Input parameter object violates the recipe input schema. */
  'invalid_input',
  /** Recipe source/data preflight rejected the bound input data (deterministic). */
  'input_rejected',
  /** Recipe DSL/registry invariants are broken; it must not execute. */
  'dsl_invalid',
  /** Only validated recipes may run; the registry must re-test it first. */
  'recipe_not_validated',
  /** Tool/prompt/parser/validator pins changed since the recipe was validated. */
  'recipe_stale',
  /** Step kind is not part of the registered DSL. */
  'unsupported_step',
  /** A binding cannot be resolved for this step (missing parameter/previous output). */
  'binding_unresolved',
  /** A declared deterministic validator is not shipped by this runtime. */
  'validator_unavailable',
  /** A deterministic validation check failed. */
  'validation_failed',
  /** A deterministic step failed (port failure or unexpected operator error). */
  'step_failed',
  /** Budget exhausted (maxToolCalls / maxModelCalls / maxRuntimeMs). */
  'budget_exhausted',
  /** Cancelled via AbortSignal. */
  'aborted',
  /** llm_assisted recipe wants a model call but no model executor was provided. */
  'model_step_unavailable',
  /** Recipe contains/purposefully attempts a model call without permission. */
  'model_calls_forbidden',
  /** emit_artifact kind differs from recipe.outputArtifactKind. */
  'output_kind_mismatch',
  /** Run produced no emitted output. */
  'missing_output',
  /** Unexpected internal inconsistency (never a business result). */
  'internal_error',
  /** Extraction: the trace does not contain enough structure to build a recipe. */
  'trace_insufficient',
  /** Extraction: the trace used model steps but the requested kind is deterministic. */
  'trace_not_deterministic',
  /** Extraction: the trace step count exceeds the bounded DSL. */
  'trace_too_long',
] as const;
export type RecipeErrorCode = (typeof RECIPE_ERROR_CODES)[number];

export interface RecipeErrorOptions {
  retryable?: boolean;
  details?: JsonValue;
  stepId?: string;
  cause?: unknown;
}

export class RecipeRuntimeError extends Error {
  readonly code: RecipeErrorCode;
  readonly retryable: boolean;
  readonly details?: JsonValue;
  readonly stepId?: string;

  constructor(code: RecipeErrorCode, message: string, options: RecipeErrorOptions = {}) {
    super(boundMessage(message));
    this.name = 'RecipeRuntimeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.stepId = options.stepId;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Extraction failures kept separate so the proposal API can report structure gaps. */
export class RecipeExtractionError extends Error {
  readonly code: 'trace_insufficient' | 'trace_not_deterministic' | 'trace_too_long' | 'trace_invalid';
  readonly issues: string[];

  constructor(
    code: 'trace_insufficient' | 'trace_not_deterministic' | 'trace_too_long' | 'trace_invalid',
    message: string,
    issues: string[] = [],
  ) {
    super(boundMessage(message));
    this.name = 'RecipeExtractionError';
    this.code = code;
    this.issues = issues;
  }
}

export function isRecipeRuntimeError(error: unknown): error is RecipeRuntimeError {
  return error instanceof RecipeRuntimeError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}

export function boundMessage(message: string, maxChars = 4000): string {
  if (message.length <= maxChars) return message;
  return `${message.slice(0, Math.max(1, maxChars - 1))}…`;
}
