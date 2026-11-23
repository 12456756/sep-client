import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { SharedPiSession } from './pi-shared-session'
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

describe('SharedPiSession', () => {
  it('uses the current turn media binding without reopening the same conversation', async () => {
    const configs: PiAgentSessionConfig[] = []
    const adapter = new SharedPiSession({ async createSession(config) { configs.push(config); return new FakeSession(`session-${configs.length}`) } })
    const config: PiAgentSessionConfig = { runId: 'first', modelId: 'model-a', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'token', authorizeTool: async () => false }
    try {
      const first = await adapter.open({ ...config, localMedia: { execute: async () => 'first' } })
      assert.equal(await configs[0].localMedia?.execute({}), 'first')
      assert.equal(await adapter.open({ ...config, runId: 'second', localMedia: { execute: async () => 'second' } }), first)
      assert.equal(await configs[0].localMedia?.execute({}), 'second')
      assert.notEqual(await adapter.open({ ...config, runId: 'third' }), first)
      assert.equal(configs[1].localMedia, undefined)
      await adapter.open({ ...config, runId: 'fourth', localMedia: { execute: async () => 'new binding' } })
      await assert.rejects(configs[0].localMedia!.execute({}), /本轮无法使用/)
    } finally { await adapter.dispose() }
  })
  it('changes model while resuming the same conversation file', async () => {
    const configs: PiAgentSessionConfig[] = []
    const adapter = new SharedPiSession({ async createSession(config) { configs.push(config); return new FakeSession(`session-${configs.length}`) } })
    const config: PiAgentSessionConfig = { runId: 'first', modelId: 'model-a', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'token', authorizeTool: async () => false }
    try {
      const first = await adapter.open(config) as FakeSession
      const second = await adapter.open({ ...config, runId: 'second', modelId: 'model-b' })
      assert.notEqual(first, second)
      assert.equal(first.disposed, 1)
      assert.equal(configs[1].modelId, 'model-b')
      assert.equal(configs[1].resumeSessionFile, first.sessionFile)
      assert.equal(await adapter.open({ ...config, modelId: 'model-b' }), second)
      await adapter.reset()
      await adapter.open({ ...config, modelId: 'model-b', resumeSessionFile: 'old-file.jsonl' })
      assert.equal(configs[2].resumeSessionFile, first.sessionFile)
    } finally { await adapter.dispose() }
  })
  it('rebuilds tools after connector authorization changes while retaining history', async () => {
    const configs: PiAgentSessionConfig[] = []
    const adapter = new SharedPiSession({ async createSession(config) { configs.push(config); return new FakeSession(`session-${configs.length}`) } })
    const config: PiAgentSessionConfig = { runId: 'run', modelId: 'model', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'token', authorizeTool: async () => false }
    try {
      const first = await adapter.open(config) as FakeSession
      const connected = await adapter.open({ ...config, connectorBinding: { revision: 'authorized', servers: [], fetch } }) as FakeSession
      assert.notEqual(first, connected)
      assert.equal(first.disposed, 1)
      assert.equal(configs[1].resumeSessionFile, first.sessionFile)
      assert.notEqual(await adapter.open(config), connected)
      assert.equal(connected.disposed, 1)
    } finally { await adapter.dispose() }
  })
  it('recreates a session on vision capability changes while retaining history', async () => {
    const configs: PiAgentSessionConfig[] = []
    const adapter = new SharedPiSession({ async createSession(config) {
      configs.push(config)
      return new FakeSession(`session-${configs.length}`)
    } })
    const config: PiAgentSessionConfig = { runId: 'run', modelId: 'model', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'token', authorizeTool: async () => false }
    try {
      const first = await adapter.open(config) as FakeSession
      assert.equal(await adapter.open({ ...config, vision: null }), first)
      const textOnly = await adapter.open({ ...config, vision: false }) as FakeSession
      assert.notEqual(textOnly, first)
      assert.equal(first.disposed, 1)
      assert.equal(configs[1].vision, false)
      assert.equal(configs[1].resumeSessionFile, first.sessionFile)
      assert.equal(await adapter.open({ ...config, vision: false }), textOnly)
      assert.notEqual(await adapter.open({ ...config, vision: true }), textOnly)
      assert.equal(textOnly.disposed, 1)
    } finally { await adapter.dispose() }
  })
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
    const adapter = new SharedPiSession(runtime)
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
    assert.ok(configs[0].browserOwner)
    assert.equal(configs[0].browserOwner, configs[1].browserOwner, 'employees share the conversation browser owner')
    second.emit({ type: 'agent_end', data: {} })
    assert.deepEqual(events, ['turn_start', 'agent_end'])
    unsubscribe()
    await adapter.dispose()
    await adapter.dispose()
    assert.equal(sessions[1].disposed, 1)
  })

  it('retains the browser owner across round resets and isolates other conversations', async () => {
    const configs: PiAgentSessionConfig[] = []
    const runtime: PiAgentRuntime = { createSession: async config => { configs.push(config); return new FakeSession('session') } }
    const config: PiAgentSessionConfig = { runId: 'run', modelId: 'm', gatewayUrl: 'g', workspaceDir: 'w', agentDir: 'a', sessionDir: 's', getAccessToken: async () => 'x', authorizeTool: async () => false }
    const first = new SharedPiSession(runtime)
    const other = new SharedPiSession(runtime)
    try {
      await first.open(config)
      await first.reset()
      await first.open(config)
      await other.open(config)
      assert.equal(configs[0].browserOwner, configs[1].browserOwner)
      assert.notEqual(configs[0].browserOwner, configs[2].browserOwner)
    } finally { await first.dispose(); await other.dispose() }
  })
})
