import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { normalizeGatewayPayload, sessionToolOptions, classifyToolFailure, buildGatewayRequestLogFields, buildGatewayThinkingLogFields } from './pi-coding-agent-adapter'

const readOnlyPolicy = {
  allowedTools: ['read', 'grep', 'find', 'ls'],
  allowedPaths: [],
  deniedPaths: [],
  commandPolicy: 'disabled' as const,
  approvalMode: 'auto-approve' as const,
  workspaceDir: 'C:/workspace',
}

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
      requestId: 42, model: 'model-a', messageCount: 3, outputLimit: 16_384, temperature: 0.2,
      stream: true, includeUsage: true, toolCount: 2, tools: 'read, write',
    })
  })

  it('tolerates absent metadata and malformed tool definitions', () => {
    assert.deepEqual(buildGatewayRequestLogFields({ tools: [null, {}, { function: { name: 12 } }] }, 7), {
      requestId: 7, model: undefined, messageCount: 0, outputLimit: undefined,
      temperature: undefined, stream: undefined, includeUsage: undefined, toolCount: 0,
    })
  })

  it('reads the SDK output budget before the shared gateway conversion', () => {
    assert.equal(buildGatewayRequestLogFields({ max_completion_tokens: 2048 }, 42).outputLimit, 2048)
    assert.equal(buildGatewayRequestLogFields({ max_tokens: 128, max_completion_tokens: 2048 }, 42).outputLimit, 128)
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

  it('maps SDK completion limits to gateway max_tokens without losing the budget', () => {
    const base = { model: 'deepseek', messages: [{ role: 'user', content: 'hello' }] }
    assert.deepEqual(normalizeGatewayPayload({ ...base, max_completion_tokens: 4096 }), { ...base, max_tokens: 4096 })
    assert.deepEqual(normalizeGatewayPayload({ ...base, max_tokens: 128, max_completion_tokens: 4096 }), { ...base, max_tokens: 128 })
    for (const invalid of [0, -1, 1.5, '4096', NaN]) {
      assert.deepEqual(normalizeGatewayPayload({ ...base, max_completion_tokens: invalid }), base)
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

  it('maps the SDK output limit to the gateway field without duplicates', () => {
    assert.deepEqual(normalizeGatewayPayload({
      model: 'model-a', messages: [], max_completion_tokens: 16384,
    }), { model: 'model-a', messages: [], max_tokens: 16384 })
  })

  it('preserves a valid gateway limit and falls back to the SDK limit otherwise', () => {
    const base = { model: 'model-a', messages: [] }
    assert.deepEqual(normalizeGatewayPayload({ ...base, max_tokens: 128, max_completion_tokens: 4096 }),
      { ...base, max_tokens: 128 })
    assert.deepEqual(normalizeGatewayPayload({ ...base, max_tokens: 0, max_completion_tokens: 16384 }),
      { ...base, max_tokens: 16384 })
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
