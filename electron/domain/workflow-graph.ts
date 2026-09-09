export type WorkflowNodeStatus = 'pending' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'skipped'

export interface WorkflowNodeDefinition {
  id: string
  subscriptionId: string
  instruction: string
  dependsOn: string[]
  expectedOutput?: string
  inputMapping?: Record<string, string>
}

export interface WorkflowNodeState extends WorkflowNodeDefinition {
  status: WorkflowNodeStatus
  output?: unknown
  error?: string
  attempts: number
}

export interface WorkflowGraph {
  version: 1
  nodes: WorkflowNodeState[]
}

export class WorkflowGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowGraphError'
  }
}

export function validateWorkflowNodes(nodes: WorkflowNodeDefinition[]): WorkflowNodeDefinition[] {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new WorkflowGraphError('A workflow must contain at least one node.')
  const ids = new Set<string>()
  for (const node of nodes) {
    if (!node || !/^[A-Za-z0-9_-]{1,128}$/.test(node.id)) throw new WorkflowGraphError('Workflow node IDs must be safe and non-empty.')
    if (ids.has(node.id)) throw new WorkflowGraphError(`Duplicate workflow node: ${node.id}`)
    ids.add(node.id)
    if (typeof node.subscriptionId !== 'string' || !node.subscriptionId) throw new WorkflowGraphError(`Node ${node.id} has no employee.`)
    if (typeof node.instruction !== 'string' || !node.instruction.trim()) throw new WorkflowGraphError(`Node ${node.id} has no instruction.`)
    if (!Array.isArray(node.dependsOn) || new Set(node.dependsOn).size !== node.dependsOn.length) throw new WorkflowGraphError(`Node ${node.id} has invalid dependencies.`)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new WorkflowGraphError(`Node ${node.id} depends on missing node ${dependency}.`)
      if (dependency === node.id) throw new WorkflowGraphError(`Node ${node.id} cannot depend on itself.`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(nodes.map(node => [node.id, node]))
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new WorkflowGraphError('Workflow dependencies must be acyclic.')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  nodes.forEach(node => visit(node.id))
  return nodes.map(node => ({ ...node, dependsOn: [...node.dependsOn], inputMapping: node.inputMapping ? { ...node.inputMapping } : undefined }))
}

export function createWorkflowGraph(nodes: WorkflowNodeDefinition[]): WorkflowGraph {
  return { version: 1, nodes: validateWorkflowNodes(nodes).map(node => ({ ...node, status: node.dependsOn.length ? 'pending' : 'ready', attempts: 0 })) }
}

export function markWorkflowReady(graph: WorkflowGraph): WorkflowGraph {
  const states = new Map(graph.nodes.map(node => [node.id, node]))
  return { ...graph, nodes: graph.nodes.map(node => {
    if (node.status !== 'pending' && node.status !== 'blocked') return { ...node }
    const dependencies = node.dependsOn.map(id => states.get(id))
    if (dependencies.some(item => item?.status === 'failed' || item?.status === 'blocked')) return { ...node, status: 'blocked' }
    if (dependencies.every(item => item?.status === 'completed' || item?.status === 'skipped')) return { ...node, status: 'ready' }
    return { ...node }
  }) }
}

export function nextWorkflowNodes(graph: WorkflowGraph): WorkflowNodeState[] {
  return markWorkflowReady(graph).nodes.filter(node => node.status === 'ready').map(node => ({ ...node }))
}

export function updateWorkflowNode(
  graph: WorkflowGraph,
  nodeId: string,
  update: Pick<WorkflowNodeState, 'status'> & Partial<Pick<WorkflowNodeState, 'output' | 'error'>>,
): WorkflowGraph {
  if (!graph.nodes.some(node => node.id === nodeId)) throw new WorkflowGraphError(`Unknown workflow node: ${nodeId}`)
  const next = graph.nodes.map(node => node.id === nodeId
    ? { ...node, ...update, attempts: update.status === 'running' ? node.attempts + 1 : node.attempts }
    : { ...node })
  return markWorkflowReady({ ...graph, nodes: next })
}

export function workflowTerminalStatus(graph: WorkflowGraph): 'completed' | 'failed' | 'running' {
  if (graph.nodes.some(node => node.status === 'failed' || node.status === 'blocked')) return 'failed'
  if (graph.nodes.every(node => node.status === 'completed' || node.status === 'skipped')) return 'completed'
  return 'running'
}
