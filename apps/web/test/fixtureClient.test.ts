import { describe, expect, it } from 'vitest';
import {
  TaskSnapshotSchema,
  SessionInfoSchema,
  WorkspaceViewSchema,
  TaskListResponseSchema,
  CreateRunResponseSchema,
  RunControlResponseSchema,
  SourceImportResponseSchema,
  ExportResponseSchema,
  ImportResponseSchema,
  CreateRecipeResponseSchema,
  ProposeRecipeResponseSchema,
  ValidateRecipeResponseSchema,
  RunRecipeResponseSchema,
  ProviderProfileResponseSchema,
  TestProviderResponseSchema,
  DemoTemplateSchema,
  type HarnessEvent,
  type JsonObject,
} from '@ca/contracts';
import { createFixtureClient } from '../src/api/fixture/client';
import { buildFixtureBundle, FIXTURE_SCENARIOS, IDS, loadFixtureBundle } from '../src/api/fixture/data';
import type { ClientFailure } from '../src/api/types';
import { isClientFailure } from '../src/api/types';
import { commandEnvelope } from '../src/lib/ids';

const client = createFixtureClient({ scenario: 'review' });

async function snapshot() {
  return client.getSnapshot(IDS.task);
}

describe('fixture scenarios are valid against frozen contracts', () => {
  it.each(FIXTURE_SCENARIOS.map((scenario) => scenario.id))('scenario %s produces a contract-valid TaskSnapshot', (scenario) => {
    const bundle = buildFixtureBundle(scenario);
    const parsed = TaskSnapshotSchema.safeParse(bundle.snapshot);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
    }
    expect(parsed.success).toBe(true);
    const expectedTaskId = parsed.data.task.id;
    expect(expectedTaskId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('review fixture carries real mechanism data: plan risks, blockers, patches, prospects, recipes', async () => {
    const data = await snapshot();
    expect(data.plan?.risks.length).toBeGreaterThan(0);
    expect(data.plan?.risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null).length).toBe(1);
    expect(data.blockers.filter((blocker) => blocker.status === 'open').length).toBe(4);
    expect(data.patches.filter((patch) => patch.status === 'proposed').length).toBe(2);
    expect(data.prospects.length).toBeGreaterThan(0);
    expect(data.recipes.some((recipe) => recipe.kind === 'deterministic' && recipe.status === 'validated')).toBe(true);
    expect(data.events.length).toBeGreaterThan(5);
  });

  it('empty fixture is an honest empty state (no plan, no fake risks)', async () => {
    const emptyClient = createFixtureClient({ scenario: 'empty' });
    const data = await emptyClient.getSnapshot(IDS.task);
    expect(data.plan).toBeNull();
    expect(data.blockers).toEqual([]);
    expect(data.patches).toEqual([]);
    expect(data.activeRun).toBeNull();
    expect(data.modules.every((view) => view.acceptance.status === 'empty')).toBe(true);
  });
});

describe('fixture client session / workspace / task reads', () => {
  it('returns contract-valid session, workspace and task list', async () => {
    expect(SessionInfoSchema.safeParse(await client.getSession()).success).toBe(true);
    const workspace = WorkspaceViewSchema.safeParse(await client.getWorkspace());
    expect(workspace.success).toBe(true);
    if (workspace.success) expect(workspace.data.demoAvailable).toBe(true);
    expect(TaskListResponseSchema.safeParse(await client.listTasks()).success).toBe(true);
  });

  it('getSnapshot returns a fresh valid snapshot and honours includeEvents=false', async () => {
    const data = await client.getSnapshot(IDS.task);
    expect(TaskSnapshotSchema.safeParse(data).success).toBe(true);
    const withoutEvents = await client.getSnapshot(IDS.task, { afterSeq: 0, includeEvents: false });
    expect(withoutEvents.events).toEqual([]);
  });
});

describe('fixture client commands keep the real command envelopes', () => {
  it('rejects a stale expectedRevision with revision_conflict', async () => {
    const data = await snapshot();
    try {
      await client.createRun(IDS.task, {
        ...commandEnvelope(data.task.revision + 99),
        expectedRevision: data.task.revision + 99,
        moduleId: IDS.modules.value as never,
        intent: '生成价值矩阵',
        planFirst: true,
      });
      throw new Error('expected conflict');
    } catch (error) {
      expect(isClientFailure(error)).toBe(true);
      expect((error as ClientFailure).code).toBe('revision_conflict');
    }
  });

  it('creates a zero-risk simple plan and then simulates the run through review', async () => {
    const emptyClient = createFixtureClient({ scenario: 'empty' });
    const initial = await emptyClient.getSnapshot(IDS.task);
    const oldRevision = initial.task.revision;
    const run = await emptyClient.createRun(IDS.task, {
      ...commandEnvelope(oldRevision),
      expectedRevision: oldRevision,
      moduleId: IDS.modules.arch as never,
      intent: '生成架构拓扑',
      planFirst: true,
    });
    expect(CreateRunResponseSchema.safeParse(run).success).toBe(true);
    expect(run.plan?.risks).toEqual([]);
    const withPlan = await emptyClient.getSnapshot(IDS.task);
    const active = withPlan.activeRun;
    expect(active).not.toBeNull();
    const commit = await emptyClient.commitPlan(active!.runId, {
      ...commandEnvelope(withPlan.task.revision),
      expectedRevision: withPlan.task.revision,
      planVersion: withPlan.plan!.version,
      contextSnapshotId: IDS.context.plan as never,
    });
    expect(RunControlResponseSchema.safeParse(commit).success).toBe(true);
    expect(commit.state).toBe('AWAITING_REVIEW');
    const reviewed = await emptyClient.getSnapshot(IDS.task);
    expect(reviewed.patches.filter((patch) => patch.status === 'proposed').length).toBe(1);
  });

  it('refuses to commit a plan while a blocking risk is unresolved', async () => {
    const data = await snapshot();
    const active = data.activeRun!;
    try {
      await client.commitPlan(active.runId, {
        ...commandEnvelope(data.task.revision),
        expectedRevision: data.task.revision,
        planVersion: data.plan!.version,
        contextSnapshotId: active.contextSnapshotId!,
      });
      throw new Error('expected blocking-risk rejection');
    } catch (error) {
      expect((error as ClientFailure).code).toBe('validation_failed');
    }
  });

  it('validates resolution values with the contract helper before accepting them', async () => {
    const data = await snapshot();
    const blocker = data.blockers.find((candidate) => candidate.resolutions[0]?.kind === 'choose')!;
    const option = blocker.resolutions.find((candidate) => candidate.kind === 'choose')!;
    const invalid = await client
      .resolveInput(blocker.runId, {
        ...commandEnvelope(data.task.revision),
        expectedRevision: data.task.revision,
        blockerId: blocker.id,
        optionId: option.id,
        value: 'not-a-real-option',
        note: '',
      })
      .catch((error: unknown) => error);
    expect(isClientFailure(invalid)).toBe(true);
    expect((invalid as ClientFailure).code).toBe('validation_failed');

    const validValue = option.options[0]!.value;
    const result = await client.resolveInput(blocker.runId, {
      ...commandEnvelope(data.task.revision),
      expectedRevision: data.task.revision,
      blockerId: blocker.id,
      optionId: option.id,
      value: validValue,
      note: '夹具测试',
    });
    expect(result.state).toBeTruthy();
    const after = await snapshot();
    expect(after.blockers.some((candidate) => candidate.id === blocker.id)).toBe(false);
  });

  it('accepts a passing patch only after fetching its review and validation id', async () => {
    const data = await snapshot();
    const patchId = data.patches.find((patch) => patch.validationStatus === 'pass')!.patchId;
    const review = await client.getPatchReview(patchId);
    expect(review.validation?.id).toBeTruthy();
    const accepted = await client.acceptPatch(patchId, {
      ...commandEnvelope(data.task.revision),
      expectedRevision: data.task.revision,
      validationReportId: review.validation!.id,
      acceptMode: 'all',
      sectionIds: [],
      note: '夹具接受',
    });
    expect(accepted.versionId).toBeTruthy();
    const after = await snapshot();
    expect(after.modules.find((view) => view.module.id === review.patch.moduleId)?.acceptance.status).toBe('accepted');
    expect(after.patches.find((patch) => patch.patchId === patchId)?.status).toBe('accepted');
  });
});

describe('fixture client sources / transfer / recipes / providers', () => {
  it('imports supported sources and clearly rejects unsupported types', async () => {
    const data = await snapshot();
    const ok = await client.importSource(IDS.task, {
      ...commandEnvelope(data.task.revision),
      fileName: 'notes.md',
      mime: 'text/markdown',
      contentBase64: 'aGVsbG8=',
      origin: 'upload',
    });
    expect(SourceImportResponseSchema.safeParse(ok).success).toBe(true);
    const rejected = await client
      .importSource(IDS.task, {
        ...commandEnvelope(data.task.revision),
        fileName: 'slides.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        contentBase64: 'aGVsbG8=',
        origin: 'upload',
      })
      .catch((error: unknown) => error);
    expect(isClientFailure(rejected)).toBe(true);
    expect((rejected as ClientFailure).code).toBe('unsupported_media_type');
  });

  it('exports and imports contract-valid payloads', async () => {
    const data = await snapshot();
    const exported = await client.exportTask(IDS.task, {
      ...commandEnvelope(data.task.revision),
      format: 'markdown',
      moduleIds: [] as never,
      includeSources: false,
    });
    expect(ExportResponseSchema.safeParse(exported).success).toBe(true);
    expect(exported.bytes).toBeGreaterThan(0);
    const imported = await client.importTask({ ...commandEnvelope(), fileName: 'package.zip', contentBase64: 'aGVsbG8=' });
    expect(ImportResponseSchema.safeParse(imported).success).toBe(true);
  });

  it('proposes, registers, validates and runs a deterministic recipe (0 LLM calls)', async () => {
    const data = await snapshot();
    const completedRun = data.runs.find((run) => run.state === 'COMPLETED' && run.origin === 'recipe')!;
    const proposal = await client.proposeRecipe({
      ...commandEnvelope(),
      runId: completedRun.runId,
      name: '夹具清洗配方',
      description: '从夹具运行提取',
      kind: 'deterministic',
      applicability: '字段映射已知',
    });
    expect(ProposeRecipeResponseSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.proposal.steps.length).toBeGreaterThan(0);
    const created = await client.createRecipe({ ...commandEnvelope(), proposal: proposal.proposal });
    expect(CreateRecipeResponseSchema.safeParse(created).success).toBe(true);
    const validated = await client.validateRecipe(created.recipeId, {
      ...commandEnvelope(),
      testInputs: created.recipe.testCases.map((testCase) => ({ testCaseId: testCase.id, inputs: testCase.inputs })),
    });
    expect(ValidateRecipeResponseSchema.safeParse(validated).success).toBe(true);
    expect(validated.status).toBe('validated');
    const run = await client.runRecipe(created.recipeId, {
      ...commandEnvelope(),
      inputs: created.recipe.inputParameters.reduce<JsonObject>((acc, parameter) => {
        acc[parameter.name] = parameter.type === 'source' ? 'legacy-systems.csv' : 'x';
        return acc;
      }, {}),
      expectedRevision: (await snapshot()).task.revision,
    });
    expect(RunRecipeResponseSchema.safeParse(run).success).toBe(true);
    expect(run.result?.llmCalls).toBe(0);
    const disabled = await client.disableRecipe(created.recipeId, { ...commandEnvelope(), reason: '夹具测试' });
    expect(disabled.recipe.status).toBe('disabled');
  });

  it('provider profiles are public views only and capability tests require cost confirmation', async () => {
    const created = await client.createProviderProfile({
      ...commandEnvelope(),
      profileName: '夹具连接',
      adapterType: 'openai_compatible',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'fixture-model',
      credentialRef: 'CA_FIXTURE_KEY',
      enabled: true,
    });
    expect(ProviderProfileResponseSchema.safeParse(created).success).toBe(true);
    expect(created.profile.credentialConfigured).toBe(true);
    const rejected = await client
      .testProviderProfile(created.profileId, { ...commandEnvelope(), probes: ['auth_and_text'], confirmCharges: false })
      .catch((error: unknown) => error);
    expect((rejected as ClientFailure).code).toBe('bad_request');
    const report = await client.testProviderProfile(created.profileId, { ...commandEnvelope(), probes: ['auth_and_text', 'streaming'], confirmCharges: true });
    expect(TestProviderResponseSchema.safeParse(report).success).toBe(true);
    expect(report.report.probes.length).toBe(2);
  });

  it('demo template is contract-valid', async () => {
    expect(DemoTemplateSchema.safeParse(await client.getDemoScenario()).success).toBe(true);
  });
});

describe('fixture events are contract-valid', () => {
  it('every fixture event parses through the shared HarnessEvent schema on the snapshot boundary', async () => {
    const data = await snapshot();
    for (const event of data.events) {
      const typed = event as unknown as HarnessEvent;
      expect(typed.seq).toBeGreaterThan(0);
      expect(typed.taskId).toBe(IDS.task);
    }
    const bundle = loadFixtureBundle('review');
    expect(Array.isArray(bundle.snapshot)).toBe(false);
  });
});
