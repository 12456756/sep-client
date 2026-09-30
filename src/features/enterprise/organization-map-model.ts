import type { OrganizationCarbonEmployee } from './organization-model';

export interface OrganizationMapDepartment {
  member: OrganizationCarbonEmployee;
  departments: OrganizationMapDepartment[];
  members: OrganizationCarbonEmployee[];
}

export interface OrganizationMap {
  enterprise: OrganizationCarbonEmployee | null;
  departments: OrganizationMapDepartment[];
  unassignedMembers: OrganizationCarbonEmployee[];
}

/** Group only SEP-provided organization relationships; local subscriptions are not organization data. */
export function buildOrganizationMap(members: readonly OrganizationCarbonEmployee[]): OrganizationMap {
  const enterprise = members.find(member => member.kind === 'root') ?? null;
  const departments = new Map<string, OrganizationMapDepartment>(
    members
      .filter(member => member.kind === 'department')
      .map(member => [member.id, { member, departments: [], members: [] }]),
  );
  const topLevel: OrganizationMapDepartment[] = [];

  for (const department of departments.values()) {
    const parentId = department.member.parentId;
    const parent = parentId ? departments.get(parentId) : undefined;
    if (parent && parent !== department && !hasDepartmentCycle(department.member.id, departments)) {
      parent.departments.push(department);
    } else {
      // Keep malformed/cyclic upstream data visible instead of dropping an entire branch.
      topLevel.push(department);
    }
  }

  const unassignedMembers: OrganizationCarbonEmployee[] = [];
  for (const member of members) {
    if (member.kind === 'root' || member.kind === 'department') continue;
    const department = member.parentId ? departments.get(member.parentId) : undefined;
    if (department) department.members.push(member);
    else unassignedMembers.push(member);
  }

  return { enterprise, departments: topLevel, unassignedMembers };
}

function hasDepartmentCycle(
  departmentId: string,
  departments: ReadonlyMap<string, OrganizationMapDepartment>,
): boolean {
  const visited = new Set<string>();
  let currentId: string | null = departmentId;

  while (currentId) {
    if (visited.has(currentId)) return true;
    visited.add(currentId);
    currentId = departments.get(currentId)?.member.parentId ?? null;
  }

  return false;
}

function matches(member: OrganizationCarbonEmployee, term: string): boolean {
  return [member.name, member.position, member.department]
    .some(value => value.toLocaleLowerCase().includes(term));
}

export function filterOrganizationMap(map: OrganizationMap, query: string): OrganizationMap {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return map;

  const filterDepartment = (department: OrganizationMapDepartment): OrganizationMapDepartment | null => {
    const departmentMatches = matches(department.member, term);
    const children = department.departments
      .map(filterDepartment)
      .filter((item): item is OrganizationMapDepartment => item !== null);
    const filteredMembers = department.members.filter(member => matches(member, term));
    if (!departmentMatches && children.length === 0 && filteredMembers.length === 0) return null;

    return {
      member: department.member,
      departments: departmentMatches ? department.departments : children,
      members: departmentMatches ? department.members : filteredMembers,
    };
  };

  return {
    enterprise: map.enterprise,
    departments: map.departments
      .map(filterDepartment)
      .filter((item): item is OrganizationMapDepartment => item !== null),
    unassignedMembers: map.unassignedMembers.filter(member => matches(member, term)),
  };
}

export interface OrganizationRelationDepartment {
  member: OrganizationCarbonEmployee;
  depth: number;
  parentDepartmentId: string | null;
  members: OrganizationCarbonEmployee[];
  /** Direct child departments, kept nested so the renderer can show the real hierarchy. */
  children: OrganizationRelationDepartment[];
}

export interface OrganizationRelationModel {
  enterprise: OrganizationCarbonEmployee | null;
  /** Flat index used for search, selection and fast lookup. */
  departments: OrganizationRelationDepartment[];
  /** Root departments used by the horizontal tree renderer. */
  rootDepartments: OrganizationRelationDepartment[];
  unassignedMembers: OrganizationCarbonEmployee[];
}

function createRelationTree(
  departments: readonly OrganizationRelationDepartment[],
): { flat: OrganizationRelationDepartment[]; roots: OrganizationRelationDepartment[] } {
  const nodes: OrganizationRelationDepartment[] = departments.map(department => ({
    ...department,
    children: [],
  }));
  const byId = new Map(nodes.map(department => [department.member.id, department]));
  const roots: OrganizationRelationDepartment[] = [];

  for (const department of nodes) {
    const parent = department.parentDepartmentId ? byId.get(department.parentDepartmentId) : undefined;
    if (parent && parent !== department) parent.children.push(department);
    else roots.push(department);
  }

  const visited = new Set<string>();
  const walk = (department: OrganizationRelationDepartment, depth: number): void => {
    if (visited.has(department.member.id)) return;
    visited.add(department.member.id);
    department.depth = depth;
    for (const child of department.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  for (const department of nodes) {
    if (!visited.has(department.member.id)) {
      department.parentDepartmentId = null;
      roots.push(department);
      walk(department, 0);
    }
  }

  return { flat: nodes, roots };
}

/**
 * Build the desktop-friendly relation model:
 * enterprise → department tree → carbon employee → silicon employee.
 * The model remains truthful to SEP data and never derives organization members
 * from the local silicon employee subscription list.
 */
export function buildOrganizationRelation(
  members: readonly OrganizationCarbonEmployee[],
): OrganizationRelationModel {
  const enterprise = members.find(member => member.kind === 'root') ?? null;
  const departments = members.filter(member => member.kind === 'department');
  const departmentById = new Map(departments.map(department => [department.id, department]));
  const relationDepartments = departments.map(department => {
    const parentId = department.parentId && departmentById.has(department.parentId)
      && !hasMemberDepartmentCycle(department.id, departmentById)
      ? department.parentId
      : null;
    return {
      member: department,
      depth: 0,
      parentDepartmentId: parentId,
      members: members.filter(member => (
        member.kind !== 'root' && member.kind !== 'department' && member.parentId === department.id
      )),
      children: [],
    } satisfies OrganizationRelationDepartment;
  });
  const { flat, roots } = createRelationTree(relationDepartments);
  const assignedMemberIds = new Set(flat.flatMap(department => department.members.map(member => member.id)));
  const unassignedMembers = members.filter(member => (
    member.kind !== 'root' && member.kind !== 'department' && !assignedMemberIds.has(member.id)
  ));

  return { enterprise, departments: flat, rootDepartments: roots, unassignedMembers };
}

function hasMemberDepartmentCycle(
  departmentId: string,
  departments: ReadonlyMap<string, OrganizationCarbonEmployee>,
): boolean {
  const visited = new Set<string>();
  let currentId: string | null = departmentId;
  while (currentId) {
    if (visited.has(currentId)) return true;
    visited.add(currentId);
    currentId = departments.get(currentId)?.parentId ?? null;
  }
  return false;
}

function organizationTextMatches(member: OrganizationCarbonEmployee, term: string): boolean {
  return [member.name, member.position, member.department]
    .some(value => value.toLocaleLowerCase().includes(term));
}

/** Keep matching departments/members and enough department ancestors to preserve the left-to-right path. */
export function filterOrganizationRelation(
  model: OrganizationRelationModel,
  query: string,
): OrganizationRelationModel {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return model;

  const departmentById = new Map(model.departments.map(department => [department.member.id, department]));
  const keepDepartmentIds = new Set<string>();
  const matchingMemberIds = new Set<string>();

  const descendantsByDepartment = new Map<string, OrganizationRelationDepartment[]>();
  for (const department of model.departments) {
    let current = department.parentDepartmentId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const descendants = descendantsByDepartment.get(current) ?? [];
      descendants.push(department);
      descendantsByDepartment.set(current, descendants);
      current = departmentById.get(current)?.parentDepartmentId ?? null;
    }
  }

  for (const department of model.departments) {
    const departmentMatches = organizationTextMatches(department.member, term);
    const memberMatches = department.members.filter(member => organizationTextMatches(member, term));
    if (departmentMatches) {
      keepDepartmentIds.add(department.member.id);
      for (const member of department.members) matchingMemberIds.add(member.id);
      for (const descendant of descendantsByDepartment.get(department.member.id) ?? []) {
        keepDepartmentIds.add(descendant.member.id);
        for (const member of descendant.members) matchingMemberIds.add(member.id);
      }
    } else {
      for (const member of memberMatches) {
        matchingMemberIds.add(member.id);
        keepDepartmentIds.add(department.member.id);
      }
    }
  }
  for (const member of model.unassignedMembers) {
    if (organizationTextMatches(member, term)) matchingMemberIds.add(member.id);
  }

  // Add department ancestors so the visible tree still describes a valid path.
  for (const departmentId of [...keepDepartmentIds]) {
    let parentId = departmentById.get(departmentId)?.parentDepartmentId ?? null;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      keepDepartmentIds.add(parentId);
      parentId = departmentById.get(parentId)?.parentDepartmentId ?? null;
    }
  }

  const filteredDepartments = model.departments
    .filter(department => keepDepartmentIds.has(department.member.id))
    .map(department => ({
      ...department,
      children: [],
      members: department.members.filter(member => matchingMemberIds.has(member.id)),
    }));
  const { flat, roots } = createRelationTree(filteredDepartments);
  return {
    enterprise: model.enterprise,
    departments: flat,
    rootDepartments: roots,
    unassignedMembers: model.unassignedMembers.filter(member => matchingMemberIds.has(member.id)),
  };
}
