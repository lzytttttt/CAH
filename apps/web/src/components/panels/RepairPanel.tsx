/**
 * Mechanism B — blocker shields and local repair cards (1–3 per batch).
 *
 * Values are pre-validated with the shared contract helper `validateBlockResolution`
 * before being sent, affected fields/steps are declared, technical failures get a
 * recovery path instead of business choices, and leaving the panel keeps the
 * accepted version untouched.
 */
import { useMemo, useRef, useState } from 'react';
import type { Blocker, ResolutionOption, SourceSpan, TaskSnapshot } from '@ca/contracts';
import { validateBlockResolution } from '@ca/contracts';
import { AlertTriangle, ChevronLeft, ChevronRight, FileUp, RefreshCw, ShieldAlert, Wrench, X } from 'lucide-react';
import { formatBytes, formatRelativeTime, truncateText } from '../../lib/format';
import {
  affectedFieldsSummary,
  blockerBatch,
  blockerStatusLabel,
  blockerTypeLabel,
  blockerTypeTone,
  isTechnicalBlocker,
  resolutionOptionKindLabel,
  severityLabel,
  severityTone,
} from '../../lib/labels';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useCoreState } from '../../state/hooks';
import { useViewStore } from '../../state/viewStore';
import { Button, Card, Chip, EmptyState, InlineWarning, StatusBadge, TextArea, TextInput, cn } from '../common/ui';

export interface RepairPanelProps {
  snapshot: TaskSnapshot;
  initialBlockerId: string | null;
  onOpenSettings: () => void;
  onOpenEvents: () => void;
  onOpenSources: () => void;
  onFocusModule: (moduleId: string) => void;
  onClose: () => void;
}

export function RepairPanel({ snapshot, initialBlockerId, onOpenSettings, onOpenEvents, onOpenSources, onFocusModule, onClose }: RepairPanelProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const { pending } = useCommandPending();
  const repairBatch = useViewStore((view) => view.repairBatch);
  const setRepairBatch = useViewStore((view) => view.setRepairBatch);
  const focusedModuleId = useViewStore((view) => view.selectedModuleId);
  const openBlockers = snapshot.blockers.filter((blocker) => blocker.status === 'open');
  const initialBatch = useMemo(() => {
    if (!initialBlockerId) return repairBatch;
    const index = openBlockers.findIndex((blocker) => blocker.id === initialBlockerId);
    return index >= 0 ? Math.floor(index / 3) : repairBatch;
  }, [initialBlockerId, openBlockers, repairBatch]);
  const [batchIndex, setBatchIndex] = useState(initialBatch);
  const batch = blockerBatch(openBlockers, batchIndex, 3);
  const [submitted, setSubmitted] = useState<Record<string, string>>({});

  const goBatch = (next: number): void => {
    setBatchIndex(next);
    setRepairBatch(next);
  };

  if (openBlockers.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <EmptyState title="没有待处理问题" description="阻塞由真实执行与验证事实触发。当前没有等待你决策的问题；你仍可以在计划与差异面板中审阅成果。" icon={<ShieldAlert aria-hidden="true" className="h-6 w-6" />} />
        <Card title="取消本次修复">
          <p className="text-xs text-ink-secondary">修复可以随时退出；已接受成果不会被清空，草稿与运行记录会保留。</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onClose}>
            关闭修复面板
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge label={`待处理问题 ${openBlockers.length} 项`} tone="pending" ariaLabel="待处理问题数量" />
        <Chip>每批最多 3 张修复卡</Chip>
        <span className="text-[11px] text-ink-secondary">
          当前批次 {batch.batchIndex + 1}/{batch.batchCount} · 其余 {batch.moreCount} 项按批次处理
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="quiet" disabled={batch.batchIndex <= 0} onClick={() => goBatch(batch.batchIndex - 1)} aria-label="上一批问题">
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="quiet" disabled={batch.batchIndex >= batch.batchCount - 1} onClick={() => goBatch(batch.batchIndex + 1)} aria-label="下一批问题">
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <InlineWarning tone="pending" title="局部修复只会使依赖变化的下游步骤失效">
        已有明确答案的内容不会被重复询问；修复不通过时会继续显示具体原因，不播放成功动画。取消修复保留原成果。
      </InlineWarning>

      {focusedModuleId && (
        <p className="text-[11px] text-ink-secondary">
          当前选中模块：{snapshot.modules.find((view) => view.module.id === focusedModuleId)?.module.title ?? focusedModuleId}
        </p>
      )}

      {batch.items.map((blocker, index) => {
        const technical = isTechnicalBlocker(blocker.type);
        const alreadySubmitted = submitted[blocker.id];
        return (
          <Card
            key={blocker.id}
            as="section"
            ariaLabel={`修复卡 ${index + 1}：${blocker.title}`}
            className={cn(technical ? 'border-failed/40' : 'border-pending/30')}
            title={
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusBadge label={blockerTypeLabel(blocker.type)} tone={blockerTypeTone(blocker.type)} ariaLabel="问题类型" />
                <StatusBadge label={severityLabel(blocker.severity)} tone={severityTone(blocker.severity)} ariaLabel="严重程度" />
                <span className="truncate">{blocker.title}</span>
              </span>
            }
            subtitle={`${blockerStatusLabel(blocker.status)} · ${affectedFieldsSummary(blocker)} · 创建于 ${formatRelativeTime(blocker.createdAt)}`}
            actions={
              <Button size="sm" variant="ghost" onClick={onClose} aria-label="关闭修复面板（保留草稿）">
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            }
          >
            <p className="text-xs leading-5 text-ink-primary">{blocker.detail}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {blocker.affectedModuleIds.map((moduleId) => (
                <Button key={moduleId} size="sm" variant="quiet" onClick={() => onFocusModule(moduleId)}>
                  定位受影响模块 {snapshot.modules.find((view) => view.module.id === moduleId)?.module.title ?? moduleId.slice(0, 8)}
                </Button>
              ))}
              {blocker.affectedSteps.length > 0 && <Chip>受影响步骤 {blocker.affectedSteps.length} 个</Chip>}
            </div>

            {alreadySubmitted ? (
              <InlineWarning tone="success" title="已提交处理">
                处理命令已提交（{alreadySubmitted}）；页面会在服务端确认后更新。若阻塞仍未解除，会继续显示原因。
              </InlineWarning>
            ) : technical ? (
              <TechnicalRecovery blocker={blocker} onOpenSettings={onOpenSettings} onOpenEvents={onOpenEvents} onRetry={() => void core.refreshSnapshot({ quiet: false })} />
            ) : (
              <ResolutionEditor
                key={blocker.id}
                blocker={blocker}
                snapshot={snapshot}
                pending={pending}
                onSubmitted={(optionId) => setSubmitted((current) => ({ ...current, [blocker.id]: optionId }))}
              />
            )}
          </Card>
        );
      })}

      <Card title="退出修复" subtitle="取消本次修复不会改变已接受成果。">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={onClose}>
            返回工作台
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenSources}>
            绑定资料
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenEvents}>
            查看运行事件
          </Button>
          {state.lastError && <span className="text-[11px] text-failed">最近错误：{state.lastError.message}</span>}
        </div>
      </Card>
    </div>
  );
}

function TechnicalRecovery({ blocker, onOpenSettings, onOpenEvents, onRetry }: { blocker: Blocker; onOpenSettings: () => void; onOpenEvents: () => void; onRetry: () => void }): JSX.Element {
  return (
    <div className="mt-1.5 rounded border border-failed/40 bg-failed/[0.05] px-2 py-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-failed">
        <Wrench aria-hidden="true" className="h-3.5 w-3.5" /> 技术恢复入口
      </p>
      <p className="mt-0.5 text-[11px] leading-4 text-ink-secondary">
        {blocker.type === 'service_failure'
          ? '模型服务或网络故障：检查连接配置后重试；系统不会伪造业务选择，也不会自动切换供应商。'
          : '权限不足：说明所需范围后重新授权或调整方案；不会绕过权限。'}
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" onClick={onRetry} icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />}>
          重新读取状态
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpenSettings}>
          检查连接配置
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpenEvents}>
          查看失败事件
        </Button>
      </div>
    </div>
  );
}

function ResolutionEditor({ blocker, snapshot, pending, onSubmitted }: { blocker: Blocker; snapshot: TaskSnapshot; pending: boolean; onSubmitted: (optionId: string) => void }): JSX.Element {
  const core = useCore();
  const [optionId, setOptionId] = useState(blocker.resolutions[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const option = blocker.resolutions.find((candidate) => candidate.id === optionId) ?? blocker.resolutions[0]!;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const value = values[option.id];
  const validation = option ? validateBlockResolution(option, value) : { ok: false, error: '没有可用处理选项', normalized: null };

  const submit = async (): Promise<void> => {
    if (!option) return;
    const checked = validateBlockResolution(option, value);
    if (!checked.ok) {
      setError(checked.error ?? '输入不合法');
      return;
    }
    setError(null);
    const envelope = commandEnvelope(snapshot.task.revision);
    const result = await core.runCommand(
      '提交修复',
      (client) =>
        client.resolveInput(blocker.runId, {
          ...envelope,
          expectedRevision: snapshot.task.revision,
          blockerId: blocker.id,
          optionId: option.id,
          value: checked.normalized,
          note: '',
        }),
      { successNotice: '修复已提交：后端会重新校验解除条件。' },
    );
    if (result) onSubmitted(option.id);
  };

  return (
    <div className="mt-1.5 flex flex-col gap-2 rounded border border-white/10 bg-black/20 px-2 py-1.5">
      <div>
        <p className="text-[11px] font-medium text-ink-secondary">选择处理方式</p>
        <ul className="mt-1 space-y-1">
          {blocker.resolutions.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className={cn(
                  'ca-focus-ring flex min-h-10 w-full items-start gap-2 rounded border px-2 py-1.5 text-left',
                  candidate.id === option.id ? 'border-anchor/50 bg-anchor/[0.05]' : 'border-white/10 hover:border-white/25',
                )}
                onClick={() => {
                  setOptionId(candidate.id);
                  setError(null);
                }}
                aria-pressed={candidate.id === option.id}
              >
                <span aria-hidden="true" className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', candidate.id === option.id ? 'bg-anchor' : 'bg-white/20')} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Chip>{resolutionOptionKindLabel(candidate.kind)}</Chip>
                    <span className="text-xs text-ink-primary">{candidate.label}</span>
                    {'required' in candidate && candidate.required === false && <Chip>可选</Chip>}
                  </span>
                  {candidate.detail && <span className="mt-0.5 block text-[11px] leading-4 text-ink-secondary">{candidate.detail}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {option && (
        <div>
          <p className="text-[11px] font-medium text-ink-secondary">填写处理内容（提交前按契约校验）</p>
          <div className="mt-1">
            <OptionInput blocker={blocker} option={option} snapshot={snapshot} value={value} onChange={(next) => setValues((current) => ({ ...current, [option.id]: next }))} />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[11px] text-failed">
          {error}
        </p>
      )}
      {!validation.ok && !error && <p className="text-[11px] text-ink-secondary">{validation.error}</p>}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="md" variant="primary" busy={pending} disabledReason={!validation.ok ? validation.error : null} onClick={() => void submit()}>
          提交处理
        </Button>
        <Button size="md" variant="ghost" onClick={() => setValues((current) => ({ ...current, [option.id]: undefined }))}>
          清空输入
        </Button>
        <span className="text-[11px] text-ink-secondary">用户的回答会写入决策记录；输入无效时不会解除阻塞。</span>
      </div>
    </div>
  );
}

function OptionInput({
  blocker,
  option,
  snapshot,
  value,
  onChange,
}: {
  blocker: Blocker;
  option: ResolutionOption;
  snapshot: TaskSnapshot;
  value: unknown;
  onChange: (next: unknown) => void;
}): JSX.Element {
  switch (option.kind) {
    case 'choose': {
      const selected = typeof value === 'string' ? value : null;
      return (
        <div role="radiogroup" aria-label={option.label} className="space-y-1">
          {option.options.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected === choice.value}
              className={cn('ca-focus-ring flex min-h-10 w-full items-start gap-2 rounded border px-2 py-1.5 text-left text-xs', selected === choice.value ? 'border-anchor/50 bg-anchor/[0.05]' : 'border-white/10 hover:border-white/25')}
              onClick={() => onChange(choice.value)}
            >
              <span aria-hidden="true" className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', selected === choice.value ? 'bg-anchor' : 'bg-white/20')} />
              <span>
                <span className="block text-ink-primary">{choice.label}</span>
                {choice.description && <span className="block text-[11px] text-ink-secondary">{choice.description}</span>}
              </span>
            </button>
          ))}
        </div>
      );
    }
    case 'text': {
      const text = typeof value === 'string' ? value : '';
      return (
        <div className="flex flex-col gap-1">
          <TextArea
            value={text}
            onChange={(event) => onChange(event.target.value)}
            placeholder={option.placeholder || '请输入处理内容'}
            aria-label={option.label}
            maxLength={option.maxChars}
            className={option.multiline ? '' : 'min-h-[64px]'}
          />
          <span className="text-[11px] text-ink-secondary">
            {text.trim().length}/{option.maxChars} 字符{option.required ? ' · 必填' : ' · 可选'}
          </span>
        </div>
      );
    }
    case 'bind_source':
      return <SourceBinder blocker={blocker} option={option} snapshot={snapshot} value={value} onChange={onChange} />;
    case 'confirm_mapping': {
      const confirmed = Boolean(value && typeof value === 'object' && (value as { confirmed?: boolean }).confirmed);
      return (
        <div className="flex flex-col gap-1.5">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-ink-secondary">
                <th className="border-b border-white/10 py-1 pr-2">来源字段</th>
                <th className="border-b border-white/10 py-1 pr-2">目标字段</th>
                <th className="border-b border-white/10 py-1">说明</th>
              </tr>
            </thead>
            <tbody>
              {option.mappingPreview.map((mapping, index) => (
                <tr key={`${mapping.from}-${index}`} className="text-ink-primary">
                  <td className="border-b border-white/5 py-0.5 pr-2 font-mono">{mapping.from}</td>
                  <td className="border-b border-white/5 py-0.5 pr-2 font-mono">{mapping.to}</td>
                  <td className="border-b border-white/5 py-0.5 text-ink-secondary">{mapping.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="flex min-h-10 items-center gap-2 text-xs text-ink-primary">
            <input type="checkbox" className="h-4 w-4 accent-anchor" checked={confirmed} onChange={(event) => onChange({ confirmed: event.target.checked })} />
            我确认以上字段映射口径（会写入配方指纹）
          </label>
        </div>
      );
    }
    case 'exclude': {
      const confirmed = Boolean(value && typeof value === 'object' && (value as { itemRef?: string }).itemRef);
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-ink-primary">待排除：{option.itemLabel}</p>
          <p className="text-[11px] text-ink-secondary">引用：{option.itemRef || '（后端默认引用）'}</p>
          <label className="flex min-h-10 items-center gap-2 text-xs text-ink-primary">
            <input type="checkbox" className="h-4 w-4 accent-anchor" checked={confirmed} onChange={(event) => onChange({ itemRef: option.itemRef || 'excluded', confirmed: event.target.checked })} />
            确认排除该条目并记录原因
          </label>
        </div>
      );
    }
  }
}

function SourceBinder({ blocker, option, snapshot, value, onChange }: { blocker: Blocker; option: Extract<ResolutionOption, { kind: 'bind_source' }>; snapshot: TaskSnapshot; value: unknown; onChange: (next: unknown) => void }): JSX.Element {
  const core = useCore();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selected = value && typeof value === 'object' ? (value as { sourceId?: string; version?: number }) : {};
  const spansBySource = useMemo(() => {
    const map = new Map<string, SourceSpan[]>();
    for (const span of snapshot.spans) {
      const list = map.get(span.sourceId) ?? [];
      list.push(span);
      map.set(span.sourceId, list);
    }
    return map;
  }, [snapshot.spans]);

  const upload = async (file: File): Promise<void> => {
    setUploadError(null);
    setNote(null);
    const name = file.name.toLowerCase();
    if (!/\.(md|markdown|txt|json|csv)$/.test(name)) {
      setUploadError('首版仅支持 UTF-8 TXT / Markdown / JSON / CSV；该文件不会被上传。');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(`单文件不能超过 10 MiB（当前 ${formatBytes(file.size)}）。`);
      return;
    }
    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      const contentBase64 = btoa(binary);
      const envelope = commandEnvelope(snapshot.task.revision);
      const result = await core.runCommand(
        '导入资料',
        (client) => client.importSource(snapshot.task.id, { ...envelope, fileName: file.name, mime: file.type || guessMime(file.name), contentBase64, origin: 'upload' }),
        { successNotice: '资料已导入。' },
      );
      if (result) {
        if (result.parseStatus === 'parsed') {
          onChange({ sourceId: result.sourceId, version: result.version });
          setNote(`已导入并绑定：${file.name} v${result.version}${result.warnings.length > 0 ? ` · ${result.warnings.join('；')}` : ''}`);
        } else {
          setUploadError(`导入结果：${result.parseStatus} · ${result.parseNote}`);
        }
      } else {
        setUploadError('导入失败，详见顶部错误提示。');
      }
    } catch (error) {
      setUploadError(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] text-ink-secondary">
        需要绑定的资料用途：{option.purpose || '未声明'} · 接受类型：{option.acceptsMime.length > 0 ? option.acceptsMime.join('、') : '未限制'}
      </p>
      <div role="radiogroup" aria-label="选择要绑定的资料版本" className="space-y-1">
        {snapshot.sources.map((source) => {
          const isSelected = selected.sourceId === source.sourceId;
          const spans = spansBySource.get(source.sourceId) ?? [];
          return (
            <button
              key={source.sourceId}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={cn('ca-focus-ring flex min-h-10 w-full items-start justify-between gap-2 rounded border px-2 py-1.5 text-left', isSelected ? 'border-anchor/50 bg-anchor/[0.05]' : 'border-white/10 hover:border-white/25')}
              onClick={() => onChange({ sourceId: source.sourceId, version: source.version })}
            >
              <span className="min-w-0">
                <span className="block truncate text-xs text-ink-primary">{source.name}</span>
                <span className="block text-[11px] text-ink-secondary">
                  v{source.version} · {source.spanCount} 个片段 · {source.availability === 'available' ? '可用' : source.availability}
                  {spans.length > 0 ? ` · ${truncateText(spans[0]!.excerpt, 48)}` : ''}
                </span>
              </span>
              {isSelected && <Chip>已选择</Chip>}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.txt,.json,.csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button size="sm" variant="secondary" busy={uploading} onClick={() => inputRef.current?.click()} icon={<FileUp aria-hidden="true" className="h-3.5 w-3.5" />}>
          选择文件并导入
        </Button>
        <Button size="sm" variant="ghost" onClick={() => inputRef.current?.click()}>
          选择输入…
        </Button>
        <span className="text-[11px] text-ink-secondary">拖拽不是唯一方式；这里始终提供显式按钮。</span>
      </div>
      {note && <p className="text-[11px] text-accepted">{note}</p>}
      {uploadError && (
        <p role="alert" className="text-[11px] text-failed">
          {uploadError}
        </p>
      )}
      {blocker.evidenceRefs.length > 0 && <p className="text-[11px] text-ink-secondary">该问题附带 {blocker.evidenceRefs.length} 条证据引用，可在差异审阅或证据区查看。</p>}
    </div>
  );
}

function guessMime(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  return 'text/plain';
}

export { AlertTriangle, TextInput };
