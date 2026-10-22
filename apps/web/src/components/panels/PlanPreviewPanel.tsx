/**
 * Mechanism A — plan preview and risk handling.
 *
 * Real risk counts from `snapshot.plan.risks`: zero risks renders zero cards.
 * Commit is bound to `planVersion` + `contextSnapshotId`; editing the intent
 * draft or the task revision after opening the preview invalidates submit until
 * the user re-checks the plan. Hard conflicts cannot be "ignored" away.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Plan, PlanRisk, TaskSnapshot } from '@ca/contracts';
import { AlertTriangle, ArrowRight, FileSearch, GitPullRequestArrow, PencilLine, RefreshCw, ShieldAlert } from 'lucide-react';
import { formatTimestamp, safeJsonPreview, truncateText } from '../../lib/format';
import { planPhaseLabel, riskBasisLabel, riskTypeLabel, severityLabel, severityTone, summarizeRisks, validationLayerLabel } from '../../lib/labels';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useCoreState } from '../../state/hooks';
import { readIntentDraft, useViewStore } from '../../state/viewStore';
import { EvidenceRefList } from '../common/EvidenceRefList';
import { Button, Card, Chip, DisabledHint, EmptyState, InlineWarning, SectionHeading, StatusBadge, StepProgress, cn } from '../common/ui';

export interface PlanPreviewPanelProps {
  snapshot: TaskSnapshot;
  onOpenConstraints: () => void;
  onOpenSources: () => void;
  onFocusModule: (moduleId: string) => void;
  onClose: () => void;
  onOpenEvents: () => void;
}

export function PlanPreviewPanel({ snapshot, onOpenConstraints, onOpenSources, onFocusModule, onClose, onOpenEvents }: PlanPreviewPanelProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const { pending } = useCommandPending();
  const selectedModuleId = useViewStore((view) => view.selectedModuleId);
  const exitFocus = useViewStore((view) => view.exitFocus);
  const plan = snapshot.plan;
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(snapshot.task.revision);
  const [draftAtReview, setDraftAtReview] = useState<string>(readIntentDraft(useViewStore.getState(), snapshot.task.id, selectedModuleId));
  const [showAllRisks, setShowAllRisks] = useState(false);
  const [expandedRiskId, setExpandedRiskId] = useState<string | null>(null);
  const [showPlanDetail, setShowPlanDetail] = useState(false);
  const task = snapshot.task;
  const currentDraft = readIntentDraft(useViewStore.getState(), task.id, selectedModuleId);

  useEffect(() => {
    setReviewedRevision(snapshot.task.revision);
    setDraftAtReview(readIntentDraft(useViewStore.getState(), task.id, selectedModuleId));
    // Only capture the baseline when the preview opens (revision captured once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const risks = plan?.risks ?? [];
  const riskSummary = useMemo(() => summarizeRisks(risks), [risks]);
  const activeRun = snapshot.activeRun;
  const blockingUnresolved = riskSummary.blockingRisks;
  const draftChanged = currentDraft !== draftAtReview;
  const revisionChanged = reviewedRevision != null && snapshot.task.revision !== reviewedRevision;
  const contextSnapshotId = activeRun?.contextSnapshotId ?? null;
  const planMatchesRun = Boolean(plan && activeRun && activeRun.planVersion === plan.version);
  const readyToCommit = activeRun?.state === 'READY' || activeRun?.state === 'AWAITING_INPUT';

  const submitDisabledReason = useMemo(() => {
    if (!plan) return '当前没有可提交的计划。';
    if (pending) return '有命令正在处理中。';
    if (!activeRun) return '没有活动运行；请先在意图胶囊中发起运行。';
    if (!planMatchesRun) return `计划 v${plan.version} 与运行计划 v${activeRun.planVersion} 不一致；请重新检查计划。`;
    if (!readyToCommit) return `运行状态「${activeRun.state}」不接受计划提交。`;
    if (blockingUnresolved.length > 0) return `${blockingUnresolved.length} 项阻止提交的风险尚未处理；硬约束冲突不能通过“忽略”抹去。`;
    if (draftChanged) return '意图草稿在审阅后被修改：请重新检查计划以确认输入未变化。';
    if (revisionChanged) return '任务在审阅后已被更新：请重新检查计划，使提交绑定最新上下文。';
    if (!contextSnapshotId) return '等待后端生成上下文快照（contextSnapshotId）；提交按钮在快照就绪前不可用。';
    return null;
  }, [plan, pending, activeRun, planMatchesRun, readyToCommit, blockingUnresolved.length, draftChanged, revisionChanged, contextSnapshotId]);

  const recheck = async (): Promise<void> => {
    await core.refreshSnapshot({ quiet: false });
    setReviewedRevision(core.getState().snapshot?.task.revision ?? task.revision);
    setDraftAtReview(readIntentDraft(useViewStore.getState(), task.id, selectedModuleId));
  };

  const submit = async (): Promise<void> => {
    if (!plan || !activeRun || submitDisabledReason) return;
    const envelope = commandEnvelope(task.revision);
    const result = await core.runCommand(
      '提交计划',
      (client) =>
        client.commitPlan(activeRun.runId, {
          ...envelope,
          expectedRevision: task.revision,
          planVersion: plan.version,
          contextSnapshotId: contextSnapshotId!,
        }),
      { successNotice: '计划已提交：真实执行开始，进度以服务端事件与快照为准。' },
    );
    if (result) {
      onClose();
      onOpenEvents();
    }
  };

  const visibleRisks = showAllRisks ? risks : risks.slice(0, 3);

  if (!plan) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState title="还没有计划" description="通过意图胶囊发起运行后，若任务复杂或存在风险，后端会先生成计划供你预览。" icon={<GitPullRequestArrow aria-hidden="true" className="h-6 w-6" />} />
        {activeRun && (
          <Card title="当前运行">
            <p className="text-xs text-ink-secondary">
              运行状态：{activeRun.state} · 计划版本 v{activeRun.planVersion} · 尝试 {activeRun.attempt}
            </p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={onOpenEvents}>
              查看运行事件
            </Button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge label={planPhaseLabel(snapshot.spatial.stage.phase)} tone="accent" ariaLabel="计划阶段" />
        <Chip>计划 v{plan.version}</Chip>
        <Chip>风险：{riskSummary.label}</Chip>
        <Chip>目标模块：{snapshot.modules.find((view) => view.module.id === plan.targetModuleId)?.module.title ?? plan.targetModuleId}</Chip>
        <Chip>{plan.steps.length} 个步骤</Chip>
        <Chip>{plan.tools.length} 个工具</Chip>
        <span className="ml-auto text-[11px] text-ink-secondary">生成于 {formatTimestamp(plan.createdAt)}</span>
      </div>

      <InlineWarning tone="accent" title="计划预览不是隐藏思维链">
        展示目标、骨架、输入版本、步骤、工具范围、预算与真实风险；模型自评分不参与通过判定。硬约束冲突必须通过修改输入/约束或明确记录处理方式解决。
      </InlineWarning>

      <Card title="目标与交付物骨架" actions={<Button size="sm" variant="ghost" onClick={() => setShowPlanDetail((value) => !value)} aria-expanded={showPlanDetail}>{showPlanDetail ? '收起详情' : '展开详情'}</Button>}>
        <p className="text-xs leading-5 text-ink-primary">{plan.goal}</p>
        <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
          {plan.artifactSkeleton.map((item) => {
            const module = snapshot.modules.find((view) => view.module.id === item.moduleId);
            return (
              <li key={item.moduleId} className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px]">
                <p className="text-ink-primary">{module?.module.title ?? item.moduleId}</p>
                <p className="text-ink-secondary">
                  {item.moduleKind} · {item.sections.length > 0 ? item.sections.join(' / ') : '无固定章节'} · {item.expectedContentSummary || '未声明'}
                </p>
              </li>
            );
          })}
        </ul>
        {showPlanDetail && (
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <div>
              <SectionHeading title="步骤顺序（无环）" />
              <ol className="mt-1 space-y-1">
                {plan.steps.map((step) => (
                  <li key={step.id} className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px]">
                    <p className="text-ink-primary">
                      {step.id} · {step.title} <span className="text-ink-secondary">（{step.kind}{step.toolId ? ` / ${step.toolId}` : ''}）</span>
                    </p>
                    <p className="text-ink-secondary">
                      依赖：{step.dependencies.length > 0 ? step.dependencies.join('、') : '无'} · 预期：{truncateText(step.expectedOutput, 60)}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <SectionHeading title="输入、约束与预算" />
              <p className="mt-1 text-[11px] text-ink-secondary">输入版本：{plan.inputRefs.length} 项</p>
              <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink-secondary">
                {plan.inputRefs.map((ref, index) => (
                  <li key={index}>
                    {ref.kind === 'source' ? `资料 ${ref.source.sourceId.slice(0, 8)} v${ref.source.version}` : `成果版本 ${ref.versionId.slice(0, 8)}（模块 ${ref.moduleId.slice(0, 8)}）`}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-ink-secondary">约束引用：{plan.constraintRefs.map((ref) => ref.constraintId).join('、') || '无'}</p>
              <p className="mt-1 text-[11px] text-ink-secondary">工具范围：{plan.tools.map((tool) => `${tool.toolId}（${tool.effect}）`).join('、')}</p>
              <p className="mt-1 text-[11px] text-ink-secondary">验证器：{plan.validators.map((validator) => `${validator.id}@${validationLayerLabel(validator.layer)}`).join('、')}</p>
              <p className="mt-1 text-[11px] text-ink-secondary">
                预算：模型 {plan.budget.maxModelRequests} · 工具 {plan.budget.maxToolCalls} · 时长 {Math.round(plan.budget.maxRunDurationMs / 1000)}s
              </p>
              <p className="mt-1 text-[11px] text-ink-secondary">prompt：{plan.promptVersion} · 模型配置：{plan.modelProfileId ?? '默认'}</p>
            </div>
          </div>
        )}
      </Card>

      <Card
        title={
          <span className="flex items-center gap-1.5">
            <ShieldAlert aria-hidden="true" className="h-4 w-4 text-pending" />
            风险（{riskSummary.label}）
          </span>
        }
        subtitle="风险数量与输入一致；零风险时这里不显示任何风险卡。默认突出前三项，阻止提交的风险始终可见。"
        actions={
          risks.length > 3 ? (
            <Button size="sm" variant="quiet" onClick={() => setShowAllRisks((value) => !value)} aria-expanded={showAllRisks}>
              {showAllRisks ? '收起' : `展开其余 ${risks.length - 3} 项`}
            </Button>
          ) : null
        }
      >
        {risks.length === 0 ? (
          <EmptyState compact title="未发现风险" description="该计划没有检测到风险；这不等于执行必然成功，仍需验证与人工接受。" icon={<FileSearch aria-hidden="true" className="h-5 w-5" />} />
        ) : (
          <ul className="space-y-1.5">
            {visibleRisks.map((risk) => (
              <RiskCard
                key={risk.id}
                risk={risk}
                expanded={expandedRiskId === risk.id}
                onToggle={() => setExpandedRiskId((current) => (current === risk.id ? null : risk.id))}
                onOpenConstraints={onOpenConstraints}
                onOpenSources={onOpenSources}
                onFocusModule={onFocusModule}
              />
            ))}
          </ul>
        )}
      </Card>

      {plan.openQuestions.length > 0 && (
        <Card title={`待决问题（${plan.openQuestions.length}）`} subtitle="问题必须有明确答案；阻塞问题未解决前不能执行计划。">
          <ul className="space-y-1">
            {plan.openQuestions.map((question) => (
              <li key={question.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5 text-xs">
                <p className="text-ink-primary">{question.question}</p>
                <p className="mt-0.5 text-[11px] text-ink-secondary">
                  {question.blocking ? '阻止提交 · ' : ''}
                  {question.reason || '需要用户确认'}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="提交计划" subtitle="提交按钮绑定计划版本与上下文快照；输入变化后按钮失效并提示重新检查。">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip>planVersion v{plan.version}</Chip>
            <Chip>{contextSnapshotId ? `contextSnapshot ${contextSnapshotId.slice(0, 8)}` : 'contextSnapshot 未就绪'}</Chip>
            <Chip>expectedRevision {task.revision}</Chip>
            <StepProgress completed={snapshot.spatial.stage.completedSteps} total={snapshot.spatial.stage.totalSteps} />
          </div>
          {(draftChanged || revisionChanged) && (
            <InlineWarning tone="pending" title="审阅后输入发生变化">
              意图草稿或任务修订号已变化，旧计划不能直接提交。请重新检查计划，或关闭预览修改输入后重新生成计划。
            </InlineWarning>
          )}
          {blockingUnresolved.length > 0 && (
            <InlineWarning tone="danger" title={`${blockingUnresolved.length} 项阻止提交的风险`}>
              硬约束冲突必须修改输入/约束，或由你明确修改约束并留下记录；不能通过“忽略”抹掉。
            </InlineWarning>
          )}
          {submitDisabledReason && <DisabledHint>{submitDisabledReason}</DisabledHint>}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="primary" size="md" busy={pending} disabledReason={submitDisabledReason} onClick={() => void submit()} icon={<ArrowRight aria-hidden="true" className="h-4 w-4" />}>
              提交并执行
            </Button>
            <Button variant="secondary" size="md" onClick={() => void recheck()} icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />}>
              重新检查计划
            </Button>
            <Button variant="ghost" size="md" onClick={onOpenConstraints} icon={<PencilLine aria-hidden="true" className="h-4 w-4" />}>
              修改约束
            </Button>
            <Button variant="ghost" size="md" onClick={onOpenSources}>
              补充证据
            </Button>
            <Button variant="ghost" size="md" onClick={() => { exitFocus(); onClose(); }}>
              返回编辑意图
            </Button>
          </div>
          {state.lastError && <p className="text-[11px] text-failed">最近错误：{state.lastError.message}</p>}
        </div>
      </Card>
    </div>
  );
}

interface RiskCardProps {
  risk: PlanRisk;
  expanded: boolean;
  onToggle: () => void;
  onOpenConstraints: () => void;
  onOpenSources: () => void;
  onFocusModule: (moduleId: string) => void;
}

function RiskCard({ risk, expanded, onToggle, onOpenConstraints, onOpenSources, onFocusModule }: RiskCardProps): JSX.Element {
  const unresolved = risk.severity === 'blocking' && risk.resolvedByDecisionId === null;
  return (
    <li className={cn('rounded border px-2 py-1.5', unresolved ? 'border-failed/40 bg-failed/[0.05]' : risk.severity === 'warning' ? 'border-pending/30 bg-pending/[0.04]' : 'border-white/10 bg-black/20')}>
      <button type="button" className="ca-focus-ring flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded text-left" onClick={onToggle} aria-expanded={expanded}>
        <StatusBadge label={riskTypeLabel(risk.type)} tone={unresolved ? 'danger' : risk.severity === 'warning' ? 'pending' : 'neutral'} ariaLabel="风险类型" />
        <StatusBadge label={severityLabel(risk.severity)} tone={severityTone(risk.severity)} ariaLabel="风险严重程度" />
        <Chip title="风险依据必须可解释">{riskBasisLabel(risk.basis)}</Chip>
        <span className="truncate text-xs font-medium text-ink-primary">{risk.title}</span>
        {risk.resolvedByDecisionId && <StatusBadge label="已有决策记录" tone="success" ariaLabel="风险处理状态" />}
      </button>
      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1.5 border-t border-white/10 pt-1.5">
          <p className="text-xs leading-5 text-ink-primary">{risk.detail}</p>
          <div>
            <p className="text-[11px] font-medium text-ink-secondary">影响模块</p>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {risk.affectedModuleIds.length === 0 && <span className="text-[11px] text-ink-secondary">未声明</span>}
              {risk.affectedModuleIds.map((moduleId) => (
                <Button key={moduleId} size="sm" variant="quiet" onClick={() => onFocusModule(moduleId)}>
                  定位 {moduleId.slice(0, 8)}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] font-medium text-ink-secondary">证据</p>
            <EvidenceRefList refs={risk.evidenceRefs} emptyLabel={risk.basis === 'explicit_unknown' ? '明确未知项：没有证据，作为未知保留' : '该风险未绑定证据'} />
          </div>
          <div>
            <p className="text-[11px] font-medium text-ink-secondary">可选处理方式（处理动作会修改真实约束/资料或重新规划）</p>
            <ul className="mt-0.5 space-y-1">
              {risk.handlingOptions.map((option) => (
                <li key={option.id} className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px]">
                  <p className="text-ink-primary">{option.label}</p>
                  {option.description && <p className="text-ink-secondary">{option.description}</p>}
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <Button size="sm" variant="quiet" onClick={onOpenConstraints}>
                      调整约束
                    </Button>
                    <Button size="sm" variant="quiet" onClick={onOpenSources}>
                      补充证据
                    </Button>
                    {risk.affectedModuleIds[0] && (
                      <Button size="sm" variant="quiet" onClick={() => onFocusModule(risk.affectedModuleIds[0]!)}>
                        查看受影响模块
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[11px] leading-4 text-ink-secondary">
            解除标准：风险依据消失（约束冲突被记录或输入补齐），且重新校验后生成新的 planVersion。风险不会自动“解决”。
          </p>
        </div>
      )}
    </li>
  );
}

export { AlertTriangle, safeJsonPreview };
