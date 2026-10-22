import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

interface ErrorBoundaryState {
  error: Error | null;
}

/** Last-resort boundary: never let a render crash fake a business state. */
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep diagnostics in the browser console only; never auto-retry or fake success.
    console.error('workbench render error', error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-xl rounded-lg border border-failed/40 bg-failed/[0.06] p-4">
            <h1 className="text-base font-semibold text-failed">界面渲染失败</h1>
            <p className="mt-1 text-xs text-ink-primary">
              已接受成果与运行记录保存在后端，不受本次界面错误影响。请刷新页面重新读取服务端状态。
            </p>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-ink-secondary">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              className="ca-focus-ring mt-3 min-h-10 rounded border border-white/15 px-3 text-sm text-ink-primary"
              onClick={() => window.location.reload()}
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
