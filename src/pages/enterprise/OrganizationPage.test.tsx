import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrganizationPage } from './OrganizationPage';
import type { SiliconEmployee } from '../../features/enterprise/types';
import type { OrganizationCarbonEmployee } from '../../features/enterprise/organization-model';

const employee: SiliconEmployee = {
  id: 'subscription-1', name: 'Granted employee', mark: 'G', roleName: 'Analyst', department: 'Data',
  availability: 'ready', assignedToMe: true, intro: '', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: [], skillIds: [], permissions: [], templateVersion: '1.0',
};

const workspace = { employees: [employee], navigate: () => undefined };

function member(overrides: Partial<OrganizationCarbonEmployee>): OrganizationCarbonEmployee {
  return {
    id: 'enterprise:enterprise-1',
    name: 'Acme',
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
  assert.doesNotMatch(html, /org-tree-card|Granted employee|carbon-root/);
});

it('renders a member without a department under the enterprise root', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace,
    organizationStatus: 'ready',
    members: [
      member({ id: 'enterprise:enterprise-1' }),
      member({
        id: 'member:unassigned', name: 'Unassigned', position: '企业成员', kind: 'member', parentId: 'enterprise:enterprise-1',
      }),
    ],
  }));
  assert.match(html, /org-tree-card/);
  assert.match(html, /Unassigned/);
  assert.doesNotMatch(html, /org-unavailable/);
});

it('renders nested departments and members returned by SEP', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, {
    workspace,
    organizationStatus: 'ready',
    members: [
      member({ id: 'enterprise:enterprise-1' }),
      member({ id: 'department:research', name: 'Research', position: '部门负责人', department: 'Research', kind: 'leader', parentId: 'enterprise:enterprise-1' }),
      member({ id: 'member:current', name: 'Current User', position: 'Lead', department: 'Research', kind: 'member', parentId: 'department:research', isCurrent: true }),
    ],
  }));
  assert.match(html, /Research/);
  assert.match(html, /下级节点 1 项/);
  assert.match(html, /org-tree-card/);
  assert.doesNotMatch(html, /org-unavailable/);
});

it('keeps the old omitted-members call compatible as an empty state', () => {
  const html = renderToStaticMarkup(createElement(OrganizationPage, { workspace }));
  assert.match(html, /org-unavailable/);
});

describe('organization page contract', () => {
  it('does not fabricate organization data from local employee subscriptions', () => {
    const html = renderToStaticMarkup(createElement(OrganizationPage, {
      workspace, members: [], organizationStatus: 'empty',
    }));
    assert.doesNotMatch(html, /Granted employee/);
  });
});
