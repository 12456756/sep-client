import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationContextStore } from './conversation-context'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('ConversationContextStore', () => {
  it('persists canonical messages, participant audit data, and the shared Pi session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-client-conversation-'))
    directories.push(root)
    const store = new ConversationContextStore(join(root, 'task-a'))
    await store.appendMessage({ id: 'm1', taskId: 'task-a', turnId: 'turn-a', runId: 'run-a', employeeInstanceId: 'employee-a', modelId: 'model-a', role: 'user', content: 'hello', createdAt: 1 })
    await store.appendMessage({ id: 'm2', taskId: 'task-a', turnId: 'turn-a', runId: 'run-a', employeeInstanceId: 'employee-a', modelId: 'model-a', role: 'assistant', content: 'hi', createdAt: 2 })
    await store.setEmployeeSession({ employeeInstanceId: 'employee-a', sessionId: 'session-a', sessionFile: 'session.jsonl', lastRunId: 'run-a', updatedAt: 2 })
    await store.setSharedSession({ sessionId: 'session-a', sessionFile: 'session.jsonl', lastRunId: 'run-a', updatedAt: 2 })
    assert.deepEqual((await store.listMessages()).map(message => message.content), ['hello', 'hi'])
    assert.equal((await store.getEmployeeSession('employee-a'))?.sessionId, 'session-a')
    assert.equal((await store.getSharedSession())?.sessionFile, 'session.jsonl')
  })
})
