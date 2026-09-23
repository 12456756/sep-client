import { logger } from '../common/logger'
import { describeError, redactText } from '../common/redact'
import {
  ClientMonitorApiError,
  type ClientMonitorApiPort,
  type ClientTaskEventRequest,
  type ClientTaskStatusRequest,
  type CreateClientTaskRequest,
} from '../common/platform/client-monitor-api'
import { ClientMonitorStore, type ClientMonitorOperation, type ClientMonitorRecord, type ClientMonitorStorePort } from '../data/client-monitor-store'
import type { MonitorStatus } from '../common/platform/client-monitor-contract'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskExecutionEvent } from '../../src/shared/types'

const log = logger.child('client-monitor')
const RETRY_BASE_DELAY_MS = 250
const DEFAULT_MAX_ATTEMPTS = 3

const MONITOR_CONTENT_MAX_LENGTH = 1000
const MONITOR_TRUNCATION_SUFFIX = '...[truncated]'

function monitorText(value: string): string {
  const redacted = redactText(value)
  if (redacted.length <= MONITOR_CONTENT_MAX_LENGTH) return redacted
  const contentLength = MONITOR_CONTENT_MAX_LENGTH - MONITOR_TRUNCATION_SUFFIX.length
  return `${redacted.slice(0, contentLength)}${MONITOR_TRUNCATION_SUFFIX}`
}

type MonitorScopeProvider = () => TaskOwnerScope | null

type MonitorContentType = 'user_input' | 'model_output'

export interface ClientMonitorServiceOptions {
  store: ClientMonitorStorePort
  api: ClientMonitorApiPort
  scopeProvider: MonitorScopeProvider
  clientVersion?: string
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  maxAttempts?: number
}

export interface ClientMonitorTaskQueuedInput {
  prompt: string
  taskId: string
  runId: string
  subscriptionId: string
  title: string
  modelId: string
  taskType: 'conversation' | 'arrangement'
}

/** 保留旧业务接口，状态上报已不再由监控业务触发。 */
export interface ClientMonitorTaskStartedInput {
  taskId: string
  runId: string
  startedAt: number
}

/** 保留旧业务接口，状态上报已不再由监控业务触发。 */
export interface ClientMonitorTaskFinishedInput {
  taskId: string
  runId: string
  status: MonitorStatus
  error?: string | null
  completedAt: number
}

export interface ClientMonitorTaskContentInput {
  taskId: string
  runId: string
  content: string
}

export class ClientMonitorService {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly maxAttempts: number
  private readonly clientVersion: string

  constructor(private readonly options: ClientMonitorServiceOptions) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.clientVersion = options.clientVersion ?? '1.0.0'
  }

  taskQueued(input: ClientMonitorTaskQueuedInput): Promise<void> {
    return this.enqueue(input.taskId, async scope => {
      const existing = await this.options.store.load(scope, input.taskId)
      const createPayload: CreateClientTaskRequest = {
        clientTaskId: input.taskId,
        clientRunId: input.runId,
        subscriptionId: input.subscriptionId,
        title: redactText(input.title, 512),
        taskType: input.taskType,
        modelId: input.modelId,
        clientVersion: this.clientVersion,
      }
      const record = this.withMetadata(existing ?? this.newRecord(input), input, createPayload)
      await this.options.store.save(scope, input.taskId, record)
      await this.processPending(scope, input.taskId)
    })
  }

  /** 兼容旧调用方；不再产生 SEP 状态或心跳操作。 */
  taskStarted(_input: ClientMonitorTaskStartedInput): Promise<void> {
    return Promise.resolve()
  }

  taskInput(input: ClientMonitorTaskContentInput): Promise<void> {
    return this.enqueueContent(input, 'user_input')
  }

  taskOutput(input: ClientMonitorTaskContentInput): Promise<void> {
    return this.enqueueContent(input, 'model_output')
  }

  /** 普通执行事件不属于对外监控内容，不再上传。 */
  taskEvent(_event: TaskExecutionEvent): Promise<void> {
    return Promise.resolve()
  }

  /** 兼容旧调用方；不再产生 SEP 终态或心跳操作。 */
  taskFinished(input: ClientMonitorTaskFinishedInput): Promise<void> {
    if (input.status !== 'COMPLETED') return Promise.resolve()
    return this.enqueue(input.taskId, async scope => {
      const record = await this.options.store.load(scope, input.taskId)
      if (!record || record.clientRunId !== input.runId || (!record.mirrorId && !record.pending.some(operation => operation.kind === 'create'))) return
      const statusPayload: ClientTaskStatusRequest = {
        status: 'COMPLETED',
        progress: 100,
        completedAt: new Date(input.completedAt).toISOString(),
      }
      const next = this.appendOperation(record, {
        id: ClientMonitorStore.operationId(),
        kind: 'status',
        payload: statusPayload,
      })
      await this.options.store.save(scope, input.taskId, next)
      await this.processPending(scope, input.taskId)
    })
  }

  async resumePending(): Promise<void> {
    const scope = this.options.scopeProvider()
    if (!scope) return
    let taskIds: string[]
    try {
      taskIds = await this.options.store.listPending(scope)
    } catch (error) {
      log.warn('client monitor recovery failed', { cause: describeError(error) })
      return
    }
    await Promise.all(taskIds.map(taskId => this.enqueue(taskId, async taskScope => {
      const record = await this.options.store.load(taskScope, taskId)
      if (record) await this.processPending(taskScope, taskId)
    })))
  }

  async stop(): Promise<void> {
    // 保留生命周期接口；当前监控不创建定时器。
  }

  private enqueueContent(input: ClientMonitorTaskContentInput, type: MonitorContentType): Promise<void> {
    if (!input.content.trim()) return Promise.resolve()
    return this.enqueue(input.taskId, async scope => {
      const record = await this.options.store.load(scope, input.taskId)
      if (!record || record.clientRunId !== input.runId) return
      const sequence = record.lastSequence + 1
      const eventPayload: ClientTaskEventRequest = {
        sequence,
        type,
        message: monitorText(input.content),
        occurredAt: new Date(this.now()).toISOString(),
      }
      const next = this.appendOperation({ ...record, lastSequence: sequence }, {
        id: ClientMonitorStore.operationId(),
        kind: 'event',
        sequence,
        payload: eventPayload,
      })
      await this.options.store.save(scope, input.taskId, next)
      await this.processPending(scope, input.taskId)
    })
  }

  private enqueue(taskId: string, operation: (scope: TaskOwnerScope) => Promise<void>): Promise<void> {
    const scope = this.options.scopeProvider()
    if (!scope) return Promise.resolve()
    const key = this.taskKey(scope, taskId)
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(() => operation(scope)).catch(error => {
      log.warn('client monitor operation failed', { taskId, cause: describeError(error) })
    })
    this.chains.set(key, next)
    return next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
  }

  private async processPending(scope: TaskOwnerScope, taskId: string): Promise<void> {
    while (true) {
      const record = await this.options.store.load(scope, taskId)
      if (!record) return
      const operation = record.pending[0]
      if (!operation) {
        await this.options.store.deleteIfEmpty(scope, taskId, record)
        return
      }
      if (this.isObsoleteOperation(operation)) {
        await this.options.store.save(scope, taskId, this.removeOperation(record, operation.id))
        continue
      }
      if (operation.kind !== 'create' && !record.mirrorId) return
      try {
        if (operation.kind === 'create') {
          const mirror = await this.callWithRetry(() => this.options.api.createTask(operation.payload), operation.kind)
          const next = this.removeOperation({ ...record, mirrorId: mirror.id }, operation.id)
          await this.options.store.save(scope, taskId, next)
          continue
        }
        await this.callWithRetry(() => this.sendOperation(record.mirrorId as string, operation), operation.kind)
        const next = this.removeOperation(record, operation.id)
        await this.options.store.save(scope, taskId, next)
      } catch (error) {
        log.warn('client monitor pending operation retained', {
          taskId,
          kind: operation.kind,
          cause: describeError(error),
        })
        return
      }
    }
  }

  private isObsoleteOperation(operation: ClientMonitorOperation): boolean {
    if (operation.kind === 'status') return operation.payload.status !== 'COMPLETED'
    if (operation.kind === 'heartbeat') return true
    return operation.kind === 'event' && operation.payload.type !== 'user_input' && operation.payload.type !== 'model_output'
  }

  private async callWithRetry<T>(operation: () => Promise<T>, kind: ClientMonitorOperation['kind']): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        const retryable = error instanceof ClientMonitorApiError ? error.isRetryable : false
        if (!retryable || attempt === this.maxAttempts) throw error
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
        log.debug('retrying client monitor operation', { kind, attempt: attempt + 1 })
      }
    }
    throw lastError
  }

  private async sendOperation(mirrorId: string, operation: Exclude<ClientMonitorOperation, { kind: 'create' }>): Promise<void> {
    if (operation.kind === 'status') {
      await this.callWithRetry(() => this.options.api.updateStatus(mirrorId, operation.payload), operation.kind)
    } else if (operation.kind === 'heartbeat') {
      await this.callWithRetry(() => this.options.api.sendHeartbeat(mirrorId, operation.payload), operation.kind)
    } else {
      await this.callWithRetry(() => this.options.api.sendEvent(mirrorId, operation.payload), operation.kind)
    }
  }

  private taskKey(scope: TaskOwnerScope, taskId: string): string {
    return `${scope.enterpriseId}\u0000${scope.memberId}\u0000${taskId}`
  }

  private newRecord(input: ClientMonitorTaskQueuedInput): ClientMonitorRecord {
    return {
      version: 1,
      clientTaskId: input.taskId,
      clientRunId: input.runId,
      mirrorId: null,
      subscriptionId: input.subscriptionId,
      title: redactText(input.title, 512),
      taskType: input.taskType,
      modelId: input.modelId,
      lastSequence: 0,
      heartbeatActive: false,
      pending: [],
      updatedAt: this.now(),
    }
  }

  private withMetadata(
    existing: ClientMonitorRecord,
    input: ClientMonitorTaskQueuedInput,
    createPayload: CreateClientTaskRequest,
  ): ClientMonitorRecord {
    const hasCurrentRunCreate = existing.pending.some(operation => (
      operation.kind === 'create' && operation.payload.clientRunId === input.runId
    ))
    const isNewRun = existing.clientRunId !== input.runId
    const isFirstRecord = existing.mirrorId === null && existing.pending.length === 0 && existing.lastSequence === 0
    const shouldQueueCreate = isNewRun || isFirstRecord
    const newOperations: ClientMonitorOperation[] = shouldQueueCreate && !hasCurrentRunCreate
      ? [{ id: ClientMonitorStore.operationId(), kind: 'create', payload: createPayload }]
      : []
    return {
      ...existing,
      clientTaskId: input.taskId,
      clientRunId: input.runId,
      subscriptionId: input.subscriptionId,
      title: redactText(input.title, 512),
      taskType: input.taskType,
      modelId: input.modelId,
      pending: [...existing.pending, ...newOperations],
      updatedAt: this.now(),
    }
  }

  private appendOperation(record: ClientMonitorRecord, operation: ClientMonitorOperation): ClientMonitorRecord {
    return { ...record, pending: [...record.pending, operation], updatedAt: this.now() }
  }

  private removeOperation(record: ClientMonitorRecord, operationId: string): ClientMonitorRecord {
    return { ...record, pending: record.pending.filter(operation => operation.id !== operationId), updatedAt: this.now() }
  }
}
