import { useCallback, useEffect, useState } from 'react';
import type { EmployeeStatus, LoginData, Subscription } from '../../shared/types';

export interface EmployeeLoadState {
  loading: boolean;
  error: string | null;
  retry: () => void;
}

interface ResourceState<T> {
  session: LoginData;
  items: T[];
  loading: boolean;
  error: string | null;
}

interface EmployeeResource<T> extends EmployeeLoadState {
  items: T[];
}

const loadSubscriptions = () => window.electronAPI.getSubscriptions();
const loadStatuses = () => window.electronAPI.getEmployeeStatus();

function useEmployeeResource<T>(session: LoginData | null, load: () => Promise<{ success: boolean; data?: T[]; error?: { message?: string } }>, fallback: string): EmployeeResource<T> {
  const [state, setState] = useState<ResourceState<T> | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!session) {
      setState(null);
      return;
    }
    let active = true;
    setState(current => ({ session, items: current?.session === session ? current.items : [], loading: true, error: null }));
    void load().then(result => {
      if (!active) return;
      setState(current => ({
        session,
        items: result.success ? result.data ?? [] : current?.items ?? [],
        loading: false,
        error: result.success ? null : result.error?.message || fallback,
      }));
    }).catch(() => {
      if (active) setState(current => ({ session, items: current?.items ?? [], loading: false, error: fallback }));
    });
    return () => { active = false; };
  }, [session, revision, load, fallback]);

  const current = state?.session === session ? state : null;
  return { items: current?.items ?? [], loading: current?.loading ?? Boolean(session), error: current?.error ?? null, retry };
}

export function useWorkspaceEmployees(session: LoginData | null): { subscriptions: EmployeeResource<Subscription>; statuses: EmployeeResource<EmployeeStatus> } {
  const subscriptions = useEmployeeResource<Subscription>(session, loadSubscriptions, '员工列表加载失败，请重试。');
  const statuses = useEmployeeResource<EmployeeStatus>(session, loadStatuses, '员工状态加载失败，请重试。');
  return { subscriptions, statuses };
}
