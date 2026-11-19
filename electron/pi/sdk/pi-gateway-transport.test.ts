import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import type { PiAgentEvent, PiAgentSession } from './pi-agent-runtime'
import type { ModelTraceEntry } from '../../domain/model-trace'
import { setLogSink, type LogRecord } from '../../common/logger'
import { runtimeFeedback } from '../../errors/runtime-feedback'

it('records the underlying stream failure in console and model traces without changing SDK recovery', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-gateway-transport-'))
  const logs: LogRecord[] = []
  const traces: ModelTraceEntry[] = []
  const events: PiAgentEvent[] = []
  const restore = setLogSink(record => { logs.push(record) })
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requests++
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': `platform-${requests}` })
      response.write(`data: ${JSON.stringify({ id: 'reply', model: 'model-a', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`)
      if (requests === 1) { setTimeout(() => response.destroy(), 30); return }
      response.write(`data: ${JSON.stringify({ id: 'reply', model: 'model-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  let session: PiAgentSession | undefined
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    session = await new PiCodingAgentAdapter().createSession({
      runId: 'transport-run', taskTitle: 'Transport test', nodeTitle: 'Node test', modelId: 'model-a',
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, workspaceDir: root,
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
      getAccessToken: async () => 'transport-secret', authorizeTool: async () => false,
      disableTools: true, disableSkills: true, mcpServers: [],
      modelTrace: async entry => { traces.push(entry) },
    })
    session.subscribe(event => { events.push(event) })
    await session.prompt('Hello')
    assert.equal(requests, 2)
    const retries = events.filter(event => event.type === 'auto_retry_start')
    assert.equal(retries.length, 1)
    assert.equal((retries[0]!.data as { delayMs: number }).delayMs, 2000)
    assert.equal(events.filter(event => event.type === 'agent_end').at(-1)?.failure, undefined)
    const diagnostic = logs.filter(record => record.message === 'model transport interrupted')
    assert.equal(diagnostic.length, 1)
    assert.equal(diagnostic[0]!.fields.causeCode, 'UND_ERR_SOCKET')
    assert.equal(diagnostic[0]!.fields.causeMessage, 'other side closed')
    assert.equal(diagnostic[0]!.fields.platformRequestId, 'platform-1')
    assert.equal(diagnostic[0]!.fields.requestNumber, 1)
    assert.equal(diagnostic[0]!.fields.model, 'model-a')
    assert.ok(Number(diagnostic[0]!.fields.bytesReceived) > 0)
    const trace = traces.find(entry => entry.metrics?.['底层错误码'] === 'UND_ERR_SOCKET')
    assert.ok(trace)
    assert.equal(trace.metrics?.['平台请求标识'], 'platform-1')
    assert.equal(trace.metrics?.['是否主动取消'], '否')
    assert.equal(trace.requestNumber, 1)
    assert.equal(trace.requestId, diagnostic[0]!.fields.traceRequestId)
    assert.doesNotMatch(JSON.stringify(diagnostic), /transport-secret/)
    assert.doesNotMatch(JSON.stringify(trace), /transport-secret/)
  } finally {
    await session?.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    restore()
  }
})

for (const scenario of ['sse-error-done', 'sse-failed-eof', 'partial-eof', 'upstream-401', '429-concurrency', '429-quota', '429-balance'] as const) {
  it(`gateway SDK retains failure and partial output (${scenario})`, { timeout: 10000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-gateway-failure-'))
    const logs: LogRecord[] = []
    const restore = setLogSink(record => logs.push(record))
    const events: PiAgentEvent[] = []
    let requests = 0
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        requests++
        const headers = { 'x-request-id': 'sep-failure', 'x-compute-request-id': 'compute-failure', 'x-upstream-request-id': 'upstream-failure', 'x-sep-execution-id': 'execution-failure' }
        if (scenario === 'upstream-401') {
          response.writeHead(401, { ...headers, 'Content-Type': 'application/json', 'x-sep-error-source': 'upstream' })
          response.end(JSON.stringify({ error: { code: 'INVALID_API_KEY', message: 'Invalid credential transport-secret' } }))
          return
        }
        if (scenario === '429-concurrency' || scenario === '429-quota' || scenario === '429-balance') {
          response.writeHead(429, { ...headers, 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { code: {
            '429-concurrency': 'CONCURRENCY_LIMIT_EXCEEDED', '429-quota': 'INSUFFICIENT_QUOTA', '429-balance': 'INSUFFICIENT_FUNDS',
          }[scenario], message: 'Private provider message transport-secret',
          ...(scenario === '429-concurrency' ? { retryable: false } : {}) } }))
          return
        }
        response.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: 'reply', model: 'model-a', choices: [{ index: 0, delta: { role: 'assistant', content: 'kept partial output' }, finish_reason: null }] })}\n\n`)
        if (scenario !== 'partial-eof') response.write(`event: ${scenario === 'sse-error-done' ? 'error' : 'response.failed'}\ndata: ${JSON.stringify({ error: { code: scenario === 'sse-error-done' ? 'UPSTREAM_INCOMPLETE_STREAM' : 'UPSTREAM_INVALID_COMPLETION', message: 'Private provider message transport-secret' } })}\n\n`)
        response.end(scenario === 'sse-error-done' ? 'data: [DONE]\n\n' : '')
      })
    })
    let session: PiAgentSession | undefined
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      session = await new PiCodingAgentAdapter().createSession({
        runId: 'failure-run', modelId: 'model-a', gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
        workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
        getAccessToken: async () => 'transport-secret', authorizeTool: async () => false,
        disableTools: true, disableSkills: true, mcpServers: [],
      })
      session.subscribe(event => events.push(event))
      await session.prompt('Hello')
      const failure = events.filter(event => event.type === 'agent_end').at(-1)?.failure
      assert.ok(failure, 'the SDK must not mark a failed stream successful')
      const feedback = runtimeFeedback(new Error(failure))
      assert.equal(feedback.code, {
        'sse-error-done': 'MODEL_RESPONSE_INTERRUPTED', 'sse-failed-eof': 'MODEL_INVALID_COMPLETION',
        'partial-eof': 'MODEL_RESPONSE_INTERRUPTED', 'upstream-401': 'MODEL_PROVIDER_AUTH_FAILED',
        '429-concurrency': 'MODEL_CONCURRENCY_LIMIT', '429-quota': 'MODEL_QUOTA_EXCEEDED', '429-balance': 'MODEL_INSUFFICIENT_FUNDS',
      }[scenario])
      assert.doesNotMatch(feedback.message, /transport-secret|Private provider message/)
      assert.equal(requests, 1)
      if (scenario.startsWith('sse') || scenario === 'partial-eof') assert.ok(events.some(event => event.type === 'text_delta' && JSON.stringify(event.data).includes('kept partial output')))
      const record = logs.find(record => record.message === 'model gateway response failed')
      assert.ok(record)
      assert.match(JSON.stringify(record.fields.diagnostic), /execution-failure/)
      assert.doesNotMatch(JSON.stringify(logs), /transport-secret/)
    } finally {
      await session?.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
      restore()
    }
  })
}
