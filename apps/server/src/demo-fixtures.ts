/**
 * Fixed, reproducible Demo event fixtures (design 3.3 / 17.3).
 *
 * The Demo namespace shows a scripted but internally consistent history:
 * - one accepted architecture module (version + evidence + validation),
 * - one pending cleanup patch awaiting review,
 * - one plan preview blocked by a real constraint conflict (mechanism A/B),
 * - one earlier failed attempt (honest failure state),
 * - one validated deterministic cleaning recipe (mechanism C),
 * - high-ledge prospects computed from real dependency state.
 *
 * Demo is read-only for new runs; these fixtures never call a model. All data is
 * labelled synthetic in the UI and task sources carry trustLevel synthetic_demo.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_BUDGET_POLICY,
  POLICY_VERSION,
  canonicalJson,
  createBudgetUsage,
  newArtifactVersionId,
  newBlockerId,
  newCheckpointId,
  newContextSnapshotId,
  newEventId,
  newModelCallId,
  newPatchId,
  newRecipeId,
  newRunId,
  newValidationReportId,
  utcNow,
  type Artifact,
  type ArtifactModule,
  type ArtifactVersion,
  type Blocker,
  type ContextSnapshot,
  type HarnessEvent,
  type ModuleContent,
  type PatchProposal,
  type Plan,
  type Recipe,
  type Run,
  type SourceItem,
  type Step,
  type Task,
  type ValidationReport,
  type Workspace,
} from '@ca/contracts';
import { applyTransformOperations, csvContentFromTable, parseCsv, tableFromParsedCsv } from '@ca/tools';
import type { EventDraft, StoragePort } from '@ca/storage';

export interface DemoFixtureInput {
  storage: StoragePort;
  task: Task;
  artifact: Artifact;
  modules: ArtifactModule[];
  sources: SourceItem[];
  legacyCsvText: string;
  log: (message: string, details?: Record<string, unknown>) => void;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

/** Deterministic cleaning of the demo legacy CSV using the registered operators. */
function cleanLegacyCsv(csvText: string): ModuleContent {
  const parsed = parseCsv(csvText, {});
  const table = tableFromParsedCsv(parsed);
  const renamed = applyTransformOperations(table, [
    { op: 'rename', mapping: { sys_id: 'system_id', owner: 'owner_dept', protocol_type: 'protocol' } },
  ]);
  const normalized = applyTransformOperations(renamed.table, [
    { op: 'normalize', column: 'status', transforms: ['trim', 'lower'], nullTokens: [] },
    { op: 'normalize', column: 'system_id', transforms: ['trim'], nullTokens: [] },
  ]);
  const deduped = applyTransformOperations(normalized.table, [
    { op: 'dedupe', keys: ['system_id'], keep: 'last', normalize: 'trim_lower' },
    { op: 'sort', column: 'system_id', direction: 'asc', numeric: false },
    { op: 'require', columns: ['system_id', 'name'] },
  ]);
  return csvContentFromTable(deduped.table);
}

function planFor(input: {
  runId: string;
  moduleId: string;
  moduleKind: 'markdown' | 'json' | 'csv';
  goal: string;
  toolIds: string[];
  risks: Plan['risks'];
  openQuestions: Plan['openQuestions'];
  version?: number;
}): Plan {
  const now = utcNow();
  const stepBase: Plan['steps'] = [
    { id: 's1', title: '读取已授权资料', kind: 'tool' as const, dependencies: [] as string[], toolId: 'source.read', description: '读取与目标模块相关的资料片段', expectedOutput: '资料片段与证据', inputRefs: [] },
    { id: 's2', title: '生成候选成果', kind: 'model' as const, dependencies: ['s1'], toolId: null, description: '依据资料与约束生成模块候选内容', expectedOutput: '模块候选内容', inputRefs: [] },
    { id: 's3', title: '确定性验证', kind: 'validate' as const, dependencies: ['s2'], toolId: null, description: '运行 L0-L3 校验并生成报告', expectedOutput: '验证报告', inputRefs: [] },
  ];
  return {
    runId: input.runId as never,
    version: input.version ?? 1,
    goal: input.goal,
    targetModuleId: input.moduleId as never,
    artifactSkeleton: [{ moduleId: input.moduleId as never, moduleKind: input.moduleKind, sections: [], expectedContentSummary: '演示夹具候选摘要' }],
    inputRefs: [],
    constraintRefs: [],
    assumptions: [
      { id: 'ASM-1', text: '演示数据均为合成数据；商业价值结论为待验证假设。', needsConfirmation: false },
    ],
    openQuestions: input.openQuestions,
    steps: stepBase,
    tools: input.toolIds.map((toolId) => ({ toolId: toolId as never, reason: '演示固定计划', effect: toolId === 'artifact.propose_patch' ? 'draft_write' : 'read' })),
    validators: [
      { id: 'l0.schema', layer: 'L0', description: '内容 Schema 校验' },
      { id: 'l1.structure', layer: 'L1', description: '结构校验' },
      { id: 'l3.constraints', layer: 'L3', description: '硬约束校验' },
    ],
    budget: DEFAULT_BUDGET_POLICY,
    risks: input.risks,
    promptVersion: 'planner.v1',
    modelProfileId: 'demo-fixture',
    createdAt: now,
  };
}

export async function seedDemoHistory(input: DemoFixtureInput): Promise<void> {
  const { storage, task, artifact, modules, sources } = input;
  const [archModule, interactionModule, cleanupModule, valueModule] = modules as [ArtifactModule, ArtifactModule, ArtifactModule, ArtifactModule];
  if (!archModule || !interactionModule || !cleanupModule || !valueModule) {
    input.log('demo history skipped: template modules missing');
    return;
  }
  const now = utcNow();
  const baseBudget = DEFAULT_BUDGET_POLICY;
  const budgetUsage = createBudgetUsage(now);

  const constraintSource = sources.find((source) => source.name === 'constraints.json');
  const legacySource = sources.find((source) => source.name === 'legacy-systems.csv');
  const evidence = constraintSource
    ? [
        {
          kind: 'user_assumption' as const,
          assumptionId: 'CONFLICT-MODEL-DEPLOYMENT',
          text: 'constraints.json：DEPLOY-1（完全离线私有化）与 AI-1（云端实时模型服务）不能同时作为硬约束成立。',
        },
      ]
    : [];

  /* ------------------------- A. accepted architecture ------------------------- */
  const run1Id = newRunId();
  const snapshot1Id = newContextSnapshotId();
  const validation1Id = newValidationReportId();
  const patch1Id = newPatchId();
  const version1Id = newArtifactVersionId();
  const archContent: ModuleContent = {
    kind: 'json',
    value: {
      components: [
        { id: 'spatial-workbench', name: '空间工作台', dependsOn: ['command-api'] },
        { id: 'command-api', name: '任务命令 API', dependsOn: ['harness-core'] },
        { id: 'harness-core', name: '执行内核', dependsOn: [] },
      ],
      deployment: {
        mode: 'hybrid_pending_clarification',
        note: '演示夹具：部署模式存在硬约束冲突，需用户决策后确定（见阻塞运行）。',
      },
      decisions: [
        { id: 'D-1', decision: '执行内核与 UI 解耦，UI 只提交命令', evidence: 'product-brief.md' },
        { id: 'D-2', decision: '模型凭据只在后端解析', evidence: 'constraints.json PRIVACY-1' },
      ],
      acceptance: '演示合成数据；不构成真实架构结论。',
    },
  };
  const archHash = sha256(archContent);
  const validation1: ValidationReport = {
    id: validation1Id,
    taskId: task.id,
    runId: run1Id,
    moduleId: archModule.id,
    baseVersionId: null,
    candidateHash: archHash,
    checks: [
      { id: 'v1-l0', layer: 'L0', code: 'content_schema', title: '候选内容符合模块内容 Schema', status: 'pass', detail: '演示夹具：通过运行时 Schema 校验。', evidenceRefs: [], affectedPaths: [] },
      { id: 'v1-l1', layer: 'L1', code: 'module_deps', title: '模块依赖完整性', status: 'pass', detail: '无上游依赖。', evidenceRefs: [], affectedPaths: [] },
      { id: 'v1-l3', layer: 'L3', code: 'constraints', title: '硬约束处理', status: 'pass', detail: '部署冲突不阻塞本模块内容，但已在计划与运行中显式记录。', evidenceRefs: evidence, affectedPaths: [] },
      { id: 'v1-l4', layer: 'L4', code: 'human_review', title: '人工验收', status: 'needs_review', detail: '方案合理性与实际可用性由用户验收。', evidenceRefs: [], affectedPaths: [] },
    ],
    status: 'needs_review',
    summary: '机器校验 L0-L3 通过；L4 由用户接受（演示夹具）。',
    validatorVersion: 'deterministic-validator-1',
    createdAt: now,
  };
  const patch1: PatchProposal = {
    id: patch1Id,
    taskId: task.id,
    runId: run1Id,
    moduleId: archModule.id,
    moduleKind: 'json',
    baseVersionId: null,
    operations: [{ kind: 'replace_module', content: archContent }],
    evidenceRefs: evidence,
    validationReportId: validation1Id,
    candidateHash: archHash,
    candidate: archContent,
    status: 'accepted',
    description: '演示夹具：生成核心架构拓扑 JSON。',
    changeSummary: { addedLines: 0, removedLines: 0, changedSections: [], addedSections: [], removedSections: [], affectedRows: 0, note: '演示夹具' },
    createdAt: now,
    acceptedVersionId: version1Id,
  };
  const version1: ArtifactVersion = {
    id: version1Id,
    artifactId: artifact.id,
    moduleId: archModule.id,
    moduleKind: 'json',
    contentHash: archHash,
    content: archContent,
    parentId: null,
    baseVersionId: null,
    sourceRunId: run1Id,
    patchId: patch1Id,
    validationReportId: validation1Id,
    acceptedBy: 'local-user',
    acceptedAt: now,
    note: '演示夹具：已接受架构成果',
    restoredFromVersionId: null,
  };
  const snapshot1: ContextSnapshot = {
    id: snapshot1Id,
    taskId: task.id,
    runId: run1Id,
    stepId: null,
    promptBundleVersion: 'prompts-1',
    promptTemplateHashes: {},
    fragments: [
      { id: 'f-goal', priority: 2, kind: 'user_goal', ref: null, contentHash: null, estimatedTokens: 120, included: true, note: '任务意图' },
      { id: 'f-brief', priority: 4, kind: 'source_span', ref: 'product-brief.md', contentHash: null, estimatedTokens: 800, included: true, note: '演示资料' },
    ],
    estimatedInputTokens: 920,
    omitted: [],
    createdAt: now,
  };
  const run1: Run = {
    id: run1Id,
    taskId: task.id,
    moduleId: archModule.id,
    mode: 'demo',
    origin: 'intent',
    state: 'COMPLETED',
    planVersion: 1,
    contextSnapshotId: snapshot1Id,
    budgetPolicy: baseBudget,
    budgetUsage: { ...budgetUsage, modelRequests: 4, toolCalls: 3, inputTokens: 3200, outputTokens: 1800, elapsedActiveMs: 42_000, startedAt: now, updatedAt: now },
    baseVersionId: null,
    revision: 6,
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
  const plan1 = planFor({
    runId: run1Id,
    moduleId: archModule.id,
    moduleKind: 'json',
    goal: '根据 product-brief.md 与 constraints.json 生成核心架构拓扑与决策记录',
    toolIds: ['source.read', 'artifact.propose_patch'],
    risks: [],
    openQuestions: [],
  });
  const stepRows1: Step[] = [
    { id: crypto.randomUUID() as never, runId: run1Id as never, kind: 'tool', title: '读取已授权资料', dependencies: [], inputRefsJson: '[]', outputRefs: [], status: 'completed', attempt: 1, modelCallId: null, toolCallIds: [], summary: '读取 product-brief.md 与 constraints.json 片段', errorJson: null, startedAt: now, finishedAt: now },
    { id: crypto.randomUUID() as never, runId: run1Id as never, kind: 'model', title: '生成候选成果', dependencies: [], inputRefsJson: '[]', outputRefs: [], status: 'completed', attempt: 1, modelCallId: null, toolCallIds: [], summary: '生成核心架构拓扑 JSON', errorJson: null, startedAt: now, finishedAt: now },
    { id: crypto.randomUUID() as never, runId: run1Id as never, kind: 'validate', title: '确定性验证', dependencies: [], inputRefsJson: '[]', outputRefs: [], status: 'completed', attempt: 1, modelCallId: null, toolCallIds: [], summary: 'L0-L3 通过，等待人工接受', errorJson: null, startedAt: now, finishedAt: now },
  ];

  /* --------------------- B. pending cleanup patch (review) --------------------- */
  const run2Id = newRunId();
  const snapshot2Id = newContextSnapshotId();
  const validation2Id = newValidationReportId();
  const patch2Id = newPatchId();
  const cleanedContent = cleanLegacyCsv(input.legacyCsvText);
  const cleanedHash = sha256(cleanedContent);
  const rowCount = cleanedContent.kind === 'csv' ? cleanedContent.rows.length : 0;
  const validation2: ValidationReport = {
    id: validation2Id,
    taskId: task.id,
    runId: run2Id,
    moduleId: cleanupModule.id,
    baseVersionId: null,
    candidateHash: cleanedHash,
    checks: [
      { id: 'v2-l1', layer: 'L1', code: 'csv_structure', title: '表格结构完整', status: 'pass', detail: `清洗后 ${rowCount} 行，列与映射一致。`, evidenceRefs: [], affectedPaths: [] },
      { id: 'v2-l3', layer: 'L3', code: 'no_duplicate_keys', title: '主键唯一', status: 'pass', detail: '按 system_id 去重后无重复组。', evidenceRefs: [], affectedPaths: [] },
      { id: 'v2-l3b', layer: 'L3', code: 'required_fields', title: '必填字段', status: 'needs_review', detail: '存在 1 行缺失名称（已记录 issue，未丢弃原始输入）。', evidenceRefs: [], affectedPaths: [] },
      { id: 'v2-l4', layer: 'L4', code: 'human_review', title: '人工验收', status: 'needs_review', detail: '请确认清洗口径后可接受。', evidenceRefs: [], affectedPaths: [] },
    ],
    status: 'needs_review',
    summary: `确定性清洗完成：${rowCount} 行；需人工确认缺失必填行的处理口径。`,
    validatorVersion: 'deterministic-validator-1',
    createdAt: now,
  };
  const patch2: PatchProposal = {
    id: patch2Id,
    taskId: task.id,
    runId: run2Id,
    moduleId: cleanupModule.id,
    moduleKind: 'csv',
    baseVersionId: null,
    operations: [{ kind: 'replace_module', content: cleanedContent }],
    evidenceRefs: legacySource ? [{ kind: 'user_assumption', assumptionId: 'LEGACY-SRC', text: `来源：${legacySource.name} v${legacySource.version}（合成演示数据）` }] : [],
    validationReportId: validation2Id,
    candidateHash: cleanedHash,
    candidate: cleanedContent,
    status: 'proposed',
    description: '演示夹具：按 field-mapping.json 确定性清洗存量系统清单。',
    changeSummary: { addedLines: 0, removedLines: 0, changedSections: [], addedSections: [], removedSections: [], affectedRows: rowCount, note: '演示夹具' },
    createdAt: now,
    acceptedVersionId: null,
  };
  const snapshot2: ContextSnapshot = { ...snapshot1, id: snapshot2Id, runId: run2Id, fragments: [...snapshot1.fragments], estimatedInputTokens: 1400 };
  const run2: Run = {
    ...run1,
    id: run2Id,
    moduleId: cleanupModule.id,
    state: 'AWAITING_REVIEW',
    planVersion: 1,
    contextSnapshotId: snapshot2Id,
    revision: 4,
    budgetUsage: { ...budgetUsage, toolCalls: 3, modelRequests: 2, elapsedActiveMs: 9000, startedAt: now, updatedAt: now },
    finishedAt: null,
  };
  const plan2 = planFor({
    runId: run2Id,
    moduleId: cleanupModule.id,
    moduleKind: 'csv',
    goal: '按 field-mapping.json 对 legacy-systems.csv 执行确定性清洗并生成差异草稿',
    toolIds: ['source.read', 'data.transform', 'artifact.propose_patch'],
    risks: [],
    openQuestions: [],
  });
  const stepRows2: Step[] = stepRows1.map((step) => ({ ...step, runId: run2Id as never, id: crypto.randomUUID() as never }));
  stepRows2[2] = { ...stepRows2[2]!, title: '生成差异草稿', status: 'completed', summary: '清洗结果已进入草稿，等待人工接受' };

  /* -------------- C. plan preview blocked by real constraint conflict -------------- */
  const run3Id = newRunId();
  const snapshot3Id = newContextSnapshotId();
  const blockerId = newBlockerId();
  const snapshot3: ContextSnapshot = { ...snapshot1, id: snapshot3Id, runId: run3Id, estimatedInputTokens: 1100 };
  const run3: Run = {
    ...run1,
    id: run3Id,
    moduleId: interactionModule.id,
    state: 'AWAITING_INPUT',
    planVersion: 1,
    contextSnapshotId: snapshot3Id,
    revision: 3,
    returnState: 'READY',
    budgetUsage: { ...budgetUsage, modelRequests: 1, elapsedActiveMs: 2500, startedAt: now, updatedAt: now },
    finishedAt: null,
  };
  const conflictRisk = {
    id: 'r1',
    type: 'constraint_conflict' as const,
    basis: 'constraint_conflict' as const,
    title: '硬约束冲突：完全离线部署与云端实时模型服务',
    detail: 'constraints.json 中 DEPLOY-1 要求完全离线私有化（含模型推理），而 AI-1 要求依赖云端实时大模型服务；两者不能同时成立。',
    severity: 'blocking' as const,
    affectedModuleIds: [interactionModule.id],
    evidenceRefs: evidence,
    handlingOptions: [
      { id: 'resolve-local-model', label: '改为本地模型服务', description: '允许私有化部署接入本地模型，云端改为可选增强。' },
      { id: 'resolve-hybrid', label: '明确仅支持混合部署', description: '业务数据留在内网，智能能力调用云端；离线能力降级为只读与确定性配方。' },
      { id: 'resolve-split', label: '拆分两个交付版本', description: '离线版与云端版分别验收。' },
    ],
    resolvedByDecisionId: null,
  };
  const plan3 = planFor({
    runId: run3Id,
    moduleId: interactionModule.id,
    moduleKind: 'markdown',
    goal: '基于已接受架构与角色需求生成多模态交互引擎规范',
    toolIds: ['source.read', 'source.search', 'artifact.propose_patch'],
    risks: [conflictRisk],
    openQuestions: [
      { id: 'Q-1', question: '部署模式最终选择：完全离线、混合部署，还是拆分两个版本？', blocking: true, reason: '该决策影响架构拓扑、模型接入与合规验收，不能由 Agent 自行假设。' },
    ],
  });
  const blocker: Blocker = {
    id: blockerId,
    taskId: task.id,
    runId: run3Id,
    type: 'constraint_conflict',
    severity: 'blocking',
    title: '需要先解决部署模式硬约束冲突',
    detail: 'constraints.json 的 DEPLOY-1 与 AI-1 冲突：请选择一种处理方式，系统会记录决策并重新校验计划。',
    evidenceRefs: evidence,
    affectedSteps: [],
    affectedModuleIds: [interactionModule.id],
    resolutions: [
      {
        id: 'choose-deployment',
        kind: 'choose',
        label: '选择部署模式处理方式',
        detail: '该选择会写入决策记录，并触发计划重校验（演示模式只读，不会真正执行）。',
        options: [
          { value: 'local-model', label: '改为本地模型服务', description: '允许私有化部署接入本地模型，云端改为可选增强。' },
          { value: 'hybrid-only', label: '明确仅支持混合部署', description: '离线能力降级为只读与确定性配方。' },
          { value: 'split-versions', label: '拆分两个交付版本', description: '离线版与云端版分别验收。' },
        ],
      },
      {
        id: 'note-decision',
        kind: 'text',
        label: '补充决策说明（可选）',
        detail: '说明选择依据，例如客户合规要求或交付节奏。',
        placeholder: '例如：金融客户要求模型推理不出内网，因此选择本地模型服务。',
        multiline: true,
        maxChars: 2000,
        required: false,
      },
    ],
    status: 'open',
    resolution: null,
    returnState: 'READY',
    createdAt: now,
    resolvedAt: null,
    clearedAt: null,
  };

  /* ------------------------------ D. failed attempt ------------------------------ */
  const run4Id = newRunId();
  const run4: Run = {
    ...run1,
    id: run4Id,
    moduleId: interactionModule.id,
    state: 'FAILED',
    planVersion: 1,
    contextSnapshotId: null,
    revision: 2,
    error: { code: 'provider_auth_error', message: '演示夹具：首次尝试因模型凭据未配置而失败（技术故障，不是业务选择题）。', retryable: false, stage: 'planning', details: '' },
    budgetUsage: { ...budgetUsage, modelRequests: 0, elapsedActiveMs: 800, startedAt: now, updatedAt: now },
    finishedAt: now,
  };

  /* ---------------------------- E. validated recipe ---------------------------- */
  const recipeId = newRecipeId();
  const recipe: Recipe = {
    id: recipeId,
    version: 1,
    name: '存量系统清单确定性清洗',
    description: '按 field-mapping.json 重命名别名、规范化枚举与空白、按 system_id 去重（keep=last）、校验必填字段。合成演示数据。',
    kind: 'deterministic',
    status: 'validated',
    dslVersion: '1',
    inputParameters: [
      { name: 'sourceFile', type: 'source', required: true, description: '存量系统清单 CSV', pattern: null, enumValues: [], acceptsMime: ['text/csv'] },
    ],
    steps: [
      { id: 's1', kind: 'source.read', title: '读取原始清单', when: null, source: { kind: 'parameter', name: 'sourceFile' }, locator: null, maxChars: 8000 },
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
        title: '主键去重与必填校验',
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
      { id: 's4', kind: 'emit_artifact', title: '输出清洗成果', when: null, moduleKind: 'csv', input: { kind: 'previous_step' }, artifactName: 'cleaned.csv' },
    ],
    outputArtifactKind: 'csv',
    validators: [{ id: 'csv_structure', description: '表结构完整', supported: true }],
    permissions: {
      tools: ['source.read', 'data.transform'],
      scopes: ['sources:read', 'data:transform', 'artifact:read'],
      allowModelCalls: false,
      maxModelCallsPerRun: 0,
    },
    budget: { maxModelCalls: 0, maxToolCalls: 20, maxRuntimeMs: 60_000 },
    testCases: [
      { id: 'tc-original', label: '原始夹具 24 行', kind: 'original', inputs: { sourceFile: legacySource?.id ?? 'demo-source' }, expectation: 'accept', status: 'passed', detail: '清洗后 22 行，问题行已记录', normalizedOutputHash: null, lastRunAt: now },
      { id: 'tc-new', label: '新数据 8 行', kind: 'new_valid', inputs: { sourceFile: 'legacy-systems-new.csv' }, expectation: 'accept', status: 'passed', detail: '清洗后 7 行，无 LLM 调用', normalizedOutputHash: null, lastRunAt: now },
      { id: 'tc-invalid', label: '缺失主键列', kind: 'invalid', inputs: { sourceFile: 'legacy-systems-invalid.csv' }, expectation: 'reject', status: 'passed', detail: '输入缺少可映射的 system_id 列，已拒绝', normalizedOutputHash: null, lastRunAt: now },
    ],
    fingerprint: sha256({ steps: 'demo-cleaning-v1', tools: ['source.read', 'data.transform'], validators: ['csv_structure'], version: 1 }),
    fingerprintInputs: {
      dslVersion: '1',
      stepFingerprint: sha256({ steps: 'demo-cleaning-v1' }),
      toolVersions: { 'source.read': '1', 'data.transform': '1' },
      promptHashes: {},
      validatorVersion: 'deterministic-validator-1',
      parserVersion: 'tools-parser-1',
    },
    sourceRunId: run2Id,
    sourceTaskId: task.id,
    sourceModuleId: cleanupModule.id,
    applicability: '表头包含 sys_id/owner/protocol_type 或规范字段，且 system_id 为主键的存量系统清单。',
    staleReason: null,
    createdAt: now,
    updatedAt: now,
  };

  /* ------------------------------- persistence ------------------------------- */
  await storage.transaction(async () => {
    await storage.insertRun(run4);
    await storage.insertRun(run3);
    await storage.insertRun(run2);
    await storage.insertRun(run1);
    for (const step of [...stepRows1, ...stepRows2]) await storage.insertStep(step);
    await storage.insertPatch(patch2);
    await storage.insertPatch(patch1);
    await storage.insertValidationReport(validation2);
    await storage.insertValidationReport(validation1);
    await storage.insertVersion(version1);
    await storage.insertBlocker(blocker);
    await storage.insertContextSnapshot(snapshot1);
    await storage.insertContextSnapshot(snapshot2);
    await storage.insertContextSnapshot(snapshot3);
    await storage.insertRecipe(recipe);
  });
  await storage.updateModules([
    { ...archModule, status: 'accepted', acceptedVersionId: version1Id, updatedAt: now },
    { ...cleanupModule, status: 'ready_for_review', updatedAt: now },
  ]);
  await storage.updateTask({ ...task, revision: 1, updatedAt: now });

  /* --------------------------------- events --------------------------------- */
  const ev = (type: string, payload: unknown, runId: string | null = null, stepId: string | null = null, causationId: string | null = null): EventDraft =>
    ({ type, payload, runId, stepId, causationId } as EventDraft);
  const runEvents = (run: Run, plan: Plan | null): EventDraft[] => {
    const events: EventDraft[] = [
      ev('run.created', { runId: run.id, taskId: task.id, moduleId: run.moduleId, origin: run.origin, baseVersionId: null, budget: { maxModelRequests: baseBudget.maxModelRequests, maxToolCalls: baseBudget.maxToolCalls } }, run.id, null, 'demo-fixture'),
    ];
    if (plan) {
      events.push(
        ev('run.state_changed', { from: 'CREATED', to: 'PLANNING', reason: '演示夹具：计划命令' }, run.id),
        ev('context.snapshot_created', { contextSnapshotId: run.contextSnapshotId ?? snapshot1Id, runId: run.id, stepId: null, estimatedTokens: 900, fragmentCount: 2, omittedCount: 0 }, run.id),
        ev('model.started', { modelCallId: newModelCallId(), stepId: crypto.randomUUID(), attempt: 1, model: 'demo-fixture-model', profileId: 'demo-fixture' }, run.id),
        ev('model.finished', { modelCallId: newModelCallId(), finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 400, totalTokens: 1300, source: 'provider', costUsd: null }, textLength: 400, toolCallCount: 0, durationMs: 1200 }, run.id),
        ev('plan.proposed', { runId: run.id, planVersion: 1, plan }, run.id),
        ev('plan.ready', { runId: run.id, planVersion: 1 }, run.id),
      );
    }
    return events;
  };

  const events: EventDraft[] = [];
  events.push(...runEvents(run1, plan1));
  events.push(
    ev('run.state_changed', { from: 'READY', to: 'RUNNING', reason: '用户提交计划' }, run1.id),
    ev('plan.committed', { runId: run1.id, planVersion: 1, contextSnapshotId: snapshot1Id, committedBy: 'local-user' }, run1.id),
    ev('run.started', { runId: run1.id, attempt: 1, planVersion: 1 }, run1.id),
    ev('step.started', { stepId: stepRows1[0]!.id, kind: 'tool', title: stepRows1[0]!.title, attempt: 1 }, run1.id, stepRows1[0]!.id),
    ev('tool.requested', { toolCallId: crypto.randomUUID(), stepId: stepRows1[0]!.id, toolId: 'source.read', argumentsPreview: '{"sourceId":"product-brief.md"}', argumentsHash: sha256('read') }, run1.id, stepRows1[0]!.id),
    ev('tool.authorized', { toolCallId: crypto.randomUUID(), decision: 'allow', reason: 'P0 只读资料自动授权', scopes: ['sources:read'] }, run1.id, stepRows1[0]!.id),
    ev('tool.succeeded', { toolCallId: crypto.randomUUID(), toolId: 'source.read', resultSummary: '读取 product-brief.md 与 constraints.json 片段', resultObjectHash: null, resultBytes: 1200, durationMs: 30 }, run1.id, stepRows1[0]!.id),
    ev('step.completed', { stepId: stepRows1[0]!.id, kind: 'tool', summary: '读取资料完成', outputRefs: [] }, run1.id, stepRows1[0]!.id),
    ev('step.started', { stepId: stepRows1[1]!.id, kind: 'model', title: stepRows1[1]!.title, attempt: 1 }, run1.id, stepRows1[1]!.id),
    ev('step.completed', { stepId: stepRows1[1]!.id, kind: 'model', summary: '生成架构 JSON', outputRefs: [] }, run1.id, stepRows1[1]!.id),
    ev('step.started', { stepId: stepRows1[2]!.id, kind: 'validate', title: stepRows1[2]!.title, attempt: 1 }, run1.id, stepRows1[2]!.id),
    ev('artifact.patch_proposed', { patchId: patch1Id, moduleId: archModule.id, baseVersionId: null, candidateHash: archHash, validationReportId: validation1Id, changeSummary: patch1.changeSummary }, run1.id),
    ev('validation.completed', { validationReportId: validation1Id, moduleId: archModule.id, status: validation1.status, checks: validation1.checks, summary: validation1.summary }, run1.id),
    ev('step.completed', { stepId: stepRows1[2]!.id, kind: 'validate', summary: 'L0-L3 通过', outputRefs: [] }, run1.id, stepRows1[2]!.id),
    ev('run.state_changed', { from: 'RUNNING', to: 'VALIDATING', reason: '候选成果待校验' }, run1.id),
    ev('run.state_changed', { from: 'VALIDATING', to: 'AWAITING_REVIEW', reason: '机器校验通过，等待人工接受' }, run1.id),
    ev('artifact.accepted', { versionId: version1Id, patchId: patch1Id, moduleId: archModule.id, contentHash: archHash, acceptedBy: 'local-user', note: '演示夹具接受', route: 'user_accept' }, run1.id),
    ev('run.state_changed', { from: 'AWAITING_REVIEW', to: 'COMMITTING', reason: '用户接受候选成果' }, run1.id),
    ev('artifact.patch_proposed', { patchId: patch1Id, moduleId: archModule.id, baseVersionId: null, candidateHash: archHash, validationReportId: validation1Id, changeSummary: patch1.changeSummary }, run1.id),
    ev('run.completed', { runId: run1.id, versionId: version1Id, moduleId: archModule.id }, run1.id),
  );

  // Run 2: cleanup patch awaiting review
  events.push(...runEvents(run2, plan2));
  events.push(
    ev('run.state_changed', { from: 'READY', to: 'RUNNING', reason: '用户提交计划' }, run2.id),
    ev('plan.committed', { runId: run2.id, planVersion: 1, contextSnapshotId: snapshot2Id, committedBy: 'local-user' }, run2.id),
    ev('run.started', { runId: run2.id, attempt: 1, planVersion: 1 }, run2.id),
    ev('artifact.patch_proposed', { patchId: patch2Id, moduleId: cleanupModule.id, baseVersionId: null, candidateHash: cleanedHash, validationReportId: validation2Id, changeSummary: patch2.changeSummary }, run2.id),
    ev('validation.completed', { validationReportId: validation2Id, moduleId: cleanupModule.id, status: validation2.status, checks: validation2.checks, summary: validation2.summary }, run2.id),
    ev('run.state_changed', { from: 'RUNNING', to: 'VALIDATING', reason: '候选清洗结果待校验' }, run2.id),
    ev('run.state_changed', { from: 'VALIDATING', to: 'AWAITING_REVIEW', reason: '校验完成，等待人工接受' }, run2.id),
    ev('recipe.proposed', { recipeId, version: 1, kind: 'deterministic', name: recipe.name }, run2.id),
    ev('recipe.validated', { recipeId, version: 1, fingerprint: recipe.fingerprint, testSummary: '原始样本 22 行、新数据 7 行、非法输入被拒绝', testCases: 3 }, run2.id),
  );

  // Run 4: failed attempt (before run 3 chronologically, but seq order is fine for projection)
  events.push(
    ev('run.created', { runId: run4.id, taskId: task.id, moduleId: run4.moduleId, origin: 'intent', baseVersionId: null, budget: { maxModelRequests: 12, maxToolCalls: 20 } }, run4.id),
    ev('run.state_changed', { from: 'CREATED', to: 'PLANNING', reason: '演示夹具：首次尝试' }, run4.id),
    ev('run.failed', { runId: run4.id, error: { code: 'provider_auth_error', message: run4.error!.message, retryable: false, stage: 'planning' }, draftPreserved: true, acceptedVersionUnchanged: true }, run4.id),
    ev('run.state_changed', { from: 'PLANNING', to: 'FAILED', reason: '模型凭据未配置（技术故障）' }, run4.id),
  );

  // Run 3: plan preview blocked by constraint conflict
  events.push(...runEvents(run3, plan3));
  events.push(
    ev('blocker.detected', { blocker }, run3.id),
    ev('input.requested', { blockerId, title: blocker.title, resolutionOptionIds: blocker.resolutions.map((option) => option.id) }, run3.id),
    ev('run.state_changed', { from: 'PLANNING', to: 'AWAITING_INPUT', reason: '存在需要用户决策的硬约束冲突' }, run3.id),
  );

  const appended: HarnessEvent[] = await storage.appendEvents(task.id, events);
  input.log('demo fixture history seeded', { taskId: task.id, events: appended.length });
  void newCheckpointId;
  void newEventId;
  void POLICY_VERSION;
  void newPatchId;
  void newValidationReportId;
  void input.artifact;
}
