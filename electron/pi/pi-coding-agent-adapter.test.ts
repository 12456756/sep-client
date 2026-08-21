import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { normalizeGatewayPayload } from './sdk/pi-coding-agent-adapter'

describe('SEP gateway payload compatibility', () => {
  it('flattens tool calls and tool results into supported messages', () => {
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
      { role: 'assistant', content: '[tool call: bash] {"command":"ls"}' },
      { role: 'user', content: '[tool result]\nfile-a.txt' },
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
