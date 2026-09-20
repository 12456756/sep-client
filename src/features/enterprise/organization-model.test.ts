import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { OrganizationCarbonEmployee } from './organization-model';
import {
  buildOrganizationBranches,
  buildOrganizationTree,
  filterOrganizationTree,
  getOrganizationDepartments,
  usableSiliconEmployeesForMember,
} from './organization-model';
import type { SiliconEmployee } from './types';

// Test-only fixtures: no runtime roster or inferred reporting relationships.
const members: OrganizationCarbonEmployee[] = [
  { id: 'root', name: 'Enterprise', position: '', department: '', employeeIds: [], isCurrent: false, kind: 'root', parentId: null },
  { id: 'lead', name: 'Lead', position: 'Manager', department: 'Data', employeeIds: [], isCurrent: false, kind: 'leader', parentId: 'root' },
  { id: 'member', name: 'Member', position: 'Analyst', department: 'Data', employeeIds: ['subscription-1'], isCurrent: true, kind: 'member', parentId: 'lead' },
];
const employee: SiliconEmployee = {
  id: 'subscription-1', name: 'Analyst', avatar: null, avatarAsset: null, mark: 'A', roleName: 'Analysis', department: 'Data',
  availability: 'ready', assignedToMe: true, intro: '', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: [], skillIds: [], permissions: [], templateVersion: '1.0',
};

describe('organization without fabricated data', () => {
  it('does not contain a runtime roster generator or infer the current department', () => {
    const source = readFileSync(new URL('./organization-model.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /buildDemoCarbonEmployees|inferCurrentDepartment|partitionIds|demoMemberCount/);
  });
  it('does not manufacture roots, members or departments when there is no data', () => {
    assert.deepEqual(buildOrganizationTree([]), []);
    assert.deepEqual(buildOrganizationBranches([]), []);
    assert.deepEqual(getOrganizationDepartments([]), []);
  });
  it('preserves only the supplied hierarchy without modifying its source', () => {
    const before = structuredClone(members);
    const tree = buildOrganizationTree(members);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].children[0].member.id, 'lead');
    assert.equal(tree[0].children[0].children[0].member.id, 'member');
    assert.deepEqual(members, before);
  });
  it('retains the ancestor path for a matching member', () => {
    const filtered = filterOrganizationTree(buildOrganizationTree(members), 'Analyst', '');
    assert.equal(filtered[0].children[0].children[0].matched, true);
    assert.deepEqual(filterOrganizationTree(buildOrganizationTree(members), 'missing', ''), []);
  });
  it('uses only explicit grants, not department membership', () => {
    assert.deepEqual(usableSiliconEmployeesForMember(members[1], [employee]), []);
    assert.deepEqual(usableSiliconEmployeesForMember(members[2], [employee]).map(item => item.id), ['subscription-1']);
  });
  it('does not substitute an employee ID for a subscription grant', () => {
    assert.deepEqual(usableSiliconEmployeesForMember({ ...members[2], employeeIds: ['employee-1'] }, [employee]), []);
  });
  it('deduplicates departments and excludes missing values', () => {
    assert.deepEqual(getOrganizationDepartments([{ department: 'Data' }, { department: null }, { department: 'Data' }]), ['Data']);
  });
});
