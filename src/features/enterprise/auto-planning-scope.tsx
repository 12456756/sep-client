import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react'
import { AutoPlanningController } from './auto-planning-controller'
import type { ArrangementDraft } from '../../shared/types'
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback'

const Context = createContext<AutoPlanningController | null>(null)
export function usePlanningController(): AutoPlanningController | null { return useContext(Context) }
export function usePlanningSession(owner: ArrangementDraft['owner']): AutoPlanningController {
  const { memberId, enterpriseId } = owner
  const { capture } = useOperationFeedback(JSON.stringify([memberId, enterpriseId]))
  const controller = useMemo(() => new AutoPlanningController({ memberId, enterpriseId }, window.electronAPI,
    error => capture().fail(error, 'workList')), [memberId, enterpriseId, capture])
  useLayoutEffect(() => {
    if (typeof window.electronAPI.listPlanningRecords !== 'function') return
    return controller.attach()
  }, [controller])
  return controller
}
export function PlanningScope({ controller, children }: { controller?: AutoPlanningController; children: ReactNode }) {
  return <Context.Provider value={controller ?? null}>{children}</Context.Provider>
}
