import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillLibraryItem } from '../../shared/skill-library';
import type { SiliconEmployee } from './types';
import { selectSkillList, skillEmployeeOptions, skillUsageSummary, uniqueSkillBindings, type SkillListFilters } from './skill-list-model';

const employees = [{ id: 'sub-a', name: '运营 Alice' }, { id: 'sub-b', name: '运营 Alice' }] as SiliconEmployee[];
const base: SkillListFilters = { query: '', employeeFilterId: '', versionFilter: 'all', sort: 'name' };
function skill(id: string, name: string, subscriptions: string[], date?: string): SkillLibraryItem {
  return { capability: { id, name, description: '商品分析', type: 'SKILL' },
    bindings: subscriptions.map(subscriptionId => ({ subscriptionId, employeeId: 'same-template', currentVersion: null, selectedVersionId: null })),
    versions: [], usableVersionIds: [], localVersions: date ? [{ idempotencyKey: id, createdAt: date, request: { capabilityId: id, parentVersionId: 'base', content: '# 原文' } }] : [] };
}
const items = [skill('b', '技能10', ['sub-a', 'sub-b', 'sub-a'], 'invalid'), skill('a', '技能2', ['sub-a'], '2026-10-20'), skill('c', '', ['orphan'])];
const ids = (list: SkillLibraryItem[]) => list.map(item => item.capability.id);

test('employee options count unique skills, distinguish names and preserve unmapped subscriptions', () => {
  const options = skillEmployeeOptions([...items, items[0]], employees);
  assert.equal(options.find(option => option.id === 'sub-a')?.count, 2);
  assert.equal(options.find(option => option.id === 'sub-b')?.count, 1);
  assert.match(options.find(option => option.id === 'sub-a')!.label, /sub-a/);
  assert.match(options.find(option => option.id === 'orphan')!.label, /员工信息暂不可用.*orphan/);
  assert.equal(uniqueSkillBindings(items[0]).length, 2);
});
test('employee, version and search filters intersect using subscriptions rather than template IDs', () => {
  const selectedLocal = { ...items[0], bindings: items[0].bindings.map(binding => ({ ...binding, selectedVersionId: 'b' })) };
  assert.deepEqual(ids(selectSkillList([selectedLocal, ...items.slice(1)], employees, { ...base, query: ' ALICE ', employeeFilterId: 'sub-b', versionFilter: 'personal' })), ['b']);
  assert.deepEqual(selectSkillList(items, employees, { ...base, employeeFilterId: 'same-template' }), []);
  assert.deepEqual(selectSkillList(items, employees, { ...base, query: 'unknown', employeeFilterId: 'sub-a' }), []);
});
test('enterprise and platform sources intersect with the employee filter and preserve sorting', () => {
  const enterprise = { ...items[0], bindings: items[0].bindings.map(binding => ({ ...binding, selectedVersionId: 'enterprise' })), versions: [{ id: 'enterprise', capabilityId: 'b', scope: 'ENTERPRISE', version: '1', status: 'ENTERPRISE_APPROVED' }] };
  const platform = { ...items[1], bindings: items[1].bindings.map(binding => ({ ...binding, selectedVersionId: 'platform' })), versions: [{ id: 'platform', capabilityId: 'a', scope: 'PLATFORM', version: '1', status: 'PLATFORM_APPROVED' }] };
  assert.deepEqual(ids(selectSkillList([enterprise, platform], employees, { ...base, employeeFilterId: 'sub-a', versionFilter: 'enterprise' })), ['b']);
  assert.deepEqual(ids(selectSkillList([enterprise, platform], employees, { ...base, employeeFilterId: 'sub-a', versionFilter: 'platform' })), ['a']);
  assert.deepEqual(selectSkillList([enterprise, platform], employees, { ...base, employeeFilterId: 'sub-b', versionFilter: 'platform' }), []);
});
test('sorts are stable, numeric-aware and do not mutate source arrays', () => {
  const before = structuredClone(items);
  assert.deepEqual(ids(selectSkillList([...items, items[0]], employees, base)), ['a', 'b', 'c']);
  assert.deepEqual(ids(selectSkillList(items, employees, { ...base, sort: 'employees' })), ['b', 'a', 'c']);
  assert.deepEqual(ids(selectSkillList(items, employees, { ...base, sort: 'recent' })), ['a', 'b', 'c']);
  assert.deepEqual(items, before);
});
test('personal creation dates alone determine recent order; remote approval dates are ignored', () => {
  const recent = { ...items[0], localVersions: [], versions: [{ id: 'personal', capabilityId: 'b', scope: 'PERSONAL', version: 'p', status: 'ENTERPRISE_REJECTED', createdAt: '2026-10-21' }] };
  const publicItem = { ...items[2], versions: [{ id: 'public', capabilityId: 'c', scope: 'ENTERPRISE', version: '1', status: 'ENTERPRISE_APPROVED', createdAt: '2026-10-28' }] };
  assert.deepEqual(ids(selectSkillList([items[1], recent, publicItem], employees, { ...base, sort: 'recent' })), ['b', 'a', 'c']);
});
test('usage summary distinguishes mixed, missing and alias-equivalent selections', () => {
  assert.equal(skillUsageSummary(items[0]), '未选择版本');
  const bindings = uniqueSkillBindings(items[0]);
  const mixed = { ...items[0], bindings: bindings.map((binding, i) => ({ ...binding, selectedVersionId: i ? 'uploaded' : 'local' })) };
  assert.equal(skillUsageSummary(mixed), '多个版本');
  assert.equal(skillUsageSummary({ ...mixed, bindings: mixed.bindings.map(binding => ({ ...binding, selectedVersionId: 'gone' })) }), '已选版本不可用');
  const local = { idempotencyKey: 'local', createdAt: '2026-10-20', request: { capabilityId: 'b', parentVersionId: 'base', content: '# text', changeSummary: '个人别名版' }, uploadedVersion: { id: 'uploaded', capabilityId: 'b', scope: 'PERSONAL', status: 'ENTERPRISE_REJECTED', version: 'opaque' } };
  assert.equal(skillUsageSummary({ ...mixed, localVersions: [local] }), '个人别名版');
});
