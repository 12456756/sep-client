import { useCallback, useEffect, useRef, useState } from 'react';
import { LoginPage } from './pages/LoginPage';
import { ClientAppPage } from './pages/ClientAppPage';
import { ToolApprovalDialog } from './components/ToolApprovalDialog';
import type { RememberedAccount, ToolAuthorizationRequest } from './shared/types';
import { useWorkspaceEmployees } from './features/enterprise/use-workspace-employees';
import { FeedbackProvider, useFeedback } from './components/feedback/FeedbackProvider';
import { LOGIN_FEEDBACK } from './shared/login-feedback';
import { useUpdate } from './features/update/use-update';

interface AuthState {
  user: { id: string; email: string; name: string };
  enterprise: { id: string; name: string } | null;
}

export default function App() {
  return <FeedbackProvider><AppContent /></FeedbackProvider>;
}

function AppContent() {
  const feedback = useFeedback();
  const update = useUpdate();
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const currentAuth = useRef<AuthState | null>(null);
  const logoutPending = useRef(false);
  const employees = useWorkspaceEmployees(authState);
  const [toolApprovalRequests, setToolApprovalRequests] = useState<ToolAuthorizationRequest[]>([]);
  const sessionStartedAt = useRef(Infinity);
  const [restoringAuth, setRestoringAuth] = useState(true);
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccount[]>([]);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);

  const loadAccounts = useCallback(async (isCurrent: () => boolean) => {
    try {
      const result = await window.electronAPI.listRememberedAccounts();
      if (!isCurrent()) return;
      setRememberedAccounts(result.accounts);
      setEncryptionAvailable(result.encryptionAvailable);
      if (result.error) feedback.show({ tone: 'error', message: result.error.message });
    } catch {
      if (isCurrent()) feedback.show({ tone: 'error', message: LOGIN_FEEDBACK.accounts_read.message });
    }
  }, [feedback]);

  useEffect(() => {
    let active = true;
    const revision = feedback.getRevision();
    void loadAccounts(() => active && revision === feedback.getRevision()).finally(() => { if (active) setRestoringAuth(false); });
    return () => { active = false; };
  }, [feedback, loadAccounts]);

  useEffect(() => window.electronAPI.onToolApprovalRequest(request => {
    if (!currentAuth.current || request.timestamp < sessionStartedAt.current) return;
    setToolApprovalRequests(current => current.some(item => item.requestId === request.requestId) ? current : [...current, request]);
  }), []);
  const resolveApproval = useCallback((requestId: string, approved: boolean) => {
    window.electronAPI.sendToolApprovalResponse({ requestId, approved, ...(approved ? {} : { reason: 'User denied or request expired' }) });
    setToolApprovalRequests(current => current.filter(item => item.requestId !== requestId));
  }, []);

  useEffect(() => window.electronAPI.onAuthenticationRequired(() => {
    if (!currentAuth.current) return;
    currentAuth.current = null;
    feedback.clear();
    setAuthState(null);
    setToolApprovalRequests([]);
    feedback.show({ tone: 'warning', message: LOGIN_FEEDBACK.session_expired.message });
  }), [feedback]);

  const handleLoginSuccess = (data: AuthState) => {
    feedback.clear();
    currentAuth.current = data;
    sessionStartedAt.current = Date.now();
    setAuthState(data);
  };

  const handleLogout = async () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    const session = currentAuth.current;
    try {
      const result = await window.electronAPI.logout();
      if (currentAuth.current !== session) return;
      if (!result.success) {
        feedback.show({ tone: 'error', message: result.error?.message ?? LOGIN_FEEDBACK.logout.message });
        return;
      }
      currentAuth.current = null;
      feedback.clear();
      setAuthState(null);
      setToolApprovalRequests([]);
      const revision = feedback.getRevision();
      await loadAccounts(() => revision === feedback.getRevision());
    } catch {
      if (currentAuth.current === session) feedback.show({ tone: 'error', message: LOGIN_FEEDBACK.logout.message });
    } finally { logoutPending.current = false; }
  };

  const renderRoute = () => {
    if (restoringAuth) return <div className="app-loading-screen"><div className="app-loading-spinner" /><p>正在读取账号</p></div>;
    if (!authState) return <LoginPage encryptionAvailable={encryptionAvailable} rememberedAccounts={rememberedAccounts} onAccountListChange={setRememberedAccounts} onLoginSuccess={handleLoginSuccess} />;
    return <ClientAppPage update={update} userId={authState.user.id} userName={authState.user.name || authState.user.email} enterpriseId={authState.enterprise?.id ?? ''} enterpriseName={authState.enterprise?.name ?? '我的企业'} instances={employees.subscriptions.items} employeeStatuses={employees.statuses.items} employeeLoad={employees.subscriptions} employeeStatusLoad={employees.statuses} onLogout={handleLogout} />;
  };

  return <>
    <div className="electron-window-chrome electron-drag-region" aria-hidden="true" />
    {renderRoute()}
    {toolApprovalRequests.map(request => <Approval key={request.requestId} request={request} onResolve={resolveApproval} />)}
  </>;
}

function Approval({ request, onResolve }: { request: ToolAuthorizationRequest; onResolve: (id: string, approved: boolean) => void }) {
  const approve = useCallback(() => onResolve(request.requestId, true), [request.requestId, onResolve]);
  const deny = useCallback(() => onResolve(request.requestId, false), [request.requestId, onResolve]);
  return <ToolApprovalDialog request={request} onApprove={approve} onDeny={deny} />;
}
