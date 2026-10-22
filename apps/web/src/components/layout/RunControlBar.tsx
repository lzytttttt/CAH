/**
 * Always-present run control bar: real phase, pause/resume, stop, budget,
 * connection and unsaved-draft indicator. Keyboard reachable, never hidden by
 * HUD minimalism (design 10.3). Stop is a command with a recorded reason.
 */
import { useState } from 'react';
import type { TaskSnapshot } from '@ca/contracts';
import { CirclePause, CirclePlay, ListTree, OctagonX, Radio, Settings2, Wifi, WifiOff } from 'lucide-react';
import { commandEnvelope } from '../../lib/ids';
import { formatStepProgress, truncateText } from '../../lib/format';
import {
  connectionPhaseLabel,
  connectionPhaseTone,
  controlConnectionLabel,
  moduleStateLabel,
  moduleStateTone,
  runStateLabel,
  runStateTone,
} from '../../lib/labels';
import { useCommandPending, useCore, useCoreState } from '../../state/hooks';
import { readIntentDraft, useViewStore } from '../../state/viewStore';
import { Button, StatusBadge, TextInput } from '../common/ui';
import { connectionBadgeProps } from './badges';

export interface RunControlBarProps {
  snapshot: TaskSnapshot;
  focusActive: boolean;
  onOpenSettings: () => void;
  onOpenEvents: () => void;
  onOpenPlan: () => void;
  onOpenRepair: () => void;
}

export function RunControlBar({ snapshot, focusActive, onOpenSettings, onOpenEvents, onOpenPlan, onOpenRepair }: RunControlBarProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const { pending } = useCommandPending();
  const selectedModuleId = useViewStore((view) => view.selectedModuleId);
  const exitFocus = useViewStore((view) => view.exitFocus);
  const setLayer = useViewStore((view) => view.setLayer);
  const draft = useViewStore((view) => readIntentDraft(view, snapshot.task.id, selectedModuleId));
  const [stopOpen, setStopOpen] = useState(false);
  const [stopReason, setStopReason] = useState('');
  const control = snapshot.control;
  const activeRun = snapshot.activeRun;
  const stage = snapshot.spatial.stage;
  const connection = state.connection;
  const connectionBadge = connectionBadgeProps(connection.phase);
  const unsaved = control.unsavedDraft || draft.trim().length > 0;
  const selectedModule = snapshot.modules.find((view) => view.module.id === selectedModuleId) ?? null;

  const runControl = async (label: string, action: 'pause' | 'resume' | 'cancel', reason = ''): Promise<void> => {
    if (!activeRun) return;
    const envelope = commandEnvelope(snapshot.task.revision);
    await core.runCommand(
      label,
      (client) => {
        const request = { ...envelope, expectedRevision: snapshot.task.revision, reason };
        if (action === 'pause') return client.pauseRun(activeRun.runId, request);
        if (action === 'resume') return client.resumeRun(activeRun.runId, request);
        return client.cancelRun(activeRun.runId, request);
      },
      { successNotice: `${label}命令已发送；状态以服务端快照为准。` },
    );
  };

  return (
    <footer className="ca-glass sticky bottom-0 z-30 border-t border-white/10 px-3 py-1.5" role="contentinfo" aria-label="运行控制栏">
      {stopOpen && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded border border-failed/40 bg-failed/[0.08] px-2 py-1.5">
          <span className="text-xs font-medium text-failed">停止运行需要记录原因；已接受成果不会被撤回。</span>
          <div className="min-w-[14rem] flex-1">
            <TextInput
              value={stopReason}
              onChange={(event) => setStopReason(event.target.value)}
              placeholder="停止原因（会写入命令记录）"
              aria-label="停止原因"
              maxLength={2000}
              data-autofocus
            />
          </div>
          <Button
            size="sm"
            variant="danger"
            busy={pending}
            disabledReason={activeRun && !control.canCancel ? '当前运行状态不接受取消（可能在提交事务中）。' : null}
            onClick={() => {
              void runControl('停止运行', 'cancel', stopReason.trim());
              setStopOpen(false);
            }}
          >
            确认停止
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setStopOpen(false)}>
            返回
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge label={`阶段：${stage.label}`} tone="accent" ariaLabel="当前阶段" title={stage.activeStepTitle ? `当前步骤：${stage.activeStepTitle}` : undefined} />
          {activeRun ? (
            <>
              <StatusBadge label={`运行：${runStateLabel(activeRun.state)}`} tone={runStateTone(activeRun.state)} ariaLabel="活动运行状态" />
              <span className="text-[11px] text-ink-secondary">尝试 {activeRun.attempt} · 计划 v{activeRun.planVersion}</span>
            </>
          ) : (
            <StatusBadge label="无活动运行" tone="muted" ariaLabel="活动运行状态" />
          )}
          {selectedModule && (
            <StatusBadge label={`目标：${selectedModule.module.title}（${moduleStateLabel(selectedModule.module.status)}）`} tone={moduleStateTone(selectedModule.module.status)} ariaLabel="当前目标模块" />
          )}
          <span className="text-[11px] text-ink-secondary">{formatStepProgress(stage.completedSteps, stage.totalSteps)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            busy={pending && control.canPause}
            disabledReason={!activeRun ? '当前没有活动运行。' : !control.canPause ? `运行状态「${runStateLabel(activeRun.state)}」不接受暂停。` : null}
            onClick={() => void runControl('暂停运行', 'pause')}
            icon={<CirclePause aria-hidden="true" className="h-3.5 w-3.5" />}
          >
            暂停
          </Button>
          <Button
            size="sm"
            variant="secondary"
            busy={pending && control.canResume}
            disabledReason={!activeRun ? '当前没有活动运行。' : !control.canResume ? `运行状态「${runStateLabel(activeRun.state)}」不接受继续。` : null}
            onClick={() => void runControl('继续运行', 'resume')}
            icon={<CirclePlay aria-hidden="true" className="h-3.5 w-3.5" />}
          >
            继续
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabledReason={!activeRun ? '当前没有活动运行。' : !control.canCancel ? '运行状态不允许取消。' : null}
            onClick={() => setStopOpen(true)}
            icon={<OctagonX aria-hidden="true" className="h-3.5 w-3.5" />}
          >
            停止
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenRepair}>
            待处理问题
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenPlan}>
            计划
          </Button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1">
          {unsaved && <StatusBadge label="存在未保存草稿" tone="pending" ariaLabel="未保存提示" title="意图草稿保存在本地视图中；提交前不会进入业务事件。" />}
          {state.staleRejected && <StatusBadge label="已忽略过期快照" tone="muted" ariaLabel="快照防护" />}
          {state.resyncReason && <StatusBadge label="已自动重新同步" tone="pending" ariaLabel="重新同步" title={state.resyncReason} />}
          <span className="text-[11px] text-ink-secondary" title={control.budgetLabel}>
            预算：{truncateText(control.budgetLabel, 64)}
          </span>
          <span className="flex items-center gap-1 text-[11px] text-ink-secondary">
            {connection.phase === 'connected' ? <Wifi aria-hidden="true" className="h-3.5 w-3.5 text-accepted" /> : connection.phase === 'offline' ? <WifiOff aria-hidden="true" className="h-3.5 w-3.5 text-failed" /> : <Radio aria-hidden="true" className="h-3.5 w-3.5 text-pending" />}
            <StatusBadge label={connectionBadge.label} tone={connectionPhaseTone(connection.phase)} ariaLabel="连接状态" title={connection.detail} />
          </span>
          <StatusBadge
            label={controlConnectionLabel(control.connectionStatus)}
            tone={control.connectionStatus === 'configured' ? 'success' : control.connectionStatus === 'error' ? 'danger' : 'muted'}
            ariaLabel="模型连接配置"
          />
          {snapshot.spatial.focusHint && <span className="hidden text-[11px] text-ink-secondary xl:inline">提示：{truncateText(snapshot.spatial.focusHint, 42)}</span>}
          <Button size="sm" variant="ghost" onClick={() => setLayer('evidence')} aria-label="展开证据区" icon={<ListTree aria-hidden="true" className="h-3.5 w-3.5" />}>
            证据
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenEvents} aria-label="事件诊断与回放">
            诊断
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenSettings} icon={<Settings2 aria-hidden="true" className="h-3.5 w-3.5" />} aria-label="设置">
            设置
          </Button>
          {focusActive && (
            <Button size="sm" variant="ghost" onClick={() => exitFocus()} aria-label="退出聚焦模式">
              退出聚焦（Esc）
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}
