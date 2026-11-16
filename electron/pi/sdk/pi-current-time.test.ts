import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_TIME_TOOL_NAME, currentTimeToolDefinition } from './pi-current-time'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import type { PiAgentEvent, PiAgentSession } from './pi-agent-runtime'

async function query(input: unknown, at = '2026-11-13T16:04:05.678Z') {
  const tool = currentTimeToolDefinition(() => Date.parse(at))
  return tool.execute('time', input, undefined, undefined, {} as never)
}

describe('current-time tool', () => {
  it('returns one consistent instant across the local date boundary', async () => {
    const result = await query({ timezone: 'Asia/Shanghai' })
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
      localTime: '2026-11-14T00:04:05+08:00', utcTime: '2026-11-13T16:04:05.678Z',
      timezone: 'Asia/Shanghai', weekday: 'Saturday', timestampMs: Date.parse('2026-11-13T16:04:05.678Z'), source: 'system-clock',
    })
  })

  it('defaults to the host timezone and supports UTC and fractional offsets', async () => {
    const host = await query({})
    assert.equal((host.details as { timezone: string }).timezone, new Intl.DateTimeFormat().resolvedOptions().timeZone)
    for (const [timezone, expected] of [['UTC', '2026-11-13T16:04:05+00:00'], ['Asia/Kathmandu', '2026-11-13T21:49:05+05:45']]) {
      const result = await query({ timezone })
      assert.equal((result.details as { localTime: string }).localTime, expected)
    }
  })

  it('uses the requested timezone DST offset at the measured instant', async () => {
    for (const [at, expected] of [['2026-07-01T00:00:00Z', '2026-06-30T20:00:00-04:00'], ['2026-12-01T00:00:00Z', '2026-11-30T19:00:00-05:00']]) {
      const result = await query({ timezone: 'America/New_York' }, at)
      assert.equal((result.details as { localTime: string }).localTime, expected)
    }
  })

  it('rejects invalid input and never silently replaces an invalid timezone', async () => {
    for (const input of [null, { timezone: 8 }, { timezone: '' }, { timezone: ' '.repeat(3) }, { unexpected: true }]) {
      await assert.rejects(query(input), /Invalid time query/)
    }
    await assert.rejects(query({ timezone: 'Mars/Olympus' }), /Invalid timezone/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(currentTimeToolDefinition().execute('time', {}, controller.signal, undefined, {} as never), /abort/i)
  })
})

function chunk(response: ServerResponse, delta: unknown, finishReason: string): void {
  response.write(`data: ${JSON.stringify({ id: 'time-test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

describe('current-time tool in a real Pi session', () => {
  for (const scenario of ['read-only', 'workspace-edit', 'full-local', 'planner', 'disabled', 'invalid-timezone'] as const) {
    it(`${scenario}: registration, execution and model result`, { timeout: 15_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'sep-time-'))
      const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<Record<string, unknown>> }> = []
      const events: PiAgentEvent[] = []
      let approvals = 0
      const disabled = scenario === 'planner' || scenario === 'disabled'
      const server = createServer(async (request, response) => {
        let body = ''
        for await (const part of request) body += String(part)
        requests.push(JSON.parse(body))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (requests.length === 1 && !disabled) {
          chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-time', type: 'function', function: {
            name: CURRENT_TIME_TOOL_NAME, arguments: JSON.stringify({ timezone: scenario === 'invalid-timezone' ? 'Mars/Olympus' : 'Asia/Shanghai' }),
          } }] }, 'tool_calls')
        } else chunk(response, { role: 'assistant', content: 'Time query completed.' }, 'stop')
        response.end('data: [DONE]\n\n')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      let session: PiAgentSession | undefined
      try {
        session = await new PiCodingAgentAdapter().createSession({
          runId: `time-${scenario}`, modelId: 'test', gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
          workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
          getAccessToken: async () => 'fake-token', authorizeTool: async () => { approvals++; return false },
          disableTools: scenario === 'disabled', disableSkills: true, mcpServers: [],
          toolPolicy: { preset: scenario === 'workspace-edit' || scenario === 'full-local' ? scenario : 'read-only',
            allowedTools: scenario === 'planner' ? [] : ['read'], allowedPaths: [], deniedPaths: [],
            commandPolicy: 'disabled', approvalMode: 'confirm-each', workspaceDir: root },
        })
        session.subscribe(event => events.push(event))
        const before = Date.now()
        await session.prompt('What time is it in Shanghai?')
        const names = requests[0]!.tools?.map(tool => tool.function.name) ?? []
        assert.equal(names.includes(CURRENT_TIME_TOOL_NAME), !disabled)
        assert.equal(approvals, 0)
        if (disabled) assert.equal(events.some(event => event.type === 'tool_execution_start'), false)
        else {
          assert.equal(requests.length, 2)
          const result = requests[1]!.messages.find(message => message.role === 'tool')
          assert.equal(result?.tool_call_id, 'call-time')
          if (scenario === 'invalid-timezone') assert.match(String(result?.content), /Invalid timezone/)
          else {
            const value = JSON.parse(String(result?.content))
            assert.equal(value.timezone, 'Asia/Shanghai')
            assert.ok(value.timestampMs >= before && value.timestampMs <= Date.now())
          }
          const end = events.find(event => event.type === 'tool_execution_end')
          assert.ok(end)
          assert.equal((end.data as { success: boolean }).success, scenario !== 'invalid-timezone')
        }
      } finally {
        await session?.dispose()
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  }
})
