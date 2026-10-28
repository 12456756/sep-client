import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { AppRoute } from './types';
import type { EmployeePageState } from './employee-page-state';

/** Keep the shared scroll container's restoration specific to employee discovery. */
export function useEmployeePageScroll(
  container: RefObject<HTMLDivElement | null>,
  route: AppRoute,
  state: EmployeePageState,
  update: (patch: Partial<EmployeePageState>) => void,
  ready: boolean,
): void {
  const snapshot = useRef(state);
  const pending = useRef(false);
  const savedScroll = useRef(state.scrollTop);
  const filters = JSON.stringify([state.search, state.availability, state.scope, state.view]);
  const previousFilters = useRef(filters);
  useLayoutEffect(() => { snapshot.current = state; });

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    if (route.name !== 'employees') {
      element.scrollTop = 0;
      return;
    }
    pending.current = true;
    savedScroll.current = snapshot.current.scrollTop;
    const record = () => {
      if (!pending.current) {
        savedScroll.current = element.scrollTop;
        update({ scrollTop: element.scrollTop });
      }
    };
    element.addEventListener('scroll', record, { passive: true });
    return () => {
      element.removeEventListener('scroll', record);
    };
  }, [container, route, update]);

  useLayoutEffect(() => {
    if (route.name !== 'employees' || !pending.current || !ready || !container.current) return;
    const element = container.current;
    element.scrollTop = savedScroll.current;
    if (state.focusId) {
      const trigger = document.getElementById(state.focusId);
      if (trigger && element.contains(trigger)) trigger.focus({ preventScroll: true });
    }
    pending.current = false;
  }, [container, route, ready, state.focusId]);

  useLayoutEffect(() => {
    if (previousFilters.current === filters) return;
    previousFilters.current = filters;
    if (route.name !== 'employees' || pending.current || !container.current) return;
    container.current.scrollTop = 0;
    savedScroll.current = 0;
  }, [container, route, filters]);
}
