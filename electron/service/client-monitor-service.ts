import { randomUUID } from 'node:crypto'
import { logger } from '../common/logger'
import { redactText } from '../common/redact'
import { ClientMonitorApiError, type ClientMonitorApiPort, type ClientTaskStatusRequest } from '../common/platform/client-monitor-api'
import { monitorParticipationSchema, type MonitorParticipation } from '../common/platform/client-monitor-contract'
import { ClientMonitorStore, type ClientMonitorOperation, type ClientMonitorRecord, type ClientMonitorStorePort } from '../data/client-monitor-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskExecutionEvent } from '../../src/shared/types'
import type { MonitorTaskQueuedInput, MonitorTaskStartedInput, MonitorTaskFinishedInput, MonitorTaskContentInput } from '../domain/task-monitor'
import type { ClientMonitorHistorySource, MonitorHistoryTask } from './client-monitor-history-service'

export type ClientMonitorTaskQueuedInput = MonitorTaskQueuedInput
export type ClientMonitorTaskStartedInput = MonitorTaskStartedInput
export type ClientMonitorTaskFinishedInput = MonitorTaskFinishedInput
export type ClientMonitorTaskContentInput = MonitorTaskContentInput

const log = logger.child('client-monitor')
const scopeKey = (scope: TaskOwnerScope | null): string => scope ? `${scope.enterpriseId}\0${scope.memberId}` : ''
const boundedText = (text: string, length: number): string => redactText(text, Infinity).slice(0, length)

// Never split a surrogate pair. Each wire message still satisfies Zod's UTF-16 max(1000).
function chunks(text: string): string[] {
  const parts: string[] = []
  let part = ''
  for (const character of text) {
    if (part.length + character.length > 1000) { parts.push(part); part = '' }
    part += character
  }
  if (part) parts.push(part)
  return parts
}

export interface ClientMonitorServiceOptions {
  store: ClientMonitorStorePort
  api: ClientMonitorApiPort
  scopeProvider: () => TaskOwnerScope | null
  history?: ClientMonitorHistorySource
  clientVersion?: string
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  maxAttempts?: number
  recoveryIntervalMs?: number
  minSendIntervalMs?: number
}

/** Atomic per-task mutations; one global wire queue. Network waits never hold mutation locks. */
export class ClientMonitorService {
  private readonly chains = new Map<string, Promise<void>>()
  private sendTail: Promise<void> = Promise.resolve()
  private recovery: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private controller = new AbortController()
  private epoch = 0
  private stopped = false
  private blockedUntil = 0
  private lastSentAt = 0
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly maxAttempts: number
  private readonly clientVersion: string

  constructor(private readonly options: ClientMonitorServiceOptions) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.maxAttempts = Math.max(1, Math.min(10, options.maxAttempts ?? 3))
    this.clientVersion = options.clientVersion ?? '1.0.0'
  }

  taskQueued(input: MonitorTaskQueuedInput): Promise<void> {
    return this.enqueue(input.taskId, async scope => {
      const record = await this.options.store.load(scope, input.taskId)
      await this.options.store.save(scope, input.taskId, this.queueRun(record, input))
    })
  }

  taskStarted(input: MonitorTaskStartedInput): Promise<void> {
    return this.enqueueStatus(input.taskId, input.runId, { status: 'RUNNING', startedAt: new Date(input.startedAt).toISOString() })
  }

  taskInput(input: MonitorTaskContentInput): Promise<void> { return this.enqueueContent(input, 'user_input') }
  taskOutput(input: MonitorTaskContentInput): Promise<void> { return this.enqueueContent(input, 'model_output') }

  taskEvent(event: TaskExecutionEvent, participation?: MonitorParticipation): Promise<void> {
    if (participation) {
      return this.enqueue(event.taskId, async scope => {
        const record = await this.options.store.load(scope, event.taskId)
        if (!record?.liveRuns?.[event.runId]) return
        await this.options.store.save(scope, event.taskId, this.addParticipation(record, event.runId, participation, event.occurredAt))
      })
    }
    if (event.type === 'approval_requested' || event.type === 'approval_resolved') {
      return this.enqueueStatus(event.taskId, event.runId, { status: event.type === 'approval_requested' ? 'WAITING_APPROVAL' : 'RUNNING' })
    }
    // Tool arguments/results and streaming deltas are not public monitor content.
    return Promise.resolve()
  }

  taskFinished(input: MonitorTaskFinishedInput): Promise<void> {
    return this.enqueueStatus(input.taskId, input.runId, {
      status: input.status,
      ...(input.status === 'COMPLETED' ? { progress: 100 } : {}),
      errorSummary: input.error ? boundedText(input.error, 1000) : null,
      completedAt: new Date(input.completedAt).toISOString(),
    })
  }

  resumePending(): Promise<void> {
    const scope = this.options.scopeProvider()
    if (!scope) return Promise.resolve()
    if (this.stopped) { this.stopped = false; this.controller = new AbortController() }
    if (!this.timer) {
      this.timer = setInterval(() => { void this.resumePending() }, this.options.recoveryIntervalMs ?? 30_000)
      this.timer.unref?.()
    }
    if (this.recovery) return this.recovery
    const epoch = this.epoch
    const recovery = this.recover(scope, epoch).catch(() => {
      log.warn('client monitor recovery failed')
    }).finally(() => { if (this.recovery === recovery) this.recovery = null })
    this.recovery = recovery
    return recovery
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.epoch++
    this.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.recovery = null
    this.blockedUntil = 0
    this.lastSentAt = 0
    // Aborted old requests cannot hold the new login's wire queue.
    this.sendTail = Promise.resolve()
  }

  private async recover(scope: TaskOwnerScope, epoch: number): Promise<void> {
    const ids = await this.options.store.listPending(scope)
    if (!this.valid(scope, epoch)) return
    // Restore a persisted 429 gate before attempting *any* task.
    for (const id of ids) {
      const record = await this.options.store.load(scope, id)
      if (!this.valid(scope, epoch)) return
      if (record?.retryStatusCode === 429) this.blockedUntil = Math.max(this.blockedUntil, record.retryAt ?? 0)
    }
    if (this.options.history) {
      const tasks = await this.options.history.read(scope)
      for (const task of tasks) {
        if (!this.valid(scope, epoch)) return
        await this.mutate(scope, task.taskId, epoch, () => this.restoreHistory(scope, task))
      }
    }
    const allIds = await this.options.store.listPending(scope)
    for (const id of allIds) {
      if (!this.valid(scope, epoch)) return
      await this.scheduleDrain(scope, id, epoch)
    }
  }

  private async restoreHistory(scope: TaskOwnerScope, task: MonitorHistoryTask): Promise<void> {
    let record = await this.options.store.load(scope, task.taskId)
    const backfill = !record
    for (const run of task.runs) {
      if (backfill) {
        record = this.queueRun(record, { ...run, taskId: task.taskId, title: task.title, taskType: task.taskType })
        for (const message of run.messages) record = this.addContent(record, { taskId: task.taskId, runId: run.runId, content: message.content }, message.type, message.occurredAt)
      }
      if (!record || (!backfill && run.runId !== record.clientRunId)) continue
      // Existing outboxes are replayed, not regenerated. Reconcile only known local runs.
      if (run.status && record.statusByRun?.[run.runId] !== this.fingerprint(run.status)) {
        record = this.addStatus(record, run.runId, run.status)
      }
    }
    if (record) await this.options.store.save(scope, task.taskId, { ...record, historyBackfilled: record.historyBackfilled || backfill })
  }

  private enqueueContent(input: MonitorTaskContentInput, type: 'user_input' | 'model_output'): Promise<void> {
    if (input.content.length === 0) return Promise.resolve()
    return this.enqueue(input.taskId, async scope => {
      const record = await this.options.store.load(scope, input.taskId)
      if (!record) return
      await this.options.store.save(scope, input.taskId, this.addContent(record, input, type, input.occurredAt ?? this.now()))
    })
  }

  private addContent(record: ClientMonitorRecord, input: MonitorTaskContentInput, type: 'user_input' | 'model_output', occurredAt: number): ClientMonitorRecord {
    if (input.content.length === 0) return record
    const parts = chunks(redactText(input.content, Infinity))
    const messageId = randomUUID()
    const liveRun = record.liveRuns?.[input.runId]
    const participation = liveRun ? this.participation(input.participation ?? liveRun.participation) : undefined
    let sequence = record.lastSequence
    const operations: ClientMonitorOperation[] = parts.map((message, index) => ({
      id: ClientMonitorStore.operationId(), kind: 'event', clientRunId: input.runId, sequence: ++sequence,
      payload: {
        clientRunId: input.runId, sequence, type, message,
        ...(parts.length > 1 ? { stepKey: `content:v1:${messageId}:${index}:${parts.length}` } : {}),
        occurredAt: new Date(occurredAt).toISOString(),
        ...(participation ? { participation } : {}),
      },
    }))
    return { ...record, lastSequence: sequence, pending: [...record.pending, ...operations], updatedAt: this.now() }
  }

  private enqueueStatus(taskId: string, runId: string, payload: ClientTaskStatusRequest): Promise<void> {
    return this.enqueue(taskId, async scope => {
      const record = await this.options.store.load(scope, taskId)
      if (record) await this.options.store.save(scope, taskId, this.addStatus(record, runId, payload))
    })
  }

  private fingerprint(payload: ClientTaskStatusRequest): string { return JSON.stringify(this.statusPayload(payload)) }

  private statusPayload(payload: ClientTaskStatusRequest): ClientTaskStatusRequest {
    return { ...payload, ...(payload.errorSummary ? { errorSummary: boundedText(payload.errorSummary, 1000) } : {}) }
  }

  private addStatus(record: ClientMonitorRecord, runId: string, payload: ClientTaskStatusRequest): ClientMonitorRecord {
    const statusByRun = { ...record.statusByRun, [runId]: this.fingerprint(payload) }
    const updated = { ...record, statusByRun, updatedAt: this.now(), pending: [...record.pending, {
      id: ClientMonitorStore.operationId(), kind: 'status', clientRunId: runId, payload: { ...this.statusPayload(payload), clientRunId: runId },
    } as ClientMonitorOperation] }
    const participation = record.liveRuns?.[runId]?.participation
    if (!participation) return updated
    const snapshot = this.participation({
      ...participation, status: payload.status,
      ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
      ...(payload.completedAt ? { completedAt: payload.completedAt } : {}),
    })!
    return this.addParticipation({ ...updated, liveRuns: { ...record.liveRuns,
      [runId]: { protocolVersion: 2, participation: snapshot },
    } }, runId, snapshot, payload.completedAt || payload.startedAt ? Date.parse((payload.completedAt || payload.startedAt)!) : this.now())
  }

  private participation(value?: MonitorParticipation): MonitorParticipation | undefined {
    if (!value) return undefined
    return monitorParticipationSchema.parse({ ...value,
      ...(value.title ? { title: boundedText(value.title, 200) || 'Task' } : {}),
    })
  }

  private addParticipation(record: ClientMonitorRecord, runId: string, value: MonitorParticipation, occurredAt: number): ClientMonitorRecord {
    const sequence = record.lastSequence + 1
    return { ...record, lastSequence: sequence, updatedAt: this.now(), pending: [...record.pending, {
      id: ClientMonitorStore.operationId(), kind: 'event', clientRunId: runId, sequence,
      payload: { clientRunId: runId, sequence, type: 'participation_status',
        participation: this.participation(value), occurredAt: new Date(occurredAt).toISOString() },
    }] }
  }

  private queueRun(existing: ClientMonitorRecord | null, input: MonitorTaskQueuedInput): ClientMonitorRecord {
    const title = boundedText(input.title, 200) || 'Task'
    const record: ClientMonitorRecord = existing ?? {
      version: 1, clientTaskId: input.taskId, clientRunId: input.runId, mirrorId: null,
      subscriptionId: input.subscriptionId, title, taskType: input.taskType, modelId: input.modelId,
      lastSequence: 0, heartbeatActive: false, pending: [], updatedAt: this.now(),
    }
    const create = !existing || record.clientRunId !== input.runId
    const participation = input.protocolVersion === 2 ? this.participation(input.participation) : undefined
    const updated: ClientMonitorRecord = { ...record, clientRunId: input.runId, subscriptionId: input.subscriptionId, title,
      taskType: input.taskType, modelId: input.modelId, updatedAt: this.now(),
      ...(create && input.protocolVersion === 2 ? { liveRuns: { ...record.liveRuns,
        [input.runId]: { protocolVersion: 2, ...(participation ? { participation } : {}) },
      } } : {}),
      pending: create ? [...record.pending, {
        id: ClientMonitorStore.operationId(), kind: 'create', clientRunId: input.runId,
        payload: { clientTaskId: input.taskId, clientRunId: input.runId, subscriptionId: input.subscriptionId,
          title, taskType: input.taskType, modelId: input.modelId, clientVersion: this.clientVersion,
          ...(input.protocolVersion === 2 ? { protocolVersion: 2, queuedAt: new Date(input.queuedAt ?? this.now()).toISOString() } : {}),
        },
      }] : record.pending,
    }
    return create && participation ? this.addParticipation(updated, input.runId, { ...participation, status: 'QUEUED' }, input.queuedAt ?? this.now()) : updated
  }

  private valid(scope: TaskOwnerScope, epoch: number): boolean {
    return !this.stopped && this.epoch === epoch && scopeKey(scope) === scopeKey(this.options.scopeProvider())
  }

  private enqueue(taskId: string, mutation: (scope: TaskOwnerScope) => Promise<void>): Promise<void> {
    const scope = this.options.scopeProvider()
    if (!scope || this.stopped) return Promise.resolve()
    const epoch = this.epoch
    return this.mutate(scope, taskId, epoch, () => mutation(scope)).then(() => this.scheduleDrain(scope, taskId, epoch))
  }

  private mutate(scope: TaskOwnerScope, taskId: string, epoch: number, mutation: () => Promise<void>): Promise<void> {
    const key = `${scopeKey(scope)}\0${taskId}`
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(async () => { if (this.valid(scope, epoch)) await mutation() }).catch(() => {
      log.warn('client monitor outbox mutation failed', { taskId })
    })
    this.chains.set(key, next)
    return next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key) })
  }

  private scheduleDrain(scope: TaskOwnerScope, taskId: string, epoch: number): Promise<void> {
    const next = this.sendTail.then(() => this.processPending(scope, taskId, epoch)).catch(() => {
      log.warn('client monitor send failed', { taskId })
    })
    this.sendTail = next
    return next
  }

  private async processPending(scope: TaskOwnerScope, taskId: string, epoch: number): Promise<void> {
    while (this.valid(scope, epoch)) {
      const record = await this.options.store.load(scope, taskId)
      if (!this.valid(scope, epoch) || !record) return
      const operation = record.pending[0]
      if (!operation || Math.max(record.retryAt ?? 0, this.blockedUntil) > this.now()) return
      if (operation.kind !== 'create' && !record.mirrorId) return
      try {
        const mirror = await this.callWithRetry(scope, epoch, () => this.send(record.mirrorId, operation, this.controller.signal))
        if (!this.valid(scope, epoch)) return
        await this.mutate(scope, taskId, epoch, async () => {
          const latest = await this.options.store.load(scope, taskId)
          if (!latest) return
          await this.options.store.save(scope, taskId, { ...latest,
            mirrorId: mirror?.id ?? latest.mirrorId, retryAt: undefined, retryStatusCode: undefined,
            pending: latest.pending.filter(item => item.id !== operation.id), updatedAt: this.now(),
          })
        })
      } catch (error) {
        if (!this.valid(scope, epoch)) return
        // The record's run is the latest admitted run. Only an explicitly older status
        // can be discarded on 409; current/unknown-run conflicts remain pending.
        const operationRun = operation.clientRunId ?? operation.payload.clientRunId
        if (error instanceof ClientMonitorApiError && error.statusCode === 409 && operation.kind === 'status' && operationRun && operationRun !== record.clientRunId && !record.liveRuns?.[operationRun]) {
          await this.mutate(scope, taskId, epoch, async () => {
            const latest = await this.options.store.load(scope, taskId)
            if (latest) await this.options.store.save(scope, taskId, { ...latest,
              pending: latest.pending.filter(item => item.id !== operation.id),
              skippedOldStatusCount: (latest.skippedOldStatusCount ?? 0) + 1, updatedAt: this.now(),
            })
          })
          log.info('client monitor obsolete run status conflict skipped', { taskId, kind: operation.kind })
          continue
        }
        const code = error instanceof ClientMonitorApiError ? error.statusCode : 0
        const delay = error instanceof ClientMonitorApiError ? error.retryAfterMs : undefined
        const retryAt = this.now() + Math.max(delay ?? 30_000, 1000)
        if (code === 429) this.blockedUntil = Math.max(this.blockedUntil, retryAt)
        await this.mutate(scope, taskId, epoch, async () => {
          const latest = await this.options.store.load(scope, taskId)
          if (latest) await this.options.store.save(scope, taskId, { ...latest, retryAt, retryStatusCode: code })
        })
        // Only allowlisted metadata: never arbitrary remote error text or message bodies.
        log.warn('client monitor pending operation retained', { taskId, kind: operation.kind, statusCode: code })
        return
      }
    }
  }

  private async callWithRetry<T>(scope: TaskOwnerScope, epoch: number, send: () => Promise<T>): Promise<T> {
    const signal = this.controller.signal
    for (let attempt = 1; ; attempt++) {
      if (!this.valid(scope, epoch)) throw new Error('Monitor scope changed')
      const pacing = Math.max(0, this.lastSentAt + (this.options.minSendIntervalMs ?? 1000) - this.now())
      if (pacing) await this.abortable(this.sleep(pacing), signal)
      if (!this.valid(scope, epoch)) throw new Error('Monitor scope changed')
      try {
        this.lastSentAt = this.now()
        return await this.abortable(send(), signal)
      } catch (error) {
        if (!this.valid(scope, epoch) || !(error instanceof ClientMonitorApiError) || !error.isRetryable || error.statusCode === 429 || attempt >= this.maxAttempts) throw error
        await this.abortable(this.sleep(Math.min(30_000, Math.max(error.retryAfterMs ?? 0, 250 * 2 ** (attempt - 1)))), signal)
      }
    }
  }

  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Monitor stopped'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try { return await Promise.race([promise, cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }

  private send(mirrorId: string | null, operation: ClientMonitorOperation, signal: AbortSignal): Promise<{ id: string } | void> {
    if (operation.kind === 'create') return this.options.api.createTask(operation.payload, signal)
    // Missing historical run IDs stay missing; never silently reattribute to the latest run.
    const payload = operation.clientRunId ? { ...operation.payload, clientRunId: operation.clientRunId } : operation.payload
    if (operation.kind === 'status') return this.options.api.updateStatus(mirrorId!, payload as ClientTaskStatusRequest, signal)
    if (operation.kind === 'heartbeat') return this.options.api.sendHeartbeat(mirrorId!, operation.clientRunId ? { ...operation.payload, clientRunId: operation.clientRunId } : operation.payload, signal)
    return this.options.api.sendEvent(mirrorId!, operation.clientRunId ? { ...operation.payload, clientRunId: operation.clientRunId } : operation.payload, signal)
  }
}
