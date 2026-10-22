/**
 * Workspace screen: composes the five spatial regions, the three elevation
 * layers and all demand-driven panels around the authoritative snapshot.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ProspectProjection, SpatialNode, TaskSnapshot } from '@ca/contracts';
import { Crosshair, Focus, X } from 'lucide-react';
import { failureGuidance, failureTitle } from '../api/errors';
import { commandEnvelope } from '../lib/ids';
import { formatStepProgress } from '../lib/format';
import { planPhaseLabel, spatialStatusLabel } from '../lib/labels';
import { buildSpatialLayout, evidenceNodeId, focusRelatedModuleIds, pageForModule, spatialBranchId } from '../lib/layout';
import { useCommandPending, useCore, useCoreState, useEffectiveReducedMotion, useFocusRestore, usePageVisible, useViewStore } from '../state/hooks';
import { Button, ErrorNotice, LoadingBlock, StatusBadge } from '../components/common/ui';
import { BranchLane } from '../components/layout/BranchLane';
import { CentralHubAnchor } from '../components/layout/CentralHubAnchor';
import { ConstraintCanopy } from '../components/layout/ConstraintCanopy';
import { EvidenceDepth } from '../components/layout/EvidenceDepth';
import { HighLedgeAttractor } from '../components/layout/HighLedgeAttractor';
import { IntentPill } from '../components/layout/IntentPill';
import { RunControlBar } from '../components/layout/RunControlBar';
import { SideRail } from '../components/layout/SideRail';
import { StatusBanner } from '../components/layout/StatusBanner';
import { PanelHost } from '../components/panels/PanelHost';
import type { TaskSnapshot as Snapshot } from '@ca/contracts';

export interface WorkspaceScreenProps {
  taskId: string;
  isFixture: boolean;
  onHome: () => void;
  onSettings: () => void;
}

export function WorkspaceScreen({ taskId, isFixture, onHome, onSettings }: WorkspaceScreenProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const view = useViewStore();
  const reducedMotion = useEffectiveReducedMotion();
  const pageVisible = usePageVisible();
  const { pending } = useCommandPending();
  const layoutRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void core.openTask(taskId);
  }, [core, taskId]);

  const snapshot: Snapshot | null = state.snapshot;

  // Keep view-only selection sane without ever touching business state.
  useEffect(() => {
    if (!snapshot) return;
    const moduleIds: string[] = snapshot.modules.map((module) => module.module.id);
    if (view.selectedModuleId == null || !moduleIds.includes(view.selectedModuleId)) {
      view.selectModule(moduleIds[0] ?? null);
    }
    const branchIds = [...new Set(snapshot.spatial.nodes.filter((node) => !['hub', 'constraint', 'prospect', 'source', 'span', 'validation'].includes(node.kind)).map(spatialBranchId))];
    if (view.expandedBranches.length === 0 && branchIds.length > 0) {
      const active = snapshot.spatial.activeBranchId;
      const initial = active && branchIds.includes(active) ? [active, ...branchIds.filter((id) => id !== active).slice(0, 2)] : branchIds.slice(0, 3);
      view.setExpandedBranches(initial);
    }
    const page = pageForModule(snapshot.modules, view.selectedModuleId, 4);
    if (view.modulePage !== page && snapshot.modules.length > 4) view.setModulePage(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.snapshotSeq, view.selectedModuleId]);

  useFocusRestore(view.focusScopeId);

  const layout = useMemo(() => {
    if (!snapshot) return null;
    const moduleTitles = new Map(snapshot.modules.map((module) => [module.module.id, module.module.title]));
    const runLabels = new Map(snapshot.runs.map((run) => [run.runId, `${run.origin === 'recipe' ? '配方运行' : run.origin === 'synthesis' ? '综合成果运行' : '执行运行'} ${run.runId.slice(0, 8)}`]));
    return buildSpatialLayout(snapshot.spatial, {
      expandedBranchIds: view.expandedBranches,
      selectedEntityId: view.selectedEntityId,
      focusScopeId: view.focusScopeId,
      moduleTitles,
      runLabels,
      maxBranches: snapshot.limits.maxSpatialBranches,
      maxNodes: snapshot.limits.maxSpatialNodes,
      maxEdges: snapshot.limits.maxSpatialEdges,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, view.expandedBranches, view.selectedEntityId, view.focusScopeId]);

  const focusModuleIds = useMemo(() => {
    if (!snapshot || !view.focusScopeId) return null;
    return focusRelatedModuleIds(snapshot, view.focusScopeId);
  }, [snapshot, view.focusScopeId]);

  const focusedNode: SpatialNode | null = snapshot && view.focusScopeId ? snapshot.spatial.nodes.find((node) => node.id === view.focusScopeId) ?? null : null;
  const focusedTitle = focusedNode?.title ?? null;

  if (!snapshot) {
    return (
      <div className="flex h-full flex-col">
        <StatusBanner
          session={state.session}
          workspace={state.workspace}
          snapshot={null}
          connection={state.connection}
          isFixture={isFixture}
          pendingCommand={state.command?.label ?? null}
          onHome={onHome}
          onSettings={onSettings}
          onRefresh={() => void core.refreshSnapshot({ quiet: false })}
          onOpenEvents={() => view.openPanel('events')}
        />
        <div className="flex flex-1 items-center justify-center p-4">
          {state.snapshotError ? (
            <ErrorNotice
              title={failureTitle(state.snapshotError)}
              message={state.snapshotError.message}
              guidance={failureGuidance(state.snapshotError)}
              traceId={state.snapshotError.traceId}
              onRetry={() => void core.refreshSnapshot({ quiet: false })}
            />
          ) : (
            <LoadingBlock label="正在读取任务快照；不会用本地状态推断执行结果…" />
          )}
        </div>
      </div>
    );
  }

  const task = snapshot.task;
  const modules = snapshot.modules;
  const plan = snapshot.plan;
  const openPanel = view.openPanel;
  const activeRun = snapshot.activeRun;
  const selectedModule = modules.find((module) => module.module.id === view.selectedModuleId) ?? null;
  const stage = snapshot.spatial.stage;

  const onSelectModule = (moduleId: string): void => {
    view.selectModule(moduleId);
    view.setModulePage(pageForModule(modules, moduleId, 4));
  };

  const onOpenIntent = (): void => {
    const element = document.getElementById('intent-pill');
    element?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    const textarea = element?.querySelector<HTMLTextAreaElement>('textarea');
    textarea?.focus();
  };

  return (
    <div ref={layoutRootRef} className={`relative flex h-full min-h-0 flex-col overflow-hidden ca-grid-bg ${pageVisible ? '' : 'ca-animation-paused'} ${reducedMotion ? 'ca-reduced-motion' : ''}`}>
      <StatusBanner
        session={state.session}
        workspace={state.workspace}
        snapshot={snapshot}
        connection={state.connection}
        isFixture={isFixture}
        pendingCommand={state.command?.label ?? null}
        onHome={onHome}
        onSettings={onSettings}
        onRefresh={() => void core.refreshSnapshot({ quiet: false })}
        onOpenEvents={() => view.openPanel('events', { runId: activeRun?.runId })}
      />

      <ConstraintCanopy
        snapshot={snapshot}
        plan={plan}
        modules={modules}
        layer={view.layer}
        open={view.canopyOpen}
        onToggle={view.setCanopyOpen}
        onOpenConstraints={() => openPanel('constraints')}
        onOpenPlan={() => openPanel('plan')}
        onSelectModule={onSelectModule}
      />

      {view.focusScopeId && (
        <div className="flex flex-wrap items-center gap-2 border-b border-anchor/30 bg-anchor/[0.06] px-3 py-1.5" role="status" aria-live="polite">
          <Focus aria-hidden="true" className="h-4 w-4 text-anchor" />
          <span className="text-xs font-medium text-anchor">聚焦模式</span>
          <span className="min-w-0 truncate text-xs text-ink-primary">{focusedTitle ?? view.focusScopeId}</span>
          <span className="text-[11px] text-ink-secondary">
            相关节点已保留，无关节点降对比并退出键盘序列；停止、审批与错误始终可见。
          </span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => view.exitFocus()} icon={<Crosshair aria-hidden="true" className="h-3.5 w-3.5" />}>
            退出聚焦（Esc）
          </Button>
        </div>
      )}

      <main id="workspace-main" className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 lg:overflow-hidden" aria-label="空间工作台">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,1.3fr)_minmax(0,0.9fr)] lg:overflow-hidden">
          <div className="order-3 flex min-h-0 flex-col gap-2 lg:order-none lg:overflow-y-auto lg:pr-0.5 ca-scroll">
            {layout && (
              <BranchLane
                layout={layout}
                selectedEntityId={view.selectedEntityId}
                focusScopeId={view.focusScopeId}
                onSelectEntity={(node) => {
                  view.selectEntity(node.id, node.moduleId);
                  if (node.moduleId) view.setModulePage(pageForModule(modules, node.moduleId, 4));
                }}
                onToggleBranch={(branchId) => view.toggleBranch(branchId, snapshot.limits.maxSpatialBranches)}
                onFocusEntity={(node) => {
                  view.enterFocus(node.id, node.moduleId);
                  if (node.moduleId) onSelectModule(node.moduleId);
                }}
                onOpenPanel={(panel, context) => openPanel(panel, context)}
                onOpenEvidenceTab={(tab) => {
                  view.setEvidenceTab(tab);
                  view.setEvidenceOpen(true);
                  view.setLayer('evidence');
                }}
                onSelectModule={onSelectModule}
              />
            )}
            <div className="lg:hidden">
              <EvidenceDepth
                snapshot={snapshot}
                layer={view.layer}
                open={view.evidenceOpen}
                tab={view.evidenceTab}
                intentSourceIds={view.intentSourceIds}
                onToggleOpen={view.setEvidenceOpen}
                onTabChange={view.setEvidenceTab}
                onOpenSourcesPanel={() => openPanel('sources')}
                onOpenVersions={(moduleId) => openPanel('versions', { moduleId })}
                onToggleIntentSource={view.toggleIntentSource}
                onFocusSpan={() => {
                  view.setLayer('evidence');
                  view.setEvidenceOpen(true);
                }}
                onFocusEntity={(entityId) => view.enterFocus(entityId)}
              />
            </div>
          </div>

          <div className="order-1 flex min-h-0 flex-col gap-2 lg:order-none lg:overflow-y-auto ca-scroll">
            <CentralHubAnchor
              artifact={snapshot.artifact}
              taskTitle={task.title}
              taskIntent={task.intent}
              modules={modules}
              patches={snapshot.patches}
              validations={snapshot.validations}
              stage={stage}
              planVersion={plan ? plan.version : null}
              planRiskLabel={plan ? (plan.risks.length === 0 ? '未发现风险' : `${plan.risks.length} 个风险（${plan.risks.filter((risk) => risk.severity === 'blocking' && risk.resolvedByDecisionId === null).length} 个阻止提交）`) : null}
              selectedModuleId={view.selectedModuleId}
              modulePage={view.modulePage}
              focusActive={Boolean(view.focusScopeId)}
              focusedTitle={focusedTitle}
              focusHint={snapshot.spatial.focusHint}
              focusModuleIds={focusModuleIds}
              onSelectModule={onSelectModule}
              onPageChange={(page) => view.setModulePage(page)}
              onExitFocus={() => view.exitFocus()}
              onOpenPanel={(panel, context) => openPanel(panel, context)}
              onOpenIntent={onOpenIntent}
            />
            <div id="intent-pill">
              <IntentPill task={task} modules={modules} onOpenSources={() => openPanel('sources')} onOpenPlan={() => openPanel('plan')} onSelectModule={onSelectModule} />
            </div>
            {plan && (
              <div className="flex flex-wrap items-center gap-1.5 rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <StatusBadge label={planPhaseLabel(stage.phase)} tone="accent" ariaLabel="计划阶段" />
                <span className="text-[11px] text-ink-secondary">{formatStepProgress(stage.completedSteps, stage.totalSteps)}</span>
                <span className="text-[11px] text-ink-secondary">计划 v{plan.version} · {plan.steps.length} 步 · {plan.tools.length} 个工具</span>
                <Button size="sm" variant="secondary" className="ml-auto" onClick={() => openPanel('plan', { runId: activeRun?.runId })}>
                  计划预览与风险
                </Button>
                {view.focusScopeId && (
                  <Button size="sm" variant="ghost" onClick={() => view.exitFocus()}>
                    退出聚焦
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="order-2 flex min-h-0 flex-col gap-2 lg:order-none lg:overflow-y-auto ca-scroll">
            <HighLedgeAttractor
              prospects={snapshot.prospects}
              modules={modules}
              collapsed={view.highLedgeCollapsed}
              onToggleCollapsed={view.setHighLedgeCollapsed}
              busy={pending}
              onGenerate={(prospect: ProspectProjection) => {
                const targetModuleId = prospect.targetModuleId ?? prospect.requiredInputs.find((input) => input.satisfied)?.moduleId ?? null;
                if (!targetModuleId) return;
                onSelectModule(targetModuleId);
                const envelope = commandEnvelope(task.revision);
                void core.runCommand(
                  '生成综合成果',
                  (client) =>
                    client.createRun(task.id, {
                      ...envelope,
                      expectedRevision: task.revision,
                      moduleId: targetModuleId,
                      intent: `生成综合成果「${prospect.title}」；输入要求来自高台候选。`,
                      planFirst: true,
                    }),
                  { successNotice: '综合成果运行已创建：仍需计划预览、验证与人工接受。' },
                ).then((result) => {
                  if (result) openPanel('plan');
                });
              }}
              onSelectModule={onSelectModule}
              onOpenSources={() => openPanel('sources')}
              onOpenProspectsNote={() => openPanel('plan')}
            />
            {selectedModule && (
              <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <p className="text-[11px] text-ink-secondary">当前目标模块</p>
                <p className="truncate text-xs text-ink-primary">{selectedModule.module.title}</p>
                <p className="text-[11px] text-ink-secondary">
                  已接受版本 {selectedModule.acceptance.acceptedVersionId ? selectedModule.acceptance.acceptedVersionId.slice(0, 8) : '无'} · 状态 {spatialStatusLabel(selectedModule.module.status)}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openPanel('versions', { moduleId: selectedModule.module.id })}>
                    版本历史
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openPanel('sources')}>
                    资料
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openPanel('export')}>
                    导出
                  </Button>
                </div>
              </div>
            )}
            <SideRail
              snapshot={snapshot}
              modules={modules}
              blockers={snapshot.blockers}
              patches={snapshot.patches}
              recipes={snapshot.recipes}
              recipeDetails={[]}
              repairBatch={view.repairBatch}
              onChangeRepairBatch={view.setRepairBatch}
              onOpenRepair={(blockerId) => openPanel('repair', { blockerId: blockerId ?? undefined })}
              onOpenReview={(patchId) => openPanel('review', { patchId })}
              onOpenRecipes={(recipeId) => openPanel('recipes', { recipeId })}
              onOpenRun={() => openPanel('events', { runId: activeRun?.runId })}
              onOpenEvidenceTab={(tab) => {
                view.setEvidenceTab(tab);
                view.setEvidenceOpen(true);
                view.setLayer('evidence');
              }}
            />
          </div>
        </div>

        <div className="hidden lg:block">
          <EvidenceDepth
            snapshot={snapshot}
            layer={view.layer}
            open={view.evidenceOpen}
            tab={view.evidenceTab}
            intentSourceIds={view.intentSourceIds}
            onToggleOpen={view.setEvidenceOpen}
            onTabChange={view.setEvidenceTab}
            onOpenSourcesPanel={() => openPanel('sources')}
            onOpenVersions={(moduleId) => openPanel('versions', { moduleId })}
            onToggleIntentSource={view.toggleIntentSource}
            onFocusSpan={(span) => {
              const nodeId = evidenceNodeId(snapshot.spatial, span.sourceId);
              if (nodeId) view.enterFocus(nodeId);
              else openPanel('sources');
              view.setEvidenceOpen(true);
            }}
            onFocusEntity={(entityId) => view.enterFocus(entityId)}
          />
        </div>
      </main>

      <RunControlBar
        snapshot={snapshot}
        focusActive={Boolean(view.focusScopeId)}
        onOpenSettings={onSettings}
        onOpenEvents={() => openPanel('events', { runId: activeRun?.runId })}
        onOpenPlan={() => openPanel('plan')}
        onOpenRepair={() => openPanel('repair')}
      />

      <PanelHost snapshot={snapshot} reducedMotion={reducedMotion} onOpenEvidenceTab={(tab) => { view.setEvidenceTab(tab); view.setEvidenceOpen(true); view.setLayer('evidence'); }} />

      {state.snapshotError && (
        <div className="pointer-events-auto fixed left-1/2 top-16 z-40 w-[min(92vw,32rem)] -translate-x-1/2">
          <ErrorNotice
            compact
            title={failureTitle(state.snapshotError)}
            message={state.snapshotError.message}
            guidance={failureGuidance(state.snapshotError)}
            traceId={state.snapshotError.traceId}
            onRetry={() => void core.refreshSnapshot({ quiet: false })}
          />
        </div>
      )}
    </div>
  );
}

export { X };
