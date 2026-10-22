import { createHash } from 'node:crypto';
import {
  canonicalJson,
  newArtifactId,
  newArtifactVersionId,
  newModuleId,
  newRecipeId,
  newTaskId,
  utcNow,
  type ArtifactModule,
  type EngineMode,
  type ExportFormat,
  type ModuleId,
  type Recipe,
  type TaskId,
} from '@ca/contracts';
import type { StoragePort } from '@ca/storage';
import { fail } from './errors';
import { readZip, writeZip, type ZipEntry, type ZipEntryInput } from './zip';

const PACKAGE_SCHEMA_VERSION = '1';
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_UNZIPPED = 512 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export interface ExportDeps {
  storage: StoragePort;
  appVersion: string;
}

export interface ExportResult {
  fileName: string;
  mime: string;
  contentBase64: string;
  sha256: string;
  bytes: number;
  redacted: boolean;
  warnings: string[];
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function finish(fileName: string, mime: string, body: string | Uint8Array, warnings: string[], redacted = false): ExportResult {
  const bytes = typeof body === 'string' ? textBytes(body) : body;
  return {
    fileName,
    mime,
    contentBase64: Buffer.from(bytes).toString('base64'),
    sha256: sha256Bytes(bytes),
    bytes: bytes.length,
    redacted,
    warnings,
  };
}

/** Export artifacts or a full task package. Never includes credentials/provider secrets. */
export async function exportTask(
  deps: ExportDeps,
  taskId: TaskId,
  format: ExportFormat,
  moduleIds: readonly ModuleId[],
  includeSources: boolean,
): Promise<ExportResult> {
  const aggregate = await deps.storage.getTaskAggregate(taskId);
  if (!aggregate) throw fail.notFound('任务');
  const { task, artifact, modules } = aggregate;
  const selected = moduleIds.length ? modules.filter((m) => moduleIds.includes(m.id)) : modules;
  if (selected.length === 0) throw fail.validationFailed('没有可导出的模块');
  const warnings: string[] = [];

  const accepted: Array<{
    module: ArtifactModule;
    content: unknown;
    versionId: string | null;
    contentHash: string | null;
  }> = [];
  for (const module of selected) {
    const version = module.acceptedVersionId ? await deps.storage.getVersion(module.acceptedVersionId) : null;
    if (!version) warnings.push(`模块「${module.title}」尚无已接受版本`);
    accepted.push({ module, content: version?.content ?? null, versionId: version?.id ?? null, contentHash: version?.contentHash ?? null });
  }

  if (format === 'markdown') {
    return finish(`${safeName(artifact.title)}.md`, 'text/markdown; charset=utf-8', renderMarkdown(artifact.title, task.intent, accepted, deps.appVersion), warnings);
  }
  if (format === 'json') {
    return finish(`${safeName(artifact.title)}.json`, 'application/json; charset=utf-8', renderJson(artifact.title, task.title, task.intent, accepted, deps.appVersion), warnings);
  }
  if (format === 'csv') {
    const csvModules = accepted.filter((a) => a.module.kind === 'csv' && a.content && (a.content as { kind: string }).kind === 'csv');
    if (csvModules.length === 0) throw fail.validationFailed('所选模块中没有 CSV 成果，无法导出 CSV');
    if (csvModules.length > 1) warnings.push('存在多个 CSV 模块，仅导出第一个；如需全部请选择 task_package');
    const content = csvModules[0]!.content as {
      columns: Array<{ key: string; label: string; type: string }>;
      rows: Array<Record<string, string | number | boolean | null>>;
    };
    return finish(`${safeName(csvModules[0]!.module.title)}.csv`, 'text/csv; charset=utf-8', serializeCsv(content), warnings);
  }

  const packageBytes = await buildTaskPackage(deps, taskId, includeSources, warnings);
  if (packageBytes.length > MAX_PACKAGE_BYTES) throw fail.payloadTooLarge('导出包超过 128MiB 限制');
  return finish(`${safeName(artifact.title)}.ca-task.zip`, 'application/zip', packageBytes, warnings, true);
}

/* ------------------------------- rendering ------------------------------- */

function renderMarkdown(
  title: string,
  intent: string,
  accepted: Array<{ module: ArtifactModule; content: unknown; versionId: string | null; contentHash: string | null }>,
  appVersion: string,
): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `> 导出时间：${utcNow()} · Cognitive Atrium v${appVersion}`,
    '> 仅包含中心交付物的已接受版本；未接受草稿不在其中。',
    '',
    '## 任务意图',
    '',
    intent,
    '',
  ];
  for (const item of accepted) {
    lines.push(`## ${item.module.title}`, '');
    lines.push(`状态：${item.module.status} · 版本：${item.versionId ?? '无'} · 内容哈希：${item.contentHash ?? '无'}`, '');
    const content = item.content as { kind: string } | null;
    if (!content) {
      lines.push('_尚无已接受内容_', '');
      continue;
    }
    if (content.kind === 'markdown') {
      for (const section of (content as unknown as { sections: Array<{ title: string; markdown: string }> }).sections) {
        lines.push(`### ${section.title}`, '', section.markdown, '');
      }
    } else if (content.kind === 'json') {
      lines.push('```json', JSON.stringify((content as unknown as { value: unknown }).value, null, 2), '```', '');
    } else if (content.kind === 'csv') {
      lines.push(serializeCsv(content as never).trimEnd(), '');
    }
  }
  return lines.join('\n');
}

function renderJson(
  artifactTitle: string,
  taskTitle: string,
  intent: string,
  accepted: Array<{ module: ArtifactModule; content: unknown; versionId: string | null; contentHash: string | null }>,
  appVersion: string,
): string {
  return JSON.stringify(
    {
      schemaVersion: PACKAGE_SCHEMA_VERSION,
      exportedAt: utcNow(),
      appVersion,
      artifact: {
        title: artifactTitle,
        modules: accepted.map((a) => ({
          moduleId: a.module.id,
          title: a.module.title,
          kind: a.module.kind,
          status: a.module.status,
          order: a.module.order,
          acceptedVersionId: a.versionId,
          contentHash: a.contentHash,
          content: a.content,
        })),
      },
      task: { title: taskTitle, intent },
    },
    null,
    2,
  );
}

function serializeCsv(content: { columns: Array<{ key: string }>; rows: Array<Record<string, string | number | boolean | null>> }): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = content.columns.map((c) => escape(c.key)).join(',');
  const rows = content.rows.map((row) => content.columns.map((c) => escape(row[c.key])).join(','));
  return `${[header, ...rows].join('\n')}\n`;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'cognitive-atrium';
}

/* ------------------------------ task package ------------------------------ */

async function buildTaskPackage(
  deps: ExportDeps,
  taskId: TaskId,
  includeSources: boolean,
  warnings: string[],
): Promise<Uint8Array> {
  const aggregate = await deps.storage.getTaskAggregate(taskId);
  if (!aggregate) throw fail.notFound('任务');
  const { task, artifact, modules } = aggregate;
  const entries: ZipEntryInput[] = [];
  const moduleManifests: unknown[] = [];
  for (const module of modules) {
    const version = module.acceptedVersionId ? await deps.storage.getVersion(module.acceptedVersionId) : null;
    const moduleManifest: Record<string, unknown> = {
      moduleId: module.id,
      title: module.title,
      kind: module.kind,
      status: module.status,
      acceptedVersionId: version?.id ?? null,
      contentHash: version?.contentHash ?? null,
    };
    if (version) {
      const file = `artifacts/${module.id}.json`;
      entries.push({ name: file, data: textBytes(JSON.stringify(version.content, null, 2)) });
      moduleManifest.file = file;
      moduleManifest.version = {
        id: version.id,
        contentHash: version.contentHash,
        acceptedAt: version.acceptedAt,
        acceptedBy: version.acceptedBy,
      };
    }
    moduleManifests.push(moduleManifest);
  }
  const sources = await deps.storage.listSources(taskId);
  const sourceManifests: unknown[] = [];
  if (includeSources) {
    for (const source of sources) {
      const found = await deps.storage.getSource(taskId, source.id, source.version);
      if (!found) continue;
      const file = `sources/${source.id}.v${source.version}.bin`;
      entries.push({ name: file, data: found.content });
      sourceManifests.push({ sourceId: source.id, name: source.name, mime: source.mime, version: source.version, hash: source.hash, file });
    }
  } else {
    for (const source of sources) {
      sourceManifests.push({ sourceId: source.id, name: source.name, mime: source.mime, version: source.version, hash: source.hash, included: false });
    }
    if (sources.length) warnings.push('任务包默认不包含原始资料；导入后保留引用信息并提示重新绑定');
  }
  const recipes = await deps.storage.listRecipes(taskId);
  const events = await deps.storage.eventsAfter(taskId, 0, 50_000);
  const manifest = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    packageKind: 'cognitive-atrium-task-package',
    exportedAt: utcNow(),
    appVersion: deps.appVersion,
    includesSources: includeSources,
    redaction: {
      excluded: ['credentials', 'provider secrets', 'model internal continuation data', 'unaccepted drafts'],
      note: '事件已脱敏：模型增量文本与工具原文不导出。',
    },
    task: { title: task.title, intent: task.intent, constraints: task.constraints, createdAt: task.createdAt },
    artifact: { title: artifact.title, status: artifact.status },
    modules: moduleManifests,
    sources: sourceManifests,
    recipes: recipes.map((recipe) => ({ ...recipe, status: 'disabled' as const })),
    validationReports: await deps.storage.listValidationReports(taskId),
    decisions: await deps.storage.listDecisions(taskId),
    events: events.map(redactEvent),
  };
  entries.unshift({ name: 'manifest.json', data: textBytes(JSON.stringify(manifest, null, 2)) });
  return writeZip(entries);
}

function redactEvent(event: import('@ca/contracts').HarnessEvent): Record<string, unknown> {
  const base = {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    taskId: event.taskId,
    runId: event.runId,
    stepId: event.stepId,
    seq: event.seq,
    type: event.type,
    category: event.category,
    timestamp: event.timestamp,
  };
  if (event.type === 'model.delta_batch') {
    return { ...base, payload: { modelCallId: (event.payload as { modelCallId: string }).modelCallId, redacted: true } };
  }
  return { ...base, payload: event.payload };
}

/* --------------------------------- import --------------------------------- */

interface PackageManifest {
  schemaVersion: string;
  packageKind: string;
  task: { title: string; intent: string; constraints: unknown[] };
  artifact: { title: string };
  modules: Array<{
    title: string;
    kind: 'markdown' | 'json' | 'csv';
    status: string;
    file?: string;
    contentHash?: string | null;
    version?: { id: string; contentHash: string; acceptedAt: string; acceptedBy: string };
  }>;
  sources: Array<{ name: string; mime: string; version: number; hash: string; included?: boolean; file?: string }>;
  recipes: Recipe[];
}

export interface ImportResult {
  taskId: TaskId;
  warnings: string[];
  sourcesNeedRebinding: boolean;
}

/** Import a task package as new records; never activates recipes or external writes. */
export async function importTaskPackage(deps: ExportDeps, bytes: Uint8Array): Promise<ImportResult> {
  if (bytes.length > MAX_PACKAGE_BYTES) throw fail.payloadTooLarge('导入包超过 128MiB 限制');
  let entries: ZipEntry[];
  try {
    entries = readZip(bytes, { maxEntries: MAX_ENTRIES, maxTotalBytes: MAX_UNZIPPED });
  } catch (error) {
    throw fail.importInvalid(`任务包解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) throw fail.importInvalid('任务包缺少 manifest.json');
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestEntry.data)) as PackageManifest;
  } catch {
    throw fail.importInvalid('任务包 manifest.json 无法解析');
  }
  if (manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) throw fail.importInvalid(`不支持的任务包 schemaVersion：${manifest.schemaVersion}`);
  if (manifest.packageKind !== 'cognitive-atrium-task-package') throw fail.importInvalid('任务包类型不匹配');
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) throw fail.importInvalid('任务包没有模块');
  if (manifest.modules.length > 8) throw fail.importInvalid('任务包模块数量超过上限');

  const warnings: string[] = [];
  const now = utcNow();
  const workspace = await deps.storage.getWorkspace();
  const taskId = newTaskId();
  const artifactId = newArtifactId();
  const moduleRows: ArtifactModule[] = manifest.modules.map((module, index) => ({
    id: newModuleId(),
    artifactId,
    title: module.title.slice(0, 200),
    kind: module.kind,
    order: index,
    dependencies: [],
    acceptanceCriteria: [],
    status: 'stale',
    blockedFrom: null,
    acceptedVersionId: null,
    createdAt: now,
    updatedAt: now,
  }));
  const sourcesNeedRebinding = manifest.sources.some((source) => !source.included || !source.file);
  if (sourcesNeedRebinding) {
    warnings.push('导入包未包含全部原始资料；已接受成果标记为过期，重新绑定来源并重新验证后才能消除过期标记。');
  }

  await deps.storage.insertTaskBundle({
    task: {
      id: taskId,
      workspaceId: workspace.id,
      title: manifest.task.title.slice(0, 200) || '导入任务',
      intent: manifest.task.intent.slice(0, 8000),
      constraints: (manifest.task.constraints as never[]) ?? [],
      artifactId,
      revision: 0,
      templateId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    artifact: {
      id: artifactId,
      taskId,
      title: manifest.artifact.title.slice(0, 200) || '导入成果',
      moduleIds: moduleRows.map((m) => m.id),
      acceptedVersionId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    modules: moduleRows,
  });

  const updatedRows: ArtifactModule[] = [];
  for (let i = 0; i < manifest.modules.length; i += 1) {
    const module = manifest.modules[i]!;
    const row = moduleRows[i]!;
    if (!module.file) {
      warnings.push(`模块「${module.title}」无已接受内容文件，保持为空并标记过期`);
      updatedRows.push(row);
      continue;
    }
    const fileEntry = byName.get(module.file);
    if (!fileEntry) throw fail.importInvalid(`任务包缺少模块文件：${module.file}`);
    let content: unknown;
    try {
      content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fileEntry.data));
    } catch {
      throw fail.importInvalid(`模块内容不是合法 JSON：${module.file}`);
    }
    if (!content || typeof content !== 'object' || (content as { kind?: string }).kind !== module.kind) {
      throw fail.importInvalid(`模块内容类型与声明不一致：${module.file}`);
    }
    const contentHash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const versionId = newArtifactVersionId();
    await deps.storage.insertVersion({
      id: versionId,
      artifactId,
      moduleId: row.id,
      moduleKind: module.kind,
      contentHash,
      content: content as never,
      parentId: null,
      baseVersionId: null,
      sourceRunId: null,
      patchId: null,
      validationReportId: null,
      acceptedBy: 'imported',
      acceptedAt: now,
      note: '从任务包导入',
      restoredFromVersionId: null,
    });
    updatedRows.push({ ...row, acceptedVersionId: versionId, status: 'stale', updatedAt: now });
  }
  await deps.storage.updateModules(updatedRows);

  for (const recipe of manifest.recipes ?? []) {
    try {
      await deps.storage.insertRecipe({
        ...recipe,
        id: newRecipeId(),
        status: 'disabled',
        sourceTaskId: taskId,
        updatedAt: now,
      });
      warnings.push(`配方「${recipe.name}」以禁用状态导入，需重新验证后才能运行`);
    } catch (error) {
      warnings.push(`配方「${recipe.name}」导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { taskId, warnings, sourcesNeedRebinding };
}
