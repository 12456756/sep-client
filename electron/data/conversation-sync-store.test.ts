import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationSyncStore } from './conversation-sync-store'
import { ScopePath } from './scope-path'
import type { ConversationSyncItem } from './conversation-sync-store'

const directories: string[] = []
const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

async function makeStore(): Promise<{ store: ConversationSyncStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-conversation-sync-'))
  directories.push(directory)
  return { store: new ConversationSyncStore(directory), directory }
}

function item(overrides: Partial<ConversationSyncItem> = {}): ConversationSyncItem {
  return {
    id: 'run-a-user', taskId: 'task-a', runId: 'run-a', role: 'user', content: 'hello',
    clientConversationId: 'task-a', clientMessageId: 'run-a-user', subscriptionId: 'employee-a',
    modelId: 'model-a', turnId: 'run-a', createdAt: 1, status: 'pending', retryCount: 0,
    nextRetryAt: 0, ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('ConversationSyncStore', () => {
  it('persists pending items and deduplicates client message ids', async () => {
    const { store } = await makeStore()
    await store.save(scope, item())
    await store.save(scope, item({ content: 'duplicate' }))
    assert.deepEqual(await store.list(scope), [item()])
  })

  it('recovers syncing items as pending', async () => {
    const { store, directory } = await makeStore()
    const file = new ScopePath(directory).conversationSyncFile(scope)
    await store.save(scope, item({ status: 'syncing' }))
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { items: ConversationSyncItem[] }
    assert.equal(persisted.items[0].status, 'syncing')
    await store.recover(scope)
    assert.equal((await store.list(scope))[0].status, 'pending')
  })

  it('keeps completed items so they are not uploaded again', async () => {
    const { store } = await makeStore()
    await store.save(scope, item({ status: 'completed' }))
    await store.save(scope, item({ status: 'pending' }))
    assert.equal((await store.list(scope)).length, 1)
    assert.equal((await store.list(scope))[0].status, 'completed')
  })

  it('does not persist secrets and rejects unsupported roles', async () => {
    const { store, directory } = await makeStore()
    await store.save(scope, item({ content: 'safe content' }))
    const file = new ScopePath(directory).conversationSyncFile(scope)
    assert.doesNotMatch(await readFile(file, 'utf8'), /token|Bearer|secret/i)
    await assert.rejects(() => store.save(scope, { ...item(), role: 'tool' as never }))
  })

  it('falls back to a valid backup after a corrupt primary file', async () => {
    const { store, directory } = await makeStore()
    const file = new ScopePath(directory).conversationSyncFile(scope)
    await store.save(scope, item())
    await writeFile(`${file}.bak`, JSON.stringify({ version: 1, items: [item({ content: 'backup' })] }), 'utf8')
    await writeFile(file, '{broken', 'utf8')
    assert.equal((await store.list(scope))[0].content, 'backup')
  })
})
