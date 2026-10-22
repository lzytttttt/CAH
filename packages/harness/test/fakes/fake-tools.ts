/**
 * Deterministic ToolRuntime fake: real argument-schema validation (from
 * @ca/contracts) but in-memory tool bodies, so kernel tests exercise the exact
 * "complete + valid → execute" contract without touching real tools.
 */
import {
  ArtifactProposePatchArgsSchema,
  ArtifactReadArgsSchema,
  ArtifactValidateArgsSchema,
  DataProfileArgsSchema,
  DataTransformArgsSchema,
  SourceListArgsSchema,
  SourceReadArgsSchema,
  SourceSearchArgsSchema,
  TOOL_IDS,
  applyPatchOperations,
  type ArtifactModule,
  type JsonObject,
  type JsonValue,
  type ModuleContent,
  type PatchProposal,
  type SourceListItem,
  type SourceReadResult,
  type SourceSearchResult,
  type ToolCallId,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolId,
  type ToolResult,
  type ToolScope,
  type TransformOperation,
} from '@ca/contracts';
import type { ArtifactAccessPort, SourceReaderPort, ToolContext, ToolRuntime, ValidatorPort } from '@ca/tools';
import type { StoragePort } from '@ca/storage';
import { z } from 'zod';
import { contentHash, sha256Hex } from '../../src/hashing';

export interface FakeToolOptions {
  storage: StoragePort;
  /** Executed tool calls (after schema validation), for assertions. */
  calls?: Array<{ toolId: ToolId; args: JsonObject; executedAt: string }>;
}

const JSON_SCHEMA = (schema: unknown): JsonObject => {
  try {
    return z.toJSONSchema(schema as never) as JsonObject;
  } catch {
    return { type: 'object', additionalProperties: true };
  }
};

function descriptor(
  id: ToolId,
  title: string,
  description: string,
  effect: 'read' | 'draft_write',
  idempotency: 'safe' | 'keyed',
  scopes: ToolScope[],
  parametersSchema: unknown,
  resultDescription: string,
): ToolDescriptor {
  return {
    id,
    version: '1.0.0',
    title,
    description,
    policy: {
      effect,
      idempotency,
      timeoutMs: 5_000,
      maxResultBytes: 2 * 1024 * 1024,
      requiredScopes: scopes,
    },
    parameters: JSON_SCHEMA(parametersSchema),
    modelFacing: true,
    resultDescription,
  };
}

const DESCRIPTORS: ToolDescriptor[] = [
  descriptor('source.list', '列出资料', '列出当前任务已授权资料的元数据', 'read', 'safe', ['sources:read'], SourceListArgsSchema, '资料清单'),
  descriptor('source.read', '读取资料', '按 sourceId、版本与定位读取资料片段', 'read', 'safe', ['sources:read'], SourceReadArgsSchema, '资料片段'),
  descriptor('source.search', '检索资料', '在已授权资料中检索并返回可定位的 SourceSpan', 'read', 'safe', ['sources:read'], SourceSearchArgsSchema, '检索命中'),
  descriptor('data.profile', '数据画像', '分析 CSV/JSON 的结构、缺失、重复与类型', 'read', 'safe', ['data:profile'], DataProfileArgsSchema, '列画像'),
  descriptor('data.transform', '数据转换', '执行声明式的字段映射、过滤、排序、去重与规范化', 'read', 'safe', ['data:transform'], DataTransformArgsSchema, '转换结果'),
  descriptor('artifact.read', '读取成果', '读取模块与指定版本内容', 'read', 'safe', ['artifact:read'], ArtifactReadArgsSchema, '模块内容'),
  descriptor('artifact.propose_patch', '提议补丁', '基于基线创建带证据的候选补丁草稿', 'draft_write', 'keyed', ['artifact:draft_write', 'artifact:validate'], ArtifactProposePatchArgsSchema, '补丁草稿与校验报告'),
  descriptor('artifact.validate', '校验成果', '运行确定性校验器并返回逐项结果', 'read', 'safe', ['artifact:validate'], ArtifactValidateArgsSchema, '校验结果'),
];

export class FakeToolRuntime implements ToolRuntime {
  readonly calls: Array<{ toolId: ToolId; args: JsonObject }> = [];
  readonly descriptorsValue = DESCRIPTORS;
  readonly handlers = new Map<ToolId, (args: JsonObject, ctx: ToolContext) => Promise<ToolResult>>();
  readonly storage: StoragePort;
  validator: ValidatorPort | null = null;
  /** Optional injection for the validator the tool runtime would call. */
  constructor(options: FakeToolOptions) {
    this.storage = options.storage;
  }

  setHandler(toolId: ToolId, handler: (args: JsonObject, ctx: ToolContext) => Promise<ToolResult>): this {
    this.handlers.set(toolId, handler);
    return this;
  }

  descriptors(): ToolDescriptor[] {
    return this.descriptorsValue;
  }

  modelTools(allowed: readonly ToolId[]): ToolDefinition[] {
    return this.descriptorsValue
      .filter((descriptor) => allowed.includes(descriptor.id))
      .map((descriptor) => ({
        name: descriptor.id,
        description: descriptor.description,
        parameters: descriptor.parameters,
        strict: false,
      }));
  }

  validateArguments(toolId: ToolId, rawJson: string): { ok: true; args: JsonObject } | { ok: false; error: string } {
    const schema = schemaFor(toolId);
    if (!schema) return { ok: false, error: `unknown tool ${toolId}` };
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJson);
    } catch (error) {
      return { ok: false, error: `arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') };
    }
    return { ok: true, args: parsed.data as JsonObject };
  }

  async execute(toolId: ToolId, rawArgumentsJson: string, ctx: ToolContext): Promise<ToolResult> {
    const validated = this.validateArguments(toolId, rawArgumentsJson);
    if (!validated.ok) {
      return {
        toolCallId: ctx.toolCallId,
        toolId,
        status: 'failed',
        resultObjectHash: null,
        resultBytes: 0,
        durationMs: 0,
        error: { code: 'invalid_arguments', message: validated.error, retryable: false },
        trust: 'untrusted_content',
      };
    }
    const args = validated.args;
    this.calls.push({ toolId, args });
    const handler = this.handlers.get(toolId);
    try {
      if (handler) return await handler(args, ctx);
      return await defaultExecute(this, toolId, args, ctx);
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        toolId,
        status: 'failed',
        resultObjectHash: null,
        resultBytes: 0,
        durationMs: 0,
        error: { code: 'tool_error', message: error instanceof Error ? error.message : String(error), retryable: false },
        trust: 'untrusted_content',
      };
    }
  }
}

function schemaFor(toolId: ToolId) {
  switch (toolId) {
    case 'source.list':
      return SourceListArgsSchema;
    case 'source.read':
      return SourceReadArgsSchema;
    case 'source.search':
      return SourceSearchArgsSchema;
    case 'data.profile':
      return DataProfileArgsSchema;
    case 'data.transform':
      return DataTransformArgsSchema;
    case 'artifact.read':
      return ArtifactReadArgsSchema;
    case 'artifact.propose_patch':
      return ArtifactProposePatchArgsSchema;
    case 'artifact.validate':
      return ArtifactValidateArgsSchema;
    default:
      return null;
  }
}

function success(ctx: ToolContext, toolId: ToolId, result: JsonValue, durationMs = 1): ToolResult {
  return {
    toolCallId: ctx.toolCallId,
    toolId,
    status: 'succeeded',
    result,
    resultObjectHash: contentHash(result),
    resultBytes: JSON.stringify(result).length,
    durationMs,
    error: null,
    trust: 'untrusted_content',
  };
}

async function defaultExecute(runtime: FakeToolRuntime, toolId: ToolId, args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
  switch (toolId) {
    case 'source.list': {
      const sources = await ctx.sources.listSources(ctx.taskId);
      const includeUnavailable = args.includeUnavailable === true;
      const items: SourceListItem[] = sources
        .filter((source) => includeUnavailable || source.availability === 'available')
        .map((source) => ({
          sourceId: source.id,
          name: source.name,
          mime: source.mime,
          version: source.version,
          sizeBytes: source.sizeBytes,
          availability: source.availability,
          origin: source.origin,
          trustLevel: source.trustLevel,
        }));
      return success(ctx, toolId, { items });
    }
    case 'source.read': {
      const sourceId = args.sourceId as never;
      const version = Number(args.version);
      const found = await ctx.sources.getSource(ctx.taskId, sourceId, version);
      if (!found) {
        return failure(ctx, toolId, 'source_not_found', '资料不存在或版本不可用');
      }
      const text = new TextDecoder().decode(found.bytes);
      const maxChars = Math.min(Number(args.maxChars ?? 8_000), 20_000);
      const locator = (args.locator as SourceReadResult['locator'] | undefined) ?? { kind: 'text_lines', startLine: 1, endLine: 1 };
      const result: SourceReadResult = {
        sourceId,
        version,
        locator,
        content: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        totalChars: text.length,
        trust: 'untrusted_content',
      };
      return success(ctx, toolId, result as unknown as JsonValue);
    }
    case 'source.search': {
      const query = String(args.query);
      const limit = Number(args.limit ?? 5);
      const contents = await ctx.sources.listLatestContents(ctx.taskId);
      const hits: SourceSearchResult['hits'] = [];
      for (const entry of contents) {
        const text = new TextDecoder().decode(entry.bytes);
        let offset = text.toLowerCase().indexOf(query.toLowerCase());
        while (offset >= 0 && hits.length < limit) {
          const line = text.slice(0, offset).split('\n').length;
          const excerpt = text.slice(Math.max(0, offset - 40), offset + query.length + 60);
          const locator = { kind: 'text_lines' as const, startLine: line, endLine: line };
          const quoteHash = sha256Hex(excerpt);
          const spanId = deterministicUuid(`${entry.source.id}|${entry.source.version}|${JSON.stringify(locator)}|${quoteHash}`);
          await ctx.sources.saveSpan({
            id: spanId as never,
            sourceId: entry.source.id,
            version: entry.source.version,
            locator,
            quoteHash,
            excerpt: excerpt.slice(0, 400),
            createdAt: ctx.now(),
          });
          hits.push({
            spanId: spanId as never,
            sourceId: entry.source.id,
            version: entry.source.version,
            locator,
            excerpt: excerpt.slice(0, 400),
            quoteHash,
            score: 1,
          });
          offset = text.toLowerCase().indexOf(query.toLowerCase(), offset + 1);
        }
      }
      return success(ctx, toolId, {
        query,
        hits,
        searchedSources: contents.map((entry) => entry.source.id),
      } as unknown as JsonValue);
    }
    case 'data.profile': {
      const sourceId = args.sourceId as never;
      const version = Number(args.version);
      const found = await ctx.sources.getSource(ctx.taskId, sourceId, version);
      if (!found) return failure(ctx, toolId, 'source_not_found', '资料不存在或版本不可用');
      const text = new TextDecoder().decode(found.bytes);
      const rows = parseCsv(text);
      const columns = (rows[0] ?? []).map((key, index) => ({
        key,
        inferredType: 'string' as const,
        missing: rows.slice(1).filter((row) => !row[index]).length,
        distinct: new Set(rows.slice(1).map((row) => row[index])).size,
        samples: rows.slice(1, 4).map((row) => String(row[index] ?? '')),
        issues: [],
      }));
      return success(ctx, toolId, {
        sourceId,
        version,
        format: 'csv',
        rowCount: Math.max(0, rows.length - 1),
        columnCount: columns.length,
        columns,
        duplicateRowCount: 0,
        missingRequiredCount: 0,
        issues: [],
      } as unknown as JsonValue);
    }
    case 'data.transform': {
      const sourceId = args.sourceId as never;
      const version = Number(args.version);
      const found = await ctx.sources.getSource(ctx.taskId, sourceId, version);
      if (!found) return failure(ctx, toolId, 'source_not_found', '资料不存在或版本不可用');
      const text = new TextDecoder().decode(found.bytes);
      const table = parseCsv(text);
      const operations = (args.operations ?? []) as TransformOperation[];
      const transformed = applyTransform(table, operations);
      const object = await ctx.objects.put(new TextEncoder().encode(JSON.stringify(transformed)), 'application/json');
      return success(ctx, toolId, {
        sourceId,
        version,
        format: 'csv',
        columns: (transformed[0] ?? []).map((key) => ({ key, label: key })),
        rowCount: Math.max(0, transformed.length - 1),
        preview: transformed.slice(0, 20).map((row) => Object.fromEntries((transformed[0] ?? []).map((key, index) => [key, row[index] ?? null]))),
        objectHash: object.hash,
        outputName: String(args.outputName ?? 'transformed.csv'),
        issues: [],
        deterministic: true,
      } as unknown as JsonValue);
    }
    case 'artifact.read': {
      const moduleId = args.moduleId as string;
      const versionId = (args.versionId as string | null) ?? null;
      const module = await ctx.artifacts.getModule(moduleId as never);
      if (!module) return failure(ctx, toolId, 'module_not_found', '模块不存在');
      const version = versionId ? await ctx.artifacts.getVersion(versionId) : await ctx.artifacts.getAcceptedVersion(moduleId as never);
      const content: ModuleContent = version?.content ?? { kind: 'markdown', sections: [] };
      return success(ctx, toolId, {
        moduleId,
        versionId: version?.id ?? null,
        content,
        contentHash: version?.contentHash ?? null,
        moduleKind: module.kind,
        dependencies: module.dependencies,
      } as unknown as JsonValue);
    }
    case 'artifact.propose_patch': {
      const moduleId = args.moduleId as string;
      const module = await ctx.artifacts.getModule(moduleId as never);
      if (!module) return failure(ctx, toolId, 'module_not_found', '模块不存在');
      const base = module.acceptedVersionId ? await ctx.artifacts.getVersion(module.acceptedVersionId) : null;
      const requestedBase = (args.baseVersionId as string | null) ?? null;
      if (base && requestedBase && base.id !== requestedBase) {
        return failure(ctx, toolId, 'version_conflict', '补丁基线不是当前已接受版本');
      }
      const candidate = applyPatchOperations(base?.content ?? null, module.kind, args.operations as never);
      const evidenceRefs = (args.evidenceRefs ?? []) as never[];
      const validation = ctx.validator
        ? await ctx.validator.validate({
            taskId: ctx.taskId,
            runId: ctx.runId,
            moduleId: module.id,
            candidate,
            evidenceRefs: evidenceRefs as never,
            baseVersion: base,
          })
        : null;
      const proposal = await ctx.artifacts.saveProposal({
        taskId: ctx.taskId,
        runId: ctx.runId,
        moduleId: module.id,
        baseVersionId: base?.id ?? null,
        operations: args.operations as never,
        evidenceRefs: evidenceRefs as never,
        description: String(args.description ?? ''),
        candidate,
        validation: validation as never,
      });
      return success(
        ctx,
        toolId,
        {
          patch: proposal.patch,
          validation: validation as never,
        } as unknown as JsonValue,
        2,
      );
    }
    case 'artifact.validate': {
      const moduleId = args.moduleId as string;
      const module = await ctx.artifacts.getModule(moduleId as never);
      if (!module) return failure(ctx, toolId, 'module_not_found', '模块不存在');
      if (!ctx.validator) return failure(ctx, toolId, 'validator_missing', '校验器不可用');
      const base = module.acceptedVersionId ? await ctx.artifacts.getVersion(module.acceptedVersionId) : null;
      const validation = await ctx.validator.validate({
        taskId: ctx.taskId,
        runId: ctx.runId,
        moduleId: module.id,
        candidate: args.candidate as ModuleContent,
        evidenceRefs: (args.evidenceRefs ?? []) as never,
        baseVersion: base,
      });
      await ctx.artifacts.saveValidationReport(validation);
      return success(ctx, toolId, { validation, status: validation.status, reportId: validation.id } as unknown as JsonValue);
    }
    default:
      void runtime;
      return failure(ctx, toolId, 'tool_unknown', `工具未实现：${toolId}`);
  }
}

function failure(ctx: ToolContext, toolId: ToolId, code: string, message: string): ToolResult {
  return {
    toolCallId: ctx.toolCallId,
    toolId,
    status: 'failed',
    resultObjectHash: null,
    resultBytes: 0,
    durationMs: 0,
    error: { code, message, retryable: false },
    trust: 'untrusted_content',
  };
}

/* -------------------------------- helpers -------------------------------- */

export function deterministicUuid(seed: string): string {
  const hash = sha256Hex(seed);
  const variant = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function applyTransform(table: string[][], operations: readonly TransformOperation[]): string[][] {
  let header = [...(table[0] ?? [])];
  let rows = table.slice(1).map((row) => [...row]);
  const asObjects = (): Array<Record<string, string>> => rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ''])));
  let objects = asObjects();
  for (const operation of operations) {
    switch (operation.op) {
      case 'select':
        objects = objects.map((row) => Object.fromEntries(operation.columns.map((column) => [column, row[column] ?? ''])));
        header = [...operation.columns];
        break;
      case 'rename': {
        objects = objects.map((row) => {
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(row)) next[operation.mapping[key] ?? key] = value;
          return next;
        });
        header = header.map((key) => operation.mapping[key] ?? key);
        break;
      }
      case 'filter':
        objects = objects.filter((row) => {
          const value = row[operation.column] ?? '';
          switch (operation.operator) {
            case 'eq':
              return value === String(operation.value ?? '');
            case 'neq':
              return value !== String(operation.value ?? '');
            case 'contains':
              return value.includes(String(operation.value ?? ''));
            case 'not_empty':
              return value.trim().length > 0;
            case 'in':
              return Array.isArray(operation.value) && operation.value.map(String).includes(value);
            case 'not_in':
              return !(Array.isArray(operation.value) && operation.value.map(String).includes(value));
            case 'gt':
              return Number(value) > Number(operation.value);
            case 'lt':
              return Number(value) < Number(operation.value);
            case 'matches':
              try {
                return new RegExp(String(operation.value ?? '')).test(value);
              } catch {
                return false;
              }
          }
          return true;
        });
        break;
      case 'dedupe': {
        const seen = new Set<string>();
        objects = objects.filter((row) => {
          const key = operation.keys.map((column) => row[column] ?? '').join('\u0001');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        break;
      }
      case 'sort':
        objects = [...objects].sort((a, b) => {
          const left = a[operation.column] ?? '';
          const right = b[operation.column] ?? '';
          const compare = operation.numeric ? Number(left) - Number(right) : left.localeCompare(right);
          return operation.direction === 'desc' ? -compare : compare;
        });
        break;
      case 'limit':
        objects = objects.slice(0, operation.count);
        break;
      case 'normalize':
        objects = objects.map((row) => ({ ...row, [operation.column]: normalize(String(row[operation.column] ?? ''), operation.transforms) }));
        break;
      case 'cast':
        objects = objects.map((row) => ({ ...row, [operation.column]: String(row[operation.column] ?? '') }));
        break;
      case 'fill':
        objects = objects.map((row) => ({
          ...row,
          [operation.column]: row[operation.column]?.trim() ? row[operation.column] : String(operation.value ?? ''),
        }));
        break;
      case 'map':
        objects = objects.map((row) => ({
          ...row,
          [operation.column]: operation.mapping[row[operation.column] ?? ''] ?? operation.fallback ?? (row[operation.column] ?? ''),
        }));
        break;
      case 'require':
        objects = objects.filter((row) => operation.columns.every((column) => (row[column] ?? '').trim().length > 0));
        break;
    }
  }
  return [header, ...objects.map((row) => header.map((key) => row[key] ?? ''))];
}

function normalize(value: string, transforms: readonly string[]): string {
  let result = value;
  for (const transform of transforms) {
    switch (transform) {
      case 'trim':
        result = result.trim();
        break;
      case 'lower':
        result = result.toLowerCase();
        break;
      case 'upper':
        result = result.toUpperCase();
        break;
      case 'collapse_space':
        result = result.replace(/\s+/g, ' ');
        break;
      case 'strip_quotes':
        result = result.replace(/^["']|["']$/g, '');
        break;
    }
  }
  return result;
}

export { TOOL_IDS };
export type { ArtifactAccessPort, SourceReaderPort, ToolCallId, ToolScope };