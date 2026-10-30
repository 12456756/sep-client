import type { SkillLibraryItem } from '../../shared/skill-library';
import type { EmployeeAvailability, SiliconEmployee, WorkItem } from './types';

/** Organization grants and personal subscription validity must both permit use. */
export function mergeEmployeeDirectory(mine: readonly SiliconEmployee[], organization: readonly SiliconEmployee[]): SiliconEmployee[] {
  const personal = new Map(mine.map(employee => [employee.id, employee]));
  const directory = new Map<string, SiliconEmployee>();
  for (const employee of organization) {
    const local = personal.get(employee.id);
    directory.set(employee.id, local ? {
      ...employee, ...local,
      intro: local.intro.trim() ? local.intro : employee.intro,
      avatar: local.avatar ?? employee.avatar,
      avatarAsset: local.avatarAsset ?? employee.avatarAsset,
      assignedToMe: local.assignedToMe && employee.assignedToMe,
      availability: employee.availability === 'unavailable' ? 'unavailable'
        : local.availability === 'ready' && employee.availability === 'working' ? 'working' : local.availability,
    } : employee);
  }
  for (const employee of mine) if (!directory.has(employee.id)) directory.set(employee.id, employee);
  return [...directory.values()];
}

export function employeeSkills(skills: readonly SkillLibraryItem[], employeeId: string): SkillLibraryItem[] {
  return [...new Map(skills.filter(skill => skill.bindings.some(binding => binding.subscriptionId === employeeId))
    .map(skill => [skill.capability.id, skill])).values()];
}

export function filterEmployees(employees: readonly SiliconEmployee[], skills: readonly SkillLibraryItem[], search: string, availability: '' | EmployeeAvailability): SiliconEmployee[] {
  const term = search.trim().toLocaleLowerCase();
  const namesByEmployee = new Map<string, string[]>();
  for (const skill of skills) for (const binding of skill.bindings) {
    const names = namesByEmployee.get(binding.subscriptionId) ?? [];
    names.push(skill.capability.name);
    namesByEmployee.set(binding.subscriptionId, names);
  }
  return employees.filter(employee => (!availability || employee.availability === availability)
    && (!term || [employee.name, employee.intro, ...(namesByEmployee.get(employee.id) ?? [])]
      .some(value => value.toLocaleLowerCase().includes(term))));
}

export function recentEmployeeWorks(works: readonly WorkItem[], employeeId: string): WorkItem[] {
  const latest = new Map<string, WorkItem>();
  for (const work of works) {
    if (!work.participants.includes(employeeId) && work.currentEmployeeId !== employeeId) continue;
    if (!latest.has(work.id) || latest.get(work.id)!.updatedAt < work.updatedAt) latest.set(work.id, work);
  }
  return [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 3);
}

export function employeeChatDisabledReason(employee: SiliconEmployee): string | null {
  if (!employee.assignedToMe) return '尚未分配给你，请联系企业管理员';
  if (employee.availability === 'unavailable') return '员工暂不可用，请刷新订阅和状态后重试';
  if (employee.availability === 'needs-auth') return '员工授权状态尚未确认';
  return null;
}

export function subscriptionAvailability(subscriptionStatus: string, platformStatus: string | undefined): EmployeeAvailability {
  if (subscriptionStatus !== 'ACTIVE') return 'unavailable';
  if (platformStatus === 'WORKING' || platformStatus === 'BUSY') return 'working';
  // SEP's OFFLINE means no recent activity, rather than an invalid subscription.
  return platformStatus === 'READY' || platformStatus === 'ONLINE' || platformStatus === 'OFFLINE' ? 'ready' : 'unavailable';
}
