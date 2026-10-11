import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppRoute, WorkItem } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import { WorkRecordsPage } from './WorkRecordsPage';

const work: WorkItem = {
  id: 'work-a', title: '整理合同', goal: '整理采购合同', kind: 'conversation',
  workType: { state: 'resolved', kind: 'conversation' }, status: 'waiting-user', progress: 0,
  currentEmployeeId: 'employee-a', currentEmployeeName: '小周', steps: [], nextUserAction: '确认结果',
  createdAt: 1, updatedAt: 2, participants: [], deliverables: [], timeline: [], messages: [], activities: [],
  sharedContext: { goal: '整理采购合同', confirmedInputs: [], previousResults: [], userNotes: [] },
  stopReason: null, workDir: null,
};

function renderRecords(works: WorkItem[], route: AppRoute = { name: 'records' }): string {
  const workspace = {
    works, route, myEmployees: [], busy: false,
    navigate: () => {}, replaceRoute: () => {}, retryWorkTypes: () => {},
  } as unknown as EnterpriseWorkspace;
  const previousReact = Reflect.get(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try {
    return renderToStaticMarkup(React.createElement(WorkRecordsPage, { workspace }));
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact });
  }
}

describe('WorkRecordsPage', () => {
  it('renders independent native button groups and restores all route filters', () => {
    const html = renderRecords([work], { name: 'records', bucket: 'all', workType: 'conversation', search: '  合同  ' });
    assert.match(html, /role="group" aria-label="按状态筛选工作记录"/);
    assert.match(html, /role="group" aria-label="按类型筛选工作记录"/);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2);
    assert.ok(html.includes('value="  合同  "'));
    assert.match(html, /工作类型：会话/);
    assert.doesNotMatch(html, /role="tab(?:list)?"|aria-selected/);
  });

  it('distinguishes no original records from no matching records', () => {
    const empty = renderRecords([]);
    assert.match(empty, /这里还没有工作记录/);
    assert.doesNotMatch(empty, /重置筛选/);

    const unmatched = renderRecords([work], { name: 'records', workType: 'arrangement' });
    assert.match(unmatched, /没有符合条件的工作记录/);
    assert.match(unmatched, /重置筛选/);
    assert.doesNotMatch(unmatched, /这里还没有工作记录/);
  });

  it('uses authoritative arrangement type even when the legacy execution kind is conversation', () => {
    const html = renderRecords([{ ...work, workType: { state: 'resolved', kind: 'arrangement' } }]);
    assert.match(html, /class="ent-record-type resolved" aria-label="工作类型：编排"/);
    assert.match(html, /lucide-workflow/);
    assert.doesNotMatch(html, /aria-label="工作类型：会话"/);
  });

  it('shows loading independently without a type reload button or conversation badge', () => {
    const html = renderRecords([{ ...work, workType: { state: 'loading' } }]);
    assert.match(html, /class="ent-record-type loading" aria-label="工作类型：类型加载中"/);
    assert.match(html, /lucide-loader-circle/);
    assert.match(html, /1 条记录的类型正在加载/);
    assert.doesNotMatch(html, /重新读取类型|aria-label="工作类型：会话"/);
  });

  it('keeps the unavailable notice and reload entry visible while a concrete type excludes unknown records', () => {
    const unavailable = { ...work, workType: { state: 'unavailable' } } satisfies WorkItem;
    const all = renderRecords([unavailable]);
    assert.match(all, /class="ent-record-type unavailable" aria-label="工作类型：类型暂不可用"/);
    assert.match(all, /lucide-circle-help/);
    assert.doesNotMatch(all, /aria-label="工作类型：会话"/);

    const filtered = renderRecords([unavailable], { name: 'records', workType: 'conversation' });
    assert.match(filtered, /1 条记录的类型暂不可用/);
    assert.match(filtered, /重新读取类型/);
    assert.match(filtered, /没有符合条件的工作记录/);
    assert.doesNotMatch(filtered, /class="ent-record"/);
  });

  it('preserves existing card actions', () => {
    const html = renderRecords([work]);
    for (const label of ['去确认', '查看结果', '查看过程', '复制为新工作', '终止当前工作', '删除记录']) {
      assert.ok(html.includes(label), label);
    }
  });
});
