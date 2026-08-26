import { markWorkflowReady, nextWorkflowNodes, type WorkflowGraph, type WorkflowNodeState, updateWorkflowNode, workflowTerminalStatus } from './workflow-graph'

export interface WorkflowNodeExecutor {
  execute(node: WorkflowNodeState): Promise<unknown>
}

export interface WorkflowExecutionResult {
  graph: WorkflowGraph
  status: 'completed' | 'failed'
}

export class WorkflowExecutor {
  async run(graph: WorkflowGraph, executor: WorkflowNodeExecutor): Promise<WorkflowExecutionResult> {
    let current = markWorkflowReady(graph)
    while (workflowTerminalStatus(current) === 'running') {
      const ready = nextWorkflowNodes(current)
      if (ready.length === 0) break
      const results = await Promise.all(ready.map(async node => {
        current = updateWorkflowNode(current, node.id, { status: 'running' })
        try {
          return { node, output: await executor.execute(node) }
        } catch (error) {
          return { node, error: error instanceof Error ? error.message : 'Workflow node failed.' }
        }
      }))
      for (const result of results) {
        current = result.error
          ? updateWorkflowNode(current, result.node.id, { status: 'failed', error: result.error })
          : updateWorkflowNode(current, result.node.id, { status: 'completed', output: result.output })
      }
    }
    const status = workflowTerminalStatus(current)
    return { graph: current, status: status === 'completed' ? 'completed' : 'failed' }
  }
}
