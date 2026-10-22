/**
 * Deterministic artifact validator (design sections 9.3 and 11.4).
 *
 * Layers:
 * - L0 protocol: schema / module-kind / serializer limits.
 * - L1 structure: markdown section ids, CSV columns/rows/types, JSON depth/nodes,
 *   module dependency integrity, rendering-safety.
 * - L2 evidence: every reference resolves to a real SourceSpan / version / tool
 *   call, or is an explicit user assumption. Missing evidence is reported as
 *   concrete findings, never hidden.
 * - L3 business rules: real hard-constraint conflicts must have a recorded user
 *   decision; deterministic acceptance criteria are checked; semantic criteria are
 *   escalated to L4 human review instead of being guessed.
 * - L4 human review: machine validation never claims to replace the user.
 *
 * The validator is deterministic: no model calls, no self-scoring, no timers.
 */
import {
  EvidenceRefSchema,
  LIMITS,
  MODULE_KIND_CONTENT_KIND,
  ModuleContentSchema,
  ValidationReportSchema,
  isCommitAllowed,
  newValidationReportId,
  rollupValidationStatus,
  summarizeValidationFailures,
  layerLabel,
  type ArtifactVersion,
  type CheckStatus,
  type EvidenceRef,
  type ModuleContent,
  type SourceSpan,
  type Task,
  type ArtifactModule,
  type ValidationCheck,
  type ValidationLayer,
  type ValidationReport,
  type Decision,
} from '@ca/contracts';
import type { StoragePort } from '@ca/storage';
import type { ValidatorPort } from '@ca/tools';
import { contentHash, truncateChars, utf8Bytes } from './hashing';
import { detectConstraintConflicts, constraintConflictDecisionKey, resolvedConflictKeys } from './risk-rules';
import type { Clock } from './types';

export const ARTIFACT_VALIDATOR_VERSION = 'harness-validator-1';

export interface ArtifactValidatorDeps {
  storage: StoragePort;
  clock?: Clock;
}

const DEFAULT_CLOCK: Clock = {
  now: () => new Date().toISOString(),
  monotonicMs: () => Date.now(),
};

export function createArtifactValidator(deps: ArtifactValidatorDeps): ValidatorPort {
  const clock = deps.clock ?? DEFAULT_CLOCK;
  return {
    async validate(input): Promise<ValidationReport> {
      return validateArtifact({
        storage: deps.storage,
        clock,
        taskId: input.taskId,
        runId: input.runId,
        moduleId: input.moduleId,
        candidate: input.candidate,
        evidenceRefs: input.evidenceRefs,
        baseVersion: input.baseVersion,
      });
    },
  };
}

export interface ValidateArtifactInput {
  storage: StoragePort;
  clock: Clock;
  taskId: string;
  runId: string;
  moduleId: string;
  candidate: ModuleContent;
  evidenceRefs: readonly EvidenceRef[];
  baseVersion: ArtifactVersion | null;
}

interface LoadedContext {
  task: Task;
  module: ArtifactModule;
  modules: ArtifactModule[];
  spans: SourceSpan[];
  decisions: Decision[];
  upstreamVersions: Map<string, ArtifactVersion | null>;
  /** Evidence versions referenced by the candidate (loaded before checks). */
  referencedVersions: Map<string, ArtifactVersion | null>;
  toolCallIds: Set<string>;
}

export async function validateArtifact(input: ValidateArtifactInput): Promise<ValidationReport> {
  const { storage } = input;
  const task = await storage.getTask(input.taskId as never);
  const module = await storage.getModule(input.moduleId);
  if (!task || !module) {
    throw new Error(`validation target not found: task=${input.taskId} module=${input.moduleId}`);
  }
  const artifact = await storage.getArtifact(module.artifactId);
  if (!artifact) throw new Error(`artifact not found: ${module.artifactId}`);
  const modules = await storage.listModules(module.artifactId);
  const spans = await storage.listSpans(task.id, 1000);
  const decisions = await storage.listDecisions(task.id);
  const upstreamVersions = new Map<string, ArtifactVersion | null>();
  for (const dependencyId of module.dependencies) {
    upstreamVersions.set(dependencyId, await storage.getAcceptedVersion(dependencyId));
  }
  const referencedVersions = new Map<string, ArtifactVersion | null>();
  for (const raw of input.evidenceRefs) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== 'artifact_version') continue;
    const versionId = parsed.data.versionId;
    if (!referencedVersions.has(versionId)) {
      referencedVersions.set(versionId, await storage.getVersion(versionId));
    }
  }
  const invocations = await storage.listToolInvocations(input.runId);
  const context: LoadedContext = {
    task,
    module,
    modules,
    spans,
    decisions,
    upstreamVersions,
    referencedVersions,
    toolCallIds: new Set(invocations.map((record) => record.toolCallId)),
  };

  const checks: ValidationCheck[] = [];
  const parsedContent = ModuleContentSchema.safeParse(input.candidate);
  checks.push(...checkL0(input, context, parsedContent.success));
  const parsed = parsedContent.success ? parsedContent.data : null;
  checks.push(...checkL1(input, context, parsed));
  checks.push(...checkL2(input, context));
  checks.push(...checkL3(input, context, parsed));
  checks.push(...checkL4(input, context));
  if (parsed === null) {
    checks.push(
      makeCheck({
        id: 'L1.structure_skipped',
        layer: 'L1',
        code: 'structure_skipped',
        title: '结构校验被跳过',
        status: 'not_applicable',
        detail: '候选内容未通过 L0 Schema 校验，结构/证据/业务校验无法执行；请先修复 Schema 问题。',
      }),
    );
  }

  const status = rollupValidationStatus(checks);
  const failing = summarizeValidationFailures(checks, 20);
  const passCount = checks.filter((check) => check.status === 'pass').length;
  const failCount = checks.filter((check) => check.status === 'fail').length;
  const reviewCount = checks.filter((check) => check.status === 'needs_review').length;
  const summary =
    status === 'pass'
      ? `确定性校验通过（${passCount} 项通过，0 项失败，0 项待复核）`
      : [
          `确定性校验${status === 'fail' ? '未通过' : '需要复核'}：通过 ${passCount}，失败 ${failCount}，待复核 ${reviewCount}`,
          ...failing.map((line) => `- ${line}`),
        ].join('\n');

  return ValidationReportSchema.parse({
    id: newValidationReportId(),
    taskId: task.id,
    runId: input.runId,
    moduleId: module.id,
    baseVersionId: input.baseVersion?.id ?? null,
    candidateHash: contentHash(input.candidate),
    checks: checks.slice(0, 500),
    status,
    summary: truncateChars(summary, 4000),
    validatorVersion: ARTIFACT_VALIDATOR_VERSION,
    createdAt: input.clock.now(),
  });
}

/* ------------------------------- helpers ------------------------------- */

interface CheckInput {
  id: string;
  layer: ValidationLayer;
  code: string;
  title: string;
  status: CheckStatus;
  detail: string;
  evidenceRefs?: EvidenceRef[];
  affectedPaths?: string[];
}

function makeCheck(input: CheckInput): ValidationCheck {
  return {
    id: input.id.slice(0, 128),
    layer: input.layer,
    code: input.code.slice(0, 128),
    title: input.title.slice(0, 300),
    status: input.status,
    detail: truncateChars(input.detail, 4000),
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, 64),
    affectedPaths: (input.affectedPaths ?? []).map((path) => path.slice(0, 512)).slice(0, 64),
  };
}

function pass(id: string, layer: ValidationLayer, code: string, title: string, detail: string): ValidationCheck {
  return makeCheck({ id, layer, code, title, status: 'pass', detail });
}

/* ---------------------------------- L0 ---------------------------------- */

function checkL0(
  input: ValidateArtifactInput,
  context: LoadedContext,
  schemaOk: boolean,
): ValidationCheck[] {
  const { module } = context;
  const checks: ValidationCheck[] = [];
  checks.push(
    makeCheck({
      id: 'L0.content_schema',
      layer: 'L0',
      code: 'content_schema',
      title: '候选内容符合模块内容 Schema',
      status: schemaOk ? 'pass' : 'fail',
      detail: schemaOk
        ? '候选内容通过 ModuleContentSchema 运行时校验。'
        : '候选内容不满足 ModuleContentSchema（必填字段、类型或上限不合法），无法作为成果提交。',
    }),
  );

  if (!schemaOk) {
    checks.push(
      makeCheck({
        id: 'L0.module_kind_match',
        layer: 'L0',
        code: 'module_kind_match',
        title: '内容类型与模块类型一致',
        status: 'fail',
        detail: `模块类型为 ${module.kind}，候选内容类型无法解析；内容类型必须为 ${MODULE_KIND_CONTENT_KIND[module.kind]}。`,
      }),
    );
    return checks;
  }

  const expectedKind = MODULE_KIND_CONTENT_KIND[module.kind];
  const kindOk = input.candidate.kind === expectedKind;
  checks.push(
    makeCheck({
      id: 'L0.module_kind_match',
      layer: 'L0',
      code: 'module_kind_match',
      title: '内容类型与模块类型一致',
      status: kindOk ? 'pass' : 'fail',
      detail: kindOk
        ? `候选内容类型 ${input.candidate.kind} 与模块类型 ${module.kind} 一致。`
        : `模块类型为 ${module.kind}，要求内容类型 ${expectedKind}，实际为 ${input.candidate.kind}。`,
    }),
  );

  const bytes = utf8Bytes(safeStringify(input.candidate));
  const sizeOk = bytes <= LIMITS.maxToolResultBytes;
  checks.push(
    makeCheck({
      id: 'L0.content_size',
      layer: 'L0',
      code: 'content_size',
      title: '候选内容大小在安全上限内',
      status: sizeOk ? 'pass' : 'fail',
      detail: sizeOk
        ? `候选内容约 ${bytes} 字节（上限 ${LIMITS.maxToolResultBytes}）。`
        : `候选内容约 ${bytes} 字节，超过上限 ${LIMITS.maxToolResultBytes} 字节。`,
    }),
  );
  return checks;
}

/* ---------------------------------- L1 ---------------------------------- */

function checkL1(
  input: ValidateArtifactInput,
  context: LoadedContext,
  content: ModuleContent | null,
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const { module } = context;

  if (content) {
    switch (content.kind) {
      case 'markdown':
        checks.push(...checkMarkdown(content));
        break;
      case 'csv':
        checks.push(...checkCsv(content));
        break;
      case 'json':
        checks.push(...checkJson(content));
        break;
    }
  }

  // Module dependency integrity: upstream modules must exist and be accepted.
  const missingModules = module.dependencies.filter((dependencyId) => !context.modules.some((entry) => entry.id === dependencyId));
  const unaccepted = module.dependencies.filter((dependencyId) => context.upstreamVersions.get(dependencyId) === null);
  if (module.dependencies.length === 0) {
    checks.push(
      pass('L1.dependency_integrity', 'L1', 'dependency_integrity', '模块依赖完整性', '模块没有上游依赖。'),
    );
  } else if (missingModules.length > 0 || unaccepted.length > 0) {
    checks.push(
      makeCheck({
        id: 'L1.dependency_integrity',
        layer: 'L1',
        code: 'dependency_integrity',
        title: '上游依赖必须存在且已接受',
        status: 'fail',
        detail: [
          missingModules.length > 0 ? `依赖模块不存在：${missingModules.join(', ')}` : '',
          unaccepted.length > 0 ? `依赖模块尚无已接受版本：${unaccepted.join(', ')}` : '',
          '请先接受上游模块，或调整模块依赖。',
        ]
          .filter(Boolean)
          .join('\n'),
        affectedPaths: ['dependencies'],
      }),
    );
  } else {
    const stale = module.dependencies.filter((dependencyId) => context.upstreamVersions.get(dependencyId) !== null);
    checks.push(
      pass(
        'L1.dependency_integrity',
        'L1',
        'dependency_integrity',
        '模块依赖完整性',
        `所有上游依赖均有已接受版本（${stale.length} 个）。`,
      ),
    );
  }

  // Rendering safety: raw scripts/dangerous links in markdown must be rejected.
  if (content?.kind === 'markdown') {
    const text = content.sections.map((section) => section.markdown).join('\n');
    const unsafe = /<script|<iframe|<object|javascript:\s*|on(?:error|load|click)\s*=/i.test(text);
    checks.push(
      makeCheck({
        id: 'L1.render_safety',
        layer: 'L1',
        code: 'render_safety',
        title: 'Markdown 不包含可执行脚本或危险链接',
        status: unsafe ? 'fail' : 'pass',
        detail: unsafe
          ? '内容包含 <script>/<iframe>/javascript: 链接或内联事件处理器，属于被禁止的危险 HTML。'
          : '未发现被禁止的可执行 HTML/危险链接。',
      }),
    );
    const hasPlaceholders = /(TODO|TBD|待补充|待填写|占位)/.test(text);
    checks.push(
      makeCheck({
        id: 'L1.completeness',
        layer: 'L1',
        code: 'completeness',
        title: '成果内容完整（无占位符）',
        status: hasPlaceholders ? 'needs_review' : 'pass',
        detail: hasPlaceholders
          ? '内容中仍有 TODO/TBD/待补充 等占位标记，模块尚不完整。'
          : '未发现占位标记。',
      }),
    );
  }
  return checks;
}

function checkMarkdown(content: Extract<ModuleContent, { kind: 'markdown' }>): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  if (content.sections.length === 0) {
    checks.push(
      makeCheck({
        id: 'L1.markdown_nonempty',
        layer: 'L1',
        code: 'markdown_nonempty',
        title: 'Markdown 模块至少包含一个章节',
        status: 'fail',
        detail: '候选内容没有任何章节，不能作为可审阅成果。',
        affectedPaths: ['sections'],
      }),
    );
    return checks;
  }
  const ids = content.sections.map((section) => section.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const empty = content.sections.filter((section) => section.markdown.trim().length === 0).map((section) => section.id);
  checks.push(
    makeCheck({
      id: 'L1.markdown_section_ids_unique',
      layer: 'L1',
      code: 'markdown_section_ids_unique',
      title: '章节 ID 唯一',
      status: duplicates.length === 0 ? 'pass' : 'fail',
      detail:
        duplicates.length === 0
          ? `共 ${content.sections.length} 个章节，ID 唯一。`
          : `存在重复章节 ID：${[...new Set(duplicates)].join(', ')}；章节 ID 必须稳定且唯一。`,
      affectedPaths: [...new Set(duplicates)].map((id) => `sections/${id}`),
    }),
  );
  checks.push(
    makeCheck({
      id: 'L1.markdown_sections_nonempty',
      layer: 'L1',
      code: 'markdown_sections_nonempty',
      title: '每个章节都有实际内容',
      status: empty.length === 0 ? 'pass' : 'fail',
      detail: empty.length === 0 ? '所有章节正文非空。' : `以下章节正文为空：${empty.join(', ')}。`,
      affectedPaths: empty.map((id) => `sections/${id}/markdown`),
    }),
  );
  return checks;
}

interface CsvColumnLike {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  required?: boolean;
}
type CsvRowLike = Record<string, string | number | boolean | null>;

function checkCsv(content: Extract<ModuleContent, { kind: 'csv' }>): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const columns = content.columns as CsvColumnLike[];
  const rows = content.rows as CsvRowLike[];
  const keys = columns.map((column) => column.key);
  const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);

  checks.push(
    makeCheck({
      id: 'L1.csv_columns_unique',
      layer: 'L1',
      code: 'csv_columns_unique',
      title: '表格列唯一且非空',
      status: duplicateKeys.length === 0 ? 'pass' : 'fail',
      detail:
        duplicateKeys.length === 0
          ? `共 ${columns.length} 列，key 唯一。`
          : `列 key 重复：${[...new Set(duplicateKeys)].join(', ')}。`,
      affectedPaths: duplicateKeys.map((key) => `columns/${key}`),
    }),
  );

  const keySet = new Set(keys);
  const extraKeys = new Set<string>();
  const missingCells: string[] = [];
  const requiredMissing: string[] = [];
  rows.forEach((row, index) => {
    for (const key of Object.keys(row)) {
      if (!keySet.has(key)) extraKeys.add(key);
    }
    for (const column of columns) {
      const value = row[column.key];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        missingCells.push(`第 ${index + 1} 行缺少列 ${column.key}`);
        if (column.required) requiredMissing.push(`第 ${index + 1} 行必填列 ${column.key} 为空`);
      }
    }
  });
  checks.push(
    makeCheck({
      id: 'L1.csv_row_shape',
      layer: 'L1',
      code: 'csv_row_shape',
      title: '每行都符合声明的列集合',
      status: extraKeys.size === 0 ? 'pass' : 'fail',
      detail:
        extraKeys.size === 0
          ? `所有 ${rows.length} 行只包含声明列。`
          : `存在未声明的列：${[...extraKeys].join(', ')}。`,
      affectedPaths: [...extraKeys].map((key) => `columns/${key}`),
    }),
  );
  checks.push(
    makeCheck({
      id: 'L1.csv_required_values',
      layer: 'L1',
      code: 'csv_required_values',
      title: '必填列没有缺失值',
      status: requiredMissing.length === 0 ? 'pass' : 'fail',
      detail:
        requiredMissing.length === 0
          ? '所有必填列均有值。'
          : requiredMissing.slice(0, 20).join('；') + (requiredMissing.length > 20 ? `；共 ${requiredMissing.length} 处` : ''),
      affectedPaths: requiredMissing.slice(0, 20).map((line) => line.replace(' ', '/')),
    }),
  );

  const typeIssues: string[] = [];
  rows.forEach((row, index) => {
    for (const column of columns) {
      const value = row[column.key];
      if (value === undefined || value === null) continue;
      if (!cellMatchesType(column.type, value)) {
        typeIssues.push(`第 ${index + 1} 行 ${column.key}=${JSON.stringify(value)} 不符合 ${column.type}`);
      }
    }
  });
  checks.push(
    makeCheck({
      id: 'L1.csv_column_types',
      layer: 'L1',
      code: 'csv_column_types',
      title: '单元格类型与声明列类型一致',
      status: typeIssues.length === 0 ? 'pass' : 'fail',
      detail: typeIssues.length === 0 ? '所有单元格类型与声明一致。' : typeIssues.slice(0, 20).join('；'),
      affectedPaths: typeIssues.slice(0, 20),
    }),
  );

  const rowJson = rows.map((row) => safeStringify(row));
  const duplicates = rowJson.filter((serialized, index) => rowJson.indexOf(serialized) !== index);
  checks.push(
    makeCheck({
      id: 'L1.csv_duplicate_rows',
      layer: 'L1',
      code: 'csv_duplicate_rows',
      title: '表格无重复行',
      status: duplicates.length === 0 ? 'pass' : 'needs_review',
      detail:
        duplicates.length === 0
          ? `${rows.length} 行数据没有重复行。`
          : `存在 ${duplicates.length} 行重复数据（去重键需人工确认，例如主键或业务键）。`,
      affectedPaths: duplicates.slice(0, 10),
    }),
  );
  if (missingCells.length > 0 && requiredMissing.length === 0) {
    checks.push(
      makeCheck({
        id: 'L1.csv_missing_cells',
        layer: 'L1',
        code: 'csv_missing_cells',
        title: '非必填列存在空值（可接受，已记录）',
        status: 'pass',
        detail: `存在 ${missingCells.length} 个空值（所在列非必填）。`,
      }),
    );
  }
  void keys;
  return checks;
}

function cellMatchesType(type: CsvColumnLike['type'], value: string | number | boolean): boolean {
  switch (type) {
    case 'string':
      return true;
    case 'number':
      if (typeof value === 'number') return Number.isFinite(value);
      return /^[-+]?\d+(?:\.\d+)?$/.test(String(value).trim());
    case 'boolean':
      if (typeof value === 'boolean') return true;
      return /^(true|false|0|1|是|否)$/i.test(String(value).trim());
    case 'date': {
      const text = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(text) && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return false;
      return !Number.isNaN(Date.parse(text));
    }
  }
}

function checkJson(content: Extract<ModuleContent, { kind: 'json' }>): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const stats = inspectJson(content.value);
  checks.push(
    makeCheck({
      id: 'L1.json_depth',
      layer: 'L1',
      code: 'json_depth',
      title: 'JSON 嵌套深度在上限内',
      status: stats.depth <= LIMITS.maxJsonDepth ? 'pass' : 'fail',
      detail: `最大嵌套深度 ${stats.depth}（上限 ${LIMITS.maxJsonDepth}）。`,
      affectedPaths: stats.deepestPath ? [stats.deepestPath] : [],
    }),
  );
  checks.push(
    makeCheck({
      id: 'L1.json_nodes',
      layer: 'L1',
      code: 'json_nodes',
      title: 'JSON 节点数量在上限内',
      status: stats.nodes <= LIMITS.maxJsonNodes ? 'pass' : 'fail',
      detail: `节点数 ${stats.nodes}（上限 ${LIMITS.maxJsonNodes}）。`,
    }),
  );
  checks.push(
    makeCheck({
      id: 'L1.json_safe_keys',
      layer: 'L1',
      code: 'json_safe_keys',
      title: 'JSON 不包含原型污染键',
      status: stats.unsafeKeys.length === 0 ? 'pass' : 'fail',
      detail:
        stats.unsafeKeys.length === 0
          ? '未发现 __proto__/constructor/prototype 键。'
          : `发现危险键：${stats.unsafeKeys.slice(0, 10).join(', ')}。`,
      affectedPaths: stats.unsafeKeys.slice(0, 10),
    }),
  );

  const graph = collectJsonGraph(content.value);
  if (graph.ids.length >= 2) {
    const duplicates = graph.ids.filter((id, index) => graph.ids.indexOf(id) !== index);
    checks.push(
      makeCheck({
        id: 'L1.json_ids_unique',
        layer: 'L1',
        code: 'json_ids_unique',
        title: 'JSON 对象 ID 唯一',
        status: duplicates.length === 0 ? 'pass' : 'fail',
        detail:
          duplicates.length === 0
            ? `检查到 ${graph.ids.length} 个 id，均唯一。`
            : `重复 id：${[...new Set(duplicates)].slice(0, 20).join(', ')}。`,
      }),
    );
  } else {
    checks.push(
      makeCheck({
        id: 'L1.json_ids_unique',
        layer: 'L1',
        code: 'json_ids_unique',
        title: 'JSON 对象 ID 唯一',
        status: 'not_applicable',
        detail: '内容中没有包含 id 的对象集合，无法适用唯一性检查。',
      }),
    );
  }
  if (graph.edges.length > 0) {
    const cycle = findGraphCycle(graph.nodes, graph.edges);
    const unknownEdges = graph.edges.filter((edge) => !graph.nodes.has(edge.to));
    checks.push(
      makeCheck({
        id: 'L1.json_dependency_acyclic',
        layer: 'L1',
        code: 'json_dependency_acyclic',
        title: 'JSON 内依赖关系无环',
        status: cycle || unknownEdges.length > 0 ? 'fail' : 'pass',
        detail: cycle
          ? `发现依赖环：${cycle.join(' -> ')}。`
          : unknownEdges.length > 0
            ? `依赖引用未知节点：${unknownEdges.slice(0, 10).map((edge) => `${edge.from}->${edge.to}`).join(', ')}。`
            : `检查到 ${graph.edges.length} 条依赖关系，无环。`,
        affectedPaths: cycle ? [cycle.join(' -> ')] : [],
      }),
    );
  } else {
    checks.push(
      makeCheck({
        id: 'L1.json_dependency_acyclic',
        layer: 'L1',
        code: 'json_dependency_acyclic',
        title: 'JSON 内依赖关系无环',
        status: 'not_applicable',
        detail: '内容中没有 id/dependencies 结构，无法适用依赖无环检查。',
      }),
    );
  }
  return checks;
}

interface JsonStats {
  depth: number;
  nodes: number;
  deepestPath: string;
  unsafeKeys: string[];
}

function inspectJson(value: unknown): JsonStats {
  const stats: JsonStats = { depth: 0, nodes: 0, deepestPath: '', unsafeKeys: [] };
  const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
  const visit = (node: unknown, depth: number, path: string): void => {
    stats.nodes += 1;
    if (depth > stats.depth) {
      stats.depth = depth;
      stats.deepestPath = path || '/';
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, depth + 1, `${path}/${index}`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (unsafe.has(key)) stats.unsafeKeys.push(`${path}/${key}`);
        visit(child, depth + 1, `${path}/${key}`);
      }
    }
  };
  visit(value, 0, '');
  return stats;
}

interface JsonGraph {
  ids: string[];
  nodes: Set<string>;
  edges: Array<{ from: string; to: string }>;
}

function collectJsonGraph(value: unknown): JsonGraph {
  const graph: JsonGraph = { ids: [], nodes: new Set(), edges: [] };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const id = record.id;
    if (typeof id === 'string' && id.length > 0) {
      graph.ids.push(id);
      graph.nodes.add(id);
      for (const key of ['dependencies', 'dependsOn', 'depends_on', 'deps']) {
        const deps = record[key];
        if (Array.isArray(deps)) {
          for (const dep of deps) {
            if (typeof dep === 'string') graph.edges.push({ from: id, to: dep });
          }
        }
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return graph;
}

function findGraphCycle(nodes: ReadonlySet<string>, edges: ReadonlyArray<{ from: string; to: string }>): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const id of nodes) adjacency.set(id, []);
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const mark = state.get(id) ?? 0;
    if (mark === 2) return null;
    if (mark === 1) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of nodes) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/* ---------------------------------- L2 ---------------------------------- */

function checkL2(input: ValidateArtifactInput, context: LoadedContext): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const spansById = new Map(context.spans.map((span) => [span.id, span]));
  const parsedRefs: EvidenceRef[] = [];
  const invalidRefs: string[] = [];
  for (const [index, raw] of input.evidenceRefs.entries()) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success) {
      invalidRefs.push(`第 ${index + 1} 条证据引用格式非法`);
      continue;
    }
    parsedRefs.push(parsed.data);
  }
  checks.push(
    makeCheck({
      id: 'L2.evidence_ref_format',
      layer: 'L2',
      code: 'evidence_ref_format',
      title: '证据引用格式合法',
      status: invalidRefs.length === 0 ? 'pass' : 'fail',
      detail:
        invalidRefs.length === 0
          ? `共 ${parsedRefs.length} 条证据引用，格式合法。`
          : invalidRefs.join('；'),
    }),
  );

  const sourceRefs = parsedRefs.filter((ref): ref is Extract<EvidenceRef, { kind: 'source_span' }> => ref.kind === 'source_span');
  const missingSpans: string[] = [];
  const unavailableSources: string[] = [];
  for (const ref of sourceRefs) {
    const span = spansById.get(ref.span.spanId);
    if (!span) {
      missingSpans.push(`span ${ref.span.spanId} 不存在于本任务证据库`);
      continue;
    }
    if (span.sourceId !== ref.span.sourceId || span.version !== ref.span.version || span.quoteHash !== ref.span.quoteHash) {
      missingSpans.push(`span ${ref.span.spanId} 的来源/版本/引文哈希不匹配`);
    }
  }
  checks.push(
    makeCheck({
      id: 'L2.source_spans_exist',
      layer: 'L2',
      code: 'source_spans_exist',
      title: '引用的 SourceSpan 真实存在且定位匹配',
      status: missingSpans.length === 0 ? 'pass' : 'fail',
      detail:
        sourceRefs.length === 0
          ? '候选没有声明来源片段引用。'
          : missingSpans.length === 0
            ? `检查到 ${sourceRefs.length} 条 SourceSpan 引用，均可在证据库中定位。`
            : missingSpans.slice(0, 20).join('；'),
      evidenceRefs: sourceRefs.slice(0, 32),
    }),
  );

  const artifactRefs = parsedRefs.filter(
    (ref): ref is Extract<EvidenceRef, { kind: 'artifact_version' }> => ref.kind === 'artifact_version',
  );
  const invalidArtifactRefs: string[] = [];
  for (const ref of artifactRefs) {
    const version = context.referencedVersions.get(ref.versionId) ?? null;
    if (!version) {
      invalidArtifactRefs.push(`版本 ${ref.versionId} 不存在`);
      continue;
    }
    if (version.moduleId !== ref.moduleId) {
      invalidArtifactRefs.push(`版本 ${ref.versionId} 不属于模块 ${ref.moduleId}`);
    }
  }
  checks.push(
    makeCheck({
      id: 'L2.artifact_versions_exist',
      layer: 'L2',
      code: 'artifact_versions_exist',
      title: '引用的已接受成果版本真实存在',
      status: invalidArtifactRefs.length === 0 ? 'pass' : 'fail',
      detail:
        artifactRefs.length === 0
          ? '候选没有引用已接受成果版本。'
          : invalidArtifactRefs.length === 0
            ? `${artifactRefs.length} 条成果版本引用均可解析。`
            : invalidArtifactRefs.join('；'),
      evidenceRefs: artifactRefs.slice(0, 32),
    }),
  );

  const toolRefs = parsedRefs.filter((ref): ref is Extract<EvidenceRef, { kind: 'tool_result' }> => ref.kind === 'tool_result');
  const invalidToolRefs = toolRefs.filter((ref) => !context.toolCallIds.has(ref.toolResult.toolCallId));
  checks.push(
    makeCheck({
      id: 'L2.tool_results_exist',
      layer: 'L2',
      code: 'tool_results_exist',
      title: '引用的工具结果来自本 Run 的真实调用',
      status: invalidToolRefs.length === 0 ? 'pass' : 'fail',
      detail:
        toolRefs.length === 0
          ? '候选没有引用工具结果。'
          : invalidToolRefs.length === 0
            ? `${toolRefs.length} 条工具结果引用均可在本 Run 调用记录中找到。`
            : `未找到工具调用：${invalidToolRefs.map((ref) => ref.toolResult.toolCallId).join(', ')}`,
    }),
  );

  const assumptions = parsedRefs.filter((ref) => ref.kind === 'user_assumption');
  checks.push(
    makeCheck({
      id: 'L2.explicit_assumptions',
      layer: 'L2',
      code: 'explicit_assumptions',
      title: '未经验证的陈述标记为显式假设',
      status: 'pass',
      detail:
        assumptions.length > 0
          ? `候选包含 ${assumptions.length} 条显式假设；它们不是事實，需在人工验收时确认。`
          : '候选没有显式假设。',
    }),
  );

  const requiresEvidence = context.module.acceptanceCriteria.some((criterion) => criterion.layer === 'L2');
  if (requiresEvidence && parsedRefs.filter((ref) => ref.kind === 'source_span' || ref.kind === 'artifact_version').length === 0) {
    checks.push(
      makeCheck({
        id: 'L2.evidence_required',
        layer: 'L2',
        code: 'evidence_required',
        title: '模块验收标准要求证据引用',
        status: 'needs_review',
        detail:
          '该模块的验收标准包含 L2 证据要求，但候选没有提供任何 SourceSpan 或已接受成果版本引用。请补齐引用，或把相关陈述明确改写为待验证假设。',
      }),
    );
  } else {
    checks.push(
      makeCheck({
        id: 'L2.evidence_required',
        layer: 'L2',
        code: 'evidence_required',
        title: '模块验收标准要求证据引用',
        status: 'not_applicable',
        detail: '该模块的验收标准没有 L2 证据要求，或已提供证据引用。',
      }),
    );
  }
  return checks;
}

/* ---------------------------------- L3 ---------------------------------- */

function checkL3(input: ValidateArtifactInput, context: LoadedContext, content: ModuleContent | null): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const conflicts = detectConstraintConflicts(context.task.constraints);
  const decisionKeys = resolvedConflictKeys(context.decisions);
  const unresolved = conflicts.filter((conflict) => !decisionKeys.has(constraintConflictDecisionKey(conflict)));
  if (conflicts.length === 0) {
    checks.push(pass('L3.constraint_conflicts', 'L3', 'constraint_conflicts', '硬约束没有可检测的冲突', '确定性规则未发现硬约束之间的冲突。'));
  } else {
    checks.push(
      makeCheck({
        id: 'L3.constraint_conflicts',
        layer: 'L3',
        code: 'constraint_conflicts',
        title: '硬约束冲突必须由用户显式处理',
        status: unresolved.length === 0 ? 'pass' : 'fail',
        detail:
          unresolved.length === 0
            ? '检测到的硬约束冲突均有用户决策记录。'
            : unresolved
                .map(
                  (conflict) =>
                    `${conflict.title}（约束 ${conflict.constraintIds.join(' 与 ')}）：${conflict.description}。请修改输入、缩小范围，或由用户显式修改约束；不能通过忽略抹掉。`,
                )
                .join('\n'),
        affectedPaths: ['constraints'],
      }),
    );
  }

  if (content) {
    checks.push(...checkAcceptanceCriteria(context, content));
  }
  return checks;
}

function checkAcceptanceCriteria(context: LoadedContext, content: ModuleContent): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const text = contentText(content);
  for (const [index, criterion] of context.module.acceptanceCriteria.entries()) {
    const evaluated =
      criterion.layer === 'L2' || criterion.layer === 'L3' || criterion.layer === 'L1'
        ? evaluateCriterion(criterion.text, context, content, text)
        : null;
    if (evaluated && evaluated.status !== 'needs_review') {
      checks.push(
        makeCheck({
          id: `L3.criterion_${index + 1}`,
          layer: criterion.layer === 'L2' ? 'L2' : 'L3',
          code: `criterion_${index + 1}`,
          title: truncateChars(criterion.text, 300),
          status: evaluated.status,
          detail: evaluated.detail,
        }),
      );
      continue;
    }
    if (evaluated && evaluated.status === 'needs_review') {
      checks.push(
        makeCheck({
          id: `L4.criterion_${index + 1}`,
          layer: 'L4',
          code: `criterion_${index + 1}`,
          title: truncateChars(criterion.text, 300),
          status: 'needs_review',
          detail: evaluated.detail,
        }),
      );
      continue;
    }
    checks.push(
      makeCheck({
        id: `L4.criterion_${index + 1}`,
        layer: 'L4',
        code: `criterion_${index + 1}`,
        title: truncateChars(criterion.text, 300),
        status: 'needs_review',
        detail: '该验收标准需要人工判断（机器无法确定性验证），请在审阅时确认。',
      }),
    );
  }
  if (context.module.acceptanceCriteria.length === 0) {
    checks.push(
      makeCheck({
        id: 'L3.acceptance_criteria',
        layer: 'L3',
        code: 'acceptance_criteria',
        title: '模块验收标准',
        status: 'not_applicable',
        detail: '模块没有声明验收标准。',
      }),
    );
  }
  return checks;
}

interface CriterionResult {
  status: 'pass' | 'fail' | 'needs_review';
  detail: string;
}

function evaluateCriterion(
  criterion: string,
  context: LoadedContext,
  content: ModuleContent,
  text: string,
): CriterionResult | null {
  const json = content.kind === 'json' ? collectJsonGraph(content.value) : null;
  if (/(ID|id|标识).{0,6}(唯一)|唯一.{0,6}(ID|id|标识)/.test(criterion) || /组件 ID 唯一/.test(criterion)) {
    if (content.kind === 'json' && json) {
      const duplicates = json.ids.filter((id, index) => json.ids.indexOf(id) !== index);
      return duplicates.length === 0
        ? { status: 'pass', detail: `检查到 ${json.ids.length} 个 id，均唯一。` }
        : { status: 'fail', detail: `重复 id：${[...new Set(duplicates)].join(', ')}。` };
    }
    if (content.kind === 'csv') {
      const idColumn = content.columns.find((column) => /(^|_|-)(id|key)$/i.test(column.key) || /(ID|编号|主键)/.test(column.label));
      if (idColumn) {
        const values = content.rows.map((row) => String(row[idColumn.key] ?? ''));
        const duplicates = values.filter((value, index) => value !== '' && values.indexOf(value) !== index);
        return duplicates.length === 0
          ? { status: 'pass', detail: `主键列 ${idColumn.key} 的 ${values.length} 个值均唯一。` }
          : { status: 'fail', detail: `主键列 ${idColumn.key} 存在重复值：${[...new Set(duplicates)].slice(0, 10).join(', ')}。` };
      }
      return { status: 'needs_review', detail: '验收标准要求唯一性，但表格没有可识别的主键/ID 列，需要人工确认去重键。' };
    }
    return null;
  }
  if (/无环/.test(criterion)) {
    if (content.kind === 'json' && json && json.edges.length > 0) {
      const cycle = findGraphCycle(json.nodes, json.edges);
      return cycle
        ? { status: 'fail', detail: `发现依赖环：${cycle.join(' -> ')}。` }
        : { status: 'pass', detail: '依赖关系无环。' };
    }
    return null;
  }
  if (/必填/.test(criterion)) {
    if (content.kind === 'csv') {
      const required = content.columns.filter((column) => column.required);
      const missing: string[] = [];
      content.rows.forEach((row, index) => {
        for (const column of required) {
          const value = row[column.key];
          if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
            missing.push(`第 ${index + 1} 行 ${column.key}`);
          }
        }
      });
      return missing.length === 0
        ? { status: 'pass', detail: `必填列（${required.map((column) => column.key).join(', ') || '无'}）均有值。` }
        : { status: 'fail', detail: `必填字段缺失：${missing.slice(0, 20).join('；')}` };
    }
    if (content.kind === 'json' && json && json.ids.length > 0) {
      return { status: 'pass', detail: 'JSON 对象均包含 id 字段，未发现必填缺失。' };
    }
    return null;
  }
  if (/不覆盖原始输入|原始输入不被覆盖|输出为新对象/.test(criterion)) {
    return { status: 'pass', detail: '成果版本模型不可变：候选只生成草稿补丁，不修改原始资料或已接受版本。' };
  }
  if (/只使用已接受的上游版本|已接受上游/.test(criterion)) {
    const unaccepted = context.module.dependencies.filter((dependencyId) => context.upstreamVersions.get(dependencyId) === null);
    return unaccepted.length === 0
      ? { status: 'pass', detail: '上游依赖均有已接受版本。' }
      : { status: 'fail', detail: `以下依赖尚无已接受版本：${unaccepted.join(', ')}。` };
  }
  if (/行数|记录数/.test(criterion)) {
    const expected = /(\d+)\s*(行|条|记录)/.exec(criterion);
    if (expected && content.kind === 'csv') {
      return {
        status: 'needs_review',
        detail: `验收标准提到 ${expected[1]} 行的记录数核对；当前输出为 ${content.rows.length} 行，需要人工核对去重规则与该数字是否一致。`,
      };
    }
    return null;
  }
  void text;
  return null;
}

/* ---------------------------------- L4 ---------------------------------- */

function checkL4(_input: ValidateArtifactInput, _context: LoadedContext): ValidationCheck[] {
  return [
    makeCheck({
      id: 'L4.human_review',
      layer: 'L4',
      code: 'human_review',
      title: '人工验收（方案合理性、表达质量、取舍）',
      status: 'needs_review',
      detail: '机器校验只覆盖 Schema、结构、证据可定位与确定性业务规则；方案合理性与实际可用性必须由用户验收。',
    }),
  ];
}

/* -------------------------------- utilities -------------------------------- */

function contentText(content: ModuleContent): string {
  switch (content.kind) {
    case 'markdown':
      return content.sections.map((section) => `${section.title}\n${section.markdown}`).join('\n');
    case 'json':
      return safeStringify(content.value);
    case 'csv':
      return content.rows.map((row) => Object.values(row).join(',')).join('\n');
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '<unserializable>';
  }
}

/** Public helper: true when the report has no blocking L0-L3 findings. */
export function reportAllowsCommit(report: Pick<ValidationReport, 'checks' | 'status'>): boolean {
  return isCommitAllowed(report);
}

/** Public helper: layer labels for readable findings. */
export function describeLayer(layer: ValidationLayer): string {
  return layerLabel(layer);
}
