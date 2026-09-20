import type { EnterpriseOrganization } from '../../shared/platform-supplement-contracts';
import type { OrganizationCarbonEmployee } from './organization-model';
import type { SiliconEmployee } from './types';

function rootId(organization: EnterpriseOrganization): string {
  return `enterprise:${organization.enterprise.id}`;
}

function departmentNodeId(departmentId: string): string {
  return `department:${departmentId}`;
}

function memberNodeId(memberId: string): string {
  return `member:${memberId}`;
}

function isActiveGrant(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > now;
}

/**
 * Converts the platform organization response into the renderer's stable tree model.
 * Reporting hierarchy comes only from department parentId/member departmentId;
 * department leaders are labels, not fabricated personal reporting edges.
 */
export function mapEnterpriseOrganization(
  organization: EnterpriseOrganization,
  currentUserId: string,
  now = Date.now(),
): OrganizationCarbonEmployee[] {
  if (organization.members.length === 0 && organization.departments.length === 0) return [];

  const validSubscriptionIds = new Set(organization.employees.map(employee => employee.subscriptionId));
  const departmentIds = new Set(organization.departments.map(department => department.id));
  const memberIds = new Set(organization.members.map(member => member.id));
  const namesByDepartmentId = new Map(organization.departments.map(department => [department.id, department.name]));
  const root = rootId(organization);

  const grantsByMemberId = new Map<string, Set<string>>();
  const grantsByDepartmentId = new Map<string, Set<string>>();
  for (const grant of organization.grants) {
    if (!isActiveGrant(grant.expiresAt, now) || !validSubscriptionIds.has(grant.subscriptionId)) continue;
    if (grant.memberId && memberIds.has(grant.memberId)) {
      const subscriptions = grantsByMemberId.get(grant.memberId) ?? new Set<string>();
      subscriptions.add(grant.subscriptionId);
      grantsByMemberId.set(grant.memberId, subscriptions);
    }
    if (grant.departmentId && departmentIds.has(grant.departmentId)) {
      const subscriptions = grantsByDepartmentId.get(grant.departmentId) ?? new Set<string>();
      subscriptions.add(grant.subscriptionId);
      grantsByDepartmentId.set(grant.departmentId, subscriptions);
    }
  }

  const departmentsById = new Map(organization.departments.map(department => [department.id, department]));
  const departmentParentId = new Map<string, string>();
  for (const department of organization.departments) {
    const seen = new Set([department.id]);
    let ancestor = department.parentId;
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = departmentsById.get(ancestor)?.parentId ?? null;
    }
    const parent = !ancestor && department.parentId && departmentIds.has(department.parentId)
      ? departmentNodeId(department.parentId)
      : root;
    departmentParentId.set(department.id, parent);
  }

  const nodes: OrganizationCarbonEmployee[] = [{
    id: root,
    name: organization.enterprise.name,
    position: '企业',
    department: '',
    employeeIds: [],
    isCurrent: false,
    kind: 'root',
    parentId: null,
  }];

  const orderedDepartments = [...organization.departments].sort((left, right) => {
    const depth = (departmentId: string, seen = new Set<string>()): number => {
      if (seen.has(departmentId)) return 0;
      const department = organization.departments.find(item => item.id === departmentId);
      if (!department?.parentId || !departmentIds.has(department.parentId)) return 0;
      seen.add(departmentId);
      return 1 + depth(department.parentId, seen);
    };
    return depth(left.id) - depth(right.id) || left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN');
  });
  for (const department of orderedDepartments) {
    const departmentSubscriptions = [...(grantsByDepartmentId.get(department.id) ?? new Set<string>())];
    nodes.push({
      id: departmentNodeId(department.id),
      name: department.name,
      position: '部门',
      department: department.name,
      employeeIds: departmentSubscriptions,
      isCurrent: false,
      kind: 'department',
      parentId: departmentParentId.get(department.id) ?? root,
    });
  }

  for (const member of organization.members) {
    const memberSubscriptions = new Set(grantsByMemberId.get(member.id) ?? []);
    if (member.departmentId) {
      for (const subscriptionId of grantsByDepartmentId.get(member.departmentId) ?? []) {
        memberSubscriptions.add(subscriptionId);
      }
    }
    nodes.push({
      id: memberNodeId(member.id),
      name: member.name,
      position: member.position ?? '企业成员',
      department: member.departmentId ? (namesByDepartmentId.get(member.departmentId) ?? '') : '',
      employeeIds: [...memberSubscriptions],
      isCurrent: member.userId === currentUserId,
      kind: 'member',
      parentId: member.departmentId && departmentIds.has(member.departmentId)
        ? departmentNodeId(member.departmentId)
        : root,
    });
  }

  return nodes;
}



/** Organization visibility does not grant local execution rights. */
export function mapOrganizationEmployees(
  organization: EnterpriseOrganization,
  localEmployees: readonly SiliconEmployee[],
): SiliconEmployee[] {
  const localsById = new Map(localEmployees.map(employee => [employee.id, employee]));
  return organization.employees.map(employee => {
    const local = localsById.get(employee.subscriptionId);
    return {
      id: employee.subscriptionId,
      name: employee.name,
      mark: employee.avatar || employee.name.slice(0, 1),
      roleName: employee.position,
      department: local?.department ?? null,
      availability: !employee.active ? 'unavailable' : employee.employeeStatus === 'WORKING' ? 'working' : 'ready',
      assignedToMe: employee.currentUserCanUse && Boolean(local?.assignedToMe),
      intro: employee.description,
      goodAt: local?.goodAt ?? [],
      cannotDo: local?.cannotDo ?? [],
      lastWorkedAt: local?.lastWorkedAt ?? null,
      allowedModels: local?.allowedModels ?? [],
      skillIds: local?.skillIds ?? [],
      permissions: local?.permissions ?? [],
      templateVersion: local?.templateVersion ?? '',
    };
  });
}
