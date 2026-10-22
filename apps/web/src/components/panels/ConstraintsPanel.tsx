/**
 * Constraints & module-graph editor (Z+1 actions).
 *
 * Editing constraints, module titles, order, acceptance criteria and
 * dependencies is a real task command (`PATCH /api/tasks/:id`) guarded by
 * expectedRevision. Cycles are rejected client-side before submitting; the
 * server re-validates and invalidates dependent plans/recipes.
 */
import { useMemo, useState } from 'react';
import type { Constraint, TaskSnapshot } from '@ca/contracts';
import { AlertTriangle, Plus, Save, Trash2 } from 'lucide-react';
import { truncateText } from '../../lib/format';
import {
  buildModuleUpdates,
  emptyConstraint,
  moduleEditStateFromViews,
  nextConstraintId,
  removeConstraint,
  upsertConstraint,
  validateModuleGraphEdit,
  type ModuleEditState,
} from '../../lib/taskGraph';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore } from '../../state/hooks';
import { Button, Card, Chip, Field, Select, StatusBadge, TextArea, TextInput, cn } from '../common/ui';

const LAYERS: Array<'L0' | 'L1' | 'L2' | 'L3' | 'L4'> = ['L0', 'L1', 'L2', 'L3', 'L4'];
const KINDS: Array<Constraint['kind']> = ['hard', 'preference', 'assumption'];
const STATUSES: Array<Constraint['status']> = ['open', 'confirmed', 'conflicted', 'waived'];

export interface ConstraintsPanelProps {
  snapshot: TaskSnapshot;
  onClose: () => void;
}

export function ConstraintsPanel({ snapshot, onClose }: ConstraintsPanelProps): JSX.Element {
  const core = useCore();
  const { pending } = useCommandPending();
  const [constraints, setConstraints] = useState<Constraint[]>(() => snapshot.task.constraints.map((constraint) => ({ ...constraint })));
  const [moduleEdits, setModuleEdits] = useState<ModuleEditState[]>(() => moduleEditStateFromViews(snapshot.modules));
  const [intentDraft, setIntentDraft] = useState(snapshot.task.intent);
  const [titleDraft, setTitleDraft] = useState(snapshot.task.title);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const knownModuleIds = useMemo(() => moduleEdits.map((module) => module.moduleId), [moduleEdits]);
  const graphErrors = validateModuleGraphEdit(moduleEdits.map((module) => ({ id: module.moduleId, dependencies: module.dependencies })));
  const dirty =
    JSON.stringify(constraints) !== JSON.stringify(snapshot.task.constraints) ||
    JSON.stringify(moduleEdits) !== JSON.stringify(moduleEditStateFromViews(snapshot.modules)) ||
    intentDraft !== snapshot.task.intent ||
    titleDraft !== snapshot.task.title;

  const save = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    if (graphErrors.length > 0) {
      setError(graphErrors.join('；'));
      return;
    }
    if (titleDraft.trim().length === 0 || intentDraft.trim().length === 0) {
      setError('任务标题与意图不能为空。');
      return;
    }
    const envelope = commandEnvelope(snapshot.task.revision);
    const result = await core.runCommand(
      '更新任务定义',
      (client) =>
        client.updateTask(snapshot.task.id, {
          ...envelope,
          expectedRevision: snapshot.task.revision,
          title: titleDraft.trim().slice(0, 200),
          intent: intentDraft.trim().slice(0, 8000),
          constraints,
          modules: buildModuleUpdates(moduleEdits),
        }),
      { successNotice: '任务定义已更新；相关计划与配方可能已过期，需要重新检查。' },
    );
    if (result) {
      setMessage('已保存。依赖变更后，旧计划与配方可能被标记过期；请在计划预览与配方面板重新检查。');
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Card title="任务目标" subtitle="修改目标或约束会影响后续计划的触发条件与风险分析。">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="任务标题" htmlFor="task-title-edit" required>
            <TextInput id="task-title-edit" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} maxLength={200} />
          </Field>
          <Field label="交付物名称（只读）" htmlFor="artifact-title" help="交付物名称在创建任务时确定。">
            <TextInput id="artifact-title" value={snapshot.artifact.title} readOnly />
          </Field>
        </div>
        <Field label="任务意图" htmlFor="task-intent-edit" required help="意图变化会使已生成的计划与配方过期。">
          <TextArea id="task-intent-edit" value={intentDraft} onChange={(event) => setIntentDraft(event.target.value)} maxLength={8000} />
        </Field>
      </Card>

      <Card
        title={`约束（${constraints.length}）`}
        subtitle="硬约束冲突不能通过“忽略”抹掉；需修改输入、缩小范围或明确修改约束并留下记录。"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setConstraints((current) => [...current, emptyConstraint(nextConstraintId(current))])} icon={<Plus aria-hidden="true" className="h-3.5 w-3.5" />}>
            新增约束
          </Button>
        }
      >
        <ul className="space-y-1.5">
          {constraints.length === 0 && <li className="text-xs text-ink-secondary">尚未登记约束。</li>}
          {constraints.map((constraint, index) => (
            <li key={`${constraint.id}-${index}`} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip>{constraint.id}</Chip>
                <span className="w-28">
                  <Select
                    aria-label={`约束 ${index + 1} 类型`}
                    value={constraint.kind}
                    onChange={(event) =>
                      setConstraints((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, kind: event.target.value as Constraint['kind'] } : item)))
                    }
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind === 'hard' ? '硬约束' : kind === 'preference' ? '偏好' : '假设'}
                      </option>
                    ))}
                  </Select>
                </span>
                <span className="w-28">
                  <Select
                    aria-label={`约束 ${index + 1} 状态`}
                    value={constraint.status}
                    onChange={(event) =>
                      setConstraints((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, status: event.target.value as Constraint['status'] } : item)))
                    }
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status === 'open' ? '待确认' : status === 'confirmed' ? '已确认' : status === 'conflicted' ? '冲突' : '已豁免'}
                      </option>
                    ))}
                  </Select>
                </span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConstraints((current) => removeConstraint(current, constraint.id))} aria-label={`删除约束 ${constraint.id}`}>
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </div>
              <TextInput
                className="mt-1"
                value={constraint.text}
                onChange={(event) => setConstraints((current) => upsertConstraint(current, { ...constraint, text: event.target.value }))}
                maxLength={2000}
                aria-label={`约束 ${index + 1} 内容`}
                placeholder="约束内容"
              />
              <TextInput
                className="mt-1"
                value={constraint.note}
                onChange={(event) => setConstraints((current) => upsertConstraint(current, { ...constraint, note: event.target.value }))}
                maxLength={1000}
                aria-label={`约束 ${index + 1} 备注`}
                placeholder="备注（可选）"
              />
            </li>
          ))}
        </ul>
        {constraints.some((constraint) => constraint.status === 'conflicted' && constraint.kind === 'hard') && (
          <p className="mt-1.5 text-[11px] text-pending">存在硬约束冲突：提交计划前必须修改范围/输入，或显式修改约束并记录决策。</p>
        )}
      </Card>

      <Card title="模块结构" subtitle="模块为 1–8 个；依赖关系必须无环。移动画布节点不会改变执行逻辑。">
        {graphErrors.length > 0 && (
          <p role="alert" className="mb-1.5 rounded border border-failed/40 bg-failed/[0.05] px-2 py-1 text-[11px] text-failed">
            {graphErrors.join('；')}
          </p>
        )}
        <ul className="space-y-1.5">
          {moduleEdits.map((module, index) => (
            <li key={module.moduleId} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
              <div className="flex flex-wrap items-end gap-1.5">
                <div className="min-w-[10rem] flex-1">
                  <Field label={`模块 ${index + 1} 名称`} htmlFor={`module-title-${module.moduleId}`}>
                    <TextInput
                      id={`module-title-${module.moduleId}`}
                      value={module.title}
                      onChange={(event) => setModuleEdits((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, title: event.target.value } : item)))}
                      maxLength={200}
                    />
                  </Field>
                </div>
                <div className="w-20">
                  <Field label="顺序" htmlFor={`module-order-${module.moduleId}`}>
                    <TextInput
                      id={`module-order-${module.moduleId}`}
                      type="number"
                      min={0}
                      max={7}
                      value={module.order}
                      onChange={(event) => setModuleEdits((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, order: Number(event.target.value) } : item)))}
                    />
                  </Field>
                </div>
                <StatusBadge label={snapshot.modules[index]?.module.status ?? '未知'} tone="neutral" ariaLabel="模块状态" />
              </div>
              <div className="mt-1">
                <p className="text-[11px] text-ink-secondary">依赖模块（不能形成环）</p>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {moduleEdits.map((candidate) =>
                    candidate.moduleId === module.moduleId ? null : (
                      <label key={candidate.moduleId} className="flex min-h-8 items-center gap-1 rounded border border-white/10 bg-black/20 px-1.5 text-[11px] text-ink-primary">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-anchor"
                          checked={module.dependencies.includes(candidate.moduleId)}
                          onChange={(event) =>
                            setModuleEdits((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      dependencies: event.target.checked
                                        ? [...item.dependencies, candidate.moduleId]
                                        : item.dependencies.filter((id) => id !== candidate.moduleId),
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                        {truncateText(candidate.title, 20)}
                      </label>
                    ),
                  )}
                </div>
              </div>
              <div className="mt-1">
                <p className="text-[11px] text-ink-secondary">验收标准</p>
                <ul className="space-y-0.5">
                  {module.acceptanceCriteria.map((criterion, criterionIndex) => (
                    <li key={`${module.moduleId}-criterion-${criterionIndex}`} className="flex flex-wrap items-center gap-1">
                      <span className="w-20">
                        <Select
                          aria-label={`验收标准 ${criterionIndex + 1} 层级`}
                          value={criterion.layer}
                          onChange={(event) =>
                            setModuleEdits((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, acceptanceCriteria: item.acceptanceCriteria.map((entry, entryIndex) => (entryIndex === criterionIndex ? { ...entry, layer: event.target.value as 'L0' | 'L1' | 'L2' | 'L3' | 'L4' } : entry)) }
                                  : item,
                              ),
                            )
                          }
                        >
                          {LAYERS.map((layer) => (
                            <option key={layer} value={layer}>
                              {layer}
                            </option>
                          ))}
                        </Select>
                      </span>
                      <TextInput
                        className="flex-1"
                        value={criterion.text}
                        aria-label={`验收标准 ${criterionIndex + 1} 内容`}
                        onChange={(event) =>
                          setModuleEdits((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, acceptanceCriteria: item.acceptanceCriteria.map((entry, entryIndex) => (entryIndex === criterionIndex ? { ...entry, text: event.target.value } : entry)) }
                                : item,
                            ),
                          )
                        }
                        maxLength={2000}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="删除验收标准"
                        onClick={() =>
                          setModuleEdits((current) =>
                            current.map((item, itemIndex) => (itemIndex === index ? { ...item, acceptanceCriteria: item.acceptanceCriteria.filter((_, entryIndex) => entryIndex !== criterionIndex) } : item)),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setModuleEdits((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, acceptanceCriteria: [...item.acceptanceCriteria, { id: `ac-${item.acceptanceCriteria.length + 1}`, text: '', layer: 'L3' }] }
                          : item,
                      ),
                    )
                  }
                  icon={<Plus aria-hidden="true" className="h-3 w-3" />}
                >
                  添加标准
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[11px] text-ink-secondary">依赖变更、约束变更或任务意图变化后，相关计划与配方会过期；保存后请在计划预览中重新检查。</p>
      </Card>

      <Card title="提交修改" subtitle="本次修改使用 expectedRevision 做并发保护；冲突时不会覆盖他人的更新。">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>expectedRevision {snapshot.task.revision}</Chip>
          <Chip>模块 {knownModuleIds.length} 个</Chip>
          {dirty && <StatusBadge label="有未提交修改" tone="pending" />}
          {error && <span role="alert" className="text-[11px] text-failed">{error}</span>}
          {message && <span className="text-[11px] text-accepted">{message}</span>}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button
            size="md"
            variant="primary"
            busy={pending}
            disabledReason={!dirty ? '没有需要保存的修改。' : graphErrors.length > 0 ? '依赖关系存在错误，请先修正。' : null}
            onClick={() => void save()}
            icon={<Save aria-hidden="true" className="h-4 w-4" />}
          >
            保存任务定义
          </Button>
          <Button
            size="md"
            variant="ghost"
            onClick={() => {
              setConstraints(snapshot.task.constraints.map((constraint) => ({ ...constraint })));
              setModuleEdits(moduleEditStateFromViews(snapshot.modules));
              setIntentDraft(snapshot.task.intent);
              setTitleDraft(snapshot.task.title);
              setError(null);
              setMessage(null);
            }}
          >
            撤销未提交修改
          </Button>
          <Button size="md" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        {snapshot.task.constraints.some((constraint) => constraint.status === 'conflicted') && (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-pending">
            <AlertTriangle aria-hidden="true" className="h-3 w-3" /> 当前仍有冲突约束；硬约束冲突不处理时计划不能提交。
          </p>
        )}
      </Card>
    </div>
  );
}
