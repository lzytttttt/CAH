/**
 * DOM-free render smoke test (react-dom/server, no jsdom).
 *
 * This does not replace E2E interaction tests, but it proves that the main
 * screens and every demand-driven panel render against a contract-valid fixture
 * snapshot without runtime errors (undefined props, broken hooks, bad imports).
 * Effects (network reads) do not run during server rendering, which is fine:
 * the loading states are part of what we render.
 *
 * Note: Zustand v5 serves `getInitialState()` to `useSyncExternalStore` during
 * server rendering, so the panel host's ViewState selection is not visible in
 * SSR; panels are rendered directly here instead.
 */
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createFixtureClient } from '../src/api/fixture/client';
import { IDS } from '../src/api/fixture/data';
import { TaskListScreen } from '../src/components/tasks/TaskListScreen';
import { SettingsScreen } from '../src/components/settings/SettingsScreen';
import { ConstraintsPanel } from '../src/components/panels/ConstraintsPanel';
import { EventsPanel } from '../src/components/panels/EventsPanel';
import { ExportPanel } from '../src/components/panels/ExportPanel';
import { PatchReviewPanel } from '../src/components/panels/PatchReviewPanel';
import { PlanPreviewPanel } from '../src/components/panels/PlanPreviewPanel';
import { RecipePanel } from '../src/components/panels/RecipePanel';
import { RepairPanel } from '../src/components/panels/RepairPanel';
import { SourcesPanel } from '../src/components/panels/SourcesPanel';
import { VersionsPanel } from '../src/components/panels/VersionsPanel';
import { WorkspaceScreen } from '../src/screens/WorkspaceScreen';
import { createCore } from '../src/state/coreStore';
import { CoreContext } from '../src/state/hooks';

const noop = (): void => undefined;

function renderWithCore(core: ReturnType<typeof createCore>, element: ReactElement): string {
  return renderToString(createElement(CoreContext.Provider, { value: core }, element));
}

async function loadedCore(scenario: 'review' | 'empty' = 'review'): Promise<ReturnType<typeof createCore>> {
  const client = createFixtureClient({ scenario });
  const core = createCore(client, { pollIntervalMs: 100_000 });
  await core.boot();
  await core.openTask(IDS.task);
  return core;
}

describe('react-dom/server render smoke (fixture-backed, no DOM)', () => {
  it('renders the workspace (five regions + run controls) without runtime errors', async () => {
    const core = await loadedCore('review');
    const html = renderWithCore(
      core,
      createElement(WorkspaceScreen, { taskId: IDS.task, isFixture: true, onHome: noop, onSettings: noop }),
    );
    expect(html).toContain('工作台状态栏');
    expect(html).toContain('中心交付区');
    expect(html).toContain('执行支线');
    expect(html).toContain('证据区');
    expect(html).toContain('综合成果');
    expect(html).toContain('意图胶囊');
    expect(html).toContain('运行控制栏');
    expect(html).toContain('本地夹具（非真实执行）');
    core.dispose();
  });

  it('renders the task list and settings screens from server state', async () => {
    const core = await loadedCore('review');
    const taskList = renderWithCore(core, createElement(TaskListScreen));
    expect(taskList).toContain('任务空间');
    expect(taskList).toContain('新建任务');
    const settings = renderWithCore(core, createElement(SettingsScreen));
    expect(settings).toContain('连接与工作区设置');
    expect(settings).toContain('工作区策略');
    core.dispose();
  });

  it('renders every demand-driven panel without runtime errors', async () => {
    const core = await loadedCore('review');
    const snapshot = core.getState().snapshot!;
    const panels: Array<{ name: string; element: ReactElement; expected: string }> = [
      {
        name: 'plan',
        element: createElement(PlanPreviewPanel, {
          snapshot,
          onOpenConstraints: noop,
          onOpenSources: noop,
          onFocusModule: noop,
          onClose: noop,
          onOpenEvents: noop,
        }),
        expected: '提交计划',
      },
      {
        name: 'repair',
        element: createElement(RepairPanel, {
          snapshot,
          initialBlockerId: null,
          onOpenSettings: noop,
          onOpenEvents: noop,
          onOpenSources: noop,
          onFocusModule: noop,
          onClose: noop,
        }),
        expected: '每批最多 3 张修复卡',
      },
      {
        name: 'review',
        element: createElement(PatchReviewPanel, {
          snapshot: { ...snapshot, patches: [] },
          initialPatchId: null,
          onClose: noop,
          onOpenVersions: noop,
          onOpenRepair: noop,
        }),
        expected: '没有待接受的变更',
      },
      {
        name: 'versions',
        element: createElement(VersionsPanel, { snapshot, initialModuleId: IDS.modules.interaction as never, onClose: noop, onOpenEvents: noop }),
        expected: '选择模块',
      },
      { name: 'sources', element: createElement(SourcesPanel, { snapshot, onClose: noop, onOpenVersions: noop }), expected: '导入资料' },
      {
        name: 'recipes',
        element: createElement(RecipePanel, { snapshot, initialRecipeId: null, onClose: noop, onOpenEvents: noop }),
        expected: '折叠表示',
      },
      {
        name: 'events',
        element: createElement(EventsPanel, { snapshot, initialRunId: null, onClose: noop }),
        expected: '历史回放',
      },
      { name: 'constraints', element: createElement(ConstraintsPanel, { snapshot, onClose: noop }), expected: '任务目标' },
      { name: 'export', element: createElement(ExportPanel, { snapshot, onClose: noop }), expected: '导出成果' },
    ];
    for (const panel of panels) {
      const html = renderWithCore(core, panel.element);
      expect(html.length, `panel ${panel.name} should render`).toBeGreaterThan(200);
      expect(html, `panel ${panel.name} content`).toContain(panel.expected);
    }
    core.dispose();
  });

  it('renders the empty fixture without inventing runs, risks or patches', async () => {
    const core = await loadedCore('empty');
    const html = renderWithCore(
      core,
      createElement(WorkspaceScreen, { taskId: IDS.task, isFixture: true, onHome: noop, onSettings: noop }),
    );
    expect(html).toContain('空任务');
    expect(html).toContain('无活动运行');
    expect(html).toContain('尚未登记约束');
    expect(html).not.toContain('阻止提交的风险');
    expect(html).not.toContain('待接受变更（1）');
    core.dispose();
  });
});
