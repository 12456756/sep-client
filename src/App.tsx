/**
 * src/App.tsx — Main Application
 *
 * Routing: Login → Subscription Select → Workspace Home
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

const SUBSCRIPTION_LOAD_TIMEOUT_MS = 3_000;

export default function App() {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionSnapshot[]>([]);
  const [toolApprovalRequest, setToolApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [restoringAuth, setRestoringAuth] = useState(true);
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccount[]>([]);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

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
      setSubscriptions([]);
      setLoadingSubscriptions(false);
      setSubscriptionError(null);
      setToolApprovalRequest(null);
    });
  }, []);

  useEffect(() => {
    const removeDirectoryListener = window.electronAPI.onSubscriptionDirectoryUpdated(nextSubscriptions => {
      setSubscriptions(nextSubscriptions);
      setSessionState(current => {
        if (!current) return nextSubscriptions[0]
          ? { subscriptionId: nextSubscriptions[0].subscriptionId, subscriptionName: nextSubscriptions[0].name }
          : null;
        const currentSubscription = nextSubscriptions.find(item => item.subscriptionId === current.subscriptionId);
        return currentSubscription
          ? { subscriptionId: currentSubscription.subscriptionId, subscriptionName: currentSubscription.name }
          : nextSubscriptions[0]
            ? { subscriptionId: nextSubscriptions[0].subscriptionId, subscriptionName: nextSubscriptions[0].name }
            : null;
      });
      setSubscriptionError(nextSubscriptions.length ? null : '当前账号没有可用的硅基员工。');
    });
    const removeRejectionListener = window.electronAPI.onSubscriptionAuthorizationRejected(rejection => {
      setSubscriptions(current => current.filter(item => item.subscriptionId !== rejection.subscriptionId));
      setSessionState(current => current?.subscriptionId === rejection.subscriptionId ? null : current);
      setSubscriptionError('当前硅基员工的授权或订阅状态已失效，正在刷新可用员工。');
    });
    return () => {
      removeDirectoryListener();
      removeRejectionListener();
    };
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
    setSubscriptions([]);
    setLoadingSubscriptions(false);
    setSubscriptionError(null);
  };

  useEffect(() => {
    if (!authState || sessionState) return;
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setLoadingSubscriptions(true);
    setSubscriptionError(null);

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('加载可用硅基员工超时，请检查网络后重试。')), SUBSCRIPTION_LOAD_TIMEOUT_MS);
    });

    void Promise.race([window.electronAPI.getSubscriptions(), timeout]).then(result => {
      if (!active) return;
      if (!result.success || !result.data?.length) {
        setSubscriptionError(result.error?.message || '当前账号没有可用的硅基员工。');
        return;
      }
      const availableSubscriptions = result.data;
      const subscription = availableSubscriptions[0];
      setLoadingSubscriptions(false);
      setSubscriptions(availableSubscriptions);
      setSessionState({ subscriptionId: subscription.subscriptionId, subscriptionName: subscription.name });
    }).catch(error => {
      if (active) setSubscriptionError(error instanceof Error ? error.message : '获取硅基员工失败。');
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      if (active) setLoadingSubscriptions(false);
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
      setSubscriptions([]);
      setLoadingSubscriptions(false);
      setSubscriptionError(null);
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
      if (loadingSubscriptions) return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在加载可用的硅基员工…</p></div>;
      if (subscriptionError) return <div className="app-empty-screen"><h1>暂时无法进入工作台</h1><p>{subscriptionError}</p><button className="workspace-primary-button" onClick={handleLogout}>退出登录</button></div>;
      return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在准备工作台…</p></div>;
    }

    return (
      <WorkspaceHomePage
        userName={authState.user.name || authState.user.email}
        enterpriseName={authState.enterprise?.name}
        subscriptionId={sessionState.subscriptionId}
        subscriptionName={sessionState.subscriptionName}
        subscriptions={subscriptions}
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
