import { randomUUID } from 'node:crypto'
import type { ClientTask } from '../../src/shared/types'
import { CONVERSATION_QUEUE_LIMIT, type ConversationQueueView } from '../../src/shared/conversation-queue'
import type { ConversationQueueEntry, ConversationQueueRecord, ConversationQueueStorePort } from '../data/conversation-queue-store'
import { WriteChain } from '../data/write-chain'
import type { TaskOwnerScope } from '../data/scope-path'
import { AppError } from '../errors/app-error'
import { logger } from '../common/logger'
import { requireScope, type ScopeSource } from './scope-guard'

interface Options {
  scope: ScopeSource
  store: ConversationQueueStorePort
  getTask(taskId: string): Promise<ClientTask | null>
  isBusy?(taskId: string): boolean
  start(taskId: string, entry: ConversationQueueEntry, signal: AbortSignal): Promise<void>
  retry(taskId: string, signal: AbortSignal): Promise<void>
  onFailure?(taskId: string, entry: ConversationQueueEntry, error: unknown, scope: TaskOwnerScope, subscriptionId: string): void
}
type Prepared = Pick<ConversationQueueEntry, 'attachmentRefs' | 'attachmentNames' | 'knowledge' | 'mode' | 'confirmed'>
const log = logger.child('conversation-queue')

/** Serializes only queue transitions; model execution continues outside this write chain. */
export class ConversationQueueService {
  private readonly writes = new WriteChain()
  private readonly loaded = new Set<string>()
  private controller = new AbortController()
  constructor(private readonly options: Options) {}

  stop(): void {
    this.controller.abort()
    this.loaded.clear()
  }

  start(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController()
  }

  private async access<T>(taskId: string, operation: (record: ConversationQueueRecord, task: ClientTask, assert: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
    const scope = requireScope(this.options.scope), signal = this.controller.signal
    const key = JSON.stringify([scope.enterpriseId, scope.memberId, taskId])
    const assert = () => {
      const current = requireScope(this.options.scope)
      if (signal.aborted || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    }
    return this.writes.run(key, async () => {
      assert()
      const task = await this.options.getTask(taskId)
      assert()
      if (!task || task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId) throw new AppError('NOT_FOUND')
      const saved = await this.options.store.get(scope, taskId)
      assert()
      const record: ConversationQueueRecord = saved ?? { version: 1, taskId, owner: { ...scope }, paused: ['failed', 'interrupted', 'paused'].includes(task.status), entries: [] }
      if (!this.loaded.has(key)) {
        // A new process/login must never replay a previously active message automatically.
        if (saved && record.entries.some(entry => ['waiting', 'active', 'failed'].includes(entry.status))) {
          record.paused = true
          for (const entry of record.entries) if (entry.status === 'active') entry.status = task.lastRunId === entry.runId && task.status === 'completed' ? 'completed' : 'failed'
          await this.options.store.save(scope, record)
          assert()
        }
        this.loaded.add(key)
      }
      return operation(record, task, assert, signal)
    })
  }

  private viewOf(record: ConversationQueueRecord): ConversationQueueView {
    const visible = (entry: ConversationQueueEntry) => ({ id: entry.id, prompt: entry.prompt, createdAt: entry.createdAt, attachmentNames: entry.attachmentNames })
    const failed = record.entries.find(entry => entry.status === 'failed')
    return { paused: record.paused, items: record.entries.filter(entry => entry.status === 'waiting').map(visible), failed: failed ? visible(failed) : null }
  }

  view(taskId: string): Promise<ConversationQueueView> {
    return this.access(taskId, async record => this.viewOf(record))
  }

  async enqueue(taskId: string, input: { id: string; prompt: string; requestKey?: string }, prepare: () => Promise<Partial<Prepared>>): Promise<ConversationQueueView> {
    const lifecycle = this.controller.signal
    const view = await this.access(taskId, async (record, task, assert) => {
      const duplicate = record.entries.find(entry => entry.id === input.id)
      if (duplicate) {
        if (duplicate.prompt !== input.prompt || duplicate.requestKey !== input.requestKey) throw new AppError('INVALID_ARGUMENT')
        return this.viewOf(record)
      }
      if (record.entries.filter(entry => entry.status === 'waiting').length >= CONVERSATION_QUEUE_LIMIT) throw new AppError('CONVERSATION_QUEUE_FULL')
      const prepared = await prepare()
      assert()
      if (!task.activeRunId && !record.entries.some(entry => ['waiting', 'active', 'failed'].includes(entry.status)) && !['failed', 'interrupted'].includes(task.status)) record.paused = false
      record.entries.push({ ...prepared, ...input, runId: input.id, createdAt: Date.now(), status: 'waiting', attachmentNames: prepared.attachmentNames ?? [] })
      await this.options.store.save(record.owner, record)
      assert()
      return this.viewOf(record)
    })
    if (!lifecycle.aborted) void this.drain(taskId).catch(error => {
      if (!lifecycle.aborted) log.warn('queue scheduling failed', { taskId, error })
    })
    return view
  }

  private async advance(record: ConversationQueueRecord, task: ClientTask, assert: () => void, signal: AbortSignal, retryFailed = false): Promise<void> {
    if (record.paused || task.activeRunId || this.options.isBusy?.(task.id) || record.entries.some(entry => entry.status === 'active')) return
    const entry = (retryFailed ? record.entries.find(item => item.status === 'failed') : undefined) ?? record.entries.find(item => item.status === 'waiting')
    if (!entry) return
    entry.status = 'active'
    await this.options.store.save(record.owner, record)
    assert()
    try {
      await this.options.start(task.id, entry, signal)
      assert()
    } catch (error) {
      assert()
      entry.status = 'failed'; record.paused = true
      await this.options.store.save(record.owner, record)
      this.options.onFailure?.(task.id, entry, error, record.owner, task.subscriptionId ?? task.id)
    }
  }

  private drain(taskId: string): Promise<void> {
    return this.access(taskId, (record, task, assert, signal) => this.advance(record, task, assert, signal))
  }

  settled(taskId: string, runId: string, owner?: TaskOwnerScope): Promise<void> {
    const current = this.options.scope.currentScope()
    if (this.controller.signal.aborted || !current || owner && (owner.memberId !== current.memberId || owner.enterpriseId !== current.enterpriseId)) return Promise.resolve()
    return this.access(taskId, async (record, task, assert, signal) => {
      const entry = record.entries.find(item => item.runId === runId && ['active', 'failed'].includes(item.status))
      if (task.activeRunId || task.lastRunId !== runId) return
      if (entry) entry.status = task.status === 'completed' ? 'completed' : 'failed'
      if (['failed', 'interrupted'].includes(task.status)) record.paused = true
      await this.options.store.save(record.owner, record)
      assert()
      await this.advance(record, task, assert, signal)
    })
  }

  resume(taskId: string): Promise<void> {
    return this.access(taskId, async (record, task, assert, signal) => {
      if (task.activeRunId || this.options.isBusy?.(task.id)) return
      const failed = record.entries.find(item => item.status === 'failed')
      if (failed) failed.runId = randomUUID()
      record.paused = false
      await this.options.store.save(record.owner, record)
      assert()
      if (!failed && ['failed', 'interrupted'].includes(task.status) && record.entries.some(item => item.status === 'waiting')) {
        try { await this.options.retry(taskId, signal); assert() }
        catch (error) { assert(); record.paused = true; await this.options.store.save(record.owner, record); throw error }
        return
      }
      await this.advance(record, task, assert, signal, !!failed)
    })
  }

  cancel(taskId: string, stop?: () => Promise<void>): Promise<void> {
    return this.access(taskId, async (record, _task, assert) => {
      for (const entry of record.entries) if (['waiting', 'active', 'failed'].includes(entry.status)) entry.status = 'cancelled'
      record.paused = true
      await this.options.store.save(record.owner, record)
      assert()
      await stop?.()
      assert()
    })
  }

  whenIdle(taskId: string, operation: () => Promise<void>): Promise<void> {
    return this.access(taskId, async (record, task, assert) => {
      if (task.activeRunId || this.options.isBusy?.(task.id) || record.entries.some(entry => ['waiting', 'active', 'failed'].includes(entry.status))) {
        throw new AppError('INVALID_STATE', { message: '还有等待处理的信息，请先处理或终止后再切换员工。' })
      }
      await operation()
      assert()
    })
  }
}
