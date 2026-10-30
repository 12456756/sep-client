import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiCodingAgentAdapter, normalizeEvent, normalizeGatewayPayload, sessionToolOptions, classifyToolFailure, buildGatewayRequestLogFields, buildGatewayThinkingLogFields } from './pi-coding-agent-adapter'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import type { MediaHostTools, MediaToolName } from '../../domain/media-tools'
import { AppError } from '../../errors/app-error'
import { setLogSink } from '../../common/logger'
import { prepareCommonSkills } from './common-skills'
import { OFFICE_TOOL_NAME } from './pi-office-policy'
import { translatePiNativeSystemPrompt } from './pi-native-system-prompt'
import type { ModelTraceEntry } from '../../domain/model-trace'

const readOnlyPolicy = {
  allowedTools: ['read', 'grep', 'find', 'ls'],
  allowedPaths: [],
  deniedPaths: [],
  commandPolicy: 'disabled' as const,
  approvalMode: 'auto-approve' as const,
  workspaceDir: 'C:/workspace',
}

describe('thinking event projection', () => {
  it('forwards only actual thinking deltas and redacts their contents', () => {
    const event = { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Inspect files. Bearer secret-access-token password="private-password"' } } as unknown as AgentSessionEvent
    const projected = normalizeEvent(event)
    assert.equal(projected?.type, 'thinking_delta')
    assert.match(JSON.stringify(projected), /Inspect files/)
    assert.doesNotMatch(JSON.stringify(projected), /secret-access-token|private-password/)
    assert.equal(normalizeEvent({ ...event, assistantMessageEvent: { type: 'thinking_start' } } as unknown as AgentSessionEvent), null)
  })
})

describe('task tool policy session options', () => {
  it('advertises policy tools without the removed web search', () => {
    assert.deepEqual(sessionToolOptions(readOnlyPolicy), {
      tools: ['read', 'grep', 'find', 'ls'],
    })
  })

  it('keeps an empty policy free of the removed web search', () => {
    assert.deepEqual(sessionToolOptions({ ...readOnlyPolicy, allowedTools: [] }), {
      tools: [],
    })
  })

  it('advertises only default tools when no task policy is present', () => {
    assert.deepEqual(sessionToolOptions(undefined), {
      tools: ['read', 'bash', 'edit', 'write'],
    })
  })

  it('can disable all tools for planner sessions', () => {
    assert.deepEqual(sessionToolOptions(undefined, true), {
      noTools: 'all',
    })
  })
})

describe('provider request diagnostics', () => {
  it('summarizes request metadata without reading historical message bodies or tool schemas', () => {
    const historical = { get content(): never { throw new Error('Historical content must not be read') } }
    const fields = buildGatewayRequestLogFields({
      model: 'model-a', max_tokens: 16_384, temperature: 0.2, stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'write' } }],
      messages: [historical, historical, historical],
    }, 42)
    assert.deepEqual(fields, {
      requestId: 42, model: 'model-a', messageCount: 3, outputBudgetSource: 'platform', temperature: 0.2,
      stream: true, includeUsage: true, toolCount: 2, tools: 'read, write',
    })
  })

  it('tolerates absent metadata and malformed tool definitions', () => {
    assert.deepEqual(buildGatewayRequestLogFields({ tools: [null, {}, { function: { name: 12 } }] }, 7), {
      requestId: 7, model: undefined, messageCount: 0, outputBudgetSource: 'platform',
      temperature: undefined, stream: undefined, includeUsage: undefined, toolCount: 0,
    })
  })

  it('does not report SDK internal budgets as effective gateway limits', () => {
    for (const payload of [{ max_completion_tokens: 2048 }, { max_tokens: 128, max_completion_tokens: 2048 }]) {
      const fields = buildGatewayRequestLogFields(payload, 42)
      assert.equal(fields.outputLimit, undefined)
      assert.equal(fields.outputBudgetSource, 'platform')
    }
  })
})
describe('provider thinking diagnostics', () => {
  it('reports zero for responses without thinking and never reads text or tool bodies', () => {
    assert.deepEqual(buildGatewayThinkingLogFields([
      { type: 'text', get text(): never { throw new Error('Body must not be read') } },
      { type: 'toolCall', id: 'call', name: 'read', get arguments(): never { throw new Error('Arguments must not be read') } },
    ]), { thinkingLength: 0, estimatedThinkingTokens: 0 })
  })

  it('estimates mixed thinking without exposing or mutating its contents', () => {
    const content = Object.freeze([
      Object.freeze({ type: 'thinking' as const, thinking: '中文abc!' }),
      Object.freeze({ type: 'thinking' as const, thinking: 'é😀𠀀' }),
    ])
    // Han: 3 * 0.6, ASCII: 4 * 0.3, other code points: 2 * 1.
    assert.deepEqual(buildGatewayThinkingLogFields(content), {
      thinkingLength: 11, estimatedThinkingTokens: 5,
    })
  })

  it('rounds once across thinking blocks and starts fresh for the next response', () => {
    const split = buildGatewayThinkingLogFields([
      { type: 'thinking', thinking: 'a' }, { type: 'thinking', thinking: 'b' },
    ])
    assert.deepEqual(split, buildGatewayThinkingLogFields([{ type: 'thinking', thinking: 'ab' }]))
    assert.deepEqual(split, { thinkingLength: 2, estimatedThinkingTokens: 1 })
    assert.deepEqual(buildGatewayThinkingLogFields([]), { thinkingLength: 0, estimatedThinkingTokens: 0 })
  })
})

describe('SEP gateway payload compatibility', () => {
  it('preserves tool call IDs and tool roles across gateway turns', () => {
    const result = normalizeGatewayPayload({
      model: 'gpt-5.2',
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'Need to inspect the workspace.',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        },
        { role: 'tool', content: 'file-a.txt', tool_call_id: 'call-1' },
      ],
    }) as { messages: Array<Record<string, unknown>> }

    assert.deepEqual(result.messages, [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, reasoning_content: 'Need to inspect the workspace.', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', content: 'file-a.txt', tool_call_id: 'call-1' },
    ])
  })

  it('omits SDK output budgets so the platform controls the output limit', () => {
    const base = { model: 'deepseek', messages: [{ role: 'user', content: 'hello' }] }
    for (const limit of [1, 4096, 16384, 32768, 0, -1, 1.5, '4096', NaN]) {
      assert.deepEqual(normalizeGatewayPayload({ ...base, max_completion_tokens: limit }), base)
      assert.deepEqual(normalizeGatewayPayload({ ...base, max_tokens: limit }), base)
    }
  })

  it('leaves ordinary requests unchanged', () => {
    const payload = { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }] }
    assert.deepEqual(normalizeGatewayPayload(payload), {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('removes provider-only fields and converts content parts to strings', () => {
    const result = normalizeGatewayPayload({
      model: 'gpt-5.2',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }], extra: true }],
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
    })
    assert.deepEqual(result, {
      model: 'gpt-5.2',
      messages: [{ role: 'assistant', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('removes the SDK summary budget rather than imposing it on the gateway', () => {
    assert.deepEqual(normalizeGatewayPayload({
      model: 'model-a', messages: [], max_completion_tokens: 16384,
    }), { model: 'model-a', messages: [] })
  })

  it('removes both budget fields even when both are present', () => {
    const base = { model: 'model-a', messages: [] }
    assert.deepEqual(normalizeGatewayPayload({ ...base, max_tokens: 128, max_completion_tokens: 4096 }),
      base)
    assert.deepEqual(normalizeGatewayPayload({ ...base, max_tokens: 0, max_completion_tokens: 16384 }),
      base)
  })

  for (const includeUsage of [true, false]) {
    it(`preserves valid usage option ${includeUsage} without unknown streaming fields`, () => {
      assert.deepEqual(normalizeGatewayPayload({
        model: 'model-a', messages: [], stream_options: { include_usage: includeUsage, unknown: true },
      }), { model: 'model-a', messages: [], stream_options: { include_usage: includeUsage } })
    })
  }

  it('does not forward invalid output limits or usage options', () => {
    for (const limit of [0, -1, 1.5, '16384', null]) {
      assert.deepEqual(normalizeGatewayPayload({
        model: 'model-a', messages: [], max_completion_tokens: limit,
        stream_options: { include_usage: 'true' },
      }), { model: 'model-a', messages: [] })
    }
  })
})

describe('tool failure classification', () => {
  it('classifies "Tool xxx not found" as unknown-tool', () => {
    assert.equal(classifyToolFailure('tool', 'Tool tool not found'), 'unknown-tool')
    assert.equal(classifyToolFailure('foo', 'Tool foo not found'), 'unknown-tool')
  })

  it('classifies denial messages as policy-denied', () => {
    assert.equal(classifyToolFailure('bash', 'Tool denied by task policy: bash'), 'policy-denied')
    assert.equal(classifyToolFailure('write', 'blocked by guard'), 'policy-denied')
    assert.equal(classifyToolFailure('edit', 'not allowed in this context'), 'policy-denied')
    assert.equal(classifyToolFailure('ls', { content: [{ type: 'text', text: 'Tool denied by task policy: ls' }], details: {} }), 'policy-denied')
  })

  it('classifies other failures as execution-failed', () => {
    assert.equal(classifyToolFailure('read', 'file not found'), 'execution-failed')
    assert.equal(classifyToolFailure('bash', 'command exited with code 1'), 'execution-failed')
    assert.equal(classifyToolFailure('grep', 'invalid regex pattern'), 'execution-failed')
  })
})


describe('MCP tool advertisement', () => {
  it('adds only registered MCP names and preserves existing tools', () => {
    assert.deepEqual(sessionToolOptions({ ...readOnlyPolicy, allowedTools: ['ls', 'mcp__fake__search'] }, false, ['mcp__docs__search']), {
      tools: ['ls', 'mcp__docs__search'],
    })
  })
  it('noTools overrides even registered MCP tools', () => {
    assert.deepEqual(sessionToolOptions(undefined, true, ['mcp__docs__search']), { noTools: 'all' })
  })
})


describe('unrestricted full-local session options', () => {
  it('advertises all built-in tools and registered MCP tools', () => {
    assert.deepEqual(sessionToolOptions({
      ...readOnlyPolicy,
      preset: 'full-local',
      allowedTools: ['read'],
      allowedPaths: ['src'],
      deniedPaths: ['src/private'],
      commandPolicy: 'disabled',
      approvalMode: 'auto-approve',
    }, false, ['mcp__docs__search']), {
      tools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'mcp__docs__search'],
    })
  })
})

describe('employee skill loader adapter boundary (no model requests)', () => {
  it('fails closed for employee entries while preserving ordinary session discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-pi-employee-loader-'))
    const restoreLog = setLogSink(() => {})
    const config: PiAgentSessionConfig = {
      runId: 'run-loader', modelId: 'model-a', gatewayUrl: 'http://127.0.0.1:1/v1',
      workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), mcpServers: [],
      additionalSkillPaths: [join(root, 'missing')],
      getAccessToken: async () => { throw new Error('No model request is permitted.') },
      authorizeTool: async () => false,
    }
    let session: Awaited<ReturnType<PiCodingAgentAdapter['createSession']>> | undefined
    try {
      const adapter = new PiCodingAgentAdapter()
      await assert.rejects(adapter.createSession({ ...config, employeeProfile: { name: 'Orders' } }), /integrity mismatch/)
      session = await adapter.createSession(config)
      assert.ok(session.sessionId)
      await session.dispose()
      session = await adapter.createSession({
        ...config, additionalSkillPaths: [], employeeProfile: { name: 'Orders' },
      })
      assert.ok(session.sessionId)
    } finally {
      await session?.dispose()
      await rm(root, { recursive: true, force: true })
      restoreLog()
    }
  })
})

const mediaNames: MediaToolName[] = ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job']
const generationInput = {
  profileId: 'profile-a', operation: 'generate', localAssetIds: [], creativeBrief: 'A product photo',
  parameters: { aspectRatio: '1:1', count: 1 },
}
const jobView = {
  jobId: 'job-a', taskId: 'task-a', runId: 'run-a', profileId: 'profile-a', operation: 'generate',
  parameters: generationInput.parameters, generationStatus: 'QUEUED', trackingStatus: 'ACTIVE', saveStatus: 'PENDING',
  billingStatus: 'pending', error: null, createdAt: 1, updatedAt: 1, assets: [], canCancelUpstream: false,
}

async function mediaSession(
  overrides: Partial<PiAgentSessionConfig>,
  call?: { name: string; input: unknown },
  result: unknown = jobView,
  prepare?: (root: string) => Promise<void>,
  continueSession?: (session: Awaited<ReturnType<PiCodingAgentAdapter['createSession']>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'sep-pi-media-'))
  await prepare?.(root)
  const bodies: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }> }> = []
  const executions: Array<{ name: MediaToolName; input: unknown; signal?: AbortSignal }> = []
  let approvals = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      bodies.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const toolCall = bodies.length === 1 && call
      const delta = toolCall ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-media', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
        : { role: 'assistant', content: 'done' }
      for (const [current, reason] of [[delta, null], [{}, toolCall ? 'tool_calls' : 'stop']] as const) {
        response.write(`data: ${JSON.stringify({ id: 'response-a', object: 'chat.completion.chunk', created: 1, model: 'model-a', choices: [{ index: 0, delta: current, finish_reason: reason }] })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const host: MediaHostTools = {
    names: mediaNames,
    async execute(name, input, signal) {
      executions.push({ name, input, signal })
      if (result instanceof Error) throw result
      return result
    },
  }
  let session: Awaited<ReturnType<PiCodingAgentAdapter['createSession']>> | undefined
  const restoreLog = setLogSink(() => {})
  try {
    const literalPrompt = join(root, 'literal-prompt')
    await writeFile(literalPrompt, 'Do not read this file as the system prompt.')
    session = await new PiCodingAgentAdapter().createSession({
      runId: 'run-a', modelId: 'model-a', gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
      workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), mcpServers: [],
      systemPrompt: literalPrompt, mediaTools: host, getAccessToken: async () => 'test-token',
      authorizeTool: async () => { approvals++; return false }, ...overrides,
    })
    await session.prompt('Run the requested operation.')
    await continueSession?.(session)
    return { bodies, executions, approvals, literalPrompt }
  } finally {
    await session?.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    restoreLog()
  }
}

describe('common Office skills with the real Pi SDK', () => {
  it('advertises the verified common skill and tool for an employee session', async t => {
    if (process.env.SEP_MCP_CONFIG || !prepareCommonSkills().office) {
      t.skip('Requires prepared Office resources and default host MCP configuration.'); return
    }
    const { bodies } = await mediaSession({ mcpServers: undefined, additionalSkillPaths: [],
      employeeProfile: { name: 'Office employee' } })
    assert.ok(bodies[0].tools?.some(tool => tool.function.name === OFFICE_TOOL_NAME))
    const system = bodies[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    assert.match(system, /<name>officecli<\/name>/)
  })
  it('advertises common Office for a general session without employee skills', async t => {
    if (process.env.SEP_MCP_CONFIG || !prepareCommonSkills().office) {
      t.skip('Requires prepared Office resources and default host MCP configuration.'); return
    }
    const { bodies } = await mediaSession({ mcpServers: undefined, disableSkills: true, enableCommonTools: true,
      additionalSkillPaths: ['missing-employee-skill'], employeeProfile: undefined, useNativeSystemPrompt: true,
      systemPrompt: 'EMPLOYEE_OVERRIDE_MUST_NOT_APPEAR' }, undefined, jobView, async root => {
      const skill = join(root, '.pi', 'skills', 'local-only')
      await mkdir(skill, { recursive: true })
      await writeFile(join(skill, 'SKILL.md'), '---\nname: local-only\ndescription: LOCAL_SKILL_MUST_NOT_APPEAR\n---\nLocal instructions.')
      await writeFile(join(root, '.pi', 'SYSTEM.md'), 'LOCAL_SYSTEM_OVERRIDE_MUST_NOT_APPEAR')
    })
    assert.ok(bodies[0].tools?.some(tool => tool.function.name === OFFICE_TOOL_NAME))
    const system = bodies[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    assert.match(system, /<name>officecli<\/name>/)
    assert.doesNotMatch(system, /EMPLOYEE_OVERRIDE_MUST_NOT_APPEAR|LOCAL_SKILL_MUST_NOT_APPEAR|LOCAL_SYSTEM_OVERRIDE_MUST_NOT_APPEAR|<employee_profile>/)
  })
  for (const overrides of [
    { mcpServers: [] },
    { mcpServers: undefined, disableTools: true },
    { mcpServers: undefined, disableTools: true, disableSkills: true, enableCommonTools: true },
    { mcpServers: undefined, disableSkills: true },
    { mcpServers: undefined, toolPolicy: { ...readOnlyPolicy, allowedTools: [] } },
  ] satisfies Array<Partial<PiAgentSessionConfig>>) {
    it(`does not add Office when disabled by ${JSON.stringify(overrides)}`, async () => {
      const { bodies } = await mediaSession({ ...overrides, additionalSkillPaths: [],
        employeeProfile: { name: 'Office employee' } })
      assert.ok(!bodies[0].tools?.some(tool => tool.function.name === OFFICE_TOOL_NAME))
      const system = bodies[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
      assert.doesNotMatch(system, /<name>officecli<\/name>/)
    })
  }
})

describe('trusted media host tools with the real Pi SDK', () => {
  it('preserves a historical named image size when projecting the original job', async () => {
    const parameters = { aspectRatio: '1:1', count: 1, size: 'small', quality: 'standard' }
    const { bodies } = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, { ...jobView, parameters })
    const continuation = bodies.at(-1)!.messages.find(message => message.role === 'tool')!
    const result = JSON.parse(continuation.content)
    assert.equal(result.jobId, 'job-a')
    assert.deepEqual(result.parameters, parameters)
  })
  it('accepts SEP named image sizes as V3 job specifications', async () => {
    const { bodies } = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, {
      ...jobView, protocolVersion: 3, parameters: { ...generationInput.parameters, size: 'small' },
    })
    const result = JSON.parse(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content)
    assert.equal(result.jobId, 'job-a')
    assert.equal(result.parameters.size, 'small')
  })
  it('explains contradictory image dimensions before dispatch without echoing the creative brief', async () => {
    const { bodies, executions } = await mediaSession({}, { name: 'media_generate_image', input: {
      creativeBrief: 'private creative brief', protocolVersion: 3, specRevision: 1,
      requestedSpec: { width: 800, height: 600, aspectRatio: '9:16' },
      parameterSources: { width: 'user', height: 'user', aspectRatio: 'model' },
    } })
    const resultText = bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content
    const result = JSON.parse(resultText)
    assert.deepEqual(executions, [])
    assert.equal(result.error.code, 'SPEC_CONFLICT')
    assert.equal(result.error.field, 'requestedSpec.aspectRatio')
    assert.equal(result.error.source, 'client')
    assert.doesNotMatch(resultText, /private creative brief/)
  })
  it('advertises and forwards a model-proposed V3 image decision through the actual SDK', async () => {
    const input = { creativeBrief: 'A vertical product photograph', requirementId: 'image-b', protocolVersion: 3, specRevision: 2,
      requestedSpec: { size: '2048x3072', quality: 'ultra' }, parameterSources: { size: 'model', quality: 'user' } }
    const view = { ...jobView, parameters: input.requestedSpec, protocolVersion: 3, requestedSpec: input.requestedSpec,
      effectiveSpec: input.requestedSpec, parameterSources: input.parameterSources, specRevision: 2 }
    const { bodies, executions } = await mediaSession({}, { name: 'media_generate_image', input }, view)
    assert.equal(executions.length, 1)
    assert.deepEqual(executions[0].input, input)
    const definition = bodies[0].tools!.find(tool => tool.function.name === 'media_generate_image')!
    assert.match(JSON.stringify(definition), /requestedSpec|parameterSources|specRevision/)
    assert.doesNotMatch(definition.function.description, /fills supported defaults|only when the user explicitly asks/)
    const continuation = JSON.stringify(bodies.at(-1))
    assert.match(continuation, /2048x3072/)
    assert.match(continuation, /effectiveSpec/)
  })
  it('keeps request documents distinct across sessions sharing the same run ID', async () => {
    const entries: ModelTraceEntry[] = []
    const config = { modelTrace: async (entry: ModelTraceEntry) => { entries.push(entry) } }
    await mediaSession(config)
    await mediaSession(config)
    const inputs = entries.filter(entry => entry.kind === 'input')
    assert.equal(inputs.length, 2)
    assert.ok(inputs.every(entry => entry.requestNumber === 1 && String(entry.requestId).startsWith('run-a-')))
    assert.notEqual(inputs[0].requestId, inputs[1].requestId)
  })
  it('rebinds diagnostics when a conversation reuses the same Pi session', async () => {
    const first: ModelTraceEntry[] = []
    const second: ModelTraceEntry[] = []
    await mediaSession({ modelTrace: async entry => { first.push(entry) } }, undefined, jobView, undefined, async session => {
      session.setDiagnostics?.({ runId: 'run-b', taskTitle: '继续对话', tracePhase: '对话执行', modelTrace: async entry => { second.push(entry) } })
      session.setRequestPurpose?.('恢复执行')
      await session.prompt('Continue the same conversation.')
    })
    assert.equal(first.filter(entry => entry.kind === 'input').length, 1)
    assert.equal(second.filter(entry => entry.kind === 'input').length, 1)
    assert.ok(first.filter(entry => entry.requestId).every(entry => String(entry.requestId).startsWith('run-a-')))
    assert.ok(second.filter(entry => entry.requestId).every(entry => String(entry.requestId).startsWith('run-b-')))
    assert.ok(second.some(entry => entry.text.includes('恢复执行')))
  })
  it('records actual provider inputs, tool continuation, headers and full response without terminal body records', async () => {
    const entries: ModelTraceEntry[] = []
    const { bodies } = await mediaSession({ taskTitle: '日志链路测试', tracePhase: '节点：图片生成',
      modelTrace: async entry => { entries.push(entry) },
    }, { name: 'media_get_job', input: { jobId: 'job-a' } })
    const inputs = entries.filter(entry => entry.kind === 'input')
    const completed = entries.filter(entry => entry.completed)
    assert.equal(inputs.length, bodies.length)
    assert.equal(completed.length, bodies.length)
    assert.match(inputs[0].text, /系统消息/)
    assert.match(inputs.at(-1)!.text, /工具返回/)
    assert.ok(entries.some(entry => entry.kind === 'tool' && entry.text.includes('工具结束')))
    assert.ok(entries.some(entry => entry.metrics?.响应状态码 === 200))
    assert.ok(completed.every(entry => typeof entry.metrics?.总耗时毫秒 === 'number'))
    assert.ok(entries.some(entry => entry.text.includes('工具执行后续轮')))
    assert.doesNotMatch(JSON.stringify(entries), /test-token/)
  })
  it('continues the real provider request when the diagnostic recorder rejects', async () => {
    const { bodies } = await mediaSession({ modelTrace: async () => { throw new Error('disk unavailable') } })
    assert.equal(bodies.length, 1)
  })
  it('general assistant preserves the Chinese native prompt and dynamic paths but loads no local skills or employee override', async () => {
    const { bodies } = await mediaSession({
      useNativeSystemPrompt: true, disableSkills: true, modelRequestAwareness: false,
      systemPrompt: 'EMPLOYEE_OVERRIDE_MUST_NOT_APPEAR', employeeProfile: undefined, mediaTools: undefined,
      additionalSkillPaths: ['missing-employee-skill'], transformSystemPrompt: translatePiNativeSystemPrompt,
    }, undefined, jobView, async root => {
      const skill = join(root, '.pi', 'skills', 'local-only')
      await mkdir(skill, { recursive: true })
      await writeFile(join(skill, 'SKILL.md'), '---\nname: local-only\ndescription: LOCAL_SKILL_MUST_NOT_APPEAR\n---\nLocal instructions.')
      await writeFile(join(root, '.pi', 'SYSTEM.md'), 'LOCAL_SYSTEM_OVERRIDE_MUST_NOT_APPEAR')
    })
    const prompt = bodies[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    assert.match(prompt, /你运行在 Pi 中。你通过读取文件、执行命令、编辑代码和创建新文件来帮助用户。/)
    assert.match(prompt, /当前工作目录：.*sep-pi-media-/)
    assert.match(prompt, /主要文档：.*README.md/)
    assert.doesNotMatch(prompt, /EMPLOYEE_OVERRIDE_MUST_NOT_APPEAR|LOCAL_SKILL_MUST_NOT_APPEAR|LOCAL_SYSTEM_OVERRIDE_MUST_NOT_APPEAR|<employee_profile>|<available_skills>/)
    assert.ok(bodies[0].tools?.some(tool => tool.function.name === 'read'))
    assert.ok(!bodies[0].tools?.some(tool => tool.function.name.startsWith('media_')))
  })
  for (const systemPrompt of [undefined, 'Custom employee instructions.']) {
    it(`keeps image tools and duty-bound means available with ${systemPrompt ? 'custom' : 'default'} instructions`, async () => {
      const { bodies, executions } = await mediaSession({ systemPrompt,
        employeeProfile: { name: '培训师', description: '制作员工培训材料' },
      }, { name: 'media_generate_image', input: generationInput })
      const prompt = bodies[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
      assert.equal(prompt.split('<employee_profile>').length, 2)
      assert.match(prompt, /不要求员工资料逐项列明这些手段/)
      assert.match(prompt, /工具可用性、费用及审批限制保持不变/)
      const tool = bodies[0].tools!.find(tool => tool.function.name === 'media_generate_image')!
      assert.match(tool.function.description, /actual authorization and protocol version/)
      assert.match(tool.function.description, /selected task reference images/)
      assert.equal(executions.length, 1)
    })
  }

  it('injects a literal system prompt and registers strict TypeBox schemas without profile secrets', async () => {
    const { bodies, literalPrompt } = await mediaSession({})
    assert.ok(bodies[0].messages.some(message => message.role === 'system' && message.content.includes(literalPrompt)))
    assert.ok(!JSON.stringify(bodies[0]).includes('Do not read this file'))
    const tools = bodies[0].tools ?? []
    assert.deepEqual(tools.map(tool => tool.function.name).filter(name => name.startsWith('media_')), mediaNames)
    const generation = tools.find(tool => tool.function.name === 'media_generate_image')!.function.parameters
    assert.equal(generation.additionalProperties, false)
    assert.deepEqual(generation.required, ['creativeBrief'])
    const properties = generation.properties as Record<string, Record<string, unknown>>
    assert.equal(properties.parameters.additionalProperties, false)
    assert.equal(properties.parameters.required, undefined)
    const nested = properties.parameters.properties as Record<string, Record<string, unknown>>
    assert.equal(nested.count.type, 'integer')
    assert.equal(nested.count.maximum, Number.MAX_SAFE_INTEGER)
    const cancel = tools.find(tool => tool.function.name === 'media_cancel_job')!.function.parameters
    assert.deepEqual(cancel.required, ['jobId', 'cancelUpstream'])
    const caps = tools.find(tool => tool.function.name === 'media_get_capabilities')!.function.parameters
    assert.equal(caps.additionalProperties, false)
    assert.ok(!JSON.stringify(tools).includes('apiKey'))
  })

  it('executes generation through the host without a duplicate raw-input approval', async () => {
    const request = { creativeBrief: 'A product photo' }
    const { bodies, executions, approvals } = await mediaSession({}, { name: 'media_generate_image', input: request }, { ...jobView, apiKey: 'private-key', url: 'https://secret.example', quote: { amount: '123' } })
    assert.equal(approvals, 0)
    assert.equal(executions.length, 1)
    assert.deepEqual(executions[0].input, request)
    assert.ok(executions[0].signal instanceof AbortSignal)
    const text = JSON.stringify(bodies[1].messages)
    assert.ok(text.includes('job-a'))
    assert.ok(!text.includes('private-key'))
    assert.ok(!text.includes('secret.example'))
    assert.ok(!text.includes('123'))
  })

  it('never exposes or executes host tools in a planner', async () => {
    const { bodies, executions } = await mediaSession({ disableTools: true }, { name: 'media_generate_image', input: generationInput })
    assert.equal(bodies[0].tools, undefined)
    assert.deepEqual(executions, [])
  })

  it('denies unknown media names even in full-local-auto', async () => {
    const { executions } = await mediaSession({ toolPolicy: { ...readOnlyPolicy, preset: 'full-local' } }, { name: 'media_unknown', input: {} })
    assert.deepEqual(executions, [])
  })

  it('does not register read-only side effects or unauthorized workspace side effects', async () => {
    for (const preset of ['read-only', 'workspace-edit'] as const) {
      const { bodies, executions } = await mediaSession({ toolPolicy: { ...readOnlyPolicy, preset, allowedTools: preset === 'read-only' ? [...mediaNames] : ['read'] } }, { name: 'media_generate_image', input: generationInput })
      assert.deepEqual(bodies[0].tools?.map(tool => tool.function.name).filter(name => name.startsWith('media_')), ['media_get_capabilities', 'media_get_job'])
      assert.deepEqual(executions, [])
    }
  })

  it('full-local-auto still calls the host facade and propagates cancellation intent', async () => {
    const { executions, approvals } = await mediaSession({ toolPolicy: { ...readOnlyPolicy, preset: 'full-local' } }, { name: 'media_cancel_job', input: { jobId: 'job-a', cancelUpstream: true } })
    assert.equal(approvals, 0)
    assert.equal(executions.length, 1)
    assert.deepEqual(executions[0].input, { jobId: 'job-a', cancelUpstream: true })
  })

  it('full-local-confirm delegates approval to the host without requiring a media allowlist', async () => {
    const { bodies, executions, approvals } = await mediaSession({ toolPolicy: { ...readOnlyPolicy, preset: 'full-local', approvalMode: 'confirm-each', allowedTools: ['read'] } }, { name: 'media_generate_image', input: generationInput })
    assert.deepEqual(bodies[0].tools?.map(tool => tool.function.name).filter(name => name.startsWith('media_')), mediaNames)
    assert.equal(executions.length, 1)
    assert.equal(approvals, 0)
  })

  it('rejects malformed generation input before the host executes', async () => {
    for (const input of [{ ...generationInput, url: 'https://unsafe.example' }, { ...generationInput, parameters: { aspectRatio: '1:1', count: 0 } },
      { creativeBrief: 'A product photo', localAssetIds: ['asset-a', 'asset-a'] }]) {
      const { executions } = await mediaSession({}, { name: 'media_generate_image', input })
      assert.deepEqual(executions, [])
    }
  })

  it('returns safe business errors but never exposes thrown transport errors', async () => {
    const thrown = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, new Error('private-key https://secret.example Bearer secret-token'))
    assert.ok(JSON.stringify(thrown.bodies[1]).includes('Media tool request failed.'))
    assert.ok(!JSON.stringify(thrown.bodies[1]).includes('private-key'))
    const denied = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, { ok: false, error: { code: 'MEDIA_DENIED', message: 'Media approval denied. https://secret.example Bearer private-token', apiKey: 'private-key' } })
    assert.ok(JSON.stringify(denied.bodies[1]).includes('MEDIA_DENIED'))
    assert.ok(!JSON.stringify(denied.bodies[1]).includes('private-key'))
    assert.ok(!JSON.stringify(denied.bodies[1]).includes('secret.example'))
    assert.ok(!JSON.stringify(denied.bodies[1]).includes('private-token'))
    const business = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, new AppError('PERMISSION_DENIED', { message: 'Media approval denied. https://secret.example Bearer private-token', details: { apiKey: 'private-key' }, cause: new Error('private-cause') }))
    assert.ok(JSON.stringify(business.bodies[1]).includes('PERMISSION_DENIED'))
    assert.ok(!JSON.stringify(business.bodies[1]).includes('private-key'))
    assert.ok(!JSON.stringify(business.bodies[1]).includes('private-cause'))
    assert.ok(!JSON.stringify(business.bodies[1]).includes('secret.example'))
    assert.ok(!JSON.stringify(business.bodies[1]).includes('private-token'))
  })

  it('preserves only whitelisted media error metadata through the SDK projection', async () => {
    const result = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, {
      ok: false, error: { code: 'INVALID_ARGUMENT', message: '规格不可用', businessCode: 'MEDIA_SIZE_UNSUPPORTED', field: 'parameters.size', stage: 'image-quote', recovery: 'query_original', secret: 'private-token' },
    })
    const text = JSON.stringify(result.bodies[1].messages.at(-1))
    assert.match(text, /MEDIA_SIZE_UNSUPPORTED/)
    assert.match(text, /parameters\.size/)
    assert.match(text, /image-quote/)
    assert.match(text, /query_original/)
    assert.doesNotMatch(text, /private-token|secret/)
  })

  it('returns capability and reference-asset business views without exposing raw host fields', async () => {
    const { bodies, executions, approvals } = await mediaSession({}, { name: 'media_get_capabilities', input: {} }, {
      capabilities: { protocolVersion: 1, tools: ['media_get_capabilities'], profiles: [] }, referenceAssets: [],
      quote: { amount: 'private-price' }, apiKey: 'private-key',
    })
    assert.equal(executions.length, 1)
    assert.equal(approvals, 0)
    const text = JSON.stringify(bodies[1].messages)
    assert.ok(text.includes('referenceAssets'))
    assert.ok(!text.includes('private-price'))
    assert.ok(!text.includes('private-key'))
  })

  it('does not invent media tools when the host has no capabilities', async () => {
    const { bodies, executions } = await mediaSession({ mediaTools: undefined }, { name: 'media_generate_image', input: generationInput })
    assert.ok(!bodies[0].tools?.some(tool => tool.function.name.startsWith('media_')))
    assert.deepEqual(executions, [])
  })
})
