import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { getEventListeners } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpRuntime, mcpToolName } from './pi-mcp-client'
import { loadMcpServers, parseMcpServers } from './pi-mcp-config'
import type { McpServerConfig } from './pi-agent-runtime'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

interface RpcRequest { id: number; method: string; params?: Record<string, unknown> }
async function serve(handler: (request: RpcRequest) => unknown) {
  const methods: string[] = []
  let deletes = 0
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') { deletes++; response.writeHead(200).end(); return }
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let body = ''
    for await (const part of request) body += String(part)
    const rpc = JSON.parse(body) as RpcRequest
    methods.push(rpc.method)
    if (rpc.id === undefined) { response.writeHead(202).end(); return }
    const result = rpc.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
      : await handler(rpc)
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}/mcp`, methods, deletes: () => deletes }
}
const tool = { name: 'search', description: 'Search documents', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } }
function config(url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: 'docs', transport: { type: 'streamable-http', url }, enabledTools: ['search'], ...extra }
}
async function runtime(servers: McpServerConfig[]) {
  const result = await createMcpRuntime(servers, process.cwd())
  cleanups.push(() => result.dispose())
  return result
}

describe('MCP configuration', () => {
  it('is disabled without configuration; rejects unsafe or ambiguous configuration', async () => {
    assert.deepEqual(await loadMcpServers(undefined), [])
    assert.deepEqual(parseMcpServers([]), [])
    for (const servers of [
      [config('http://example.com/mcp')],
      [config('https://user:password@example.com/mcp')],
      [config('https://example.com/mcp', { name: '../bad' })],
      [config('https://example.com/mcp', { autoApproveTools: ['unlisted'] })],
      [config('https://example.com/mcp'), config('https://example.com/other')],
    ]) assert.throws(() => parseMcpServers(servers), /MCP configuration/)
  })
  it('reads only an explicitly provided absolute configuration path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-mcp-config-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'mcp.json')
    await writeFile(path, JSON.stringify({ servers: [config('https://example.com/mcp')] }))
    assert.equal((await loadMcpServers(path))[0]?.name, 'docs')
    await assert.rejects(loadMcpServers('mcp.json'), /absolute/)
  })
})

describe('MCP tool bridge', () => {
  it('preserves long snapshots and numeric refs while still redacting credentials', async () => {
    const text = 'element ref=e1 value=123\n'.repeat(700) + 'LAST_ELEMENT Bearer private-test-token'
    const server = await serve(request => request.method === 'tools/list'
      ? { tools: [tool] } : { content: [{ type: 'text', text }] })
    const bridge = await runtime([config(server.url)])
    const result = await bridge.tools[0]!.execute('snapshot', {}, undefined)
    assert.match(result.content[0]!.text, /LAST_ELEMENT/)
    assert.match(result.content[0]!.text, /ref=e1 value=123/)
    assert.ok(!result.content[0]!.text.includes('private-test-token'))
  })

  it('still bounds oversized model results with an explicit truncation marker', async () => {
    const server = await serve(request => request.method === 'tools/list'
      ? { tools: [tool] } : { content: [{ type: 'text', text: 'x'.repeat(130_000) }] })
    const bridge = await runtime([config(server.url)])
    const result = await bridge.tools[0]!.execute('snapshot', {}, undefined)
    assert.equal(result.content[0]!.text, 'x'.repeat(128_000) + '...[truncated]')
  })

  it('does not redact Electron launch mode as a secret in tool results', async () => {
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        const result = m.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } }
          : m.method === 'tools/list' ? { tools: [${JSON.stringify(tool)}] }
          : { content: [{ type: 'text', text: 'button ref=e1 count=123' }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
    `
    const bridge = await runtime([{ name: 'local', enabledTools: ['search'], transport: {
      type: 'stdio', command: process.execPath, args: ['-e', script], env: { ELECTRON_RUN_AS_NODE: '1' },
    } }])
    const result = await bridge.tools[0]!.execute('snapshot', {}, undefined)
    assert.equal(result.content[0]!.text, 'button ref=e1 count=123')
  })

  it('discovers paginated allowlisted tools, preserves schemas and routes names/arguments', async () => {
    let received: unknown
    const server = await serve(request => {
      if (request.method === 'tools/list') return request.params?.cursor
        ? { tools: [tool] }
        : { tools: [{ ...tool, name: 'hidden' }], nextCursor: 'page-2' }
      received = request.params
      return { content: [{ type: 'text', text: 'found report.txt' }], structuredContent: { count: 1 } }
    })
    const bridge = await runtime([config(server.url)])
    assert.deepEqual(bridge.tools.map(item => item.name), ['mcp__docs__search'])
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.tools[0]!.parameters)), tool.inputSchema)
    assert.equal(bridge.permissions.get('mcp__docs__search'), 'confirm-each')
    const result = await bridge.tools[0]!.execute('call-1', { query: 'report' }, undefined)
    assert.deepEqual(received, { name: 'search', arguments: { query: 'report' } })
    assert.match(result.content.map(item => item.text).join(' '), /report.txt/)
    assert.match(result.content.map(item => item.text).join(' '), /"count":1/)
    assert.equal(result.details.isError, false)
    await bridge.dispose()
    await bridge.dispose()
    assert.equal(server.deletes(), 1)
  })
  it('returns business errors to the model and never retries a tool call', async () => {
    const server = await serve(request => request.method === 'tools/list' ? { tools: [tool] } : {
      isError: true, content: [{ type: 'text', text: 'Invalid query: provide a filename' }],
    })
    const bridge = await runtime([config(server.url)])
    const result = await bridge.tools[0]!.execute('call-1', { query: '' }, undefined)
    assert.equal(result.details.isError, true)
    assert.match(result.content[0]!.text, /provide a filename/)
    assert.equal(server.methods.filter(method => method === 'tools/call').length, 1)
  })
  it('does not leak configured credentials in tool errors', async () => {
    const secret = 'private-test-credential'
    const server = await serve(request => request.method === 'tools/list' ? { tools: [tool] } : {
      content: [{ type: 'text', text: `Rejected credential ${secret}` }], isError: true,
    })
    const headerCases: Record<string, string>[] = [{ 'x-api-key': secret }, { authorization: `Bearer ${secret}` }]
    for (const headers of headerCases) {
      const bridge = await runtime([config(server.url, { transport: { type: 'streamable-http', url: server.url, headers } })])
      const result = await bridge.tools[0]!.execute('call-1', {}, undefined)
      assert.equal(JSON.stringify(result).includes(secret), false)
      assert.match(result.content[0]!.text, /redacted/)
    }
  })
  it('disables unconfigured tools and refuses missing tools rather than silently granting access', async () => {
    const server = await serve(() => ({ tools: [tool] }))
    assert.equal((await runtime([config(server.url, { enabledTools: [] })])).tools.length, 0)
    assert.deepEqual(server.methods, [])
    await assert.rejects(runtime([config(server.url, { enabledTools: ['missing'] })]), /missing/)
    assert.equal(server.deletes(), 1)
  })
  it('separates names across servers and permits only explicit auto-approval', async () => {
    const first = await serve(() => ({ tools: [tool] }))
    const second = await serve(() => ({ tools: [tool] }))
    const bridge = await runtime([config(first.url), config(second.url, { name: 'other', autoApproveTools: ['search'] })])
    assert.deepEqual(bridge.tools.map(item => item.name), ['mcp__docs__search', 'mcp__other__search'])
    assert.equal(bridge.permissions.get('mcp__other__search'), 'auto-approve')
  })
  it('forwards cancellation and reports unsupported result types without pretending success', async () => {
    const server = await serve(request => request.method === 'tools/list' ? { tools: [tool] } : {
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const bridge = await runtime([config(server.url)])
    const result = await bridge.tools[0]!.execute('call-1', {}, undefined)
    assert.equal(result.details.isError, true)
    assert.match(result.content[0]!.text, /unsupported.*image/i)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await bridge.tools[0]!.execute('call-2', {}, controller.signal)
    assert.equal(cancelled.details.isError, true)
    assert.match(cancelled.content[0]!.text, /cancel/i)
    assert.equal(server.methods.filter(method => method === 'tools/call').length, 1)
  })
  it('cleans up abort listeners between repeated calls on the same session signal', async () => {
    const server = await serve(request => request.method === 'tools/list' ? { tools: [tool] } : { content: [] })
    const bridge = await runtime([config(server.url)])
    const controller = new AbortController()
    for (let index = 0; index < 12; index++) {
      const result = await bridge.tools[0]!.execute(`call-${index}`, { query: 'report' }, controller.signal)
      assert.equal(result.details.isError, false)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    }
  })
  it('bounds stuck calls and sends cancellation instead of retrying', async () => {
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const server = await serve(request => {
      if (request.method === 'tools/list') return { tools: [tool] }
      started()
      return new Promise(() => {})
    })
    const bridge = await runtime([config(server.url, { timeoutMs: 250 })])
    const controller = new AbortController()
    const pending = bridge.tools[0]!.execute('call-1', {}, controller.signal)
    await start
    controller.abort()
    assert.match((await pending).content[0]!.text, /cancel/i)
    const timedOut = await bridge.tools[0]!.execute('call-2', {}, undefined)
    assert.equal(timedOut.details.isError, true)
    assert.match(timedOut.content[0]!.text, /timed out/i)
    assert.equal(server.methods.filter(method => method === 'tools/call').length, 2)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
  it('returns malformed protocol results as actionable errors', async () => {
    const server = await serve(request => request.method === 'tools/list' ? { tools: [tool] } : { content: 'not-an-array' })
    const bridge = await runtime([config(server.url)])
    const result = await bridge.tools[0]!.execute('call-1', {}, undefined)
    assert.equal(result.details.isError, true)
    assert.match(result.content[0]!.text, /MCP tool failed/)
    assert.equal(server.methods.filter(method => method === 'tools/call').length, 1)
  })
  it('closes all connected servers after a later discovery failure', async () => {
    const first = await serve(() => ({ tools: [tool] }))
    const second = await serve(() => ({ tools: [tool], nextCursor: 'repeated' }))
    await assert.rejects(runtime([config(first.url), config(second.url, { name: 'broken' })]), /repeated.*cursor/)
    assert.equal(first.deletes(), 1)
    assert.equal(second.deletes(), 1)
  })
  it('rejects duplicate tool mappings and makes long/unsafe names provider-compatible', async () => {
    const server = await serve(() => ({ tools: [tool, tool] }))
    await assert.rejects(runtime([config(server.url)]), /collision/)
    const names = ['a.b', 'a/b', 'a'.repeat(120)].map(name => mcpToolName('docs', name))
    assert.equal(new Set(names).size, 3)
    for (const name of names) { assert.ok(name.length <= 64); assert.match(name, /^[a-zA-Z0-9_-]+$/) }
  })
  it('supports real stdio initialization, calls and process cleanup', async () => {
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        const result = m.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : m.method === 'tools/list' ? { tools: [${JSON.stringify(tool)}] }
          : { content: [{ type: 'text', text: 'stdio result: ' + m.params.arguments.query }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
      rl.on('close', () => process.exit(0));
    `
    const bridge = await runtime([{ name: 'local', enabledTools: ['search'], transport: { type: 'stdio', command: process.execPath, args: ['-e', script] } }])
    const result = await bridge.tools[0]!.execute('call-1', { query: 'hello' }, undefined)
    assert.equal(result.content[0]!.text, 'stdio result: hello')
    await bridge.dispose()
  })
})
