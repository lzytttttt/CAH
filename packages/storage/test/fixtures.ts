/**
 * Shared fixtures for the storage test suite. Every helper creates real contract
 * entities (validated by the frozen @ca/contracts schemas) and every test works
 * inside its own mkdtemp directory; the repository `data/` directory is never
 * touched.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  ArtifactModuleSchema,
  ArtifactSchema,
  ArtifactVersionIdSchema,
  ArtifactVersionSchema,
  BlockerSchema,
  BudgetPolicySchema,
  ContextSnapshotSchema,
  DecisionSchema,
  PatchProposalSchema,
  ProviderProfileSchema,
  RecipeSchema,
  RunCheckpointSchema,
  RunSchema,
  SourceItemSchema,
  SourceSpanSchema,
  StepSchema,
  TaskSchema,
  ToolInvocationRecordSchema,
  ValidationReportSchema,
  WorkspaceIdSchema,
  WorkspaceSettingsSchema,
  createBudgetUsage,
  emptyContentForKind,
  newArtifactId,
  newBlockerId,
  newCheckpointId,
  newContextSnapshotId,
  newDecisionId,
  newModuleId,
  newPatchId,
  newProviderProfileId,
  newRecipeId,
  newRunId,
  newSourceId,
  newSourceSpanId,
  newStepId,
  newTaskId,
  newToolCallId,
  newUuid,
  newValidationReportId,
  utcNow,
  type Artifact,
  type ArtifactModule,
  type ArtifactVersion,
  type ArtifactVersionId,
  type Blocker,
  type ContextSnapshot,
  type Decision,
  type ModuleContent,
  type ModuleKind,
  type PatchProposal,
  type ProviderProfile,
  type Recipe,
  type Run,
  type RunCheckpoint,
  type SourceItem,
  type SourceSpan,
  type Step,
  type Task,
  type TaskId,
  type ToolInvocationRecord,
  type ValidationReport,
  type Workspace,
  type WorkspaceId,
} from '@ca/contracts';
import { hashModuleContent, sha256Hex } from '../src/hash';
import { openStorageWithDiagnostics, type OpenStorageOptions, type SqliteStorage } from '../src/storage';
import type { EventDraft } from '../src/types';

export interface TestStorage {
  storage: SqliteStorage;
  dataDir: string;
  workspace: Workspace;
}

const activeStorages: TestStorage[] = [];

/** Create a storage instance backed by a fresh temporary directory. */
export async function createTempStorage(overrides: Partial<OpenStorageOptions> = {}): Promise<TestStorage> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ca-storage-test-'));
  const storage = openStorageWithDiagnostics({
    dataDir,
    mode: overrides.mode ?? 'demo',
    workspaceName: overrides.workspaceName ?? 'Storage Test Workspace',
    settings: overrides.settings,
  });
  const workspace = await storage.getWorkspace();
  const testStorage = { storage, dataDir, workspace };
  activeStorages.push(testStorage);
  return testStorage;
}

/** Close and delete every temporary storage created via createTempStorage. */
export async function cleanupTempStorages(): Promise<void> {
  while (activeStorages.length > 0) {
    const entry = activeStorages.pop()!;
    try {
      await entry.storage.close();
    } catch {
      /* already closed */
    }
    await rm(entry.dataDir, { recursive: true, force: true });
  }
}

export function newWorkspaceId(): WorkspaceId {
  return WorkspaceIdSchema.parse(newUuid());
}

export function newVersionId(): ArtifactVersionId {
  return ArtifactVersionIdSchema.parse(newUuid());
}

/* ------------------------------------------------------------------ */
/* tasks + artifacts                                                   */
/* ------------------------------------------------------------------ */

export interface TaskBundleFixture {
  task: Task;
  artifact: Artifact;
  modules: ArtifactModule[];
}

export function makeTaskBundle(
  workspaceId: WorkspaceId,
  options: { kinds?: ModuleKind[]; intent?: string; revision?: number } = {},
): TaskBundleFixture {
  const now = utcNow();
  const taskId = newTaskId();
  const artifactId = newArtifactId();
  const kinds = options.kinds ?? ['markdown'];
  const modules = kinds.map((kind, index) =>
    ArtifactModuleSchema.parse({
      id: newModuleId(),
      artifactId,
      title: `Module ${index + 1}`,
      kind,
      order: index,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const artifact = ArtifactSchema.parse({
    id: artifactId,
    taskId,
    title: 'Deliverable',
    moduleIds: modules.map((module) => module.id),
    createdAt: now,
    updatedAt: now,
  });
  const task = TaskSchema.parse({
    id: taskId,
    workspaceId,
    title: 'Test task',
    intent: options.intent ?? 'Produce a deliverable from the provided sources',
    constraints: [],
    artifactId,
    revision: options.revision ?? 0,
    createdAt: now,
    updatedAt: now,
  });
  return { task, artifact, modules };
}

export const defaultWorkspaceSettings = WorkspaceSettingsSchema.parse({});

/* ------------------------------------------------------------------ */
/* module contents                                                     */
/* ------------------------------------------------------------------ */

export function sampleMarkdownContent(): ModuleContent {
  return {
    kind: 'markdown',
    sections: [
      {
        id: 'summary',
        title: '摘要',
        markdown: '# 摘要\n\n包含 **中文**、emoji 🚀、引号 "double" 与换行。\n',
      },
      {
        id: 'details',
        title: 'Details',
        markdown: '| col | value |\n| --- | --- |\n| a | 1 |\n',
      },
    ],
  };
}

export function sampleJsonContent(): ModuleContent {
  return {
    kind: 'json',
    value: {
      nested: { list: [1, 2.5, null, true, '中文'], empty: {} },
      escaped: 'line1\nline2\t"quoted"',
    },
  };
}

export function sampleCsvContent(): ModuleContent {
  return {
    kind: 'csv',
    columns: [
      { key: 'name', label: 'Name', type: 'string', required: true },
      { key: 'amount', label: 'Amount', type: 'number', required: false },
      { key: 'active', label: 'Active', type: 'boolean', required: false },
    ],
    rows: [
      { name: 'Alice, A.', amount: 1.5, active: true },
      { name: '张三 "Z"', amount: null, active: false },
      { name: 'line\nbreak', amount: 0, active: null },
    ],
  };
}

export function sampleContentForKind(kind: ModuleKind): ModuleContent {
  switch (kind) {
    case 'markdown':
      return sampleMarkdownContent();
    case 'json':
      return sampleJsonContent();
    case 'csv':
      return sampleCsvContent();
  }
}

/* ------------------------------------------------------------------ */
/* versions / runs / steps / checkpoints                               */
/* ------------------------------------------------------------------ */

export function makeVersion(
  artifact: Artifact,
  module: ArtifactModule,
  options: {
    content?: ModuleContent;
    baseVersionId?: ArtifactVersionId | null;
    parentId?: ArtifactVersionId | null;
    acceptedAt?: string;
  } = {},
): ArtifactVersion {
  const content = options.content ?? sampleContentForKind(module.kind);
  return ArtifactVersionSchema.parse({
    id: newVersionId(),
    artifactId: artifact.id,
    moduleId: module.id,
    moduleKind: module.kind,
    contentHash: hashModuleContent(content),
    content,
    parentId: options.parentId ?? null,
    baseVersionId: options.baseVersionId ?? null,
    sourceRunId: null,
    patchId: null,
    validationReportId: null,
    acceptedBy: 'tester',
    acceptedAt: options.acceptedAt ?? utcNow(),
    note: '',
  });
}

export function makeRun(task: Task, moduleId: ArtifactModule['id'], options: { state?: Run['state'] } = {}): Run {
  const now = utcNow();
  return RunSchema.parse({
    id: newRunId(),
    taskId: task.id,
    moduleId,
    mode: 'demo',
    origin: 'intent',
    state: options.state ?? 'CREATED',
    budgetPolicy: BudgetPolicySchema.parse({}),
    budgetUsage: createBudgetUsage(now),
    createdAt: now,
    updatedAt: now,
  });
}

export function makeStep(run: Run, options: Partial<Step> = {}): Step {
  return StepSchema.parse({
    id: newStepId(),
    runId: run.id,
    kind: 'context',
    title: 'Build context',
    ...options,
  });
}

export function makeCheckpoint(run: Run, options: { seqAtCheckpoint?: number; kind?: RunCheckpoint['kind'] } = {}): RunCheckpoint {
  return RunCheckpointSchema.parse({
    id: newCheckpointId(),
    runId: run.id,
    kind: options.kind ?? 'state',
    stepId: null,
    seqAtCheckpoint: options.seqAtCheckpoint ?? 0,
    dataJson: JSON.stringify({ note: 'checkpoint' }),
    createdAt: utcNow(),
  });
}

/* ------------------------------------------------------------------ */
/* sources / spans                                                     */
/* ------------------------------------------------------------------ */

export function makeSource(
  taskId: TaskId,
  options: { name?: string; mime?: string; version?: number; content?: Uint8Array } = {},
): { source: SourceItem; content: Uint8Array } {
  const content = options.content ?? new TextEncoder().encode('# Source\n\nhello world\n');
  const hash = sha256Hex(content);
  const source = SourceItemSchema.parse({
    id: newSourceId(),
    taskId,
    name: options.name ?? 'source.md',
    mime: options.mime ?? 'text/markdown',
    version: options.version ?? 1,
    sizeBytes: content.byteLength,
    hash,
    origin: 'upload',
    trustLevel: 'user_provided',
    parseStatus: 'parsed',
    createdAt: utcNow(),
  });
  return { source, content };
}

export function makeSpan(source: SourceItem, options: Partial<SourceSpan> = {}): SourceSpan {
  return SourceSpanSchema.parse({
    id: newSourceSpanId(),
    sourceId: source.id,
    version: source.version,
    locator: { kind: 'text_lines', startLine: 1, endLine: 2 },
    quoteHash: sha256Hex('hello world'),
    excerpt: 'hello world',
    createdAt: utcNow(),
    ...options,
  });
}

/* ------------------------------------------------------------------ */
/* blockers / decisions / patches / reports                            */
/* ------------------------------------------------------------------ */

export function makeBlocker(task: Task, run: Run, options: Partial<Blocker> = {}): Blocker {
  return BlockerSchema.parse({
    id: newBlockerId(),
    taskId: task.id,
    runId: run.id,
    type: 'info_missing',
    severity: 'blocking',
    title: 'Need the target audience',
    detail: 'The brief does not say who the deliverable is for.',
    resolutions: [
      {
        id: 'choose-audience',
        kind: 'choose',
        label: 'Pick an audience',
        options: [
          { value: 'internal', label: 'Internal team' },
          { value: 'external', label: 'External customers' },
        ],
      },
    ],
    createdAt: utcNow(),
    ...options,
  });
}

export function makeDecision(task: Task, run: Run, options: Partial<Decision> = {}): Decision {
  return DecisionSchema.parse({
    id: newDecisionId(),
    taskId: task.id,
    runId: run.id,
    key: 'audience',
    valueJson: JSON.stringify({ value: 'internal' }),
    actor: 'user',
    createdAt: utcNow(),
    ...options,
  });
}

export function makePatch(
  task: Task,
  run: Run,
  module: ArtifactModule,
  options: { content?: ModuleContent; baseVersionId?: ArtifactVersionId | null } = {},
): PatchProposal {
  const candidate = options.content ?? sampleContentForKind(module.kind);
  return PatchProposalSchema.parse({
    id: newPatchId(),
    taskId: task.id,
    runId: run.id,
    moduleId: module.id,
    moduleKind: module.kind,
    baseVersionId: options.baseVersionId ?? null,
    operations: [{ kind: 'replace_module', content: candidate }],
    candidate,
    candidateHash: hashModuleContent(candidate),
    status: 'proposed',
    description: 'Regenerated module content',
    changeSummary: {},
    createdAt: utcNow(),
  });
}

export function makeValidationReport(
  task: Task,
  run: Run,
  module: ArtifactModule,
  options: Partial<ValidationReport> = {},
): ValidationReport {
  return ValidationReportSchema.parse({
    id: newValidationReportId(),
    taskId: task.id,
    runId: run.id,
    moduleId: module.id,
    baseVersionId: null,
    candidateHash: hashModuleContent(sampleContentForKind(module.kind)),
    checks: [],
    status: 'pass',
    summary: 'All deterministic checks passed',
    validatorVersion: 'validators-1',
    createdAt: utcNow(),
    ...options,
  });
}

export function makeContextSnapshot(task: Task, run: Run): ContextSnapshot {
  return ContextSnapshotSchema.parse({
    id: newContextSnapshotId(),
    taskId: task.id,
    runId: run.id,
    promptBundleVersion: 'prompts-1',
    fragments: [],
    estimatedInputTokens: 123,
    createdAt: utcNow(),
  });
}

export function makeToolInvocation(run: Run, step: Step, options: Partial<ToolInvocationRecord> = {}): ToolInvocationRecord {
  return ToolInvocationRecordSchema.parse({
    toolCallId: newToolCallId(),
    runId: run.id,
    stepId: step.id,
    toolId: 'source.list',
    status: 'planned',
    argumentsJson: '{}',
    resultSummary: null,
    resultObjectHash: null,
    resultBytes: null,
    error: null,
    attempt: 1,
    plannedAt: utcNow(),
    authorizedAt: null,
    startedAt: null,
    finishedAt: null,
    ...options,
  });
}

/* ------------------------------------------------------------------ */
/* recipes / provider profiles                                         */
/* ------------------------------------------------------------------ */

export function makeRecipe(task: Task, run: Run, options: Partial<Recipe> = {}): Recipe {
  const now = utcNow();
  return RecipeSchema.parse({
    id: newRecipeId(),
    version: 1,
    name: 'Profile then transform',
    description: 'Deterministic demo recipe',
    kind: 'deterministic',
    status: 'candidate',
    dslVersion: '1',
    inputParameters: [{ name: 'source', type: 'source', required: true }],
    steps: [
      {
        id: 'profile',
        title: 'Profile the source',
        kind: 'data.profile',
        input: { kind: 'parameter', name: 'source' },
      },
    ],
    outputArtifactKind: 'json',
    permissions: { tools: ['data.profile'], scopes: ['data:profile'], allowModelCalls: false },
    testCases: [
      { id: 'original', label: 'Original input', kind: 'original', inputs: { source: 's1' }, expectation: 'accept' },
    ],
    fingerprint: 'fingerprint-1',
    fingerprintInputs: {
      dslVersion: '1',
      stepFingerprint: 'a'.repeat(64),
      validatorVersion: 'validators-1',
      parserVersion: 'parsers-1',
    },
    sourceRunId: run.id,
    sourceTaskId: task.id,
    createdAt: now,
    updatedAt: now,
    ...options,
  });
}

export function makeProviderProfile(options: Partial<ProviderProfile> = {}): ProviderProfile {
  const now = utcNow();
  return ProviderProfileSchema.parse({
    id: newProviderProfileId(),
    profileName: 'Local test provider',
    adapterType: 'openai_compatible',
    baseURL: 'https://api.example.com/v1',
    model: 'test-model',
    credentialRef: 'CA_TEST_PROVIDER_KEY',
    contextWindowOverride: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...options,
  });
}

/* ------------------------------------------------------------------ */
/* event drafts                                                        */
/* ------------------------------------------------------------------ */

export function stateChangedDraft(run: Run, from: Run['state'], to: Run['state']): EventDraft<'run.state_changed'> {
  return {
    runId: run.id,
    stepId: null,
    causationId: null,
    type: 'run.state_changed',
    payload: { from, to, reason: 'test transition' },
  };
}

export function usageUpdatedDraft(run: Run): EventDraft<'usage.updated'> {
  return {
    runId: run.id,
    stepId: null,
    causationId: null,
    type: 'usage.updated',
    payload: {
      modelRequests: 1,
      toolCalls: 2,
      inputTokens: 30,
      outputTokens: 40,
      estimated: false,
      usdCost: null,
    },
  };
}

export function runCreatedPayload(run: Run): EventDraft<'run.created'> {
  return {
    runId: run.id,
    stepId: null,
    causationId: null,
    type: 'run.created',
    payload: {
      runId: run.id,
      taskId: run.taskId,
      moduleId: run.moduleId,
      origin: run.origin,
      baseVersionId: run.baseVersionId,
      budget: { maxModelRequests: 12, maxToolCalls: 20 },
    },
  };
}
