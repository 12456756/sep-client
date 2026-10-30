import type { AppRoute, EmployeeAvailability } from './types';

const DEFAULT_BACKGROUND: AppRoute = { name: 'employees' };

/** Employee navigation opens an overlay over the last real page. */
export function employeeBackgroundRoute(route: AppRoute, history: readonly AppRoute[]): AppRoute {
  return route.name === 'employee'
    ? [...history].reverse().find(item => item.name !== 'employee') ?? DEFAULT_BACKGROUND
    : route;
}

export interface EmployeePageState {
  scope: 'mine' | 'all';
  search: string;
  availability: '' | EmployeeAvailability;
  view: 'cards' | 'list';
  scrollTop: number;
  focusId: string | null;
}

export function createEmployeePageState(view: EmployeePageState['view'] = 'cards'): EmployeePageState {
  return { scope: 'mine', search: '', availability: '', view, scrollTop: 0, focusId: null };
}

export function enterEmployeePage(state: EmployeePageState, scope?: 'mine' | 'all'): EmployeePageState {
  return scope ? { ...createEmployeePageState(state.view), scope } : state;
}

export function readEmployeeView(scopeKey: string, storage?: Pick<Storage, 'getItem'>): EmployeePageState['view'] {
  try {
    const source = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    return source?.getItem(`sep.employees.view.${scopeKey}`) === 'list' ? 'list' : 'cards';
  }
  catch { return 'cards'; }
}

export function saveEmployeeView(scopeKey: string, view: EmployeePageState['view']): void {
  try { window.localStorage.setItem(`sep.employees.view.${scopeKey}`, view); }
  catch { /* View preference must not prevent using the directory. */ }
}
