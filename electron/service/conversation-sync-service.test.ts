import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ConversationSyncService } from './conversation-sync-service'
import type { ConversationSyncItem, ConversationSyncStorePort } from '../data/conversation-sync-store'
import type { TaskOwnerScope } from '../data/scope-path'

const scope: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

function message(overrides: Partial<Parameters<ConversationSyncService['enqueue']>[0]> = {}) {
  return {
    taskId: 'task-a', runId: 'run-a', role: 'user' as const, content: 'hello',
    clientConversationId: 'task-a', clientMessageId: 'message-a', subscriptionId: 'employee-a',
    modelId: 'model-a', turnId: 'run-a', createdAt: 1, ...overrides,
  }
}

class MemoryStore implements ConversationSyncStorePort {
  readonly items = new Map<string, ConversationSyncItem>()
  recoverCalls = 0
  async list(): Promise<ConversationSyncItem[]> { return [...this.items.values()].map(item => ({ ...item })) }
  async save(_scope: TaskOwnerScope, item: ConversationSyncItem): Promise<void> {
    if (!this.items.has(item.clientMessageId)) this.items.set(item.clientMessageId, { ...item })
  }
  async update(_scope: TaskOwnerScope, clientMessageId: string, update: Partial<ConversationSyncItem>): Promise<void> {
    const current = this.items.get(clientMessageId)
    if (current) this.items.set(clientMessageId, { ...current, ...update })
  }
  async recover(): Promise<void> {
    this.recoverCalls += 1
    for (const [id, item] of this.items) {
      if (item.status === 'syncing') this.items.set(id, { ...item, status: 'pending' })
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('ConversationSyncService', () => {
  it('uploads asynchronously and completes the outbox item', async () => {
    const store = new MemoryStore()
    let uploaded: ConversationSyncItem | undefined
    const service = new ConversationSyncService({
      store, getScope: () => scope, upload: async item => { uploaded = item },
    })
    service.enqueue(message())
    assert.equal(store.items.size, 1)
    await settle()
    assert.ok(uploaded)
    assert.equal(uploaded.clientMessageId, 'message-a')
    assert.equal(store.items.get('message-a')?.status, 'completed')
  })

  it('does not throw to the caller and permanently records client errors', async () => {
    const store = new MemoryStore()
    const service = new ConversationSyncService({
      store, getScope: () => scope, upload: async () => { throw Object.assign(new Error('bad request'), { statusCode: 400 }) },
    })
    assert.doesNotThrow(() => service.enqueue(message()))
    await settle()
    const item = store.items.get('message-a')
    assert.equal(item?.status, 'failed')
    assert.equal(item?.lastError, 'http-400')
    assert.equal(item?.nextRetryAt, Number.MAX_SAFE_INTEGER)
  })

  it('treats conflicts as successful idempotent uploads', async () => {
    const store = new MemoryStore()
    const service = new ConversationSyncService({
      store, getScope: () => scope, upload: async () => { throw Object.assign(new Error('duplicate'), { statusCode: 409 }) },
    })
    service.enqueue(message())
    await settle()
    assert.equal(store.items.get('message-a')?.status, 'completed')
  })

  it('backs off transient failures and eventually succeeds', async () => {
    const store = new MemoryStore()
    let attempts = 0
    let currentTime = 0
    const delays: number[] = []
    const service = new ConversationSyncService({
      store, getScope: () => scope, retryDelaysMs: [11, 22],
      now: () => currentTime,
      sleep: async delay => { delays.push(delay); currentTime += delay },
      upload: async () => {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('busy'), { statusCode: 503 })
      },
    })
    service.enqueue(message())
    await settle()
    assert.equal(attempts, 3)
    assert.deepEqual(delays, [11, 22])
    assert.equal(store.items.get('message-a')?.status, 'completed')
  })

  it('recovers interrupted uploads when started for a scope', async () => {
    const store = new MemoryStore()
    store.items.set('message-a', { ...message(), id: 'message-a', status: 'syncing', retryCount: 0, nextRetryAt: 0 })
    const service = new ConversationSyncService({
      store, getScope: () => scope, upload: async () => undefined,
    })
    service.start(scope)
    await settle()
    assert.equal(store.recoverCalls, 1)
    assert.equal(store.items.get('message-a')?.status, 'completed')
  })

  it('keeps one upload worker per scope', async () => {
    const store = new MemoryStore()
    let active = 0
    let maximum = 0
    const service = new ConversationSyncService({
      store, getScope: () => scope,
      upload: async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise(resolve => setImmediate(resolve))
        active -= 1
      },
    })
    service.enqueue(message({ clientMessageId: 'message-a' }))
    service.enqueue(message({ clientMessageId: 'message-b' }))
    await settle()
    assert.equal(maximum, 1)
    assert.equal(store.items.get('message-a')?.status, 'completed')
    assert.equal(store.items.get('message-b')?.status, 'completed')
  })
})
