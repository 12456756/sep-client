/**
 * src/App.tsx — Main Application
 *
 * Routing: Login → Instance Select → Task Board
 */

import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/LoginPage';
import { InstanceSelectPage } from './pages/InstanceSelectPage';
import { TaskBoardPage } from './pages/TaskBoardPage';
import { ToolApprovalDialog } from './components/ToolApprovalDialog';

type AppRoute = 'login' | 'instance-select' | 'task-board';

interface AuthState {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; name: string };
  enterprise: { id: string; name: string } | null;
}

interface SessionState {
  instanceId: string;
  instanceToken: string;
  instanceName: string;
}

interface ToolApprovalRequest {
  toolName: string;
  input: unknown;
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>('login');
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [toolApprovalRequest, setToolApprovalRequest] = useState<ToolApprovalRequest | null>(null);

  // Check for stored credentials on mount
  useEffect(() => {
    checkStoredCredentials();
  }, []);

  // Listen for tool approval requests
  useEffect(() => {
    const cleanup = window.electronAPI.onToolApprovalRequest((request) => {
      console.log('[App] Tool approval request:', request);
      setToolApprovalRequest(request);
    });

    return cleanup;
  }, []);

  const checkStoredCredentials = async () => {
    try {
      const result = await window.electronAPI.checkStoredCredentials();

      if (result.hasCredentials) {
        console.log('[App] Found stored credentials:', result);
        // TODO: Auto-navigate to instance select page
      }
    } catch (error) {
      console.error('[App] Failed to check stored credentials:', error);
    }
  };

  const handleLoginSuccess = (data: AuthState) => {
    console.log('[App] Login successful:', data);
    setAuthState(data);
    setRoute('instance-select');
  };

  const handleInstanceSelected = async (instanceId: string, instanceToken: string, instanceName: string) => {
    console.log('[App] Instance selected:', instanceId);

    try {
      // Get refresh token from main process
      const tokenResult = await window.electronAPI.getRefreshToken();

      if (!tokenResult.success || !tokenResult.data) {
        console.error('[App] Failed to get refresh token:', tokenResult.error);
        // TODO: Show error message to user
        return;
      }

      const refreshToken = tokenResult.data.refreshToken;

      // Start pi session immediately
      await window.electronAPI.startSession({
        employeeId: instanceId,
        gatewayUrl: 'http://localhost:3001/gateway',
        refreshToken,
      });

      setSessionState({ instanceId, instanceToken, instanceName });
      setRoute('task-board');
    } catch (error) {
      console.error('[App] Failed to start session:', error);
      // TODO: Show error message to user
    }
  };

  const handleLogout = async () => {
    try {
      await window.electronAPI.logout();
      setAuthState(null);
      setSessionState(null);
      setRoute('login');
    } catch (error) {
      console.error('[App] Logout failed:', error);
    }
  };

  const handleToolApprove = () => {
    console.log('[App] Tool approved');
    window.electronAPI.sendToolApprovalResponse({ approved: true });
    setToolApprovalRequest(null);
  };

  const handleToolDeny = () => {
    console.log('[App] Tool denied');
    window.electronAPI.sendToolApprovalResponse({ approved: false, reason: 'User denied' });
    setToolApprovalRequest(null);
  };

  // Render current route
  const renderRoute = () => {
    switch (route) {
      case 'login':
        return <LoginPage onLoginSuccess={handleLoginSuccess} />;

      case 'instance-select':
        if (!authState) {
          setRoute('login');
          return null;
        }
        return (
          <InstanceSelectPage
            accessToken={authState.accessToken}
            onInstanceSelected={handleInstanceSelected}
            onLogout={handleLogout}
          />
        );

      case 'task-board':
        if (!sessionState) {
          setRoute('login');
          return null;
        }

        return <TaskBoardPage instanceName={sessionState.instanceName} />;

      default:
        return null;
    }
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
