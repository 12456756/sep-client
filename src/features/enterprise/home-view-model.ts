import { GENERAL_ASSISTANT_ID } from './general-assistant';
import type { SiliconEmployee, WorkItem } from './types';

export interface HomeViewModel {
  roster: SiliconEmployee[];
  stats: { total: number; working: number; idle: number };
  recentWorks: WorkItem[];
  recentEmployees: SiliconEmployee[];
  recommendedEmployees: SiliconEmployee[];
  allRecommendedEmployees: SiliconEmployee[];
}

export function createHomeViewModel(
  employees: readonly SiliconEmployee[],
  works: readonly WorkItem[],
): HomeViewModel {
  const roster = employees.filter(employee => employee.id !== GENERAL_ASSISTANT_ID && employee.assignedToMe);
  const employeeIds = new Set(roster.map(employee => employee.id));
  const activeEmployeeIds = new Set<string>();
  const lastWorkAt = new Map<string, number>();

  works.forEach(work => {
    const participants = new Set([work.currentEmployeeId, ...work.participants]);
    participants.forEach(id => {
      if (!employeeIds.has(id)) return;
      lastWorkAt.set(id, Math.max(lastWorkAt.get(id) ?? Number.NEGATIVE_INFINITY, work.updatedAt));
      if (work.isActive === true) activeEmployeeIds.add(id);
    });
  });

  const workingIds = new Set(roster
    .filter(employee => employee.availability === 'working' || activeEmployeeIds.has(employee.id))
    .map(employee => employee.id));
  const recentWorks = works.map((work, index) => ({ work, index }))
    .sort((a, b) => b.work.updatedAt - a.work.updatedAt || a.index - b.index)
    .slice(0, 5)
    .map(entry => entry.work);
  const recentEmployees = roster.filter(employee => lastWorkAt.has(employee.id) || employee.lastWorkedAt !== null).map((employee, index) => ({
    employee,
    index,
    workAt: lastWorkAt.get(employee.id) ?? Number.NEGATIVE_INFINITY,
    lastWorkedAt: employee.lastWorkedAt ?? Number.NEGATIVE_INFINITY,
  })).sort((a, b) => Math.max(b.workAt, b.lastWorkedAt) - Math.max(a.workAt, a.lastWorkedAt)
    || a.index - b.index).slice(0, 5).map(entry => entry.employee);

  return {
    roster,
    stats: {
      total: roster.length,
      working: workingIds.size,
      idle: roster.filter(employee => employee.availability === 'ready' && !activeEmployeeIds.has(employee.id)).length,
    },
    recentWorks,
    recentEmployees,
    recommendedEmployees: roster.slice(0, 5),
    allRecommendedEmployees: roster,
  };
}
