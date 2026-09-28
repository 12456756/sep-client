import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrganizationPage } from './OrganizationPage';
import type { SiliconEmployee } from '../../features/enterprise/types';
import type { OrganizationCarbonEmployee } from '../../features/enterprise/organization-model';

const employee: SiliconEmployee = {
  id: 'subscription-1', name: '代码助手', avatar: null, avatarAsset: null, mark: 'G', roleName: '研发助理', department: 'Data',
  availability: 'ready', assignedToMe: true, intro: '', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: [], skillIds: [], permissions: [], templateVersion: '1.0',
};

const workspace = { employees: [employee], navigate: () => undefined };

function member(overrides: Partial<OrganizationCarbonEmployee>): OrganizationCarbonEmployee {
  return {
    id: 'enterprise:enterprise-1',
    name: '龙硅科技',
    position: '企业',
    department: '',
    employeeIds: [],
    isCurrent: false,
    kind: 'root',
    parentId: null,
    ...overrides,
  };
}

it('shows loading while organization data is being fetched', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace, organizationStatus: 'loading', members: [],
  }));
  assert.match(html, /正在加载组织架构/);
  assert.match(html, /role="status"/);
});

it('shows an actionable error state when organization loading fails', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace, organizationStatus: 'error', organizationError: 'SEP unavailable', onRetry: () => undefined,
  }));
  assert.match(html, /组织架构加载失败/);
  assert.match(html, /SEP unavailable/);
  assert.match(html, /重新加载/);
  assert.match(html, /role="alert"/);
});

it('keeps an explicitly empty organization empty without deriving data from subscriptions', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace, organizationStatus: 'empty', members: [],
  }));
  assert.match(html, /org-unavailable/);
  assert.match(html, /平台暂无企业成员数据/);
  assert.doesNotMatch(html, /org-tree-shell|代码助手/);
});

it('renders a connected horizontal tree with all four relationship levels', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace,
    organizationStatus: 'ready',
    members: [
      member({ id: 'enterprise:enterprise-1' }),
      member({ id: 'department:research', name: '研发部', position: '部门', department: '研发部', kind: 'department', parentId: 'enterprise:enterprise-1' }),
      member({ id: 'member:current', name: '当前用户', position: '工程师', department: '研发部', kind: 'member', parentId: 'department:research', isCurrent: true, employeeIds: ['subscription-1'] }),
    ],
  }));
  assert.match(html, /org-tree-shell/);
  assert.match(html, /org-tree-company-node/);
  assert.match(html, /org-tree-department-node/);
  assert.match(html, /org-tree-carbon-node/);
  assert.match(html, /org-tree-silicon-node/);
  assert.match(html, /龙硅科技/);
  assert.match(html, /研发部/);
  assert.match(html, /当前用户/);
  assert.match(html, /代码助手/);
  assert.doesNotMatch(html, /企业组织.*组织架构|从企业到员工/);
  assert.doesNotMatch(html, /org-map-groups|org-zoom-controls|org-filter/);
});


it('renders nested departments as parent and child branches, not sibling departments', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace,
    organizationStatus: 'ready',
    members: [
      member({ id: 'enterprise:enterprise-1' }),
      member({ id: 'department:tech', name: '技术部', position: '部门', department: '技术部', kind: 'department', parentId: 'enterprise:enterprise-1' }),
      member({ id: 'department:research', name: '研发组', position: '部门', department: '研发组', kind: 'department', parentId: 'department:tech' }),
      member({ id: 'member:ling', name: '刘凌', position: '负责人', department: '研发组', kind: 'member', parentId: 'department:research', isCurrent: true, employeeIds: ['subscription-1'] }),
    ],
  }));
  assert.match(html, /data-department-id="department:tech"/);
  assert.match(html, /data-department-id="department:research" data-parent-department-id="department:tech"/);
  assert.match(html, /org-tree-subbranches/);
  assert.match(html, /data-department-id="department:tech"[\s\S]*?org-tree-branch-outlet[\s\S]*?data-department-id="department:research"/);
  assert.doesNotMatch(html, /org-tree-collapse-toggle/);
  assert.match(html, /aria-expanded="true" aria-label="刘凌，收起硅基员工"/);
});

it('keeps the default view compact by folding unrelated departments and silicon employees', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace,
    organizationStatus: 'ready',
    members: [
      member({ id: 'enterprise:enterprise-1' }),
      member({ id: 'department:research', name: '研发部', position: '部门', department: '研发部', kind: 'department', parentId: 'enterprise:enterprise-1' }),
      member({ id: 'member:current', name: '当前用户', position: '工程师', department: '研发部', kind: 'member', parentId: 'department:research', isCurrent: true, employeeIds: ['subscription-1'] }),
      member({ id: 'member:colleague', name: '同事甲', position: '设计师', department: '研发部', kind: 'member', parentId: 'department:research', employeeIds: ['subscription-1'] }),
      member({ id: 'department:product', name: '产品部', position: '部门', department: '产品部', kind: 'department', parentId: 'enterprise:enterprise-1' }),
      member({ id: 'member:product', name: '产品同事', position: '产品经理', department: '产品部', kind: 'member', parentId: 'department:product', employeeIds: ['subscription-1'] }),
    ],
  }));
  assert.match(html, /当前用户/);
  assert.match(html, /代码助手/);
  assert.match(html, /同事甲/);
  assert.match(html, /产品部/);
  assert.match(html, /class="org-tree-collapsed-counts"[\s\S]*?<strong>1<\/strong> 成员/);
  assert.match(html, /同事甲[\s\S]*?class="org-tree-silicon-count"[\s\S]*?<strong>1<\/strong> 位硅基员工/);
  assert.doesNotMatch(html, /位成员已折叠|位硅基员工已折叠|点击当前用户展开/);
  assert.doesNotMatch(html, /产品同事[\s\S]*?代码助手/);
  assert.match(html, /aria-expanded="false"/);
});

it('shows honest empty authorization state for a carbon employee', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace,
    organizationStatus: 'ready',
    members: [
      member({ id: 'enterprise:enterprise-1' }),
      member({ id: 'member:current', name: '当前用户', position: '工程师', kind: 'member', parentId: 'enterprise:enterprise-1', isCurrent: true }),
    ],
  }));
  assert.match(html, /暂未配置可用的硅基员工/);
  assert.doesNotMatch(html, /代码助手/);
});

it('does not fabricate organization members from local employee subscriptions', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace, members: [member({ id: 'enterprise:enterprise-1' })], organizationStatus: 'ready',
  }));
  assert.match(html, /没有找到匹配的组织成员|暂无/);
  assert.doesNotMatch(html, /代码助手/);
});

it('keeps the old omitted-members call compatible as an empty state', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, { workspace }));
  assert.match(html, /org-unavailable/);
});
