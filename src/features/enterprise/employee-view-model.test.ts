import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SiliconEmployee, WorkItem } from './types';
import type { SkillLibraryItem } from '../../shared/skill-library';
import { mergeEmployeeDirectory, employeeSkills, filterEmployees, recentEmployeeWorks, employeeChatDisabledReason, subscriptionAvailability } from './employee-view-model';

const employee = (id: string, patch: Partial<SiliconEmployee> = {}): SiliconEmployee => ({
  id, name: '同名员工', avatar: null, avatarAsset: null, mark: '同', roleName: '', department: null,
  availability: 'ready', assignedToMe: true, intro: '', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: [], skillIds: [], permissions: [], templateVersion: '', ...patch,
});
const skill = (id: string, subscriptionId: string): SkillLibraryItem => ({
  capability: { id, name: '市场研究', description: '研究说明', type: 'skill' },
  bindings: [{ subscriptionId, employeeId: 'platform-id', selectedVersionId: null, currentVersion: null }],
  versions: [], usableVersionIds: [], localVersions: [],
});
const work = (id: string, updatedAt: number, participants: string[], currentEmployeeId = '') => ({ id, updatedAt, participants, currentEmployeeId }) as WorkItem;

test('directory merges by subscription ID, preserves personal work state, and respects organization denial', () => {
  const mine = [employee('a', { availability: 'working', lastWorkedAt: 8 }), employee('b')];
  const organization = [employee('a', { intro: '真实介绍' }), employee('c', { assignedToMe: false })];
  const result = mergeEmployeeDirectory(mine, organization);
  assert.deepEqual(result.map(item => item.id), ['a', 'c', 'b']);
  assert.equal(result[0].availability, 'working');
  assert.equal(result[0].intro, '真实介绍');
  assert.equal(result[0].lastWorkedAt, 8);
  assert.equal(mergeEmployeeDirectory(mine, [employee('a', { assignedToMe: false })])[0].assignedToMe, false);
  assert.equal(mergeEmployeeDirectory(mine, [employee('a', { availability: 'unavailable' })])[0].availability, 'unavailable');
  assert.equal(mine[0].intro, '');
});

test('skill search uses exact subscription bindings and intersects with availability', () => {
  const employees = [employee('a', { intro: 'Analysis report' }), employee('b', { availability: 'working' })];
  const skills = [skill('research', 'b'), skill('research', 'b')];
  assert.equal(employeeSkills(skills, 'b').length, 1);
  assert.equal(employeeSkills(skills, 'a').length, 0);
  assert.deepEqual(filterEmployees(employees, skills, ' 市场研究 ', '').map(item => item.id), ['b']);
  assert.deepEqual(filterEmployees(employees, skills, 'ANALYSIS', '').map(item => item.id), ['a']);
  assert.deepEqual(filterEmployees(employees, skills, '市场研究', 'ready'), []);
});

test('recent work is deduplicated, includes current employee, and takes newest three with stable ties', () => {
  const works = [work('old', 1, ['a']), work('c', 4, ['a']), work('b', 4, [], 'a'), work('b', 2, ['a']), work('a', 5, ['a']), work('other', 99, ['b'])];
  assert.deepEqual(recentEmployeeWorks(works, 'a').map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(recentEmployeeWorks(works, 'missing'), []);
});

test('chat requires assignment and actual availability; frontend permissions are irrelevant', () => {
  assert.equal(employeeChatDisabledReason(employee('a', { permissions: [] })), null);
  assert.ok(employeeChatDisabledReason(employee('a', { assignedToMe: false })));
  assert.ok(employeeChatDisabledReason(employee('a', { availability: 'unavailable' })));
  assert.ok(employeeChatDisabledReason(employee('a', { availability: 'needs-auth' })));
  assert.equal(employeeChatDisabledReason(employee('a', { availability: 'working' })), null);
  assert.equal(subscriptionAvailability('ACTIVE', 'WORKING'), 'working');
  assert.equal(subscriptionAvailability('ACTIVE', 'READY'), 'ready');
  assert.equal(subscriptionAvailability('ACTIVE', 'BUSY'), 'working');
  assert.equal(subscriptionAvailability('ACTIVE', 'OFFLINE'), 'ready');
  assert.equal(subscriptionAvailability('ACTIVE', 'ONLINE'), 'ready');
  assert.equal(subscriptionAvailability('EXPIRED', 'READY'), 'unavailable');
  assert.equal(subscriptionAvailability('ACTIVE', undefined), 'unavailable');
});
