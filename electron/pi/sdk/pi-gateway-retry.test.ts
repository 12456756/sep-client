import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import type { PiAgentEvent } from './pi-agent-runtime'
import { setLogSink } from '../../common/logger'

function success(response: ServerResponse, toolPath?: string): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const chunk of [
    { choices: [{ index: 0, delta: toolPath
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-recovery', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: toolPath }) } }] }
      : { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolPath ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
  ]) {
    response.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'model-a', ...chunk })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

for (const scenario of [500, 502, 503, 504, 524, 'server-15-seconds', 'backoff-reset'] as const) {
  it(`real gateway: server wait and recovery (${scenario})`, { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-gateway-server-wait-'))
    const toolPath = join(root, 'retained.txt')
    await writeFile(toolPath, 'successful tool result')
    const requests: number[] = []
    const retries: Array<{ delayMs: number; attempt: number }> = []
    const restoreLog = setLogSink(() => {})
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        requests.push(Date.now())
        const count = requests.length
        if (count === 1 || (scenario === 'backoff-reset' && count === 3)) {
          response.writeHead(typeof scenario === 'number' ? scenario : 503, {
            'Content-Type': 'application/json',
            ...(scenario !== 'backoff-reset' ? { 'Retry-After': scenario === 'server-15-seconds' ? '15' : '0.05' } : {}),
          })
          response.end(JSON.stringify({ error: { message: 'Service unavailable' } }))
          return
        }
        success(response, scenario === 'backoff-reset' && count === 2 ? toolPath : undefined)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const session = await new PiCodingAgentAdapter().createSession({
      runId: 'run-a', modelId: 'model-a', gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
      getAccessToken: async () => 'test-token', authorizeTool: async () => true,
      disableTools: scenario !== 'backoff-reset', mcpServers: [],
    })
    session.subscribe(event => {
      if (event.type === 'auto_retry_start') retries.push(event.data as { delayMs: number; attempt: number })
    })
    try {
      await session.prompt('Read the file and finish.')
      const reset = scenario === 'backoff-reset'
      const expectedDelay = reset ? 2000 : scenario === 'server-15-seconds' ? 15000 : 50
      assert.equal(requests.length, reset ? 4 : 2)
      assert.deepEqual(retries.map(event => event.delayMs), reset ? [2000, 2000] : [expectedDelay])
      assert.deepEqual(retries.map(event => event.attempt), reset ? [1, 1] : [1])
      assert.ok(requests[1]! - requests[0]! >= expectedDelay)
      if (reset) assert.ok(requests[3]! - requests[2]! >= 2000)
    } finally {
      await session.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
      restoreLog()
    }
  })
}

for (const scenario of ['recover', 'cancel', 'too-long', 'non-retryable', 'exhausted', 'next-turn'] as const) {
  it(`real gateway: ${scenario}`, { timeout: 10000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-gateway-retry-'))
    const requests: Array<{ time: number; payload: Record<string, unknown> }> = []
    const events: PiAgentEvent[] = []
    const restoreLog = setLogSink(() => {})
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requests.push({ time: Date.now(), payload: JSON.parse(body) as Record<string, unknown> })
        const count = requests.length
        if ((scenario === 'recover' && count === 2) || (scenario === 'next-turn' && count === 3)) {
          success(response)
          return
        }
        response.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': scenario === 'cancel' ? '90' : scenario === 'too-long' || (scenario === 'next-turn' && count === 1) ? '301' : '0.05',
          ...(scenario === 'non-retryable' ? { 'x-should-retry': 'false' } : {}),
        })
        response.end(JSON.stringify({ error: { message: 'Too many requests', type: 'rate_limit_error' } }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const session = await new PiCodingAgentAdapter().createSession({
      runId: 'run-a', modelId: 'model-a', gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
      getAccessToken: async () => 'test-token', authorizeTool: async () => false,
      disableTools: true, mcpServers: [],
    })
    let cancellation: ReturnType<typeof setTimeout> | undefined
    session.subscribe(event => {
      events.push(event)
      if (scenario === 'cancel' && event.type === 'auto_retry_start') {
        cancellation = setTimeout(() => { void session.abort() }, 20)
      }
    })
    try {
      const started = Date.now()
      await session.prompt('Hello')
      if (scenario === 'next-turn') await session.prompt('Try again')
      assert.ok(Date.now() - started < 5000, 'must not add a second 2/4/8-second wait')
      const expected = scenario === 'recover' ? 2 : scenario === 'exhausted' ? 4 : scenario === 'next-turn' ? 3 : 1
      assert.equal(requests.length, expected)
      for (const { payload } of requests) {
        assert.equal(payload.max_tokens, 16384)
        assert.equal('max_completion_tokens' in payload, false)
        assert.deepEqual(payload.stream_options, { include_usage: true })
      }
      const retries = events.filter(event => event.type === 'auto_retry_start')
      assert.equal(retries.length, scenario === 'exhausted' ? 3 : ['recover', 'cancel', 'next-turn'].includes(scenario) ? 1 : 0)
      if (scenario === 'recover' || scenario === 'next-turn') {
        const start = scenario === 'next-turn' ? 1 : 0
        assert.ok(requests[start + 1]!.time - requests[start]!.time >= 50)
        assert.equal((retries[0]!.data as { delayMs: number }).delayMs, 50)
        const endings = events.filter(event => event.type === 'agent_end')
        assert.equal(endings.at(-1)?.failure, undefined)
        const finalMessage = events.filter(event => event.type === 'message_end').at(-1)?.data as { message: { usage: { input: number; output: number } } }
        assert.equal(finalMessage.message.usage.input, 20)
        assert.equal(finalMessage.message.usage.output, 2)
      }
      if (scenario === 'too-long') {
        assert.match(events.find(event => event.type === 'agent_end')?.failure ?? '', /300000/)
      }
      if (scenario === 'cancel') {
        assert.equal((retries[0]!.data as { delayMs: number }).delayMs, 90000)
      }
    } finally {
      clearTimeout(cancellation)
      await session.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
      restoreLog()
    }
  })
}
