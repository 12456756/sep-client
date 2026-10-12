import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import type { PiAgentEvent } from './pi-agent-runtime'
import { setLogSink } from '../../common/logger'

function success(response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
  ]) {
    response.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'model-a', ...chunk })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

for (const scenario of ['recover', 'token-rotation', 'cancel', 'too-long', 'non-retryable', 'exhausted', 'next-turn'] as const) {
  it(`real gateway: ${scenario}`, { timeout: 10000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-gateway-retry-'))
    const requests: Array<{ time: number; payload: Record<string, unknown>; authorization: string | undefined }> = []
    let token = 'test-token'
    let tokenRotation: ReturnType<typeof setTimeout> | undefined
    const events: PiAgentEvent[] = []
    const restoreLog = setLogSink(() => {})
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requests.push({ time: Date.now(), payload: JSON.parse(body) as Record<string, unknown>, authorization: request.headers.authorization })
        const count = requests.length
        if ((['recover', 'token-rotation'].includes(scenario) && count === 2) || (scenario === 'next-turn' && count === 3)) {
          success(response)
          return
        }
        response.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': scenario === 'cancel' ? '90' : scenario === 'too-long' || (scenario === 'next-turn' && count === 1) ? '301' : scenario === 'token-rotation' ? '0.3' : '0.05',
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
      getAccessToken: async () => token, authorizeTool: async () => false,
      disableTools: true, mcpServers: [],
    })
    let cancellation: ReturnType<typeof setTimeout> | undefined
    session.subscribe(event => {
      events.push(event)
      if (scenario === 'cancel' && event.type === 'auto_retry_start') {
        cancellation = setTimeout(() => { void session.abort() }, 20)
      }
      if (scenario === 'token-rotation' && event.type === 'auto_retry_start') {
        tokenRotation = setTimeout(() => { token = 'rotated-token' }, 100)
      }
    })
    try {
      const started = Date.now()
      await session.prompt('Hello')
      if (scenario === 'next-turn') await session.prompt('Try again')
      assert.ok(Date.now() - started < 5000, 'must not add a second 2/4/8-second wait')
      const expected = ['recover', 'token-rotation'].includes(scenario) ? 2 : scenario === 'exhausted' ? 4 : scenario === 'next-turn' ? 3 : 1
      assert.equal(requests.length, expected)
      for (const { payload } of requests) {
        assert.equal(payload.max_tokens, 16384)
        assert.equal('max_completion_tokens' in payload, false)
        assert.deepEqual(payload.stream_options, { include_usage: true })
      }
      const retries = events.filter(event => event.type === 'auto_retry_start')
      assert.equal(retries.length, scenario === 'exhausted' ? 3 : ['recover', 'token-rotation', 'cancel', 'next-turn'].includes(scenario) ? 1 : 0)
      if (scenario === 'token-rotation') {
        assert.equal(requests[0]!.authorization, 'Bearer test-token')
        assert.equal(requests[1]!.authorization, 'Bearer rotated-token')
        assert.ok(requests[1]!.time - requests[0]!.time >= 300)
        assert.equal(events.filter(event => event.type === 'agent_end').at(-1)?.failure, undefined)
      }
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
      clearTimeout(tokenRotation)
      await session.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
      restoreLog()
    }
  })
}
