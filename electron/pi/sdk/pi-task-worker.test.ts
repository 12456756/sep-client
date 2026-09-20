import { createServer, type ServerResponse } from 'node:http'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiTaskWorker } from './pi-task-worker'
import { SharedPiSession } from './pi-shared-session'
import type { PiAgentRuntime, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'

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
  listener: ((event: { type: string; data: unknown; failure?: string }) => void) | null = null
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
    taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', modelId: 'model-a',
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


  it('passes the selected tool allowlist to the provider session', async () => {
    let requestBody: Record<string, unknown> | null = null
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requestBody = JSON.parse(body) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        writeChunk(response, { role: 'assistant', content: 'ok' })
        writeChunk(response, {}, 'stop')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const root = await makeDirectory()
    const worker = new PiTaskWorker({
      context: {
        ...context(root),
        gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
        toolPolicy: {
          allowedTools: ['read', 'grep', 'find', 'ls'],
          allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled',
          approvalMode: 'confirm-each', workspaceDir: root,
        },
      },
      runtime: new PiCodingAgentAdapter(), createTokenManager: () => new FakeTokenManager(),
      getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
      onApprovalRequest: async () => false, onEvent: () => {},
    })
    try {
      await worker.run('Hello')
      const tools = (requestBody as Record<string, unknown> | null)?.tools
      assert.ok(Array.isArray(tools))
      const names = tools.map(tool => {
        if (!tool || typeof tool !== 'object') return undefined
        const record = tool as Record<string, unknown>
        if (typeof record.name === 'string') return record.name
        const fn = record.function
        return fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string'
          ? (fn as Record<string, unknown>).name
          : undefined
      })
      assert.deepEqual(names, ['read', 'grep', 'find', 'ls', 'web_search'])
    } finally {
      await worker.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('forwards repeated tool execution failures without aborting the agent loop', async () => {
    const runtime = new FakeRuntime()
    runtime.session.prompt = async () => {
      for (let index = 0; index < 3; index++) {
        runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'bash', success: false, error: 'command failed', failureReason: 'execution-failed' } })
      }
      runtime.session.listener?.({ type: 'agent_end', data: { willRetry: false } })
    }
    const events: string[] = []
    const worker = new PiTaskWorker({
      context: context(await makeDirectory()), getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {}, onApprovalRequest: async () => false,
      onEvent: event => { events.push(event.type) }, runtime, createTokenManager: () => new FakeTokenManager(),
    })

    await worker.run('hello')
    assert.equal(runtime.session.aborted, false, 'tool failures must not abort the session')
    await worker.dispose()
    assert.equal(runtime.session.aborted, true, 'dispose still aborts the session')
    assert.equal(events.filter(type => type === 'tool_execution_end').length, 3)
    assert.equal(events.includes('tool_failure_budget_exhausted'), false)
  })

  it('forwards policy-denied and unknown-tool failures as ordinary tool events', async () => {
    const runtime = new FakeRuntime()
    let completed = false
    runtime.session.prompt = async () => {
      // Two policy denials
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'bash', success: false, error: 'policy denied', failureReason: 'policy-denied' } })
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'write', success: false, error: 'not allowed', failureReason: 'policy-denied' } })
      // Two unknown tools
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'tool', success: false, error: 'Tool tool not found', failureReason: 'unknown-tool' } })
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'foo', success: false, error: 'Tool foo not found', failureReason: 'unknown-tool' } })
      // Execution failures are also forwarded; the model decides whether to correct or stop.
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'read', success: false, error: 'file not found', failureReason: 'execution-failed' } })
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'read', success: true } })
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolName: 'grep', success: false, error: 'pattern error', failureReason: 'execution-failed' } })
      runtime.session.listener?.({ type: 'agent_end', data: { willRetry: false } })
      completed = true
    }
    const events: string[] = []
    const worker = new PiTaskWorker({
      context: context(await makeDirectory()), getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {}, onApprovalRequest: async () => false,
      onEvent: event => { events.push(event.type) }, runtime, createTokenManager: () => new FakeTokenManager(),
    })

    await worker.run('hello')
    await worker.dispose()
    assert.equal(completed, true, 'the Pi loop should remain in control of completion')
    assert.equal(events.filter(type => type === 'tool_execution_end').length, 7)
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


for (const stage of ['token', 'session', 'persistence'] as const) {
  it(`cancels during ${stage} setup without ever sending a prompt`, async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const session = new FakeSession()
    let prompts = 0
    session.prompt = async () => { prompts++ }
    const tokens = new FakeTokenManager()
    if (stage === 'token') tokens.initialize = async () => { entered(); await gate }
    const worker = new PiTaskWorker({
      context: context(await makeDirectory()), getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {}, onApprovalRequest: async () => true, onEvent: () => {},
      createTokenManager: () => tokens,
      runtime: { async createSession() { if (stage === 'session') { entered(); await gate }; return session } },
      onSessionCreated: async () => { if (stage === 'persistence') { entered(); await gate } },
    })
    const running = worker.run('must not execute').catch(() => undefined)
    await ready
    await worker.abort()
    const settledBeforeRelease = await Promise.race([running.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
    release()
    await running
    await new Promise(resolve => setTimeout(resolve, 10))
    await worker.dispose()
    assert.equal(settledBeforeRelease, true, 'cancel must not wait for unabortable setup IO')
    assert.equal(prompts, 0)
    assert.equal(tokens.stopped, true)
    if (stage === 'session') assert.equal(session.disposed, true, 'late session must be disposed')
  })
}

it('bounds automatic retries across successful SDK tool turns, not just consecutive failures', async () => {
  const runtime = new FakeRuntime()
  runtime.session.prompt = async () => {
    for (let index = 0; index < 4; index++) {
      runtime.session.listener?.({ type: 'auto_retry_start', data: { attempt: 1, maxAttempts: 3, error: '503 overloaded' } })
      runtime.session.listener?.({ type: 'auto_retry_end', data: { success: true, attempt: 1 } })
    }
  }
  const events: string[] = []
  const worker = new PiTaskWorker({
    context: context(await makeDirectory()), getRefreshToken: () => 'refresh-token',
    onAuthenticationRequired: () => {}, onApprovalRequest: async () => true,
    onEvent: event => { events.push(event.type) }, runtime, createTokenManager: () => new FakeTokenManager(),
  })
  await assert.rejects(worker.run('hello'), /自动重试.*上限/)
  await worker.dispose()
  assert.equal(runtime.session.aborted, true)
  assert.ok(events.includes('retry_budget_exhausted'))
})


function writeChunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'model-a', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

it('streams real SDK deltas before completion and returns denied tool results with matching IDs', { timeout: 20000 }, async () => {
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let firstDelta!: () => void
  const first = new Promise<void>(resolve => { firstDelta = resolve })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (requests.length === 1) {
        writeChunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-denied', type: 'function', function: { name: 'bash', arguments: '{"command":"echo must-not-execute"}' } }] })
        writeChunk(response, {}, 'tool_calls')
        response.end('data: [DONE]\n\n')
      } else {
        writeChunk(response, { role: 'assistant', content: 'Hello' })
        void gate.then(() => {
          writeChunk(response, { content: ' world' })
          writeChunk(response, {}, 'stop')
          response.end('data: [DONE]\n\n')
        })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const text: string[] = []
  let approvals = 0
  let settled = false
  const worker = new PiTaskWorker({
    context: { ...context(await makeDirectory()), gatewayUrl: `http://127.0.0.1:${address.port}/v1` },
    runtime: new PiCodingAgentAdapter(), createTokenManager: () => new FakeTokenManager(),
    getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
    onApprovalRequest: async () => { approvals++; return false },
    onEvent: event => {
      if (event.type === 'text_delta') { text.push((event.data as { text: string }).text); firstDelta() }
    },
  })
  const run = worker.run('Try the tool, then acknowledge denial.').finally(() => { settled = true })
  try {
    await Promise.race([first, run.then(() => { throw new Error('No streaming delta') })])
    assert.equal(settled, false)
    assert.equal(text.join(''), 'Hello')
    release()
    await run
    assert.equal(text.join(''), 'Hello world')
    assert.equal(approvals, 1)
    assert.equal(requests.length, 2)
    const messages = requests[1]!.messages
    assert.ok(messages.some(message => message.role === 'assistant' && Array.isArray(message.tool_calls)))
    const tool = messages.find(message => message.role === 'tool')
    assert.equal(tool?.tool_call_id, 'call-denied')
    assert.match(String(tool?.content), /denied|blocked/i)
  } finally {
    release()
    await worker.abort()
    await run.catch(() => undefined)
    await worker.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

for (const { status, cancel } of [{ status: 401, cancel: false }, { status: 503, cancel: true }, { status: 503, cancel: false }]) {
  it(`real SDK ${status}: ${status === 401 ? 'surfaces auth failure without retries' : cancel ? 'cancel interrupts retry backoff' : 'stops after three retries'}`, { timeout: 30000 }, async () => {
    let requests = 0
    const server = createServer((request, response) => {
      request.resume()
      requests++
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: status === 401 ? 'Unauthorized' : 'Service unavailable', type: 'test_error' } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const events: string[] = []
    const worker = new PiTaskWorker({
      context: { ...context(await makeDirectory()), gatewayUrl: `http://127.0.0.1:${address.port}/v1` },
      runtime: new PiCodingAgentAdapter(), createTokenManager: () => new FakeTokenManager(),
      getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {}, onApprovalRequest: async () => false,
      onEvent: event => {
        events.push(event.type)
        if (cancel && event.type === 'auto_retry_start') void worker.abort()
      },
    })
    try {
      await assert.rejects(worker.run('Hello'))
      assert.equal(requests, status === 401 || cancel ? 1 : 4)
      assert.equal(events.includes('auto_retry_start'), status === 503)
    } finally {
      await worker.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
}


it('cleans a cancelled shared-session setup before admitting the next turn', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let config!: PiAgentSessionConfig
  let creations = 0
  const first = new FakeSession()
  const second = new FakeSession()
  const adapter = new SharedPiSession({ async createSession(input) {
    config = input
    if (++creations === 1) { entered(); await gate; return first }
    return second
  } })
  const worker = new PiTaskWorker({
    context: context(await makeDirectory()), sessionAdapter: adapter,
    getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
    onApprovalRequest: async () => false, onEvent: () => {}, createTokenManager: () => new FakeTokenManager(),
  })
  const running = worker.run('first').catch(() => undefined)
  await ready
  await worker.abort()
  await running
  await worker.dispose()
  const next = adapter.open(config)
  release()
  try {
    assert.equal(await next, second, 'new turn must not reuse a cancelled setup session')
    assert.equal(first.disposed, true)
    assert.equal(second.disposed, false)
  } finally { await adapter.dispose() }
})
