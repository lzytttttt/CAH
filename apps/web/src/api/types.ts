/**
 * Browser-side API surface for the spatial workbench.
 *
 * The UI never invents business state: every read comes from the server
 * snapshot / SSE stream, and every write is one of the documented commands.
 * This interface exists so the same UI runs against the real HTTP server and
 * against a deterministic local fixture client used for explicit previews
 * (`?fixture=1`); the fixture is labelled 本地夹具（非真实执行） everywhere.
 */
import type {
  AcceptPatchRequest,
  AcceptPatchResponse,
  CommitPlanRequest,
  CreateProviderProfileRequest,
  CreateRecipeRequest,
  CreateRecipeResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DemoResetRequest,
  DemoResetResponse,
  DemoTemplate,
  DisableRecipeRequest,
  ExportRequest,
  ExportResponse,
  HarnessEvent,
  ImportRequest,
  ImportResponse,
  ModuleContentResponse,
  PatchReviewResponse,
  ProposeRecipeRequest,
  ProposeRecipeResponse,
  ProviderProfileResponse,
  Recipe,
  RecipeListResponse,
  RecipeResponse,
  RejectPatchRequest,
  RejectPatchResponse,
  ResolveInputRequest,
  RestoreVersionRequest,
  RestoreVersionResponse,
  RunControlRequest,
  RunControlResponse,
  RunDetailResponse,
  RunRecipeRequest,
  RunRecipeResponse,
  SessionInfo,
  SnapshotQuery,
  SourceImportRequest,
  SourceImportResponse,
  SwitchModeRequest,
  SwitchModeResponse,
  TaskListResponse,
  TaskSnapshot,
  TestProviderRequest,
  TestProviderResponse,
  UpdateProviderProfileRequest,
  UpdateTaskRequest,
  UpdateTaskResponse,
  UpdateWorkspaceRequest,
  UpdateWorkspaceResponse,
  ValidateRecipeRequest,
  ValidateRecipeResponse,
  VersionListResponse,
  WorkspaceView,
} from '@ca/contracts';

/** Which backend implementation is feeding the UI. */
export type ClientKind = 'http' | 'fixture';

/**
 * Event envelope as serialized by the server (TaskSnapshot.events).
 * (The contracts package's discriminated `HarnessEvent` type is the server-side
 * mapped union; the snapshot projection types the payload as a record, so the
 * UI consumes this serialized shape.)
 */
export type BusinessEvent = TaskSnapshot['events'][number];

/** Documented public error code, or a client-side transport code. */
export interface ApiErrorMeta {
  code: string;
  message: string;
  retryable: boolean;
  traceId: string;
  status?: number;
  details?: unknown;
}

/** A transport problem, distinct from a business command rejection. */
export type ClientFailureKind = 'http' | 'network' | 'invalid_response' | 'aborted';

export class ClientFailure extends Error {
  readonly kind: ClientFailureKind;
  readonly code: string;
  readonly retryable: boolean;
  readonly traceId: string;
  readonly status: number | undefined;
  readonly details: unknown;

  constructor(meta: ApiErrorMeta & { kind: ClientFailureKind }) {
    super(meta.message);
    this.name = 'ClientFailure';
    this.kind = meta.kind;
    this.code = meta.code;
    this.retryable = meta.retryable;
    this.traceId = meta.traceId;
    this.status = meta.status;
    this.details = meta.details;
  }
}

export function isClientFailure(error: unknown): error is ClientFailure {
  return error instanceof ClientFailure;
}

/* ------------------------------ SSE plumbing ------------------------------ */

export interface EventSubscription {
  /** Stop reading and suppress reconnects. Safe to call multiple times. */
  close(): void;
  /** True while a live stream is attached. */
  isOpen(): boolean;
}

export interface SubscribeEventsOptions {
  /** Last applied task-local sequence, used for resume. */
  afterSeq: number;
  /** Last SSE id (usually equals afterSeq); sent as Last-Event-ID. */
  lastEventId?: number | null;
  onEvent(event: BusinessEvent): void;
  onOpen?(): void;
  onError?(error: ClientFailure): void;
  /** Seq gap detected: the caller must refetch the snapshot before applying more events. */
  onGap?(fromSeq: number, toSeq: number): void;
  onStateChange?(state: 'connecting' | 'open' | 'closed'): void;
}

/* -------------------------------- interface -------------------------------- */

export interface ApiClient {
  readonly kind: ClientKind;
  /** Absolute base URL ('' means same origin through the dev proxy). */
  readonly baseUrl: string;

  /* session / workspace */
  getSession(): Promise<SessionInfo>;
  getWorkspace(): Promise<WorkspaceView>;
  updateWorkspace(request: UpdateWorkspaceRequest): Promise<UpdateWorkspaceResponse>;
  setWorkspaceMode(request: SwitchModeRequest): Promise<SwitchModeResponse>;

  /* tasks */
  listTasks(): Promise<TaskListResponse>;
  createTask(request: CreateTaskRequest): Promise<CreateTaskResponse>;
  updateTask(taskId: string, request: UpdateTaskRequest): Promise<UpdateTaskResponse>;
  getSnapshot(taskId: string, query?: SnapshotQuery): Promise<TaskSnapshot>;
  subscribeEvents(taskId: string, options: SubscribeEventsOptions): EventSubscription;

  /* sources */
  importSource(taskId: string, request: SourceImportRequest): Promise<SourceImportResponse>;

  /* runs */
  createRun(taskId: string, request: CreateRunRequest): Promise<CreateRunResponse>;
  commitPlan(runId: string, request: CommitPlanRequest): Promise<RunControlResponse>;
  resolveInput(runId: string, request: ResolveInputRequest): Promise<RunControlResponse>;
  pauseRun(runId: string, request: RunControlRequest): Promise<RunControlResponse>;
  resumeRun(runId: string, request: RunControlRequest): Promise<RunControlResponse>;
  cancelRun(runId: string, request: RunControlRequest): Promise<RunControlResponse>;
  getRunDetail(runId: string): Promise<RunDetailResponse>;

  /* patches / artifacts */
  getPatchReview(patchId: string): Promise<PatchReviewResponse>;
  acceptPatch(patchId: string, request: AcceptPatchRequest): Promise<AcceptPatchResponse>;
  rejectPatch(patchId: string, request: RejectPatchRequest): Promise<RejectPatchResponse>;
  getModuleContent(taskId: string, moduleId: string): Promise<ModuleContentResponse>;
  getVersions(taskId: string, moduleId: string): Promise<VersionListResponse>;
  restoreVersion(artifactId: string, request: RestoreVersionRequest): Promise<RestoreVersionResponse>;

  /* providers */
  createProviderProfile(request: CreateProviderProfileRequest): Promise<ProviderProfileResponse>;
  updateProviderProfile(id: string, request: UpdateProviderProfileRequest): Promise<ProviderProfileResponse>;
  testProviderProfile(id: string, request: TestProviderRequest): Promise<TestProviderResponse>;

  /* recipes */
  proposeRecipe(request: ProposeRecipeRequest): Promise<ProposeRecipeResponse>;
  createRecipe(request: CreateRecipeRequest): Promise<CreateRecipeResponse>;
  listRecipes(taskId: string): Promise<RecipeListResponse>;
  getRecipe(recipeId: string): Promise<RecipeResponse>;
  validateRecipe(recipeId: string, request: ValidateRecipeRequest): Promise<ValidateRecipeResponse>;
  runRecipe(recipeId: string, request: RunRecipeRequest): Promise<RunRecipeResponse>;
  disableRecipe(recipeId: string, request: DisableRecipeRequest): Promise<RecipeResponse>;

  /* transfer / demo */
  exportTask(taskId: string, request: ExportRequest): Promise<ExportResponse>;
  importTask(request: ImportRequest): Promise<ImportResponse>;
  demoReset(request: DemoResetRequest): Promise<DemoResetResponse>;
  getDemoScenario(): Promise<DemoTemplate>;
}

export type { Recipe };
