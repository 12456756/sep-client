import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { AppRoute } from './types';
import type { SkillPageState } from './skill-page-state';

/** The employee scroll owner skips skills; this hook exclusively owns skill routes. */
export function useSkillPageScroll(container: RefObject<HTMLDivElement | null>, route: AppRoute, state: SkillPageState, update: (patch: Partial<SkillPageState>) => void, ready: boolean): void {
  const snapshot = useRef(state);
  const pending = useRef(false);
  const filters = JSON.stringify([state.query, state.employeeFilterId, state.versionFilter, state.sort]);
  const previousFilters = useRef(filters);
  useLayoutEffect(() => { snapshot.current = state; });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || route.name !== 'skills') return;
    if (route.skillId) { element.scrollTop = 0; return; }
    pending.current = true;
    const record = () => {
      if (pending.current) return;
      const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-skill-id]'));
      const top = element.getBoundingClientRect().top;
      const anchor = rows.find(row => row.getBoundingClientRect().bottom > top);
      update({ scrollTop: element.scrollTop, anchorId: anchor?.dataset.skillId ?? null, anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0 });
    };
    element.addEventListener('scroll', record, { passive: true });
    return () => element.removeEventListener('scroll', record);
  }, [container, route, update]);
  useLayoutEffect(() => {
    const element = container.current;
    if (route.name !== 'skills' || route.skillId || !pending.current || !ready || !element) return;
    const saved = snapshot.current;
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-skill-id]')).find(row => row.dataset.skillId === saved.anchorId);
    element.scrollTop = anchor ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.anchorOffset : saved.scrollTop;
    if (saved.focusId) {
      const trigger = document.getElementById(saved.focusId);
      if (trigger && element.contains(trigger)) trigger.focus({ preventScroll: true });
    }
    pending.current = false;
  }, [container, route, ready]);
  useLayoutEffect(() => {
    if (filters === previousFilters.current) return;
    previousFilters.current = filters;
    if (route.name === 'skills' && !route.skillId && container.current) container.current.scrollTop = 0;
  }, [container, route, filters]);
}
