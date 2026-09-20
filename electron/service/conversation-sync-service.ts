import { logger } from '../common/logger'
import type { ConversationMessageToSync, ConversationMessageSyncPort } from '../domain/conversation-message-sync'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConversationSyncItem, ConversationSyncStorePort } from '../data/conversation-sync-store'

export interface ConversationSyncServiceOptions {
  store: ConversationSyncStorePort
  getScope: () => TaskOwnerScope | null
  upload: (item: ConversationSyncItem) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  retryDelaysMs?: readonly number[]
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000] as const
const MAX_AUTH_RETRIES = 3
const log = logger.child('conversation-sync')

interface ClassifiedError {
  kind: 'transient' | 'permanent'
  code: string
}

function statusCodeOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as { statusCode?: unknown }).statusCode
  return typeof value === 'number' ? value : null
}

function classifyError(error: unknown): ClassifiedError {
  const statusCode = statusCodeOf(error)
  if (statusCode === 409) return { kind: 'permanent', code: 'http-409' }
  if (statusCode === 401) return { kind: 'transient', code: 'http-401' }
  if (statusCode === 408 || statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return { kind: 'transient', code: `http-${statusCode}` }
  }
  if (statusCode !== null && statusCode >= 500) return { kind: 'transient', code: `http-${statusCode}` }
  if (statusCode !== null && statusCode >= 400) return { kind: 'permanent', code: `http-${statusCode}` }
  return { kind: 'transient', code: 'network-error' }
}

function cloneScope(scope: TaskOwnerScope): TaskOwnerScope {
  return { memberId: scope.memberId, enterpriseId: scope.enterpriseId }
}

export class ConversationSyncService implements ConversationMessageSyncPort {
  private readonly getScope: () => TaskOwnerScope | null
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly retryDelaysMs: readonly number[]
  private readonly workers = new Map<string, Promise<void>>()
  private readonly startedScopes = new Map<string, TaskOwnerScope>()

  constructor(private readonly options: ConversationSyncServiceOptions) {
    this.getScope = options.getScope
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS
  }

  enqueue(message: ConversationMessageToSync): void {
    const scope = this.getScope()
    if (!scope) return
    const item: ConversationSyncItem = {
      id: message.clientMessageId,
      taskId: message.taskId,
      runId: message.runId,
      role: message.role,
      content: message.content,
      clientConversationId: message.clientConversationId,
      clientMessageId: message.clientMessageId,
      subscriptionId: message.subscriptionId,
      modelId: message.modelId,
      turnId: message.turnId,
      createdAt: message.createdAt,
      status: 'pending',
      retryCount: 0,
      nextRetryAt: 0,
    }
    const ownedScope = cloneScope(scope)
    void this.options.store.save(ownedScope, item)
      .then(() => this.pump(ownedScope))
      .catch(error => this.logFailure('save', error))
  }

  start(scope: TaskOwnerScope): void {
    const ownedScope = cloneScope(scope)
    this.startedScopes.set(this.scopeKey(ownedScope), ownedScope)
    void this.options.store.recover(ownedScope)
      .then(() => this.pump(ownedScope))
      .catch(error => this.logFailure('recover', error))
  }

  private pump(scope: TaskOwnerScope): Promise<void> {
    const key = this.scopeKey(scope)
    const prior = this.workers.get(key)
    if (prior) return prior
    const worker = this.run(scope).catch(error => this.logFailure('worker', error)).finally(() => {
      if (this.workers.get(key) === worker) this.workers.delete(key)
    })
    this.workers.set(key, worker)
    return worker
  }

  private async run(scope: TaskOwnerScope): Promise<void> {
    while (true) {
      const items = await this.options.store.list(scope)
      const now = this.now()
      const candidate = items.find(item =>
        (item.status === 'pending' || item.status === 'failed') && item.nextRetryAt <= now &&
        !(item.status === 'failed' && item.lastError === 'http-401' && item.retryCount >= MAX_AUTH_RETRIES),
      )
      if (!candidate) return

      await this.options.store.update(scope, candidate.clientMessageId, { status: 'syncing' })
      try {
        await this.options.upload(candidate)
        await this.options.store.update(scope, candidate.clientMessageId, {
          status: 'completed', nextRetryAt: 0, lastError: undefined,
        })
      } catch (error) {
        const classified = classifyError(error)
        if (classified.code === 'http-409') {
          await this.options.store.update(scope, candidate.clientMessageId, {
            status: 'completed',
            nextRetryAt: 0,
            lastError: undefined,
          })
          continue
        }
        const retryCount = candidate.retryCount + 1
        const canRetry = classified.kind === 'transient' &&
          (classified.code !== 'http-401' || retryCount <= MAX_AUTH_RETRIES)
        const delay = canRetry
          ? this.retryDelaysMs[Math.min(retryCount - 1, this.retryDelaysMs.length - 1)]
          : 0
        await this.options.store.update(scope, candidate.clientMessageId, {
          status: 'failed',
          retryCount,
          nextRetryAt: canRetry ? this.now() + delay : Number.MAX_SAFE_INTEGER,
          lastError: classified.code,
        })
        this.logFailure('upload', error, classified.code)
        if (canRetry) await this.sleep(delay)
      }
    }
  }

  private scopeKey(scope: TaskOwnerScope): string {
    return `${scope.enterpriseId}:${scope.memberId}`
  }

  private logFailure(stage: string, error: unknown, code?: string): void {
    log.warn('conversation message sync failed', {
      stage,
      code: code ?? classifyError(error).code,
    })
  }
}
