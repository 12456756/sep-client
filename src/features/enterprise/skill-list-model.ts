import type { SkillLibraryItem } from '../../shared/skill-library';
import type { SiliconEmployee } from './types';
import { filterSkillLibrary, type SkillVersionFilter } from './skill-search';
import { skillVersionLabel } from './skill-labels';

export type SkillSort = 'name' | 'employees' | 'recent';
export interface SkillListFilters {
  query: string;
  employeeFilterId: string;
  versionFilter: SkillVersionFilter;
  sort: SkillSort;
}
export interface SkillEmployeeOption {
  id: string;
  name: string;
  label: string;
  count: number;
  employee?: SiliconEmployee;
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function uniqueSkillBindings(skill: SkillLibraryItem): SkillLibraryItem['bindings'] {
  return [...new Map(skill.bindings.map(binding => [binding.subscriptionId, binding])).values()];
}

export function skillEmployeeOptions(skills: readonly SkillLibraryItem[], employees: readonly SiliconEmployee[]): SkillEmployeeOption[] {
  const employeeById = new Map(employees.map(employee => [employee.id, employee]));
  const counts = new Map<string, Set<string>>();
  for (const skill of skills) for (const binding of skill.bindings) {
    const ids = counts.get(binding.subscriptionId) ?? new Set<string>();
    ids.add(skill.capability.id);
    counts.set(binding.subscriptionId, ids);
  }
  const names = new Map<string, number>();
  for (const id of counts.keys()) {
    const name = employeeById.get(id)?.name.trim() || '员工信息暂不可用';
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return [...counts].map(([id, ids]) => {
    const employee = employeeById.get(id);
    const name = employee?.name.trim() || '员工信息暂不可用';
    return { id, name, label: !employee || (names.get(name) ?? 0) > 1 ? `${name}（${id}）` : name, count: ids.size, employee };
  }).sort((a, b) => collator.compare(a.name, b.name) || compareId(a.id, b.id));
}

export function hasPersonalSkillVersion(skill: SkillLibraryItem): boolean {
  return skill.localVersions.length > 0 || skill.versions.some(version => version.scope === 'PERSONAL');
}

export function skillUsageSummary(skill: SkillLibraryItem): string {
  const selected = uniqueSkillBindings(skill).map(binding => {
    const local = skill.localVersions.find(item => item.idempotencyKey === binding.selectedVersionId || item.uploadedVersion?.id === binding.selectedVersionId);
    return local?.idempotencyKey ?? binding.selectedVersionId;
  });
  const ids = new Set(selected);
  if (!ids.size || ids.size === 1 && ids.has(null)) return '未选择版本';
  if (ids.size > 1) return '多个版本';
  const id = [...ids][0];
  const local = skill.localVersions.find(version => version.idempotencyKey === id);
  if (local) return local.request.changeSummary || '个人修改版';
  const version = skill.versions.find(version => version.id === id);
  return version ? skillVersionLabel(version) : '已选版本不可用';
}

function latestPersonalTime(skill: SkillLibraryItem): number {
  const dates = [...skill.localVersions.map(version => version.createdAt), ...skill.versions.filter(version => version.scope === 'PERSONAL').map(version => version.createdAt)];
  return dates.reduce((latest, date) => {
    const parsed = date ? Date.parse(date) : NaN;
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, -Infinity);
}

export function selectSkillList(skills: readonly SkillLibraryItem[], employees: readonly SiliconEmployee[], filters: SkillListFilters): SkillLibraryItem[] {
  const unique = [...new Map(skills.map(skill => [skill.capability.id, skill])).values()];
  return filterSkillLibrary(unique, employees, filters.query, filters.versionFilter)
    .filter(skill => !filters.employeeFilterId || skill.bindings.some(binding => binding.subscriptionId === filters.employeeFilterId))
    .sort((a, b) => {
      if (filters.sort === 'employees') {
        const difference = uniqueSkillBindings(b).length - uniqueSkillBindings(a).length;
        if (difference) return difference;
      }
      if (filters.sort === 'recent') {
        const aTime = latestPersonalTime(a), bTime = latestPersonalTime(b);
        if (aTime !== bTime) return aTime > bTime ? -1 : 1;
      }
      const aName = a.capability.name.trim(), bName = b.capability.name.trim();
      return Number(!aName) - Number(!bName) || collator.compare(aName, bName) || compareId(a.capability.id, b.capability.id);
    });
}
