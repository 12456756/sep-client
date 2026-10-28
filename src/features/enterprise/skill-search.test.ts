import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillLibraryItem } from '../../shared/skill-library';
import { filterSkillLibrary } from './skill-search';

const employees = [
  { id: 'sub-front', name: '前端工程师 Alice' },
  { id: 'sub-back', name: '后端工程师 Bob' },
];
function skill(id: string, name: string, description: string, subscriptionIds: string[], personal = false): SkillLibraryItem {
  const version = { id: `${id}-version`, capabilityId: id, scope: personal ? 'PERSONAL' : 'ENTERPRISE', version: '1.0', status: 'ENTERPRISE_APPROVED' };
  return {
    capability: { id, name, description, type: 'SKILL' },
    bindings: subscriptionIds.map(subscriptionId => ({ subscriptionId, employeeId: `employee-${subscriptionId}`, currentVersion: version, selectedVersionId: version.id })),
    versions: [version], usableVersionIds: [version.id], localVersions: [],
  };
}
const skills = [
  skill('ui', 'UI Designer', '设计页面', ['sub-front']),
  skill('shared', 'Code Review', '检查代码', ['sub-front', 'sub-back'], true),
  skill('api', 'API Design', '设计接口', ['sub-back']),
];
const ids = (items: SkillLibraryItem[]) => items.map(item => item.capability.id);

test('employee search returns all associated skills once, using subscription IDs', () => {
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '前端', 'all')), ['ui', 'shared']);
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '工程师', 'all')), ['ui', 'shared', 'api']);
});

test('employee search ignores case and surrounding whitespace', () => {
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '  ALICE  ', 'all')), ['ui', 'shared']);
});

test('skill names and descriptions still match independently of employee names', () => {
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, 'ui designer', 'all')), ['ui']);
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '接口', 'all')), ['api']);
});

test('personal-version filter combines with employee search and includes selected local versions', () => {
  const local = { ...skills[0], bindings: skills[0].bindings.map(binding => ({ ...binding, selectedVersionId: 'local-version' })), localVersions: [{ idempotencyKey: 'local-version', createdAt: '2026-10-14', request: { capabilityId: 'ui', parentVersionId: 'ui-version', content: '# local' } }] };
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '前端', 'personal')), ['shared']);
  assert.deepEqual(ids(filterSkillLibrary([local, ...skills.slice(1)], employees, '前端', 'personal')), ['ui', 'shared']);
});

test('version filters follow current selections rather than available or historical versions', () => {
  const enterprise = skills[0];
  const personal = skills[1];
  const platform = { ...skills[2], versions: skills[2].versions.map(version => ({ ...version, scope: 'PLATFORM' })) };
  const platformWithHistory = { ...platform, versions: [...enterprise.versions, ...personal.versions, ...platform.versions], localVersions: [{ idempotencyKey: 'unused-local', createdAt: '2026-10-28', request: { capabilityId: 'api', parentVersionId: 'api-version', content: '# local' } }] };
  const empty = { ...enterprise, capability: { ...enterprise.capability, id: 'empty' }, versions: [], localVersions: [] };
  const library = [enterprise, personal, platformWithHistory, empty];
  assert.deepEqual(ids(filterSkillLibrary(library, employees, '', 'enterprise')), ['ui']);
  assert.deepEqual(ids(filterSkillLibrary(library, employees, '', 'platform')), ['api']);
  assert.deepEqual(ids(filterSkillLibrary(library, employees, '', 'personal')), ['shared']);
  assert.equal(filterSkillLibrary(library, employees, '', 'all').length, 4);
  assert.deepEqual(ids(filterSkillLibrary(library, employees, 'Bob', 'platform')), ['api']);
  assert.deepEqual(filterSkillLibrary(library, employees, 'Alice', 'platform'), []);
  const switched = { ...platformWithHistory, bindings: platformWithHistory.bindings.map(binding => ({ ...binding, selectedVersionId: enterprise.versions[0].id })) };
  assert.deepEqual(ids(filterSkillLibrary([switched], employees, '', 'enterprise')), ['api']);
  assert.deepEqual(filterSkillLibrary([switched], employees, '', 'platform'), []);
});

test('mixed employee selections match their used sources once, without depending on usability', () => {
  const mixed = { ...skills[1], versions: [...skills[0].versions, ...skills[1].versions], usableVersionIds: [], bindings: skills[1].bindings.map((binding, i) => ({ ...binding, selectedVersionId: i ? skills[0].versions[0].id : skills[1].versions[0].id })) };
  assert.deepEqual(ids(filterSkillLibrary([mixed], employees, '', 'enterprise')), ['shared']);
  assert.deepEqual(ids(filterSkillLibrary([mixed], employees, '', 'personal')), ['shared']);
  assert.deepEqual(filterSkillLibrary([mixed], employees, '', 'platform'), []);
});

test('local and uploaded aliases classify as personal; empty or unknown selections have no category', () => {
  const uploadedVersion = { id: 'uploaded', capabilityId: 'ui', scope: 'PERSONAL', status: 'ENTERPRISE_REJECTED', version: 'opaque' };
  const local = { ...skills[0], localVersions: [{ idempotencyKey: 'local', createdAt: '2026-10-28', request: { capabilityId: 'ui', parentVersionId: 'ui-version', content: '# local' }, uploadedVersion }] };
  for (const selectedVersionId of ['local', 'uploaded']) {
    const selected = { ...local, bindings: local.bindings.map(binding => ({ ...binding, selectedVersionId })) };
    assert.deepEqual(ids(filterSkillLibrary([selected], employees, '', 'personal')), ['ui']);
    assert.deepEqual(filterSkillLibrary([selected], employees, '', 'enterprise'), []);
  }
  for (const selectedVersionId of [null, 'missing']) {
    const unavailable = { ...local, bindings: local.bindings.map(binding => ({ ...binding, selectedVersionId })) };
    assert.deepEqual(filterSkillLibrary([unavailable], employees, '', 'personal'), []);
    assert.deepEqual(filterSkillLibrary([unavailable], employees, '', 'enterprise'), []);
    assert.deepEqual(filterSkillLibrary([unavailable], employees, '', 'platform'), []);
    assert.deepEqual(filterSkillLibrary([unavailable], employees, '', 'all'), [unavailable]);
  }
});

test('empty search preserves ordering and the version filter', () => {
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '  ', 'all')), ['ui', 'shared', 'api']);
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '', 'personal')), ['shared']);
});

test('missing employees do not crash or prevent skill metadata searches', () => {
  assert.deepEqual(ids(filterSkillLibrary(skills, [], '设计', 'all')), ['ui', 'api']);
  assert.deepEqual(filterSkillLibrary(skills, [], 'Alice', 'all'), []);
  assert.deepEqual(filterSkillLibrary(skills, employees, '未匹配的员工', 'all'), []);
  assert.deepEqual(filterSkillLibrary([], employees, '前端', 'all'), []);
});

test('employee search uses the current employee list without stale names', () => {
  const renamed = employees.map(employee => ({ ...employee, name: '新员工' }));
  assert.deepEqual(filterSkillLibrary(skills, renamed, 'Alice', 'all'), []);
  assert.deepEqual(ids(filterSkillLibrary(skills, renamed, '新员工', 'all')), ['ui', 'shared', 'api']);
});
