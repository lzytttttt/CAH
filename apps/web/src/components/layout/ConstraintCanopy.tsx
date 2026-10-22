/**
 * Z+1 Constraint Canopy: goal, hard constraints, dependency summary and budget.
 * Defaults to a collapsed summary; expanding it never issues a command.
 */
import type { ModuleView, Plan, TaskSnapshot } from '@ca/contracts';
import { ChevronDown, ChevronRight, Flag, Link2, SlidersHorizontal } from 'lucide-react';
import { formatStepProgress, truncateText } from '../../lib/format';
import { moduleStateLabel, moduleStateTone, planPhaseLabel, runStateLabel } from '../../lib/labels';
import type { ElevationLayer } from '../../state/viewStore';
import { Button, Chip, SectionHeading, StatusBadge, cn } from '../common/ui';

export interface ConstraintCanopyProps {
  snapshot: TaskSnapshot;
  plan: Plan | null;
  modules: ModuleView[];
  layer: ElevationLayer;
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpenConstraints: () => void;
  onOpenPlan: () => void;
  onSelectModule: (moduleId: string) => void;
}

export function ConstraintCanopy({ snapshot, plan, modules, layer, open, onToggle, onOpenConstraints, onOpenPlan, onSelectModule }: ConstraintCanopyProps): JSX.Element {
  const { task, spatial, control } = snapshot;
  const constraints = task.constraints;
  const hardConstraints = constraints.filter((constraint) => constraint.kind === 'hard');
  const conflicted = constraints.filter((constraint) => constraint.status === 'conflicted');
  const openQuestions = plan?.openQuestions ?? [];
  const blockingQuestions = openQuestions.filter((question) => question.blocking);
  const stage = spatial.stage;
  const dependencyEdges = spatial.edges.filter((edge) => edge.kind === 'dependency');

  return (
    <section className="ca-solid border-b border-white/10" aria-label="Z+1 约束区" data-layer={layer}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <button
          type="button"
          className="ca-focus-ring flex min-h-8 items-center gap-1.5 rounded px-1 text-xs font-medium text-ink-primary"
          aria-expanded={open}
          aria-controls="constraint-canopy-body"
          onClick={() => onToggle(!open)}
        >
          {open ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
          <Flag aria-hidden="true" className="h-3.5 w-3.5 text-anchor" />
          <span>约束区（Z+1）</span>
        </button>
        <span className="max-w-[26rem] truncate text-xs text-ink-secondary" title={task.intent}>
          目标：{truncateText(task.intent, 80)}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>硬约束 {hardConstraints.length}</Chip>
          {conflicted.length > 0 && <StatusBadge label={`${conflicted.length} 条约束冲突`} tone="pending" ariaLabel="约束冲突" />}
          <Chip>模块 {modules.length}（依赖 {dependencyEdges.length}）</Chip>
          {blockingQuestions.length > 0 && <StatusBadge label={`${blockingQuestions.length} 个阻止提交的问题`} tone="pending" ariaLabel="待决问题" />}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-secondary">
            {planPhaseLabel(stage.phase)} · {formatStepProgress(stage.completedSteps, stage.totalSteps)}
          </span>
          {layer === 'global' && <StatusBadge label="当前层级：Z+1 全局" tone="accent" />}
          <Chip title="服务端投影的运行预算摘要">{control.budgetLabel}</Chip>
          <Button size="sm" variant="ghost" onClick={onOpenConstraints} icon={<SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />}>
            编辑约束
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenPlan} icon={<Link2 aria-hidden="true" className="h-3.5 w-3.5" />}>
            计划与风险
          </Button>
        </div>
      </div>

      {open && (
        <div id="constraint-canopy-body" className="ca-fade-in grid gap-3 border-t border-white/10 px-3 py-2.5 md:grid-cols-2 xl:grid-cols-3">
          <div>
            <SectionHeading title="硬约束与假设" description="硬约束冲突不能通过“忽略”抹掉；需修改输入或明确修改约束。" />
            <ul className="mt-1.5 space-y-1">
              {constraints.length === 0 && <li className="text-xs text-ink-secondary">尚未登记约束。</li>}
              {constraints.map((constraint) => (
                <li key={constraint.id} className="flex items-start gap-1.5 rounded border border-white/10 bg-black/20 px-2 py-1.5">
                  <StatusBadge
                    label={constraint.kind === 'hard' ? '硬' : constraint.kind === 'preference' ? '偏好' : '假设'}
                    tone={constraint.kind === 'hard' ? 'accent' : constraint.kind === 'preference' ? 'neutral' : 'pending'}
                    ariaLabel={`约束 ${constraint.id} 类型`}
                  />
                  <div className="min-w-0">
                    <p className="text-xs leading-5 text-ink-primary">{constraint.text}</p>
                    <p className="text-[11px] text-ink-secondary">
                      {constraint.status === 'conflicted' ? '状态：冲突待处理' : constraint.status === 'confirmed' ? '状态：已确认' : constraint.status === 'waived' ? '状态：已豁免' : '状态：待确认'}
                      {constraint.note ? ` · ${constraint.note}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            {plan && plan.assumptions.length > 0 && (
              <>
                <h3 className="mt-2 text-xs font-medium text-ink-primary">计划假设（{plan.assumptions.length} 项）</h3>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px] leading-4 text-ink-secondary">
                  {plan.assumptions.map((assumption) => (
                    <li key={assumption.id}>
                      {assumption.text}
                      {assumption.needsConfirmation ? '（需确认）' : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div>
            <SectionHeading title="模块依赖摘要" description="依赖关系来自服务端投影；移动节点不会改变执行逻辑。" />
            <ul className="mt-1.5 space-y-1">
              {modules.map((view) => {
                const dependencies = view.module.dependencies
                  .map((id) => modules.find((candidate) => candidate.module.id === id)?.module.title)
                  .filter((title): title is string => Boolean(title));
                return (
                  <li key={view.module.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                    <button type="button" className="ca-focus-ring flex min-h-8 w-full items-center gap-1.5 text-left" onClick={() => onSelectModule(view.module.id)}>
                      <StatusBadge label={moduleStateLabel(view.module.status)} tone={moduleStateTone(view.module.status)} ariaLabel="模块状态" />
                      <span className="truncate text-xs text-ink-primary">{view.module.title}</span>
                    </button>
                    <p className="text-[11px] text-ink-secondary">{dependencies.length > 0 ? `依赖：${dependencies.join('、')}` : '无上游依赖'}</p>
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <SectionHeading title="待决问题与预算" description="阶段与步骤来自服务端；不显示虚假完成百分比。" />
            <ul className="mt-1.5 space-y-1">
              {openQuestions.length === 0 && <li className="text-xs text-ink-secondary">当前计划没有待决问题。</li>}
              {openQuestions.map((question) => (
                <li key={question.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5 text-xs">
                  <p className="text-ink-primary">{question.question}</p>
                  <p className="text-[11px] text-ink-secondary">
                    {question.blocking ? '阻止提交 · ' : ''}
                    {question.reason || '等待用户确认'}
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-2 rounded border border-white/10 bg-black/20 px-2 py-1.5">
              <p className="text-[11px] text-ink-secondary">运行预算</p>
              <p className="break-words text-xs text-ink-primary">{control.budgetLabel}</p>
              <p className="mt-0.5 text-[11px] text-ink-secondary">模型连接：{control.providerLabel} · 运行状态：{snapshot.activeRun ? runStateLabel(snapshot.activeRun.state) : '无活动运行'}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
