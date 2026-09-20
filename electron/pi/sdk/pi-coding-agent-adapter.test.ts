import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { normalizeGatewayPayload, sessionToolOptions, classifyToolFailure } from './pi-coding-agent-adapter'

const readOnlyPolicy = {
  allowedTools: ['read', 'grep', 'find', 'ls'],
  allowedPaths: [],
  deniedPaths: [],
  commandPolicy: 'disabled' as const,
  approvalMode: 'auto-approve' as const,
  workspaceDir: 'C:/workspace',
}

describe('task tool policy session options', () => {
  it('advertises policy tools plus unrestricted web search', () => {
    assert.deepEqual(sessionToolOptions(readOnlyPolicy), {
      tools: ['read', 'grep', 'find', 'ls', 'web_search'],
    })
  })

  it('keeps web search available for an otherwise empty policy', () => {
    assert.deepEqual(sessionToolOptions({ ...readOnlyPolicy, allowedTools: [] }), {
      tools: ['web_search'],
    })
  })

  it('advertises default tools plus web search when no task policy is present', () => {
    assert.deepEqual(sessionToolOptions(undefined), {
      tools: ['read', 'bash', 'edit', 'write', 'web_search'],
    })
  })

  it('can disable all tools for planner sessions', () => {
    assert.deepEqual(sessionToolOptions(undefined, true), {
      noTools: 'all',
    })
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
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        },
        { role: 'tool', content: 'file-a.txt', tool_call_id: 'call-1' },
      ],
    }) as { messages: Array<Record<string, unknown>> }

    assert.deepEqual(result.messages, [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', content: 'file-a.txt', tool_call_id: 'call-1' },
    ])
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
    })
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
