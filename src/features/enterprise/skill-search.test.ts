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

test('personal-version filter combines with employee search and includes local versions', () => {
  const local = { ...skills[0], localVersions: [{ idempotencyKey: 'local-version', createdAt: '2026-10-14', request: { capabilityId: 'ui', parentVersionId: 'ui-version', content: '# local' } }] };
  assert.deepEqual(ids(filterSkillLibrary(skills, employees, '前端', 'personal')), ['shared']);
  assert.deepEqual(ids(filterSkillLibrary([local, ...skills.slice(1)], employees, '前端', 'personal')), ['ui', 'shared']);
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
