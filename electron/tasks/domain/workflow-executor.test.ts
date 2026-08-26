import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createWorkflowGraph } from './workflow-graph'
import { WorkflowExecutor } from './workflow-executor'

describe('WorkflowExecutor', () => {
  it('runs independent nodes concurrently and blocks dependents after failure', async () => {
    const graph = createWorkflowGraph([
      { id: 'a', employeeInstanceId: 'employee-a', instruction: 'a', dependsOn: [] },
      { id: 'b', employeeInstanceId: 'employee-b', instruction: 'b', dependsOn: [] },
      { id: 'c', employeeInstanceId: 'employee-c', instruction: 'c', dependsOn: ['a'] },
    ])
    const started: string[] = []
    const result = await new WorkflowExecutor().run(graph, {
      async execute(node) {
        started.push(node.id)
        if (node.id === 'a') throw new Error('failed')
        return node.id
      },
    })
    assert.deepEqual(started.sort(), ['a', 'b'])
    assert.equal(result.status, 'failed')
    assert.equal(result.graph.nodes.find(node => node.id === 'c')?.status, 'blocked')
  })
})
