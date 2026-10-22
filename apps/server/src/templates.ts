import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskTemplateSchema, type TaskTemplate } from '@ca/contracts';
import { fail } from './errors';

export const BUILT_IN_TEMPLATE_ID = 'cognitive-atrium';

export interface TemplateCatalog {
  builtIn: TaskTemplate;
  scenarioDir: string;
  scenarioSources: Array<{ name: string; mime: string }>;
}

const SCENARIO_SOURCES: Array<{ name: string; mime: string }> = [
  { name: 'product-brief.md', mime: 'text/markdown' },
  { name: 'constraints.json', mime: 'application/json' },
  { name: 'legacy-systems.csv', mime: 'text/csv' },
  { name: 'field-mapping.json', mime: 'application/json' },
  { name: 'stakeholder-notes.md', mime: 'text/markdown' },
  { name: 'legacy-systems-new.csv', mime: 'text/csv' },
  { name: 'legacy-systems-invalid.csv', mime: 'text/csv' },
];

/** Load the built-in scenario template once at boot; it is data, not code. */
export async function loadTemplateCatalog(repoRoot: string): Promise<TemplateCatalog> {
  const scenarioDir = path.join(repoRoot, 'scenarios', 'cognitive-atrium');
  try {
    const raw = JSON.parse(await readFile(path.join(scenarioDir, 'template.json'), 'utf8'));
    const parsed = TaskTemplateSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
    return { builtIn: parsed.data, scenarioDir, scenarioSources: SCENARIO_SOURCES };
  } catch (error) {
    throw fail.internal(`内置场景模板加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function findBuiltInTemplate(catalog: TemplateCatalog, templateId: string): TaskTemplate {
  if (templateId !== catalog.builtIn.id) {
    throw fail.validationFailed(
      `未知模板 ${templateId}；当前内置模板为 ${catalog.builtIn.id}。也可以直接提交自定义 modules。`,
    );
  }
  return catalog.builtIn;
}
