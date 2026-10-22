/** Task selection screen: list server tasks, create, demo reset, import package. */
import { useRef, useState } from 'react';
import { FileUp, FolderOpen, Plus, RefreshCw, Settings } from 'lucide-react';
import { formatRelativeTime } from '../../lib/format';
import { commandEnvelope } from '../../lib/ids';
import { modeLabel, modeTone, runStateLabel, runStateTone } from '../../lib/labels';
import { useCommandPending, useCore, useCoreState, useNavigate } from '../../state/hooks';
import { Button, Card, Chip, EmptyState, ErrorNotice, LoadingBlock, StatusBadge } from '../common/ui';

export function TaskListScreen(): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const navigate = useNavigate();
  const { pending } = useCommandPending();
  const importRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tasks = state.tasks?.tasks ?? [];
  const mode = state.session?.mode ?? state.workspace?.workspace.mode ?? 'demo';

  const refresh = async (): Promise<void> => {
    await core.loadTasks();
    await core.refreshWorkspace();
  };

  const resetDemo = async (): Promise<void> => {
    const envelope = commandEnvelope();
    const result = await core.runCommand('重置演示数据', (client) => client.demoReset({ ...envelope }), {
      successNotice: '演示数据已重置（仅 Demo 命名空间）。',
    });
    if (result) {
      await core.loadTasks();
      navigate({ name: 'task', taskId: result.taskId });
    }
  };

  const importPackage = async (file: File): Promise<void> => {
    setImportError(null);
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      const contentBase64 = btoa(binary);
      const envelope = commandEnvelope();
      const result = await core.runCommand('导入任务包', (client) => client.importTask({ ...envelope, fileName: file.name, contentBase64 }), {
        successNotice: '任务包已导入（配方不会自动激活）。',
      });
      if (result) {
        await core.loadTasks();
        navigate({ name: 'task', taskId: result.taskId });
      }
    } catch (error) {
      setImportError(`读取任务包失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  if (state.boot === 'loading' || (state.boot === 'idle' && !state.tasksError)) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        <LoadingBlock label="正在读取工作区与任务列表…" />
      </div>
    );
  }

  if (state.boot === 'error' || state.bootError) {
    const failure = state.bootError;
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        <Card title="无法连接后端工作区">
          <ErrorNotice
            title={failure ? '初始化失败' : '后端不可达'}
            message={failure?.message ?? '未能读取会话信息。'}
            guidance={[
              '真实模式不会自动回退到演示数据；请确认后端已在 127.0.0.1:4310 启动。',
              '如需在没有后端的情况下预览界面，可显式打开 ?fixture=1（会显示“本地夹具（非真实执行）”标识）。',
            ]}
            traceId={failure?.traceId}
            onRetry={() => void core.boot()}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="md" variant="secondary" onClick={() => void core.boot()} icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />}>
              重试连接
            </Button>
            <a
              href="?fixture=1"
              className="ca-focus-ring inline-flex min-h-10 items-center rounded border border-white/15 px-3 text-sm text-ink-primary hover:bg-white/[0.06]"
            >
              使用本地夹具预览
            </a>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 overflow-y-auto p-4 ca-scroll">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink-primary">Cognitive Atrium · 任务空间</h1>
          <p className="mt-0.5 text-xs text-ink-secondary">
            选择任务进入空间工作台。每个任务恰好关联一个中心交付物清单；运行控制与状态都在任务空间内。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge label={`模式：${modeLabel(mode)}`} tone={modeTone(mode)} ariaLabel="工作区模式" />
          {state.session && <Chip>服务端 {state.session.serverVersion}</Chip>}
          {state.session && <Chip>可用模式 {state.session.availableModes.map((available) => modeLabel(available)).join(' / ')}</Chip>}
          <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'settings' })} icon={<Settings aria-hidden="true" className="h-3.5 w-3.5" />}>
            设置
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void refresh()} icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />}>
            刷新
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button size="md" variant="primary" onClick={() => navigate({ name: 'task-new' })} icon={<Plus aria-hidden="true" className="h-4 w-4" />}>
          新建任务
        </Button>
        <Button size="md" variant="secondary" busy={pending || busy} disabledReason={!state.session?.demoAvailable ? '后端未提供演示数据能力。' : null} onClick={() => void resetDemo()}>
          重置演示数据
        </Button>
        <input
          ref={importRef}
          type="file"
          accept=".zip,.json,.ca,.capkg"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importPackage(file);
          }}
        />
        <Button size="md" variant="secondary" busy={busy || pending} onClick={() => importRef.current?.click()} icon={<FileUp aria-hidden="true" className="h-4 w-4" />}>
          导入任务包
        </Button>
      </div>
      {importError && <ErrorNotice compact title="导入失败" message={importError} />}
      {state.tasksError && <ErrorNotice compact title="任务列表读取失败" message={state.tasksError.message} guidance={['已保存的任务数据仍在后端；刷新或检查连接后重试。']} traceId={state.tasksError.traceId} onRetry={() => void core.loadTasks()} />}

      <Card title={`任务（${tasks.length}）`} subtitle="状态来自服务端；已接受成果不会因列表刷新而改变。">
        {tasks.length === 0 ? (
          <EmptyState
            title="还没有任务"
            description="新建一个任务并选择内置四模块模板，或使用“重置演示数据”加载合成演示场景。"
            icon={<FolderOpen aria-hidden="true" className="h-6 w-6" />}
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate({ name: 'task-new' })}>
                新建任务
              </Button>
            }
          />
        ) : (
          <ul className="space-y-1.5">
            {tasks.map((task) => (
              <li key={task.taskId}>
                <button
                  type="button"
                  className="ca-focus-ring flex min-h-12 w-full flex-wrap items-center gap-2 rounded border border-white/10 bg-black/20 px-2.5 py-2 text-left hover:border-white/25"
                  onClick={() => navigate({ name: 'task', taskId: task.taskId })}
                  aria-label={`打开任务 ${task.title}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-primary">{task.title}</p>
                    <p className="text-[11px] text-ink-secondary">
                      模块 {task.moduleCount} · 已接受 {task.acceptedCount} · 修订 {task.revision} · 更新于 {formatRelativeTime(task.updatedAt)}
                    </p>
                  </div>
                  <StatusBadge label={task.status === 'active' ? '进行中任务' : '已归档'} tone={task.status === 'active' ? 'accent' : 'muted'} ariaLabel="任务状态" />
                  <StatusBadge label={task.activeRunState ? `运行：${runStateLabel(task.activeRunState)}` : '无活动运行'} tone={task.activeRunState ? runStateTone(task.activeRunState) : 'muted'} ariaLabel="活动运行状态" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-[11px] leading-4 text-ink-secondary">
        演示与正式数据物理隔离；切换模式需先结束或保留当前活动运行。没有后端时不会自动用演示数据替代真实结果。
      </p>
    </div>
  );
}
