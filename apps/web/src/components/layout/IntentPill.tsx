/**
 * Intent Pill: per selected module multiline intent, attachment entry, the
 * sources that will be used, and the real submit action (createRun command).
 */
import { useMemo, useState } from 'react';
import type { ModuleView, TaskSnapshot } from '@ca/contracts';
import { Paperclip, Send, ShieldQuestion, X } from 'lucide-react';
import { formatNumber } from '../../lib/format';
import { moduleStateLabel, moduleStateTone, trustLevelLabel } from '../../lib/labels';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useCoreState } from '../../state/hooks';
import { readIntentDraft, useViewStore } from '../../state/viewStore';
import { Button, Card, Chip, StatusBadge, TextArea, Toggle, cn } from '../common/ui';

export interface IntentPillProps {
  task: TaskSnapshot['task'];
  modules: ModuleView[];
  onOpenSources: () => void;
  onOpenPlan: () => void;
  onSelectModule: (moduleId: string) => void;
}

export function IntentPill({ task, modules, onOpenSources, onOpenPlan, onSelectModule }: IntentPillProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const { pending } = useCommandPending();
  const selectedModuleId = useViewStore((view) => view.selectedModuleId);
  const draft = useViewStore((view) => readIntentDraft(view, task.id, selectedModuleId));
  const planFirst = useViewStore((view) => view.planFirst);
  const intentSourceIds = useViewStore((view) => view.intentSourceIds);
  const setIntentDraft = useViewStore((view) => view.setIntentDraft);
  const clearIntentDraft = useViewStore((view) => view.clearIntentDraft);
  const setPlanFirst = useViewStore((view) => view.setPlanFirst);
  const toggleIntentSource = useViewStore((view) => view.toggleIntentSource);
  const clearIntentSources = useViewStore((view) => view.clearIntentSources);
  const openPanel = useViewStore((view) => view.openPanel);
  const reducedMotion = useViewStore((view) => view.reducedMotion);
  const [showScope, setShowScope] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedModule = modules.find((view) => view.module.id === selectedModuleId) ?? null;
  const sources = state.snapshot?.sources ?? [];
  const selectedSources = useMemo(() => sources.filter((source) => intentSourceIds.includes(source.sourceId)), [sources, intentSourceIds]);
  const trimmed = draft.trim();
  const disabledReason = useMemo(() => {
    if (pending) return '有命令正在处理中，请等待完成。';
    if (!selectedModule) return '请先在中心锚点选择一个目标模块。';
    if (selectedModule.module.status === 'blocked') return '目标模块当前受阻，请先在待处理问题中补齐输入。';
    if (trimmed.length < 2) return '请输入至少 2 个字符的意图描述。';
    if (trimmed.length > 8000) return '意图不能超过 8000 字符。';
    return null;
  }, [pending, selectedModule, trimmed]);

  const submit = async (): Promise<void> => {
    if (disabledReason || !selectedModule) return;
    const envelope = commandEnvelope(task.revision);
    const result = await core.runCommand(
      '发起运行',
      (client) =>
        client.createRun(task.id, {
          ...envelope,
          expectedRevision: task.revision,
          moduleId: selectedModule.module.id,
          intent: trimmed,
          planFirst,
          sourceIds: intentSourceIds.length > 0 ? intentSourceIds : undefined,
        }),
      { successNotice: '运行已创建：等待后端生成计划与风险预览。' },
    );
    if (result) {
      clearIntentDraft(task.id, selectedModule.module.id);
      setLocalError(null);
      openPanel('plan');
    } else {
      setLocalError('运行创建失败；意图草稿已保留，可修正后重试。具体错误见顶部提示。');
    }
  };

  return (
    <Card
      as="section"
      className={cn('min-w-0', 'ca-glass')}
      ariaLabel="意图输入区"
      title={
        <span className="flex items-center gap-1.5">
          <Send aria-hidden="true" className="h-4 w-4 text-anchor" />
          意图胶囊
          {selectedModule ? (
            <span className="truncate text-xs font-normal text-ink-secondary">目标模块：{selectedModule.module.title}</span>
          ) : (
            <span className="text-xs font-normal text-ink-secondary">未选择目标模块</span>
          )}
        </span>
      }
      actions={
        selectedModule ? (
          <StatusBadge label={moduleStateLabel(selectedModule.module.status)} tone={moduleStateTone(selectedModule.module.status)} ariaLabel="目标模块状态" />
        ) : null
      }
    >
      {!selectedModule ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-ink-secondary">从中心锚点选择一个模块作为本次交付目标；没有选中对象时界面仍保留新建/选择入口。</p>
          <div className="flex flex-wrap gap-1">
            {modules.map((view) => (
              <Button key={view.module.id} size="sm" variant="secondary" onClick={() => onSelectModule(view.module.id)}>
                {view.module.title}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor="intent-editor" className="ca-sr-only">
            意图描述
          </label>
          <TextArea
            id="intent-editor"
            value={draft}
            onChange={(event) => {
              setIntentDraft(task.id, selectedModule.module.id, event.target.value);
              setLocalError(null);
            }}
            placeholder="描述要达成的成果、输入范围与约束；支持粘贴长文本与中文编辑。Enter 在按钮上执行，Escape 关闭面板并保留草稿。"
            aria-describedby="intent-help"
            maxLength={8000}
            className="min-h-[92px] border-white/15 bg-black/25"
          />
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-secondary" id="intent-help">
            <span className="ca-tabular">{formatNumber(draft.length)}/8000 字符</span>
            <span>目标：{selectedModule.module.title}</span>
            {selectedModule.acceptance.acceptedVersionId ? <span>基线版本 {selectedModule.acceptance.acceptedVersionId.slice(0, 8)}</span> : <span>尚无已接受基线（首次生成）</span>}
            <span>资料：{selectedSources.length} 个已选</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="quiet" onClick={onOpenSources} icon={<Paperclip aria-hidden="true" className="h-3.5 w-3.5" />}>
              附件 / 选择输入
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setShowScope((value) => !value)} aria-expanded={showScope} icon={<ShieldQuestion aria-hidden="true" className="h-3.5 w-3.5" />}>
              查看请求范围
            </Button>
            <Button size="sm" variant="quiet" onClick={onOpenPlan}>
              计划与风险
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Toggle label="先生成计划（推荐）" checked={planFirst} onChange={setPlanFirst} help="复杂或跨依赖任务应先看计划；简单只读操作可关闭。" />
              <Button size="md" variant="primary" busy={pending} disabledReason={disabledReason} onClick={() => void submit()} icon={<Send aria-hidden="true" className="h-4 w-4" />}>
                提交并执行
              </Button>
            </div>
          </div>

          {selectedSources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-ink-secondary">将使用的资料：</span>
              {selectedSources.map((source) => (
                <span key={source.sourceId} className="inline-flex items-center gap-1 rounded border border-white/15 bg-black/20 px-1.5 py-0.5 text-[11px] text-ink-primary">
                  {source.name}
                  <span className="text-ink-secondary">（{trustLevelLabel(source.trustLevel)}）</span>
                  <button
                    type="button"
                    className="ca-focus-ring rounded p-0.5 text-ink-secondary hover:text-ink-primary"
                    onClick={() => toggleIntentSource(source.sourceId)}
                    aria-label={`移除资料 ${source.name}`}
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <Button size="sm" variant="ghost" onClick={clearIntentSources}>
                清空
              </Button>
            </div>
          )}

          {showScope && (
            <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] leading-4 text-ink-secondary">
              <p>请求范围（提交时由后端校验）：</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                <li>目标模块：{selectedModule.module.title}（{selectedModule.module.kind}）</li>
                <li>预期任务修订号：{task.revision}（expectedRevision）</li>
                <li>计划优先：{planFirst ? '是' : '否（只允许简单只读路径，后端仍会校验触发条件）'}</li>
                <li>资料版本：{selectedSources.length > 0 ? selectedSources.map((source) => `${source.name} v${source.version}`).join('、') : '使用任务默认资料'}</li>
                <li>提交时生成唯一 commandId 以保证幂等；重复提交会返回同一结果或当前操作状态。</li>
              </ul>
            </div>
          )}

          {localError && (
            <p role="alert" className="text-[11px] leading-4 text-failed">
              {localError}
            </p>
          )}
          {reducedMotion && <p className="text-[10px] text-ink-secondary">已启用减少动态效果：界面过渡关闭，业务步骤不变。</p>}
          <Chip className="self-start" title="模型连接与预算由服务端控制">
            预算与模型连接由后端控制 · 提交不代表成功
          </Chip>
        </div>
      )}
    </Card>
  );
}
