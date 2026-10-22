/** Application shell: backend selection, hash routing, global hotkeys and notices. */
import { useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { selectClient, type ClientSelection } from './api/clientFactory';
import { TaskCreateScreen } from './components/tasks/TaskCreateScreen';
import { TaskListScreen } from './components/tasks/TaskListScreen';
import { SettingsScreen } from './components/settings/SettingsScreen';
import { NoticeStack } from './components/common/ui';
import { WorkspaceScreen } from './screens/WorkspaceScreen';
import { createCore } from './state/coreStore';
import {
  CoreContext,
  useCore,
  useCoreState,
  useEffectiveReducedMotion,
  useGlobalHotkeys,
  useHashRoute,
  useNavigate,
  useNotices,
  usePageVisible,
  useViewStore,
} from './state/hooks';
import { isTaskId } from './lib/routes';

export function App(): JSX.Element {
  const [selection] = useState<ClientSelection>(() => {
    if (typeof window === 'undefined') {
      return selectClient('', { VITE_CA_FIXTURE: '1' });
    }
    const env = (import.meta as { env?: { VITE_CA_FIXTURE?: string; VITE_CA_API_BASE?: string } }).env ?? {};
    return selectClient(window.location.search, env);
  });
  const [core] = useState(() => createCore(selection.client));

  useEffect(() => {
    void core.boot();
    // The core intentionally lives for the whole app session; browser refresh is
    // the recovery path (there is no local business state to persist).
  }, [core]);

  return (
    <CoreContext.Provider value={core}>
      <AppShell selection={selection} />
    </CoreContext.Provider>
  );
}

function AppShell({ selection }: { selection: ClientSelection }): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const route = useHashRoute();
  const navigate = useNavigate();
  const reducedMotion = useEffectiveReducedMotion();
  const pageVisible = usePageVisible();
  const { notices, dismiss } = useNotices();
  const panel = useViewStore((view) => view.panel);
  const focusScopeId = useViewStore((view) => view.focusScopeId);
  const closePanel = useViewStore((view) => view.closePanel);
  const exitFocus = useViewStore((view) => view.exitFocus);
  const shiftLayer = useViewStore((view) => view.shiftLayer);

  useEffect(() => {
    if (route.name !== 'task') core.closeTask();
  }, [core, route.name]);

  useGlobalHotkeys({
    enabled: route.name === 'task',
    onLayerShift: shiftLayer,
    onEscape: () => {
      if (panel) closePanel();
      else if (focusScopeId) exitFocus();
    },
  });

  const onHome = (): void => {
    core.closeTask();
    navigate({ name: 'tasks' });
  };
  const onSettings = (): void => navigate({ name: 'settings' });

  let screen: JSX.Element;
  if (route.name === 'task') {
    if (!isTaskId(route.taskId)) {
      screen = (
        <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm text-ink-primary">任务地址无效</p>
          <p className="text-xs text-ink-secondary">URL 中的任务 ID 不合法；请从任务列表重新进入。</p>
          <button type="button" className="ca-focus-ring min-h-10 rounded border border-white/15 px-3 text-sm text-ink-primary" onClick={onHome}>
            返回任务列表
          </button>
        </div>
      );
    } else {
      screen = <WorkspaceScreen taskId={route.taskId} isFixture={selection.isFixture} onHome={onHome} onSettings={onSettings} />;
    }
  } else if (route.name === 'task-new') {
    screen = <TaskCreateScreen />;
  } else if (route.name === 'settings') {
    screen = <SettingsScreen />;
  } else {
    screen = <TaskListScreen />;
  }

  return (
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'user'}>
      <div className={`flex h-full min-h-0 flex-col bg-base text-ink-primary ${reducedMotion ? 'ca-reduced-motion' : ''} ${pageVisible ? '' : 'ca-animation-paused'}`}>
        <a href="#workspace-main" className="ca-sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-elevated focus:px-3 focus:py-2 focus:text-sm focus:text-ink-primary">
          跳到主内容
        </a>
        {selection.isFixture && (
          <div className="border-b border-pending/30 bg-pending/10 px-3 py-1 text-[11px] text-pending" role="status">
            本地夹具（非真实执行）：当前数据来自 ?fixture=1 预览夹具，不代表真实模型或工具执行结果；真实连接错误不会被演示数据覆盖。
          </div>
        )}
        {state.staleRejected && (
          <div className="border-b border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-ink-secondary" role="status">
            已忽略一个过期快照（旧快照不能覆盖较新的业务状态）。
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">{screen}</div>
        <NoticeStack notices={notices} onDismiss={dismiss} />
      </div>
    </MotionConfig>
  );
}
