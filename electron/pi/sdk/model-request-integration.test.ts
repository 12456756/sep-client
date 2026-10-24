import { afterEach, describe, it, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { PiCodingAgentAdapter } from './pi-coding-agent-adapter'
import type { PiAgentSession, PiAgentSessionConfig } from './pi-agent-runtime'
import { advanceModelRequestProgress, type ModelRequestKind, type ModelRequestProgress } from '../../domain/model-request-progress'
import { setLogLevel, setLogSink, type LogRecord } from '../../common/logger'

import { translatePiNativeSystemPrompt } from './pi-native-system-prompt'

let restoreLog: (() => void) | undefined
afterEach(() => { restoreLog?.(); restoreLog = undefined; setLogLevel('debug') })

interface RequestBody { messages: Array<{ role: string; content: string }>; max_tokens?: number; max_completion_tokens?: number }

const gatewayRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().nullable(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  }).strict()),
  stream: z.literal(true),
  stream_options: z.object({ include_usage: z.literal(true) }).strict(),
  temperature: z.number().optional(),
  tools: z.array(z.unknown()).optional(),
}).strict()

function answer(response: ServerResponse, text: string, promptTokens = 10): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  chunk(response, { role: 'assistant', content: text })
  chunk(response, {}, 'stop')
  response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } })}\n\ndata: [DONE]\n\n`)
}

function chunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

async function fixture(t: TestContext, handle: (body: RequestBody, response: ServerResponse, root: string) => void,
  persist?: PiAgentSessionConfig['onModelRequest'], overrides: Partial<PiAgentSessionConfig> = {}) {
  const logs: LogRecord[] = []
  restoreLog = setLogSink(record => { logs.push(record) })
  const root = await mkdtemp(join(tmpdir(), 'sep-model-awareness-'))
  const requests: RequestBody[] = []
  const payloadErrors: string[] = []
  const kinds: ModelRequestKind[] = []
  let progress: ModelRequestProgress | undefined
  const resources: { session?: PiAgentSession } = {}
  const server = createServer((request, response) => {
    request.setEncoding('utf8')
    let body = ''
    request.on('data', data => { body += String(data) })
    request.on('end', () => {
      const parsed = JSON.parse(body) as RequestBody
      requests.push(parsed)
      response.setHeader('x-request-id', `platform-test-${requests.length}`)
      const validated = gatewayRequestSchema.safeParse(parsed)
      if (!validated.success) {
        payloadErrors.push(validated.error.message)
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Invalid gateway parameters', code: 'INVALID_PARAMETER' } }))
        return
      }
      handle(parsed, response, root)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await resources.session?.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const config: PiAgentSessionConfig = {
    runId: 'run', modelId: 'model', gatewayUrl: `http://127.0.0.1:${address.port}/v1`, workspaceDir: root,
    agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), mcpServers: [],
    fixedSystemPrompt: 'Fixed node contract: finish all required work before final JSON.',
    getAccessToken: async () => 'test-token', authorizeTool: async () => true,
    onModelRequest: async kind => {
      kinds.push(kind)
      progress = persist ? await persist(kind) : advanceModelRequestProgress(progress, kind)
      return progress
    },
    ...overrides,
  }
  let session = await new PiCodingAgentAdapter().createSession(config)
  resources.session = session
  return { root, get session() { return session }, requests, payloadErrors, kinds, logs, progress: () => progress,
    reopen: async () => {
      const sessionFile = session.sessionFile!
      await session.dispose()
      session = await new PiCodingAgentAdapter().createSession({ ...config, resumeSessionFile: sessionFile })
      resources.session = session
    },
  }
}

describe('real SDK model request awareness', () => {
  it('retains the native Chinese system and node contract on start, tool continuation, retry, correction and resume', { timeout: 30_000 }, async t => {
    let calls = 0
    const f = await fixture(t, (_body, response) => {
      if (++calls === 1) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'read-input', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'input.txt' }) } }] })
        chunk(response, {}, 'tool_calls')
        response.end('data: [DONE]\n\n')
      } else if (calls === 2) {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' })
        response.end(JSON.stringify({ error: { message: 'Try again', type: 'server_error' } }))
      } else answer(response, 'Result')
    }, undefined, {
      systemPrompt: 'OLD_EMPLOYEE_OVERRIDE', employeeProfile: { name: '研究员工', description: '研究职责' }, additionalSkillPaths: [],
      useNativeSystemPrompt: true, modelRequestAwareness: false,
      transformSystemPrompt: translatePiNativeSystemPrompt,
      fixedSystemPrompt: '# 硅基员工节点执行要求\n员工：研究员工\n节点：node-a\n知识库：实际检索片段',
    })
    await writeFile(join(f.root, 'input.txt'), 'Actual data')
    await f.session.prompt('请开始执行当前节点。')
    await f.session.prompt('交付校验失败，请修正。')
    await writeFile(join(f.root, 'agent', 'SYSTEM.md'), 'OLD_DISCOVERED_OVERRIDE')
    await f.reopen()
    await f.session.prompt('继续完成未完成工作。')
    assert.deepEqual(f.kinds, ['execution', 'execution', 'retry', 'execution', 'execution'])
    assert.equal(f.progress()?.requestAttempts, 5)
    assert.equal(f.progress()?.executionRetries, 1)
    for (const request of f.requests) {
      const system = request.messages.find(message => message.role === 'system')!.content
      assert.ok(system.startsWith('你运行在 Pi 中。你通过读取文件、执行命令、编辑代码和创建新文件来帮助用户。'))
      assert.equal(system.split('# 硅基员工节点执行要求').length, 2)
      for (const text of ['可用工具：', '主要文档：', '附加文档：', '示例：', '当前工作目录：', f.root.replace(/\\/g, '/'), '研究员工', 'node-a', '实际检索片段']) assert.ok(system.includes(text), text)
      assert.doesNotMatch(system, /OLD_EMPLOYEE_OVERRIDE|OLD_DISCOVERED_OVERRIDE|employee_profile|responsibility_judgment|当前节点执行情况|自动编排规划 Agent|expert coding assistant/)
    }
    assert.deepEqual(f.payloadErrors, [])
  })

  it('passes recovered local text to the next model request without rerunning tools', { timeout: 30_000 }, async t => {
    let calls = 0
    const f = await fixture(t, (_body, response) => {
      if (++calls > 1) { answer(response, 'done'); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'read-legacy', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'legacy.txt' }) } }] })
      chunk(response, {}, 'tool_calls')
      response.end('data: [DONE]\n\n')
    })
    const text = '\u4e2d\u6587\u6d4b\u8bd5'.repeat(10)
    await writeFile(join(f.root, 'legacy.txt'), Buffer.from('d6d0cec4b2e2cad4'.repeat(10), 'hex'))
    await f.session.prompt('Read legacy.txt once.')
    assert.equal(calls, 2)
    assert.equal(f.requests[1].messages.find(message => message.role === 'tool')?.content, text)
    assert.deepEqual(f.payloadErrors, [])
  })

  it('keeps encoding overrides behind approvals and disables them for planners', { timeout: 30_000 }, async t => {
    let approvals = 0
    let calls = 0
    const f = await fixture(t, (_body, response) => {
      if (++calls > 1) { answer(response, 'denied'); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'denied-bash', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo should-not-run' }) } }] })
      chunk(response, {}, 'tool_calls')
      response.end('data: [DONE]\n\n')
    }, undefined, { authorizeTool: async () => { approvals++; return false } })
    await f.session.prompt('Run command.')
    assert.equal(approvals, 1)
    assert.match(f.requests[1].messages.find(message => message.role === 'tool')?.content ?? '', /denied/i)
    const planner = await fixture(t, (body, response) => {
      assert.equal('tools' in body, false)
      answer(response, 'plan')
    }, undefined, { disableTools: true })
    await planner.session.prompt('Plan only.')
  })

  for (const overflow of [false, true]) {
    it(`normalizes ${overflow ? 'overflow recovery' : 'threshold'} compaction requests for a strict gateway and continues execution`, { timeout: 30_000 }, async t => {
      let executionRequests = 0
      let summaryRequests = 0
      const compactions: Array<{ errorMessage?: string; result?: { summary: string } }> = []
      const f = await fixture(t, (body, response) => {
        const isExecution = body.messages.some(message => message.role === 'system' && message.content.includes('Fixed node contract'))
        if (!isExecution) {
          summaryRequests++
          answer(response, 'Summary: preserve the completed research and create the final document.')
        } else if (++executionRequests === 1) {
          answer(response, 'Earlier useful findings. '.repeat(5_000))
        } else if (executionRequests === 2 && overflow) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }))
        } else answer(response, '{"nodeId":"node-1","summary":"Done","finalDeliverables":[]}', executionRequests === 2 ? 120_000 : 10)
      })
      f.session.subscribe(event => {
        if (event.type === 'compaction_end') compactions.push(event.data as typeof compactions[number])
      })
      await f.session.prompt('Gather useful findings.')
      await f.session.prompt('Complete the required document.')
      if (!overflow) await f.session.prompt('Continue after compaction.')
      assert.deepEqual(f.payloadErrors, [], 'Every ordinary and compaction request must satisfy the gateway contract')
      assert.ok(summaryRequests > 0)
      assert.ok(compactions.length > 0)
      for (const outcome of compactions) {
        assert.equal(outcome.errorMessage, undefined)
        assert.match(outcome.result?.summary ?? '', /preserve the completed research/)
      }
      const finalRequest = f.requests.at(-1)!
      for (const request of f.requests) {
        assert.equal('max_tokens' in request, false, 'Execution and compaction must use the platform budget')
        assert.equal('max_completion_tokens' in request, false)
      }
      assert.match(finalRequest.messages.find(message => message.role === 'system')!.content, /Fixed node contract/)
      assert.ok(finalRequest.messages.some(message => message.content?.includes('preserve the completed research')))
      assert.equal(f.progress()?.executionRounds, overflow ? 2 : 3)
      assert.equal(f.progress()?.compactionAttempts, summaryRequests)
      assert.ok(f.logs.some(record => record.message === 'model response content' && String(record.fields.content).includes('"nodeId":"node-1"')))
    })
  }

  it('logs readable request and completed response records with matching IDs and safe usage values', { timeout: 30_000 }, async t => {
    const f = await fixture(t, (_body, response) => answer(response, 'First result\nSecond result\nBearer response-secret'))
    await f.session.prompt('First requirement\nSecond requirement\nBearer request-secret')
    const overview = f.logs.find(record => record.message === 'model request overview')!
    assert.equal(overview.level, 'info')
    assert.equal(overview.fields.runId, 'run')
    assert.equal(overview.fields.outputLimit, undefined)
    assert.equal(overview.fields.outputBudgetSource, 'platform')
    assert.equal(overview.fields.includeUsage, true)
    const requestId = overview.fields.requestId
    const user = f.logs.find(record => record.message === 'model input added: user')!
    assert.equal(user.fields.content, 'First requirement\nSecond requirement\nBearer [redacted]')
    assert.equal(user.fields.runId, 'run')
    assert.equal(user.fields.displayTitle, '模型输入（用户消息）')
    assert.equal(user.fields.inputSequence, overview.fields.latestInputSequence)
    const completed = f.logs.find(record => record.message === 'model response completed')!
    assert.equal(completed.fields.runId, 'run')
    assert.equal(completed.fields.requestId, requestId)
    assert.equal(completed.fields.stopReason, 'stop')
    assert.equal(completed.fields.platformRequestId, 'platform-test-1')
    assert.equal(completed.fields.providerStatus, 200)
    assert.deepEqual(completed.fields.usage, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 })
    const body = f.logs.find(record => record.message === 'model response content')!
    assert.equal(body.fields.content, 'First result\nSecond result\nBearer [redacted]')
    assert.equal(body.fields.displayTitle, '模型输出')
    assert.equal(body.fields.requestId, requestId)
    assert.equal(f.requests[0]!.messages.at(-1)!.content, 'First requirement\nSecond requirement\nBearer request-secret')
    assert.equal(f.logs.some(record => 'context' in record.fields), false)
    assert.doesNotMatch(JSON.stringify(f.logs), /request-secret|response-secret/)
    assert.equal(f.logs.some(record => record.message === 'provider response received'), false)
    assert.equal(f.logs.some(record => record.message === 'model request tool list'), false)
  })

  it('shows low-level gateway diagnostics only at trace level', { timeout: 30_000 }, async t => {
    setLogLevel('trace')
    const f = await fixture(t, (_body, response) => answer(response, 'Visible response'))
    await f.session.prompt('New requirement')
    assert.ok(f.logs.some(record => record.message === 'provider response received' && record.level === 'trace'))
    assert.ok(f.logs.some(record => record.message === 'model request tool list' && record.level === 'trace'))
    assert.ok(f.logs.some(record => record.message === 'model response content' && record.fields.content === 'Visible response'))
  })

  it('logs assembled thinking once per response without accumulating history', { timeout: 30_000 }, async t => {
    let attempt = 0
    const f = await fixture(t, (_body, response) => {
      if (++attempt > 1) return answer(response, 'Final response')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      chunk(response, { role: 'assistant', reasoning_content: '中文' })
      chunk(response, { reasoning_content: 'private-thinking-marker' })
      chunk(response, {}, 'stop')
      response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 } })}\n\ndata: [DONE]\n\n`)
    })
    await f.session.prompt('First requirement')
    await f.session.prompt('Continue the work')
    const completed = f.logs.filter(record => record.message === 'model response completed')
    assert.equal(completed.length, 2)
    assert.equal(completed[0]!.fields.thinkingLength, 25)
    assert.equal(completed[0]!.fields.estimatedThinkingTokens, 9)
    assert.equal(completed[0]!.fields.contentLength, 0)
    assert.equal(completed[0]!.fields.toolCount, 0)
    assert.equal(completed[0]!.fields.stopReason, 'stop')
    assert.deepEqual(completed[0]!.fields.usage, { input: 10, output: 4096, cacheRead: 0, cacheWrite: 0, total: 4106 })
    assert.equal(completed[1]!.fields.thinkingLength, 0)
    assert.equal(completed[1]!.fields.estimatedThinkingTokens, 0)
    assert.equal(completed[1]!.fields.contentLength, 'Final response'.length)
    const bodies = f.logs.filter(record => record.message === 'model response content')
    assert.equal(bodies[0]!.fields.displayTitle, '模型输出')
    assert.equal(bodies[0]!.fields.content, '（本轮没有正文输出）')
    for (const [index, record] of completed.entries()) {
      assert.equal(record.fields.outputLimit, f.requests[index]!.max_tokens)
      const overview = f.logs.find(log => log.message === 'model request overview' && log.fields.requestId === record.fields.requestId)
      assert.equal(record.fields.outputLimit, overview?.fields.outputLimit)
    }
    const thinking = f.logs.filter(record => record.message === 'model response thinking')
    assert.equal(thinking.length, 1)
    assert.equal(thinking[0]!.fields.displayTitle, '模型思考')
    assert.equal(thinking[0]!.fields.content, '中文private-thinking-marker')
    assert.equal(thinking[0]!.fields.runId, completed[0]!.fields.runId)
    assert.equal(thinking[0]!.fields.requestId, completed[0]!.fields.requestId)
    assert.ok(f.logs.indexOf(thinking[0]!) < f.logs.indexOf(bodies[0]!))
    assert.ok(f.requests.every(request => !('max_tokens' in request) && !('max_completion_tokens' in request)))
  })

  for (const finishReason of ['stop', 'length']) {
    it(`accepts output beyond 4096 and preserves the platform ${finishReason} reason`, { timeout: 30_000 }, async t => {
      const text = 'Full output. '.repeat(500)
      const f = await fixture(t, (_body, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        chunk(response, { role: 'assistant', content: text })
        chunk(response, {}, finishReason)
        response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 6000, total_tokens: 6010 } })}\n\ndata: [DONE]\n\n`)
      })
      await f.session.prompt('Produce the complete result.')
      assert.deepEqual(f.payloadErrors, [])
      const completed = f.logs.find(record => record.message === 'model response completed')!
      assert.equal(completed.fields.contentLength, text.length)
      assert.equal(completed.fields.stopReason, finishReason)
      assert.equal((completed.fields.usage as { output: number }).output, 6000)
      assert.equal(f.logs.find(record => record.message === 'model response content')!.fields.content, text)
    })
  }

  it('logs only newly added inputs and responses while preserving the full provider context', { timeout: 30_000 }, async t => {
    let turn = 0
    const f = await fixture(t, (_body, response) => answer(response, `Reply ${++turn}`))
    await f.session.prompt('First requirement')
    await f.session.prompt('New delivery correction')
    const inputs = f.logs.filter(record => record.message === 'model input added: user')
    assert.deepEqual(inputs.map(record => record.fields.content), ['First requirement', 'New delivery correction'])
    assert.deepEqual(f.logs.filter(record => record.message === 'model response content').map(record => record.fields.content), ['Reply 1', 'Reply 2'])
    assert.deepEqual(f.logs.filter(record => record.message === 'model request overview').map(record => record.fields.latestInputSequence), [1, 2])
    assert.equal(f.logs.some(record => record.message.startsWith('model request message')), false)
    assert.equal(f.logs.some(record => record.fields.role === 'system'), false)
    assert.ok(f.requests[1]!.messages.some(message => message.content === 'First requirement'))
    assert.ok(f.requests[1]!.messages.some(message => message.content === 'Reply 1'))
    assert.ok(f.requests[1]!.messages.some(message => message.content === 'New delivery correction'))
  })

  it('does not replay saved history into logs after reopening a session', { timeout: 30_000 }, async t => {
    const f = await fixture(t, (_body, response) => answer(response, 'Saved response'))
    await f.session.prompt('Saved requirement')
    await f.reopen()
    f.logs.length = 0
    await f.session.prompt('Resume with this new requirement')
    assert.deepEqual(f.logs.filter(record => record.message === 'model input added: user').map(record => record.fields.content), ['Resume with this new requirement'])
    assert.doesNotMatch(JSON.stringify(f.logs.filter(record => record.message.startsWith('model input'))), /Saved requirement|Saved response/)
    assert.ok(f.requests[1]!.messages.some(message => message.content === 'Saved requirement'))
  })

  it('keeps only metadata at info level', { timeout: 30_000 }, async t => {
    setLogLevel('info')
    const f = await fixture(t, (_body, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      chunk(response, { role: 'assistant', reasoning_content: 'Private thinking body' })
      chunk(response, { content: 'Private response body' })
      chunk(response, {}, 'stop')
      response.end('data: [DONE]\n\n')
    })
    await f.session.prompt('Private request body')
    assert.ok(f.logs.some(record => record.message === 'model request overview'))
    assert.ok(f.logs.some(record => record.message === 'model response completed'))
    assert.doesNotMatch(JSON.stringify(f.logs), /Private request body|Private response body|Private thinking body/)
  })

  for (const legacy of [false, true]) {
    it(`starts a new round after reopening a failed overflow compaction with ${legacy ? 'missing legacy' : 'existing'} counts`, { timeout: 30_000 }, async t => {
      let normalAttempts = 0
      let summaryAttempts = 0
      let restoredLegacy = false
      let progress: ModelRequestProgress | undefined
      const f = await fixture(t, (body, response) => {
        const isSummary = !body.messages.some(message => message.role === 'system' && message.content.includes('Fixed node contract'))
        if (isSummary) {
          if (++summaryAttempts === 1) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: { message: 'Invalid summary request' } }))
          } else answer(response, 'Summary of prior findings and outstanding work.')
        } else if (++normalAttempts === 1) answer(response, 'Earlier findings. '.repeat(5_000))
        else if (normalAttempts === 2) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }))
        } else answer(response, 'Done')
      }, async kind => {
        progress = advanceModelRequestProgress(progress, kind, restoredLegacy ? 'since-resume' : undefined)
        return progress
      })
      await f.session.prompt('Gather findings.')
      await f.session.prompt('Complete the node.')
      assert.deepEqual(f.kinds, ['execution', 'execution', 'compaction'])
      if (legacy) { progress = undefined; restoredLegacy = true }
      await f.reopen()
      await f.session.prompt('Continue interrupted work.')
      await f.session.prompt('Apply the delivery correction.')
      assert.deepEqual(f.kinds, ['execution', 'execution', 'compaction', 'compaction', 'execution', 'execution'])
      assert.equal(f.progress()?.executionRounds, legacy ? 2 : 4)
      for (const [index, round] of (legacy ? [1, 2] : [3, 4]).entries()) {
        const system = f.requests[index + 4]!.messages.find(message => message.role === 'system')!.content
        assert.ok(system.includes(`第 ${round} 次执行模型请求`))
        assert.equal(system.split('【当前节点执行情况】').length, 2)
        assert.match(system, /Fixed node contract/)
        assert.match(system, /不得因为请求次数增加/)
        if (legacy) {
          assert.match(system, /自恢复统计起点以来/)
          assert.match(system, /此前执行次数未记录/)
        } else assert.doesNotMatch(system, /此前执行次数未记录/)
      }
      for (const index of [2, 3]) assert.doesNotMatch(f.requests[index]!.messages.find(message => message.role === 'system')!.content, /【当前节点执行情况】/)
    })
  }

  for (const status of [429, 503]) {
    it(`reuses the execution round after ${status} and advances after the next tool result`, { timeout: 30_000 }, async t => {
      let attempt = 0
      const f = await fixture(t, (_body, response, root) => {
        attempt++
        if (attempt === 2) {
          response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '0' })
          response.end(JSON.stringify({ error: { message: 'Try again', type: 'server_error' } }))
        } else if (attempt === 1 || attempt === 3) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: `read-${attempt}`, type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: join(root, `${attempt}.txt`) }) } }] })
          chunk(response, {}, 'tool_calls')
          response.end('data: [DONE]\n\n')
        } else answer(response, 'Done')
      })
      await writeFile(join(f.root, '1.txt'), 'First result')
      await writeFile(join(f.root, '3.txt'), 'New useful result')
      await f.session.prompt('Read both files and complete the node.')
      assert.deepEqual(f.kinds, ['execution', 'execution', 'retry', 'execution'])
      assert.deepEqual(f.progress(), { executionRounds: 3, requestAttempts: 4, executionRetries: 1, compactionAttempts: 0 })
      const inputs = f.logs.filter(record => record.message.startsWith('model input added:'))
      assert.deepEqual(inputs.map(record => record.fields.role), ['user', 'tool', 'tool'])
      assert.match(String(inputs[1]?.fields.content), /First result/)
      assert.match(String(inputs[2]?.fields.content), /New useful result/)
      assert.deepEqual(f.logs.filter(record => record.message === 'model request overview').map(record => record.fields.latestInputSequence), [1, 2, 2, 3])
      for (const [index, round] of [1, 2, 2, 3].entries()) {
        const system = f.requests[index]!.messages.find(message => message.role === 'system')!.content
        assert.ok(system.includes(`第 ${round} 次执行模型请求`))
        assert.equal(system.split('【当前节点执行情况】').length, 2)
        assert.match(system, /不得因为请求次数增加/)
      }
    })
  }

  it('waits for persisted counters before sending a request', { timeout: 30_000 }, async t => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    t.after(release)
    const f = await fixture(t, (_body, response) => answer(response, 'Done'), async () => {
      entered()
      await gate
      return advanceModelRequestProgress(undefined, 'execution')
    })
    const pending = f.session.prompt('Complete the node.')
    await started
    assert.equal(f.requests.length, 0)
    release()
    await pending
    assert.equal(f.requests.length, 1)
  })

  it('does not send after cancellation while counters are being saved', { timeout: 30_000 }, async t => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    t.after(release)
    const f = await fixture(t, (_body, response) => answer(response, 'Must not happen'), async () => {
      entered()
      await gate
      return advanceModelRequestProgress(undefined, 'execution')
    })
    const pending = f.session.prompt('Complete the node.')
    await started
    const cancelling = f.session.abort()
    release()
    await cancelling
    await pending
    assert.equal(f.requests.length, 0)
    assert.equal(f.progress()?.executionRounds, 1)
  })

  it('never sends a request or retries after counter storage fails', { timeout: 30_000 }, async t => {
    const f = await fixture(t, (_body, response) => answer(response, 'Must not happen'), async () => { throw new Error('ENOSPC') })
    await assert.rejects(f.session.prompt('Complete the node.'), /计数保存失败/)
    assert.equal(f.requests.length, 0)
    assert.deepEqual(f.kinds, ['execution'])
    await assert.rejects(f.session.prompt('Continue'), /计数保存失败/)
    assert.deepEqual(f.kinds, ['execution'])
  })

  for (const overflow of [false, true]) {
    it(`counts compaction retries separately ${overflow ? 'and preserves the overflowed round' : 'before a new execution round'}`, { timeout: 45_000 }, async t => {
      let normalAttempts = 0
      let compactionAttempts = 0
      const f = await fixture(t, (body, response) => {
        const isSummary = !body.messages.some(message => message.role === 'system' && message.content.includes('Fixed node contract'))
        if (isSummary) {
          if (++compactionAttempts === 1) {
            response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' })
            response.end(JSON.stringify({ error: { message: 'Service unavailable' } }))
          } else answer(response, 'Summary: preserve the node goal, useful findings and required final files.')
        } else if (++normalAttempts === 1) {
          answer(response, 'Earlier useful findings. '.repeat(5_000))
        } else if (normalAttempts === 2 && overflow) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' } }))
        } else answer(response, 'Node work is complete.', normalAttempts === 2 ? 120_000 : 10)
      })
      await f.session.prompt('Gather useful findings.')
      await f.session.prompt('Complete the required node work.')
      if (!overflow) await f.session.prompt('Continue after the saved checkpoint.')
      assert.ok(compactionAttempts >= (overflow ? 1 : 2))
      assert.equal(f.progress()?.executionRounds, overflow ? 2 : 3)
      assert.equal(f.progress()?.compactionAttempts, compactionAttempts)
      assert.equal(f.kinds.filter(kind => kind === 'recovery').length, overflow ? 1 : 0)
      for (const [index, kind] of f.kinds.entries()) {
        const system = f.requests[index]!.messages.find(message => message.role === 'system')!.content
        if (kind === 'compaction') assert.doesNotMatch(system, /【当前节点执行情况】/)
        else assert.equal(system.split('【当前节点执行情况】').length, 2)
      }
    })
  }
})
