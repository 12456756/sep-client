import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrganizationCarbonEmployee } from './organization-model';
import {
  buildOrganizationMap,
  buildOrganizationRelation,
  filterOrganizationMap,
  filterOrganizationRelation,
} from './organization-map-model';

function node(
  id: string,
  kind: OrganizationCarbonEmployee['kind'],
  parentId: string | null,
  overrides: Partial<OrganizationCarbonEmployee> = {},
): OrganizationCarbonEmployee {
  return { id, kind, parentId, name: id, position: kind, department: '', employeeIds: [], isCurrent: false, ...overrides };
}

const members = [
  node('company-1', 'root', null, { name: '龙硅科技' }),
  node('department:research', 'department', 'company-1', { name: '研发部' }),
  node('department:platform', 'department', 'department:research', { name: '平台组' }),
  node('member:alice', 'member', 'department:research', { name: 'Alice', position: '工程师', department: '研发部' }),
  node('member:bob', 'member', 'department:platform', { name: 'Bob', department: '平台组' }),
  node('member:independent', 'member', 'company-1', { name: '未归属成员' }),
];

describe('organization map model', () => {
  it('preserves department hierarchy and groups direct and unassigned members', () => {
    const map = buildOrganizationMap(members);
    assert.equal(map.enterprise?.id, 'company-1');
    assert.deepEqual(map.departments.map(item => item.member.id), ['department:research']);
    assert.deepEqual(map.departments[0]?.members.map(item => item.id), ['member:alice']);
    assert.deepEqual(map.departments[0]?.departments[0]?.members.map(item => item.id), ['member:bob']);
    assert.deepEqual(map.unassignedMembers.map(item => item.id), ['member:independent']);
  });

  it('filters a member while preserving its department path', () => {
    const filtered = filterOrganizationMap(buildOrganizationMap(members), 'bob');
    assert.deepEqual(filtered.departments.map(item => item.member.id), ['department:research']);
    assert.deepEqual(filtered.departments[0]?.departments.map(item => item.member.id), ['department:platform']);
    assert.deepEqual(filtered.departments[0]?.departments[0]?.members.map(item => item.id), ['member:bob']);
    assert.deepEqual(filtered.unassignedMembers, []);
  });

  it('keeps cyclic department data visible as top-level groups', () => {
    const cyclicMembers = [
      node('company-1', 'root', null),
      node('department:a', 'department', 'department:b', { name: 'A' }),
      node('department:b', 'department', 'department:a', { name: 'B' }),
      node('member:alice', 'member', 'department:a', { name: 'Alice' }),
    ];

    const map = buildOrganizationMap(cyclicMembers);
    assert.deepEqual(map.departments.map(item => item.member.id), ['department:a', 'department:b']);
    assert.deepEqual(map.departments[0]?.members.map(item => item.id), ['member:alice']);
  });

  it('shows a department with its members when searching by department name', () => {
    const filtered = filterOrganizationMap(buildOrganizationMap(members), '研发部');
    assert.deepEqual(filtered.departments[0]?.members.map(item => item.id), ['member:alice']);
    assert.deepEqual(filtered.departments[0]?.departments[0]?.members.map(item => item.id), ['member:bob']);
  });
});

describe('organization relation model', () => {
  it('keeps a flat lookup index and nested roots for a left-to-right relation path', () => {
    const relation = buildOrganizationRelation(members);
    assert.equal(relation.enterprise?.name, '龙硅科技');
    assert.deepEqual(relation.departments.map(item => [item.member.id, item.depth, item.parentDepartmentId]), [
      ['department:research', 0, null],
      ['department:platform', 1, 'department:research'],
    ]);
    assert.deepEqual(relation.departments[0]?.members.map(item => item.id), ['member:alice']);
    assert.deepEqual(relation.departments[1]?.members.map(item => item.id), ['member:bob']);
    assert.deepEqual(relation.rootDepartments.map(item => item.member.id), ['department:research']);
    assert.deepEqual(relation.rootDepartments[0]?.children.map(item => item.member.id), ['department:platform']);
    assert.deepEqual(relation.rootDepartments[0]?.children[0]?.parentDepartmentId, 'department:research');
    assert.deepEqual(relation.unassignedMembers.map(item => item.id), ['member:independent']);
  });

  it('preserves ancestors and descendant members when searching a department', () => {
    const filtered = filterOrganizationRelation(buildOrganizationRelation(members), '研发部');
    assert.deepEqual(filtered.departments.map(item => item.member.id), ['department:research', 'department:platform']);
    assert.deepEqual(filtered.departments[0]?.members.map(item => item.id), ['member:alice']);
    assert.deepEqual(filtered.departments[1]?.members.map(item => item.id), ['member:bob']);
  });

  it('keeps only the matching member while retaining its department ancestors', () => {
    const filtered = filterOrganizationRelation(buildOrganizationRelation(members), 'Bob');
    assert.deepEqual(filtered.departments.map(item => item.member.id), ['department:research', 'department:platform']);
    assert.deepEqual(filtered.departments[0]?.members, []);
    assert.deepEqual(filtered.departments[1]?.members.map(item => item.id), ['member:bob']);
  });

  it('does not create organization members from local subscriptions', () => {
    const relation = buildOrganizationRelation([node('company-1', 'root', null)]);
    assert.deepEqual(relation.departments, []);
    assert.deepEqual(relation.unassignedMembers, []);
  });
});
