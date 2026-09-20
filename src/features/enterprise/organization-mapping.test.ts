import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnterpriseOrganization } from '../../shared/platform-supplement-contracts';
import { mapEnterpriseOrganization, mapOrganizationEmployees } from './organization-mapping';

function fixture(overrides: Partial<EnterpriseOrganization> = {}): EnterpriseOrganization {
  return {
    enterprise: { id: 'enterprise-1', name: 'Acme', logo: null },
    permissions: {
      grantVisibility: 'ENTERPRISE',
      departmentGrantInheritance: 'DIRECT_DEPARTMENT_ONLY',
      personalReportingSupported: false,
    },
    statistics: {
      employeeCount: 1,
      subscriptionCount: 2,
      activeEmployeeCount: 1,
      currentUserAvailableEmployeeCount: 2,
    },
    employees: [
      {
        employeeId: 'employee-1', subscriptionId: 'subscription-1', name: 'Researcher', avatar: null,
        position: 'Researcher', description: '', status: 'ACTIVE', employeeStatus: 'READY',
        endDate: null, active: true, currentUserCanUse: true,
      },
      {
        employeeId: 'employee-2', subscriptionId: 'subscription-2', name: 'Writer', avatar: null,
        position: 'Writer', description: '', status: 'ACTIVE', employeeStatus: 'READY',
        endDate: null, active: true, currentUserCanUse: true,
      },
    ],
    departments: [
      { id: 'dept-parent', name: 'Research', parentId: null, leaderId: 'member-current', sortOrder: 1 },
      { id: 'dept-child', name: 'Content', parentId: 'dept-parent', leaderId: null, sortOrder: 1 },
    ],
    members: [
      { id: 'member-current', userId: 'user-current', name: 'Current User', departmentId: 'dept-parent', position: 'Lead', avatar: null },
      { id: 'member-child', userId: 'user-child', name: 'Child User', departmentId: 'dept-child', position: 'Writer', avatar: null },
      { id: 'member-unassigned', userId: 'user-other', name: 'Unassigned', departmentId: null, position: null, avatar: null },
    ],
    grants: [
      { id: 'grant-member', subscriptionId: 'subscription-1', memberId: 'member-current', departmentId: null, expiresAt: null },
      { id: 'grant-department', subscriptionId: 'subscription-2', memberId: null, departmentId: 'dept-parent', expiresAt: null },
    ],
    ...overrides,
  };
}

describe('mapEnterpriseOrganization', () => {
  it('builds a root, nested departments, and members without mutating the response', () => {
    const source = fixture();
    const before = structuredClone(source);
    const result = mapEnterpriseOrganization(source, 'user-current');

    assert.deepEqual(source, before);
    assert.deepEqual(result.map(item => [item.id, item.parentId, item.kind]), [
      ['enterprise:enterprise-1', null, 'root'],
      ['department:dept-parent', 'enterprise:enterprise-1', 'department'],
      ['department:dept-child', 'department:dept-parent', 'department'],
      ['member:member-current', 'department:dept-parent', 'member'],
      ['member:member-child', 'department:dept-child', 'member'],
      ['member:member-unassigned', 'enterprise:enterprise-1', 'member'],
    ]);
    assert.equal(result.find(item => item.id === 'member:member-current')?.isCurrent, true);
  });

  it('maps direct member grants and direct department grants using subscriptionId only', () => {
    const result = mapEnterpriseOrganization(fixture(), 'user-current');
    assert.deepEqual(result.find(item => item.id === 'member:member-current')?.employeeIds, ['subscription-1', 'subscription-2']);
    assert.deepEqual(result.find(item => item.id === 'member:member-child')?.employeeIds, []);
    assert.deepEqual(result.find(item => item.id === 'member:member-unassigned')?.employeeIds, []);
  });

  it('ignores invalid relationships and keeps valid members visible', () => {
    const source = fixture({
      departments: [{ id: 'dept-valid', name: 'Valid', parentId: 'missing', leaderId: 'missing', sortOrder: 1 }],
      members: [{ id: 'member-valid', userId: 'user-valid', name: 'Valid', departmentId: 'missing', position: null, avatar: null }],
      grants: [{ id: 'bad', subscriptionId: 'employee-1', memberId: 'missing', departmentId: 'missing', expiresAt: null }],
    });
    const result = mapEnterpriseOrganization(source, 'user-valid');
    assert.deepEqual(result.map(item => item.id), ['enterprise:enterprise-1', 'department:dept-valid', 'member:member-valid']);
    assert.deepEqual(result.find(item => item.id === 'member:member-valid')?.employeeIds, []);
  });

  it('returns no nodes for an empty platform organization', () => {
    const source = fixture({ departments: [], members: [], grants: [], employees: [] });
    assert.deepEqual(mapEnterpriseOrganization(source, 'user-current'), []);
  });
});


describe('organization directory display', () => {
  it('uses platform employees even if they are absent from the local subscription directory', () => {
    const employees = mapOrganizationEmployees(fixture(), []);
    assert.deepEqual(employees.map(employee => employee.id), ['subscription-1', 'subscription-2']);
    assert.equal(employees[0]?.name, 'Researcher');
    assert.equal(employees[0]?.assignedToMe, false);
    assert.deepEqual(employees[0]?.allowedModels, []);
  });

  it('keeps departments distinct from people and marks only the current member', () => {
    const nodes = mapEnterpriseOrganization(fixture(), 'user-current');
    assert.equal(nodes.find(node => node.id === 'department:dept-parent')?.kind, 'department');
    assert.deepEqual(nodes.filter(node => node.isCurrent).map(node => node.id), ['member:member-current']);
  });

  it('excludes expired and malformed grants', () => {
    const source = fixture({ grants: [
      { id: 'expired', subscriptionId: 'subscription-1', memberId: 'member-current', departmentId: null, expiresAt: '2026-01-01T00:00:00Z' },
      { id: 'invalid', subscriptionId: 'subscription-2', memberId: 'member-current', departmentId: null, expiresAt: 'bad-date' },
    ] });
    const nodes = mapEnterpriseOrganization(source, 'user-current', Date.parse('2026-09-17T00:00:00Z'));
    assert.deepEqual(nodes.find(node => node.id === 'member:member-current')?.employeeIds, []);
  });

  it('keeps departments and members reachable even when parent relationships form a cycle', () => {
    const source = fixture();
    const cyclic = { ...source, departments: source.departments.map(department => ({
      ...department, parentId: department.id === 'dept-parent' ? 'dept-child' : 'dept-parent',
    })) };
    const nodes = mapEnterpriseOrganization(cyclic, 'user-current');
    for (const node of nodes) {
      const seen = new Set<string>();
      let current: typeof node | undefined = node;
      while (current) {
        assert.equal(seen.has(current.id), false, 'must not contain a parent cycle');
        seen.add(current.id);
        current = nodes.find(candidate => candidate.id === current?.parentId);
      }
      assert.ok(seen.has('enterprise:enterprise-1'));
    }
  });
});


it('preserves configured departments even before members are added', () => {
  const nodes = mapEnterpriseOrganization(fixture({ members: [], grants: [] }), 'user-current');
  assert.deepEqual(nodes.map(node => node.id), ['enterprise:enterprise-1', 'department:dept-parent', 'department:dept-child']);
});
