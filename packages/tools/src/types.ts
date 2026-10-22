/**
 * Tool runtime contracts. The runtime validates model arguments against the
 * versioned schemas, checks policy/scopes, enforces timeouts and normalizes
 * results. It never trusts model-provided permissions and never executes
 * arbitrary code or shell.
 *
 * Implementations live in `runtime.ts`; this file is the stable contract.
 */
import type {
  ArtifactModule,
  ArtifactVersion,
  EvidenceRef,
  JsonObject,
  JsonValue,
  ModuleContent,
  PatchOperation,
  PatchProposal,
  ProviderCapabilities,
  RunId,
  SourceId,
  SourceItem,
  SourceSpan,
  StepId,
  TaskId,
  ToolCallId,
  ToolDescriptor,
  ToolDefinition,
  ToolId,
  ToolResult,
  ToolScope,
  ValidationReport,
  ModuleId,
} from '@ca/contracts';

/** Read-only view over task sources, implemented by the server over StoragePort. */
export interface SourceReaderPort {
  listSources(taskId: TaskId): Promise<SourceItem[]>;
  getSource(taskId: TaskId, sourceId: SourceId, version: number): Promise<{ source: SourceItem; bytes: Uint8Array } | null>;
  listLatestContents(taskId: TaskId): Promise<Array<{ source: SourceItem; bytes: Uint8Array }>>;
  listSpans(taskId: TaskId, limit?: number): Promise<SourceSpan[]>;
}

/** Artifact access for artifact.* tools. */
export interface ArtifactAccessPort {
  getModule(moduleId: ModuleId): Promise<ArtifactModule | null>;
  getAcceptedVersion(moduleId: ModuleId): Promise<ArtifactVersion | null>;
  getVersion(versionId: string): Promise<ArtifactVersion | null>;
  /** Persist a draft patch + validation report. Never touches accepted versions. */
  saveProposal(input: {
    taskId: TaskId;
    runId: RunId;
    moduleId: ModuleId;
    baseVersionId: string | null;
    operations: PatchOperation[];
    evidenceRefs: EvidenceRef[];
    description: string;
    candidate: ModuleContent;
    validation: ValidationReport;
  }): Promise<{ patch: PatchProposal }>;
  saveValidationReport(report: ValidationReport): Promise<void>;
}

/** Optional artifact validation implementation (provided by the harness). */
export interface ValidatorPort {
  validate(input: {
    taskId: TaskId;
    runId: RunId;
    moduleId: ModuleId;
    candidate: ModuleContent;
    evidenceRefs: EvidenceRef[];
    baseVersion: ArtifactVersion | null;
  }): Promise<ValidationReport>;
}

export interface ObjectWriterPort {
  put(bytes: Uint8Array, mime: string): Promise<{ hash: string; sizeBytes: number; mime: string }>;
}

/** Everything a tool may touch. Nothing else (no fs, no network, no env). */
export interface ToolContext {
  taskId: TaskId;
  runId: RunId;
  stepId: StepId;
  toolCallId: ToolCallId;
  /** Scopes granted to this run by policy. */
  grantedScopes: readonly ToolScope[];
  sources: SourceReaderPort;
  artifacts: ArtifactAccessPort;
  validator: ValidatorPort | null;
  objects: ObjectWriterPort;
  /** Provider capabilities are visible so tools cannot claim unsupported features. */
  capabilities: ProviderCapabilities | null;
  now(): string;
  /** Aborted by pause/cancel/timeout. Tools must check cooperatively. */
  signal: AbortSignal;
}

export interface ToolRuntime {
  /** All registered descriptors (for diagnostics and API surface). */
  descriptors(): ToolDescriptor[];
  /** Model-facing OpenAI-compatible tool definitions. */
  modelTools(allowed: readonly ToolId[]): ToolDefinition[];
  /** Validate raw stream-assembled JSON without executing anything. */
  validateArguments(toolId: ToolId, rawJson: string): { ok: true; args: JsonObject } | { ok: false; error: string };
  /** Execute a validated call. Emits no business events; the harness wraps it. */
  execute(toolId: ToolId, rawArgumentsJson: string, ctx: ToolContext): Promise<ToolResult>;
}

/** Deterministic JSON Schema for tool args (for plan validation display). */
export interface ToolArgumentSchemaInfo {
  toolId: ToolId;
  schema: JsonObject;
}

export type ToolResultData = JsonValue;
