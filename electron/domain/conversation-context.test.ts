import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationContextStore } from './conversation-context'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('ConversationContextStore', () => {
  it('persists canonical messages and one task-level shared Pi session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-client-conversation-'))
    directories.push(root)
    const store = new ConversationContextStore(join(root, 'task-a'))
    await store.appendMessage({ id: 'm1', taskId: 'task-a', turnId: 'turn-a', runId: 'run-a', subscriptionId: 'employee-a', modelId: 'model-a', role: 'user', content: 'hello', createdAt: 1 })
    await store.appendMessage({ id: 'm2', taskId: 'task-a', turnId: 'turn-a', runId: 'run-a', subscriptionId: 'employee-a', modelId: 'model-a', role: 'assistant', content: 'hi', createdAt: 2 })
    await store.setSharedSession({ sessionId: 'session-a', sessionFile: 'session.jsonl', lastRunId: 'run-a', updatedAt: 2 })
    assert.deepEqual((await store.listMessages()).map(message => message.content), ['hello', 'hi'])
    assert.equal((await store.getSharedSession())?.sessionFile, 'session.jsonl')
  })

  it('does not create employee-specific session bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-client-conversation-'))
    directories.push(root)
    const store = new ConversationContextStore(join(root, 'task-a'))
    await store.setSharedSession({ sessionId: 'session-a', sessionFile: 'session.jsonl', lastRunId: 'run-a', updatedAt: 2 })
    await store.appendMessage({ id: 'm2', taskId: 'task-a', turnId: 'turn-b', runId: 'run-b', subscriptionId: 'employee-b', modelId: 'model-b', role: 'assistant', content: 'handoff', createdAt: 3 })
    await store.setSharedSession({ sessionId: 'session-a', sessionFile: 'session.jsonl', lastRunId: 'run-b', updatedAt: 3 })
    const conversationDir = join(root, 'task-a', 'conversation')
    await assert.rejects(access(join(conversationDir, 'participants.json')))
    assert.deepEqual(await store.getSharedSession(), {
      sessionId: 'session-a',
      sessionFile: 'session.jsonl',
      lastRunId: 'run-b',
      updatedAt: 3,
    })
  })
})

