import type { ElectronAPI } from '../../shared/ipc'
import type { CreateWorkSchedule } from '../../shared/scheduled-tasks'

// Retain the exact request across modal unmounts when the IPC outcome is unknown.
const pending = new WeakMap<ElectronAPI, Map<string, CreateWorkSchedule>>()
const key = (scope: string, taskId: string) => JSON.stringify([scope, taskId])
export function readPendingWorkSchedule(api: ElectronAPI, scope: string, taskId: string): CreateWorkSchedule | undefined {
  const request = pending.get(api)?.get(key(scope, taskId))
  return request ? structuredClone(request) : undefined
}
export function retainWorkSchedule(api: ElectronAPI, scope: string, request: CreateWorkSchedule): void {
  let values = pending.get(api)
  if (!values) { values = new Map(); pending.set(api, values) }
  values.set(key(scope, request.taskId), structuredClone(request))
}
export function clearPendingWorkSchedule(api: ElectronAPI, scope: string, taskId: string): void {
  pending.get(api)?.delete(key(scope, taskId))
}
