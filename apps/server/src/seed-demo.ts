import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  newArtifactId,
  newModuleId,
  newTaskId,
  utcNow,
  type Artifact,
  type ArtifactModule,
  type Constraint,
  type Task,
  type TaskTemplate,
} from '@ca/contracts';
import type { StoragePort } from '@ca/storage';
import type { ServerConfig } from './config';
import type { LogFn } from './runtime-manager';

export interface SeedDeps {
  storage: StoragePort;
  config: ServerConfig;
  log: LogFn;
}

/**
 * Demo namespace seeding (design 3.3 / 17): reproducible synthetic task with the
 * built-in four modules and the scenario sources. Demo never calls a real model.
 */
export async function ensureDemoSeeded(deps: SeedDeps): Promise<void> {
  const workspace = await deps.storage.getWorkspace();
  const existing = await deps.storage.listTasks();
  if (existing.length > 0 && !deps.config.demoResetOnBoot) return;
  if (existing.length > 0 && deps.config.demoResetOnBoot) await deps.storage.resetDemoData();
  void workspace;

  const scenarioDir = path.join(deps.config.repoRoot, 'scenarios', 'cognitive-atrium');
  const templateRaw = await readFile(path.join(scenarioDir, 'template.json'), 'utf8');
  const template = JSON.parse(templateRaw) as TaskTemplate;
  const now = utcNow();
  const taskId = newTaskId();
  const artifactId = newArtifactId();
  const keyToModule = new Map<string, ArtifactModule>();
  const modules: ArtifactModule[] = template.modules.map((moduleTemplate, index) => {
    const module: ArtifactModule = {
      id: newModuleId(),
      artifactId,
      title: moduleTemplate.title,
      kind: moduleTemplate.kind,
      order: index,
      dependencies: [],
      acceptanceCriteria: moduleTemplate.acceptanceCriteria.map((criterion, criterionIndex) => ({
        id: `${moduleTemplate.key}-ac-${criterionIndex + 1}`,
        text: criterion.text,
        layer: criterion.layer,
        validatorId: null,
      })),
      status: 'empty',
      blockedFrom: null,
      acceptedVersionId: null,
      createdAt: now,
      updatedAt: now,
    };
    keyToModule.set(moduleTemplate.key, module);
    return module;
  });
  for (const moduleTemplate of template.modules) {
    const module = keyToModule.get(moduleTemplate.key)!;
    module.dependencies = moduleTemplate.dependsOnKeys
      .map((key) => keyToModule.get(key)?.id)
      .filter((id): id is NonNullable<typeof id> => Boolean(id));
  }

  const constraints: Constraint[] = [
    {
      id: 'DEPLOY-1',
      text: '首版必须支持完全离线私有化部署：业务数据与模型推理都不离开客户内网。',
      kind: 'hard',
      status: 'open',
      sourceRefs: [],
      note: '来自 product-brief.md 第 4 节（部署范围）',
    },
    {
      id: 'AI-1',
      text: '核心交互必须依赖云端实时大模型服务完成流式生成与工具调用。',
      kind: 'hard',
      status: 'open',
      sourceRefs: [],
      note: '来自 product-brief.md 第 3 节；与 DEPLOY-1 存在冲突',
    },
    {
      id: 'FORMAT-1',
      text: '交付物必须同时可导出为 Markdown 与 JSON；表格类模块可导出 CSV。',
      kind: 'hard',
      status: 'confirmed',
      sourceRefs: [],
      note: '',
    },
  ];

  const task: Task = {
    id: taskId,
    workspaceId: workspace.id,
    title: '次世代智能工作空间产品架构与 GTM 策略中枢',
    intent:
      '基于合成资料完成四模块交付物：核心架构拓扑、多模态交互引擎规范、存量系统兼容层清洗、商业化价值壁垒矩阵。资料为演示用途，所有商业结论标记为待验证假设。',
    constraints,
    artifactId,
    revision: 0,
    templateId: template.id,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  const artifact: Artifact = {
    id: artifactId,
    taskId,
    title: '次世代智能工作空间：交付物清单',
    moduleIds: modules.map((m) => m.id),
    acceptedVersionId: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  await deps.storage.insertTaskBundle({ task, artifact, modules });

  // Import the scenario sources as demo data (explicit synthetic trust level).
  const sourceFiles: Array<{ name: string; mime: string }> = [
    { name: 'product-brief.md', mime: 'text/markdown' },
    { name: 'constraints.json', mime: 'application/json' },
    { name: 'legacy-systems.csv', mime: 'text/csv' },
    { name: 'field-mapping.json', mime: 'application/json' },
    { name: 'stakeholder-notes.md', mime: 'text/markdown' },
    { name: 'legacy-systems-new.csv', mime: 'text/csv' },
    { name: 'legacy-systems-invalid.csv', mime: 'text/csv' },
  ];
  const { createHash } = await import('node:crypto');
  const { newSourceId } = await import('@ca/contracts');
  const seededSources: Array<import('@ca/contracts').SourceItem> = [];
  for (const file of sourceFiles) {
    try {
      const bytes = await readFile(path.join(scenarioDir, file.name));
      const hash = createHash('sha256').update(bytes).digest('hex');
      const sourceItem: import('@ca/contracts').SourceItem = {
        id: newSourceId(),
        taskId,
        name: file.name,
        mime: file.mime,
        version: 1,
        sizeBytes: bytes.length,
        hash,
        origin: 'demo_seed',
        trustLevel: 'synthetic_demo',
        availability: 'available',
        parseStatus: 'parsed',
        parseNote: '',
        createdAt: now,
      };
      await deps.storage.insertSource(sourceItem, bytes);
      seededSources.push(sourceItem);
    } catch (error) {
      deps.log('demo source seed failed', { name: file.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Fixed Demo event fixtures: accepted module, pending review patch, blocked plan
  // preview, earlier failed attempt and a validated deterministic recipe.
  try {
    const legacyCsvText = await readFile(path.join(scenarioDir, 'legacy-systems.csv'), 'utf8');
    const { seedDemoHistory } = await import('./demo-fixtures');
    await seedDemoHistory({
      storage: deps.storage,
      task,
      artifact,
      modules,
      sources: seededSources,
      legacyCsvText,
      log: deps.log,
    });
  } catch (error) {
    deps.log('demo fixture history seed failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  deps.log('demo task seeded', { taskId });
}
