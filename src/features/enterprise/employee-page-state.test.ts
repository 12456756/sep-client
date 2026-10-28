import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmployeePageState, employeeBackgroundRoute, enterEmployeePage, readEmployeeView } from './employee-page-state';
import type { AppRoute } from './types';

test('employee drawers retain their source page and its route identity through nested employee history', () => {
  const source: AppRoute = { name: 'employees', scope: 'all' };
  const employee: AppRoute = { name: 'employee', employeeId: 'a' };
  assert.equal(employeeBackgroundRoute(source, []), source);
  assert.equal(employeeBackgroundRoute(employee, [{ name: 'home' }, source]), source);
  assert.equal(employeeBackgroundRoute(employee, [source, employee]), source);
  const home: AppRoute = { name: 'home' };
  assert.equal(employeeBackgroundRoute(employee, [home]), home);
  assert.deepEqual(employeeBackgroundRoute(employee, []), { name: 'employees' });
});

test('returning preserves filters while explicit entry resets query, scroll and focus but keeps view', () => {
  const state = { ...createEmployeePageState('list'), search: '研究', availability: 'working' as const, scrollTop: 430, focusId: 'employee-detail-a' };
  assert.equal(enterEmployeePage(state), state);
  assert.deepEqual(enterEmployeePage(state, 'all'), { ...createEmployeePageState('list'), scope: 'all' });
});

test('view preferences are scoped and tolerate unavailable storage', () => {
  const storage = { getItem: (key: string) => key === 'sep.employees.view.scope-a' ? 'list' : 'unexpected' };
  assert.equal(readEmployeeView('scope-a', storage), 'list');
  assert.equal(readEmployeeView('scope-b', storage), 'cards');
  assert.equal(readEmployeeView('scope-a', { getItem: () => { throw new Error('unavailable'); } }), 'cards');
});
