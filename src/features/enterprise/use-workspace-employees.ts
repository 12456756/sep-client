import { useCallback, useEffect, useState } from 'react';
import type { EmployeeStatus, LoginData, Subscription } from '../../shared/types';
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback';
import { operationFailure, type FeedbackOperation } from '../../shared/arrangement-feedback';

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

function useEmployeeResource<T>(session: LoginData | null, load: () => Promise<{ success: boolean; data?: T[]; error?: { message?: string; code?: string } }>, operation: FeedbackOperation): EmployeeResource<T> {
  const { capture } = useOperationFeedback();
  const fallback = operationFailure(operation);
  const [state, setState] = useState<ResourceState<T> | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!session) {
      setState(null);
      return;
    }
    let active = true;
    const notice = capture();
    setState(current => ({ session, items: current?.session === session ? current.items : [], loading: true, error: null }));
    void load().then(result => {
      if (!active || !notice.isCurrent()) return;
      if (!result.success && result.error?.code !== 'AUTH_REQUIRED') notice.show(result.error?.message || fallback);
      setState(current => ({
        session,
        items: result.success ? result.data ?? [] : current?.items ?? [],
        loading: false,
        error: result.success ? null : result.error?.message || fallback,
      }));
    }).catch(() => {
      if (active && notice.isCurrent()) {
        notice.show(fallback);
        setState(current => ({ session, items: current?.items ?? [], loading: false, error: fallback }));
      }
    });
    return () => { active = false; };
  }, [session, revision, load, fallback, capture]);

  const current = state?.session === session ? state : null;
  return { items: current?.items ?? [], loading: current?.loading ?? Boolean(session), error: current?.error ?? null, retry };
}

export function useWorkspaceEmployees(session: LoginData | null): { subscriptions: EmployeeResource<Subscription>; statuses: EmployeeResource<EmployeeStatus> } {
  const subscriptions = useEmployeeResource<Subscription>(session, loadSubscriptions, 'employees');
  const statuses = useEmployeeResource<EmployeeStatus>(session, loadStatuses, 'employeeStatus');
  return { subscriptions, statuses };
}
