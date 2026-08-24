/**
 * src/App.tsx — Main Application
 *
 * Routing: Login → Instance Select → Workspace Home
 */

import { useState, useEffect } from 'react';
import { LoginPage } from './pages/LoginPage';
import { WorkspaceHomePage } from './pages/WorkspaceHomePage';
import { ToolApprovalDialog } from './components/ToolApprovalDialog';
import type { SubscriptionSnapshot, RememberedAccount } from './shared/types';

interface AuthState {
  user: { id: string; email: string; name: string };
  enterprise: { id: string; name: string } | null;
}

interface SessionState {
  subscriptionId: string;
  subscriptionName: string;
}

interface ToolApprovalRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

const INSTANCE_LOAD_TIMEOUT_MS = 3_000;

export default function App() {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [instances, setInstances] = useState<SubscriptionSnapshot[]>([]);
  const [toolApprovalRequest, setToolApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [restoringAuth, setRestoringAuth] = useState(true);
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccount[]>([]);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);

  useEffect(() => {
    void loadRememberedAccounts();
  }, []);

  useEffect(() => {
    let active = true;
    void window.electronAPI.getCurrentSession().then(result => {
      if (active && result.success && result.data) setAuthState(result.data);
    }).catch(() => undefined);
    return () => { active = false };
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onToolApprovalRequest((request) => {
      setToolApprovalRequest(request);
    });

    return cleanup;
  }, []);

  useEffect(() => {
    return window.electronAPI.onAuthenticationRequired(() => {
      setAuthState(null);
      setSessionState(null);
      setInstances([]);
      setLoadingInstances(false);
      setInstanceError(null);
      setToolApprovalRequest(null);
    });
  }, []);

  const loadRememberedAccounts = async () => {
    try {
      const result = await window.electronAPI.listRememberedAccounts();
      setRememberedAccounts(result.accounts);
      setEncryptionAvailable(result.encryptionAvailable);
    } catch (error) {
      console.error('[App] Failed to read stored accounts:', error);
    } finally {
      setRestoringAuth(false);
    }
  };

  const handleAccountListChange = (accounts: RememberedAccount[]) => {
    setRememberedAccounts(accounts);
  };

  const handleLoginSuccess = (data: AuthState) => {
    setAuthState(data);
    setSessionState(null);
    setInstances([]);
    setLoadingInstances(false);
    setInstanceError(null);
  };

  useEffect(() => {
    if (!authState || sessionState) return;
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setLoadingInstances(true);
    setInstanceError(null);

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('加载可用硅基员工超时，请检查网络后重试。')), INSTANCE_LOAD_TIMEOUT_MS);
    });

    void Promise.race([window.electronAPI.getInstances(), timeout]).then(result => {
      if (!active) return;
      if (!result.success || !result.data?.length) {
        setInstanceError(result.error?.message || '当前账号没有可用的硅基员工实例。');
        return;
      }
      const availableInstances = result.data;
      const subscription = availableInstances[0];
      setLoadingInstances(false);
      setInstances(availableInstances);
      setSessionState({ subscriptionId: subscription.subscriptionId, subscriptionName: subscription.name });
    }).catch(error => {
      if (active) setInstanceError(error instanceof Error ? error.message : '获取硅基员工实例失败。');
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      if (active) setLoadingInstances(false);
    });
    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [authState, sessionState]);

  const handleLogout = async () => {
    try {
      await window.electronAPI.logout();
    } catch (error) {
      console.error('[App] Logout failed:', error);
    } finally {
      setAuthState(null);
      setSessionState(null);
      setInstances([]);
      setLoadingInstances(false);
      setInstanceError(null);
      setToolApprovalRequest(null);
      const result = await window.electronAPI.listRememberedAccounts();
      setRememberedAccounts(result.accounts);
      setEncryptionAvailable(result.encryptionAvailable);
    }
  };

  const handleToolApprove = () => {
    if (!toolApprovalRequest) return;
    window.electronAPI.sendToolApprovalResponse({ requestId: toolApprovalRequest.requestId, approved: true });
    setToolApprovalRequest(null);
  };

  const handleToolDeny = () => {
    if (!toolApprovalRequest) return;
    window.electronAPI.sendToolApprovalResponse({ requestId: toolApprovalRequest.requestId, approved: false, reason: 'User denied' });
    setToolApprovalRequest(null);
  };

  const renderRoute = () => {
    if (restoringAuth) {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-[#fffafa]">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#ead0d0] border-t-[#c83a3a]" />
        </div>
      );
    }

    if (!authState) {
      return (
        <LoginPage
          encryptionAvailable={encryptionAvailable}
          rememberedAccounts={rememberedAccounts}
          onAccountListChange={handleAccountListChange}
          onLoginSuccess={handleLoginSuccess}
        />
      );
    }

    if (!sessionState) {
      if (loadingInstances) return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在加载可用的硅基员工…</p></div>;
      if (instanceError) return <div className="app-empty-screen"><h1>暂时无法进入工作台</h1><p>{instanceError}</p><button className="workspace-primary-button" onClick={handleLogout}>退出登录</button></div>;
      return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在准备工作台…</p></div>;
    }

    return (
      <WorkspaceHomePage
        userName={authState.user.name || authState.user.email}
        enterpriseName={authState.enterprise?.name}
        subscriptionId={sessionState.subscriptionId}
        subscriptionName={sessionState.subscriptionName}
        instances={instances}
        onLogout={handleLogout}
      />
    );
  };

  return (
    <>
      {renderRoute()}
      <ToolApprovalDialog
        request={toolApprovalRequest}
        onApprove={handleToolApprove}
        onDeny={handleToolDeny}
      />
    </>
  );
}
