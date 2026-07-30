/**
 * src/App.tsx — PoC 验证 Dashboard
 *
 * 本周目标：4 个 PoC 验证（不写真实 UI）
 * 仅用于验证技术可行性，UI 简化为状态面板 + 工具审批对话框。
 */

import React, { useEffect, useState } from 'react';

interface PocStatus {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'pass' | 'fail';
  message?: string;
}

interface ToolApprovalRequest {
  toolName: string;
  input: unknown;
}

export default function App() {
  const [pocs, setPocs] = useState<PocStatus[]>([
    { id: 'poc1', title: 'PoC ①: SDK import', status: 'pending' },
    { id: 'poc2', title: 'PoC ②: Provider + resolve()', status: 'pending' },
    { id: 'poc3', title: 'PoC ③: async tool_call', status: 'pending' },
    { id: 'poc4', title: 'PoC ④: 失败态不静默', status: 'pending' },
  ]);

  const [approvalRequest, setApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [sessionActive, setSessionActive] = useState(false);

  // Listen for pi events
  useEffect(() => {
    const cleanup = window.electronAPI.onPiEvent((event: unknown) => {
      const e = event as { type: string; data?: unknown };
      console.log('[renderer] pi event:', e.type, e.data);

      // Update PoC status based on events (placeholder logic)
      if (e.type === 'agent_start') {
        setPocs((prev) =>
          prev.map((p) =>
            p.id === 'poc3' ? { ...p, status: 'running', message: 'Agent started' } : p
          )
        );
      }
      if (e.type === 'agent_settled') {
        setPocs((prev) =>
          prev.map((p) =>
            p.id === 'poc3' && p.status === 'running'
              ? { ...p, status: 'pass', message: 'Agent settled successfully' }
              : p
          )
        );
      }
    });

    return cleanup;
  }, []);

  // Listen for tool approval requests
  useEffect(() => {
    const cleanup = window.electronAPI.onToolApprovalRequest((request) => {
      console.log('[renderer] tool approval request:', request);
      setApprovalRequest(request);
    });

    return cleanup;
  }, []);

  const handleApprove = () => {
    if (!approvalRequest) return;
    window.electronAPI.sendToolApprovalResponse({ approved: true });
    setApprovalRequest(null);
  };

  const handleDeny = () => {
    if (!approvalRequest) return;
    window.electronAPI.sendToolApprovalResponse({ approved: false, reason: 'User denied' });
    setApprovalRequest(null);
  };

  const handleStartSession = async () => {
    try {
      await window.electronAPI.startSession({
        employeeId: 'test-employee',
        gatewayUrl: 'http://localhost:9999',
        refreshToken: 'test-refresh-token',
      });
      setSessionActive(true);
      setPocs((prev) =>
        prev.map((p) => ({ ...p, status: p.id === 'poc1' ? 'pass' : p.status }))
      );
    } catch (err) {
      console.error('Failed to start session:', err);
    }
  };

  const handleSendPrompt = async () => {
    if (!sessionActive) return;
    try {
      await window.electronAPI.sendPrompt('Hello from renderer — test PoC ③');
      setPocs((prev) =>
        prev.map((p) => (p.id === 'poc3' ? { ...p, status: 'running' } : p))
      );
    } catch (err) {
      console.error('Failed to send prompt:', err);
    }
  };

  const handleStopSession = async () => {
    try {
      await window.electronAPI.stopSession();
      setSessionActive(false);
    } catch (err) {
      console.error('Failed to stop session:', err);
    }
  };

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>SEP Client — PoC 验证面板</h1>
      <p style={{ color: '#666', marginBottom: '2rem' }}>
        本周目标：验证 4 个技术前提（不开发真实界面）
      </p>

      {/* PoC Status Board */}
      <div style={{ marginBottom: '2rem' }}>
        <h2>PoC 状态</h2>
        {pocs.map((poc) => (
          <div
            key={poc.id}
            style={{
              padding: '1rem',
              marginBottom: '0.5rem',
              borderRadius: '8px',
              backgroundColor: getStatusColor(poc.status),
              color: '#fff',
            }}
          >
            <strong>{poc.title}</strong>
            <span style={{ marginLeft: '1rem', opacity: 0.9 }}>
              [{poc.status.toUpperCase()}]
            </span>
            {poc.message && <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>{poc.message}</div>}
          </div>
        ))}
      </div>

      {/* Session Controls */}
      <div style={{ marginBottom: '2rem' }}>
        <h2>Session 控制</h2>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={handleStartSession} disabled={sessionActive} style={buttonStyle}>
            启动 Session
          </button>
          <button onClick={handleSendPrompt} disabled={!sessionActive} style={buttonStyle}>
            发送 Prompt (测试 PoC③)
          </button>
          <button onClick={handleStopSession} disabled={!sessionActive} style={buttonStyle}>
            停止 Session
          </button>
        </div>
      </div>

      {/* Tool Approval Dialog */}
      {approvalRequest && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              padding: '2rem',
              borderRadius: '12px',
              maxWidth: '500px',
              width: '90%',
            }}
          >
            <h3 style={{ marginTop: 0 }}>工具执行审批</h3>
            <p>
              <strong>工具名称:</strong> {approvalRequest.toolName}
            </p>
            <pre
              style={{
                backgroundColor: '#f5f5f5',
                padding: '1rem',
                borderRadius: '8px',
                overflow: 'auto',
                maxHeight: '200px',
              }}
            >
              {JSON.stringify(approvalRequest.input, null, 2)}
            </pre>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
              <button onClick={handleApprove} style={{ ...buttonStyle, backgroundColor: '#22c55e' }}>
                ✓ 允许执行
              </button>
              <button onClick={handleDeny} style={{ ...buttonStyle, backgroundColor: '#ef4444' }}>
                ✗ 拒绝执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getStatusColor(status: PocStatus['status']): string {
  switch (status) {
    case 'pending':
      return '#6b7280';
    case 'running':
      return '#3b82f6';
    case 'pass':
      return '#22c55e';
    case 'fail':
      return '#ef4444';
  }
}

const buttonStyle: React.CSSProperties = {
  padding: '0.75rem 1.5rem',
  border: 'none',
  borderRadius: '8px',
  backgroundColor: '#3b82f6',
  color: '#fff',
  fontSize: '1rem',
  cursor: 'pointer',
  fontWeight: 500,
};
