/**
 * Event diagnostics + read-only replay.
 *
 * Events are recorded business events from the server snapshot / SSE stream.
 * Replay only moves a view cursor over the recorded list; it never re-executes
 * tools or model calls and never changes business state.
 */
import { useMemo, useState } from 'react';
import type { TaskSnapshot } from '@ca/contracts';
import { ListTree, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { formatTimestamp, safeJsonPreview } from '../../lib/format';
import { eventCategoryLabel, eventTypeLabel, runStateLabel, runStateTone } from '../../lib/labels';
import { useCore, useCoreState } from '../../state/hooks';
import { useViewStore } from '../../state/viewStore';
import { Button, Card, Chip, EmptyState, ErrorNotice, LoadingBlock, Select, StatusBadge, TextInput, cn } from '../common/ui';

export interface EventsPanelProps {
  snapshot: TaskSnapshot;
  initialRunId: string | null;
  onClose: () => void;
}

export function EventsPanel({ snapshot, initialRunId, onClose }: EventsPanelProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const replay = useViewStore((view) => view.replay);
  const setReplay = useViewStore((view) => view.setReplay);
  const filters = useViewStore((view) => view.filters);
  const setFilters = useViewStore((view) => view.setFilters);
  const events = state.events.length > 0 ? state.events : snapshot.events;
  const [selectedEventId, setSelectedEventId] = useState<string | null>(events[events.length - 1]?.eventId ?? null);
  const [runDetail, setRunDetail] = useState<Awaited<ReturnType<typeof core.client.getRunDetail>> | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const runIds = useMemo(() => [...new Set([...snapshot.runs.map((run) => run.runId), snapshot.activeRun?.runId ?? ''].filter(Boolean))], [snapshot.runs, snapshot.activeRun]);
  const [runId, setRunId] = useState(initialRunId ?? runIds[0] ?? '');

  const filtered = useMemo(() => {
    const query = filters.eventQuery.trim().toLowerCase();
    return events.filter((event) => {
      if (filters.eventCategory !== 'all' && event.category !== filters.eventCategory) return false;
      if (!query) return true;
      return event.type.toLowerCase().includes(query) || event.eventId.toLowerCase().includes(query) || JSON.stringify(event.payload).toLowerCase().includes(query);
    });
  }, [events, filters.eventCategory, filters.eventQuery]);

  const cursorIndex = replay.cursorSeq == null ? filtered.length - 1 : Math.max(0, filtered.findIndex((event) => event.seq >= (replay.cursorSeq ?? 0)));
  const effectiveIndex = replay.enabled ? cursorIndex : filtered.length - 1;
  const visible = replay.enabled ? filtered.slice(0, effectiveIndex + 1) : filtered;
  const selected = visible.find((event) => event.eventId === selectedEventId) ?? visible[visible.length - 1] ?? null;

  const toggleReplay = (): void => {
    if (replay.enabled) {
      setReplay({ enabled: false, cursorSeq: null });
    } else {
      setReplay({ enabled: true, cursorSeq: visible[visible.length - 1]?.seq ?? null });
    }
  };
  const step = (direction: -1 | 1): void => {
    if (!replay.enabled || visible.length === 0) return;
    const index = Math.min(Math.max(0, effectiveIndex + direction), filtered.length - 1);
    setReplay({ enabled: true, cursorSeq: filtered[index]?.seq ?? null });
  };

  const loadRun = async (): Promise<void> => {
    if (!runId) return;
    setRunLoading(true);
    setRunError(null);
    const detail = await core.read('读取运行详情', (client) => client.getRunDetail(runId));
    setRunLoading(false);
    if (!detail) {
      setRunError('运行详情读取失败；事件列表仍可查看。');
      return;
    }
    setRunDetail(detail);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Card
        title="历史回放（只读）"
        subtitle="回放只移动视图游标，不重新执行模型/工具，不改变业务状态。"
        actions={
          <div className="flex flex-wrap items-center gap-1">
            <StatusBadge label={replay.enabled ? '回放中' : '实时事件'} tone={replay.enabled ? 'prospect' : 'accent'} ariaLabel="回放状态" />
            <Button size="sm" variant="quiet" onClick={toggleReplay} icon={replay.enabled ? <Pause aria-hidden="true" className="h-3.5 w-3.5" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}>
              {replay.enabled ? '退出回放' : '进入回放'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="quiet" disabled={!replay.enabled} onClick={() => step(-1)} icon={<SkipBack aria-hidden="true" className="h-3.5 w-3.5" />} aria-label="上一条事件">
            上一条
          </Button>
          <Button size="sm" variant="quiet" disabled={!replay.enabled} onClick={() => step(1)} icon={<SkipForward aria-hidden="true" className="h-3.5 w-3.5" />} aria-label="下一条事件">
            下一条
          </Button>
          <Button size="sm" variant="ghost" disabled={!replay.enabled} onClick={() => setReplay({ cursorSeq: filtered[filtered.length - 1]?.seq ?? null })}>
            跳到最新
          </Button>
          <Chip>
            {replay.enabled ? `游标 seq ${visible[visible.length - 1]?.seq ?? '—'} · 已回放 ${visible.length}/${filtered.length}` : `共 ${filtered.length} 条事件 · 最新 seq ${filtered[filtered.length - 1]?.seq ?? '—'}`}
          </Chip>
          <span className="text-[11px] text-ink-secondary">心跳不会改变业务状态；重复 seq 被忽略，缺口会触发快照重取。</span>
        </div>
      </Card>

      <Card title="运行详情" subtitle="按需读取后端运行记录：步骤、阻塞、上下文快照与验证报告。">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <Select value={runId} onChange={(event) => setRunId(event.target.value)} aria-label="选择运行">
              {runIds.length === 0 && <option value="">无运行记录</option>}
              {runIds.map((id) => (
                <option key={id} value={id}>
                  {id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" variant="secondary" busy={runLoading} disabledReason={!runId ? '没有可读取的运行。' : null} onClick={() => void loadRun()}>
            读取运行详情
          </Button>
          {runDetail && <StatusBadge label={`状态：${runStateLabel(runDetail.run.state)}`} tone={runStateTone(runDetail.run.state)} ariaLabel="运行状态" />}
          {runDetail && <Chip>尝试 {runDetail.run.attempt}</Chip>}
          {runDetail && <Chip>计划 v{runDetail.run.planVersion}</Chip>}
        </div>
        {runError && <ErrorNotice compact title="运行详情不可用" message={runError} />}
        {runDetail && (
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <div>
              <p className="text-[11px] font-medium text-ink-secondary">步骤（{runDetail.steps.length}）</p>
              <ul className="mt-0.5 space-y-0.5">
                {runDetail.steps.map((step) => (
                  <li key={step.stepId} className="text-[11px] text-ink-secondary">
                    <span className="text-ink-primary">{step.title}</span> · {step.kind} · {step.status}
                    {step.summary ? ` · ${step.summary}` : ''}
                  </li>
                ))}
                {runDetail.steps.length === 0 && <li className="text-[11px] text-ink-secondary">后端未返回步骤明细。</li>}
              </ul>
              <p className="mt-1 text-[11px] font-medium text-ink-secondary">阻塞（{runDetail.blockers.length}）</p>
              <ul className="mt-0.5 space-y-0.5">
                {runDetail.blockers.map((blocker) => (
                  <li key={blocker.id} className="text-[11px] text-pending">
                    {blocker.title} · {blocker.type} · {blocker.status}
                  </li>
                ))}
                {runDetail.blockers.length === 0 && <li className="text-[11px] text-ink-secondary">无阻塞。</li>}
              </ul>
            </div>
            <div>
              <p className="text-[11px] font-medium text-ink-secondary">上下文快照</p>
              {runDetail.contextSnapshot ? (
                <p className="text-[11px] text-ink-secondary">
                  {runDetail.contextSnapshot.id.slice(0, 8)} · 估算 token {runDetail.contextSnapshot.estimatedInputTokens} · 片段 {runDetail.contextSnapshot.fragments.length} · 省略 {runDetail.contextSnapshot.omitted.length}
                </p>
              ) : (
                <p className="text-[11px] text-ink-secondary">无上下文快照。</p>
              )}
              <p className="mt-1 text-[11px] font-medium text-ink-secondary">验证报告</p>
              {runDetail.validationReport ? (
                <p className="text-[11px] text-ink-secondary">
                  状态 {runDetail.validationReport.status} · 检查项 {runDetail.validationReport.checks.length} · {runDetail.validationReport.summary}
                </p>
              ) : (
                <p className="text-[11px] text-ink-secondary">无验证报告。</p>
              )}
              <p className="mt-1 text-[11px] font-medium text-ink-secondary">预算用量</p>
              <p className="text-[11px] text-ink-secondary">
                模型 {runDetail.run.budgetUsage.modelRequests} · 工具 {runDetail.run.budgetUsage.toolCalls} · token 入 {runDetail.run.budgetUsage.inputTokens} / 出 {runDetail.run.budgetUsage.outputTokens}
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card
        title={`事件流（${filtered.length}）`}
        subtitle="事件用于诊断与回放；业务状态以快照投影为准。"
        actions={
          <div className="flex flex-wrap items-center gap-1">
            <div className="w-32">
              <Select value={filters.eventCategory} onChange={(event) => setFilters({ eventCategory: event.target.value })} aria-label="按事件类别过滤">
                <option value="all">全部类别</option>
                {['plan', 'execution', 'tool', 'blocker', 'artifact', 'recipe', 'control', 'usage', 'context'].map((category) => (
                  <option key={category} value={category}>
                    {eventCategoryLabel(category)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-44">
              <TextInput value={filters.eventQuery} onChange={(event) => setFilters({ eventQuery: event.target.value })} placeholder="搜索事件类型或字段…" aria-label="搜索事件" />
            </div>
          </div>
        }
      >
        {state.connection.phase !== 'connected' && <p className="mb-1 text-[11px] text-pending">事件流未连接（{state.connection.detail}）；快照轮询兜底中。</p>}
        {visible.length === 0 && <EmptyState compact title="没有事件" description="任务还没有可显示的业务事件。" icon={<ListTree aria-hidden="true" className="h-5 w-5" />} />}
        <ul className="ca-scroll max-h-[36vh] space-y-1 overflow-y-auto pr-1">
          {[...visible].reverse().map((event) => {
            const isSelected = selected?.eventId === event.eventId;
            return (
              <li key={event.eventId}>
                <button
                  type="button"
                  className={cn('ca-focus-ring flex min-h-10 w-full items-start gap-1.5 rounded border px-2 py-1 text-left', isSelected ? 'border-anchor/50 bg-anchor/[0.05]' : 'border-white/10 bg-black/20 hover:border-white/25')}
                  onClick={() => setSelectedEventId(event.eventId)}
                  aria-pressed={isSelected}
                  aria-label={`事件 ${event.seq}：${eventTypeLabel(event.type)}`}
                >
                  <span className="ca-tabular w-10 shrink-0 text-[10px] text-ink-secondary">#{event.seq}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1 text-[11px]">
                      <Chip>{eventCategoryLabel(event.category)}</Chip>
                      <span className="text-ink-primary">{eventTypeLabel(event.type)}</span>
                      <span className="font-mono text-[10px] text-ink-secondary">{event.type}</span>
                      <span className="ml-auto text-[10px] text-ink-secondary">{formatTimestamp(event.timestamp)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-ink-secondary">{safeJsonPreview(event.payload, 140)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {selected && (
          <div className="mt-2 rounded border border-white/10 bg-black/20 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge label={`seq ${selected.seq}`} tone="neutral" ariaLabel="事件序号" />
              <Chip>{selected.type}</Chip>
              <Chip>类别 {eventCategoryLabel(selected.category)}</Chip>
              {selected.runId && <Chip>运行 {selected.runId.slice(0, 8)}</Chip>}
              {selected.stepId && <Chip>步骤 {selected.stepId.slice(0, 8)}</Chip>}
              <span className="ml-auto text-[10px] text-ink-secondary">{formatTimestamp(selected.timestamp)}</span>
            </div>
            <pre className="ca-scroll mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/25 p-2 font-mono text-[11px] leading-4 text-ink-secondary">
              {safeJsonPreview(selected.payload, 4000)}
            </pre>
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={onClose}>
            返回工作台
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void core.refreshSnapshot({ quiet: false })}>
            手动刷新快照
          </Button>
          <span className="text-[11px] text-ink-secondary">连接状态：{state.connection.phase} · 已应用事件 {state.events.length} 条 · lastSeq {state.lastSeq}</span>
        </div>
      </Card>
    </div>
  );
}
