import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskRunStore } from './task-run-store'

const temporaryDirectories: string[] = []

async function makeUserDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-runs-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('TaskRunStore', () => {
  it('keeps run, session, and event data inside the authenticated owner scope', async () => {
    const store = new TaskRunStore(await makeUserDataDir())
    const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const record = await store.create(owner, {
      taskId: 'task-a',
      runId: 'run-a',
      subscriptionId: 'employee-a',
      modelId: 'model-a',
      runtimeKey: 'employee-a:model-a',
      workspaceDir: 'C:/workspace/task-a',
      prompt: 'first question',
    })

    assert.equal(record.sessionId, null)
    assert.match(record.sessionDir, /task-a/)
    await store.setSession(owner, 'task-a', 'run-a', { sessionId: 'session-a', sessionFile: 'C:/session.jsonl' })
    await store.appendEvent(owner, {
      taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', sequence: 1,
      type: 'text_delta', occurredAt: 1, data: { text: 'hello' },
    })
    await store.finish(owner, 'task-a', 'run-a', 'completed')

    const paths = store.getPaths(owner, 'task-a', 'run-a')
    const persisted = JSON.parse(await readFile(paths.runFile, 'utf8')) as { outcome: string; sessionId: string }
    assert.equal(persisted.outcome, 'completed')
    assert.equal(persisted.sessionId, 'session-a')
    assert.equal('subscriptionId' in persisted, true)
    assert.equal('employeeInstanceId' in persisted, false)
    const events = await readFile(join(paths.taskDir, 'events.jsonl'), 'utf8')
    assert.match(events, /"runId":"run-a"/)
    assert.throws(() => store.getPaths({ memberId: '../other', enterpriseId: owner.enterpriseId }, 'task-a', 'run-a'))
  })

  it('serializes updates for one run without losing the session binding', async () => {
    const store = new TaskRunStore(await makeUserDataDir())
    const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    await store.create(owner, {
      taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', modelId: 'model-a',
      runtimeKey: 'runtime-a', workspaceDir: 'C:/workspace/task-a',
      prompt: 'first question',
    })
    await Promise.all([
      store.setSession(owner, 'task-a', 'run-a', { sessionId: 'session-a', sessionFile: null }),
      store.finish(owner, 'task-a', 'run-a', 'failed', 'failure'),
    ])
    const paths = store.getPaths(owner, 'task-a', 'run-a')
    const persisted = JSON.parse(await readFile(paths.runFile, 'utf8')) as { outcome: string; sessionId: string }
    assert.equal(persisted.outcome, 'failed')
    assert.equal(persisted.sessionId, 'session-a')
  })

  it('marks active runs interrupted on startup and reads a scoped timeline', async () => {
    const store = new TaskRunStore(await makeUserDataDir())
    const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    await store.create(owner, {
      taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', modelId: 'model-a',
      runtimeKey: 'runtime-a', workspaceDir: 'C:/workspace/task-a',
      prompt: 'first question',
    })
    const paths = store.getPaths(owner, 'task-a', 'run-a')
    await appendFile(join(paths.taskDir, 'events.jsonl'), '{broken}\n')
    await store.appendEvent(owner, {
      taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', sequence: 2,
      type: 'agent_end', occurredAt: 2, data: { token: 'hidden' },
    })
    await store.appendEvent(owner, {
      taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', sequence: 1,
      type: 'agent_start', occurredAt: 1, data: null,
    })
    assert.equal(await store.markActiveRunsInterrupted(owner), 1)
    const record = await store.get(owner, 'task-a', 'run-a')
    assert.equal(record?.outcome, 'interrupted')
    const timeline = await store.getTimeline(owner, 'task-a', 'run-a')
    assert.deepEqual(timeline.map(event => event.sequence), [1, 2])
    assert.deepEqual(timeline[1]?.data, { token: '[redacted]' })
    assert.equal((await store.list(owner, 'task-a')).length, 1)
  })

  it('reconstructs persisted multi-turn conversation messages', async () => {
    const store = new TaskRunStore(await makeUserDataDir())
    const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const createRun = async (runId: string, prompt: string) => {
      await store.create(owner, {
        taskId: 'task-a', runId, subscriptionId: 'employee-a', modelId: 'model-a',
        runtimeKey: 'runtime-a', workspaceDir: 'C:/workspace/task-a', prompt,
      })
    }
    await createRun('run-a', 'first question')
    await store.appendEvent(owner, {
      taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', sequence: 1,
      type: 'text_delta', occurredAt: 1, data: { text: 'first ' },
    })
    await store.appendEvent(owner, {
      taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', sequence: 2,
      type: 'text_delta', occurredAt: 2, data: { text: 'answer' },
    })
    await store.finish(owner, 'task-a', 'run-a', 'completed')
    await new Promise(resolve => setTimeout(resolve, 2))
    await createRun('run-b', 'follow-up question')
    await store.appendEvent(owner, {
      taskId: 'task-a', runId: 'run-b', subscriptionId: 'employee-a', sequence: 1,
      type: 'text_delta', occurredAt: 3, data: { text: 'follow-up answer' },
    })

    const messages = await store.getMessages(owner, 'task-a', 'legacy fallback')
    assert.deepEqual(messages.map(message => [message.role, message.content]), [
      ['user', 'first question'],
      ['assistant', 'first answer'],
      ['user', 'follow-up question'],
      ['assistant', 'follow-up answer'],
    ])
  })
})
