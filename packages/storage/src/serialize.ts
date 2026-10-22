/**
 * Row <-> entity mapping for the SQLite persistence layer.
 *
 * Every read goes through a contract schema (`zod`) so a corrupted or manually
 * edited database can never leak `any` into the rest of the system; every
 * non-scalar field is stored as JSON text in a column of its own. Immutable
 * artifact versions keep their full content JSON (design document section 4.1:
 * content, model output, file objects and events are stored separately).
 */
import {
  ArtifactModuleSchema,
  ArtifactSchema,
  ArtifactVersionSchema,
  BlockerSchema,
  ContextSnapshotSchema,
  DecisionSchema,
  ProviderProfileSchema,
  PatchProposalSchema,
  RecipeSchema,
  RunCheckpointSchema,
  RunSchema,
  SourceItemSchema,
  SourceSpanSchema,
  StepSchema,
  TaskSchema,
  ToolInvocationRecordSchema,
  ValidationReportSchema,
  WorkspaceSchema,
  WorkspaceSettingsSchema,
  parseHarnessEvent,
  utcNow,
  type Artifact,
  type ArtifactModule,
  type ArtifactVersion,
  type Blocker,
  type ContextSnapshot,
  type Decision,
  type HarnessEvent,
  type PatchProposal,
  type ProviderProfile,
  type Recipe,
  type Run,
  type RunCheckpoint,
  type SourceItem,
  type SourceSpan,
  type Step,
  type Task,
  type ToolInvocationRecord,
  type ValidationReport,
  type Workspace,
  type WorkspaceSettings,
} from '@ca/contracts';
import { StorageError } from './types';

/* ------------------------------------------------------------------ */
/* low level DB value helpers                                          */
/* ------------------------------------------------------------------ */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export type DbRow = Record<string, SqlValue>;

export interface SchemaLike<T> {
  parse(input: unknown): T;
}

/** Schema used to (re)build a `Workspace`, exposed for tests/diagnostics. */
export const workspaceEntitySchema = WorkspaceSchema;

export function nowIso(): string {
  return utcNow();
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function nullableJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function boolValue(value: boolean): number {
  return value ? 1 : 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Parse a JSON column and validate it with the given contract schema. */
export function parseJsonColumn<T>(row: SqlRow, column: string, schema: SchemaLike<T>, context: string): T {
  const raw = rowString(row, column);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError('corrupt_row', `${context}: column ${column} is not valid JSON`);
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new StorageError('corrupt_row', `${context}: column ${column} failed validation: ${errorMessage(error)}`);
  }
}

export function parseNullableJsonColumn<T>(
  row: SqlRow,
  column: string,
  schema: SchemaLike<T>,
  context: string,
): T | null {
  const raw = rowNullableString(row, column);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError('corrupt_row', `${context}: column ${column} is not valid JSON`);
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new StorageError('corrupt_row', `${context}: column ${column} failed validation: ${errorMessage(error)}`);
  }
}

/** Validate an entity read from the database, reporting which row failed. */
export function parseEntity<T>(schema: SchemaLike<T>, value: unknown, context: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new StorageError('corrupt_row', `${context}: row failed contract validation: ${errorMessage(error)}`);
  }
}

export function rowString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new StorageError('corrupt_row', `column ${column} expected text but got ${typeof value}`);
  }
  return value;
}

export function rowNullableString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new StorageError('corrupt_row', `column ${column} expected text or null but got ${typeof value}`);
  }
  return value;
}

export function rowNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new StorageError('corrupt_row', `column ${column} expected integer but got ${typeof value}`);
}

export function rowNullableNumber(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new StorageError('corrupt_row', `column ${column} expected integer or null but got ${typeof value}`);
}

export function rowBoolean(row: SqlRow, column: string): boolean {
  return rowNumber(row, column) !== 0;
}

/* ------------------------------------------------------------------ */
/* workspace                                                           */
/* ------------------------------------------------------------------ */

export function workspaceFromRow(row: SqlRow): Workspace {
  return parseEntity(
    WorkspaceSchema,
    {
      id: rowString(row, 'id'),
      mode: rowString(row, 'mode'),
      name: rowString(row, 'name'),
      settings: parseJsonColumn(row, 'settings_json', WorkspaceSettingsSchema, 'workspace'),
      policyVersion: rowString(row, 'policy_version'),
      createdAt: rowString(row, 'created_at'),
      updatedAt: rowString(row, 'updated_at'),
    },
    'workspace',
  );
}

export function workspaceToRow(workspace: Workspace, revision: number): DbRow {
  return {
    id: workspace.id,
    mode: workspace.mode,
    name: workspace.name,
    settings_json: json(workspace.settings),
    policy_version: workspace.policyVersion,
    revision,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
  };
}

export function workspaceRevisionFromRow(row: SqlRow): number {
  return rowNumber(row, 'revision');
}

export function parseWorkspaceSettings(value: unknown): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse(value);
}

/* ------------------------------------------------------------------ */
/* task + artifact skeleton                                            */
/* ------------------------------------------------------------------ */

export function taskFromRow(row: SqlRow): Task {
  return parseEntity(
    TaskSchema,
    {
      id: rowString(row, 'id'),
      workspaceId: rowString(row, 'workspace_id'),
      title: rowString(row, 'title'),
      intent: rowString(row, 'intent'),
      constraints: parseJsonColumn(row, 'constraints_json', { parse: (v) => TaskSchema.shape.constraints.parse(v) }, 'task'),
      artifactId: rowString(row, 'artifact_id'),
      revision: rowNumber(row, 'revision'),
      templateId: rowNullableString(row, 'template_id'),
      status: rowString(row, 'status'),
      createdAt: rowString(row, 'created_at'),
      updatedAt: rowString(row, 'updated_at'),
    },
    'task',
  );
}

export function taskToRow(task: Task): DbRow {
  return {
    id: task.id,
    workspace_id: task.workspaceId,
    title: task.title,
    intent: task.intent,
    constraints_json: json(task.constraints),
    artifact_id: task.artifactId,
    revision: task.revision,
    template_id: task.templateId,
    status: task.status,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

export function artifactFromRow(row: SqlRow): Artifact {
  return parseEntity(
    ArtifactSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      title: rowString(row, 'title'),
      moduleIds: parseJsonColumn(row, 'module_ids_json', { parse: (v) => ArtifactSchema.shape.moduleIds.parse(v) }, 'artifact'),
      acceptedVersionId: rowNullableString(row, 'accepted_version_id'),
      status: rowString(row, 'status'),
      createdAt: rowString(row, 'created_at'),
      updatedAt: rowString(row, 'updated_at'),
    },
    'artifact',
  );
}

export function artifactToRow(artifact: Artifact): DbRow {
  return {
    id: artifact.id,
    task_id: artifact.taskId,
    title: artifact.title,
    module_ids_json: json(artifact.moduleIds),
    accepted_version_id: artifact.acceptedVersionId,
    status: artifact.status,
    created_at: artifact.createdAt,
    updated_at: artifact.updatedAt,
  };
}

export function moduleFromRow(row: SqlRow): ArtifactModule {
  return parseEntity(
    ArtifactModuleSchema,
    {
      id: rowString(row, 'id'),
      artifactId: rowString(row, 'artifact_id'),
      title: rowString(row, 'title'),
      kind: rowString(row, 'kind'),
      order: rowNumber(row, 'order_index'),
      dependencies: parseJsonColumn(row, 'dependencies_json', { parse: (v) => ArtifactModuleSchema.shape.dependencies.parse(v) }, 'artifact_module'),
      acceptanceCriteria: parseJsonColumn(
        row,
        'acceptance_criteria_json',
        { parse: (v) => ArtifactModuleSchema.shape.acceptanceCriteria.parse(v) },
        'artifact_module',
      ),
      status: rowString(row, 'status'),
      blockedFrom: rowNullableString(row, 'blocked_from'),
      acceptedVersionId: rowNullableString(row, 'accepted_version_id'),
      createdAt: rowString(row, 'created_at'),
      updatedAt: rowString(row, 'updated_at'),
    },
    'artifact_module',
  );
}

export function moduleToRow(module: ArtifactModule): DbRow {
  return {
    id: module.id,
    artifact_id: module.artifactId,
    title: module.title,
    kind: module.kind,
    order_index: module.order,
    dependencies_json: json(module.dependencies),
    acceptance_criteria_json: json(module.acceptanceCriteria),
    status: module.status,
    blocked_from: module.blockedFrom,
    accepted_version_id: module.acceptedVersionId,
    created_at: module.createdAt,
    updated_at: module.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* artifact version                                                    */
/* ------------------------------------------------------------------ */

export function versionFromRow(row: SqlRow): ArtifactVersion {
  return parseEntity(
    ArtifactVersionSchema,
    {
      id: rowString(row, 'id'),
      artifactId: rowString(row, 'artifact_id'),
      moduleId: rowString(row, 'module_id'),
      moduleKind: rowString(row, 'module_kind'),
      contentHash: rowString(row, 'content_hash'),
      content: parseJsonColumn(row, 'content_json', { parse: (v) => ArtifactVersionSchema.shape.content.parse(v) }, 'artifact_version'),
      parentId: rowNullableString(row, 'parent_id'),
      baseVersionId: rowNullableString(row, 'base_version_id'),
      sourceRunId: rowNullableString(row, 'source_run_id'),
      patchId: rowNullableString(row, 'patch_id'),
      validationReportId: rowNullableString(row, 'validation_report_id'),
      acceptedBy: rowString(row, 'accepted_by'),
      acceptedAt: rowString(row, 'accepted_at'),
      note: rowString(row, 'note'),
      restoredFromVersionId: rowNullableString(row, 'restored_from_version_id'),
    },
    'artifact_version',
  );
}

export function versionToRow(version: ArtifactVersion): DbRow {
  return {
    id: version.id,
    artifact_id: version.artifactId,
    module_id: version.moduleId,
    module_kind: version.moduleKind,
    content_hash: version.contentHash,
    content_json: json(version.content),
    parent_id: version.parentId,
    base_version_id: version.baseVersionId,
    source_run_id: version.sourceRunId,
    patch_id: version.patchId,
    validation_report_id: version.validationReportId,
    accepted_by: version.acceptedBy,
    accepted_at: version.acceptedAt,
    note: version.note,
    restored_from_version_id: version.restoredFromVersionId,
    created_at: nowIso(),
  };
}

/* ------------------------------------------------------------------ */
/* sources + spans                                                     */
/* ------------------------------------------------------------------ */

export function sourceFromRow(row: SqlRow): SourceItem {
  return parseEntity(
    SourceItemSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      name: rowString(row, 'name'),
      mime: rowString(row, 'mime'),
      version: rowNumber(row, 'version'),
      sizeBytes: rowNumber(row, 'size_bytes'),
      hash: rowString(row, 'hash'),
      origin: rowString(row, 'origin'),
      trustLevel: rowString(row, 'trust_level'),
      availability: rowString(row, 'availability'),
      parseStatus: rowString(row, 'parse_status'),
      parseNote: rowString(row, 'parse_note'),
      createdAt: rowString(row, 'created_at'),
    },
    'source',
  );
}

export function sourceToRow(source: SourceItem): DbRow {
  return {
    id: source.id,
    version: source.version,
    task_id: source.taskId,
    name: source.name,
    mime: source.mime,
    size_bytes: source.sizeBytes,
    hash: source.hash,
    origin: source.origin,
    trust_level: source.trustLevel,
    availability: source.availability,
    parse_status: source.parseStatus,
    parse_note: source.parseNote,
    created_at: source.createdAt,
  };
}

export function spanFromRow(row: SqlRow): SourceSpan {
  return parseEntity(
    SourceSpanSchema,
    {
      id: rowString(row, 'id'),
      sourceId: rowString(row, 'source_id'),
      version: rowNumber(row, 'version'),
      locator: parseJsonColumn(row, 'locator_json', { parse: (v) => SourceSpanSchema.shape.locator.parse(v) }, 'source_span'),
      quoteHash: rowString(row, 'quote_hash'),
      excerpt: rowString(row, 'excerpt'),
      createdAt: rowString(row, 'created_at'),
    },
    'source_span',
  );
}

export function spanToRow(span: SourceSpan): DbRow {
  return {
    id: span.id,
    source_id: span.sourceId,
    version: span.version,
    locator_json: json(span.locator),
    quote_hash: span.quoteHash,
    excerpt: span.excerpt,
    created_at: span.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* runs / steps / checkpoints                                          */
/* ------------------------------------------------------------------ */

export function runFromRow(row: SqlRow): Run {
  return parseEntity(
    RunSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      moduleId: rowString(row, 'module_id'),
      mode: rowString(row, 'mode'),
      origin: rowString(row, 'origin'),
      state: rowString(row, 'state'),
      planVersion: rowNumber(row, 'plan_version'),
      contextSnapshotId: rowNullableString(row, 'context_snapshot_id'),
      budgetPolicy: parseJsonColumn(row, 'budget_policy_json', { parse: (v) => RunSchema.shape.budgetPolicy.parse(v) }, 'run'),
      budgetUsage: parseJsonColumn(row, 'budget_usage_json', { parse: (v) => RunSchema.shape.budgetUsage.parse(v) }, 'run'),
      baseVersionId: rowNullableString(row, 'base_version_id'),
      revision: rowNumber(row, 'revision'),
      returnState: rowNullableString(row, 'return_state'),
      interrupted: parseNullableJsonColumn(row, 'interrupted_json', { parse: (v) => RunSchema.shape.interrupted.parse(v) }, 'run'),
      error: parseNullableJsonColumn(row, 'error_json', { parse: (v) => RunSchema.shape.error.parse(v) }, 'run'),
      checkpointId: rowNullableString(row, 'checkpoint_id'),
      attempt: rowNumber(row, 'attempt'),
      autoAcceptPolicyApplied: rowBoolean(row, 'auto_accept_policy_applied'),
      queuePosition: rowNullableNumber(row, 'queue_position'),
      createdAt: rowString(row, 'created_at'),
      updatedAt: rowString(row, 'updated_at'),
      startedAt: rowNullableString(row, 'started_at'),
      finishedAt: rowNullableString(row, 'finished_at'),
    },
    'run',
  );
}

export function runToRow(run: Run): DbRow {
  return {
    id: run.id,
    task_id: run.taskId,
    module_id: run.moduleId,
    mode: run.mode,
    origin: run.origin,
    state: run.state,
    plan_version: run.planVersion,
    context_snapshot_id: run.contextSnapshotId,
    budget_policy_json: json(run.budgetPolicy),
    budget_usage_json: json(run.budgetUsage),
    base_version_id: run.baseVersionId,
    revision: run.revision,
    return_state: run.returnState,
    interrupted_json: nullableJson(run.interrupted),
    error_json: nullableJson(run.error),
    checkpoint_id: run.checkpointId,
    attempt: run.attempt,
    auto_accept_policy_applied: boolValue(run.autoAcceptPolicyApplied),
    queue_position: run.queuePosition,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };
}

export function stepFromRow(row: SqlRow): Step {
  return parseEntity(
    StepSchema,
    {
      id: rowString(row, 'id'),
      runId: rowString(row, 'run_id'),
      kind: rowString(row, 'kind'),
      title: rowString(row, 'title'),
      dependencies: parseJsonColumn(row, 'dependencies_json', { parse: (v) => StepSchema.shape.dependencies.parse(v) }, 'step'),
      inputRefsJson: rowString(row, 'input_refs_json'),
      outputRefs: parseJsonColumn(row, 'output_refs_json', { parse: (v) => StepSchema.shape.outputRefs.parse(v) }, 'step'),
      status: rowString(row, 'status'),
      attempt: rowNumber(row, 'attempt'),
      modelCallId: rowNullableString(row, 'model_call_id'),
      toolCallIds: parseJsonColumn(row, 'tool_call_ids_json', { parse: (v) => StepSchema.shape.toolCallIds.parse(v) }, 'step'),
      summary: rowString(row, 'summary'),
      errorJson: rowNullableString(row, 'error_json'),
      startedAt: rowNullableString(row, 'started_at'),
      finishedAt: rowNullableString(row, 'finished_at'),
    },
    'step',
  );
}

export function stepToRow(step: Step): DbRow {
  return {
    id: step.id,
    run_id: step.runId,
    kind: step.kind,
    title: step.title,
    dependencies_json: json(step.dependencies),
    input_refs_json: step.inputRefsJson,
    output_refs_json: json(step.outputRefs),
    status: step.status,
    attempt: step.attempt,
    model_call_id: step.modelCallId,
    tool_call_ids_json: json(step.toolCallIds),
    summary: step.summary,
    error_json: step.errorJson,
    started_at: step.startedAt,
    finished_at: step.finishedAt,
  };
}

export function checkpointFromRow(row: SqlRow): RunCheckpoint {
  return parseEntity(
    RunCheckpointSchema,
    {
      id: rowString(row, 'id'),
      runId: rowString(row, 'run_id'),
      kind: rowString(row, 'kind'),
      stepId: rowNullableString(row, 'step_id'),
      seqAtCheckpoint: rowNumber(row, 'seq_at_checkpoint'),
      dataJson: rowString(row, 'data_json'),
      createdAt: rowString(row, 'created_at'),
    },
    'run_checkpoint',
  );
}

export function checkpointToRow(checkpoint: RunCheckpoint): DbRow {
  return {
    id: checkpoint.id,
    run_id: checkpoint.runId,
    kind: checkpoint.kind,
    step_id: checkpoint.stepId,
    seq_at_checkpoint: checkpoint.seqAtCheckpoint,
    data_json: checkpoint.dataJson,
    created_at: checkpoint.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* blockers / decisions                                                */
/* ------------------------------------------------------------------ */

export function blockerFromRow(row: SqlRow): Blocker {
  return parseEntity(
    BlockerSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      runId: rowString(row, 'run_id'),
      type: rowString(row, 'type'),
      severity: rowString(row, 'severity'),
      title: rowString(row, 'title'),
      detail: rowString(row, 'detail'),
      evidenceRefs: parseJsonColumn(row, 'evidence_refs_json', { parse: (v) => BlockerSchema.shape.evidenceRefs.parse(v) }, 'blocker'),
      affectedSteps: parseJsonColumn(row, 'affected_steps_json', { parse: (v) => BlockerSchema.shape.affectedSteps.parse(v) }, 'blocker'),
      affectedModuleIds: parseJsonColumn(
        row,
        'affected_module_ids_json',
        { parse: (v) => BlockerSchema.shape.affectedModuleIds.parse(v) },
        'blocker',
      ),
      resolutions: parseJsonColumn(row, 'resolutions_json', { parse: (v) => BlockerSchema.shape.resolutions.parse(v) }, 'blocker'),
      status: rowString(row, 'status'),
      resolution: parseNullableJsonColumn(row, 'resolution_json', { parse: (v) => BlockerSchema.shape.resolution.parse(v) }, 'blocker'),
      returnState: rowString(row, 'return_state'),
      createdAt: rowString(row, 'created_at'),
      resolvedAt: rowNullableString(row, 'resolved_at'),
      clearedAt: rowNullableString(row, 'cleared_at'),
    },
    'blocker',
  );
}

export function blockerToRow(blocker: Blocker): DbRow {
  return {
    id: blocker.id,
    task_id: blocker.taskId,
    run_id: blocker.runId,
    type: blocker.type,
    severity: blocker.severity,
    title: blocker.title,
    detail: blocker.detail,
    evidence_refs_json: json(blocker.evidenceRefs),
    affected_steps_json: json(blocker.affectedSteps),
    affected_module_ids_json: json(blocker.affectedModuleIds),
    resolutions_json: json(blocker.resolutions),
    status: blocker.status,
    resolution_json: nullableJson(blocker.resolution),
    return_state: blocker.returnState,
    created_at: blocker.createdAt,
    resolved_at: blocker.resolvedAt,
    cleared_at: blocker.clearedAt,
  };
}

export function decisionFromRow(row: SqlRow): Decision {
  return parseEntity(
    DecisionSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      runId: rowString(row, 'run_id'),
      blockerId: rowNullableString(row, 'blocker_id'),
      planVersion: rowNullableNumber(row, 'plan_version'),
      key: rowString(row, 'key'),
      valueJson: rowString(row, 'value_json'),
      note: rowString(row, 'note'),
      actor: rowString(row, 'actor'),
      createdAt: rowString(row, 'created_at'),
    },
    'decision',
  );
}

export function decisionToRow(decision: Decision): DbRow {
  return {
    id: decision.id,
    task_id: decision.taskId,
    run_id: decision.runId,
    blocker_id: decision.blockerId,
    plan_version: decision.planVersion,
    key: decision.key,
    value_json: decision.valueJson,
    note: decision.note,
    actor: decision.actor,
    created_at: decision.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* patches / validation reports                                        */
/* ------------------------------------------------------------------ */

export function patchFromRow(row: SqlRow): PatchProposal {
  return parseEntity(
    PatchProposalSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      runId: rowString(row, 'run_id'),
      moduleId: rowString(row, 'module_id'),
      moduleKind: rowString(row, 'module_kind'),
      baseVersionId: rowNullableString(row, 'base_version_id'),
      operations: parseJsonColumn(row, 'operations_json', { parse: (v) => PatchProposalSchema.shape.operations.parse(v) }, 'patch'),
      evidenceRefs: parseJsonColumn(row, 'evidence_refs_json', { parse: (v) => PatchProposalSchema.shape.evidenceRefs.parse(v) }, 'patch'),
      validationReportId: rowNullableString(row, 'validation_report_id'),
      candidateHash: rowString(row, 'candidate_hash'),
      candidate: parseJsonColumn(row, 'candidate_json', { parse: (v) => PatchProposalSchema.shape.candidate.parse(v) }, 'patch'),
      status: rowString(row, 'status'),
      description: rowString(row, 'description'),
      changeSummary: parseJsonColumn(row, 'change_summary_json', { parse: (v) => PatchProposalSchema.shape.changeSummary.parse(v) }, 'patch'),
      createdAt: rowString(row, 'created_at'),
      acceptedVersionId: rowNullableString(row, 'accepted_version_id'),
    },
    'patch',
  );
}

export function patchToRow(patch: PatchProposal): DbRow {
  return {
    id: patch.id,
    task_id: patch.taskId,
    run_id: patch.runId,
    module_id: patch.moduleId,
    module_kind: patch.moduleKind,
    base_version_id: patch.baseVersionId,
    operations_json: json(patch.operations),
    evidence_refs_json: json(patch.evidenceRefs),
    validation_report_id: patch.validationReportId,
    candidate_hash: patch.candidateHash,
    candidate_json: json(patch.candidate),
    status: patch.status,
    description: patch.description,
    change_summary_json: json(patch.changeSummary),
    created_at: patch.createdAt,
    accepted_version_id: patch.acceptedVersionId,
  };
}

export function validationReportFromRow(row: SqlRow): ValidationReport {
  return parseEntity(
    ValidationReportSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      runId: rowString(row, 'run_id'),
      moduleId: rowString(row, 'module_id'),
      baseVersionId: rowNullableString(row, 'base_version_id'),
      candidateHash: rowString(row, 'candidate_hash'),
      checks: parseJsonColumn(row, 'checks_json', { parse: (v) => ValidationReportSchema.shape.checks.parse(v) }, 'validation_report'),
      status: rowString(row, 'status'),
      summary: rowString(row, 'summary'),
      validatorVersion: rowString(row, 'validator_version'),
      createdAt: rowString(row, 'created_at'),
    },
    'validation_report',
  );
}

export function validationReportToRow(report: ValidationReport): DbRow {
  return {
    id: report.id,
    task_id: report.taskId,
    run_id: report.runId,
    module_id: report.moduleId,
    base_version_id: report.baseVersionId,
    candidate_hash: report.candidateHash,
    checks_json: json(report.checks),
    status: report.status,
    summary: report.summary,
    validator_version: report.validatorVersion,
    created_at: report.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* context snapshots                                                   */
/* ------------------------------------------------------------------ */

export function contextSnapshotFromRow(row: SqlRow): ContextSnapshot {
  return parseEntity(
    ContextSnapshotSchema,
    {
      id: rowString(row, 'id'),
      taskId: rowString(row, 'task_id'),
      runId: rowString(row, 'run_id'),
      stepId: rowNullableString(row, 'step_id'),
      promptBundleVersion: rowString(row, 'prompt_bundle_version'),
      promptTemplateHashes: parseJsonColumn(
        row,
        'prompt_template_hashes_json',
        { parse: (v) => ContextSnapshotSchema.shape.promptTemplateHashes.parse(v) },
        'context_snapshot',
      ),
      fragments: parseJsonColumn(row, 'fragments_json', { parse: (v) => ContextSnapshotSchema.shape.fragments.parse(v) }, 'context_snapshot'),
      estimatedInputTokens: rowNumber(row, 'estimated_input_tokens'),
      omitted: parseJsonColumn(row, 'omitted_json', { parse: (v) => ContextSnapshotSchema.shape.omitted.parse(v) }, 'context_snapshot'),
      createdAt: rowString(row, 'created_at'),
    },
    'context_snapshot',
  );
}

export function contextSnapshotToRow(snapshot: ContextSnapshot): DbRow {
  return {
    id: snapshot.id,
    task_id: snapshot.taskId,
    run_id: snapshot.runId,
    step_id: snapshot.stepId,
    prompt_bundle_version: snapshot.promptBundleVersion,
    prompt_template_hashes_json: json(snapshot.promptTemplateHashes),
    fragments_json: json(snapshot.fragments),
    estimated_input_tokens: snapshot.estimatedInputTokens,
    omitted_json: json(snapshot.omitted),
    created_at: snapshot.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* tool invocations                                                    */
/* ------------------------------------------------------------------ */

export function toolInvocationFromRow(row: SqlRow): ToolInvocationRecord {
  return parseEntity(
    ToolInvocationRecordSchema,
    {
      toolCallId: rowString(row, 'tool_call_id'),
      runId: rowString(row, 'run_id'),
      stepId: rowString(row, 'step_id'),
      toolId: rowString(row, 'tool_id'),
      status: rowString(row, 'status'),
      argumentsJson: rowString(row, 'arguments_json'),
      resultSummary: rowNullableString(row, 'result_summary'),
      resultObjectHash: rowNullableString(row, 'result_object_hash'),
      resultBytes: rowNullableNumber(row, 'result_bytes'),
      error: parseNullableJsonColumn(row, 'error_json', { parse: (v) => ToolInvocationRecordSchema.shape.error.parse(v) }, 'tool_invocation'),
      attempt: rowNumber(row, 'attempt'),
      plannedAt: rowString(row, 'planned_at'),
      authorizedAt: rowNullableString(row, 'authorized_at'),
      startedAt: rowNullableString(row, 'started_at'),
      finishedAt: rowNullableString(row, 'finished_at'),
    },
    'tool_invocation',
  );
}

export function toolInvocationToRow(record: ToolInvocationRecord): DbRow {
  return {
    tool_call_id: record.toolCallId,
    run_id: record.runId,
    step_id: record.stepId,
    tool_id: record.toolId,
    status: record.status,
    arguments_json: record.argumentsJson,
    result_summary: record.resultSummary,
    result_object_hash: record.resultObjectHash,
    result_bytes: record.resultBytes,
    error_json: nullableJson(record.error),
    attempt: record.attempt,
    planned_at: record.plannedAt,
    authorized_at: record.authorizedAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
  };
}

/* ------------------------------------------------------------------ */
/* recipes                                                             */
/* ------------------------------------------------------------------ */

export function recipeFromRow(row: SqlRow): Recipe {
  return parseEntity(
    RecipeSchema,
    {
      id: rowString(row, 'id'),
      version: rowNumber(row, 'version'),
      name: rowString(row, 'name'),
      description: rowString(row, 'description'),
      kind: rowString(row, 'kind'),
      status: rowString(row, 'status'),
      dslVersion: rowString(row, 'dsl_version'),
      inputParameters: parseJsonColumn(row, 'input_parameters_json', { parse: (v) => RecipeSchema.shape.inputParameters.parse(v) }, 'recipe'),
      steps: parseJsonColumn(row, 'steps_json', { parse: (v) => RecipeSchema.shape.steps.parse(v) }, 'recipe'),
      outputArtifactKind: rowString(row, 'output_artifact_kind'),
      validators: parseJsonColumn(row, 'validators_json', { parse: (v) => RecipeSchema.shape.validators.parse(v) }, 'recipe'),
      permissions: parseJsonColumn(row, 'permissions_json', { parse: (v) => RecipeSchema.shape.permissions.parse(v) }, 'recipe'),
      budget: parseJsonColumn(row, 'budget_json', { parse: (v) => RecipeSchema.shape.budget.parse(v) }, 'recipe'),
      testCases: parseJsonColumn(row, 'test_cases_json', { parse: (v) => RecipeSchema.shape.testCases.parse(v) }, 'recipe'),
      fingerprint: rowString(row, 'fingerprint'),
      fingerprintInputs: parseJsonColumn(
        row,
        'fingerprint_inputs_json',
        { parse: (v) => RecipeSchema.shape.fingerprintInputs.parse(v) },
        'recipe',
      ),
      sourceRunId: rowString(row, 'source_run_id'),
      sourceTaskId: rowString(row, 'source_task_id'),
      sourceModuleId: rowNullableString(row, 'source_module_id'),
      applicability: rowString(row, 'applicability'),
      staleReason: rowNullableString(row, 'stale_reason'),
      createdAt: rowString(row, 'created_at'),
      updatedAt: rowString(row, 'updated_at'),
    },
    'recipe',
  );
}

export function recipeToRow(recipe: Recipe): DbRow {
  return {
    id: recipe.id,
    version: recipe.version,
    name: recipe.name,
    description: recipe.description,
    kind: recipe.kind,
    status: recipe.status,
    dsl_version: recipe.dslVersion,
    input_parameters_json: json(recipe.inputParameters),
    steps_json: json(recipe.steps),
    output_artifact_kind: recipe.outputArtifactKind,
    validators_json: json(recipe.validators),
    permissions_json: json(recipe.permissions),
    budget_json: json(recipe.budget),
    test_cases_json: json(recipe.testCases),
    fingerprint: recipe.fingerprint,
    fingerprint_inputs_json: json(recipe.fingerprintInputs),
    source_run_id: recipe.sourceRunId,
    source_task_id: recipe.sourceTaskId,
    source_module_id: recipe.sourceModuleId,
    applicability: recipe.applicability,
    stale_reason: recipe.staleReason,
    created_at: recipe.createdAt,
    updated_at: recipe.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* provider profiles                                                   */
/* ------------------------------------------------------------------ */

export function providerProfileFromRow(row: SqlRow): ProviderProfile {
  return parseEntity(
    ProviderProfileSchema,
    {
      id: rowString(row, 'id'),
      profileName: rowString(row, 'profile_name'),
      adapterType: rowString(row, 'adapter_type'),
      baseURL: rowString(row, 'base_url'),
      model: rowString(row, 'model'),
      credentialRef: rowString(row, 'credential_ref'),
      enabled: rowBoolean(row, 'enabled'),
      timeouts: parseJsonColumn(row, 'timeouts_json', { parse: (v) => ProviderProfileSchema.shape.timeouts.parse(v) }, 'provider_profile'),
      contextWindowOverride: rowNullableNumber(row, 'context_window_override'),
      priceTable: parseNullableJsonColumn(row, 'price_table_json', { parse: (v) => ProviderProfileSchema.shape.priceTable.parse(v) }, 'provider_profile'),
      capabilities: parseJsonColumn(row, 'capabilities_json', { parse: (v) => ProviderProfileSchema.shape.capabilities.parse(v) }, 'provider_profile'),
      createdAt: rowString(row, 'created_at'),
      updatedAt: rowString(row, 'updated_at'),
    },
    'provider_profile',
  );
}

export function providerProfileToRow(profile: ProviderProfile): DbRow {
  return {
    id: profile.id,
    profile_name: profile.profileName,
    adapter_type: profile.adapterType,
    base_url: profile.baseURL,
    model: profile.model,
    credential_ref: profile.credentialRef,
    enabled: boolValue(profile.enabled),
    timeouts_json: json(profile.timeouts),
    context_window_override: profile.contextWindowOverride ?? null,
    price_table_json: nullableJson(profile.priceTable),
    capabilities_json: json(profile.capabilities),
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* business events                                                     */
/* ------------------------------------------------------------------ */

export function eventFromRow(row: SqlRow): HarnessEvent {
  return parseHarnessEvent({
    schemaVersion: rowString(row, 'schema_version'),
    eventId: rowString(row, 'event_id'),
    taskId: rowString(row, 'task_id'),
    runId: rowNullableString(row, 'run_id'),
    stepId: rowNullableString(row, 'step_id'),
    seq: rowNumber(row, 'seq'),
    causationId: rowNullableString(row, 'causation_id'),
    type: rowString(row, 'type'),
    category: rowString(row, 'category'),
    payload: parseJsonColumn(row, 'payload_json', { parse: (v) => v }, 'event'),
    timestamp: rowString(row, 'timestamp'),
  });
}

export function eventToRow(event: HarnessEvent): DbRow {
  return {
    event_id: event.eventId,
    task_id: event.taskId,
    run_id: event.runId,
    step_id: event.stepId,
    seq: event.seq,
    causation_id: event.causationId,
    type: event.type,
    category: event.category,
    schema_version: event.schemaVersion,
    payload_json: json(event.payload),
    timestamp: event.timestamp,
    recorded_at: nowIso(),
  };
}
