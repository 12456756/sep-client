import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClientTask, TaskExecutionEvent } from '../../src/shared/types'
import { TaskStatus } from '../../src/shared/types'
import type { AuthSessionManager } from '../common/platform/auth-session-manager'
import { AuthApiError } from '../common/platform/platform-api'
import { ClientTaskApi } from '../common/platform/client-task-api'
import { describeError } from '../common/redact'
import { logger } from '../common/logger'

const log = logger.child('task-cloud-mirror')
const TERMINAL = new Set<ClientTask['status']>([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.INTERRUPTED])
const STATUS: Record<string, string> = {
  pending: 'QUEUED', running: 'RUNNING', waiting_approval: 'WAITING_APPROVAL', paused: 'PAUSED',
  interrupted: 'CANCELLED', completed: 'COMPLETED', failed: 'FAILED',
}

interface MirrorState {
  remoteTaskId: string
  /** Highest allocated sequence, including events still awaiting delivery. */
  sequence: number
  disabled?: boolean
  pendingEvents?: Array<{ sequence: number; type: string; occurredAt: string; data?: Record<string, unknown> }>
  heartbeat?: ReturnType<typeof setInterval>
}

interface PendingCreate {
  clientTaskId: string
  clientRunId?: string | null
  subscriptionId?: string | null
  title: string
  status: string
  createdAt: string
}

export class TaskCloudMirror {
  private readonly api: ClientTaskApi
  private readonly states = new Map<string, MirrorState>()
  private readonly chain = new Map<string, Promise<void>>()
  private readonly pendingCreates = new Map<string, PendingCreate>()
  private readonly disabledTasks = new Set<string>()
  private readonly stateFile: string
  private persistChain: Promise<void> = Promise.resolve()
  private loaded: Promise<void>

  constructor(auth: AuthSessionManager, userDataDir: string) {
    this.api = new ClientTaskApi(auth)
    const directory = join(userDataDir, 'task-cloud-mirror')
    this.stateFile = join(directory, 'state.json')
    this.loaded = mkdir(directory, { recursive: true }).then(async () => {
      try {
        const saved = JSON.parse(await readFile(this.stateFile, 'utf8')) as { states?: Record<string, { remoteTaskId: string; sequence: number; disabled?: boolean; pendingEvents?: MirrorState['pendingEvents'] }>; pendingCreates?: Record<string, PendingCreate>; disabledTasks?: string[] }
        for (const [id, value] of Object.entries(saved.states ?? {})) {
          // Older files stored the last acknowledged sequence instead of the allocation cursor.
          const sequence = (value.pendingEvents ?? []).reduce((highest, event) => Math.max(highest, event.sequence), value.sequence)
          this.states.set(id, { ...value, sequence })
        }
        for (const [id, value] of Object.entries(saved.pendingCreates ?? {})) this.pendingCreates.set(id, value)
        for (const id of saved.disabledTasks ?? []) this.disabledTasks.add(id)
      } catch { /* first run */ }
    })
  }

  observeTask(task: ClientTask): void {
    void this.enqueue(task.id, async () => { await this.loaded; await this.syncTask(task) })
  }

  observeEvent(event: TaskExecutionEvent): void {
    void this.enqueue(event.taskId, async () => {
      await this.loaded
      const state = this.states.get(event.taskId)
      if (!state || state.disabled) return
      const sequence = state.sequence + 1
      const payload = {
        sequence,
        type: event.type,
        occurredAt: new Date(event.occurredAt).toISOString(),
        data: safeEventData(event.data),
      }
      state.sequence = sequence
      state.pendingEvents = [...(state.pendingEvents ?? []), payload]
      await this.persist()
      try {
        await this.flushEvents(state)
        await this.persist()
      } catch (error) { this.handleError(event.taskId, error) }
    })
  }

  stop(): void { for (const state of this.states.values()) this.stopHeartbeat(state) }

  private stopHeartbeat(state: MirrorState): void {
    if (state.heartbeat) clearInterval(state.heartbeat)
    state.heartbeat = undefined
  }

  private async syncTask(task: ClientTask): Promise<void> {
    let state = this.states.get(task.id)
    if (state && TERMINAL.has(task.status)) this.stopHeartbeat(state)
    if (state?.disabled || this.disabledTasks.has(task.id)) return
    if (!state) {
      // Creation precedes admission locally; do not cache an incomplete identity.
      if (!task.subscriptionId?.trim() || !task.activeRunId?.trim()) return
      const pending = this.pendingCreates.get(task.id)
      const payload: PendingCreate = pending?.clientRunId?.trim() && pending.subscriptionId?.trim() ? pending : {
        clientTaskId: task.id,
        clientRunId: task.activeRunId,
        subscriptionId: task.subscriptionId,
        title: task.title.slice(0, 200),
        status: STATUS[task.status] ?? 'QUEUED',
        createdAt: new Date(task.createdAt).toISOString(),
      }
      this.pendingCreates.set(task.id, payload)
      await this.persist()
      try {
        const remote = await this.retry(() => this.api.create(payload))
        state = { remoteTaskId: remote.id, sequence: 0 }
        this.states.set(task.id, state)
        this.pendingCreates.delete(task.id)
        await this.persist()
      } catch (error) { this.handleError(task.id, error); return }
    }
    try {
      await this.retry(() => this.api.updateStatus(state!.remoteTaskId, STATUS[task.status] ?? 'QUEUED'))
      await this.flushEvents(state)
      if (!TERMINAL.has(task.status)) this.ensureHeartbeat(task.id, state, task.status)
      await this.persist()
    } catch (error) { this.handleError(task.id, error) }
  }

  private ensureHeartbeat(taskId: string, state: MirrorState, status: string): void {
    const interval = status === TaskStatus.WAITING_APPROVAL ? 15_000 : status === TaskStatus.RUNNING ? 10_000 : 0
    if (!interval || state.heartbeat) return
    state.heartbeat = setInterval(() => {
      void this.retry(() => this.api.heartbeat(state!.remoteTaskId)).catch(error => this.handleError(taskId, error))
    }, interval)
    ;(state.heartbeat as NodeJS.Timeout).unref?.()
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let delay = 500
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation() } catch (error) {
        if (error instanceof AuthApiError && (error.isUnauthorized || error.isForbidden || error.statusCode === 404)) throw error
        if (error instanceof AuthApiError && error.statusCode !== 0 && error.statusCode !== 429 && error.statusCode < 500) throw error
        if (attempt >= 3) throw error
        await new Promise(resolve => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 8_000)
      }
    }
  }

  private async flushEvents(state: MirrorState): Promise<void> {
    while (state.pendingEvents?.length) {
      const next = state.pendingEvents[0]
      await this.retry(() => this.api.appendEvent(state.remoteTaskId, next))
      state.pendingEvents.shift()
    }
  }

  private handleError(taskId: string, error: unknown): void {
    const state = this.states.get(taskId)
    if (state && error instanceof AuthApiError && (error.isForbidden || error.statusCode === 404)) {
      state.disabled = true
      this.stopHeartbeat(state)
      void this.persist()
    } else if (error instanceof AuthApiError && (error.isForbidden || error.statusCode === 404)) {
      this.disabledTasks.add(taskId)
      this.pendingCreates.delete(taskId)
      void this.persist()
    }
    log.warn('cloud task mirror failed; local task continues', { taskId, cause: describeError(error) })
  }

  private enqueue(taskId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.chain.get(taskId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.chain.set(taskId, next)
    return next
  }

  private persist(): Promise<void> {
    const states: Record<string, { remoteTaskId: string; sequence: number; disabled?: boolean; pendingEvents?: MirrorState['pendingEvents'] }> = {}
    for (const [id, state] of this.states) states[id] = {
      remoteTaskId: state.remoteTaskId,
      sequence: state.sequence,
      ...(state.disabled ? { disabled: true } : {}),
      ...(state.pendingEvents?.length ? { pendingEvents: state.pendingEvents } : {}),
    }
    const contents = JSON.stringify({
      states,
      pendingCreates: Object.fromEntries(this.pendingCreates),
      disabledTasks: [...this.disabledTasks],
    }, null, 2)
    const next = this.persistChain.catch(() => undefined).then(() => writeFile(this.stateFile, contents))
    this.persistChain = next.then(() => undefined, () => undefined)
    return next
  }
}

function safeEventData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined
  const source = data as Record<string, unknown>
  const allowed = ['toolId', 'toolName', 'success', 'attempt', 'maxAttempts', 'delayMs']
  const result: Record<string, unknown> = {}
  for (const key of allowed) {
    if (typeof source[key] === 'string' || typeof source[key] === 'number' || typeof source[key] === 'boolean') result[key] = source[key]
  }
  return Object.keys(result).length ? result : undefined
}
