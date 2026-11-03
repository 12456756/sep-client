import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ElectronAPI } from '../../shared/ipc'
import { ScheduledTaskClient, scheduledDefinitionSchema, type PendingScheduledCreation } from './scheduled-task-client'
import type { ScheduledCreation, ScheduledCreationRequest } from '../../shared/scheduled-creation'
import { scheduleTimeResultSchema, type ScheduleTimeRequest, type ScheduleInput, type ScheduledDefinition } from '../../shared/scheduled-tasks'

const initial = { data: null, loading: true, busy: false, error: null, pendingCreations: [], cancellingCreations: [] }
const pendingByApi = new WeakMap<ElectronAPI, Map<string, Map<string, PendingScheduledCreation>>>()
const emptySubscribe = () => () => {}
const initialSnapshot = () => initial

export function useScheduledTasks(api: ElectronAPI = window.electronAPI, scopeKey?: string) {
  const [binding, setBinding] = useState<{ api: ElectronAPI; scopeKey?: string; client: ScheduledTaskClient } | null>(null)
  const client = binding?.api === api && binding.scopeKey === scopeKey ? binding.client : null
  useEffect(() => {
    let pending = new Map<string, PendingScheduledCreation>()
    if (scopeKey) {
      let scopes = pendingByApi.get(api)
      if (!scopes) { scopes = new Map(); pendingByApi.set(api, scopes) }
      const existing = scopes.get(scopeKey)
      if (existing) pending = existing
      else scopes.set(scopeKey, pending)
    }
    const active = new ScheduledTaskClient(() => api.listScheduledTasks(), pending)
    setBinding({ api, scopeKey, client: active })
    let disposed = false
    let refreshing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (disposed || refreshing) return
      if (timer) clearTimeout(timer)
      refreshing = true
      try { if (!document.hidden) await active.refresh() }
      finally {
        refreshing = false
        if (!disposed) timer = setTimeout(() => { void refresh() }, 3000)
      }
    }
    const visible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', visible)
    void refresh()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
      active.dispose()
    }
  }, [api, scopeKey])
  const state = useSyncExternalStore(client?.subscribe ?? emptySubscribe, client?.getSnapshot ?? initialSnapshot)
  const parsed = async (operation: () => ReturnType<ElectronAPI['createScheduledTask']>) => {
    const result = await operation()
    if (!result.success) return result
    const data = scheduledDefinitionSchema.parse(result.data)
    client?.acceptDefinition(data)
    return { ...result, data }
  }
  return {
    ...state,
    submitCreation: (request: ScheduledCreationRequest) => client?.submitCreation(request, value => api.submitScheduledCreation(value)),
    cancelCreation: (creation: ScheduledCreation) => client?.cancelCreation(creation, () => api.cancelScheduledCreation({ id: creation.id, expectedRevision: creation.revision })),
    interpretTime: async (input: ScheduleTimeRequest) => {
      const result = await api.interpretScheduleTime(input)
      if (!result.success) throw new Error(result.error?.message || '时间解析失败，请稍后重试。')
      const parsed = scheduleTimeResultSchema.safeParse(result.data)
      if (!parsed.success) throw new Error('时间解析结果无效，请重新描述。')
      return parsed.data
    },
    refresh: () => client?.refresh(true),
    save: (requestId: string, input: ScheduleInput, definition?: ScheduledDefinition) => client?.command(() => parsed(() => definition
      ? api.editScheduledTask({ id: definition.id, expectedRevision: definition.revision, input })
      : api.createScheduledTask({ requestId, input }))),
    plan: (definition: ScheduledDefinition) => client?.command(() => parsed(() => api.planScheduledTask({ id: definition.id, expectedRevision: definition.revision }))),
    confirm: (definition: ScheduledDefinition) => client?.command(() => parsed(() => api.confirmScheduledTask({ id: definition.id, expectedRevision: definition.revision }))),
    pause: (definition: ScheduledDefinition) => client?.command(() => api.pauseScheduledTask({ id: definition.id, expectedRevision: definition.revision })),
    archive: (definition: ScheduledDefinition) => client?.command(() => api.deleteScheduledTask({ id: definition.id, expectedRevision: definition.revision })),
    check: (id: string) => client?.command(() => api.checkScheduledRun(id)),
    acknowledge: (id: string) => client?.command(() => api.acknowledgeScheduledRun({ id, confirmed: true })),
    cancel: (id: string) => client?.command(() => api.cancelScheduledRun(id)),
    resume: () => client?.command(() => api.resumeScheduledTasks()),
  }
}
export type ScheduledTasksModel = ReturnType<typeof useScheduledTasks>
