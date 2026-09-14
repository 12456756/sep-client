import type { ArrangementNode } from './arrangement-plan'

/**
 * 已确认编排的纯状态机。
 *
 * 这里不读写文件，也不启动 worker，只根据节点依赖计算 ready、blocked、retry、resume
 * 等状态，并始终返回新的快照。持久化和实际执行分别由 data/runtime 层负责。
 */
export type ArrangementNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted' | 'stopped'
export type ArrangementExecutionStatus = 'queued' | 'running' | 'waiting-user' | 'interrupted' | 'completed' | 'stopped' | 'failed'

export interface ArrangementNodeCheckpoint {
  nodeId: string
  status: ArrangementNodeStatus
  attempt: number
  error: string | null
  output: string | null
}

export interface ArrangementExecutionState {
  status: ArrangementExecutionStatus
  nodes: ArrangementNodeCheckpoint[]
  failureNodeIds: string[]
  interruptionReason: 'client-exit' | 'client-crash' | 'runtime-error' | null
}

function descendantNodeIds(nodes: readonly ArrangementNode[], rootId: string): Set<string> {
  const result = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (result.has(node.id)) continue
      if (node.dependsOn.includes(rootId) || node.dependsOn.some(dependency => result.has(dependency))) {
        result.add(node.id)
        changed = true
      }
    }
  }
  return result
}

function nodeMap(state: ArrangementExecutionState): Map<string, ArrangementNodeCheckpoint> {
  return new Map(state.nodes.map(node => [node.nodeId, node]))
}

export function createArrangementExecutionState(nodes: readonly ArrangementNode[]): ArrangementExecutionState {
  const roots = new Set(nodes.filter(node => node.dependsOn.length === 0).map(node => node.id))
  return {
    status: 'queued',
    nodes: nodes.map(node => ({ nodeId: node.id, status: roots.has(node.id) ? 'ready' : 'pending', attempt: 0, error: null, output: null })),
    failureNodeIds: [],
    interruptionReason: null,
  }
}

export function markArrangementNodeRunning(state: ArrangementExecutionState, nodeId: string): ArrangementExecutionState {
  if (state.status === 'waiting-user' || state.status === 'stopped' || state.status === 'failed') return state
  const nodes = state.nodes.map(node => node.nodeId === nodeId && node.status === 'ready'
    ? { ...node, status: 'running' as const, attempt: node.attempt + 1 }
    : { ...node })
  return { ...state, status: 'running', nodes }
}

export function markArrangementNodeCompleted(
  state: ArrangementExecutionState,
  planNodes: readonly ArrangementNode[],
  nodeId: string,
  output: string | null = null,
): ArrangementExecutionState {
  const nextNodes = nodeMap(state)
  const current = nextNodes.get(nodeId)
  if (!current || current.status !== 'running') return state
  nextNodes.set(nodeId, { ...current, status: 'completed', output, error: null })
  for (const node of planNodes) {
    const checkpoint = nextNodes.get(node.id)
    if (!checkpoint || checkpoint.status !== 'pending') continue
    if (node.dependsOn.every(dependency => nextNodes.get(dependency)?.status === 'completed')) {
      nextNodes.set(node.id, { ...checkpoint, status: 'ready' })
    }
  }
  const ordered = [...nextNodes.values()]
  const status = ordered.every(node => node.status === 'completed') ? 'completed' : 'running'
  return { ...state, status, nodes: ordered }
}

export function markArrangementNodeFailed(
  state: ArrangementExecutionState,
  planNodes: readonly ArrangementNode[],
  nodeId: string,
  error: string,
): ArrangementExecutionState {
  const current = nodeMap(state).get(nodeId)
  if (!current || (current.status !== 'running' && current.status !== 'interrupted')) return state
  const blocked = descendantNodeIds(planNodes, nodeId)
  const nodes = state.nodes.map(node => {
    if (node.nodeId === nodeId) return { ...node, status: 'failed' as const, error }
    if (blocked.has(node.nodeId) && node.status !== 'completed') return { ...node, status: 'blocked' as const }
    if (node.status === 'ready' || node.status === 'pending') return { ...node, status: node.status }
    return { ...node }
  })
  return { ...state, status: 'waiting-user', nodes, failureNodeIds: [...new Set([...state.failureNodeIds, nodeId])] }
}

export function retryArrangementNode(
  state: ArrangementExecutionState,
  planNodes: readonly ArrangementNode[],
  nodeId: string,
): ArrangementExecutionState {
  if (state.status !== 'waiting-user') return state
  const failed = state.nodes.find(node => node.nodeId === nodeId && node.status === 'failed')
  if (!failed) return state
  const descendantsToRelease = descendantNodeIds(planNodes, nodeId)
  const nodes = state.nodes.map(node => {
    if (node.nodeId === nodeId) return { ...node, status: 'ready' as const, error: null }
    if (descendantsToRelease.has(node.nodeId) && node.status === 'blocked') return { ...node, status: 'pending' as const }
    return { ...node }
  })
  return {
    ...state,
    status: 'running',
    nodes,
    failureNodeIds: state.failureNodeIds.filter(id => id !== nodeId),
  }
}

export function stopArrangement(state: ArrangementExecutionState): ArrangementExecutionState {
  if (state.status === 'completed' || state.status === 'stopped') return state
  return { ...state, status: 'stopped', nodes: state.nodes.map(node => node.status === 'completed' ? { ...node } : { ...node, status: 'stopped' as const }) }
}

export function interruptArrangement(
  state: ArrangementExecutionState,
  reason: ArrangementExecutionState['interruptionReason'],
): ArrangementExecutionState {
  if (state.status === 'completed' || state.status === 'stopped') return state
  return {
    ...state,
    status: 'interrupted',
    interruptionReason: reason,
    nodes: state.nodes.map(node => node.status === 'running' ? { ...node, status: 'interrupted' as const } : { ...node }),
  }
}

export function resumeArrangement(state: ArrangementExecutionState): ArrangementExecutionState {
  if (state.status !== 'interrupted') return state
  return {
    ...state,
    status: 'running',
    interruptionReason: null,
    nodes: state.nodes.map(node => node.status === 'interrupted' ? { ...node, status: 'ready' as const } : { ...node }),
  }
}


