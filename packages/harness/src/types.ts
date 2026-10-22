/**
 * Harness contracts: the UI-independent execution kernel.
 *
 * No DOM, React, canvas or animation types may appear anywhere in this package.
 * All external effects go through injected ports (storage, providers, tools).
 */
import type {
  ArtifactModule,
  ArtifactVersion,
  Blocker,
  BudgetUsage,
  ContextSnapshot,
  EventPayloads,
  EventType,
  EvidenceRef,
  HarnessEvent,
  ModelEvent,
  ModelRequest,
  ModuleContent,
  ModuleId,
  PatchProposal,
  Plan,
  ProviderCapabilities,
  ProviderProfile,
  Run,
  RunId,
  RunState,
  SourceId,
  Step,
  TaskId,
  Task,
  ValidationReport,
  WorkspaceSettings,
  ToolId,
  ToolScope,
  StepId as StepIdType,
} from '@ca/contracts';
import type { StoragePort } from '@ca/storage';
import type { ToolContext, ToolRuntime, ValidatorPort } from '@ca/tools';

/** Low-level model gateway consumed by the kernel (implemented by the server). */
export interface ProviderGateway {
  getProfile(profileId: string): Promise<ProviderProfile | null>;
  listEnabledProfiles(): Promise<ProviderProfile[]>;
  capabilities(profileId: string): Promise<ProviderCapabilities>;
  stream(profileId: string, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface Clock {
  now(): string;
  /** Monotonic milliseconds for budget accounting. */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

export interface HarnessConfig {
  policyVersion: string;
  promptBundleVersion: string;
  ownerId: string;
  defaultModelProfileId: string | null;
  /** Total token budget for prompt assembly per model call. */
  contextTokenBudget: number;
  /** Model output/tool result reservation inside the context window. */
  contextReserveTokens: number;
  /** Upper bound of model/tool round trips inside one run (belt and braces over BudgetPolicy). */
  maxToolRounds: number;
  /** Demo mode is seeded and never calls live providers. */
  mode: 'demo' | 'live';
  /** When true, engine.recoverInterrupted() runs during construction/startup. */
  debugTraceModelEvents: boolean;
}

export const DEFAULT_HARNESS_CONFIG: Omit<HarnessConfig, 'mode'> = {
  policyVersion: 'p0-policy-1',
  promptBundleVersion: 'prompts-1',
  ownerId: 'local-user',
  defaultModelProfileId: null,
  contextTokenBudget: 32_000,
  contextReserveTokens: 4_000,
  maxToolRounds: 8,
  debugTraceModelEvents: false,
};

/**
 * Inputs for the server-provided tool context factory. The kernel never builds
 * filesystem/network/auth context itself: the server resolves sources, scopes,
 * capabilities and the abort signal and returns a sandboxed ToolContext.
 */
export interface ToolContextFactoryInput {
  taskId: TaskId;
  runId: RunId;
  stepId: StepIdType;
  toolCallId: string;
  /** Scopes granted to this run by policy (derived from the committed plan). */
  grantedScopes: readonly ToolScope[];
  /** Aborted by pause/cancel/timeout; tools must check cooperatively. */
  signal: AbortSignal;
}

export interface HarnessDeps {
  storage: StoragePort;
  providers: ProviderGateway;
  tools: ToolRuntime;
  config: HarnessConfig;
  clock?: Clock;
  /** Server-provided: builds the sandboxed ToolContext for every tool execute. */
  toolContextFactory: (input: ToolContextFactoryInput) => Promise<ToolContext>;
  /** Called exactly once when a run reaches a terminal state. */
  onRunFinished?: (runId: RunId, state: RunState) => void | Promise<void>;
  /** Called for every delta batch so the server can broadcast before commit. */
  onModelDelta?: (event: ModelEvent) => void;
}

/* ------------------------------ commands ------------------------------ */

export interface PlanCommand {
  commandId: string;
  taskId: TaskId;
  expectedRevision: number;
  moduleId: ModuleId;
  intent: string;
  planFirst: boolean;
  budgetOverrides?: Partial<import('@ca/contracts').BudgetPolicy>;
  sourceIds?: SourceId[];
  actor: string;
}

export interface CommitPlanCommand {
  commandId: string;
  runId: RunId;
  expectedRevision: number;
  planVersion: number;
  contextSnapshotId: string;
  actor: string;
}

export interface ResolveInputCommand {
  commandId: string;
  runId: RunId;
  expectedRevision: number;
  blockerId: string;
  optionId: string;
  value: unknown;
  note: string;
  actor: string;
}

export interface PauseCommand {
  commandId: string;
  runId: RunId;
  expectedRevision: number;
  actor: string;
}

export interface ResumeCommand {
  commandId: string;
  runId: RunId;
  expectedRevision: number;
  actor: string;
}

export interface CancelCommand {
  commandId: string;
  runId: RunId;
  expectedRevision: number;
  reason: string;
  actor: string;
}

export interface AcceptPatchCommand {
  commandId: string;
  patchId: string;
  expectedRevision: number;
  validationReportId: string;
  acceptMode: 'all' | 'sections';
  sectionIds: string[];
  note: string;
  actor: string;
}

export interface RejectPatchCommand {
  commandId: string;
  patchId: string;
  reason: string;
  actor: string;
}

export interface RestoreVersionCommand {
  commandId: string;
  taskId: TaskId;
  moduleId: ModuleId;
  versionId: string;
  expectedRevision: number;
  note: string;
  actor: string;
}

export interface RunHandle {
  runId: RunId;
  state: RunState;
  plan?: Plan | null;
}

export interface AcceptResult {
  versionId: string;
  moduleId: ModuleId;
  artifactRevision: number;
  runState: RunState | null;
  taskRevision: number;
}

export interface RunDetail {
  run: Run;
  plan: Plan | null;
  steps: Step[];
  blockers: Blocker[];
  contextSnapshot: ContextSnapshot | null;
  validationReport: ValidationReport | null;
}

export interface RecoveryReport {
  interrupted: Array<{ runId: RunId; lastCheckpointId: string | null; unclearToolCalls: string[] }>;
  recovered: number;
  skipped: number;
}

export interface HarnessEngine {
  readonly validator: ValidatorPort;
  plan(command: PlanCommand): Promise<RunHandle>;
  commit(command: CommitPlanCommand): Promise<RunHandle>;
  resolve(command: ResolveInputCommand): Promise<RunHandle>;
  pause(command: PauseCommand): Promise<void>;
  resume(command: ResumeCommand): Promise<RunHandle>;
  cancel(command: CancelCommand): Promise<void>;
  accept(command: AcceptPatchCommand): Promise<AcceptResult>;
  reject(command: RejectPatchCommand): Promise<{ patchId: string; status: string }>;
  restore(command: RestoreVersionCommand): Promise<{ versionId: string; artifactRevision: number }>;
  getRunDetail(runId: RunId): Promise<RunDetail | null>;
  /** Start (or restart) execution of a run whose plan is committed. Returns when settled. */
  startRun(runId: RunId): Promise<void>;
  /** Wait for all currently running loops to settle (tests and shutdown). */
  waitForIdle(): Promise<void>;
  /** Number of currently executing loops. */
  activeRunCount(): number;
  /** Recover interrupted runs after a process restart. */
  recoverInterrupted(): Promise<RecoveryReport>;
  /** Read the run's event stream (used by CLI/tests; the server also proxies SSE). */
  events(taskId: TaskId, afterSeq: number): AsyncIterable<HarnessEvent>;
  shutdown(): Promise<void>;
}

/** Structured error thrown by the kernel; maps to API error codes. */
export class HarnessError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(code: string, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/* ---------------------------- planning types ---------------------------- */

export interface PlanDraft {
  goal: string;
  skeleton: Array<{ moduleId: ModuleId; sections: string[]; expectedContentSummary: string }>;
  steps: Array<{
    id: string;
    title: string;
    kind: 'tool' | 'model' | 'validate' | 'compose';
    dependencies: string[];
    toolId: string | null;
    description: string;
    expectedOutput: string;
  }>;
  toolIds: ToolId[];
  assumptions: Array<{ id: string; text: string; needsConfirmation: boolean }>;
  openQuestions: Array<{ id: string; question: string; blocking: boolean; reason: string }>;
  risks: Array<{
    id: string;
    type: 'constraint_conflict' | 'missing_input' | 'permission' | 'scope_overrun' | 'budget' | 'unverified_assumption' | 'irreversible_change' | 'explicit_unknown';
    basis: 'evidence' | 'constraint_conflict' | 'explicit_unknown';
    title: string;
    detail: string;
    severity: 'info' | 'warning' | 'blocking';
    affectedModuleIds: ModuleId[];
    evidenceRefs: EvidenceRef[];
    handlingOptions: Array<{ id: string; label: string; description: string }>;
  }>;
  rationale: string;
}

export interface ValidationInput {
  task: Task;
  module: ArtifactModule;
  candidate: ModuleContent;
  baseVersion: ArtifactVersion | null;
  evidenceRefs: EvidenceRef[];
  acceptedUpstream: ArtifactVersion[];
}

export interface ValidationOutput {
  report: ValidationReport;
}

export interface ExecutionOutcome {
  candidate: ModuleContent | null;
  evidenceRefs: EvidenceRef[];
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null; estimated: boolean };
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown';
}

export interface ContextBuildInput {
  workspaceSettings: WorkspaceSettings;
  task: Task;
  module: ArtifactModule;
  acceptedVersion: ArtifactVersion | null;
  acceptedUpstream: Array<{ module: ArtifactModule; version: ArtifactVersion }>;
  sourceRefs: Array<{ sourceId: SourceId; version: number }>;
  stepGoal: string;
  evidenceRefs: EvidenceRef[];
  recentToolResults: Array<{ toolId: string; summary: string }>;
  plan: Plan | null;
}

export interface ContextBuildResult {
  snapshot: ContextSnapshot;
  systemPrompt: string;
  userPrompt: string;
}

export type EventEmitInput<T extends EventType = EventType> = {
  runId: string | null;
  stepId: string | null;
  causationId: string | null;
  type: T;
  payload: EventPayloads[T];
};
