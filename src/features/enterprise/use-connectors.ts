import { useCallback, useEffect, useRef, useState } from 'react';
import { connectorStateSchema, type ConnectorState, type ConnectorId } from '../../shared/connectors';

export function useConnectors(id: ConnectorId = 'dingtalk') {
  const [state, setState] = useState<ConnectorState>({ id, status: 'disconnected' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const acting = useRef(false);
  const sequence = useRef(0);
  const available = typeof window.electronAPI?.getConnectorState === 'function';
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!available) { setLoading(false); return; }
    try {
      const result = await window.electronAPI.getConnectorState(id);
      if (!mounted.current || request !== sequence.current) return;
      if (!result.success || !result.data) throw new Error(result.error?.message || '无法获取连接状态');
      const next = connectorStateSchema.parse(result.data);
      if (next.id !== id) throw new Error('连接器状态不匹配');
      setState(next);
      setError(undefined);
    } catch { if (mounted.current && request === sequence.current) setError('无法获取连接状态，请重试'); }
    finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [available, id]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  useEffect(() => {
    if (state.status !== 'authorizing' && state.status !== 'connected') return;
    const delay = state.status === 'authorizing' ? 1500 : 15000;
    let stopped = false;
    let timer: number;
    const poll = async (): Promise<void> => { await refresh(); if (!stopped) timer = window.setTimeout(() => { void poll(); }, delay); };
    timer = window.setTimeout(() => { void poll(); }, delay);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [state.status, refresh]);
  const act = async (action: 'connect' | 'disconnect'): Promise<void> => {
    if (acting.current || !available) return;
    acting.current = true;
    sequence.current++;
    setBusy(true); setError(undefined);
    try {
      const result = await (action === 'connect' ? window.electronAPI.connectConnector(id) : window.electronAPI.disconnectConnector(id));
      if (!result.success) throw new Error(result.error?.message || '操作失败，请重试');
      await refresh();
    } catch (cause) { await refresh(); if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试'); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  };
  return { state, loading, busy, available, error, refresh, connect: () => act('connect'), disconnect: () => act('disconnect') };
}
