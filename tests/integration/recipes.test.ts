import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_POLICY,
  createBudgetUsage,
  newRunId,
  utcNow,
  type RecipeProposalInput,
  type Run,
  type TaskSnapshot,
} from '@ca/contracts';
import { createHarness, type TestHarness } from './helpers';

const uuid = (): string => crypto.randomUUID();
const scenario = path.resolve(__dirname, '../../scenarios/cognitive-atrium');

async function inject(harness: TestHarness, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await harness.app.inject({ method, url, headers: harness.headers, payload: payload as never });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function importCsv(harness: TestHarness, taskId: string, name: string): Promise<string> {
  const bytes = await readFile(path.join(scenario, name));
  const response = await inject(harness, 'POST', `/api/tasks/${taskId}/sources`, {
    commandId: uuid(),
    fileName: name,
    mime: 'text/csv',
    contentBase64: bytes.toString('base64'),
  });
  expect(response.status).toBe(200);
  expect(response.body.parseStatus).toBe('parsed');
  return response.body.sourceId as string;
}

function cleaningProposal(sourceIds: { original: string; newValid: string; invalid: string }): RecipeProposalInput {
  return {
    runId: uuid() as never,
    name: '存量系统清单确定性清洗（集成测试）',
    description: '按 field-mapping 别名重命名、规范化、主键去重与必填校验。',
    kind: 'deterministic',
    inputParameters: [
      {
        name: 'sourceFile',
        type: 'source',
        required: true,
        description: '存量系统 CSV',
        pattern: null,
        enumValues: [],
        acceptsMime: ['text/csv'],
      },
    ],
    steps: [
      {
        id: 's1',
        kind: 'source.read',
        title: '读取原始清单',
        when: null,
        source: { kind: 'parameter', name: 'sourceFile' },
        locator: null,
        maxChars: 8000,
      },
      {
        id: 's2',
        kind: 'data.transform',
        title: '别名映射与规范化',
        when: null,
        input: { kind: 'previous_step' },
        format: 'csv',
        operations: [
          { op: 'rename', mapping: { sys_id: 'system_id', owner: 'owner_dept', protocol_type: 'protocol' } },
          { op: 'normalize', column: 'status', transforms: ['trim', 'lower'], nullTokens: [] },
          { op: 'normalize', column: 'system_id', transforms: ['trim'], nullTokens: [] },
        ],
        outputName: 'cleaned.csv',
      },
      {
        id: 's3',
        kind: 'data.transform',
        title: '去重与必填',
        when: null,
        input: { kind: 'previous_step' },
        format: 'csv',
        operations: [
          { op: 'dedupe', keys: ['system_id'], keep: 'last', normalize: 'trim_lower' },
          { op: 'sort', column: 'system_id', direction: 'asc', numeric: false },
          { op: 'require', columns: ['system_id', 'name'] },
        ],
        outputName: 'cleaned.csv',
      },
      {
        id: 's4',
        kind: 'emit_artifact',
        title: '输出清洗成果',
        when: null,
        moduleKind: 'csv',
        input: { kind: 'previous_step' },
        artifactName: 'cleaned.csv',
      },
    ],
    testCases: [
      { id: 'tc-original', label: '原始夹具', kind: 'original', inputs: { sourceFile: sourceIds.original }, expectation: 'accept', status: 'untested', detail: '', normalizedOutputHash: null, lastRunAt: null },
      { id: 'tc-new', label: '新数据', kind: 'new_valid', inputs: { sourceFile: sourceIds.newValid }, expectation: 'accept', status: 'untested', detail: '', normalizedOutputHash: null, lastRunAt: null },
      { id: 'tc-invalid', label: '缺失主键列', kind: 'invalid', inputs: { sourceFile: sourceIds.invalid }, expectation: 'reject', status: 'untested', detail: '', normalizedOutputHash: null, lastRunAt: null },
    ],
    applicability: '表头含 sys_id/owner/protocol_type 的存量系统清单。',
  };
}

describe('recipe registry and deterministic run through the server', () => {
  it('registers, validates against original/new/invalid fixtures, then runs on new data with zero LLM calls', async () => {
    const harness = await createHarness();
    try {
      const created = await inject(harness, 'POST', '/api/tasks', {
        commandId: uuid(),
        title: '配方任务',
        intent: '验证确定性清洗配方',
        artifactTitle: '清洗交付物',
        modules: [{ key: 'cleanup', title: '存量系统清洗', kind: 'csv', order: 0, dependsOnKeys: [], acceptanceCriteria: [] }],
      });
      expect(created.status).toBe(200);
      const taskId = created.body.taskId as string;
      const moduleId = created.body.moduleIds[0] as string;
      const originals = {
        original: await importCsv(harness, taskId, 'legacy-systems.csv'),
        newValid: await importCsv(harness, taskId, 'legacy-systems-new.csv'),
        invalid: await importCsv(harness, taskId, 'legacy-systems-invalid.csv'),
      };

      // Extraction requires a real run trace; this test registers the reviewed
      // proposal directly (extraction is covered by packages/recipes tests).
      const proposal = cleaningProposal(originals);
      proposal.runId = (await createRunId(harness)) as never;
      const register = await inject(harness, 'POST', '/api/recipes', { commandId: uuid(), proposal });
      expect(register.status).toBe(200);
      expect(register.body.status).toBe('candidate');
      const recipeId = register.body.recipeId as string;

      const validate = await inject(harness, 'POST', `/api/recipes/${recipeId}/validate`, {
        commandId: uuid(),
        testInputs: [
          { testCaseId: 'tc-original', inputs: { sourceFile: originals.original } },
          { testCaseId: 'tc-new', inputs: { sourceFile: originals.newValid } },
          { testCaseId: 'tc-invalid', inputs: { sourceFile: originals.invalid } },
        ],
      });
      expect(validate.status).toBe(200);
      expect(validate.body.status).toBe('validated');
      const statuses = (validate.body.testCases as Array<{ id: string; status: string }>).map((testCase) => `${testCase.id}:${testCase.status}`);
      expect(statuses).toEqual(['tc-original:passed', 'tc-new:passed', 'tc-invalid:passed']);

      const run = await inject(harness, 'POST', `/api/recipes/${recipeId}/run`, {
        commandId: uuid(),
        inputs: { sourceFile: originals.newValid },
      });
      expect(run.status).toBe(200);
      expect(run.body.cacheState).toBe('executed');
      expect(run.body.result.llmCalls).toBe(0);
      expect(run.body.result.outputs[0].rowCount).toBe(7);

      const snapshot = await inject(harness, 'GET', `/api/tasks/${taskId}/snapshot`);
      const pending = (snapshot.body.patches as Array<{ patchId: string }>)[0];
      expect(pending).toBeTruthy();
      const review = await inject(harness, 'GET', `/api/patches/${pending!.patchId}`);
      expect(review.body.validation.status).not.toBe('fail');
      const content = review.body.patch.candidate as { kind: string; rows: unknown[] };
      expect(content.kind).toBe('csv');
      expect(content.rows).toHaveLength(7);

      // Deterministic recipe output still follows the normal review/accept path.
      const accepted = await inject(harness, 'POST', `/api/patches/${pending!.patchId}/accept`, {
        commandId: uuid(),
        expectedRevision: snapshot.body.task.revision,
        validationReportId: review.body.patch.validationReportId,
        acceptMode: 'all',
        sectionIds: [],
        note: '配方成果接受',
      });
      expect(accepted.status).toBe(200);
      const finalSnapshot = (await inject(harness, 'GET', `/api/tasks/${taskId}/snapshot`)).body as TaskSnapshot;
      const module = finalSnapshot.modules.find((m) => m.module.id === moduleId)!;
      expect(module.module.status).toBe('accepted');

      // Running a deterministic recipe must never request a model.
      expect(harness.provider.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  }, 90_000);
});

/** Insert a minimal finished run used only as the recipe's provenance reference. */
async function createRunId(harness: TestHarness): Promise<string> {
  const rt = harness.manager.runtime('live');
  const tasks = await rt.storage.listTasks();
  const task = tasks[0]!;
  const aggregate = await rt.storage.getTaskAggregate(task.id);
  const module = aggregate!.modules[0]!;
  const now = utcNow();
  const run: Run = {
    id: newRunId(),
    taskId: task.id,
    moduleId: module.id,
    mode: 'live',
    origin: 'intent',
    state: 'COMPLETED',
    planVersion: 1,
    contextSnapshotId: null,
    budgetPolicy: DEFAULT_BUDGET_POLICY,
    budgetUsage: createBudgetUsage(now),
    baseVersionId: null,
    revision: 1,
    returnState: null,
    interrupted: null,
    error: null,
    checkpointId: null,
    attempt: 1,
    autoAcceptPolicyApplied: false,
    queuePosition: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
  };
  await rt.storage.insertRun(run);
  return run.id;
}
