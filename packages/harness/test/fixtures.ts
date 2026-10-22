/**
 * Shared deterministic fixtures for the harness test suite.
 *
 * Everything is in-memory: FakeStorage + FakeProviderGateway + FakeToolRuntime +
 * the real deterministic ArtifactValidator and the real kernel.
 */
import {
  DEFAULT_BUDGET_POLICY,
  newArtifactId,
  newModuleId,
  newPatchId,
  newSourceId,
  newTaskId,
  newUuid,
  type AcceptanceCriterion,
  type Artifact,
  type ArtifactModule,
  type ArtifactVersion,
  type BudgetPolicy,
  type Constraint,
  type EvidenceRef,
  type HarnessEvent,
  type ModuleContent,
  type PatchProposal,
  type ProviderCapabilities,
  type Run,
  type RunDetail,
  type SourceItem,
  type Task,
  type ValidationReport,
  type Workspace,
  type WorkspaceSettings,
} from '@ca/contracts';
import type { ToolContext } from '@ca/tools';
import type { StoragePort } from '@ca/storage';
import { createHarnessEngine } from '../src/engine';
import { DEFAULT_HARNESS_CONFIG, systemClock, type Clock, type HarnessConfig, type HarnessEngine, type ToolContextFactoryInput } from '../src/types';
import { contentHash, sha256Hex } from '../src/hashing';
import { createArtifactValidator } from '../src/validator';
import { FakeStorage, TestClock } from './fakes/fake-storage';
import { FakeProviderGateway } from './fakes/fake-provider';
import { FakeToolRuntime } from './fakes/fake-tools';

export interface ModuleFixtureInput {
  title: string;
  kind: 'markdown' | 'json' | 'csv';
  dependencies?: number[];
  acceptanceCriteria?: Array<{ text: string; layer?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' }>;
}

export interface SourceFixtureInput {
  name: string;
  text: string;
  mime?: string;
}

export interface FixtureOptions {
  modules?: ModuleFixtureInput[];
  intent?: string;
  constraints?: Array<{ text: string; kind?: 'hard' | 'preference' | 'assumption'; status?: Constraint['status'] }>;
  workspaceSettings?: Partial<WorkspaceSettings>;
  budget?: Partial<BudgetPolicy>;
  sources?: SourceFixtureInput[];
  capabilities?: Partial<ProviderCapabilities>;
  config?: Partial<HarnessConfig>;
  /** When false the fixture does not assign a default provider profile (tests the missing-provider path). */
  configureProvider?: boolean;
}

export interface HarnessFixture {
  clock: TestClock;
  storage: FakeStorage;
  provider: FakeProviderGateway;
  tools: FakeToolRuntime;
  engine: HarnessEngine;
  workspace: Workspace;
  task: Task;
  artifact: Artifact;
  modules: ArtifactModule[];
  sources: SourceItem[];
  finished: Array<{ runId: string; state: string }>;
  taskRevision(): Promise<number>;
  events(): HarnessEvent[];
  eventTypes(): string[];
  findEvents(type: string): HarnessEvent[];
  detail(runId: string): Promise<RunDetail | null>;
  close(): Promise<void>;
}

const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  autoAcceptVerifiedDrafts: false,
  pauseWhenPageCloses: false,
  providerProfileIds: [],
  reducedMotion: false,
  theme: 'dark',
};

export async function createFixture(options: FixtureOptions = {}): Promise<HarnessFixture> {
  const clock = new TestClock();
  const storage = new FakeStorage(clock);
  const budgetPolicy: BudgetPolicy = { ...DEFAULT_BUDGET_POLICY, maxRetries: 0, ...(options.budget ?? {}) };
  const workspace = await storage.ensureWorkspace({
    name: 'harness-test',
    settings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      defaultBudget: budgetPolicy,
      ...(options.workspaceSettings ?? {}),
    },
  });
  const moduleInputs: ModuleFixtureInput[] =
    options.modules && options.modules.length > 0 ? options.modules : [{ title: '测试模块', kind: 'markdown' }];
  const taskId = newTaskId();
  const artifactId = newArtifactId();
  const moduleIds = moduleInputs.map(() => newModuleId());
  const now = clock.now();
  const modules: ArtifactModule[] = moduleInputs.map((input, index) => ({
    id: moduleIds[index]!,
    artifactId,
    title: input.title,
    kind: input.kind,
    order: index,
    dependencies: (input.dependencies ?? []).map((dependencyIndex) => moduleIds[dependencyIndex]!),
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map<AcceptanceCriterion>((criterion, criterionIndex) => ({
      id: `crit-${index + 1}-${criterionIndex + 1}`,
      text: criterion.text,
      layer: criterion.layer ?? 'L3',
      validatorId: null,
    })),
    status: 'empty',
    blockedFrom: null,
    acceptedVersionId: null,
    createdAt: now,
    updatedAt: now,
  }));
  const artifact: Artifact = {
    id: artifactId,
    taskId,
    title: '测试交付物',
    moduleIds,
    acceptedVersionId: null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  const constraints: Constraint[] = (options.constraints ?? []).map((constraint, index) => ({
    id: `C${index + 1}`,
    text: constraint.text,
    kind: constraint.kind ?? 'hard',
    status: constraint.status ?? 'confirmed',
    sourceRefs: [],
    note: '',
  }));
  const task: Task = {
    id: taskId,
    workspaceId: workspace.id,
    title: '测试任务',
    intent: options.intent ?? '生成测试模块成果说明',
    constraints,
    artifactId,
    revision: 0,
    templateId: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertTaskBundle({ task, artifact, modules });

  const sources: SourceItem[] = [];
  for (const sourceInput of options.sources ?? []) {
    const source: SourceItem = {
      id: newSourceId(),
      taskId,
      name: sourceInput.name,
      mime: sourceInput.mime ?? 'text/markdown',
      version: 1,
      sizeBytes: Buffer.byteLength(sourceInput.text, 'utf8'),
      hash: sha256Hex(sourceInput.text),
      origin: 'upload',
      trustLevel: 'user_provided',
      availability: 'available',
      parseStatus: 'parsed',
      parseNote: '',
      createdAt: now,
    };
    await storage.insertSource(source, new TextEncoder().encode(sourceInput.text));
    sources.push(source);
  }

  const provider = new FakeProviderGateway({ capabilities: options.capabilities, disabled: options.configureProvider === false });
  const tools = new FakeToolRuntime({ storage });
  const budget: BudgetPolicy = budgetPolicy;
  const finished: Array<{ runId: string; state: string }> = [];
  let validatorRef: ReturnType<typeof createArtifactValidator> | null = null;

  const toolContextFactory = async (input: ToolContextFactoryInput): Promise<ToolContext> => {
    const sourceReader: ToolContext['sources'] = {
      listSources: async (taskIdValue) => storage.listSources(taskIdValue),
      getSource: async (taskIdValue, sourceId, version) => storage.getSource(taskIdValue, sourceId, version),
      listLatestContents: async (taskIdValue) => storage.listLatestSourceContents(taskIdValue),
      listSpans: async (taskIdValue, limit) => storage.listSpans(taskIdValue, limit),
      saveSpan: async (span) => storage.insertSpans([span]),
    };
    const artifacts: ToolContext['artifacts'] = {
      getModule: async (moduleId) => storage.getModule(moduleId),
      getAcceptedVersion: async (moduleId) => storage.getAcceptedVersion(moduleId),
      getVersion: async (versionId) => storage.getVersion(versionId),
      saveProposal: async (proposalInput) => {
        if (proposalInput.validation) await storage.insertValidationReport(proposalInput.validation);
        const patch: PatchProposal = {
          id: newPatchId(),
          taskId: proposalInput.taskId,
          runId: proposalInput.runId,
          moduleId: proposalInput.moduleId,
          moduleKind: proposalInput.candidate.kind,
          baseVersionId: proposalInput.baseVersionId,
          operations: proposalInput.operations,
          evidenceRefs: proposalInput.evidenceRefs,
          validationReportId: proposalInput.validation?.id ?? null,
          candidateHash: contentHash(proposalInput.candidate),
          candidate: proposalInput.candidate,
          status: 'proposed',
          description: proposalInput.description,
          changeSummary: {
            addedLines: 0,
            removedLines: 0,
            changedSections: [],
            addedSections: [],
            removedSections: [],
            affectedRows: 0,
            note: 'fake tool proposal',
          },
          createdAt: clock.now(),
          acceptedVersionId: null,
        };
        await storage.insertPatch(patch);
        return { patch };
      },
      saveValidationReport: async (report) => storage.insertValidationReport(report),
    };
    const context: ToolContext = {
      taskId: input.taskId,
      runId: input.runId,
      stepId: input.stepId,
      toolCallId: input.toolCallId as never,
      grantedScopes: input.grantedScopes,
      sources: sourceReader,
      artifacts,
      validator: validatorRef,
      objects: storage.objects,
      capabilities: provider.capabilitiesValue,
      now: () => clock.now(),
      signal: input.signal,
    };
    return context;
  };

  const config: HarnessConfig = {
    ...DEFAULT_HARNESS_CONFIG,
    mode: 'demo',
    defaultModelProfileId: options.configureProvider === false ? null : (provider.profile.id as string),
    contextTokenBudget: 32_000,
    contextReserveTokens: 2_000,
    maxToolRounds: 8,
    ...(options.config ?? {}),
  };

  const engine = createHarnessEngine({
    storage,
    providers: provider,
    tools,
    config,
    clock,
    toolContextFactory,
    onRunFinished: (runId, state) => {
      finished.push({ runId, state });
    },
  });
  validatorRef = createArtifactValidator({ storage, clock: clock as unknown as Clock });

  return {
    clock,
    storage,
    provider,
    tools,
    engine,
    workspace,
    task,
    artifact,
    modules,
    sources,
    finished,
    async taskRevision() {
      const fresh = await storage.getTask(taskId);
      return fresh?.revision ?? 0;
    },
    events() {
      return storage.eventsFor(taskId);
    },
    eventTypes() {
      return storage.eventTypes(taskId);
    },
    findEvents(type) {
      return storage.eventsFor(taskId).filter((event) => event.type === type);
    },
    async detail(runId) {
      return engine.getRunDetail(runId as never);
    },
    async close() {
      await engine.shutdown();
      await storage.close();
    },
  };
}

/* ------------------------------- plan helpers ------------------------------ */

export function validPlannerOutput(params: {
  moduleId: string;
  moduleKind: 'markdown' | 'json' | 'csv';
  title?: string;
}): Record<string, unknown> {
  return {
    goal: '生成测试模块的候选成果',
    skeleton: [
      {
        moduleId: params.moduleId,
        moduleKind: params.moduleKind,
        sections: params.moduleKind === 'markdown' ? ['背景', '结论'] : [],
        expectedContentSummary: '结构完整、可校验的成果内容',
      },
    ],
    steps: [
      {
        id: 's1',
        title: '读取资料并生成候选成果',
        kind: 'model',
        dependencies: [],
        toolId: null,
        description: `为模块 ${params.title ?? params.moduleId} 生成候选成果`,
        expectedOutput: '候选成果 JSON',
      },
    ],
    tools: [
      { toolId: 'source.list', reason: '列出资料', effect: 'read' },
      { toolId: 'source.read', reason: '读取资料片段', effect: 'read' },
      { toolId: 'artifact.propose_patch', reason: '产出候选补丁草稿', effect: 'draft_write' },
    ],
    assumptions: [],
    openQuestions: [],
    risks: [],
    rationale: '按目标生成一份可审验的候选成果。',
  };
}

export function markdownCandidate(sections: Array<{ id: string; title: string; markdown: string }>): ModuleContent {
  return { kind: 'markdown', sections };
}

export function csvCandidate(
  columns: Array<{ key: string; label: string; type: 'string' | 'number' | 'boolean' | 'date'; required?: boolean }>,
  rows: Array<Record<string, string | number | boolean | null>>,
): ModuleContent {
  return { kind: 'csv', columns: columns.map((column) => ({ ...column, required: column.required ?? false })), rows };
}

export function candidateEnvelope(candidate: ModuleContent, evidenceRefs: EvidenceRef[] = []): string {
  return JSON.stringify({ candidate, evidenceRefs, description: '测试候选成果' });
}

export async function planToReady(
  fixture: HarnessFixture,
  plannerOutput?: Record<string, unknown>,
): Promise<{ runId: string; planVersion: number; contextSnapshotId: string | null }> {
  const moduleId = fixture.modules[0]!.id;
  fixture.provider.enqueueText(
    JSON.stringify(plannerOutput ?? validPlannerOutput({ moduleId: moduleId as string, moduleKind: fixture.modules[0]!.kind })),
  );
  const handle = await fixture.engine.plan({
    commandId: newUuid() as never,
    taskId: fixture.task.id,
    expectedRevision: await fixture.taskRevision(),
    moduleId,
    intent: fixture.task.intent,
    planFirst: true,
    actor: 'user',
  });
  if (handle.state !== 'READY') {
    throw new Error(`expected READY after planning, got ${handle.state}: ${JSON.stringify(handle.plan)}`);
  }
  return {
    runId: handle.runId as string,
    planVersion: handle.plan?.version ?? 1,
    contextSnapshotId: null,
  };
}

export async function commitRun(fixture: HarnessFixture, runId: string): Promise<{ runId: string; state: string }> {
  const detail = await fixture.engine.getRunDetail(runId as never);
  if (!detail) throw new Error('run not found');
  const run = detail.run;
  const handle = await fixture.engine.commit({
    commandId: newUuid() as never,
    runId: run.id,
    expectedRevision: await fixture.taskRevision(),
    planVersion: run.planVersion,
    contextSnapshotId: run.contextSnapshotId as string,
    actor: 'user',
  });
  return { runId: handle.runId as string, state: handle.state };
}

export async function latestPatch(fixture: HarnessFixture): Promise<PatchProposal | null> {
  const patches = await fixture.storage.listPatches(fixture.task.id);
  return patches[patches.length - 1] ?? null;
}

export async function latestReport(fixture: HarnessFixture, patch: PatchProposal): Promise<ValidationReport | null> {
  if (!patch.validationReportId) return null;
  return fixture.storage.getValidationReport(patch.validationReportId);
}

export async function currentRun(fixture: HarnessFixture, runId: string): Promise<Run> {
  const run = await fixture.storage.getRun(runId);
  if (!run) throw new Error(`run missing: ${runId}`);
  return run;
}

export function sourceSpanEvidence(span: {
  id: string;
  sourceId: string;
  version: number;
  locator: unknown;
  quoteHash: string;
  excerpt: string;
}): EvidenceRef {
  return {
    kind: 'source_span',
    span: {
      spanId: span.id as never,
      sourceId: span.sourceId as never,
      version: span.version,
      locator: span.locator as never,
      quoteHash: span.quoteHash as never,
      excerpt: span.excerpt,
    },
  };
}

/** Seed an accepted version directly (simulates "someone else accepted first"). */
export async function seedAcceptedVersion(
  fixture: HarnessFixture,
  moduleIndex: number,
  content: ModuleContent,
  options: { acceptedBy?: string } = {},
): Promise<ArtifactVersion> {
  const module = fixture.modules[moduleIndex]!;
  const version: ArtifactVersion = {
    id: newUuid() as never,
    artifactId: fixture.artifact.id,
    moduleId: module.id,
    moduleKind: module.kind,
    contentHash: contentHash(content),
    content,
    parentId: null,
    baseVersionId: null,
    sourceRunId: null,
    patchId: null,
    validationReportId: null,
    acceptedBy: options.acceptedBy ?? 'seed',
    acceptedAt: fixture.clock.now(),
    note: 'seeded',
    restoredFromVersionId: null,
  };
  fixture.storage.seedAcceptedVersion(version);
  return version;
}

export { DEFAULT_BUDGET_POLICY, systemClock };
export type { StoragePort };
