import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import { BROWSER_MODE_TOOL, BrowserModeSession } from './pi-browser-runtime'
import { BROWSER_EXTRACT, BROWSER_SAVE_ASSETS, BROWSER_SCROLL } from './pi-browser-page-tools'
import { createPlaywrightMcpServer, isRoutineBrowserCall, PLAYWRIGHT_GUIDELINES, PLAYWRIGHT_HANDOFF_GUIDELINES, PLAYWRIGHT_TOOL_SNIPPETS } from './pi-playwright-mcp'
import { evaluateDingTalkCommand } from '../../runtime/dingtalk-command'
import { ToolApprovals } from '../../runtime/run-approvals'
import type { ModelTraceEntry } from '../../domain/model-trace'
import { RUN_PYTHON_TOOL } from '../../../src/shared/python-tool'

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
  it('advertises staged Python independently of file access', () => {
    const local = { ...readOnlyPolicy, fileAccess: 'local' as const, allowedTools: ['read', 'write', RUN_PYTHON_TOOL] }
    const tools = (policy: PiAgentSessionConfig['toolPolicy'], available = true, disabled = false) =>
      sessionToolOptions(policy, disabled, [], [], [], false, false, false, available).tools ?? []
    assert.ok(tools(local).includes(RUN_PYTHON_TOOL))
    for (const policy of [undefined, { ...local, preset: 'read-only' as const }, { ...local, fileAccess: 'workspace' as const },
      { ...local, unattended: true }, { ...local, allowedPaths: ['reports'] }, { ...local, deniedPaths: ['secrets'] }]) {
      assert.ok(tools(policy).includes(RUN_PYTHON_TOOL))
    }
    assert.ok(!tools(local, false).includes(RUN_PYTHON_TOOL))
    assert.ok(!tools(local, true, true).includes(RUN_PYTHON_TOOL))
  })

  it('advertises policy tools without the removed web search', () => {
    assert.deepEqual(sessionToolOptions(readOnlyPolicy), {
      tools: ['read', 'grep', 'find', 'ls', 'get_current_time'],
    })
  })

  it('keeps an empty policy free of the removed web search', () => {
    assert.deepEqual(sessionToolOptions({ ...readOnlyPolicy, allowedTools: [] }), {
      tools: [],
    })
  })

  it('advertises only default tools when no task policy is present', () => {
    assert.deepEqual(sessionToolOptions(undefined), {
      tools: ['read', 'bash', 'edit', 'write', 'get_current_time'],
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
      tools: ['ls', 'get_current_time', 'mcp__docs__search'],
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
      tools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'get_current_time', 'mcp__docs__search'],
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

it('restoring a conversation checkpoint excludes an interrupted turn from the next provider context', async () => {
  const interruptedText = 'unique interrupted context text'
  const result = await mediaSession({}, undefined, undefined, undefined, async session => {
    const checkpoint = session.getContextCheckpoint?.()
    assert.notEqual(checkpoint, undefined)
    await session.prompt(interruptedText)
    await session.restoreContextCheckpoint?.(checkpoint!)
    await session.prompt('priority message')
  })
  const nextRequest = result.bodies.at(-1)
  assert.ok(nextRequest)
  assert.doesNotMatch(JSON.stringify(nextRequest.messages), new RegExp(interruptedText))
  assert.match(JSON.stringify(nextRequest.messages), /priority message/)
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

function messageText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected text message content.')
  return value
}

type FixtureCall = { name: string; input: unknown }
async function mediaSession(
  overrides: Partial<PiAgentSessionConfig>,
  call?: FixtureCall | Array<FixtureCall | undefined> | ((step: number, lastToolResult: string) => FixtureCall | undefined),
  result: unknown = jobView,
  prepare?: (root: string) => Promise<void>,
  continueSession?: (session: Awaited<ReturnType<PiCodingAgentAdapter['createSession']>>) => Promise<void>,
  includeImage = false,
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-pi-media-'))
  await prepare?.(root)
  const bodies: Array<{ messages: Array<{ role: string; content: string | unknown[] | null }>; tools?: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }> }> = []
  const executions: Array<{ name: MediaToolName; input: unknown; signal?: AbortSignal }> = []
  let approvals = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      bodies.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const toolCall = typeof call === 'function' ? call(bodies.length, String(bodies.at(-1)?.messages.filter(message => message.role === 'tool').at(-1)?.content ?? ''))
        : Array.isArray(call) ? call[bodies.length - 1] : bodies.length === 1 && call
      const delta = toolCall ? { role: 'assistant', tool_calls: [{ index: 0, id: Array.isArray(call) || typeof call === 'function' ? `call-${bodies.length}` : 'call-media', type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } }] }
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
      ...(overrides.toolPolicy ? { toolPolicy: { ...overrides.toolPolicy, workspaceDir: root } } : {}),
    })
    await session.prompt('Run the requested operation.', includeImage ? {
      images: [{ type: 'image', data: 'aW1hZ2UtZGF0YQ==', mimeType: 'image/png' }],
    } : undefined)
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

describe('bundled Python through the real Pi SDK', () => {
  it('uses one approval per call and creates the HTML result only after approval', { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async () => {
    const directory = '\u62a5\u544a'
    const purpose = 'Summarize the CSV by department'
    const code = `import csv, html, os
from pathlib import Path
assert not os.environ.get('PATH')
totals = {}
with Path('inputs', 'input.csv').open(encoding='utf-8', newline='') as source:
    for row in csv.DictReader(source):
        totals[row['team']] = totals.get(row['team'], 0) + int(row['amount'])
Path('outputs', 'report.html').write_text('<!doctype html><meta charset="utf-8">' + ''.join(f'<p>{html.escape(team)}: {total}</p>' for team, total in totals.items()), encoding='utf-8')
print('Report written')`
    const requests: unknown[] = []
    let artifact = ''
    let root = ''
    const { bodies } = await mediaSession({
      toolPolicy: { ...readOnlyPolicy, preset: 'workspace-edit', fileAccess: 'workspace', allowedTools: ['read', 'write'], allowedPaths: [directory] },
      authorizeTool: async request => {
        requests.push(request)
        await assert.rejects(readFile(join(root, directory, 'report.html')), { code: 'ENOENT' })
        return requests.length === 2
      },
    }, Array.from({ length: 2 }, () => ({ name: RUN_PYTHON_TOOL, input: { purpose, code,
      inputs: [{ name: 'input.csv', path: `${directory}/input.csv` }], output: { name: 'report.html', path: `${directory}/report.html` } } })), undefined,
    async workspace => {
      root = workspace
      await mkdir(join(workspace, directory))
      await writeFile(join(workspace, directory, 'input.csv'), 'team,amount\n\u7814\u53d1,3\n\u7814\u53d1,4\n')
    }, async () => { artifact = await readFile(join(root, directory, 'report.html'), 'utf8').catch(() => '') })
    assert.ok(bodies[0].tools?.some(tool => tool.function.name === RUN_PYTHON_TOOL))
    assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ toolName: RUN_PYTHON_TOOL, input: { purpose, timeoutSeconds: 60 } })))
    assert.match(JSON.stringify(bodies[1].messages.at(-1)), /execution was not approved/)
    assert.match(JSON.stringify(bodies[2].messages.at(-1)), /Report written/)
    assert.match(artifact, /<p>\u7814\u53d1: 7<\/p>/)
  })

  it('lets read-only tasks compute and import permitted files, but never save or import denied files', { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async () => {
    const options = { purpose: 'Read a text file', code: "from pathlib import Path; print(Path('inputs/a.txt').read_text())" }
    let root = ''
    const { bodies } = await mediaSession({
      toolPolicy: { ...readOnlyPolicy, preset: 'read-only', fileAccess: 'workspace', deniedPaths: ['private.txt'] },
      authorizeTool: async () => true,
    }, [
      { name: RUN_PYTHON_TOOL, input: { ...options, inputs: [{ name: 'a.txt', path: 'public.txt' }] } },
      { name: RUN_PYTHON_TOOL, input: { ...options, inputs: [{ name: 'a.txt', path: 'private.txt' }] } },
      { name: RUN_PYTHON_TOOL, input: { ...options, output: { name: 'leak.txt', path: 'leak.txt' } } },
    ], undefined, async workspace => {
      root = workspace
      await writeFile(join(workspace, 'public.txt'), 'permitted input result')
      await writeFile(join(workspace, 'private.txt'), 'private file contents')
    }, async () => assert.rejects(readFile(join(root, 'leak.txt')), { code: 'ENOENT' }))
    const tool = bodies[0].tools!.find(tool => tool.function.name === RUN_PYTHON_TOOL)
    assert.ok(tool)
    assert.doesNotMatch(JSON.stringify(tool.function.parameters), /"output"/)
    assert.match(JSON.stringify(bodies[1].messages.at(-1)), /permitted input result/)
    assert.match(JSON.stringify(bodies[2].messages.at(-1)), /denied by task policy/)
    assert.doesNotMatch(JSON.stringify(bodies), /private file contents/)
  })

  it('enforces write exclusions even when Python has local file access', { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async () => {
    let root = ''
    const { bodies } = await mediaSession({
      toolPolicy: { ...readOnlyPolicy, preset: 'workspace-edit', fileAccess: 'local', allowedTools: ['read', 'write'], deniedPaths: ['protected.txt'] },
      authorizeTool: async () => true,
    }, { name: RUN_PYTHON_TOOL, input: {
      purpose: 'Generate text', code: "from pathlib import Path; Path('outputs/result.txt').write_text('new content')",
      output: { name: 'result.txt', path: 'protected.txt' },
    } }, undefined, async workspace => {
      root = workspace
      await writeFile(join(root, 'protected.txt'), 'original content')
    }, async () => assert.equal(await readFile(join(root, 'protected.txt'), 'utf8'), 'original content'))
    assert.match(JSON.stringify(bodies[1].messages.at(-1)), /File access denied by task policy/)
  })
})

describe('conversation attachments through the real Pi SDK', () => {
  it('advertises only the scoped reader and returns the selected document to the model', async () => {
    const conversationAttachments: NonNullable<PiAgentSessionConfig['conversationAttachments']> = {
      list: () => ({ files: [{ attachmentId: 'attachment-doc', name: 'notes.txt', mediaType: 'text/plain', messageNumber: 1 }], nextOffset: null }),
      async read(id, offset) {
        assert.equal(id, 'attachment-doc')
        assert.equal(offset, 0)
        return { text: JSON.stringify({ text: 'Original document content.' }) }
      },
    }
    const call = { name: 'conversation_attachment', input: { operation: 'read', attachmentId: 'attachment-doc' } }
    const { bodies, approvals } = await mediaSession({ conversationAttachments, mediaTools: undefined }, call)
    assert.equal(bodies[0].tools!.find(tool => tool.function.name === call.name)?.function.parameters.type, 'object')
    const result = bodies[1].messages.find(message => message.role === 'tool')!
    assert.equal(JSON.parse(messageText(result.content)).text, 'Original document content.')
    assert.equal(approvals, 0)

    const blocked = await mediaSession({ conversationAttachments, disableTools: true }, call)
    assert.ok(!blocked.bodies[0].tools?.some(tool => tool.function.name === call.name))
    assert.ok(!JSON.stringify(blocked.bodies).includes('Original document content.'))
  })

  it('executes a structured XLSX query through the existing scoped attachment tool', async () => {
    const query = { operation: 'xlsx_analyze', sheet: 'Sales', range: 'A2:E8002', kind: 'count', filters: [{ column: 'E', op: 'gte', value: 0 }] } as const
    const call = { name: 'conversation_attachment', input: { attachmentId: 'attachment-xlsx', ...query, filters: [{ column: 'E', op: 'gte', number: 0 }] } }
    const conversationAttachments: NonNullable<PiAgentSessionConfig['conversationAttachments']> = {
      list: () => ({ files: [], nextOffset: null }),
      read: async () => assert.fail('analysis must not read the extracted text'),
      async xlsx(id, received) {
        assert.equal(id, 'attachment-xlsx')
        assert.deepEqual(received, query)
        return { operation: query.operation, sheet: query.sheet, range: query.range, kind: query.kind, scannedRows: 8001,
          emptyRows: 1, filteredRows: 0, unavailableFilterRows: 0, matchedRows: 8000, includedRows: 8000, excludedKeyRows: 0, excludedValueRows: 0 }
      },
    }
    const { bodies, approvals } = await mediaSession({ conversationAttachments, mediaTools: undefined }, call)
    assert.match(JSON.stringify(bodies[0].tools?.find(tool => tool.function.name === call.name)), /xlsx_analyze/)
    const result = bodies[1].messages.find(message => message.role === 'tool')!
    const text = messageText(result.content)
    assert.match(text, /^\{/, text)
    assert.equal(JSON.parse(text).includedRows, 8000)
    assert.equal(approvals, 0)
  })

  it('forwards a selected attachment image as image content, not an encoded text result', async () => {
    const image = { data: 'aW1hZ2UtZGF0YQ==', mimeType: 'image/png' }
    const { bodies } = await mediaSession({ vision: true, mediaTools: undefined, conversationAttachments: {
      list: () => ({ files: [], nextOffset: null }),
      read: async () => ({ text: '{"name":"original.png"}', image }),
    } }, { name: 'conversation_attachment', input: { operation: 'read', attachmentId: 'attachment-image' } })
    assert.ok(!JSON.stringify(bodies[0].messages).includes(image.data))
    assert.match(JSON.stringify(bodies[1].messages), /data:image\/png;base64,aW1hZ2UtZGF0YQ==/)
  })

  for (const sameImage of [true, false]) {
    it(`keeps the attachment tool result while ${sameImage ? 'omitting the duplicate user image' : 'sending a distinct image'}`, async () => {
      const original = 'aW1hZ2UtZGF0YQ=='
      const data = sameImage ? original : 'b3RoZXItaW1hZ2U='
      const receipt = { attachmentId: 'attachment-image', name: 'original.png' }
      const { bodies } = await mediaSession({ vision: true, mediaTools: undefined, conversationAttachments: {
        list: () => ({ files: [], nextOffset: null }),
        read: async () => ({ text: JSON.stringify(receipt), image: { data, mimeType: 'image/png' } }),
      } }, { name: 'conversation_attachment', input: { operation: 'read', attachmentId: receipt.attachmentId } },
      undefined, undefined, undefined, true)
      assert.equal(bodies.length, 2)
      const images = (body: typeof bodies[number]) => body.messages.flatMap(message => Array.isArray(message.content)
        ? message.content.flatMap(part => {
          if (!part || typeof part !== 'object' || !('image_url' in part)) return []
          const image = part.image_url
          return image && typeof image === 'object' && 'url' in image ? [image.url] : []
        }) : [])
      const originalUrl = `data:image/png;base64,${original}`
      assert.deepEqual(images(bodies[0]!), [originalUrl])
      assert.deepEqual(images(bodies[1]!), sameImage ? [originalUrl] : [originalUrl, `data:image/png;base64,${data}`])
      const result = bodies[1]!.messages.find(message => message.role === 'tool')!
      assert.deepEqual(JSON.parse(messageText(result.content)), receipt)
    })
  }
})

describe('browser instructions in real provider requests', () => {
  const cases: Array<{ name: string; overrides: Partial<PiAgentSessionConfig> }> = [
    { name: 'native general assistant', overrides: { useNativeSystemPrompt: true, disableSkills: true,
      transformSystemPrompt: translatePiNativeSystemPrompt, systemPrompt: 'IGNORED_NATIVE_OVERRIDE' } },
    { name: 'default employee', overrides: { systemPrompt: undefined, employeeProfile: { name: 'Researcher' } } },
    { name: 'custom employee', overrides: { systemPrompt: 'CUSTOM_EMPLOYEE_RULES', employeeProfile: { name: 'Researcher' } } },
    { name: 'discovered system override', overrides: { systemPrompt: undefined } },
    { name: 'arrangement node', overrides: { useNativeSystemPrompt: true, fixedSystemPrompt: 'NODE_EXECUTION_RULES',
      transformSystemPrompt: translatePiNativeSystemPrompt } },
  ]
  for (const entry of cases) {
    it(`includes browser rules once per request for ${entry.name}, without unavailable handoff tools`, async () => {
      const { bodies } = await mediaSession({ ...entry.overrides, mcpServers: [createPlaywrightMcpServer()] },
        undefined, jobView, entry.name === 'discovered system override' ? async root => {
          await mkdir(join(root, '.pi'), { recursive: true })
          await writeFile(join(root, '.pi', 'SYSTEM.md'), 'DISCOVERED_SYSTEM_RULES')
        } : undefined, async session => { await session.prompt('Continue the research.') })
      assert.equal(bodies.length, 2)
      for (const body of bodies) {
        const system = body.messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
        for (const guideline of PLAYWRIGHT_GUIDELINES) assert.equal(system.split(guideline).length - 1, 1)
        for (const guideline of PLAYWRIGHT_HANDOFF_GUIDELINES) assert.ok(!system.includes(guideline))
        assert.ok(!system.includes(BROWSER_MODE_TOOL))
        assert.ok(!body.tools?.some(tool => tool.function.name === BROWSER_MODE_TOOL))
        const navigation = body.tools?.find(tool => tool.function.name === 'mcp__playwright__browser_navigate')
        assert.equal(navigation?.function.description, 'Navigate to a URL', 'preserve the upstream tool contract')
        if (entry.name !== 'custom employee' && entry.name !== 'discovered system override') {
          for (const snippet of Object.values(PLAYWRIGHT_TOOL_SNIPPETS)) assert.ok(system.includes(snippet))
        }
        if (entry.name === 'custom employee') assert.ok(system.includes('CUSTOM_EMPLOYEE_RULES'))
        if (entry.name === 'discovered system override') assert.ok(system.includes('DISCOVERED_SYSTEM_RULES'))
        if (entry.name === 'arrangement node') assert.ok(system.includes('NODE_EXECUTION_RULES'))
      }
    })
  }

  it('adds handoff instructions only with the built-in mode tool', async t => {
    if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
      t.skip('Requires default browser configuration.'); return
    }
    const { bodies } = await mediaSession({ mcpServers: undefined, disableSkills: true,
      useNativeSystemPrompt: true, mediaTools: undefined })
    const system = bodies[0].messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
    for (const guideline of [...PLAYWRIGHT_GUIDELINES, ...PLAYWRIGHT_HANDOFF_GUIDELINES]) {
      assert.equal(system.split(guideline).length - 1, 1)
    }
    assert.ok(bodies[0].tools?.some(tool => tool.function.name === BROWSER_MODE_TOOL))
    assert.match(system, /watching automated actions/)
  })

  for (const overrides of [
    { mcpServers: [] },
    { mcpServers: undefined, disableTools: true },
    { mcpServers: undefined, toolPolicy: { ...readOnlyPolicy, allowedTools: [] } },
  ] satisfies Array<Partial<PiAgentSessionConfig>>) {
    it(`does not advertise browser rules without browser tools: ${JSON.stringify(overrides)}`, async () => {
      const { bodies } = await mediaSession(overrides)
      const system = bodies[0].messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
      assert.ok(!system.includes('浏览器使用规则：'))
      assert.ok(!bodies[0].tools?.some(tool => tool.function.name.startsWith('mcp__playwright__')))
    })
  }
})

describe('built-in browser handoff with the real Pi SDK', () => {
  it('classifies an ordinary site discovery, page read and personal center navigation without marking side effects routine', () => {
    const routine = (tool: string, input: unknown) => isRoutineBrowserCall(`mcp__playwright__browser_${tool}`, input)
    for (const url of ['https://search.example.test/?q=campus+jobs', 'https://jobs.example.test/', 'https://jobs.example.test/candidate/center']) {
      assert.equal(routine('navigate', { url }), true, url)
    }
    assert.equal(routine('snapshot', {}), true)
    assert.equal(routine('tabs', { action: 'list' }), true)
    assert.equal(routine('snapshot', { filename: 'local.md' }), false)
    assert.equal(routine('tabs', { action: 'close' }), false)
    assert.equal(routine('click', { target: 'e1' }), false)
    assert.equal(routine('type', { target: 'e2', text: 'form', submit: true }), false)
    for (const url of ['file:///private', 'http://127.0.0.1/', 'https://intranet.local/', 'https://user:password@example.test/',
      'https://jobs.example.test/%6Cogout', 'https://jobs.example.test/?action=delete', 'https://jobs.example.test/?next=/checkout']) {
      assert.equal(routine('navigate', { url }), false, url)
    }
  })

  it('opens, reads, follows a link and submits a form without an approval prompt', { timeout: 40_000 }, async t => {
    if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
      t.skip('Requires default browser configuration.'); return
    }
    const getContext = BrowserModeSession.prototype.getContext
    const contexts = new WeakSet()
    const visits: string[] = []
    t.mock.method(BrowserModeSession.prototype, 'getContext', async function (this: BrowserModeSession) {
      const context = await getContext.call(this)
      if (!contexts.has(context)) {
        contexts.add(context)
        await context.route('https://jobs.example.test/**', async route => {
          const path = new URL(route.request().url()).pathname
          visits.push(`${route.request().method()} ${path}`)
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: path === '/candidate/center'
            ? '<h1>Candidate center</h1><form method="post" action="/submit"><button>Submit</button></form>'
            : path === '/submit' ? '<h1>Form received</h1>'
              : '<h1>Campus jobs</h1><a href="/candidate/center">Candidate profile</a><script>document.querySelector("a").addEventListener("click", event => { event.preventDefault(); location.href = "/unexpected-click" })</script>' })
        })
      }
      return context
    })
    const navigate = 'mcp__playwright__browser_navigate'
    const click = 'mcp__playwright__browser_click'
    const approvals: string[] = []
    const broker = new ToolApprovals({ onRequest: request => { approvals.push(request.toolName); broker.respond({ requestId: request.requestId, approved: false }) } })
    const { bodies } = await mediaSession({ mcpServers: undefined, disableSkills: true,
      authorizeTool: (request, detection) => broker.requestTaskTool({ ...request, taskId: 'task', runId: 'run', subscriptionId: 'sub' }, detection) }, (step, last) => {
      if (step === 1) return { name: navigate, input: { url: 'https://jobs.example.test/' } }
      if (step === 2 || step === 4) return { name: 'mcp__playwright__browser_snapshot', input: {} }
      if (step === 3) return { name: click, input: { target: /link "Candidate profile" \[ref=((?:f\d+)?e\d+)\]/.exec(last)?.[1] ?? 'missing-ref' } }
      if (step === 5) return { name: click, input: { target: /button "Submit" \[ref=((?:f\d+)?e\d+)\]/.exec(last)?.[1] ?? 'missing-ref' } }
    })
    assert.deepEqual(approvals, [])
    assert.deepEqual(visits, ['GET /', 'GET /candidate/center', 'POST /submit'])
    const lastTool = (step: number) => messageText(bodies[step - 1].messages.filter(message => message.role === 'tool').at(-1)!.content)
    assert.match(lastTool(4), /https:\/\/jobs\.example\.test\/candidate\/center/)
    assert.match(lastTool(5), /Candidate center/)
    assert.match(lastTool(5), /button "Submit" \[ref=(?:f\d+)?e\d+\]/)
    assert.match(lastTool(6), /Page URL: https:\/\/jobs\.example\.test\/submit/)
  })

  it('sends only a validated browser summary for registered operations', async t => {
    if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
      t.skip('Requires default browser configuration.'); return
    }
    const cases = [
      { name: 'mcp__playwright__browser_navigate', input: { url: 'https://user:secret@example.test:8443/path?private=secret#section' },
        summary: { kind: 'browser-navigate', origin: 'https://example.test:8443' } },
      { name: 'mcp__playwright__browser_snapshot', input: { filename: 'private.md' },
        summary: { kind: 'browser-snapshot', savesFile: true } },
    ] as const
    for (const { name, input, summary } of cases) {
      const approvals: Array<Parameters<PiAgentSessionConfig['authorizeTool']>[0]> = []
      const { bodies } = await mediaSession({ mcpServers: undefined, disableSkills: true,
        authorizeTool: async request => { approvals.push(request); return false } }, { name, input })
      assert.deepEqual(approvals, [{ toolName: name, input: {}, registeredTool: true, summary }])
      assert.match(messageText(bodies[1].messages.find(message => message.role === 'tool')!.content), /User denied/)
    }
  })

  it('reuses handoff approval for inline snapshots in this turn, not for files or later turns', { timeout: 30_000 }, async t => {
    if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
      t.skip('Requires default browser configuration.'); return
    }
    const site = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<main><h1>Local snapshot fixture</h1></main>')
    })
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
    try {
      const address = site.address()
      assert.ok(address && typeof address !== 'string')
      const navigate = 'mcp__playwright__browser_navigate'
      const snapshot = 'mcp__playwright__browser_snapshot'
      const approvals: string[] = []
      const { bodies } = await mediaSession({ mcpServers: undefined, disableSkills: true, authorizeTool: async request => {
        approvals.push(request.toolName)
        return request.toolName === navigate || request.toolName === BROWSER_MODE_TOOL
      } }, [
        { name: navigate, input: { url: `http://127.0.0.1:${address.port}/` } },
        { name: BROWSER_MODE_TOOL, input: { mode: 'visible' } },
        { name: snapshot, input: {} },
        { name: snapshot, input: { filename: 'not-approved.md' } },
        undefined,
        { name: snapshot, input: {} },
      ], jobView, undefined, session => session.prompt('Start a new turn.'))
      assert.deepEqual(approvals, [navigate, BROWSER_MODE_TOOL, snapshot, snapshot])
      const lastTool = (step: number) => messageText(bodies[step - 1].messages.filter(message => message.role === 'tool').at(-1)?.content)
      assert.match(lastTool(4), /Local snapshot fixture/)
      assert.match(lastTool(5), /User denied/)
      assert.match(lastTool(7), /User denied/)
    } finally {
      site.closeAllConnections()
      await new Promise<void>(resolve => site.close(() => resolve()))
    }
  })

  const browserBinding = { browserArtifactTaskId: 'task', browserTaskStateDir: 'task' }
  const managedPolicy = { ...readOnlyPolicy, preset: 'workspace-edit' as const, approvalMode: 'confirm-each' as const,
    allowedTools: [...readOnlyPolicy.allowedTools, 'write', 'edit'], fileAccess: 'workspace' as const }
  const saveCall = { name: BROWSER_SAVE_ASSETS, input: { folder: 'media', refs: ['fb582074-ddc4-4e4b-8a39-8072dcb1dc8b'] } }

  it('asks before enabling a persistent profile in full-local auto mode', async t => {
    if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
      t.skip('Requires default browser configuration.'); return
    }
    const { approvals, bodies } = await mediaSession({ mcpServers: undefined, ...browserBinding,
      toolPolicy: { ...readOnlyPolicy, preset: 'full-local', approvalMode: 'auto-approve' },
    }, { name: BROWSER_MODE_TOOL, input: { mode: 'background', profile: 'persistent' } })
    assert.equal(approvals, 1)
    assert.match(messageText(bodies[1].messages.find(message => message.role === 'tool')!.content), /persistence was not approved/)
  })

  it('advertises scoped page tools but not the retired workflow, and asks before saving in full-local auto mode', async t => {
    if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
      t.skip('Requires default browser configuration.'); return
    }
    const { approvals, bodies } = await mediaSession({ mcpServers: undefined, useNativeSystemPrompt: true,
      ...browserBinding, toolPolicy: { ...readOnlyPolicy, preset: 'full-local', approvalMode: 'auto-approve' },
    }, saveCall)
    const names = bodies[0].tools?.map(tool => tool.function.name) ?? []
    for (const name of [BROWSER_EXTRACT, BROWSER_SCROLL, BROWSER_SAVE_ASSETS]) assert.ok(names.includes(name), name)
    assert.ok(!names.includes('mcp__playwright__browser_run_workflow'))
    const modeTool = bodies[0].tools?.find(tool => tool.function.name === BROWSER_MODE_TOOL)
    assert.match(JSON.stringify(modeTool), /"persistent"/)
    const system = bodies[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    assert.doesNotMatch(system, /browser_run_workflow|竞品采集/)
    assert.equal(approvals, 1)
    assert.match(messageText(bodies[1].messages.find(message => message.role === 'tool')!.content), /not approved/)
  })

  it('does not advertise the new page tools for a read-only policy without an explicit browser grant', async t => {
    if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
      t.skip('Requires default browser configuration.'); return
    }
    const { bodies } = await mediaSession({ mcpServers: undefined, useNativeSystemPrompt: true,
      browserArtifactTaskId: 'task', toolPolicy: { ...readOnlyPolicy, preset: 'read-only' },
    })
    const names = bodies[0].tools?.map(tool => tool.function.name) ?? []
    for (const name of [BROWSER_EXTRACT, BROWSER_SCROLL, BROWSER_SAVE_ASSETS]) assert.ok(!names.includes(name), name)
  })

  for (const fileAccess of ['workspace', 'local'] as const) {
    it(`advertises page tools for managed ${fileAccess} access without bypassing save approval`, async t => {
      if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
        t.skip('Requires default browser configuration.'); return
      }
      const { bodies, approvals } = await mediaSession({ mcpServers: undefined, ...browserBinding,
        toolPolicy: { ...managedPolicy, fileAccess } }, saveCall)
      const names = bodies[0].tools?.map(tool => tool.function.name) ?? []
      for (const name of [BROWSER_SCROLL, BROWSER_EXTRACT, BROWSER_SAVE_ASSETS]) assert.ok(names.includes(name), name)
      assert.ok(!names.includes('bash'))
      assert.equal(approvals, 1)
      assert.match(messageText(bodies[1].messages.find(message => message.role === 'tool')!.content), /not approved/)
    })
  }

  for (const [label, overrides] of [
    ['read-only', { toolPolicy: { ...managedPolicy, preset: 'read-only' } }],
    ['unattended', { toolPolicy: { ...managedPolicy, unattended: true } }],
    ['restricted paths', { toolPolicy: { ...managedPolicy, deniedPaths: ['results'] } }],
    ['missing artifact directory', { browserArtifactTaskId: undefined }],
  ] as const satisfies ReadonlyArray<readonly [string, Partial<PiAgentSessionConfig>]>) {
    it(`does not expose browser asset saving with ${label}`, async t => {
      if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
        t.skip('Requires default browser configuration.'); return
      }
      const defaults: Partial<PiAgentSessionConfig> = { mcpServers: undefined, ...browserBinding, toolPolicy: managedPolicy }
      const { bodies, approvals } = await mediaSession({ ...defaults, ...overrides }, saveCall)
      const names = bodies[0].tools?.map(tool => tool.function.name) ?? []
      assert.ok(!names.includes(BROWSER_SAVE_ASSETS))
      assert.equal(approvals, 0)
    })
  }

  for (const approvalMode of ['auto-approve', 'confirm-each'] as const) {
    it(`rejects a blank-window handoff in full-local ${approvalMode}`, async t => {
      if (process.env.SEP_MCP_CONFIG || process.env.SEP_PLAYWRIGHT_MCP === '0') {
        t.skip('Requires default browser configuration.'); return
      }
      const { approvals, bodies } = await mediaSession({ mcpServers: undefined, enableCommonTools: true,
        toolPolicy: { ...readOnlyPolicy, preset: 'full-local', approvalMode },
      }, { name: BROWSER_MODE_TOOL, input: { mode: 'visible' } })
      assert.equal(approvals, 0, 'do not request login completion for a blank browser')
      assert.match(messageText(bodies[1].messages.find(message => message.role === 'tool')!.content), /No target website is open/)
    })
  }
})

it('executes DingTalk messages and other connected business commands without prompting', async () => {
  const toolName = 'dingtalk_execute', body = '明天  9:00 开会。\n请带上材料。'
  const lookup = ['aisearch', 'person', '--query', '张三', '--dimension', 'name']
  const send = ['chat', '+dm', '--to', '张三', '--content', body]
  const verify = ['chat', '+chat-messages', '--user', 'opaque-id', '--no-reactions']
  const grant = ['pat', 'grant']
  const feishu = ['im', '+messages-send', '--text', body]
  const executed: string[][] = [], approvals: Array<Parameters<PiAgentSessionConfig['authorizeTool']>[0]> = []
  const broker = new ToolApprovals({ onRequest: request => { approvals.push(request); broker.respond({ requestId: request.requestId, approved: false }) } })
  await mediaSession({ connectorBinding: { revision: 'test', servers: [], fetch, commands: (['dingtalk', 'feishu'] as const).map(id => ({ id, name: id,
    instructions: { reference: 'reference', schema: 'schema', execute: 'execute' },
    reference: async () => '', schema: async () => ({ text: '', isError: false }), evaluateCommand: id === 'dingtalk' ? evaluateDingTalkCommand : undefined,
    execute: async args => { executed.push(args); return { text: 'fixture', isError: false } },
  })) }, authorizeTool: (request, detection) => broker.requestTaskTool({ ...request, taskId: 'task', runId: 'run', subscriptionId: 'sub' }, detection) },
  [...[lookup, send, send, verify, grant].map(args => ({ name: toolName, input: { args } })), { name: 'feishu_execute', input: { args: feishu } }])
  assert.deepEqual(executed, [lookup, send, send, verify, feishu])
  assert.equal(approvals.length, 1)
  assert.deepEqual(approvals[0].input, { args: grant })
})

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
  it('sends one validated replacement batch to the image host and projects business results only', async () => {
    const calls: unknown[] = []
    const args = { jobIds: ['cover-old', 'body-old'] }
    const mediaTools: MediaHostTools = { names: [...mediaNames, 'media_replace_images'], async execute(name, input) {
      assert.equal(name, 'media_replace_images')
      calls.push(input)
      return { replacements: [
        { originalJobId: 'cover-old', status: 'created', job: { ...jobView, providerSecret: 'private-provider-field' } },
        { originalJobId: 'body-old', status: 'skipped' },
      ] }
    } }
    const { bodies, approvals } = await mediaSession({ mediaTools, toolPolicy: { ...readOnlyPolicy, preset: 'workspace-edit', allowedTools: ['media_generate_image'] } },
      { name: 'media_replace_images', input: args })
    assert.ok(bodies[0].tools?.some(tool => tool.function.name === 'media_replace_images'))
    assert.deepEqual(calls, [args])
    assert.equal(approvals, 0)
    const text = messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content)
    assert.match(text, /cover-old.*created.*body-old.*skipped/)
    assert.doesNotMatch(text, /private-provider-field/)
    await mediaSession({ mediaTools }, { name: 'media_replace_images', input: { jobIds: ['cover-old', 'cover-old'] } })
    assert.deepEqual(calls, [args])
  })

  it('rejects images for a model explicitly marked as text-only before sending HTTP', async () => {
    await assert.rejects(mediaSession({ vision: false, mcpServers: [], getAccessToken: async () => { assert.fail('must not send an image request') } }, undefined, jobView, undefined, undefined, true), /不支持图片/)
    const { bodies } = await mediaSession({ vision: false, mcpServers: [] })
    assert.equal(bodies.length, 1)
    assert.equal(typeof bodies[0]?.messages.find(message => message.role === 'user')?.content, 'string')
  })

  it('preserves images when vision support is declared or unknown', async () => {
    for (const vision of [true, null]) {
      const { bodies } = await mediaSession({ vision, mcpServers: [] }, undefined, jobView, undefined, undefined, true)
      assert.ok(Array.isArray(bodies[0]?.messages.find(message => message.role === 'user')?.content))
    }
  })

  it('rejects historical images when resuming with a text-only model before HTTP or retries', async () => {
    let root = ''
    await mediaSession({ vision: true, mcpServers: [] }, undefined, jobView,
      async directory => { root = directory }, async first => {
        const resumed = await new PiCodingAgentAdapter().createSession({
          runId: 'run-text-only', modelId: 'model-a', vision: false, gatewayUrl: 'http://127.0.0.1:1/v1',
          workspaceDir: root, agentDir: join(root, 'text-agent'), sessionDir: join(root, 'sessions'),
          resumeSessionFile: first.sessionFile!, mcpServers: [],
          getAccessToken: async () => { assert.fail('must not send historical images') }, authorizeTool: async () => false,
        })
        const failures: string[] = [], retries: string[] = []
        resumed.subscribe(event => {
          if (event.failure) failures.push(event.failure)
          if (event.type === 'auto_retry_start') retries.push(event.type)
        })
        try {
          await resumed.prompt('Continue without a new attachment.')
          assert.match(failures.join('\n'), /不支持图片/)
          assert.deepEqual(retries, [])
        } finally { await resumed.dispose() }
      }, true)
  })
  it('sends attached conversation images to the SEP gateway', async () => {
    const { bodies } = await mediaSession({ mcpServers: [] }, undefined, jobView, undefined, undefined, true)
    const userContent = bodies[0]?.messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(userContent))
    assert.deepEqual(userContent, [
      { type: 'text', text: 'Run the requested operation.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2UtZGF0YQ==' } },
    ])
  })

  it('preserves nested V3 image hints and adapter metadata in the actual model continuation', async () => {
    const sizes = Array.from({ length: 128 }, (_, index) => `${1024 + index}x1024`)
    const profile = {
      profileId: 'image-v3', kind: 'image', displayName: 'Image V3', configVersion: 'cfg-v3',
      operations: ['generate', 'edit'], executionMode: 'sync-response',
      capabilities: { referenceImage: true, cancel: false, recoverByRequestId: false }, allowedAspectRatios: [],
      authorized: true,
      adapter: { id: 'sub2api-image', version: '3', available: true, operations: ['generate', 'edit'],
        referenceSupport: { maxCount: 4, maxInputBytes: 5242880, mimeTypes: ['image/png'] },
        supportsTaskQuery: false, supportsCancel: false },
      capabilityHints: [{ field: 'size', values: sizes, source: 'profile-config', observedAt: null, confidence: 'declared' },
        { field: 'quality', values: ['high'], source: 'Bearer private-hint-token', observedAt: null, confidence: 'unknown' }],
    }
    const { bodies } = await mediaSession({}, { name: 'media_get_capabilities', input: {} }, {
      capabilities: { protocolVersion: 3, defaultProfileId: profile.profileId, tools: mediaNames, profiles: [profile] },
      referenceAssets: [], apiKey: 'private-capability-key',
    })
    const text = messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content)
    const result = JSON.parse(text)
    const visible = result.capabilities.profiles[0]
    assert.deepEqual(visible.adapter, profile.adapter)
    assert.deepEqual(visible.capabilityHints[0], profile.capabilityHints[0])
    assert.equal(visible.capabilityHints[1].source, 'Bearer [redacted]')
    assert.doesNotMatch(text, /max-depth|private-hint-token|private-capability-key/)
    const definition = bodies[0].tools!.find(tool => tool.function.name === 'media_generate_image')!
    assert.match(definition.function.description, /ratio alone does not determine pixel dimensions/)
    assert.match(definition.function.description, /MISSING_SPEC/)
    assert.match(definition.function.description, /execute in the current turn without requesting confirmation of routine specifications/)
    assert.match(definition.function.description, /distinguish submitted, generated and saved/)
  })
  it('preserves a historical named image size when projecting the original job', async () => {
    const parameters = { aspectRatio: '1:1', count: 1, size: 'small', quality: 'standard' }
    const { bodies } = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, { ...jobView, parameters })
    const continuation = bodies.at(-1)!.messages.find(message => message.role === 'tool')!
    const result = JSON.parse(messageText(continuation.content))
    assert.equal(result.jobId, 'job-a')
    assert.deepEqual(result.parameters, parameters)
  })

  it('passes the Chinese submission cause to the model without request diagnostics', async () => {
    const { bodies } = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, {
      ...jobView, generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'STOPPED', error: 'QUERY_UNAVAILABLE',
      failure: { code: 'SERVICE_UNAVAILABLE', stage: 'image-submit', source: 'upstream', businessCode: 'PROVIDER_OVERLOADED',
        message: 'Supplier account disabled', requestId: 'private-request-id', httpStatus: 503 },
      canRetrySave: false, canResumeTracking: false,
    })
    const text = messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content)
    const result = JSON.parse(text)
    assert.match(result.issue, /提交结果尚未确认.*图片提交.*供应商.*停用/)
    assert.match(result.issue, /勿重复提交/)
    assert.equal(result.failure.stage, 'image-submit')
    assert.equal(result.canResumeTracking, false)
    assert.doesNotMatch(text, /Supplier account disabled|private-request-id|httpStatus/)
  })

  it('keeps indexed image output failures and gives the model a Chinese explanation', async () => {
    const { bodies } = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, {
      ...jobView, generationStatus: 'PARTIAL_SUCCEEDED', error: null,
      outputErrors: [{ index: 1, code: 'CONTENT_POLICY_VIOLATION' }],
    })
    const result = JSON.parse(messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content))
    assert.deepEqual(result.outputErrors, [{ index: 1, code: 'CONTENT_POLICY_VIOLATION' }])
    assert.match(result.issue, /第 2 项.*内容.*已生成的成果可继续使用/)
  })
  it('accepts SEP named image sizes as V3 job specifications', async () => {
    const { bodies } = await mediaSession({}, { name: 'media_get_job', input: { jobId: 'job-a' } }, {
      ...jobView, protocolVersion: 3, parameters: { ...generationInput.parameters, size: 'small' },
    })
    const result = JSON.parse(messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content))
    assert.equal(result.jobId, 'job-a')
    assert.equal(result.parameters.size, 'small')
  })
  it('explains contradictory image dimensions before dispatch without echoing the creative brief', async () => {
    const { bodies, executions } = await mediaSession({}, { name: 'media_generate_image', input: {
      creativeBrief: 'private creative brief', protocolVersion: 3, specRevision: 1,
      requestedSpec: { width: 800, height: 600, aspectRatio: '9:16' },
      parameterSources: { width: 'user', height: 'user', aspectRatio: 'model' },
    } })
    const resultText = messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content)
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
  it('only offers an image format correction for a confirmed unsubmitted adapter rejection', async () => {
    for (const submissionState of ['not_submitted', 'unknown']) {
      const result = new AppError('ADAPTER_FIELD_UNMAPPED', { details: {
        field: 'outputFormat', source: 'adapter', stage: 'image-quote', recovery: 'revise_request', submissionState,
      } })
      const { bodies } = await mediaSession({}, { name: 'media_generate_image', input: generationInput }, result)
      const toolResult = JSON.parse(messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content))
      assert.equal(toolResult.error.code, 'ADAPTER_FIELD_UNMAPPED')
      if (submissionState === 'not_submitted') {
        assert.match(toolResult.error.message, /模型自行填写.*重新报价一次/)
        assert.match(toolResult.error.message, /用户明确要求上游原生格式.*等待用户决定/)
      } else {
        assert.doesNotMatch(toolResult.error.message, /重新报价/)
      }
    }
  })
  it('rejects an upstream PNG format in the model tool arguments before invoking the image host', async () => {
    const { bodies, executions, approvals } = await mediaSession({}, { name: 'media_generate_image', input: {
      creativeBrief: '周年纪念海报', protocolVersion: 3, specRevision: 1,
      requestedSpec: { size: '1024x1536', count: 1, quality: 'high', outputFormat: 'image/png' },
      parameterSources: { size: 'model', count: 'model', quality: 'model' },
    } })
    assert.deepEqual(executions, [])
    assert.equal(approvals, 0)
    assert.match(messageText(bodies.at(-1)!.messages.find(message => message.role === 'tool')!.content), /outputFormat/)
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
    const prompt = bodies[0].messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
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
      const prompt = bodies[0].messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
      assert.equal(prompt.split('<employee_profile>').length, 2)
      assert.match(prompt, /不要求员工资料逐项列明这些手段/)
      assert.match(prompt, /工具可用性、费用及审批限制保持不变/)
      const tool = bodies[0].tools!.find(tool => tool.function.name === 'media_generate_image')!
      assert.match(tool.function.description, /actual authorization and protocol version/)
      assert.match(tool.function.description, /selected task reference images/)
      assert.equal(executions.length, 1)
    })
  }

  it('sends media resubmission rules in the general assistant system prompt across turns', async () => {
    const { bodies, executions, approvals } = await mediaSession({
      useNativeSystemPrompt: true, disableSkills: true, systemPrompt: undefined, employeeProfile: undefined,
    }, undefined, jobView, undefined, async session => { await session.prompt('What is the status of the original task?') })
    assert.equal(bodies.length, 2)
    for (const body of bodies) {
      assert.ok(body.tools?.some(tool => tool.function.name === 'media_generate_image'))
      const prompt = body.messages.filter(message => message.role === 'system').map(message => messageText(message.content)).join('\n')
      assert.match(prompt, /明确要求重新生成[^。]*独立的新任务/)
      assert.match(prompt, /提交状态未知时[^。]*只查询或恢复原任务/)
      assert.match(prompt, /确认被拒绝或尚未取得时[^。]*不要继续/)
      assert.match(prompt, /询问状态[^。]*不视为授权/)
    }
    assert.deepEqual(executions, [])
    assert.equal(approvals, 0)
  })

  it('injects a literal system prompt and registers strict TypeBox schemas without profile secrets', async () => {
    const { bodies, literalPrompt } = await mediaSession({})
    assert.ok(bodies[0].messages.some(message => message.role === 'system' &&
      typeof message.content === 'string' && message.content.includes(literalPrompt)))
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

  it('preserves image reference identities and projects out private source fields', async () => {
    const source = { localAssetId: 'ref-a', source: 'attachment', attachmentId: 'attachment-a', displayName: 'product.png' }
    const generated = { localAssetId: 'ref-b', source: 'generated', sourceArtifactId: 'output-a', jobId: 'job-a' }
    const { bodies } = await mediaSession({}, { name: 'media_get_capabilities', input: {} }, {
      capabilities: { protocolVersion: 1, tools: ['media_get_capabilities'], profiles: [] }, referenceAssets: [],
      referenceSources: [{ ...source, path: 'C:/private/image.png' }, { ...generated, apiKey: 'private-key' }],
    })
    const message = bodies[1].messages.find(message => message.role === 'tool')!
    const result = JSON.parse(messageText(message.content))
    assert.deepEqual(result.referenceSources, [source, generated])
    assert.doesNotMatch(JSON.stringify(result), /private-key|C:\/private/)
    const description = bodies[0].tools!.find(tool => tool.function.name === 'media_generate_image')!.function.description
    assert.match(description, /operation.*edit/)
    assert.match(description, /localAssetIds/)
  })

  it('does not invent media tools when the host has no capabilities', async () => {
    const { bodies, executions } = await mediaSession({ mediaTools: undefined }, { name: 'media_generate_image', input: generationInput })
    assert.ok(!bodies[0].tools?.some(tool => tool.function.name.startsWith('media_')))
    assert.deepEqual(executions, [])
  })
})
