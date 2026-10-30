import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { finalResponseFromEvents, RunResponseBuffer } from './run-response'
import type { TaskExecutionEvent } from './types'

const event = (type: string, data: unknown): TaskExecutionEvent => ({
  taskId: 'task-a', runId: 'run-a', subscriptionId: 'employee-a', sequence: 1, occurredAt: 1, type, data,
})

describe('run response projection', () => {
  it('projects the final answer after multiple tools without preliminary promises', () => {
    assert.equal(finalResponseFromEvents([
      event('text_delta', { text: 'I will generate.' }), event('tool_execution_start', {}),
      event('text_delta', { text: 'Checking the result.' }), event('tool_execution_start', {}),
      event('tool_execution_start', {}), event('text_delta', null), event('text_delta', { text: '' }),
      event('text_delta', { text: 'Generated ' }), event('text_delta', { text: 'and saved.' }),
    ]), 'Generated and saved.')
  })

  it('preserves partial text if no final response arrives', () => {
    assert.equal(finalResponseFromEvents([event('text_delta', { text: 'Working.' }),
      event('tool_execution_start', {}), event('text_delta', { text: '' })]), 'Working.')
  })

  it('isolates runs and cleans up tool-only buffers', () => {
    const buffer = new RunResponseBuffer()
    buffer.append('a', 'before')
    buffer.append('b', 'other')
    buffer.markToolBoundary('a')
    buffer.markToolBoundary('empty')
    assert.deepEqual([...buffer.keys()], ['a', 'b', 'empty'])
    buffer.delete('empty')
    buffer.append('a', 'after')
    assert.equal(buffer.get('a'), 'after')
    assert.equal(buffer.get('b'), 'other')
    buffer.clear()
    assert.deepEqual([...buffer.keys()], [])
  })
})
