import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmployeeCard } from '../../components/enterprise/EmployeeCard';
import { EmployeesPage } from './EmployeesPage';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SiliconEmployee } from '../../features/enterprise/types';
import type { SkillLibraryItem } from '../../shared/skill-library';

const employee: SiliconEmployee = {
  id: 'test-subscription', name: '测试员工', avatar: null, avatarAsset: null, mark: '测', roleName: 'LEGACY_ROLE', department: 'LEGACY_DEPARTMENT',
  availability: 'ready', assignedToMe: true, intro: '测试员工介绍', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: [], skillIds: [], permissions: [], templateVersion: '1.0',
};
const skill: SkillLibraryItem = {
  capability: { id: 'skill-a', name: '市场机会分析', description: '评估商品和市场机会', type: 'general' },
  bindings: [{ subscriptionId: employee.id, employeeId: employee.id, currentVersion: null, selectedVersionId: null }],
  usableVersionIds: [], versions: [], localVersions: [],
};
const workspace = {
  employees: [employee], organizationEmployees: [{ ...employee, id: 'roster-only', name: '企业员工' }], skills: [skill],
  navigate: () => undefined, busy: false, organizationStatus: 'ready', organizationError: null, retryOrganization: () => undefined,
  skillsLoading: false, skillsError: null, skillsRetrySeconds: null, refreshSkills: async () => undefined,
} as unknown as EnterpriseWorkspace;

function assertNoEmployeeOrganization(html: string): void {
  assert.doesNotMatch(html, /LEGACY_ROLE|LEGACY_DEPARTMENT|按职能筛选|按部门筛选|安排工作/);
}

for (const compact of [false, true]) {
  it(`employee card (${compact ? 'list' : 'grid'}) exposes details and real bound skills`, () => {
    const html = renderToStaticMarkup(createElement(EmployeeCard, { employee, skills: [skill], compact, onOpen: () => undefined, onChat: () => undefined }));
    assertNoEmployeeOrganization(html);
    assert.match(html, /开始对话/);
    assert.match(html, /aria-label="查看测试员工详情"/);
    assert.doesNotMatch(html, />查看详情<|ent-emp-details/);
    assert.match(html, /市场机会分析/);
    assert.doesNotMatch(html, /已授权|尚无记录|查看技能/);
  });
}
it('employee list searches real skill names and supports both scopes', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, { workspace }));
  assertNoEmployeeOrganization(html);
  assert.match(html, /按可用状态筛选/);
  assert.match(html, /搜索员工或技能/);
  assert.match(html, /role="group" aria-label="员工范围"/);
  assert.match(html, /aria-pressed="true"/);
  const all = renderToStaticMarkup(createElement(EmployeesPage, { workspace, scope: 'all' }));
  assert.match(all, /企业员工/);
  assert.match(all, /2 名员工/);
});

for (const compact of [false, true]) {
  it('unassigned employee can view details but cannot start a conversation', () => {
    const html = renderToStaticMarkup(createElement(EmployeeCard, { employee: { ...employee, assignedToMe: false }, compact, onOpen: () => undefined }));
    assert.doesNotMatch(html, /申请使用|安排工作/);
    assert.match(html, /disabled=""[^>]*>[\s\S]*?开始对话/);
    assert.match(html, /aria-label="查看测试员工详情"/);
    assert.doesNotMatch(html, />查看详情<|ent-emp-details/);
  });
}

it('employee card omits unavailable description, empty skills and empty last-work metadata', () => {
  const sparse = { ...employee, intro: '', goodAt: [], lastWorkedAt: null };
  const html = renderToStaticMarkup(createElement(EmployeeCard, { employee: sparse, onOpen: () => undefined }));
  assert.doesNotMatch(html, /测试员工介绍|尚无记录|sparkles|已授权/);
});

it('controlled scope takes precedence over a standalone initial scope', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, {
    workspace, scope: 'mine', state: { scope: 'all', search: '', availability: '', view: 'cards', scrollTop: 0, focusId: null },
  }));
  assert.match(html, /企业员工/);
  assert.match(html, /2 名员工/);
});

it('failed or loading directory preserves cached employees without claiming a confirmed total', () => {
  for (const organizationStatus of ['loading', 'error'] as const) {
    const html = renderToStaticMarkup(createElement(EmployeesPage, { workspace: { ...workspace, organizationStatus }, scope: 'all' }));
    assert.match(html, /企业员工/);
    assert.doesNotMatch(html, /2 名员工|暂未分配员工/);
    assert.match(html, /员工数量确认中|员工数量暂不可用/);
  }
});

it('failed subscriptions do not also show an empty assignment state', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, {
    workspace: { ...workspace, employees: [] }, employeeLoad: { loading: false, error: '订阅获取失败', retry: () => undefined },
  }));
  assert.match(html, /订阅获取失败/);
  assert.doesNotMatch(html, /暂未分配员工|0 名员工/);
});

it('skill retry shows the cooldown and exposes only supported status filters', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, {
    workspace: { ...workspace, skillsError: '请求过于频繁', skillsRetrySeconds: 12 },
  }));
  assert.match(html, /disabled=""[^>]*>12 秒后重试/);
  assert.doesNotMatch(html, /option value="needs-auth"/);
});

for (const compact of [false, true]) {
  for (const availability of ['unavailable', 'needs-auth'] as const) {
    it(`shared ${compact ? 'list' : 'card'} independently disables ${availability} employees and describes why`, () => {
      const html = renderToStaticMarkup(createElement(EmployeeCard, {
        employee: { ...employee, availability }, compact, onOpen: () => undefined, onChat: () => undefined,
      }));
      assert.match(html, /disabled=""[^>]*aria-describedby="employee-chat-disabled-test-subscription"/);
      assert.match(html, /id="employee-chat-disabled-test-subscription"[^>]*>员工/);
    });
  }
  it(`shared ${compact ? 'list' : 'card'} visibly explains unassigned employees`, () => {
    const html = renderToStaticMarkup(createElement(EmployeeCard, {
      employee: { ...employee, assignedToMe: false }, compact, onOpen: () => undefined, onChat: () => undefined,
    }));
    assert.match(html, /id="employee-chat-disabled-test-subscription"[^>]*>尚未分配给你，请联系企业管理员/);
  });
}

it('subscription loading or failure disables cached employee conversations', () => {
  for (const load of [{ loading: true, error: null }, { loading: false, error: '订阅获取失败' }]) {
    const html = renderToStaticMarkup(createElement(EmployeesPage, { workspace, employeeLoad: { ...load, retry: () => undefined } }));
    assert.match(html, /disabled=""[^>]*aria-describedby="employee-chat-disabled-test-subscription"/);
    assert.match(html, /id="employee-chat-disabled-test-subscription"[^>]*>员工订阅正在确认或暂不可用/);
  }
});

it('personal scope honors enterprise access denial without including enterprise-only employees', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, {
    workspace: { ...workspace, organizationEmployees: [{ ...employee, assignedToMe: false }, ...workspace.organizationEmployees.filter(item => item.id !== employee.id)] },
  }));
  assert.match(html, /测试员工/);
  assert.match(html, /1 名员工/);
  assert.doesNotMatch(html, /企业员工<\/strong>/);
  assert.match(html, /disabled=""[^>]*aria-describedby="employee-chat-disabled-test-subscription"/);
  assert.match(html, /id="employee-chat-disabled-test-subscription"[^>]*>尚未分配给你，请联系企业管理员/);
});

it('partial skill results warn that search may be incomplete', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, { workspace: { ...workspace, skillsWarning: '部分员工技能尚未返回。' } }));
  assert.match(html, /部分员工技能尚未返回。 技能搜索结果可能不完整。/);
});


for (const compact of [false, true]) {
  it(`${compact ? 'row' : 'card'} exposes a separate whole-area detail button and conversation button`, () => {
    const html = renderToStaticMarkup(createElement(EmployeeCard, { employee, compact, onOpen: () => undefined, onChat: () => undefined }));
    assert.match(html, /<button id="employee-detail-test-subscription" type="button" class="ent-emp-open" aria-haspopup="dialog" aria-label="查看测试员工详情"><\/button>/);
    assert.equal((html.match(/<button\b/g) ?? []).length, 2);
    assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });
}

it('directory omits the redundant page title and introductory copy', () => {
  const html = renderToStaticMarkup(createElement(EmployeesPage, { workspace }));
  assert.doesNotMatch(html, /<h1|找到合适的员工，把工作交给它完成。/);
});
