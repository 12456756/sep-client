import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiTaskWorker } from './pi-task-worker'
import type { PiAgentRuntime, PiAgentSession } from './pi-agent-runtime'

const temporaryDirectories: string[] = []

class FakeTokenManager {
  stopped = false
  async initialize(): Promise<void> {}
  async getValidToken(): Promise<string> { return 'test-token' }
  stop(): void { this.stopped = true }
}

class FakeSession implements PiAgentSession {
  readonly sessionId = 'session-a'
  readonly sessionFile = 'session-a.jsonl'
  private listener: ((event: { type: string; data: unknown; failure?: string }) => void) | null = null
  disposed = false
  aborted = false

  async prompt(): Promise<void> {
    this.listener?.({ type: 'agent_start', data: {} })
    this.listener?.({ type: 'agent_end', data: { willRetry: false } })
  }

  async abort(): Promise<void> { this.aborted = true }

  subscribe(listener: (event: { type: string; data: unknown; failure?: string }) => void): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }

  async dispose(): Promise<void> { this.disposed = true }

  emitLate(): void { this.listener?.({ type: 'late_event', data: {} }) }
}

class FakeRuntime implements PiAgentRuntime {
  readonly session = new FakeSession()
  async createSession(): Promise<PiAgentSession> { return this.session }
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-worker-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function context(root: string) {
  return {
    taskId: 'task-a', runId: 'run-a', employeeInstanceId: 'employee-a', modelId: 'model-a',
    gatewayUrl: 'http://localhost:19999', workspaceDir: root,
    agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
  }
}

describe('PiTaskWorker', () => {
  it('owns one run session and emits events with explicit context', async () => {
    const runtime = new FakeRuntime()
    const events: string[] = []
    const tokenManager = new FakeTokenManager()
    const worker = new PiTaskWorker({
      context: context(await makeDirectory()),
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onApprovalRequest: async () => true,
      onEvent: event => { events.push(`${event.taskId}:${event.runId}:${event.type}:${event.sequence}`) },
      runtime,
      createTokenManager: () => tokenManager,
    })

    await worker.run('hello')
    await worker.dispose()
    runtime.session.emitLate()

    assert.deepEqual(events, ['task-a:run-a:agent_start:1', 'task-a:run-a:agent_end:2'])
    assert.equal(runtime.session.disposed, true)
    assert.equal(runtime.session.aborted, true)
    assert.equal(tokenManager.stopped, true)
  })

  it('does not leak token state when session construction fails', async () => {
    const tokenManager = new FakeTokenManager()
    const runtime: PiAgentRuntime = {
      async createSession(): Promise<PiAgentSession> { throw new Error('init failed') },
    }
    const worker = new PiTaskWorker({
      context: context(await makeDirectory()), getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {}, onApprovalRequest: async () => true,
      onEvent: () => {}, runtime, createTokenManager: () => tokenManager,
    })
    await assert.rejects(worker.run('hello'), /init failed/)
    assert.equal(tokenManager.stopped, true)
  })
})
