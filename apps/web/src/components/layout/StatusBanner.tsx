/** Persistent status banner: mode badge, connection, elevation switch, global entries. */
import type { SessionInfo, TaskSnapshot, WorkspaceView } from '@ca/contracts';
import { ArrowLeft, ListTree, RefreshCw, Settings, Waypoints } from 'lucide-react';
import { layerLabel, modeLabel, modeTone } from '../../lib/labels';
import type { ConnectionState } from '../../state/snapshot';
import { useViewStore } from '../../state/viewStore';
import { Button, IconButton, StatusBadge, cn } from '../common/ui';
import { connectionBadgeProps } from './badges';

export interface StatusBannerProps {
  session: SessionInfo | null;
  workspace: WorkspaceView | null;
  snapshot: TaskSnapshot | null;
  connection: ConnectionState;
  isFixture: boolean;
  pendingCommand: string | null;
  onHome: () => void;
  onSettings: () => void;
  onRefresh: () => void;
  onOpenEvents: () => void;
}

const LAYERS = ['global', 'execution', 'evidence'] as const;

export function StatusBanner({ session, workspace, snapshot, connection, isFixture, pendingCommand, onHome, onSettings, onRefresh, onOpenEvents }: StatusBannerProps): JSX.Element {
  const layer = useViewStore((state) => state.layer);
  const setLayer = useViewStore((state) => state.setLayer);
  const shiftLayer = useViewStore((state) => state.shiftLayer);
  const replay = useViewStore((state) => state.replay);
  const mode = snapshot?.workspace.mode ?? workspace?.workspace.mode ?? session?.mode ?? 'demo';
  const connectionBadge = connectionBadgeProps(connection.phase);
  const taskTitle = snapshot?.task.title ?? null;

  return (
    <header className="ca-glass sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/10 px-3 py-2" role="banner" aria-label="工作台状态栏">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={onHome} className="ca-focus-ring flex min-h-10 items-center gap-2 rounded px-1 text-left" aria-label="返回任务列表">
          <Waypoints aria-hidden="true" className="h-5 w-5 text-anchor" />
          <span className="text-sm font-semibold tracking-wide text-ink-primary">Cognitive Atrium</span>
        </button>
        {taskTitle && (
          <>
            <span aria-hidden="true" className="text-ink-secondary/50">
              /
            </span>
            <span className="max-w-[22rem] truncate text-xs text-ink-secondary" title={taskTitle}>
              {taskTitle}
            </span>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge label={`模式：${modeLabel(mode)}`} tone={modeTone(mode)} ariaLabel="运行模式" title={`当前工作区模式：${modeLabel(mode)}`} />
        {isFixture && <StatusBadge label="本地夹具（非真实执行）" tone="pending" ariaLabel="数据来源" title="?fixture=1 预览模式：所有数据来自本地夹具，不代表真实执行结果。" />}
        {replay.enabled && <StatusBadge label="历史回放（只读）" tone="prospect" ariaLabel="回放状态" />}
        <StatusBadge label={connectionBadge.label} tone={connectionBadge.tone} ariaLabel="连接状态" title={connection.detail} />
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label="层级切换（Alt+↑/↓）" className="flex items-center gap-0.5 rounded border border-white/10 bg-black/20 p-0.5">
          {LAYERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={layer === value}
              onClick={() => setLayer(value)}
              className={cn(
                'ca-focus-ring min-h-9 rounded px-2 text-[11px] transition-colors duration-feedback',
                layer === value ? 'bg-white/[0.1] font-medium text-ink-primary' : 'text-ink-secondary hover:text-ink-primary',
              )}
              title={`切换到 ${layerLabel(value)}（Alt+${value === 'global' ? '↑' : value === 'evidence' ? '↓' : '↑/↓'}）`}
            >
              {layerLabel(value)}
            </button>
          ))}
          <IconButton label="上移一层（Alt+↑）" size="sm" className="border-transparent bg-transparent" onClick={() => shiftLayer('up')}>
            <span aria-hidden="true" className="text-[10px]">▲</span>
          </IconButton>
          <IconButton label="下移一层（Alt+↓）" size="sm" className="border-transparent bg-transparent" onClick={() => shiftLayer('down')}>
            <span aria-hidden="true" className="text-[10px]">▼</span>
          </IconButton>
        </div>

        {pendingCommand && (
          <StatusBadge label={`处理中：${pendingCommand}`} tone="accent" ariaLabel="正在处理的命令" title="命令已发送，正在等待后端确认；界面状态仍以服务端快照为准。" />
        )}
        <IconButton label="刷新任务快照" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" className={cn('h-4 w-4', pendingCommand && 'animate-spin')} />
        </IconButton>
        <IconButton label="打开事件诊断与回放" onClick={onOpenEvents}>
          <ListTree aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        <IconButton label="打开设置" onClick={onSettings}>
          <Settings aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        <Button size="sm" variant="ghost" onClick={onHome} icon={<ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />}>
          任务列表
        </Button>
      </div>
    </header>
  );
}
