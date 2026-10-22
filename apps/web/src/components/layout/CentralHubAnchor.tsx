/**
 * Z0 Central Hub Anchor: the single delivery target with 1–8 module slots
 * paged by 4. Never scrolled away by the canvas; while focus mode is active a
 * minified anchor plus a return entry stays visible (design 10.1 / 14.1).
 */
import type { Artifact, ModuleView, PatchQueueItem, StageSummary, ValidationSummary } from '@ca/contracts';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, ClipboardCheck, Layers, ListChecks } from 'lucide-react';
import { formatStepProgress, formatTimestamp, truncateText } from '../../lib/format';
import { moduleStateLabel, moduleStateTone, validationStatusLabel, validationStatusTone } from '../../lib/labels';
import { paginateModules } from '../../lib/layout';
import type { PanelId, PanelContext } from '../../state/viewStore';
import { Button, Card, Chip, StatusBadge, StepProgress, cn } from '../common/ui';

export interface CentralHubAnchorProps {
  artifact: Artifact;
  taskTitle: string;
  taskIntent: string;
  modules: ModuleView[];
  patches: PatchQueueItem[];
  validations: ValidationSummary[];
  stage: StageSummary;
  planVersion: number | null;
  planRiskLabel: string | null;
  selectedModuleId: string | null;
  modulePage: number;
  focusActive: boolean;
  focusedTitle: string | null;
  focusHint: string;
  focusModuleIds: ReadonlySet<string> | null;
  onSelectModule: (moduleId: string) => void;
  onPageChange: (page: number) => void;
  onExitFocus: () => void;
  onOpenPanel: (panel: PanelId, context?: PanelContext | null) => void;
  onOpenIntent: () => void;
}

export function CentralHubAnchor(props: CentralHubAnchorProps): JSX.Element {
  const {
    artifact,
    taskTitle,
    taskIntent,
    modules,
    patches,
    validations,
    stage,
    planVersion,
    planRiskLabel,
    selectedModuleId,
    modulePage,
    focusActive,
    focusedTitle,
    focusHint,
    focusModuleIds,
    onSelectModule,
    onPageChange,
    onExitFocus,
    onOpenPanel,
    onOpenIntent,
  } = props;
  const page = paginateModules(modules, modulePage, 4);
  const selectedModule = modules.find((view) => view.module.id === selectedModuleId) ?? null;
  const acceptedCount = modules.filter((view) => view.acceptance.status === 'accepted').length;
  const pendingPatchCount = patches.filter((patch) => patch.status === 'proposed').length;
  const failingValidation = validations.find((validation) => validation.status === 'fail');
  const pendingValidation = validations.find((validation) => validation.status === 'needs_review');

  if (focusActive) {
    return (
      <section className="ca-hairline rounded-lg bg-elevated/90 p-2" aria-label="中心锚点（聚焦时微缩）">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label="聚焦模式" tone="accent" ariaLabel="视图状态" />
          <span className="min-w-0 truncate text-sm font-medium text-ink-primary">{focusedTitle ?? artifact.title}</span>
          <span className="text-xs text-ink-secondary">
            {selectedModule ? `所在模块：${selectedModule.module.title}` : '中心交付物已微缩'}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <StepProgress completed={stage.completedSteps} total={stage.totalSteps} />
            <Button size="sm" variant="secondary" onClick={onExitFocus} icon={<ArrowLeftRight aria-hidden="true" className="h-3.5 w-3.5" />}>
              返回（Esc）
            </Button>
          </div>
        </div>
        {focusHint && <p className="mt-1 text-[11px] leading-4 text-ink-secondary">聚焦范围：{focusHint}</p>}
      </section>
    );
  }

  return (
    <section className="ca-hairline flex min-h-0 flex-col rounded-lg bg-elevated/95" aria-label="中心交付区">
      <div className="border-b border-white/10 px-3 py-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-primary">
              <Layers aria-hidden="true" className="mr-1.5 inline h-4 w-4 text-anchor" />
              {artifact.title}
            </h2>
            <p className="mt-0.5 line-clamp-2 max-w-[36rem] text-xs text-ink-secondary" title={taskIntent}>
              {truncateText(taskTitle, 60)} · {truncateText(taskIntent, 110)}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex flex-wrap justify-end gap-1.5">
              <Chip title="中心交付物仅此一个；所有支线都必须声明回收目标">
                <ListChecks aria-hidden="true" className="h-3 w-3" /> 已接受 {acceptedCount}/{modules.length}
              </Chip>
              <Chip title="等待人工审阅的候选修改数量">待审阅 {pendingPatchCount}</Chip>
              {planVersion != null && <Chip title="当前计划版本；提交绑定该版本与上下文快照">计划 v{planVersion}</Chip>}
              {planRiskLabel && <Chip title="风险数量来自服务端计划，不制造固定风险数">{planRiskLabel}</Chip>}
            </div>
            <StepProgress completed={stage.completedSteps} total={stage.totalSteps} label="阶段" />
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
          <StatusBadge label={stage.label} tone="accent" ariaLabel="当前阶段" />
          {stage.activeStepTitle && <span className="truncate">当前步骤：{stage.activeStepTitle}</span>}
          {stage.note && <span className="truncate text-ink-secondary/90">· {stage.note}</span>}
        </div>
      </div>

      {(failingValidation || pendingValidation) && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 bg-failed/[0.05] px-3 py-1.5">
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 text-failed" />
          <span className="text-[11px] text-ink-secondary">
            {failingValidation
              ? `${modules.find((view) => view.module.id === failingValidation.moduleId)?.module.title ?? '模块'} 的验证未通过，接受操作已禁用。`
              : `${modules.find((view) => view.module.id === pendingValidation?.moduleId)?.module.title ?? '模块'} 有检查项待复核，接受前请确认。`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onOpenPanel('review', failingValidation ? { patchId: modules.find((view) => view.module.id === failingValidation.moduleId)?.acceptance.pendingPatchId ?? undefined } : undefined)
            }
          >
            查看验证详情
          </Button>
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-2 p-2 sm:grid-cols-2" aria-live="polite">
        {page.items.length === 0 && <p className="col-span-full px-2 py-6 text-center text-xs text-ink-secondary">当前任务还没有模块。</p>}
        {page.items.map((view) => {
          const isSelected = view.module.id === selectedModuleId;
          const dimmed = focusModuleIds != null && !focusModuleIds.has(view.module.id);
          const pending = patches.find((patch) => patch.patchId === view.acceptance.pendingPatchId && patch.status === 'proposed');
          const validation = validations.find((candidate) => candidate.validationReportId === view.acceptance.pendingValidationReportId);
          const versionShort = view.acceptance.acceptedVersionId ? view.acceptance.acceptedVersionId.slice(0, 8) : null;
          return (
            <div key={view.module.id} className={cn('min-w-0', dimmed && 'ca-dimmed')} data-selected={isSelected || undefined}>
              <div
                className={cn(
                  'flex h-full flex-col rounded border bg-black/20 p-2 transition-colors duration-feedback',
                  isSelected ? 'border-anchor/60 bg-anchor/[0.04]' : 'border-white/10 hover:border-white/25',
                )}
              >
                <button
                  type="button"
                  className="ca-focus-ring flex min-h-10 w-full items-start justify-between gap-2 rounded text-left"
                  onClick={() => onSelectModule(view.module.id)}
                  aria-label={`选择模块：${view.module.title}，状态 ${moduleStateLabel(view.module.status)}，${view.acceptance.acceptedVersionId ? '已接受' : '无已接受版本'}`}
                  aria-pressed={isSelected}
                  tabIndex={dimmed ? -1 : undefined}
                  aria-hidden={dimmed || undefined}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                      <span className="ca-tabular text-[11px] text-ink-secondary">#{view.module.order + 1}</span>
                      <span className="truncate">{view.module.title}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-secondary">
                      {view.module.kind === 'markdown' ? 'Markdown 文档' : view.module.kind === 'json' ? 'JSON 结构' : 'CSV 表格'}
                      {versionShort ? ` · 版本 ${versionShort}` : ' · 尚无已接受版本'}
                      {view.acceptance.acceptedAt ? ` · ${formatTimestamp(view.acceptance.acceptedAt)}` : ''}
                    </p>
                  </div>
                  <StatusBadge label={moduleStateLabel(view.module.status)} tone={moduleStateTone(view.module.status)} ariaLabel="模块状态" />
                </button>

                {view.acceptance.acceptedSummary && <p className="mt-1 line-clamp-2 text-[11px] text-ink-secondary">{truncateText(view.acceptance.acceptedSummary, 90)}</p>}
                {view.acceptance.staleReason && <p className="mt-1 text-[11px] text-pending">已过期：{truncateText(view.acceptance.staleReason, 100)}</p>}

                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1.5">
                  {view.acceptance.openBlockerIds.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      tabIndex={dimmed ? -1 : undefined}
                      onClick={() => onOpenPanel('repair', { moduleId: view.module.id })}
                      icon={<AlertTriangle aria-hidden="true" className="h-3 w-3 text-pending" />}
                    >
                      {view.acceptance.openBlockerIds.length} 项待处理
                    </Button>
                  )}
                  {pending && (
                    <Button
                      size="sm"
                      variant="ghost"
                      tabIndex={dimmed ? -1 : undefined}
                      onClick={() => onOpenPanel('review', { patchId: pending.patchId })}
                      icon={<ClipboardCheck aria-hidden="true" className="h-3 w-3 text-anchor" />}
                    >
                      审阅变更
                    </Button>
                  )}
                  {validation && (
                    <StatusBadge label={`校验：${validationStatusLabel(validation.status)}`} tone={validationStatusTone(validation.status)} ariaLabel="待审阅候选的校验状态" />
                  )}
                  {view.module.acceptanceCriteria.length > 0 && (
                    <span className="text-[11px] text-ink-secondary" title={view.module.acceptanceCriteria.map((criterion) => `[${criterion.layer}] ${criterion.text}`).join('\n')}>
                      验收标准 {view.module.acceptanceCriteria.length}
                    </span>
                  )}
                  {view.acceptance.status === 'accepted' && <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-accepted" />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="quiet" disabled={page.page <= 0} onClick={() => onPageChange(page.page - 1)} aria-label="上一页模块">
            上一页
          </Button>
          <span className="ca-tabular text-[11px] text-ink-secondary">
            第 {page.page + 1}/{page.pageCount} 页 · 模块 {page.startIndex + 1}–{page.endIndex}（共 {page.total} 个）
          </span>
          <Button size="sm" variant="quiet" disabled={page.page >= page.pageCount - 1} onClick={() => onPageChange(page.page + 1)} aria-label="下一页模块">
            下一页
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-secondary">{formatStepProgress(stage.completedSteps, stage.totalSteps)}</span>
          <Button size="sm" variant="secondary" onClick={onOpenIntent}>
            输入意图
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Exported for the side rail: compact pending-change list. */
export function PendingChangesCard({ patches, modules, onOpenReview }: { patches: PatchQueueItem[]; modules: ModuleView[]; onOpenReview: (patchId: string) => void }): JSX.Element {
  const proposed = patches.filter((patch) => patch.status === 'proposed');
  return (
    <Card title={`待接受变更（${proposed.length}）`} subtitle="候选不改变已接受版本；拒绝会保留运行记录与草稿。">
      {proposed.length === 0 && <p className="text-xs text-ink-secondary">当前没有待接受的候选修改。</p>}
      <ul className="space-y-1">
        {proposed.map((patch) => {
          const module = modules.find((view) => view.module.id === patch.moduleId);
          return (
            <li key={patch.patchId}>
              <button
                type="button"
                className="ca-focus-ring flex min-h-10 w-full items-center justify-between gap-2 rounded border border-white/10 bg-black/20 px-2 py-1.5 text-left hover:border-white/25"
                onClick={() => onOpenReview(patch.patchId)}
                aria-label={`审阅 ${module?.module.title ?? patch.moduleId} 的候选修改`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs text-ink-primary">{module?.module.title ?? patch.moduleId}</span>
                  <span className="text-[11px] text-ink-secondary">差异创建于 {formatTimestamp(patch.createdAt)}</span>
                </span>
                <StatusBadge label={`校验：${validationStatusLabel(patch.validationStatus)}`} tone={validationStatusTone(patch.validationStatus)} ariaLabel="候选校验状态" />
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
