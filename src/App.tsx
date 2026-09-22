import { useCallback, useEffect, useState, lazy, Suspense } from 'react';
import type { EmployeeStatus, Subscription, RememberedAccount } from './shared/types';
import { PerformanceMonitor } from './components/PerformanceMonitor';

// 懒加载页面组件
const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const ClientAppPage = lazy(() => import('./pages/ClientAppPage').then(m => ({ default: m.ClientAppPage })));
const ToolApprovalDialog = lazy(() => import('./components/ToolApprovalDialog').then(m => ({ default: m.ToolApprovalDialog })));

interface AuthState {
  user: { id: string; email: string; name: string };
  enterprise: { id: string; name: string } | null;
}

interface ToolApprovalRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

const INSTANCE_LOAD_TIMEOUT_MS = 3_000;

export default function App() {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [instances, setInstances] = useState<Subscription[]>([]);
  const [employeeStatuses, setEmployeeStatuses] = useState<EmployeeStatus[]>([]);
  const [toolApprovalRequest, setToolApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [restoringAuth, setRestoringAuth] = useState(true);
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccount[]>([]);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.listRememberedAccounts().then(result => {
      setRememberedAccounts(result.accounts);
      setEncryptionAvailable(result.encryptionAvailable);
      setRestoringAuth(false);
    }).catch(() => setRestoringAuth(false));
  }, []);

  useEffect(() => window.electronAPI.onToolApprovalRequest(setToolApprovalRequest), []);

  useEffect(() => window.electronAPI.onAuthenticationRequired(() => {
    setAuthState(null);
    setInstances([]);
    setEmployeeStatuses([]);
    setLoadingInstances(false);
    setInstanceError(null);
    setToolApprovalRequest(null);
  }), []);

  useEffect(() => {
    if (!authState) return;
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setLoadingInstances(true);
    setInstanceError(null);
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('加载员工团队超时，请稍后重试。')), INSTANCE_LOAD_TIMEOUT_MS);
    });
    void Promise.race([
      Promise.all([window.electronAPI.getSubscriptions(), window.electronAPI.getEmployeeStatus()]),
      timeout,
    ]).then(result => {
      if (!active) return;
      const [subscriptions, statuses] = result;
      if (!subscriptions.success) {
        setInstanceError(subscriptions.error?.message || '?????????');
        return;
      }
      setInstances(subscriptions.data ?? []);
      setEmployeeStatuses(statuses.success ? (statuses.data ?? []) : []);
    }).catch(error => {
      if (active) setInstanceError(error instanceof Error ? error.message : '?????????');
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      if (active) setLoadingInstances(false);
    });
    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [authState]);

  const handleLogout = async () => {
    try {
      await window.electronAPI.logout();
    } finally {
      setAuthState(null);
      setInstances([]);
      setEmployeeStatuses([]);
      setInstanceError(null);
      setToolApprovalRequest(null);
      const result = await window.electronAPI.listRememberedAccounts();
      setRememberedAccounts(result.accounts);
      setEncryptionAvailable(result.encryptionAvailable);
    }
  };

  const handleToolApprove = useCallback(() => {
    if (!toolApprovalRequest) return;
    void window.electronAPI.sendToolApprovalResponse({ requestId: toolApprovalRequest.requestId, approved: true });
    setToolApprovalRequest(null);
  }, [toolApprovalRequest]);

  const handleToolDeny = useCallback(() => {
    if (!toolApprovalRequest) return;
    void window.electronAPI.sendToolApprovalResponse({ requestId: toolApprovalRequest.requestId, approved: false, reason: 'User denied' });
    setToolApprovalRequest(null);
  }, [toolApprovalRequest]);

  const renderRoute = () => {
    if (restoringAuth) return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在恢复工作台</p></div>;
    if (!authState) return <LoginPage encryptionAvailable={encryptionAvailable} rememberedAccounts={rememberedAccounts} onAccountListChange={setRememberedAccounts} onLoginSuccess={setAuthState} />;
    if (loadingInstances) return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在准备你的员工团队</p></div>;
    if (instanceError) return <div className="app-empty-screen"><h1>暂时无法进入工作台</h1><p>{instanceError}</p><button className="workspace-primary-button" onClick={() => void handleLogout()}>退出登录</button></div>;
    return <ClientAppPage userId={authState.user.id} userName={authState.user.name || authState.user.email} enterpriseId={authState.enterprise?.id ?? ''} enterpriseName={authState.enterprise?.name ?? '我的企业'} instances={instances} employeeStatuses={employeeStatuses} onLogout={handleLogout} />;
  };

  return (
    <Suspense fallback={<div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在加载...</p></div>}>
      {renderRoute()}
      <ToolApprovalDialog request={toolApprovalRequest} onApprove={handleToolApprove} onDeny={handleToolDeny} />
      {/* 性能监控 - 仅在开发环境显示 */}
      {import.meta.env.DEV && <PerformanceMonitor position="bottom-right" />}
    </Suspense>
  );
}
