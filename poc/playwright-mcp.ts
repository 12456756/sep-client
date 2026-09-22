import { createRequire } from 'node:module'
/** Real Pi + pinned Playwright MCP + local Edge; no SEP or external website. */
import * as assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PiCodingAgentAdapter } from '../electron/pi/sdk/pi-coding-agent-adapter'
import { createPlaywrightMcpServer } from '../electron/pi/sdk/pi-playwright-mcp'
import type { PiAgentEvent, PiAgentSession } from '../electron/pi/sdk/pi-agent-runtime'

function chunk(response: ServerResponse, delta: unknown, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'browser-smoke', object: 'chat.completion.chunk', created: 1,
    model: 'test', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

const root = await mkdtemp(join(tmpdir(), 'sep-browser-smoke-'))
const events: PiAgentEvent[] = []
let requests = 0
let approvals = 0
let failure: unknown
let base = ''
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<title>SEP Browser Smoke</title><main>${'<p>Snapshot context verification paragraph 123.</p>'.repeat(400)}
        <label for="name">Name</label><input id="name"><button id="save" onclick="document.querySelector('#result').textContent='Saved: '+document.querySelector('#name').value">Save</button>
        <p id="result" role="status">Not saved</p></main>`)
      return
    }
    let body = ''
    for await (const part of request) body += String(part)
    const payload = JSON.parse(body) as { tools: Array<{ function: { name: string } }>; messages: Array<Record<string, unknown>> }
    requests++
    assert.ok(payload.tools.some(tool => tool.function.name === 'mcp__playwright__browser_navigate'))
    assert.ok(payload.messages.some(message => message.role === 'user'))
    const results = payload.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, requests - 1, 'Every tool result must remain in subsequent model context')
    let action: { name: string; input: Record<string, unknown> } | undefined
    if (requests === 1) action = { name: 'browser_navigate', input: { url: `${base}/page` } }
    if (requests === 2) action = { name: 'browser_snapshot', input: {} }
    if (requests === 3) {
      const snapshot = String(results[1]?.content)
      assert.ok(snapshot.length > 8192, 'Exercise the old result truncation boundary')
      assert.match(snapshot, /textbox "Name"/)
      assert.match(snapshot, /paragraph 123/)
      action = { name: 'browser_type', input: { target: '#name', text: 'SEP MCP 123' } }
    }
    if (requests === 4) action = { name: 'browser_click', input: { target: '#does-not-exist' } }
    if (requests === 5) {
      assert.match(String(results[3]?.content), /Error|Timeout|not found/i, 'The model receives the real browser error')
      action = { name: 'browser_click', input: { target: '#save' } }
    }
    if (requests === 6) action = { name: 'browser_snapshot', input: { target: '#result' } }
    if (requests === 7) assert.match(String(results[5]?.content), /Saved: SEP MCP 123/)
    assert.ok(requests <= 7, 'No unbounded tool retry loop')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (action) {
      chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: `browser-call-${requests}`, type: 'function',
        function: { name: `mcp__playwright__${action.name}`, arguments: JSON.stringify(action.input) } }] })
      chunk(response, {}, 'tool_calls')
    } else {
      chunk(response, { role: 'assistant', content: 'Browser workflow verified.' })
      chunk(response, {}, 'stop')
    }
    response.end('data: [DONE]\n\n')
  } catch (error) {
    failure = error
    response.writeHead(400).end('Local smoke assertion failed')
  }
})
let session: PiAgentSession | undefined
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  base = `http://127.0.0.1:${address.port}`
  const preset = createPlaywrightMcpServer()
  assert.equal(preset.transport.type, 'stdio')
  if (preset.transport.type !== 'stdio') throw new Error('Expected stdio preset')
  const electronPath = createRequire(import.meta.url)('electron') as string
  session = await new PiCodingAgentAdapter().createSession({
    runId: randomUUID(), workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
    modelId: 'test', gatewayUrl: `${base}/v1`, getAccessToken: async () => 'local-fixture-token',
    authorizeTool: async () => { approvals++; return true },
    mcpServers: [{ ...preset, transport: { ...preset.transport, command: electronPath,
      args: [...preset.transport.args!, '--headless'] } }],
  })
  session.subscribe(event => events.push(event))
  await session.prompt('Use the local test form and verify the saved result.')
  if (failure) throw failure
  assert.equal(requests, 7)
  assert.equal(approvals, 6)
  assert.equal(events.filter(event => event.type === 'tool_execution_end' && !(event.data as { success: boolean }).success).length, 1)
  assert.equal(events.some(event => event.type === 'auto_retry_start'), false)
  process.stdout.write('PASS: real browser navigation/input/click/snapshot, long context, error feedback, approvals and no automatic retries.\n')
} finally {
  await session?.dispose()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
