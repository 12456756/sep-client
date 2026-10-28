import type { AppRoute } from './types';
import type { SkillListFilters } from './skill-list-model';

export interface SkillPageState extends SkillListFilters {
  scrollTop: number;
  focusId: string | null;
  anchorId: string | null;
  anchorOffset: number;
  notice: string;
}
export function createSkillPageState(): SkillPageState {
  return { query: '', employeeFilterId: '', versionFilter: 'all', sort: 'name', scrollTop: 0, focusId: null, anchorId: null, anchorOffset: 0, notice: '' };
}
export function enterSkillPage(state: SkillPageState, route: Extract<AppRoute, { name: 'skills' }>): SkillPageState {
  return !route.skillId && route.employeeFilterId !== undefined
    ? { ...createSkillPageState(), sort: state.sort, employeeFilterId: route.employeeFilterId }
    : state;
}

/** Scope changes invalidate guards immediately, even before effect cleanup. */
export function createSkillLeaveRegistry(): {
  register(scope: string, guard: (() => boolean) | null): () => void;
  mayLeave(scope: string): boolean;
} {
  let active: { scope: string; guard: (() => boolean) | null } | null = null;
  return {
    register(scope, guard) {
      const record = { scope, guard };
      active = record;
      return () => { if (active === record) active = null; };
    },
    mayLeave(scope) { return !active || active.scope !== scope || !active.guard || active.guard(); },
  };
}
