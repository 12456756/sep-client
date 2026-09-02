import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { SharedPiSessionAdapter } from './shared-session-adapter'
import type { PiAgentEvent, PiAgentRuntime, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'

class FakeSession implements PiAgentSession {
  readonly sessionId: string
  readonly sessionFile = 'task-session.jsonl'
  prompts: string[] = []
  disposed = 0
  aborted = 0
  private listeners = new Set<(event: PiAgentEvent) => void>()

  constructor(id: string) { this.sessionId = id }
  prompt(text: string): Promise<void> { this.prompts.push(text); return Promise.resolve() }
  abort(): Promise<void> { this.aborted++; return Promise.resolve() }
  subscribe(listener: (event: PiAgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  dispose(): Promise<void> { this.disposed++; return Promise.resolve() }
  emit(event: PiAgentEvent): void { for (const listener of this.listeners) listener(event) }
}

describe('SharedPiSessionAdapter', () => {
  it('reuses one session and rebuilds on employee switch with the same file', async () => {
    const sessions: FakeSession[] = []
    const configs: PiAgentSessionConfig[] = []
    const runtime: PiAgentRuntime = {
      createSession: async config => {
        configs.push(config)
        const session = new FakeSession(`session-${sessions.length + 1}`)
        sessions.push(session)
        return session
      },
    }
    const adapter = new SharedPiSessionAdapter(runtime)
    const events: string[] = []
    const unsubscribe = adapter.subscribe(event => events.push(event.type))
    const first = await adapter.open({ runId: 'run-1', modelId: 'm1', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'x', authorizeTool: async () => true }) as FakeSession
    const same = await adapter.open({ runId: 'run-2', modelId: 'm1', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'x', authorizeTool: async () => true })
    assert.equal(first, same)
    sessions[0].emit({ type: 'turn_start', data: {} })
    assert.deepEqual(events, ['turn_start'])

    const second = await adapter.switchEmployee({ runId: 'run-3', modelId: 'm2', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'x', authorizeTool: async () => true }) as FakeSession
    assert.notEqual(second, first)
    assert.equal(sessions[0].aborted, 1)
    assert.equal(sessions[0].disposed, 1)
    assert.equal(configs[1].resumeSessionFile, 'task-session.jsonl')
    second.emit({ type: 'agent_end', data: {} })
    assert.deepEqual(events, ['turn_start', 'agent_end'])
    unsubscribe()
    await adapter.dispose()
    await adapter.dispose()
    assert.equal(sessions[1].disposed, 1)
  })
})
