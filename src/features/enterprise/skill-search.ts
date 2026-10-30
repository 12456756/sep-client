import type { SkillLibraryItem } from '../../shared/skill-library';
import type { SiliconEmployee } from './types';

export type SkillVersionFilter = 'all' | 'personal' | 'enterprise' | 'platform';

export function filterSkillLibrary(
  skills: readonly SkillLibraryItem[],
  employees: readonly Pick<SiliconEmployee, 'id' | 'name'>[],
  query: string,
  filter: SkillVersionFilter,
): SkillLibraryItem[] {
  const term = query.trim().toLowerCase();
  const matchingEmployeeIds = new Set(employees
    .filter(employee => employee.name.toLowerCase().includes(term))
    .map(employee => employee.id));

  return skills.filter(item => {
    const matchesQuery = `${item.capability.name} ${item.capability.description}`.toLowerCase().includes(term)
      || item.bindings.some(binding => matchingEmployeeIds.has(binding.subscriptionId));
    const matchesVersion = filter === 'all'
      || item.bindings.some(binding => {
        const selectedId = binding.selectedVersionId;
        if (!selectedId) return false;
        const local = item.localVersions.find(version => version.idempotencyKey === selectedId || version.uploadedVersion?.id === selectedId);
        if (local) return filter === 'personal';
        return item.versions.some(version => version.id === selectedId && version.scope === filter.toUpperCase());
      });
    return matchesQuery && matchesVersion;
  });
}
