/**
 * Right-hand local execution rail: blocker shields (mechanism B summary),
 * pending changes, recipe folds and the active run summary.
 * Everything here is driven by the server snapshot; actions open real panels.
 */
import type { Blocker, ModuleView, PatchQueueItem, Recipe, TaskSnapshot } from '@ca/contracts';
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck, ShieldAlert, Wrench } from 'lucide-react';
import { formatRelativeTime, truncateText } from '../../lib/format';
import {
  affectedFieldsSummary,
  blockerBatch,
  blockerTypeLabel,
  blockerTypeTone,
  isTechnicalBlocker,
  recipeKindLabel,
  recipeStatusTone,
  recipeStatusLabel,
  runStateLabel,
  runStateTone,
  severityLabel,
  severityTone,
} from '../../lib/labels';
import { Button, Card, Chip, StatusBadge, cn } from '../common/ui';
import { PendingChangesCard } from './CentralHubAnchor';

export interface SideRailProps {
  snapshot: TaskSnapshot;
  modules: ModuleView[];
  blockers: Blocker[];
  patches: PatchQueueItem[];
  recipes: TaskSnapshot['recipes'];
  recipeDetails: readonly Recipe[];
  repairBatch: number;
  onChangeRepairBatch: (next: number) => void;
  onOpenRepair: (blockerId: string | null) => void;
  onOpenReview: (patchId: string) => void;
  onOpenRecipes: (recipeId?: string) => void;
  onOpenRun: () => void;
  onOpenEvidenceTab: (tab: 'sources' | 'spans' | 'tools' | 'validation') => void;
}

export function SideRail(props: SideRailProps): JSX.Element {
  const { snapshot, modules, blockers, patches, recipes, recipeDetails, repairBatch, onChangeRepairBatch, onOpenRepair, onOpenReview, onOpenRecipes, onOpenRun, onOpenEvidenceTab } = props;
  const batch = blockerBatch(blockers, repairBatch, 3);
  const activeRun = snapshot.activeRun;
  const openBlockers = blockers.filter((blocker) => blocker.status === 'open');
  const technical = openBlockers.filter((blocker) => isTechnicalBlocker(blocker.type));

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Card
        title={
          <span className="flex items-center gap-1.5">
            <ShieldAlert aria-hidden="true" className="h-4 w-4 text-pending" />
            待处理问题（{blockers.filter((blocker) => blocker.status === 'open').length}）
          </span>
        }
        subtitle="每批最多 3 张修复卡；技术故障使用恢复入口，不做成业务选择题。"
        actions={
          <div className="flex items-center gap-1">
            {batch.batchCount > 1 && (
              <>
                <Button size="sm" variant="quiet" disabled={batch.batchIndex <= 0} onClick={() => onChangeRepairBatch(batch.batchIndex - 1)} aria-label="上一批问题">
                  <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
                <span className="ca-tabular text-[11px] text-ink-secondary">
                  {batch.batchIndex + 1}/{batch.batchCount}
                </span>
                <Button size="sm" variant="quiet" disabled={batch.batchIndex >= batch.batchCount - 1} onClick={() => onChangeRepairBatch(batch.batchIndex + 1)} aria-label="下一批问题">
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button size="sm" variant="secondary" onClick={() => onOpenRepair(null)} icon={<Wrench aria-hidden="true" className="h-3 w-3" />}>
              处理
            </Button>
          </div>
        }
      >
        {openBlockers.length === 0 ? (
          <p className="text-xs text-ink-secondary">当前没有待处理问题。计划风险与验证结果仍会显示在对应面板中。</p>
        ) : (
          <ul className="space-y-1.5">
            {batch.items.map((blocker) => (
              <li key={blocker.id}>
                <button
                  type="button"
                  className="ca-focus-ring flex min-h-10 w-full flex-col gap-1 rounded border border-pending/25 bg-pending/[0.05] px-2 py-1.5 text-left hover:border-pending/50"
                  onClick={() => onOpenRepair(blocker.id)}
                  aria-label={`处理问题：${blocker.title}`}
                >
                  <span className="flex w-full flex-wrap items-center gap-1.5">
                    <StatusBadge label={blockerTypeLabel(blocker.type)} tone={blockerTypeTone(blocker.type)} ariaLabel="问题类型" />
                    <StatusBadge label={severityLabel(blocker.severity)} tone={severityTone(blocker.severity)} ariaLabel="严重程度" />
                    {isTechnicalBlocker(blocker.type) && <Chip>技术恢复入口</Chip>}
                    <span className="ml-auto text-[10px] text-ink-secondary">{formatRelativeTime(blocker.createdAt)}</span>
                  </span>
                  <span className="truncate text-xs font-medium text-ink-primary">{blocker.title}</span>
                  <span className="line-clamp-2 text-[11px] leading-4 text-ink-secondary">{truncateText(blocker.detail, 120)}</span>
                  <span className="text-[11px] text-ink-secondary">{affectedFieldsSummary(blocker)}</span>
                </button>
              </li>
            ))}
            {batch.moreCount > 0 && <li className="text-[11px] text-ink-secondary">另有 {batch.moreCount} 项待处理，使用上方批次切换。</li>}
          </ul>
        )}
        {technical.length > 0 && (
          <p className="mt-1.5 text-[11px] text-ink-secondary">
            技术故障 {technical.length} 项：这些问题的处理方式是检查连接/权限后恢复，不伪装成业务选择。
          </p>
        )}
      </Card>

      <PendingChangesCard patches={patches} modules={modules} onOpenReview={onOpenReview} />

      <Card
        title="运行与配方"
        subtitle="确定性配方显示 0 次 LLM 调用；LLM 辅助配方按实际账本计数。"
        actions={
          <Button size="sm" variant="ghost" onClick={() => onOpenRun()} icon={<ClipboardCheck aria-hidden="true" className="h-3 w-3" />}>
            运行详情
          </Button>
        }
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge label={activeRun ? `运行：${runStateLabel(activeRun.state)}` : '无活动运行'} tone={activeRun ? runStateTone(activeRun.state) : 'muted'} ariaLabel="活动运行状态" />
            {activeRun && <Chip>尝试 {activeRun.attempt}</Chip>}
            {activeRun && <Chip>计划 v{activeRun.planVersion}</Chip>}
            <Chip title="预算计数来自后端账本">{snapshot.control.budgetLabel}</Chip>
          </div>
          {activeRun?.error ? (
            <p className="rounded border border-failed/40 bg-failed/[0.06] px-2 py-1 text-[11px] text-ink-primary">
              运行错误：{truncateText(typeof activeRun.error === 'string' ? activeRun.error : JSON.stringify(activeRun.error), 160)}
            </p>
          ) : null}
          {recipes.length > 0 ? (
            <ul className="space-y-1">
              {recipes.map((recipe) => {
                const detail = recipeDetails.find((candidate) => candidate.id === recipe.recipeId);
                return (
                  <li key={recipe.recipeId}>
                    <button
                      type="button"
                      className="ca-focus-ring flex min-h-10 w-full flex-wrap items-center justify-between gap-1.5 rounded border border-white/10 bg-black/20 px-2 py-1.5 text-left hover:border-white/25"
                      onClick={() => onOpenRecipes(recipe.recipeId)}
                      aria-label={`配方：${recipe.name}，状态 ${recipeStatusLabel(recipe.status)}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs text-ink-primary">{recipe.name}</span>
                        <span className="text-[11px] text-ink-secondary">
                          {recipeKindLabel(recipe.kind)} · v{recipe.version}
                          {detail ? ` · ${detail.testCases.filter((testCase) => testCase.status === 'passed').length}/${detail.testCases.length} 测试通过` : ''}
                        </span>
                      </span>
                      <StatusBadge label={recipeStatusLabel(recipe.status)} tone={recipeStatusTone(recipe.status)} ariaLabel="配方状态" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-ink-secondary">还没有可复用配方。成功运行并接受成果后，可保存候选配方。</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onOpenEvidenceTab('validation')} icon={<AlertTriangle aria-hidden="true" className="h-3 w-3" />}>
              验证报告
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onOpenRecipes()}>
              配方面板
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
