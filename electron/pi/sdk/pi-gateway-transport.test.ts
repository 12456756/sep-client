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
