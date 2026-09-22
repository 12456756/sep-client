import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import { PiTaskWorker } from './pi-task-worker'
import type { PiAgentEvent, PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'

function chunk(response: ServerResponse, delta: unknown, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

describe('MCP extension with real Pi session', () => {
  for (const scenario of ['success', 'business-error', 'denied', 'auto-approve', 'disabled', 'planner', 'host-config'] as const) {
    it(`${scenario}: advertisements, approval and subsequent model context`, { timeout: 15_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'sep-pi-mcp-'))
      const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<Record<string, unknown>> }> = []
      let calls = 0
      let initialized = 0
      let terminated = 0
      let approvals = 0
      const events: PiAgentEvent[] = []
      const name = 'mcp__docs__search'
      const server = createServer(async (request, response) => {
        if (request.method === 'DELETE') { terminated++; response.writeHead(200).end(); return }
        if (request.method !== 'POST') { response.writeHead(405).end(); return }
        let body = ''
        for await (const part of request) body += String(part)
        const parsed = JSON.parse(body)
        if (request.url === '/mcp') {
          if (parsed.id === undefined) { response.writeHead(202).end(); return }
          let result: unknown
          if (parsed.method === 'initialize') {
            initialized++
            result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          } else if (parsed.method === 'tools/list') {
            result = { tools: [{ name: 'search', description: 'Search docs', inputSchema: {
              type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
            }, annotations: { readOnlyHint: true } }] }
          } else {
            calls++
            assert.deepEqual(parsed.params, { name: 'search', arguments: { query: 'report' } })
            result = {
              content: [{ type: 'text', text: scenario === 'business-error' ? 'Invalid query: choose an existing directory' : 'report.txt found' }],
              isError: scenario === 'business-error',
            }
          }
          response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture' })
          response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
          return
        }
        requests.push(parsed)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (requests.length === 1 && scenario !== 'disabled' && scenario !== 'planner') {
          chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-mcp', type: 'function', function: { name, arguments: '{"query":"report"}' } }] })
          chunk(response, {}, 'tool_calls')
        } else {
          chunk(response, { role: 'assistant', content: 'Finished based on the tool result.' })
          chunk(response, {}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const base = `http://127.0.0.1:${address.port}`
      const config: PiAgentSessionConfig = {
        runId: `mcp-${scenario}`, workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
        modelId: 'test', gatewayUrl: `${base}/v1`, getAccessToken: async () => 'fake-token',
        authorizeTool: async request => { approvals++; assert.equal(request.toolName, name); return scenario !== 'denied' },
        toolPolicy: { allowedTools: scenario === 'planner' ? [] : ['ls'], allowedPaths: [], deniedPaths: [], commandPolicy: 'disabled', approvalMode: 'auto-approve', workspaceDir: root },
        disableTools: scenario === 'disabled',
        mcpServers: [{ name: 'docs', transport: { type: 'streamable-http', url: `${base}/mcp` }, enabledTools: ['search'], autoApproveTools: scenario === 'auto-approve' ? ['search'] : [] }],
      }
      let session: PiAgentSession | undefined
      let worker: PiTaskWorker | undefined
      let sessionFile: string | null = null
      const previousConfig = process.env.SEP_MCP_CONFIG
      try {
        if (scenario === 'host-config') {
          const file = join(root, 'mcp.json')
          await writeFile(file, JSON.stringify({ servers: config.mcpServers }))
          process.env.SEP_MCP_CONFIG = file
          worker = new PiTaskWorker({
            context: {
              taskId: 'host-task', subscriptionId: 'test-employee', runId: config.runId,
              modelId: config.modelId, gatewayUrl: config.gatewayUrl, workspaceDir: root,
              agentDir: config.agentDir, sessionDir: config.sessionDir, toolPolicy: config.toolPolicy,
            },
            getRefreshToken: () => 'fake-refresh', onAuthenticationRequired: () => {},
            createTokenManager: () => ({ initialize: async () => {}, getValidToken: config.getAccessToken, stop: () => {} }),
            onApprovalRequest: config.authorizeTool,
            onEvent: event => { events.push(event) },
            onSessionCreated: created => { sessionFile = created.sessionFile },
          })
          await worker.run('Search for report')
        } else {
          session = await new PiCodingAgentAdapter().createSession(config)
          session.subscribe(event => events.push(event))
          await session.prompt('Search for report')
          sessionFile = session.sessionFile
        }
        const names = requests[0]!.tools?.map(tool => tool.function.name) ?? []
        if (scenario === 'disabled' || scenario === 'planner') {
          assert.equal(names.includes(name), false)
          assert.equal(initialized, 0)
          assert.equal(calls, 0)
        } else {
          assert.deepEqual(names, ['ls', name])
          assert.equal(approvals, scenario === 'auto-approve' ? 0 : 1)
          assert.equal(calls, scenario === 'denied' ? 0 : 1)
          assert.equal(requests.length, 2)
          const result = requests[1]!.messages.find(message => message.role === 'tool')
          assert.equal(result?.tool_call_id, 'call-mcp')
          assert.match(String(result?.content), scenario === 'denied' ? /denied/i : scenario === 'business-error' ? /choose an existing directory/ : /report.txt/)
          const end = events.find(event => event.type === 'tool_execution_end')
          assert.ok(end)
          assert.equal((end.data as { success: boolean }).success, scenario !== 'business-error' && scenario !== 'denied')
          assert.equal(events.some(event => event.type === 'auto_retry_start'), false)
          const sessionText = await import('node:fs/promises').then(fs => fs.readFile(sessionFile!, 'utf8'))
          assert.match(sessionText, /mcp__docs__search/)
        }
        await session?.dispose()
        await session?.dispose()
        await worker?.dispose()
        await worker?.dispose()
        assert.equal(terminated, initialized)
      } finally {
        if (previousConfig === undefined) delete process.env.SEP_MCP_CONFIG
        else process.env.SEP_MCP_CONFIG = previousConfig
        await worker?.dispose()
        await session?.dispose()
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it('has an actual host configuration entry point, not an unused session field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-mcp-host-'))
    const previous = process.env.SEP_MCP_CONFIG
    try {
      const file = join(root, 'mcp.json')
      await writeFile(file, '{"servers":[{"name":"invalid"}]}')
      process.env.SEP_MCP_CONFIG = file
      await assert.rejects(new PiCodingAgentAdapter().createSession({
        runId: 'host-config', workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
        modelId: 'test', gatewayUrl: 'http://127.0.0.1:1/v1', getAccessToken: async () => 'fake', authorizeTool: async () => false,
      }), /MCP configuration/)
    } finally {
      if (previous === undefined) delete process.env.SEP_MCP_CONFIG
      else process.env.SEP_MCP_CONFIG = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})
