import { createServer, type ServerResponse } from 'node:http'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiTaskWorker } from './pi-task-worker'
import { SharedPiSession } from './pi-shared-session'
import { setLogSink, type LogRecord } from '../../common/logger'
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
  await assert.rejects(worker.run('hello'), /\u81ea\u52a8\u91cd\u8bd5.*\u4e0a\u9650/)
  await worker.dispose()
  assert.equal(runtime.session.aborted, true)
  assert.ok(events.includes('retry_budget_exhausted'))
})


function writeChunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'model-a', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

it('forwards successful ls results in the next model context', { timeout: 20000 }, async () => {
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(body) as { messages: Array<Record<string, unknown>> })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (requests.length === 1) {
        writeChunk(response, {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call-ls', type: 'function', function: { name: 'ls', arguments: '{}' } }],
        })
        writeChunk(response, {}, 'tool_calls')
      } else {
        writeChunk(response, { role: 'assistant', content: 'The directory contains known.txt.' })
        writeChunk(response, {}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = await makeDirectory()
  await writeFile(join(root, 'known.txt'), 'known file', 'utf8')
  const worker = new PiTaskWorker({
    context: {
      ...context(root),
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      toolPolicy: {
        allowedTools: ['ls'], allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled',
        approvalMode: 'confirm-each', workspaceDir: root,
      },
    },
    runtime: new PiCodingAgentAdapter(), createTokenManager: () => new FakeTokenManager(),
    getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
    onApprovalRequest: async () => { throw new Error('ls must not ask approval') }, onEvent: () => {},
  })
  try {
    await worker.run('List the files in the workspace.')
    assert.equal(requests.length, 2)
    const messages = requests[1]!.messages
    const assistant = messages.find(message => message.role === 'assistant' && Array.isArray(message.tool_calls))
    assert.ok(assistant)
    const toolCalls = assistant.tool_calls as Array<Record<string, unknown>>
    const call = toolCalls[0]
    assert.equal((call?.function as Record<string, unknown>)?.name, 'ls')
    assert.equal(call?.id, 'call-ls')
    const result = messages.find(message => message.role === 'tool' && message.tool_call_id === 'call-ls')
    assert.ok(result, 'the successful ls result must be sent back to the model')
    assert.match(String(result.content), /known\.txt/)
  } finally {
    await worker.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
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


for (const recover of [true, false]) {
  it(`real SDK returns unknown-tool errors to the model and ${recover ? 'allows correction' : 'stops an identical invalid batch loop'}`, { timeout: 20000 }, async () => {
    const requests: Array<{ messages: Array<Record<string, unknown>> }> = []
    const logs: LogRecord[] = []
    const restoreLog = setLogSink(record => { logs.push(record) })
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requests.push(JSON.parse(body))
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const round = requests.length
        if ((recover && round === 2) || round > 4) {
          writeChunk(response, { role: 'assistant', content: 'Done' })
          writeChunk(response, {}, 'stop')
        } else {
          // Fragmented SSE arguments with stable indexes; two independent calls in one response.
          writeChunk(response, { role: 'assistant', tool_calls: [
            { index: 0, id: `ls-${round}`, type: 'function', function: { name: 'ls', arguments: '' } },
            { index: 1, id: `unknown-${round}`, type: 'function', function: { name: 'tool', arguments: '' } },
          ] })
          writeChunk(response, { tool_calls: [
            { index: 0, function: { arguments: '{}' } },
            { index: 1, function: { arguments: '{"privateValue":"do-not-log-tool-arguments"}' } },
          ] })
          writeChunk(response, {}, 'tool_calls')
        }
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const root = await makeDirectory()
    const events: Array<{ type: string; data: unknown }> = []
    const worker = new PiTaskWorker({
      context: {
        ...context(root), gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
        toolPolicy: { allowedTools: ['ls'], allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled', approvalMode: 'confirm-each', workspaceDir: root },
      },
      runtime: new PiCodingAgentAdapter(), createTokenManager: () => new FakeTokenManager(),
      getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
      onApprovalRequest: async () => { throw new Error('Read-only ls must not ask approval') },
      onEvent: event => { events.push(event) },
    })
    try {
      if (recover) await worker.run('List files')
      else await assert.rejects(worker.run('List files'), /Repeated unknown-tool loop/)
      assert.equal(requests.length, recover ? 2 : 3)
      for (let round = 1; round < requests.length; round++) {
        const messages = requests[round]!.messages
        const unknownResult = messages.find(message => message.tool_call_id === `unknown-${round}`)
        assert.equal(unknownResult?.role, 'tool')
        assert.match(String(unknownResult?.content), /Tool tool not found/)
        assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === `ls-${round}`))
      }
      const endings = events.filter(event => event.type === 'tool_execution_end').map(event => event.data as { toolName: string; success: boolean })
      assert.ok(endings.some(event => event.toolName === 'ls' && event.success))
      assert.ok(endings.some(event => event.toolName === 'tool' && !event.success))
      assert.equal(events.some(event => event.type === 'auto_retry_start'), false)
      const audit = logs.find(record => record.message === 'provider returned unavailable tool calls')
      assert.ok(audit, 'streamed tool names must be audited after SDK assembly, not through nonexistent response.body')
      assert.deepEqual(audit.fields['toolNames'], ['tool'])
      assert.equal(JSON.stringify(logs).includes('do-not-log-tool-arguments'), false)
    } finally {
      await worker.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      restoreLog()
    }
  })
}


it('stops a successful identical-tool loop instead of issuing unbounded provider requests', async () => {
  const runtime = new FakeRuntime()
  runtime.session.prompt = async () => {
    for (let round = 0; round < 4; round += 1) {
      const call = { type: 'toolCall', id: `ls-${round}`, name: 'ls', arguments: { path: '.' } }
      const result = { role: 'toolResult', toolCallId: call.id, toolName: 'ls', isError: false, content: [{ type: 'text', text: 'test.txt' }] }
      runtime.session.listener?.({ type: 'turn_start', data: {} })
      runtime.session.listener?.({ type: 'tool_execution_end', data: { toolId: call.id, toolName: 'ls', success: true } })
      runtime.session.listener?.({ type: 'turn_end', data: { message: { content: [call] }, toolResults: [result] } })
    }
  }
  const worker = new PiTaskWorker({
    context: context(await makeDirectory()), runtime, createTokenManager: () => new FakeTokenManager(),
    getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
    onApprovalRequest: async () => false, onEvent: () => {},
  })
  try {
    await assert.rejects(worker.run('List files'), /Repeated tool loop/)
    assert.equal(runtime.session.aborted, true)
  } finally { await worker.dispose() }
})

for (const progress of ['arguments', 'results', 'valid-turn', 'ordinary-error', 'same-turn'] as const) {
  it(`does not stop tool recovery with ${progress}`, async () => {
    const runtime = new FakeRuntime()
    runtime.session.prompt = async () => {
      const roundCount = progress === 'same-turn' ? 1 : 4
      for (let round = 0; round < roundCount; round++) {
        const unknown = progress !== 'ordinary-error' && !(progress === 'valid-turn' && round === 2)
        const toolName = unknown ? 'tool' : 'ls'
        const calls = Array.from({ length: progress === 'same-turn' ? 4 : 1 }, (_, index) => ({
          type: 'toolCall', id: `${round}-${index}`, name: toolName,
          arguments: { path: progress === 'arguments' ? `folder-${round}` : '.' },
        }))
        const results = calls.map(call => ({
          role: 'toolResult', toolCallId: call.id, toolName, isError: unknown || progress === 'ordinary-error',
          content: [{ type: 'text', text: progress === 'results' ? `changed-${round}` : 'unchanged' }],
        }))
        runtime.session.listener?.({ type: 'turn_start', data: {} })
        for (const result of results) {
          runtime.session.listener?.({ type: 'tool_execution_end', data: {
            toolId: result.toolCallId, toolName, success: !result.isError,
            failureReason: unknown ? 'unknown-tool' : 'execution-failed',
          } })
        }
        runtime.session.listener?.({ type: 'turn_end', data: { message: { content: calls }, toolResults: results } })
      }
    }
    const worker = new PiTaskWorker({
      context: context(await makeDirectory()), runtime, createTokenManager: () => new FakeTokenManager(),
      getRefreshToken: () => 'test-refresh', onAuthenticationRequired: () => {},
      onApprovalRequest: async () => false, onEvent: () => {},
    })
    try {
      await worker.run('Recover from errors')
      assert.equal(runtime.session.aborted, false)
    } finally { await worker.dispose() }
  })
}
