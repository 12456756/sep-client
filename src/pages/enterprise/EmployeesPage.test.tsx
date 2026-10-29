import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmployeeCard } from '../../components/enterprise/EmployeeCard';
import { EmployeePortrait } from '../../components/enterprise/EmployeePortrait';
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
  assert.doesNotMatch(html, /ent-emp-speech/);
});

it('speech combines the actual introduction and all unique skills without duplicating content below the name', () => {
  const second = { ...skill, capability: { ...skill.capability, id: 'skill-b', name: '商品机会评分' } };
  const html = renderToStaticMarkup(createElement(EmployeeCard, {
    employee: { ...employee, intro: '筛选有需求证据但尚未充分满足的商品机会。' },
    skills: [skill, second, skill], onOpen: () => undefined,
  }));
  assert.match(html, /我可以筛选有需求证据但尚未充分满足的商品机会，擅长<strong>市场机会分析<\/strong>和<strong>商品机会评分<\/strong>。/);
  assert.equal((html.match(/市场机会分析/g) ?? []).length, 1);
  assert.equal((html.match(/筛选有需求证据/g) ?? []).length, 1);
  assert.doesNotMatch(html, /ent-emp-card-intro|ent-emp-card-skills/);
  assert.match(html, /<header><div class="ent-emp-card-id"><strong title="测试员工">测试员工<\/strong><\/div><\/header>/);
  assert.doesNotMatch(html, /ent-emp-person-status|class="ent-chip/);
});

for (const [intro, expected] of [
  ['我可以分析商品机会。', '我可以分析商品机会。'],
  ['可以分析商品机会。', '我可以分析商品机会。'],
  ['负责整理资料！', '我负责整理资料。'],
  ['分析商品机会', '我可以分析商品机会。'],
]) {
  it(`speech retains first-person grammar for introduction: ${intro}`, () => {
    const html = renderToStaticMarkup(createElement(EmployeeCard, { employee: { ...employee, intro }, onOpen: () => undefined }));
    assert.ok(html.includes(expected));
    assert.doesNotMatch(html, /我可以我|我可以可以|擅长|ent-emp-card-intro/);
  });
}

it('skills alone form a real first-person introduction and blank skill names are omitted', () => {
  const blank = { ...skill, capability: { ...skill.capability, name: ' ' } };
  const html = renderToStaticMarkup(createElement(EmployeeCard, {
    employee: { ...employee, intro: ' ' }, skills: [skill, blank], onOpen: () => undefined,
  }));
  assert.match(html, /我擅长<strong>市场机会分析<\/strong>。/);
  assert.doesNotMatch(html, /我可以|ent-emp-card-intro|ent-emp-card-skills/);
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

it('people view shows the selected digital companion while compact rows retain their small identity avatar', () => {
  const portrait = renderToStaticMarkup(createElement(EmployeeCard, { employee, onOpen: () => undefined, onChat: () => undefined }));
  assert.match(portrait, /ent-emp-person-stage/);
  assert.match(portrait, /class="employee-portrait/);
  assert.match(portrait, /data-character="soft-digital-companion"/);
  assert.match(portrait, /data-palette="[^"]+"/);
  assert.match(portrait, /data-expression="[^"]+"/);
  assert.doesNotMatch(portrait, /employee-portrait-orbit/);
  assert.doesNotMatch(portrait, /ent-card\s/);
  const compact = renderToStaticMarkup(createElement(EmployeeCard, { employee, compact: true, onOpen: () => undefined }));
  assert.match(compact, /ent-face sm/);
  assert.doesNotMatch(compact, /class="employee-portrait/);
});

it('a platform avatar never replaces the unified illustrated employee identity', () => {
  const html = renderToStaticMarkup(createElement(EmployeePortrait, { employee: { ...employee, avatar: 'https://example.invalid/old-face.png' } }));
  assert.doesNotMatch(html, /<image|<img|old-face/);
  assert.match(html, /employee-portrait-head/);
  assert.match(html, /employee-portrait-body/);
  assert.match(html, /employee-portrait-visor/);
  assert.doesNotMatch(html, /employee-portrait-hair|employee-portrait-skin|<svg/);
});

it('real employee status changes the pose while preserving generated appearance', () => {
  const identities = new Set<string>();
  const poses = new Set<string>();
  for (const availability of ['ready', 'working', 'unavailable', 'needs-auth'] as const) {
    const html = renderToStaticMarkup(createElement(EmployeePortrait, { employee: { ...employee, availability } }));
    identities.add(html.match(/data-appearance="([^"]+)"/)![1]);
    poses.add(html.match(/employee-portrait-pose-([^"\s]+)/)![1]);
    assert.match(html, new RegExp(`data-pose="${availability}"`));
    assert.match(html, /aria-label="测试员工，.+数字员工形象"/);
    assert.equal(html.includes('employee-portrait-laptop'), availability === 'working');
    assert.equal(html.includes('employee-portrait-document'), availability === 'needs-auth');
  }
  assert.equal(identities.size, 1);
  assert.equal(poses.size, 4);
});
