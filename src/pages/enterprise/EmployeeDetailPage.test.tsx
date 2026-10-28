import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmployeeDetailPage } from './EmployeeDetailPage';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee, WorkItem } from '../../features/enterprise/types';
import type { SkillLibraryItem } from '../../shared/skill-library';

function button(workspace: EnterpriseWorkspace, className: string, props: Partial<Parameters<typeof EmployeeDetailPage>[0]> = {}) {
  let found: React.ReactElement<Record<string, unknown>> | undefined;
  const visit = (nodes: React.ReactNode): void => React.Children.forEach(nodes, child => {
    if (!React.isValidElement<Record<string, unknown>>(child)) return;
    if (child.type === 'button' && child.props.className === className) found = child;
    visit(child.props.children as React.ReactNode);
  });
  visit(EmployeeDetailPage({ workspace, employeeId: employee.id, ...props }));
  assert.ok(found, `missing button ${className}`);
  return found.props;
}

const employee: SiliconEmployee = {
  id: 'employee-a', name: '市场分析师', avatar: null, avatarAsset: null, mark: '市', roleName: '', department: null,
  availability: 'ready', assignedToMe: true, intro: '分析商品与市场资料，评估选品机会。', goodAt: [], cannotDo: [], lastWorkedAt: 300,
  allowedModels: [], skillIds: ['skill-a'], permissions: [], templateVersion: '1.0',
};
const skill: SkillLibraryItem = {
  capability: { id: 'skill-a', name: '市场机会分析', description: '评估商品和市场机会。', type: 'general' },
  bindings: [{ subscriptionId: employee.id, employeeId: employee.id, currentVersion: null, selectedVersionId: null }],
  usableVersionIds: [], versions: [], localVersions: [],
};
const work = {
  id: 'work-a', title: '商品机会评估', goal: '', kind: 'conversation', workType: { state: 'resolved', kind: 'conversation' },
  status: 'completed', progress: 100, currentEmployeeId: employee.id, currentEmployeeName: employee.name, steps: [], nextUserAction: null,
  createdAt: 100, startedAt: 100, completedAt: 200, updatedAt: 300, participants: [employee.id], deliverables: [], timeline: [], messages: [],
  activities: [], sharedContext: { goal: '', confirmedInputs: [], previousResults: [], userNotes: [] }, stopReason: null, workDir: null,
} as WorkItem;

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const workspace = {
    employees: [employee], organizationEmployees: [employee], organizationStatus: 'ready', organizationError: null, retryOrganization: () => calls.push('retry-directory'),
    skills: [skill], skillsLoading: false, skillsError: null, skillsRetrySeconds: null, refreshSkills: async () => undefined,
    works: [work], workListLoad: { loading: false, error: null, retry: () => undefined },
    canGoBack: true, goBack: () => calls.push('back'), navigate: (route: unknown) => calls.push(route),
    ...overrides,
  } as unknown as EnterpriseWorkspace;
  return { workspace, calls };
}

it('renders only the employee profile, bound skills and latest work links', () => {
  const { workspace } = makeWorkspace();
  const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
  assert.match(html, /市场分析师/);
  assert.match(html, /分析商品与市场资料/);
  assert.match(html, /市场机会分析/);
  assert.match(html, /评估商品和市场机会/);
  assert.match(html, /商品机会评估/);
  assert.match(html, /查看技能/);
  assert.doesNotMatch(html, /textarea|语音输入|权限|模板版本|能做什么|不做这些|交给他开始/);
});

it('renders linked start, skill and recent work actions', () => {
  const { workspace, calls } = makeWorkspace();
  for (const className of ['ent-btn primary', 'ent-employee-inline-link', 'ent-employee-work-link']) {
    (button(workspace, className).onClick as () => void)();
  }
  assert.deepEqual(calls, [
    { name: 'arrange', mode: 'chat', employeeId: employee.id },
    { name: 'skills', skillId: skill.capability.id },
    { name: 'work', workId: work.id },
  ]);
});

it('keeps the start action disabled for employees that are not assigned to the user', () => {
  const { workspace } = makeWorkspace({ employees: [{ ...employee, assignedToMe: false }], organizationEmployees: [{ ...employee, assignedToMe: false }] });
  const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
  assert.match(html, /尚未分配给你/);
  assert.match(html, /disabled=""[^>]*>[\s\S]*?开始对话/);
});

it('shows skill loading and failure separately from a confirmed empty skill list', () => {
  const loading = makeWorkspace({ skills: [], skillsLoading: true });
  const loadingHtml = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace: loading.workspace, employeeId: employee.id }));
  assert.match(loadingHtml, /正在加载技能/);
  assert.doesNotMatch(loadingHtml, /暂未配置可查看的技能/);
  const failed = makeWorkspace({ skills: [], skillsLoading: false, skillsError: '技能服务不可用' });
  const failedHtml = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace: failed.workspace, employeeId: employee.id }));
  assert.match(failedHtml, /技能服务不可用/);
  assert.doesNotMatch(failedHtml, /暂未配置可查看的技能/);
  const empty = makeWorkspace({ skills: [] });
  const emptyHtml = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace: empty.workspace, employeeId: employee.id }));
  assert.match(emptyHtml, /暂未配置可查看的技能/);
});

it('omits recent work when loaded and empty, but preserves loading and error states', () => {
  const empty = makeWorkspace({ works: [] });
  const emptyHtml = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace: empty.workspace, employeeId: employee.id }));
  assert.doesNotMatch(emptyHtml, /最近工作/);
  const loading = makeWorkspace({ works: [], workListLoad: { loading: true, error: null, retry: () => undefined } });
  const loadingHtml = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace: loading.workspace, employeeId: employee.id }));
  assert.match(loadingHtml, /正在加载最近工作/);
  const failed = makeWorkspace({ works: [], workListLoad: { loading: false, error: '工作记录读取失败', retry: () => undefined } });
  const failedHtml = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace: failed.workspace, employeeId: employee.id }));
  assert.match(failedHtml, /工作记录读取失败/);
});


it('keeps organization-only skill visibility unknown until skill loading succeeds', () => {
  for (const state of [{ skillsLoading: true }, { skillsError: '服务错误' }]) {
    const { workspace } = makeWorkspace({ employees: [], skills: [], ...state });
    const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
    assert.doesNotMatch(html, /当前账号暂无可查看的技能信息|暂未配置可查看的技能/);
  }
  const { workspace } = makeWorkspace({ employees: [], skills: [] });
  assert.match(renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id })), /当前账号暂无可查看的技能信息/);
});

it('shows a directory error before declaring an employee missing and retries it', () => {
  const { workspace, calls } = makeWorkspace({ employees: [], organizationEmployees: [], organizationStatus: 'error', organizationError: '目录加载失败' });
  const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
  assert.match(html, /目录加载失败/);
  assert.doesNotMatch(html, /找不到这位员工/);
  (button(workspace, 'ent-btn').onClick as () => void)();
  assert.deepEqual(calls, ['retry-directory']);
});

it('preserves recent work links when a refresh fails', () => {
  const { workspace } = makeWorkspace({ workListLoad: { loading: false, error: '工作刷新失败', retry: () => undefined } });
  const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
  assert.match(html, /工作刷新失败/);
  assert.match(html, /商品机会评估/);
});

it('disables chat while employee assignment or availability is being confirmed', () => {
  const { workspace } = makeWorkspace();
  for (const load of [{ loading: true, error: null }, { loading: false, error: '读取失败' }]) {
    for (const key of ['employeeLoad', 'employeeStatusLoad'] as const) {
      assert.equal(button(workspace, 'ent-btn primary', { [key]: { ...load, retry: () => undefined } }).disabled, true);
    }
  }
});

it('does not confirm empty skills when partial library data was skipped', () => {
  for (const employees of [[employee], []]) {
    const { workspace } = makeWorkspace({ employees, skills: [], skillsWarning: '部分技能未能读取' });
    const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
    assert.match(html, /部分技能未能读取/);
    assert.doesNotMatch(html, /当前账号暂无可查看的技能信息|暂未配置可查看的技能/);
  }
});

it('shows organization refresh errors while preserving a cached employee', () => {
  const { workspace, calls } = makeWorkspace({ organizationStatus: 'error', organizationError: '企业目录刷新失败' });
  const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
  assert.match(html, /企业目录刷新失败，已保留当前员工信息/);
  assert.match(html, /市场分析师/);
  const retry = button(workspace, 'ent-btn sm');
  (retry.onClick as () => void)();
  assert.deepEqual(calls, ['retry-directory']);
});
