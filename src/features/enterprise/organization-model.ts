import type { EmployeeAvailability, SiliconEmployee } from './types';

export type OrganizationAvailabilityFilter = '' | EmployeeAvailability;

export type OrganizationCarbonKind = 'root' | 'department' | 'leader' | 'member';

export interface OrganizationCarbonEmployee {
  id: string;
  name: string;
  position: string;
  department: string;
  employeeIds: string[];
  isCurrent: boolean;
  kind: OrganizationCarbonKind;
  parentId: string | null;
}

export interface OrganizationBranch {
  leader: OrganizationCarbonEmployee;
  members: OrganizationCarbonEmployee[];
}

export function getOrganizationDepartments(
  employees: readonly { department: string | null }[],
): string[] {
  return [...new Set(
    employees
      .map(employee => employee.department)
      .filter((department): department is string => Boolean(department)),
  )].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export function matchesOrganizationMember(
  member: OrganizationCarbonEmployee,
  term: string,
  department: string,
): boolean {
  if (department && member.department !== department) return false;
  if (!term) return true;

  return [member.name, member.position, member.department]
    .some(value => value.toLocaleLowerCase().includes(term));
}

export function filterOrganizationMembers(
  members: readonly OrganizationCarbonEmployee[],
  search: string,
  department: string,
): OrganizationCarbonEmployee[] {
  const term = search.trim().toLocaleLowerCase();
  return members.filter(member => matchesOrganizationMember(member, term, department));
}

/**
 * 在树形分支上筛选：命中负责人的时候保留其全部下属以维持上下文；只命中某个成员时，
 * 也保留该成员并把它挂回对应负责人下面，避免「搜得到成员却看不到整棵树」。
 */
export function filterOrganizationBranches(
  branches: readonly OrganizationBranch[],
  search: string,
  department: string,
): OrganizationBranch[] {
  const term = search.trim().toLocaleLowerCase();
  const hasFilter = Boolean(term) || Boolean(department);

  return branches
    .map(branch => {
      const leaderMatches = matchesOrganizationMember(branch.leader, term, department);
      const members = leaderMatches
        ? [...branch.members]
        : branch.members.filter(member => matchesOrganizationMember(member, term, department));
      return { leader: branch.leader, members };
    })
    .filter(branch => {
      if (!hasFilter) return true;
      return matchesOrganizationMember(branch.leader, term, department) || branch.members.length > 0;
    });
}

/** 从扁平列表按 parentId 聚合成「负责人 → 并行成员」的树形分支。 */
export function buildOrganizationBranches(
  members: readonly OrganizationCarbonEmployee[],
): OrganizationBranch[] {
  const membersByLeader = new Map<string, OrganizationCarbonEmployee[]>();

  members.forEach(member => {
    if (member.kind !== 'member' || !member.parentId) return;
    const siblings = membersByLeader.get(member.parentId) ?? [];
    membersByLeader.set(member.parentId, [...siblings, member]);
  });

  return members
    .filter(member => member.kind === 'leader')
    .map(leader => ({ leader, members: membersByLeader.get(leader.id) ?? [] }));
}

export function usableSiliconEmployeesForMember(
  member: OrganizationCarbonEmployee,
  employees: readonly SiliconEmployee[],
): SiliconEmployee[] {
  const employeeIds = new Set(member.employeeIds);
  return employees.filter(employee => employeeIds.has(employee.id));
}

export function filterOrganizationEmployees(
  employees: readonly SiliconEmployee[],
  search: string,
  department: string,
  availability: OrganizationAvailabilityFilter,
): SiliconEmployee[] {
  const term = search.trim().toLocaleLowerCase();

  return employees.filter(employee => {
    if (department && employee.department !== department) return false;
    if (availability && employee.availability !== availability) return false;
    if (!term) return true;

    return [employee.name, employee.roleName, employee.department ?? '', ...employee.goodAt]
      .some(value => value.toLocaleLowerCase().includes(term));
  });
}

export function enabledPermissionCount(employee: SiliconEmployee): number {
  return employee.permissions.filter(permission => permission.enabled).length;
}

// ── 组织树：用于分层展示与展开/收起 ─────────────────────────────

export interface OrganizationTreeNode {
  member: OrganizationCarbonEmployee;
  children: OrganizationTreeNode[];
}

export interface FilteredOrganizationNode {
  member: OrganizationCarbonEmployee;
  children: FilteredOrganizationNode[];
  /** 当前节点本身是否命中搜索词（用于高亮），部门筛选不算命中。 */
  matched: boolean;
  /** 子树里是否存在命中节点（用于自动展开祖先路径）。 */
  containsMatch: boolean;
}

/** 按 parentId 把扁平的碳基员工聚合成树。parentId 为 null 的是根节点。 */
export function buildOrganizationTree(
  members: readonly OrganizationCarbonEmployee[],
): OrganizationTreeNode[] {
  const childrenByParent = new Map<string, OrganizationCarbonEmployee[]>();

  members.forEach(member => {
    if (!member.parentId) return;
    const siblings = childrenByParent.get(member.parentId) ?? [];
    childrenByParent.set(member.parentId, [...siblings, member]);
  });

  const build = (member: OrganizationCarbonEmployee): OrganizationTreeNode => ({
    member,
    children: (childrenByParent.get(member.id) ?? []).map(build),
  });

  return members
    .filter(member => member.parentId === null)
    .map(build);
}

/**
 * 在树上做搜索 / 部门筛选，同时保留命中节点的祖先路径：
 * 命中的节点保留并高亮，其它节点只有当它的子树里有命中时才作为上下文保留。
 */
export function filterOrganizationTree(
  roots: readonly OrganizationTreeNode[],
  search: string,
  department: string,
): FilteredOrganizationNode[] {
  const term = search.trim().toLocaleLowerCase();
  const termActive = Boolean(term);
  const departmentActive = Boolean(department);

  const walk = (node: OrganizationTreeNode): FilteredOrganizationNode | null => {
    const termMatch = termActive && [node.member.name, node.member.position, node.member.department]
      .some(value => value.toLocaleLowerCase().includes(term));
    const departmentMatch = departmentActive && node.member.department === department;

    const children = node.children
      .map(walk)
      .filter((child): child is FilteredOrganizationNode => child !== null);

    const containsMatch = departmentMatch || children.some(child => child.matched || child.containsMatch);
    const kept = (!termActive && !departmentActive) || termMatch || departmentMatch || children.length > 0;
    if (!kept) return null;

    return { member: node.member, children, matched: termMatch, containsMatch };
  };

  return roots
    .map(walk)
    .filter((node): node is FilteredOrganizationNode => node !== null);
}
