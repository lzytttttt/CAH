/** Overlay panel host: one demand-driven panel at a time (no permanent admin columns). */
import type { TaskSnapshot } from '@ca/contracts';
import { panelTitle } from '../../lib/labels';
import { useNavigate, useViewStore } from '../../state/hooks';
import { OverlayPanel } from '../common/ui';
import { PlanPreviewPanel } from './PlanPreviewPanel';
import { RepairPanel } from './RepairPanel';
import { PatchReviewPanel } from './PatchReviewPanel';
import { VersionsPanel } from './VersionsPanel';
import { SourcesPanel } from './SourcesPanel';
import { RecipePanel } from './RecipePanel';
import { EventsPanel } from './EventsPanel';
import { ConstraintsPanel } from './ConstraintsPanel';
import { ExportPanel } from './ExportPanel';

export interface PanelHostProps {
  snapshot: TaskSnapshot;
  reducedMotion: boolean;
  onOpenEvidenceTab: (tab: 'sources' | 'spans' | 'tools' | 'validation') => void;
}

export function PanelHost({ snapshot, reducedMotion, onOpenEvidenceTab }: PanelHostProps): JSX.Element | null {
  const navigate = useNavigate();
  const panel = useViewStore((view) => view.panel);
  const panelContext = useViewStore((view) => view.panelContext);
  const closePanel = useViewStore((view) => view.closePanel);
  const exitFocus = useViewStore((view) => view.exitFocus);
  const openPanel = useViewStore((view) => view.openPanel);
  const selectModule = useViewStore((view) => view.selectModule);

  if (!panel) return null;

  const onClose = (): void => closePanel();
  const onOpenSettings = (): void => {
    closePanel();
    navigate({ name: 'settings' });
  };
  const onOpenEvents = (): void => openPanel('events', { runId: snapshot.activeRun?.runId });
  const onOpenSources = (): void => openPanel('sources');
  const onOpenVersions = (moduleId: string): void => openPanel('versions', { moduleId });
  const onOpenConstraints = (): void => openPanel('constraints');
  const onOpenRepair = (): void => openPanel('repair');
  const onOpenPlan = (): void => openPanel('plan');
  const onFocusModule = (moduleId: string): void => {
    selectModule(moduleId);
    closePanel();
  };

  const size = panel === 'events' || panel === 'settings' ? 'xl' : panel === 'sources' || panel === 'plan' ? 'xl' : 'lg';

  return (
    <OverlayPanel title={panelTitle(panel)} onClose={onClose} reducedMotion={reducedMotion} size={size} subtitle={panelSubtitle(panel)}>
      {panel === 'plan' && (
        <PlanPreviewPanel snapshot={snapshot} onOpenConstraints={onOpenConstraints} onOpenSources={onOpenSources} onFocusModule={onFocusModule} onClose={onClose} onOpenEvents={onOpenEvents} />
      )}
      {panel === 'repair' && (
        <RepairPanel
          snapshot={snapshot}
          initialBlockerId={panelContext?.blockerId ?? null}
          onOpenSettings={onOpenSettings}
          onOpenEvents={onOpenEvents}
          onOpenSources={onOpenSources}
          onFocusModule={onFocusModule}
          onClose={onClose}
        />
      )}
      {panel === 'review' && (
        <PatchReviewPanel
          snapshot={snapshot}
          initialPatchId={panelContext?.patchId ?? null}
          onClose={onClose}
          onOpenVersions={onOpenVersions}
          onOpenRepair={() => openPanel('repair', { moduleId: panelContext?.moduleId })}
        />
      )}
      {panel === 'versions' && <VersionsPanel snapshot={snapshot} initialModuleId={panelContext?.moduleId ?? null} onClose={onClose} onOpenEvents={onOpenEvents} />}
      {panel === 'sources' && <SourcesPanel snapshot={snapshot} onClose={onClose} onOpenVersions={onOpenVersions} />}
      {panel === 'recipes' && <RecipePanel snapshot={snapshot} initialRecipeId={panelContext?.recipeId ?? null} onClose={onClose} onOpenEvents={onOpenEvents} />}
      {panel === 'events' && <EventsPanel snapshot={snapshot} initialRunId={panelContext?.runId ?? null} onClose={onClose} />}
      {panel === 'constraints' && (
        <ConstraintsPanel
          snapshot={snapshot}
          onClose={onClose}
        />
      )}
      {panel === 'export' && <ExportPanel snapshot={snapshot} onClose={onClose} />}
      {panel === 'plan' && (
        <p className="mt-3 text-[11px] text-ink-secondary">
          <button type="button" className="ca-focus-ring min-h-8 rounded underline decoration-white/20 underline-offset-2" onClick={() => { exitFocus(); onOpenEvidenceTab('validation'); onClose(); }}>
            查看验证报告
          </button>
          {' · '}
          <button type="button" className="ca-focus-ring min-h-8 rounded underline decoration-white/20 underline-offset-2" onClick={onOpenPlan}>
            重新打开计划预览
          </button>
        </p>
      )}
    </OverlayPanel>
  );
}

function panelSubtitle(panel: string): string {
  switch (panel) {
    case 'plan':
      return '计划版本、真实风险、处理动作与提交守卫';
    case 'repair':
      return '1–3 张必要修复卡；每批处理更多问题';
    case 'review':
      return '差异、证据、L0–L4 校验与接受/拒绝';
    case 'versions':
      return '不可变版本历史；恢复会创建新版本';
    case 'sources':
      return '资料导入、版本、信任与片段';
    case 'recipes':
      return '保存候选配方、测试、用新数据运行与失效';
    case 'events':
      return '只读诊断与历史回放，不重新执行副作用';
    case 'constraints':
      return '任务定义、约束与模块依赖（无环校验）';
    case 'export':
      return '导出成果与导入任务包';
    default:
      return '';
  }
}
