import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmployeeDeskCard } from '../../components/enterprise/EmployeeDeskCard';
import { EmployeeCard } from '../../components/enterprise/EmployeeCard';
import { EmployeesPage } from './EmployeesPage';
import { EmployeeDetailPage } from './EmployeeDetailPage';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee } from '../../features/enterprise/types';

const employee: SiliconEmployee = {
  id: 'test-subscription', name: '测试员工', avatar: null, avatarAsset: null, mark: '测', roleName: 'LEGACY_ROLE', department: 'LEGACY_DEPARTMENT',
  availability: 'ready', assignedToMe: true, intro: '测试员工介绍', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: [], skillIds: [], permissions: [], templateVersion: '1.0',
};
const workspace = { employees: [employee], skills: [], navigate: () => undefined, busy: false } as unknown as EnterpriseWorkspace;

function assertNoEmployeeOrganization(html: string): void {
  assert.doesNotMatch(html, /LEGACY_ROLE|LEGACY_DEPARTMENT|按职能筛选|按部门筛选|安排工作/);
}

for (const compact of [false, true]) {
  it(`employee card (${compact ? 'compact' : 'grid'}) has only chat and skill actions`, () => {
    const html = renderToStaticMarkup(createElement(EmployeeCard, { employee, compact, onOpen: () => undefined, onChat: () => undefined }));
    assertNoEmployeeOrganization(html);
    assert.match(html, /开始对话/);
    assert.match(html, /查看技能/);
  });
}
it('employee list has no role or department filters', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, { workspace }));
  assertNoEmployeeOrganization(html);
  assert.match(html, /按可用状态筛选/);
  assert.match(html, /搜索员工/);
});
it('employee detail retains chat and skills without organization metadata or arrange action', () => {
  const html = renderToStaticMarkup(createElement(EmployeeDetailPage, { workspace, employeeId: employee.id }));
  assertNoEmployeeOrganization(html);
  assert.match(html, /开始对话/);
  assert.match(html, /查看技能/);
  assert.match(html, /模板版本 1.0/);
});

it('home employee card does not expose role or department in text or accessible labels', () => {
  const html = renderToStaticMarkup(createElement(EmployeeDeskCard, { employee, load: { done: 0, total: 0 }, working: false, flags: [], onOpen: () => undefined }));
  assertNoEmployeeOrganization(html);
});

for (const compact of [false, true]) {
  it('unassigned employee keeps the two entries but cannot start a conversation', () => {
    const html = renderToStaticMarkup(createElement(EmployeeCard, { employee: { ...employee, assignedToMe: false }, compact, onOpen: () => undefined }));
    assert.doesNotMatch(html, /申请使用|安排工作/);
    assert.match(html, /disabled=""[^>]*>[\s\S]*?开始对话/);
    assert.match(html, /查看技能/);
  });
}
