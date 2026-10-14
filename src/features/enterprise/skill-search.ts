import type { SkillLibraryItem } from '../../shared/skill-library';
import type { SiliconEmployee } from './types';

export function filterSkillLibrary(
  skills: readonly SkillLibraryItem[],
  employees: readonly Pick<SiliconEmployee, 'id' | 'name'>[],
  query: string,
  filter: string,
): SkillLibraryItem[] {
  const term = query.trim().toLowerCase();
  const matchingEmployeeIds = new Set(employees
    .filter(employee => employee.name.toLowerCase().includes(term))
    .map(employee => employee.id));

  return skills.filter(item => {
    const matchesQuery = `${item.capability.name} ${item.capability.description}`.toLowerCase().includes(term)
      || item.bindings.some(binding => matchingEmployeeIds.has(binding.subscriptionId));
    const matchesVersion = filter !== 'personal'
      || item.versions.some(version => version.scope === 'PERSONAL')
      || item.localVersions.length > 0;
    return matchesQuery && matchesVersion;
  });
}
