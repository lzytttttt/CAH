/**
 * Deterministic fixture data for the spatial workbench preview.
 *
 * Every object below is parsed through the frozen contract schemas at the end
 * of the builder, so the fixture can never drift into "almost valid" shapes.
 * The content mirrors the built-in synthetic scenario in `scenarios/cognitive-
 * atrium` (four modules, constraints conflict, legacy CSV cleanup, value matrix)
 * and is clearly labelled as synthetic demo data in the UI (ModeBadge: 演示).
 */
import {
  EVENT_CATEGORY_BY_TYPE,
  PatchProposalSchema,
  RecipeProposalInputSchema,
  ValidationReportSchema,
  applyPatchOperations,
  type EventType,
  type ModuleContent,
  type PatchProposal,
  type Recipe,
  type RecipeProposalInput,
  type ValidationReport,
} from '@ca/contracts';
import { spatialBranchId } from '../../lib/layout';

export type FixtureScenario = 'review' | 'blocked' | 'empty' | 'completed';

export const FIXTURE_SCENARIOS: ReadonlyArray<{ id: FixtureScenario; label: string; description: string }> = [
  { id: 'review', label: '待审阅（完整机制演示）', description: '四模块任务：计划预览 3 项风险、2 张待接受差异、4 项待决问题、3 个高台候选。' },
  { id: 'blocked', label: '阻塞与修复', description: '等待用户补齐输入与确认映射，中心已有 1 个已接受模块。' },
  { id: 'completed', label: '已接受与配方复用', description: '四个模块均已接受，确定性配方已验证，可用于演示配方运行与版本恢复。' },
  { id: 'empty', label: '空任务', description: '新建任务后的空态：没有计划、没有运行、没有证据。' },
];

const BASE_TIME = Date.parse('2026-10-20T02:00:00.000Z');

function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString();
}

/** Deterministic RFC-4122 v4 UUID (fixture only; never used for real commands). */
export function fixtureUuid(n: number): string {
  const tail = String(n).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

/** Deterministic 64-char lowercase hex digest placeholder (fixture only). */
export function fixtureHash(seed: string): string {
  let out = '';
  let h = 0x811c9dc5;
  for (let round = 0; round < 8; round += 1) {
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i) + round;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

/* ------------------------------- identifiers ------------------------------- */

export const IDS = {
  workspace: fixtureUuid(1),
  task: fixtureUuid(2),
  artifact: fixtureUuid(3),
  modules: {
    arch: fixtureUuid(10),
    interaction: fixtureUuid(11),
    cleanup: fixtureUuid(12),
    value: fixtureUuid(13),
  },
  versions: {
    archV1: fixtureUuid(20),
    interactionV1: fixtureUuid(21),
    interactionV2: fixtureUuid(22),
    cleanupV1: fixtureUuid(23),
  },
  runs: {
    arch: fixtureUuid(30),
    interaction: fixtureUuid(31),
    cleanup: fixtureUuid(32),
    plan: fixtureUuid(33),
    synthesis: fixtureUuid(34),
  },
  steps: {
    planContext: fixtureUuid(40),
    planConflict: fixtureUuid(41),
    mapping: fixtureUuid(42),
    cleanupTransform: fixtureUuid(43),
    cleanupValidate: fixtureUuid(44),
    interactionDraft: fixtureUuid(45),
  },
  toolCalls: {
    profile: fixtureUuid(50),
    transform: fixtureUuid(51),
    read: fixtureUuid(52),
  },
  sources: {
    brief: fixtureUuid(60),
    constraints: fixtureUuid(61),
    legacy: fixtureUuid(62),
    notes: fixtureUuid(63),
  },
  spans: {
    briefUsers: fixtureUuid(70),
    briefScope: fixtureUuid(71),
    constraintOffline: fixtureUuid(72),
    legacyRows: fixtureUuid(73),
    notesRoles: fixtureUuid(74),
  },
  blockers: {
    scope: fixtureUuid(80),
    conflict: fixtureUuid(81),
    mapping: fixtureUuid(82),
    noProgress: fixtureUuid(83),
  },
  patches: {
    interaction: fixtureUuid(90),
    cleanup: fixtureUuid(91),
  },
  validations: {
    interaction: fixtureUuid(100),
    cleanup: fixtureUuid(101),
    arch: fixtureUuid(102),
  },
  context: {
    plan: fixtureUuid(110),
  },
  recipes: {
    cleanup: fixtureUuid(120),
    value: fixtureUuid(121),
  },
  profiles: {
    demo: fixtureUuid(130),
  },
} as const;

/* -------------------------------- contents -------------------------------- */

const ARCH_CONTENT: ModuleContent = {
  kind: 'json',
  value: {
    components: [
      { id: 'spatial-ui', role: '空间工作台', dependsOn: ['task-api'] },
      { id: 'task-api', role: '任务命令 API', dependsOn: ['harness-core'] },
      { id: 'harness-core', role: '执行内核', dependsOn: [] },
      { id: 'tool-runtime', role: '工具运行时', dependsOn: ['harness-core'] },
      { id: 'artifact-service', role: '成果版本服务', dependsOn: ['harness-core'] },
    ],
    deployment: { mode: 'hybrid', note: '推理默认本地模型；可选云同步为待确认约束（见冲突 B-01）' },
    decisions: [
      { id: 'D-01', text: '空间 UI 不直接访问模型凭据，所有调用经后端', evidence: 'product-brief#L14' },
      { id: 'D-02', text: '默认串行工具执行，同一任务只允许一个写成果 Run', evidence: 'constraints.json#latency' },
    ],
  },
};

const INTERACTION_V2_CONTENT: ModuleContent = {
  kind: 'markdown',
  sections: [
    {
      id: 'interaction-overview',
      title: '交互总览',
      markdown:
        '## 交互总览\n\n首版支持文本输入、文件绑定与结构化审批三种交互模态。语音、图像与 PDF 在未实现解析器前明确标记为“不支持”。\n',
    },
    {
      id: 'interaction-states',
      title: '状态与事件表',
      markdown:
        '## 状态与事件表（接受基线）\n\n| 状态 | 事件 | 用户可见结果 |\n| - | - | - |\n| 等待输入 | input.requested | 显示 1–3 张修复卡 |\n| 执行中 | step.started | 显示真实步骤，不显示虚假百分比 |\n',
    },
    {
      id: 'interaction-errors',
      title: '错误处理表',
      markdown:
        '## 错误处理表\n\n- 模型鉴权失败：提示检查连接配置，不自动切换供应商。\n- 工具超时：保留检查点，允许重试或取消。\n',
    },
  ],
};

const INTERACTION_V1_CONTENT: ModuleContent = {
  kind: 'markdown',
  sections: [
    { id: 'interaction-overview', title: '交互总览', markdown: '## 交互总览\n\n首版仅支持文本输入。\n' },
    { id: 'interaction-errors', title: '错误处理表', markdown: '## 错误处理表\n\n- 网络错误：提示重试。\n' },
  ],
};

const CLEANUP_COLUMNS = [
  { key: 'system_id', label: '系统ID', type: 'string' as const, required: true },
  { key: 'name', label: '系统名称', type: 'string' as const, required: true },
  { key: 'owner_dept', label: '归属部门', type: 'string' as const, required: false },
  { key: 'protocol', label: '协议', type: 'string' as const, required: false },
  { key: 'status', label: '状态', type: 'string' as const, required: true },
];

const CLEANUP_ROWS = [
  { system_id: 'S-1001', name: '订单中心', owner_dept: '交易', protocol: 'REST', status: 'active' },
  { system_id: 'S-1001', name: '订单中心（旧）', owner_dept: '交易', protocol: 'REST', status: 'active' },
  { system_id: 'S-1004', name: '计费网关', owner_dept: '财务', protocol: 'SOAP', status: 'decommissioned' },
  { system_id: 'S-1007', name: '用户画像', owner_dept: '增长', protocol: 'GRPC', status: 'legacy' },
  { system_id: 'S-1007', name: '用户画像', owner_dept: '增长', protocol: 'GRPC', status: 'retired' },
  { system_id: 'S-1012', name: '风控决策', owner_dept: '风控', protocol: 'KAFKA', status: 'unknown' },
  { system_id: '', name: '库存同步', owner_dept: '供应链', protocol: 'REST', status: 'planned' },
];

const CLEANUP_CANDIDATE: ModuleContent = {
  kind: 'csv',
  columns: CLEANUP_COLUMNS,
  rows: CLEANUP_ROWS.filter((row) => row.system_id !== '').map((row) => ({ ...row })),
};

const CLEANUP_BASE: ModuleContent = { kind: 'csv', columns: CLEANUP_COLUMNS, rows: [] };

/* --------------------------------- helpers --------------------------------- */

function baseVersion(input: {
  id: string;
  moduleId: string;
  kind: 'markdown' | 'json' | 'csv';
  content: ModuleContent;
  hash: string;
  minutes: number;
  sourceRunId: string | null;
  validationReportId?: string | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    artifactId: IDS.artifact,
    moduleId: input.moduleId,
    moduleKind: input.kind,
    contentHash: input.hash,
    content: input.content,
    parentId: null,
    baseVersionId: null,
    sourceRunId: input.sourceRunId,
    patchId: null,
    validationReportId: input.validationReportId ?? null,
    acceptedBy: 'demo-seed',
    acceptedAt: at(input.minutes),
    note: '内置演示数据（合成）',
    restoredFromVersionId: null,
  };
}

function acceptance(input: {
  moduleId: string;
  status: string;
  acceptedVersionId: string | null;
  acceptedAt: string | null;
  acceptedSummary: string | null;
  acceptedContentHash: string | null;
  pendingPatchId: string | null;
  pendingValidationReportId: string | null;
  pendingValidationStatus: 'pass' | 'fail' | 'needs_review' | null;
  staleReason: string | null;
  openBlockerIds: string[];
}): Record<string, unknown> {
  return input;
}

/* ------------------------------- plan / risks ------------------------------- */

function evidenceSpan(spanId: string, sourceId: string, span: Record<string, unknown>): Record<string, unknown> {
  return { kind: 'source_span', span: { ...span, spanId, sourceId } };
}

/* --------------------------------- builder --------------------------------- */

export interface FixtureBundle {
  snapshot: unknown;
  patches: PatchProposal[];
  validations: Record<string, ValidationReport>;
  recipes: Recipe[];
  recipeProposals: Record<string, RecipeProposalInput>;
  baseContents: Record<string, ModuleContent | null>;
}

/** The rich "review" fixture: plan preview + risks + repair cards + patch review. */
export function buildFixtureBundle(scenario: FixtureScenario): FixtureBundle {
  const taskTitle = '次世代智能工作空间产品架构与 GTM 策略中枢';
  const artifactTitle = '产品架构与 GTM 策略中枢交付物';
  const taskIntent =
    '依据产品 brief、约束清单与存量系统数据，形成四个模块成果：核心架构拓扑、多模态交互引擎规范、存量系统兼容层清洗、商业化价值壁垒矩阵。所有市场结论必须标记为待验证假设。';

  const constraints = [
    {
      id: 'C-01',
      text: '推理必须默认在本地完成，不把用户资料发送给未批准的第三方服务。',
      kind: 'hard',
      status: 'confirmed',
      sourceRefs: [{ sourceId: IDS.sources.constraints, version: 1 }],
      note: '',
    },
    {
      id: 'C-02',
      text: '部署范围：纯离线还是允许混合云？product-brief 中存在歧义。',
      kind: 'assumption',
      status: 'conflicted',
      sourceRefs: [{ sourceId: IDS.sources.brief, version: 1 }],
      note: '需要用户确认；处理前阻止计划提交。',
    },
    {
      id: 'C-03',
      text: '首版只支持 UTF-8 TXT / Markdown / JSON / CSV 输入。',
      kind: 'preference',
      status: 'confirmed',
      sourceRefs: [],
      note: '',
    },
  ];

  const sources = [
    {
      sourceId: IDS.sources.brief,
      name: 'product-brief.md',
      version: 1,
      availability: 'available',
      spanCount: 2,
      trustLevel: 'synthetic_demo',
      previewSpanIds: [IDS.spans.briefUsers, IDS.spans.briefScope],
    },
    {
      sourceId: IDS.sources.constraints,
      name: 'constraints.json',
      version: 1,
      availability: 'available',
      spanCount: 1,
      trustLevel: 'synthetic_demo',
      previewSpanIds: [IDS.spans.constraintOffline],
    },
    {
      sourceId: IDS.sources.legacy,
      name: 'legacy-systems.csv',
      version: 1,
      availability: 'available',
      spanCount: 1,
      trustLevel: 'synthetic_demo',
      previewSpanIds: [IDS.spans.legacyRows],
    },
    {
      sourceId: IDS.sources.notes,
      name: 'stakeholder-notes.md',
      version: 1,
      availability: 'changed',
      spanCount: 1,
      trustLevel: 'synthetic_demo',
      previewSpanIds: [IDS.spans.notesRoles],
    },
  ];

  const spans = [
    {
      id: IDS.spans.briefUsers,
      sourceId: IDS.sources.brief,
      version: 1,
      locator: { kind: 'text_lines', startLine: 12, endLine: 16 },
      quoteHash: fixtureHash('brief-users'),
      excerpt: '目标用户：需要同时处理架构、交互、数据清洗与商业价值四类成果的产品与工程团队。',
      createdAt: at(1),
    },
    {
      id: IDS.spans.briefScope,
      sourceId: IDS.sources.brief,
      version: 1,
      locator: { kind: 'text_lines', startLine: 30, endLine: 34 },
      quoteHash: fixtureHash('brief-scope'),
      excerpt: '部署要求：默认本地推理；是否允许混合云同步尚未确认（存在歧义）。',
      createdAt: at(1),
    },
    {
      id: IDS.spans.constraintOffline,
      sourceId: IDS.sources.constraints,
      version: 1,
      locator: { kind: 'json_pointer', pointer: '/constraints/0' },
      quoteHash: fixtureHash('constraint-offline'),
      excerpt: '{"id":"C-01","kind":"hard","text":"推理必须默认在本地完成"}',
      createdAt: at(1),
    },
    {
      id: IDS.spans.legacyRows,
      sourceId: IDS.sources.legacy,
      version: 1,
      locator: { kind: 'csv_rows', rowNumbers: [3, 4, 7] },
      quoteHash: fixtureHash('legacy-rows'),
      excerpt: 'S-1001 订单中心 | S-1004 计费网关（异常枚举 decommissioned）| S-1012 风控决策（异常枚举 unknown）',
      createdAt: at(2),
    },
    {
      id: IDS.spans.notesRoles,
      sourceId: IDS.sources.notes,
      version: 1,
      locator: { kind: 'text_lines', startLine: 5, endLine: 9 },
      quoteHash: fixtureHash('notes-roles'),
      excerpt: '平台负责人：需要可审计的决策记录；安全负责人：资料不得离开本地环境。',
      createdAt: at(2),
    },
  ];

  const spanRefs: Record<string, Record<string, unknown>> = {
    briefUsers: evidenceSpan(IDS.spans.briefUsers, IDS.sources.brief, spans[0]!),
    briefScope: evidenceSpan(IDS.spans.briefScope, IDS.sources.brief, spans[1]!),
    constraintOffline: evidenceSpan(IDS.spans.constraintOffline, IDS.sources.constraints, spans[2]!),
    legacyRows: evidenceSpan(IDS.spans.legacyRows, IDS.sources.legacy, spans[3]!),
    notesRoles: evidenceSpan(IDS.spans.notesRoles, IDS.sources.notes, spans[4]!),
  };

  const modules = {
    arch: {
      id: IDS.modules.arch,
      artifactId: IDS.artifact,
      title: '核心架构拓扑',
      kind: 'json',
      order: 0,
      dependencies: [],
      acceptanceCriteria: [
        { id: 'arch-ac-1', text: '组件 ID 唯一，依赖关系无环', layer: 'L1', validatorId: null },
        { id: 'arch-ac-2', text: '部署模式明确（离线/混合），并说明与约束的关系', layer: 'L3', validatorId: null },
        { id: 'arch-ac-3', text: 'constraints.json 中每条硬约束都有处理结果或明确冲突', layer: 'L3', validatorId: null },
      ],
      status: 'accepted',
      blockedFrom: null,
      acceptedVersionId: IDS.versions.archV1,
      createdAt: at(0),
      updatedAt: at(14),
    },
    interaction: {
      id: IDS.modules.interaction,
      artifactId: IDS.artifact,
      title: '多模态交互引擎规范',
      kind: 'markdown',
      order: 1,
      dependencies: [IDS.modules.arch],
      acceptanceCriteria: [
        { id: 'int-ac-1', text: '明确首版支持的输入模态边界', layer: 'L3', validatorId: null },
        { id: 'int-ac-2', text: '包含状态与事件表，覆盖取消、重试、异常反馈', layer: 'L1', validatorId: null },
        { id: 'int-ac-3', text: '需求项引用 stakeholder-notes.md 的可定位证据', layer: 'L2', validatorId: null },
      ],
      status: 'ready_for_review',
      blockedFrom: null,
      acceptedVersionId: IDS.versions.interactionV2,
      createdAt: at(0),
      updatedAt: at(28),
    },
    cleanup: {
      id: IDS.modules.cleanup,
      artifactId: IDS.artifact,
      title: '存量系统兼容层清洗',
      kind: 'csv',
      order: 2,
      dependencies: [],
      acceptanceCriteria: [
        { id: 'clean-ac-1', text: '记录数可核对：输入 24 行，输出与去重规则一致', layer: 'L3', validatorId: null },
        { id: 'clean-ac-2', text: '必填字段符合规则，缺失行记录在 issues', layer: 'L3', validatorId: null },
        { id: 'clean-ac-3', text: '原始输入不被覆盖，输出为新对象', layer: 'L1', validatorId: null },
      ],
      status: 'ready_for_review',
      blockedFrom: null,
      acceptedVersionId: null,
      createdAt: at(0),
      updatedAt: at(26),
    },
    value: {
      id: IDS.modules.value,
      artifactId: IDS.artifact,
      title: '商业化价值壁垒矩阵',
      kind: 'csv',
      order: 3,
      dependencies: [IDS.modules.arch, IDS.modules.cleanup],
      acceptanceCriteria: [
        { id: 'val-ac-1', text: '每行包含用户问题、能力、价值假设、证据与待验证指标', layer: 'L1', validatorId: null },
        { id: 'val-ac-2', text: '价值陈述标记为待验证假设，不编造市场规模或营收', layer: 'L3', validatorId: null },
        { id: 'val-ac-3', text: '只使用已接受的上游版本', layer: 'L1', validatorId: null },
      ],
      status: 'blocked',
      blockedFrom: 'empty',
      acceptedVersionId: null,
      createdAt: at(0),
      updatedAt: at(18),
    },
  } as const;

  const archVersion = baseVersion({
    id: IDS.versions.archV1,
    moduleId: IDS.modules.arch,
    kind: 'json',
    content: ARCH_CONTENT,
    hash: fixtureHash('arch-v1'),
    minutes: 14,
    sourceRunId: IDS.runs.arch,
    validationReportId: IDS.validations.arch,
  });
  const interactionV1 = baseVersion({
    id: IDS.versions.interactionV1,
    moduleId: IDS.modules.interaction,
    kind: 'markdown',
    content: INTERACTION_V1_CONTENT,
    hash: fixtureHash('interaction-v1'),
    minutes: 10,
    sourceRunId: IDS.runs.interaction,
  });
  const interactionV2 = baseVersion({
    id: IDS.versions.interactionV2,
    moduleId: IDS.modules.interaction,
    kind: 'markdown',
    content: INTERACTION_V2_CONTENT,
    hash: fixtureHash('interaction-v2'),
    minutes: 22,
    sourceRunId: IDS.runs.interaction,
  });

  const validations: Record<string, ValidationReport> = {
    [IDS.validations.interaction]: ValidationReportSchema.parse({
      id: IDS.validations.interaction,
      taskId: IDS.task,
      runId: IDS.runs.interaction,
      moduleId: IDS.modules.interaction,
      baseVersionId: IDS.versions.interactionV2,
      candidateHash: fixtureHash('interaction-candidate'),
      checks: [
        { id: 'chk-0', layer: 'L0', code: 'schema_valid', title: 'Markdown 结构合法', status: 'pass', detail: '章节 ID 唯一，内容非空。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-1', layer: 'L1', code: 'state_table_present', title: '状态与事件表存在', status: 'pass', detail: '包含取消、重试与异常反馈行。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-2', layer: 'L2', code: 'evidence_linked', title: '需求项引用可定位证据', status: 'pass', detail: '3 条角色需求引用 stakeholder-notes.md 行号。', evidenceRefs: [spanRefs.notesRoles!], affectedPaths: [] },
        { id: 'chk-3', layer: 'L3', code: 'modality_boundary', title: '输入模态边界明确', status: 'pass', detail: '语音与 PDF 标记为不支持。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-4', layer: 'L4', code: 'human_review', title: '人工审阅（方案合理性）', status: 'not_applicable', detail: '由用户在差异审阅中确认。', evidenceRefs: [], affectedPaths: [] },
      ],
      status: 'pass',
      summary: '确定性校验全部通过（L0–L3）；表达质量由人工审阅确认。',
      validatorVersion: 'validator-1',
      createdAt: at(29),
    }),
    [IDS.validations.cleanup]: ValidationReportSchema.parse({
      id: IDS.validations.cleanup,
      taskId: IDS.task,
      runId: IDS.runs.cleanup,
      moduleId: IDS.modules.cleanup,
      baseVersionId: null,
      candidateHash: fixtureHash('cleanup-candidate'),
      checks: [
        { id: 'chk-0', layer: 'L0', code: 'schema_valid', title: 'CSV 结构合法', status: 'pass', detail: '7 行 × 5 列，表头与声明一致。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-1', layer: 'L1', code: 'primary_key_unique', title: '主键唯一', status: 'pass', detail: '按 keep=last 去重后 system_id 唯一。', evidenceRefs: [spanRefs.legacyRows!], affectedPaths: [] },
        { id: 'chk-2', layer: 'L3', code: 'required_fields', title: '必填字段完整', status: 'fail', detail: '1 行缺少 system_id（原 CSV 第 7 数据行），需补齐或明确排除口径。', evidenceRefs: [spanRefs.legacyRows!], affectedPaths: ['rows[6].system_id'] },
        { id: 'chk-3', layer: 'L2', code: 'evidence_exists', title: '生成数据可追踪', status: 'needs_review', detail: '去重规则来自 field-mapping.json，但该文件尚未绑定为资料版本。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-4', layer: 'L4', code: 'human_review', title: '人工审阅（业务口径）', status: 'not_applicable', detail: '由用户在差异审阅中确认。', evidenceRefs: [], affectedPaths: [] },
      ],
      status: 'fail',
      summary: '必填字段校验失败（L3）；证据绑定 1 项待复核（L2）。',
      validatorVersion: 'validator-1',
      createdAt: at(27),
    }),
    [IDS.validations.arch]: ValidationReportSchema.parse({
      id: IDS.validations.arch,
      taskId: IDS.task,
      runId: IDS.runs.arch,
      moduleId: IDS.modules.arch,
      baseVersionId: null,
      candidateHash: fixtureHash('arch-candidate'),
      checks: [
        { id: 'chk-0', layer: 'L0', code: 'schema_valid', title: 'JSON Schema 合法', status: 'pass', detail: '结构符合契约。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-1', layer: 'L1', code: 'dag', title: '依赖无环', status: 'pass', detail: '5 个组件依赖构成 DAG。', evidenceRefs: [], affectedPaths: [] },
        { id: 'chk-2', layer: 'L3', code: 'constraint_covered', title: '硬约束有处理结果', status: 'pass', detail: 'C-01 由本地推理路径满足；C-02 冲突记录在待决问题。', evidenceRefs: [spanRefs.constraintOffline!], affectedPaths: [] },
      ],
      status: 'pass',
      summary: '确定性校验通过。',
      validatorVersion: 'validator-1',
      createdAt: at(14),
    }),
  };

  const interactionOps = [
    {
      kind: 'markdown.replace_section',
      sectionId: 'interaction-states',
      title: '状态与事件表',
      markdown:
        '## 状态与事件表\n\n| 状态 | 事件 | 用户可见结果 |\n| - | - | - |\n| 等待输入 | input.requested | 显示 1–3 张修复卡，含受影响字段 |\n| 执行中 | step.started | 显示真实步骤与已完成数量 |\n| 待审阅 | artifact.patch_proposed | 打开差异审阅，显示证据与校验 |\n| 已取消 | run.cancelled | 保留已接受版本与草稿 |\n',
    },
    {
      kind: 'markdown.insert_section',
      afterSectionId: 'interaction-errors',
      title: '取消与重试约定',
      markdown:
        '## 取消与重试约定\n\n- 取消请求进入 CANCELLING，仅在安全边界生效；已接受成果不回滚。\n- 重试必须显示新的 attempt 与潜在重复费用。\n- 前端不得用动画或计时器推断成功。\n',
      id: 'interaction-cancel-retry',
    },
  ] as const;
  const interactionCandidate = applyPatchOperations(INTERACTION_V2_CONTENT, 'markdown', interactionOps as never);

  const interactionPatch = PatchProposalSchema.parse({
    id: IDS.patches.interaction,
    taskId: IDS.task,
    runId: IDS.runs.interaction,
    moduleId: IDS.modules.interaction,
    moduleKind: 'markdown',
    baseVersionId: IDS.versions.interactionV2,
    operations: interactionOps,
    evidenceRefs: [spanRefs.notesRoles!],
    validationReportId: IDS.validations.interaction,
    candidateHash: fixtureHash('interaction-candidate'),
    candidate: interactionCandidate,
    status: 'proposed',
    description: '根据角色需求补充状态与事件表，并新增取消与重试约定。',
    changeSummary: {
      addedLines: 14,
      removedLines: 5,
      changedSections: ['状态与事件表'],
      addedSections: ['取消与重试约定'],
      removedSections: [],
      affectedRows: 0,
      note: '未修改已接受的技术基线章节。',
    },
    createdAt: at(29),
    acceptedVersionId: null,
  });

  const cleanupOps = [{ kind: 'replace_module', content: CLEANUP_CANDIDATE }] as const;
  const cleanupPatch = PatchProposalSchema.parse({
    id: IDS.patches.cleanup,
    taskId: IDS.task,
    runId: IDS.runs.cleanup,
    moduleId: IDS.modules.cleanup,
    moduleKind: 'csv',
    baseVersionId: null,
    operations: cleanupOps,
    evidenceRefs: [spanRefs.legacyRows!],
    validationReportId: IDS.validations.cleanup,
    candidateHash: fixtureHash('cleanup-candidate'),
    candidate: CLEANUP_CANDIDATE,
    status: 'proposed',
    description: '按 field-mapping 别名映射、枚举规范化与 keep=last 去重生成清洗结果。',
    changeSummary: {
      addedLines: 7,
      removedLines: 0,
      changedSections: [],
      addedSections: [],
      removedSections: [],
      affectedRows: 7,
      note: '原始输入未被覆盖；输出为新的内容对象。',
    },
    createdAt: at(27),
    acceptedVersionId: null,
  });

  const blockers = [
    {
      id: IDS.blockers.scope,
      taskId: IDS.task,
      runId: IDS.runs.plan,
      type: 'info_missing',
      severity: 'blocking',
      title: '价值矩阵的部署口径未确认',
      detail: '商业化价值矩阵需要明确“纯离线”还是“允许混合云”。product-brief 与 constraints.json 对该范围存在歧义，不能由系统自行决定。',
      evidenceRefs: [spanRefs.briefScope!],
      affectedSteps: [IDS.steps.planContext],
      affectedModuleIds: [IDS.modules.value],
      resolutions: [
        {
          id: 'opt-deploy-choose',
          kind: 'choose',
          label: '选择部署口径',
          detail: '选择后写入决策记录，并重新校验受影响计划。',
          options: [
            { value: 'offline_only', label: '仅离线部署', description: '不允许任何云同步能力；价值矩阵只描述本地能力。' },
            { value: 'hybrid_allowed', label: '允许混合云', description: '核心推理在本地，允许经批准的云同步；需要补充数据边界约束。' },
          ],
        },
        {
          id: 'opt-deploy-text',
          kind: 'text',
          label: '补充业务说明',
          detail: '如果两种口径都不准确，请用一段文字说明部署范围。',
          placeholder: '例如：只在客户内网部署，不接任何公有云服务…',
          multiline: true,
          maxChars: 2000,
          required: false,
        },
      ],
      status: 'open',
      resolution: null,
      returnState: 'READY',
      createdAt: at(24),
      resolvedAt: null,
      clearedAt: null,
    },
    {
      id: IDS.blockers.conflict,
      taskId: IDS.task,
      runId: IDS.runs.plan,
      type: 'constraint_conflict',
      severity: 'blocking',
      title: '硬约束冲突：纯离线与实时云同步不能同时满足',
      detail: 'C-01 要求推理默认本地完成；产品 brief 又要求“实时云端协作”。两者冲突，必须修改输入、缩小范围，或由用户明确修改约束并留下记录。',
      evidenceRefs: [spanRefs.constraintOffline!, spanRefs.briefScope!],
      affectedSteps: [IDS.steps.planConflict, IDS.steps.interactionDraft],
      affectedModuleIds: [IDS.modules.arch, IDS.modules.interaction],
      resolutions: [
        {
          id: 'opt-conflict-constraint',
          kind: 'text',
          label: '明确修改后的约束（写入决策记录）',
          detail: '不能通过“忽略”抹掉硬冲突；需要你明确新的边界。',
          placeholder: '例如：允许经批准的私有云同步，但用户原始资料不得离开本地…',
          multiline: true,
          maxChars: 2000,
          required: true,
        },
        {
          id: 'opt-conflict-exclude',
          kind: 'exclude',
          label: '排除“实时云端协作”分支',
          detail: '缩小首版范围，保留纯离线能力；后续版本重新评估。',
          itemLabel: '实时云端协作能力',
          itemRef: 'capability:realtime-cloud',
        },
      ],
      status: 'open',
      resolution: null,
      returnState: 'READY',
      createdAt: at(25),
      resolvedAt: null,
      clearedAt: null,
    },
    {
      id: IDS.blockers.mapping,
      taskId: IDS.task,
      runId: IDS.runs.cleanup,
      type: 'validation_failed',
      severity: 'warning',
      title: '字段映射需要人工确认',
      detail: '清洗配方解析出 3 个别名映射；其中 owner → owner_dept 可能改变部门口径，请在执行前确认。',
      evidenceRefs: [spanRefs.legacyRows!],
      affectedSteps: [IDS.steps.cleanupTransform, IDS.steps.mapping],
      affectedModuleIds: [IDS.modules.cleanup],
      resolutions: [
        {
          id: 'opt-mapping-confirm',
          kind: 'confirm_mapping',
          label: '确认字段映射',
          detail: '确认后这些映射写入配方指纹，后续版本变化会触发重新测试。',
          mappingPreview: [
            { from: 'sys_id', to: 'system_id', note: '别名映射' },
            { from: 'owner', to: 'owner_dept', note: '别名映射' },
            { from: 'protocol_type', to: 'protocol', note: '别名映射' },
          ],
        },
        {
          id: 'opt-mapping-exclude',
          kind: 'exclude',
          label: '排除 owner → owner_dept 映射',
          detail: '保留原始列，不改变部门口径。',
          itemLabel: 'owner → owner_dept',
          itemRef: 'mapping:owner->owner_dept',
        },
      ],
      status: 'open',
      resolution: null,
      returnState: 'RUNNING',
      createdAt: at(26),
      resolvedAt: null,
      clearedAt: null,
    },
    {
      id: IDS.blockers.noProgress,
      taskId: IDS.task,
      runId: IDS.runs.cleanup,
      type: 'no_progress',
      severity: 'warning',
      title: '同一验证失败连续出现两次',
      detail: '必填字段失败签名未变化，继续盲目重试不会产生新结果。请选择替代路径或取消本次修复。',
      evidenceRefs: [],
      affectedSteps: [IDS.steps.cleanupValidate],
      affectedModuleIds: [IDS.modules.cleanup],
      resolutions: [
        {
          id: 'opt-progress-alt',
          kind: 'choose',
          label: '选择替代路径',
          detail: '替代路径会生成新的 planVersion，不会原地修改历史。',
          options: [
            { value: 'fill_missing', label: '补齐缺失主键后重新校验', description: '仅重跑依赖步骤。' },
            { value: 'exclude_row', label: '明确排除该行并记录原因', description: '在清洗报告中保留问题行。' },
          ],
        },
      ],
      status: 'open',
      resolution: null,
      returnState: 'AWAITING_INPUT',
      createdAt: at(27),
      resolvedAt: null,
      clearedAt: null,
    },
  ];

  const planSteps = [
    { id: 's1', title: '读取产品 brief 与约束清单', kind: 'tool', dependencies: [], toolId: 'source.read', description: '固定输入版本后构建上下文快照。', expectedOutput: '资料片段与版本清单', inputRefs: [{ kind: 'source', source: { sourceId: IDS.sources.brief, version: 1 } }] },
    { id: 's2', title: '分析约束冲突与待确认假设', kind: 'model', dependencies: ['s1'], toolId: null, description: '仅提出有依据的风险，不制造固定数量。', expectedOutput: '风险与处理选项', inputRefs: [] },
    { id: 's3', title: '确认部署口径与字段映射', kind: 'model', dependencies: ['s2'], toolId: null, description: '等待用户输入或确认。', expectedOutput: '决策记录', inputRefs: [] },
    { id: 's4', title: '更新交互规范状态与事件表', kind: 'model', dependencies: ['s1', 's3'], toolId: null, description: '只修改受影响章节。', expectedOutput: '候选 markdown 章节', inputRefs: [{ kind: 'artifact_version', versionId: IDS.versions.interactionV2, moduleId: IDS.modules.interaction }] },
    { id: 's5', title: '校验候选成果（L0–L4）', kind: 'validate', dependencies: ['s4'], toolId: 'artifact.validate', description: '确定性校验，模型自评分不参与。', expectedOutput: 'ValidationReport', inputRefs: [] },
    { id: 's6', title: '生成待接受差异', kind: 'compose', dependencies: ['s5'], toolId: 'artifact.propose_patch', description: '候选进入隔离草稿，不覆盖已接受版本。', expectedOutput: 'PatchProposal 与差异', inputRefs: [] },
  ];

  const plan = {
    runId: IDS.runs.plan,
    version: 2,
    goal: '在不违反本地推理硬约束的前提下，更新交互规范并澄清价值矩阵依赖。',
    targetModuleId: IDS.modules.interaction,
    artifactSkeleton: [
      { moduleId: IDS.modules.arch, moduleKind: 'json', sections: ['组件拓扑', '部署模式', '决策记录'], expectedContentSummary: '已接受基线，无需修改' },
      { moduleId: IDS.modules.interaction, moduleKind: 'markdown', sections: ['交互总览', '状态与事件表', '错误处理表', '取消与重试约定'], expectedContentSummary: '补充状态表与取消重试约定' },
      { moduleId: IDS.modules.cleanup, moduleKind: 'csv', sections: [], expectedContentSummary: '等待字段映射确认后生成' },
      { moduleId: IDS.modules.value, moduleKind: 'csv', sections: [], expectedContentSummary: '依赖两个已接受上游模块' },
    ],
    inputRefs: [
      { kind: 'source', source: { sourceId: IDS.sources.brief, version: 1 } },
      { kind: 'source', source: { sourceId: IDS.sources.constraints, version: 1 } },
      { kind: 'source', source: { sourceId: IDS.sources.notes, version: 1 } },
      { kind: 'artifact_version', versionId: IDS.versions.interactionV2, moduleId: IDS.modules.interaction },
    ],
    constraintRefs: [
      { constraintId: 'C-01', text: '推理必须默认在本地完成。' },
      { constraintId: 'C-02', text: '部署范围存在歧义，需用户确认。' },
      { constraintId: 'C-03', text: '首版只支持 4 种输入格式。' },
    ],
    assumptions: [
      { id: 'a1', text: '价值矩阵默认依赖已接受的核心架构与清洗成果。', needsConfirmation: false },
      { id: 'a2', text: '角色需求的商业价值暂标记为待验证假设。', needsConfirmation: true },
    ],
    openQuestions: [
      { id: 'q1', question: '部署范围是纯离线还是允许混合云同步？', blocking: true, reason: '硬约束冲突不能由系统自行选择。' },
    ],
    steps: planSteps,
    tools: [
      { toolId: 'source.read', reason: '读取已授权资料片段', effect: 'read' },
      { toolId: 'artifact.validate', reason: '运行确定性校验', effect: 'read' },
      { toolId: 'artifact.propose_patch', reason: '生成隔离草稿，不直接提交', effect: 'draft_write' },
    ],
    validators: [
      { id: 'markdown-sections', layer: 'L1', description: '章节 ID 唯一、内容非空' },
      { id: 'evidence-linked', layer: 'L2', description: '需求项引用真实 SourceSpan' },
      { id: 'modality-boundary', layer: 'L3', description: '未实现模态明确标记不支持' },
    ],
    budget: {
      maxModelRequests: 12,
      maxToolCalls: 20,
      maxOutputTokens: 8192,
      firstEventTimeoutMs: 30000,
      idleTimeoutMs: 45000,
      totalModelRequestTimeoutMs: 180000,
      toolTimeoutMs: 30000,
      maxRetries: 2,
      maxStructureRepairs: 2,
      maxRunDurationMs: 600000,
      userCostBudgetUsd: null,
    },
    risks: [
      {
        id: 'r1',
        type: 'constraint_conflict',
        basis: 'constraint_conflict',
        title: '硬约束冲突：纯离线 vs 实时云同步',
        detail: 'C-01 与 product-brief 的“实时云端协作”要求冲突。未处理前不能提交计划；不支持通过“忽略”抹掉该风险。',
        severity: 'blocking',
        affectedModuleIds: [IDS.modules.arch, IDS.modules.interaction],
        evidenceRefs: [spanRefs.constraintOffline!, spanRefs.briefScope!],
        handlingOptions: [
          { id: 'h1', label: '修改约束边界并记录决策', description: '明确允许的同步范围，写入决策记录。' },
          { id: 'h2', label: '缩小首版范围，排除实时云同步', description: '保留纯离线能力，后续版本再评估。' },
          { id: 'h3', label: '返回编辑任务目标', description: '重新描述任务后再生成计划。' },
        ],
        resolvedByDecisionId: null,
      },
      {
        id: 'r2',
        type: 'missing_input',
        basis: 'evidence',
        title: '清洗输入缺少 field-mapping.json 版本绑定',
        detail: '清洗规则来自 field-mapping.json，但该文件尚未作为资料导入。引用无法定位到版本，L2 证据校验会标记待复核。',
        severity: 'warning',
        affectedModuleIds: [IDS.modules.cleanup],
        evidenceRefs: [spanRefs.legacyRows!],
        handlingOptions: [
          { id: 'h1', label: '导入 field-mapping.json', description: '导入后重新校验证据引用。' },
          { id: 'h2', label: '把映射规则标记为待验证假设', description: '显式标注，不伪装成已证实证据。' },
        ],
        resolvedByDecisionId: null,
      },
      {
        id: 'r3',
        type: 'explicit_unknown',
        basis: 'explicit_unknown',
        title: '价值矩阵的市场结论缺少真实数据',
        detail: '当前只有合成演示资料；市场规模与客户采纳率无法验证。该项作为明确未知保留，不作为事实写入成果。',
        severity: 'info',
        affectedModuleIds: [IDS.modules.value],
        evidenceRefs: [],
        handlingOptions: [
          { id: 'h1', label: '保持“待验证假设”标记', description: '成果中明确标注，不编造数字。' },
          { id: 'h2', label: '导入真实市场资料后再生成', description: '等待真实资料，不提前解锁。' },
        ],
        resolvedByDecisionId: null,
      },
    ],
    promptVersion: 'planner.v1',
    modelProfileId: null,
    createdAt: at(23),
  };

  const runs = [
    { runId: IDS.runs.arch, moduleId: IDS.modules.arch, state: 'COMPLETED', origin: 'intent', attempt: 1, createdAt: at(8), updatedAt: at(14), activeStepTitle: null, errorSummary: null },
    { runId: IDS.runs.interaction, moduleId: IDS.modules.interaction, state: 'COMPLETED', origin: 'intent', attempt: 1, createdAt: at(16), updatedAt: at(30), activeStepTitle: null, errorSummary: null },
    { runId: IDS.runs.cleanup, moduleId: IDS.modules.cleanup, state: 'INTERRUPTED', origin: 'recipe', attempt: 1, createdAt: at(20), updatedAt: at(28), activeStepTitle: '必填字段校验', errorSummary: '运行进程在记录工具结果后被中断；已保留检查点与草稿。' },
    { runId: IDS.runs.plan, moduleId: IDS.modules.interaction, state: 'AWAITING_INPUT', origin: 'intent', attempt: 1, createdAt: at(23), updatedAt: at(29), activeStepTitle: '确认部署口径与字段映射', errorSummary: null },
  ];

  const patchesQueue = [
    { patchId: IDS.patches.interaction, moduleId: IDS.modules.interaction, status: 'proposed', validationStatus: 'pass', createdAt: at(29) },
    { patchId: IDS.patches.cleanup, moduleId: IDS.modules.cleanup, status: 'proposed', validationStatus: 'fail', createdAt: at(27) },
  ];

  const validationSummaries = [
    {
      validationReportId: IDS.validations.interaction,
      moduleId: IDS.modules.interaction,
      status: 'pass',
      checkCounts: { pass: 4, fail: 0, needsReview: 0, notApplicable: 1 },
      blockingFindings: [],
      createdAt: at(29),
    },
    {
      validationReportId: IDS.validations.cleanup,
      moduleId: IDS.modules.cleanup,
      status: 'fail',
      checkCounts: { pass: 2, fail: 1, needsReview: 1, notApplicable: 1 },
      blockingFindings: [
        '[L3/required_fields] 必填字段完整: 1 行缺少 system_id（原 CSV 第 7 数据行），需补齐或明确排除口径。',
        '[L2/evidence_exists] 生成数据可追踪: 去重规则来自 field-mapping.json，但该文件尚未绑定为资料版本。',
      ],
      createdAt: at(27),
    },
  ];

  const prospects = [
    {
      id: 'prospect-value-matrix',
      title: '综合价值壁垒矩阵',
      state: 'missing_inputs',
      valueStatement: '把已接受的架构能力与清洗后的存量系统，映射为用户问题 / 能力 / 价值假设 / 证据 / 待验证指标的行级矩阵。',
      requiredInputs: [
        { moduleId: IDS.modules.arch, label: '核心架构拓扑（已接受）', satisfied: true, moduleStatus: 'accepted' },
        { moduleId: IDS.modules.cleanup, label: '存量系统清洗结果（待接受）', satisfied: false, moduleStatus: 'ready_for_review' },
      ],
      missingInputs: ['存量系统兼容层清洗尚未接受', '角色需求资料未绑定（可选）'],
      note: '依赖满足只代表允许生成，不代表成果已完成；生成后仍需校验与人工接受。',
      candidateUnverified: false,
      targetModuleId: IDS.modules.value,
      sourceModuleId: IDS.modules.arch,
    },
    {
      id: 'prospect-gtm-brief',
      title: 'GTM 假设说明',
      state: 'proposed',
      valueStatement: '基于价值矩阵生成 GTM 假设清单；所有商业数字标记为待验证，不编造市场规模。',
      requiredInputs: [{ moduleId: IDS.modules.value, label: '价值矩阵（未生成）', satisfied: false, moduleStatus: 'blocked' }],
      missingInputs: ['商业化价值壁垒矩阵尚未生成'],
      note: '可由规则模板生成预览名称；模型生成的摘要必须标记为待验证候选。',
      candidateUnverified: true,
      targetModuleId: IDS.modules.value,
      sourceModuleId: null,
    },
    {
      id: 'prospect-interaction-check',
      title: '交互一致性检查',
      state: 'ready',
      valueStatement: '对已接受的交互规范与待审阅变更做一致性检查，输出差异清单。',
      requiredInputs: [{ moduleId: IDS.modules.interaction, label: '交互规范（已接受基线）', satisfied: true, moduleStatus: 'ready_for_review' }],
      missingInputs: [],
      note: '依赖已满足；生成、验证、审阅与提交沿用标准 Run。',
      candidateUnverified: false,
      targetModuleId: IDS.modules.interaction,
      sourceModuleId: null,
    },
  ];

  const recipes = [
    { recipeId: IDS.recipes.cleanup, name: '存量系统清洗配方', kind: 'deterministic', status: 'validated', version: 2, fingerprint: fixtureHash('recipe-cleanup-v2') },
    { recipeId: IDS.recipes.value, name: '价值矩阵生成配方', kind: 'llm_assisted', status: 'candidate', version: 1, fingerprint: fixtureHash('recipe-value-v1') },
  ];

  const moduleViews = [
    {
      module: modules.arch,
      acceptance: acceptance({
        moduleId: IDS.modules.arch,
        status: 'accepted',
        acceptedVersionId: IDS.versions.archV1,
        acceptedAt: at(14),
        acceptedSummary: '组件拓扑 5 个组件、依赖无环；部署模式=混合（存在待确认约束）。',
        acceptedContentHash: fixtureHash('arch-v1'),
        pendingPatchId: null,
        pendingValidationReportId: null,
        pendingValidationStatus: null,
        staleReason: null,
        openBlockerIds: [IDS.blockers.conflict],
      }),
      acceptedContent: ARCH_CONTENT,
      acceptedVersion: archVersion,
      pendingCandidateSummary: null,
    },
    {
      module: modules.interaction,
      acceptance: acceptance({
        moduleId: IDS.modules.interaction,
        status: 'ready_for_review',
        acceptedVersionId: IDS.versions.interactionV2,
        acceptedAt: at(22),
        acceptedSummary: '已接受基线：交互总览、状态与事件表、错误处理表。',
        acceptedContentHash: fixtureHash('interaction-v2'),
        pendingPatchId: IDS.patches.interaction,
        pendingValidationReportId: IDS.validations.interaction,
        pendingValidationStatus: 'pass',
        staleReason: null,
        openBlockerIds: [IDS.blockers.conflict],
      }),
      acceptedContent: INTERACTION_V2_CONTENT,
      acceptedVersion: interactionV2,
      pendingCandidateSummary: '候选：更新状态与事件表，新增取消与重试约定（校验 L0–L3 通过）。',
    },
    {
      module: modules.cleanup,
      acceptance: acceptance({
        moduleId: IDS.modules.cleanup,
        status: 'ready_for_review',
        acceptedVersionId: null,
        acceptedAt: null,
        acceptedSummary: null,
        acceptedContentHash: null,
        pendingPatchId: IDS.patches.cleanup,
        pendingValidationReportId: IDS.validations.cleanup,
        pendingValidationStatus: 'fail',
        staleReason: null,
        openBlockerIds: [IDS.blockers.mapping, IDS.blockers.noProgress],
      }),
      acceptedContent: null,
      acceptedVersion: null,
      pendingCandidateSummary: '候选：7 行 × 5 列；必填字段校验失败，需先修复才能接受。',
    },
    {
      module: modules.value,
      acceptance: acceptance({
        moduleId: IDS.modules.value,
        status: 'blocked',
        acceptedVersionId: null,
        acceptedAt: null,
        acceptedSummary: null,
        acceptedContentHash: null,
        pendingPatchId: null,
        pendingValidationReportId: null,
        pendingValidationStatus: null,
        staleReason: null,
        openBlockerIds: [IDS.blockers.scope],
      }),
      acceptedContent: null,
      acceptedVersion: null,
      pendingCandidateSummary: null,
    },
  ];

  const spatialNodes = [
    { id: 'node-hub', kind: 'hub', layer: 'global', title: artifactTitle, status: 'idle', summary: '4 个模块 · 1 个已接受', moduleId: null, runId: null, stepId: null, refId: IDS.artifact, badgeCount: 4, laneHint: 0 },
    { id: `node-module-${IDS.modules.arch}`, kind: 'module', layer: 'execution', title: '核心架构拓扑', status: 'accepted', summary: '已接受 v1', moduleId: IDS.modules.arch, runId: null, stepId: null, refId: IDS.modules.arch, badgeCount: null, laneHint: 0 },
    { id: `node-module-${IDS.modules.interaction}`, kind: 'module', layer: 'execution', title: '多模态交互引擎规范', status: 'ready_for_review', summary: '1 个待接受差异', moduleId: IDS.modules.interaction, runId: null, stepId: null, refId: IDS.modules.interaction, badgeCount: 1, laneHint: 1 },
    { id: `node-module-${IDS.modules.cleanup}`, kind: 'module', layer: 'execution', title: '存量系统兼容层清洗', status: 'warning', summary: '校验失败待修复', moduleId: IDS.modules.cleanup, runId: null, stepId: null, refId: IDS.modules.cleanup, badgeCount: 2, laneHint: 2 },
    { id: `node-module-${IDS.modules.value}`, kind: 'module', layer: 'execution', title: '商业化价值壁垒矩阵', status: 'blocked', summary: '缺少已接受上游输入', moduleId: IDS.modules.value, runId: null, stepId: null, refId: IDS.modules.value, badgeCount: 1, laneHint: 3 },
    { id: 'node-constraints', kind: 'constraint', layer: 'global', title: '约束清单（3 条，1 组冲突）', status: 'warning', summary: 'C-02 部署范围待确认', moduleId: null, runId: null, stepId: null, refId: null, badgeCount: 1, laneHint: 0 },
    { id: `node-run-${IDS.runs.plan}`, kind: 'run', layer: 'execution', title: '计划审阅运行', status: 'blocked', summary: '等待 3 项决策', moduleId: IDS.modules.interaction, runId: IDS.runs.plan, stepId: null, refId: IDS.runs.plan, badgeCount: 3, laneHint: 0 },
    { id: `node-step-${IDS.steps.planContext}`, kind: 'step', layer: 'execution', title: '读取资料与构建上下文', status: 'completed', summary: 'ContextSnapshot 已创建', moduleId: null, runId: IDS.runs.plan, stepId: IDS.steps.planContext, refId: null, badgeCount: null, laneHint: 1 },
    { id: `node-step-${IDS.steps.mapping}`, kind: 'step', layer: 'execution', title: '确认部署口径与字段映射', status: 'blocked', summary: '等待用户决策', moduleId: IDS.modules.cleanup, runId: IDS.runs.cleanup, stepId: IDS.steps.mapping, refId: null, badgeCount: 2, laneHint: 0 },
    { id: `node-tool-${IDS.toolCalls.profile}`, kind: 'tool', layer: 'execution', title: 'data.profile', status: 'completed', summary: '7 行 · 5 列 · 2 组重复主键', moduleId: IDS.modules.cleanup, runId: IDS.runs.cleanup, stepId: IDS.steps.cleanupTransform, refId: IDS.toolCalls.profile, badgeCount: null, laneHint: 1 },
    { id: `node-patch-${IDS.patches.interaction}`, kind: 'patch', layer: 'execution', title: '待接受差异：交互规范', status: 'ready_for_review', summary: '校验通过，等待接受', moduleId: IDS.modules.interaction, runId: IDS.runs.interaction, stepId: null, refId: IDS.patches.interaction, badgeCount: null, laneHint: 2 },
    { id: `node-patch-${IDS.patches.cleanup}`, kind: 'patch', layer: 'execution', title: '待修复差异：清洗结果', status: 'warning', summary: '校验失败 1 项', moduleId: IDS.modules.cleanup, runId: IDS.runs.cleanup, stepId: null, refId: IDS.patches.cleanup, badgeCount: 1, laneHint: 2 },
    { id: `node-blocker-${IDS.blockers.conflict}`, kind: 'blocker', layer: 'execution', title: '硬约束冲突待处理', status: 'blocked', summary: '不能提交计划', moduleId: IDS.modules.arch, runId: IDS.runs.plan, stepId: null, refId: IDS.blockers.conflict, badgeCount: null, laneHint: 0 },
    { id: `node-blocker-${IDS.blockers.scope}`, kind: 'blocker', layer: 'execution', title: '部署口径待确认', status: 'blocked', summary: '价值矩阵输入缺失', moduleId: IDS.modules.value, runId: IDS.runs.plan, stepId: null, refId: IDS.blockers.scope, badgeCount: null, laneHint: 1 },
    { id: `node-recipe-${IDS.recipes.cleanup}`, kind: 'recipe', layer: 'execution', title: '存量系统清洗配方', status: 'accepted', summary: '确定性 · 0 次 LLM 调用 · v2', moduleId: null, runId: null, stepId: null, refId: IDS.recipes.cleanup, badgeCount: null, laneHint: 3 },
    { id: `node-source-${IDS.sources.brief}`, kind: 'source', layer: 'evidence', title: 'product-brief.md', status: 'completed', summary: '2 个片段 · 合成演示', moduleId: null, runId: null, stepId: null, refId: IDS.sources.brief, badgeCount: null, laneHint: 0 },
    { id: `node-source-${IDS.sources.legacy}`, kind: 'source', layer: 'evidence', title: 'legacy-systems.csv', status: 'completed', summary: '24 行原始数据', moduleId: null, runId: null, stepId: null, refId: IDS.sources.legacy, badgeCount: null, laneHint: 1 },
    { id: `node-source-${IDS.sources.notes}`, kind: 'source', layer: 'evidence', title: 'stakeholder-notes.md', status: 'warning', summary: '资料版本已变更', moduleId: null, runId: null, stepId: null, refId: IDS.sources.notes, badgeCount: null, laneHint: 2 },
    { id: `node-validation-${IDS.validations.cleanup}`, kind: 'validation', layer: 'evidence', title: '清洗验证：未通过', status: 'failed', summary: 'L3 失败 1 项，L2 待复核 1 项', moduleId: IDS.modules.cleanup, runId: IDS.runs.cleanup, stepId: null, refId: IDS.validations.cleanup, badgeCount: 2, laneHint: 3 },
    { id: `node-validation-${IDS.validations.interaction}`, kind: 'validation', layer: 'evidence', title: '交互规范验证：通过', status: 'completed', summary: 'L0–L3 全部通过', moduleId: IDS.modules.interaction, runId: IDS.runs.interaction, stepId: null, refId: IDS.validations.interaction, badgeCount: null, laneHint: 4 },
    { id: 'node-prospect-value', kind: 'prospect', layer: 'prospect', title: '综合价值壁垒矩阵', status: 'draft', summary: '缺少 1 个必需输入', moduleId: IDS.modules.value, runId: null, stepId: null, refId: 'prospect-value-matrix', badgeCount: null, laneHint: 0 },
    { id: 'node-prospect-ready', kind: 'prospect', layer: 'prospect', title: '交互一致性检查', status: 'ready_for_review', summary: '依赖已满足，可生成', moduleId: IDS.modules.interaction, runId: null, stepId: null, refId: 'prospect-interaction-check', badgeCount: null, laneHint: 1 },
  ];

  const branchPlan = `run:${IDS.runs.plan}`;
  const branchCleanup = `run:${IDS.runs.cleanup}`;
  const spatialEdges = [
    { id: 'e1', from: `node-module-${IDS.modules.arch}`, to: `node-module-${IDS.modules.interaction}`, kind: 'dependency', label: '依赖' },
    { id: 'e2', from: `node-module-${IDS.modules.arch}`, to: `node-module-${IDS.modules.value}`, kind: 'dependency', label: '依赖' },
    { id: 'e3', from: `node-module-${IDS.modules.cleanup}`, to: `node-module-${IDS.modules.value}`, kind: 'dependency', label: '依赖' },
    { id: 'e4', from: `node-run-${IDS.runs.plan}`, to: `node-step-${IDS.steps.planContext}`, kind: 'flow', label: '执行' },
    { id: 'e5', from: `node-run-${IDS.runs.plan}`, to: `node-blocker-${IDS.blockers.conflict}`, kind: 'flow', label: '阻塞' },
    { id: 'e6', from: `node-step-${IDS.steps.mapping}`, to: `node-blocker-${IDS.blockers.scope}`, kind: 'flow', label: '等待输入' },
    { id: 'e7', from: `node-tool-${IDS.toolCalls.profile}`, to: `node-step-${IDS.steps.mapping}`, kind: 'trace', label: '工具结果' },
    { id: 'e8', from: `node-source-${IDS.sources.legacy}`, to: `node-tool-${IDS.toolCalls.profile}`, kind: 'evidence', label: '输入' },
    { id: 'e9', from: `node-patch-${IDS.patches.interaction}`, to: `node-module-${IDS.modules.interaction}`, kind: 'binding', label: '候选' },
    { id: 'e10', from: `node-patch-${IDS.patches.cleanup}`, to: `node-module-${IDS.modules.cleanup}`, kind: 'binding', label: '候选' },
    { id: 'e11', from: `node-validation-${IDS.validations.cleanup}`, to: `node-patch-${IDS.patches.cleanup}`, kind: 'trace', label: '校验' },
    { id: 'e12', from: `node-source-${IDS.sources.notes}`, to: `node-patch-${IDS.patches.interaction}`, kind: 'evidence', label: '证据' },
    { id: 'e13', from: `node-recipe-${IDS.recipes.cleanup}`, to: `node-module-${IDS.modules.cleanup}`, kind: 'binding', label: '配方复用' },
    { id: 'e14', from: 'node-prospect-value', to: `node-module-${IDS.modules.value}`, kind: 'binding', label: '综合目标' },
    { id: 'e15', from: `node-module-${IDS.modules.cleanup}`, to: 'node-prospect-value', kind: 'dependency', label: '必需输入' },
    { id: 'e16', from: 'node-constraints', to: `node-blocker-${IDS.blockers.conflict}`, kind: 'trace', label: '约束冲突' },
    { id: 'e17', from: `node-step-${IDS.steps.planContext}`, to: `node-source-${IDS.sources.brief}`, kind: 'evidence', label: '读取' },
    { id: 'e18', from: 'node-prospect-ready', to: `node-module-${IDS.modules.interaction}`, kind: 'binding', label: '综合目标' },
  ];

  const spatial = {
    nodes: spatialNodes,
    edges: spatialEdges,
    stage: {
      phase: 'resolving',
      label: '计划预览 · 等待处理 3 项决策',
      completedSteps: 2,
      totalSteps: 6,
      activeStepTitle: '确认部署口径与字段映射',
      note: '真实风险 3 项（1 项阻止提交）；未处理前提交按钮不可用。',
    },
    counts: { branchCount: 2, nodeCount: 9, edgeCount: 4, collapsedNodes: 9, byKind: { source: 2, step: 3, validation: 1, prospect: 1, patch: 2 } as Record<string, number> },
    activeBranchId: branchPlan,
    focusHint: '先处理硬约束冲突：纯离线要求与实时云同步能力冲突',
  };

  const events = buildEvents({ plan, taskTitle, interactionPatch: interactionPatch.id, cleanupPatch: cleanupPatch.id, blockerConflict: blockers[1]!.id, blockerScope: blockers[0]!.id });

  const control = {
    runId: IDS.runs.plan,
    state: 'AWAITING_INPUT',
    canPause: false,
    canResume: false,
    canCancel: true,
    budgetLabel: '模型 3/12 · 工具 2/20 · token 入 4,120 · 出 860 · 金额未知',
    providerLabel: '演示夹具 · 无外部模型调用',
    connectionStatus: 'unconfigured',
    queuePosition: null,
    unsavedDraft: false,
  };

  const usage = {
    modelRequests: 3,
    toolCalls: 2,
    inputTokens: 4120,
    outputTokens: 860,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    usdCost: null,
    elapsedActiveMs: 74_000,
    startedAt: at(23),
    updatedAt: at(29),
  };

  const snapshot = {
    snapshotSeq: 42,
    serverTime: at(30),
    workspace: {
      workspaceId: IDS.workspace,
      mode: 'demo' as const,
      name: '演示工作区',
      settings: {
        autoAcceptVerifiedDrafts: false,
        pauseWhenPageCloses: false,
        providerProfileIds: [],
        reducedMotion: false,
        theme: 'dark' as const,
      },
      policyVersion: 'p0-policy-1',
    },
    task: {
      id: IDS.task,
      workspaceId: IDS.workspace,
      title: taskTitle,
      intent: taskIntent,
      constraints,
      artifactId: IDS.artifact,
      revision: 7,
      templateId: 'cognitive-atrium',
      status: 'active' as const,
      createdAt: at(0),
      updatedAt: at(30),
    },
    artifact: {
      id: IDS.artifact,
      taskId: IDS.task,
      title: artifactTitle,
      moduleIds: [modules.arch.id, modules.interaction.id, modules.cleanup.id, modules.value.id],
      acceptedVersionId: IDS.versions.archV1,
      status: 'active' as const,
      createdAt: at(0),
      updatedAt: at(30),
    },
    modules: moduleViews,
    plan,
    runs,
    activeRun: {
      runId: IDS.runs.plan,
      moduleId: IDS.modules.interaction,
      state: 'AWAITING_INPUT',
      revision: 23,
      attempt: 1,
      planVersion: 2,
      contextSnapshotId: IDS.context.plan,
      budgetUsage: usage,
      error: null,
      interrupted: null,
    },
    blockers,
    patches: patchesQueue,
    validations: validationSummaries,
    sources,
    spans,
    prospects,
    recipes,
    spatial,
    control,
    usage,
    events,
    limits: { maxSpatialBranches: 3, maxSpatialNodes: 12, maxSpatialEdges: 16 },
  };

  const recipeProposals = {
    [IDS.runs.cleanup]: RecipeProposalInputSchema.parse({
      runId: IDS.runs.cleanup,
      name: '存量系统清洗配方',
      description: '按 field-mapping 别名映射、枚举规范化、主键去重与必填校验的确定性清洗流程。',
      kind: 'deterministic',
      inputParameters: [
        { name: 'sourceCsv', type: 'source', required: true, description: '待清洗的存量系统 CSV', pattern: null, enumValues: [], acceptsMime: ['text/csv'] },
        { name: 'mappingJson', type: 'source', required: true, description: 'field-mapping.json', pattern: null, enumValues: [], acceptsMime: ['application/json'] },
      ],
      steps: [
        { id: 'read-csv', title: '读取原始 CSV', kind: 'source.read', source: { kind: 'parameter', name: 'sourceCsv' }, locator: null, maxChars: 8000, when: null },
        { id: 'read-mapping', title: '读取字段映射', kind: 'source.read', source: { kind: 'parameter', name: 'mappingJson' }, locator: null, maxChars: 8000, when: null },
        { id: 'transform', title: '执行确定性清洗', kind: 'data.transform', input: { kind: 'previous_step' }, format: 'csv', operations: [{ op: 'normalize', column: 'status', transforms: ['trim', 'lower'], nullTokens: [] }], outputName: 'cleaned.csv', when: null },
        { id: 'emit', title: '输出清洗结果', kind: 'emit_artifact', moduleKind: 'csv', input: { kind: 'previous_step' }, artifactName: 'cleaned.csv', when: null },
      ],
      testCases: [
        { id: 'original', label: '原始样本（24 行）', kind: 'original', inputs: { sourceCsv: 'legacy-systems.csv', mappingJson: 'field-mapping.json' }, expectation: 'accept', status: 'passed', detail: '输出 22 行（keep=last）', normalizedOutputHash: fixtureHash('recipe-cleaned-original'), lastRunAt: at(31) },
        { id: 'new-valid', label: '新有效样本（8 行）', kind: 'new_valid', inputs: { sourceCsv: 'legacy-systems-new.csv', mappingJson: 'field-mapping.json' }, expectation: 'accept', status: 'passed', detail: '输出 7 行，大小写与空白已规范化', normalizedOutputHash: fixtureHash('recipe-cleaned-new'), lastRunAt: at(32) },
        { id: 'invalid', label: '非法样本（缺少主键列）', kind: 'invalid', inputs: { sourceCsv: 'legacy-systems-invalid.csv', mappingJson: 'field-mapping.json' }, expectation: 'reject', status: 'passed', detail: '缺少可映射到 system_id 的列，输入被拒绝', normalizedOutputHash: null, lastRunAt: at(32) },
      ],
      applicability: '适用于字段映射已知、主键为大小写敏感字符串的存量系统 CSV；工具版本或映射规则变化后需要重新测试。',
    }),
  } as Record<string, RecipeProposalInput>;

  const recipesFull: Recipe[] = [
    {
      id: IDS.recipes.cleanup as never,
      version: 2,
      name: '存量系统清洗配方',
      description: '确定性清洗：别名映射、枚举规范化、去重与必填校验。',
      kind: 'deterministic',
      status: 'validated',
      dslVersion: '1',
      inputParameters: recipeProposals[IDS.runs.cleanup]!.inputParameters,
      steps: recipeProposals[IDS.runs.cleanup]!.steps,
      outputArtifactKind: 'csv',
      validators: [{ id: 'required_fields', description: '必填字段与主键规则', supported: true }],
      permissions: { tools: ['source.read', 'data.transform', 'artifact.propose_patch'], scopes: ['sources:read', 'data:transform'], allowModelCalls: false, maxModelCallsPerRun: 0 },
      budget: { maxModelCalls: 0, maxToolCalls: 8, maxRuntimeMs: 60_000 },
      testCases: recipeProposals[IDS.runs.cleanup]!.testCases,
      fingerprint: fixtureHash('recipe-cleanup-v2'),
      fingerprintInputs: { dslVersion: '1', stepFingerprint: fixtureHash('recipe-steps'), toolVersions: { 'data.transform': '1' }, promptHashes: {}, validatorVersion: 'validator-1', parserVersion: 'csv-1' },
      sourceRunId: IDS.runs.cleanup as never,
      sourceTaskId: IDS.task as never,
      sourceModuleId: IDS.modules.cleanup as never,
      applicability: '适用于字段映射已知、主键为大小写敏感字符串的存量系统 CSV。',
      staleReason: null,
      createdAt: at(31),
      updatedAt: at(31),
    },
  ];

  const bundle: FixtureBundle = {
    snapshot,
    patches: [interactionPatch, cleanupPatch],
    validations,
    recipes: recipesFull,
    recipeProposals,
    baseContents: {
      [IDS.patches.interaction]: INTERACTION_V2_CONTENT,
      [IDS.patches.cleanup]: CLEANUP_BASE,
    },
  };

  if (scenario === 'empty') return buildEmptyBundle(taskTitle, taskIntent, artifactTitle, sources, spans);
  if (scenario === 'completed') return buildCompletedBundle(bundle);
  if (scenario === 'blocked') return buildBlockedBundle(bundle);
  return bundle;
}

/* ------------------------------ event builder ------------------------------ */

interface EventBuildInput {
  plan: Record<string, unknown>;
  taskTitle: string;
  interactionPatch: string;
  cleanupPatch: string;
  blockerConflict: string;
  blockerScope: string;
}

function buildEvents(input: EventBuildInput): unknown[] {
  let seq = 0;
  const list: unknown[] = [];
  const push = (type: EventType, payload: unknown, opts: { runId?: string | null; stepId?: string | null; minute: number }): void => {
    seq += 1;
    list.push({
      schemaVersion: '1',
      eventId: fixtureUuid(900 + seq),
      taskId: IDS.task,
      runId: opts.runId ?? null,
      stepId: opts.stepId ?? null,
      seq,
      causationId: null,
      type,
      category: EVENT_CATEGORY_BY_TYPE[type],
      payload,
      timestamp: at(opts.minute),
    });
  };

  push('run.created', { runId: IDS.runs.plan, taskId: IDS.task, moduleId: IDS.modules.interaction, origin: 'intent', baseVersionId: IDS.versions.interactionV2, budget: { maxModelRequests: 12, maxToolCalls: 20 } }, { runId: IDS.runs.plan, minute: 23 });
  push('plan.proposed', { runId: IDS.runs.plan, planVersion: 2, plan: input.plan }, { runId: IDS.runs.plan, minute: 23 });
  push('plan.ready', { runId: IDS.runs.plan, planVersion: 2 }, { runId: IDS.runs.plan, minute: 23 });
  push('run.state_changed', { from: 'PLANNING', to: 'AWAITING_INPUT', reason: '发现 3 项待处理问题，其中硬约束冲突阻止提交' }, { runId: IDS.runs.plan, minute: 24 });
  push('blocker.detected', {
    blocker: {
      id: input.blockerScope,
      taskId: IDS.task,
      runId: IDS.runs.plan,
      type: 'info_missing',
      severity: 'blocking',
      title: '价值矩阵的部署口径未确认',
      detail: '需要确认纯离线或混合云。',
      evidenceRefs: [],
      affectedSteps: [IDS.steps.planContext],
      affectedModuleIds: [IDS.modules.value],
      resolutions: [{ id: 'opt', kind: 'text', label: '补充说明', detail: '', placeholder: '', multiline: false, maxChars: 2000, required: true }],
      status: 'open',
      resolution: null,
      returnState: 'READY',
      createdAt: at(24),
      resolvedAt: null,
      clearedAt: null,
    },
  }, { runId: IDS.runs.plan, minute: 24 });
  push('input.requested', { blockerId: input.blockerConflict, title: '硬约束冲突：纯离线 vs 实时云同步', resolutionOptionIds: ['opt-conflict-constraint', 'opt-conflict-exclude'] }, { runId: IDS.runs.plan, minute: 25 });
  push('context.snapshot_created', { contextSnapshotId: IDS.context.plan, runId: IDS.runs.plan, stepId: null, estimatedTokens: 4120, fragmentCount: 9, omittedCount: 1 }, { runId: IDS.runs.plan, minute: 25 });
  push('run.started', { runId: IDS.runs.cleanup, attempt: 1, planVersion: 1 }, { runId: IDS.runs.cleanup, minute: 20 });
  push('step.started', { stepId: IDS.steps.cleanupTransform, kind: 'tool', title: '执行 data.transform 清洗', attempt: 1 }, { runId: IDS.runs.cleanup, stepId: IDS.steps.cleanupTransform, minute: 21 });
  push('tool.requested', { toolCallId: IDS.toolCalls.transform, stepId: IDS.steps.cleanupTransform, toolId: 'data.transform', argumentsPreview: '{"format":"csv","operations":[...]}', argumentsHash: fixtureHash('args-transform') }, { runId: IDS.runs.cleanup, stepId: IDS.steps.cleanupTransform, minute: 21 });
  push('tool.authorized', { toolCallId: IDS.toolCalls.transform, decision: 'allow', reason: '只读资料 + 仅写隔离草稿', scopes: ['sources:read', 'data:transform'] }, { runId: IDS.runs.cleanup, stepId: IDS.steps.cleanupTransform, minute: 21 });
  push('tool.succeeded', { toolCallId: IDS.toolCalls.transform, toolId: 'data.transform', resultSummary: '7 行 × 5 列，2 组重复主键已按 keep=last 去重', resultObjectHash: fixtureHash('transform-result'), resultBytes: 4096, durationMs: 42 }, { runId: IDS.runs.cleanup, stepId: IDS.steps.cleanupTransform, minute: 22 });
  push('step.completed', { stepId: IDS.steps.cleanupTransform, kind: 'tool', summary: '清洗输出为新对象，原始输入未被覆盖', outputRefs: [fixtureHash('transform-result')] }, { runId: IDS.runs.cleanup, stepId: IDS.steps.cleanupTransform, minute: 22 });
  push('step.failed', { stepId: IDS.steps.cleanupValidate, kind: 'validate', error: { code: 'validation_failed', message: '必填字段缺失 1 行', retryable: false } }, { runId: IDS.runs.cleanup, stepId: IDS.steps.cleanupValidate, minute: 24 });
  push('artifact.patch_proposed', { patchId: input.cleanupPatch, moduleId: IDS.modules.cleanup, baseVersionId: null, candidateHash: fixtureHash('cleanup-candidate'), validationReportId: IDS.validations.cleanup, changeSummary: { addedLines: 7, removedLines: 0, changedSections: [], addedSections: [], removedSections: [], affectedRows: 7, note: '' } }, { runId: IDS.runs.cleanup, minute: 25 });
  push('validation.completed', {
    validationReportId: IDS.validations.cleanup,
    moduleId: IDS.modules.cleanup,
    status: 'fail',
    checks: [{ id: 'chk-2', layer: 'L3', code: 'required_fields', title: '必填字段完整', status: 'fail', detail: '1 行缺少 system_id', evidenceRefs: [], affectedPaths: ['rows[6].system_id'] }],
    summary: '必填字段校验失败（L3）。',
  }, { runId: IDS.runs.cleanup, minute: 26 });
  push('run.interrupted', { runId: IDS.runs.cleanup, lastCheckpointId: fixtureUuid(140), unclearToolCalls: [], reason: 'process_terminated' }, { runId: IDS.runs.cleanup, minute: 28 });
  push('artifact.patch_proposed', { patchId: input.interactionPatch, moduleId: IDS.modules.interaction, baseVersionId: IDS.versions.interactionV2, candidateHash: fixtureHash('interaction-candidate'), validationReportId: IDS.validations.interaction, changeSummary: { addedLines: 14, removedLines: 5, changedSections: ['状态与事件表'], addedSections: ['取消与重试约定'], removedSections: [], affectedRows: 0, note: '' } }, { runId: IDS.runs.interaction, minute: 29 });
  push('validation.completed', {
    validationReportId: IDS.validations.interaction,
    moduleId: IDS.modules.interaction,
    status: 'pass',
    checks: [{ id: 'chk-3', layer: 'L3', code: 'modality_boundary', title: '输入模态边界明确', status: 'pass', detail: '语音与 PDF 标记为不支持', evidenceRefs: [], affectedPaths: [] }],
    summary: '确定性校验全部通过（L0–L3）。',
  }, { runId: IDS.runs.interaction, minute: 29 });
  push('run.state_changed', { from: 'VALIDATING', to: 'AWAITING_REVIEW', reason: '候选通过确定性校验，等待人工接受' }, { runId: IDS.runs.interaction, minute: 30 });
  push('recipe.proposed', { recipeId: IDS.recipes.cleanup, version: 2, kind: 'deterministic', name: '存量系统清洗配方' }, { runId: IDS.runs.cleanup, minute: 31 });
  push('recipe.validated', { recipeId: IDS.recipes.cleanup, version: 2, fingerprint: fixtureHash('recipe-cleanup-v2'), testSummary: '3/3 测试通过（原始、新有效、非法输入）', testCases: 3 }, { runId: IDS.runs.cleanup, minute: 31 });
  push('usage.updated', { modelRequests: 3, toolCalls: 2, inputTokens: 4120, outputTokens: 860, estimated: false, usdCost: null }, { runId: IDS.runs.plan, minute: 30 });
  push('artifact.stale', { artifactId: IDS.artifact, moduleId: IDS.modules.value, reason: '上游清洗结果尚未接受', staleRefs: [IDS.patches.cleanup] }, { runId: null, minute: 30 });

  return list;
}

/* ------------------------------ other states ------------------------------ */

function buildEmptyBundle(taskTitle: string, taskIntent: string, artifactTitle: string, sources: unknown[], spans: unknown[]): FixtureBundle {
  const emptyModule = (id: string, title: string, kind: 'markdown' | 'json' | 'csv', order: number, deps: string[]): Record<string, unknown> => ({
    id,
    artifactId: IDS.artifact,
    title,
    kind,
    order,
    dependencies: deps,
    acceptanceCriteria: [],
    status: 'empty',
    blockedFrom: null,
    acceptedVersionId: null,
    createdAt: at(0),
    updatedAt: at(0),
  });
  const modules = [
    emptyModule(IDS.modules.arch, '核心架构拓扑', 'json', 0, []),
    emptyModule(IDS.modules.interaction, '多模态交互引擎规范', 'markdown', 1, []),
    emptyModule(IDS.modules.cleanup, '存量系统兼容层清洗', 'csv', 2, []),
    emptyModule(IDS.modules.value, '商业化价值壁垒矩阵', 'csv', 3, []),
  ];
  const snapshot = {
    snapshotSeq: 1,
    serverTime: at(0),
    workspace: {
      workspaceId: IDS.workspace,
      mode: 'demo' as const,
      name: '演示工作区',
      settings: { autoAcceptVerifiedDrafts: false, pauseWhenPageCloses: false, providerProfileIds: [], reducedMotion: false, theme: 'dark' as const },
      policyVersion: 'p0-policy-1',
    },
    task: {
      id: IDS.task,
      workspaceId: IDS.workspace,
      title: taskTitle,
      intent: taskIntent,
      constraints: [],
      artifactId: IDS.artifact,
      revision: 0,
      templateId: 'cognitive-atrium',
      status: 'active' as const,
      createdAt: at(0),
      updatedAt: at(0),
    },
    artifact: {
      id: IDS.artifact,
      taskId: IDS.task,
      title: artifactTitle,
      moduleIds: modules.map((m) => m.id as string),
      acceptedVersionId: null,
      status: 'draft' as const,
      createdAt: at(0),
      updatedAt: at(0),
    },
    modules: modules.map((module) => ({
      module,
      acceptance: {
        moduleId: module.id,
        status: 'empty',
        acceptedVersionId: null,
        acceptedAt: null,
        acceptedSummary: null,
        acceptedContentHash: null,
        pendingPatchId: null,
        pendingValidationReportId: null,
        pendingValidationStatus: null,
        staleReason: null,
        openBlockerIds: [],
      },
      acceptedContent: null,
      acceptedVersion: null,
      pendingCandidateSummary: null,
    })),
    plan: null,
    runs: [],
    activeRun: null,
    blockers: [],
    patches: [],
    validations: [],
    sources,
    spans,
    prospects: [],
    recipes: [],
    spatial: {
      nodes: [
        { id: 'node-hub', kind: 'hub', layer: 'global', title: artifactTitle, status: 'empty', summary: '4 个模块 · 尚未开始', moduleId: null, runId: null, stepId: null, refId: IDS.artifact, badgeCount: 4, laneHint: 0 },
        ...modules.map((module, index) => ({
          id: `node-module-${module.id as string}`,
          kind: 'module',
          layer: 'execution',
          title: module.title as string,
          status: 'empty',
          summary: '尚未开始',
          moduleId: module.id,
          runId: null,
          stepId: null,
          refId: module.id,
          badgeCount: null,
          laneHint: index,
        })),
      ],
      edges: [],
      stage: { phase: 'idle', label: '空任务 · 等待意图', completedSteps: null, totalSteps: null, activeStepTitle: null, note: '在意图胶囊中选择模块并描述目标。' },
      counts: { branchCount: 0, nodeCount: 0, edgeCount: 0, collapsedNodes: 0, byKind: {} as Record<string, number> },
      activeBranchId: null,
      focusHint: '',
    },
    control: {
      runId: null,
      state: null,
      canPause: false,
      canResume: false,
      canCancel: false,
      budgetLabel: '尚未消耗预算',
      providerLabel: '未配置模型连接',
      connectionStatus: 'unconfigured',
      queuePosition: null,
      unsavedDraft: false,
    },
    usage: null,
    events: [],
    limits: { maxSpatialBranches: 3, maxSpatialNodes: 12, maxSpatialEdges: 16 },
  };
  return { snapshot, patches: [], validations: {}, recipes: [], recipeProposals: {}, baseContents: {} };
}

function buildCompletedBundle(base: FixtureBundle): FixtureBundle {
  const snapshot = JSON.parse(JSON.stringify(base.snapshot)) as Record<string, unknown>;
  const modules = snapshot.modules as Array<Record<string, unknown>>;
  for (const view of modules) {
    const module = view.module as Record<string, unknown>;
    const acceptance = view.acceptance as Record<string, unknown>;
    module.status = 'accepted';
    acceptance.status = 'accepted';
    acceptance.pendingPatchId = null;
    acceptance.pendingValidationReportId = null;
    acceptance.pendingValidationStatus = null;
    acceptance.openBlockerIds = [];
    if (!acceptance.acceptedVersionId) {
      acceptance.acceptedVersionId = IDS.versions.cleanupV1;
      acceptance.acceptedAt = at(40);
      acceptance.acceptedSummary = '已接受：7 行 × 5 列清洗结果';
      acceptance.acceptedContentHash = fixtureHash('cleanup-v1');
    }
  }
  snapshot.patches = [];
  snapshot.blockers = [];
  snapshot.prospects = [
    {
      id: 'prospect-summary',
      title: '综合价值壁垒矩阵',
      state: 'ready',
      valueStatement: '基于已接受架构与清洗成果，生成价值矩阵与 GTM 假设说明。',
      requiredInputs: [
        { moduleId: IDS.modules.arch, label: '核心架构拓扑（已接受）', satisfied: true, moduleStatus: 'accepted' },
        { moduleId: IDS.modules.cleanup, label: '存量系统清洗（已接受）', satisfied: true, moduleStatus: 'accepted' },
      ],
      missingInputs: [],
      note: '依赖已满足；生成后仍需验证与人工接受。',
      candidateUnverified: false,
      targetModuleId: IDS.modules.value,
      sourceModuleId: IDS.modules.arch,
    },
  ];
  const spatial = snapshot.spatial as Record<string, unknown>;
  spatial.activeBranchId = null;
  spatial.stage = { phase: 'review', label: '全部模块已接受 · 可保存配方或生成综合成果', completedSteps: null, totalSteps: null, activeStepTitle: null, note: '四机制历史可在事件诊断中查看。' };
  snapshot.activeRun = null;
  snapshot.control = {
    runId: null,
    state: null,
    canPause: false,
    canResume: false,
    canCancel: false,
    budgetLabel: '模型 9/12 · 工具 8/20 · 金额未知',
    providerLabel: '演示夹具 · 无外部模型调用',
    connectionStatus: 'unconfigured',
    queuePosition: null,
    unsavedDraft: false,
  };
  return {
    ...base,
    snapshot,
    patches: [],
    baseContents: {},
    recipes: base.recipes.map((recipe) => ({ ...recipe, status: 'validated' as const })),
  };
}

function buildBlockedBundle(base: FixtureBundle): FixtureBundle {
  const snapshot = JSON.parse(JSON.stringify(base.snapshot)) as Record<string, unknown>;
  snapshot.plan = null;
  snapshot.patches = [];
  snapshot.validations = [];
  snapshot.activeRun = {
    runId: IDS.runs.plan,
    moduleId: IDS.modules.cleanup,
    state: 'AWAITING_INPUT',
    revision: 23,
    attempt: 2,
    planVersion: 1,
    contextSnapshotId: IDS.context.plan,
    budgetUsage: (base.snapshot as Record<string, unknown>).usage,
    error: null,
    interrupted: null,
  };
  snapshot.blockers = (base.snapshot as Record<string, unknown>).blockers;
  const spatial = snapshot.spatial as Record<string, unknown>;
  spatial.stage = { phase: 'resolving', label: '阻塞处理 · 4 项待决问题', completedSteps: 2, totalSteps: 5, activeStepTitle: '确认字段映射', note: '每批最多展示 3 张修复卡，其余按批次处理。' };
  snapshot.control = {
    runId: IDS.runs.plan,
    state: 'AWAITING_INPUT',
    canPause: false,
    canResume: false,
    canCancel: true,
    budgetLabel: '模型 2/12 · 工具 1/20 · token 入 2,180 · 出 420 · 金额未知',
    providerLabel: '演示夹具 · 无外部模型调用',
    connectionStatus: 'unconfigured',
    queuePosition: null,
    unsavedDraft: false,
  };
  return { ...base, snapshot, patches: [], validations: {}, baseContents: {}, recipeProposals: base.recipeProposals };
}

/** Parsed scenario snapshot plus full patch/validation/recipe detail for the fixture backend. */
export function loadFixtureBundle(scenario: FixtureScenario): FixtureBundle {
  return buildFixtureBundle(scenario);
}

export function fixtureScenarioFromParam(value: string | null | undefined): FixtureScenario {
  if (value === 'blocked' || value === 'empty' || value === 'completed' || value === 'review') return value;
  return 'review';
}
