import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { createWorkflowGraph, nextWorkflowNodes, updateWorkflowNode, validateWorkflowNodes, workflowTerminalStatus, WorkflowGraphError } from './workflow-graph'

const nodes = [
  { id: 'research', subscriptionId: 'employee-a', instruction: 'Research', dependsOn: [] },
  { id: 'write', subscriptionId: 'employee-b', instruction: 'Write', dependsOn: ['research'] },
  { id: 'publish', subscriptionId: 'employee-c', instruction: 'Publish', dependsOn: ['write'] },
]

describe('workflow graph domain', () => {
  it('rejects cycles and missing dependencies', () => {
    assert.throws(() => validateWorkflowNodes([{ ...nodes[0], dependsOn: ['missing'] }]), WorkflowGraphError)
    assert.throws(() => validateWorkflowNodes([{ ...nodes[0], dependsOn: ['research'] }]), WorkflowGraphError)
  })

  it('schedules dependencies in order and blocks failed descendants', () => {
    let graph = createWorkflowGraph(nodes)
    assert.deepEqual(nextWorkflowNodes(graph).map(node => node.id), ['research'])
    graph = updateWorkflowNode(graph, 'research', { status: 'running' })
    graph = updateWorkflowNode(graph, 'research', { status: 'failed', error: 'no result' })
    assert.equal(graph.nodes.find(node => node.id === 'write')?.status, 'blocked')
    assert.equal(workflowTerminalStatus(graph), 'failed')
  })

  it('allows retry after successful recovery', () => {
    let graph = createWorkflowGraph(nodes)
    graph = updateWorkflowNode(graph, 'research', { status: 'completed', output: 'notes' })
    assert.deepEqual(nextWorkflowNodes(graph).map(node => node.id), ['write'])
    graph = updateWorkflowNode(graph, 'write', { status: 'completed', output: 'draft' })
    graph = updateWorkflowNode(graph, 'publish', { status: 'completed' })
    assert.equal(workflowTerminalStatus(graph), 'completed')
  })
})
