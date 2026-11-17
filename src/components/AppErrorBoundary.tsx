import { Component, type ReactNode } from 'react';
import { RotateCw, TriangleAlert } from 'lucide-react';

interface Props { children: ReactNode }
interface State { failed: boolean }

export function AppErrorFallback() {
  return <main className="app-empty-screen" role="alert">
    <TriangleAlert size={28} aria-hidden="true" />
    <h1>页面显示出现异常</h1>
    <p>正在执行的工作可能仍在后台继续，重新加载后请查看工作记录。</p>
    <p>重新加载会丢弃本页尚未保存的输入。</p>
    <button type="button" className="app-recovery-button" onClick={() => window.location.reload()}>
      <RotateCw size={16} aria-hidden="true" />重新加载
    </button>
  </main>;
}

/** Catch render and lifecycle failures, including lazy component loading errors. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  render() { return this.state.failed ? <AppErrorFallback /> : this.props.children; }
}
