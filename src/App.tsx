import { useEffect, useState } from 'react';
import { LoginPage } from './pages/LoginPage';
import { WorkspaceHomePage } from './pages/WorkspaceHomePage';
import { ToolApprovalDialog } from './components/ToolApprovalDialog';
import type { EmployeeInstanceSnapshot, RememberedAccount } from './shared/types';

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
  const [instances, setInstances] = useState<EmployeeInstanceSnapshot[]>([]);
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
    void Promise.race([window.electronAPI.getInstances(), timeout]).then(result => {
      if (!active) return;
      if (!result.success || !result.data?.length) {
        setInstanceError(result.error?.message || '当前账号没有可用的硅基员工实例。');
        return;
      }
      setInstances(result.data);
    }).catch(error => {
      if (active) setInstanceError(error instanceof Error ? error.message : '获取员工实例失败。');
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
      setInstanceError(null);
      setToolApprovalRequest(null);
      const result = await window.electronAPI.listRememberedAccounts();
      setRememberedAccounts(result.accounts);
      setEncryptionAvailable(result.encryptionAvailable);
    }
  };

  const renderRoute = () => {
    if (restoringAuth) return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在恢复工作台</p></div>;
    if (!authState) return <LoginPage encryptionAvailable={encryptionAvailable} rememberedAccounts={rememberedAccounts} onAccountListChange={setRememberedAccounts} onLoginSuccess={setAuthState} />;
    if (loadingInstances) return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在准备你的员工团队</p></div>;
    if (instanceError && instances.length === 0) return <div className="app-empty-screen"><h1>暂时无法进入工作台</h1><p>{instanceError}</p><button className="workspace-primary-button" onClick={() => void handleLogout()}>退出登录</button></div>;
    return <WorkspaceHomePage userName={authState.user.name || authState.user.email} enterpriseName={authState.enterprise?.name} employeeInstanceId={instances[0]?.id} employeeInstanceName={instances[0]?.name} instances={instances} onLogout={handleLogout} />;
  };

  return <>
    {renderRoute()}
    <ToolApprovalDialog request={toolApprovalRequest} onApprove={() => { if (toolApprovalRequest) window.electronAPI.sendToolApprovalResponse({ requestId: toolApprovalRequest.requestId, approved: true }); setToolApprovalRequest(null); }} onDeny={() => { if (toolApprovalRequest) window.electronAPI.sendToolApprovalResponse({ requestId: toolApprovalRequest.requestId, approved: false, reason: 'User denied' }); setToolApprovalRequest(null); }} />
  </>;
}
