import { z } from 'zod'
import { scheduleInputSchema, scheduledWorkSourceSchema, type ScheduledDefinition, type ScheduledSnapshot } from '../../shared/scheduled-tasks'
import type { IpcCommandResult } from '../../shared/ipc'
import { scheduledCreationSchema, type ScheduledCreation, type ScheduledCreationRequest } from '../../shared/scheduled-creation'

const time = z.number().int().nonnegative()
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const issue = z.object({ code: z.string(), message: z.string(), action: z.enum(['retry', 'auth', 'blocked', 'review']), retryAfterMs: z.number().positive().optional() })
const deliverables = z.array(z.object({ id: z.string(), name: z.string(), format: z.string(), path: z.string(), contentOutline: z.array(z.string()), acceptanceCriteria: z.array(z.string()) })).min(1)
const plan = z.union([
  z.object({ status: z.literal('ready'), kind: z.literal('employee').optional(), objective: z.string().min(1), instruction: z.string().min(1), expectedOutput: z.string().min(1), deliverables }),
  z.object({ status: z.literal('ready'), kind: z.literal('arrangement'), title: z.string().min(1),
    source: scheduledWorkSourceSchema.optional(),
    nodes: z.array(z.object({ id, subscriptionId: id, modelId: z.string().min(1), title: z.string(), objective: z.string().optional(), instruction: z.string(), expectedOutput: z.string(), deliverables,
      dependsOn: z.array(id), skillIds: z.array(z.string()), requiresUserConfirmation: z.boolean(), stepId: z.string().optional() })).min(1).max(32),
    intentAnalysis: z.object({ summary: z.string(), steps: z.array(z.object({ id: z.string(), title: z.string(), requiredCapabilities: z.array(z.string()), requiredCapabilityIds: z.array(z.string()).optional(), dependsOn: z.array(z.string()) })) }).nullable(),
  }),
])
export const scheduledDefinitionSchema = z.object({
  id, revision: z.number().int().positive(), input: scheduleInputSchema, plan: plan.nullable(), planInputKey: z.string().nullable(),
  enabled: z.boolean(), deleted: z.boolean(), nextRunAt: time.nullable(), pausedAt: time.nullable().optional(), createdAt: time, updatedAt: time,
})
const snapshotSchema = z.object({
  definitions: z.array(scheduledDefinitionSchema),
  occurrences: z.array(z.object({
    id, definitionId: id, revision: z.number().int().positive(), scheduledAt: time, taskId: id, input: scheduleInputSchema, plan,
    status: z.enum(['pending', 'preparing', 'launching', 'running', 'waiting_approval', 'waiting_retry', 'waiting_auth', 'blocked', 'review', 'cancelling', 'completed', 'failed', 'cancelled', 'timed_out', 'missed']),
    firstEligibleAt: time, startDeadline: time, startedAt: time.nullable(), finishedAt: time.nullable(), nextRetryAt: time.nullable(), error: issue.nullable(),
    stopReason: z.enum(['cancelled', 'timed_out']).nullable(),
    attempts: z.array(z.object({ id, number: z.number().int().positive(), startedAt: time, finishedAt: time.nullable(), status: z.enum(['preparing', 'admitted', 'failed', 'completed', 'interrupted']), error: issue.nullable() })),
  })),
  schedulerState: z.enum(['running', 'stopped', 'error']).optional(),
  creations: z.array(scheduledCreationSchema).optional(),
})

export interface PendingScheduledCreation { request: ScheduledCreationRequest; sending: boolean; error: string | null }
interface ClientState { data: ScheduledSnapshot | null; busy: boolean; loading: boolean; error: string | null; pendingCreations: PendingScheduledCreation[]; cancellingCreations: string[] }
type CreationResult = IpcCommandResult & { data?: ScheduledCreation }

function mergeRevisions<T extends { id: string; revision: number }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) if ((merged.get(item.id)?.revision ?? 0) <= item.revision) merged.set(item.id, item)
  return [...merged.values()]
}

export function creationAccepted(creation: ScheduledCreation, request: ScheduledCreationRequest): boolean {
  return creation.id === request.requestId && (creation.stage === 'cancelled' || (
    creation.revision > (request.expectedRevision ?? 0) && creation.messages.at(-1)?.content === request.message &&
    creation.request.modelId === request.modelId && creation.request.workDir === request.workDir && creation.request.timezone === request.timezone &&
    creation.request.permissions.preset === request.permissions.preset && creation.request.permissions.approvalMode === request.permissions.approvalMode
  ))
}

/** Owns page reads/commands, but never schedules or executes work in the renderer. */
export class ScheduledTaskClient {
  private state: ClientState
  private readonly listeners = new Set<() => void>()
  private sequence = 0
  private disposed = false
  private operationError: string | null = null
  constructor(private readonly read: () => Promise<IpcCommandResult & { data?: ScheduledSnapshot }>, private readonly pending = new Map<string, PendingScheduledCreation>()) {
    this.state = { data: null, busy: false, loading: true, error: null, pendingCreations: [...pending.values()], cancellingCreations: [] }
  }
  getSnapshot = (): ClientState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  acceptDefinition(value: ScheduledDefinition): void {
    if (!this.state.data) return
    ++this.sequence
    this.update({ data: { ...this.state.data, definitions: mergeRevisions(this.state.data.definitions, [value]) } })
  }
  acceptCreation(value: ScheduledCreation): void {
    ++this.sequence
    const data = this.state.data ?? { definitions: [], occurrences: [] }
    const creations = mergeRevisions(data.creations ?? [], [value])
    this.resolvePending(creations)
    this.update({ data: { ...data, creations }, pendingCreations: [...this.pending.values()] })
  }
  private resolvePending(creations: ScheduledCreation[]): void {
    for (const creation of creations) {
      const pending = this.pending.get(creation.id)
      if (pending && creationAccepted(creation, pending.request)) this.pending.delete(creation.id)
    }
  }
  private update(patch: Partial<ClientState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  async refresh(clearError = false): Promise<void> {
    if (clearError) this.operationError = null
    await this.load()
  }
  private async load(): Promise<void> {
    const sequence = ++this.sequence
    try {
      const result = await this.read()
      if (sequence !== this.sequence || this.disposed) return
      if (!result.success) { this.update({ loading: false, error: result.error?.message || '无法刷新定时任务，请重新加载。' }); return }
      const incoming = snapshotSchema.parse(result.data)
      const data = { ...incoming, definitions: mergeRevisions(this.state.data?.definitions ?? [], incoming.definitions), creations: mergeRevisions(this.state.data?.creations ?? [], incoming.creations ?? []) }
      this.resolvePending(data.creations)
      this.update({ data, pendingCreations: [...this.pending.values()], loading: false, error: this.operationError })
    } catch {
      if (sequence === this.sequence) this.update({ loading: false, error: '无法刷新定时任务，请重新加载。' })
    }
  }
  async submitCreation(request: ScheduledCreationRequest, operation: (request: ScheduledCreationRequest) => Promise<CreationResult>): Promise<CreationResult | null> {
    if (this.disposed || this.pending.get(request.requestId)?.sending) return null
    // Keep the original payload through uncertain transport outcomes, including across page remounts.
    const retained = this.pending.get(request.requestId)?.request ?? structuredClone(request)
    this.pending.set(request.requestId, { request: retained, sending: true, error: null })
    this.update({ pendingCreations: [...this.pending.values()] })
    try {
      const result = await operation(retained)
      if (!result.success) {
        const current = this.state.data?.creations?.find(item => item.id === request.requestId)
        if (this.pending.get(request.requestId)?.request === retained && (!current || !creationAccepted(current, retained))) this.pending.set(request.requestId, { request: retained, sending: false, error: result.error?.message || '创建未完成，请重试或取消。' })
        return result
      }
      const data = scheduledCreationSchema.parse(result.data)
      if (data.id !== retained.requestId) throw new Error('Mismatched creation response')
      this.acceptCreation(data)
      if (this.pending.get(request.requestId)?.request === retained) this.pending.delete(request.requestId)
      return { ...result, data }
    } catch {
      const current = this.state.data?.creations?.find(item => item.id === request.requestId)
      if ((!this.pending.has(request.requestId) || this.pending.get(request.requestId)?.request === retained) && (!current || !creationAccepted(current, retained))) this.pending.set(request.requestId, { request: retained, sending: false, error: '发送结果未确认，内容已保留。请重试同一请求或等待状态更新。' })
      return null
    } finally { this.update({ pendingCreations: [...this.pending.values()] }) }
  }
  async cancelCreation(creation: ScheduledCreation, operation: () => Promise<CreationResult>): Promise<CreationResult | null> {
    if (this.disposed || this.state.cancellingCreations.includes(creation.id)) return null
    this.update({ cancellingCreations: [...this.state.cancellingCreations, creation.id] })
    try {
      const result = await operation()
      if (result.success) this.acceptCreation(scheduledCreationSchema.parse(result.data))
      else { this.operationError = result.error?.message || '取消未完成，请刷新后重试。'; this.update({ error: this.operationError }) }
      return result
    } catch {
      this.operationError = '取消结果未确认，请刷新查看状态后重试。'
      this.update({ error: this.operationError })
      return null
    } finally { this.update({ cancellingCreations: this.state.cancellingCreations.filter(id => id !== creation.id) }) }
  }
  async command<T extends IpcCommandResult>(operation: () => Promise<T>): Promise<T | null> {
    if (this.state.busy || this.disposed) return null
    ++this.sequence
    this.operationError = null
    this.update({ busy: true, error: null })
    try {
      const result = await operation()
      if (this.disposed) return null
      if (!result.success) { this.operationError = result.error?.message || '操作未完成，请刷新后重试。'; this.update({ error: this.operationError }); return result }
      await this.load()
      return result
    } catch {
      this.operationError = '操作结果未确认，请刷新查看已保存的记录后再操作。'
      this.update({ error: this.operationError })
      return null
    } finally { this.update({ busy: false }) }
  }
  dispose(): void { this.disposed = true; ++this.sequence; this.listeners.clear() }
}
