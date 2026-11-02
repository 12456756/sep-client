import type { ArrangementNode } from './arrangement-plan'
import type { DeliveryIssue, NodeDeliveryProgress } from './arrangement-delivery'
import type { ModelRequestProgress } from './model-request-progress'
import { arrangementInputReplySchema, type ArrangementInputRequest, type ArrangementInputReply } from '../../src/shared/arrangement-input'

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
  /** Last attempt that durably registered this node’s Pi session. */
  sessionRunId?: string
  error: string | null
  output: string | null
  pendingConfirmation?: boolean
  delivery?: NodeDeliveryProgress
  modelRequestProgress?: ModelRequestProgress
  inputRequest?: ArrangementInputRequest
  /** User-owned reply persisted before admission so a restart cannot lose it. */
  inputReply?: ArrangementInputReply
  mediaSpecRevisions?: Record<string, number>
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
    nodes: nodes.map(node => ({ nodeId: node.id, status: roots.has(node.id) ? 'ready' : 'pending', attempt: 0, error: null, output: null, pendingConfirmation: false })),
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
  const pendingConfirmation = planNodes.find(node => node.id === nodeId)?.requiresUserConfirmation === true
  nextNodes.set(nodeId, { ...current, status: 'completed', output, error: null, pendingConfirmation })
  for (const node of planNodes) {
    const checkpoint = nextNodes.get(node.id)
    if (!checkpoint || checkpoint.status !== 'pending') continue
    if (node.dependsOn.every(dependency => nextNodes.get(dependency)?.status === 'completed' && !nextNodes.get(dependency)?.pendingConfirmation)) {
      nextNodes.set(node.id, { ...checkpoint, status: 'ready' })
    }
  }
  const ordered = [...nextNodes.values()]
  const status = ordered.some(node => node.status === 'running' || node.status === 'ready') ? 'running'
    : ordered.some(node => node.pendingConfirmation) ? 'waiting-user'
      : ordered.every(node => node.status === 'completed') ? 'completed'
        : ordered.some(node => node.status === 'failed' || node.inputRequest) ? 'waiting-user' : 'running'
  return { ...state, status, nodes: ordered }
}

export function confirmArrangementNode(state: ArrangementExecutionState, planNodes: readonly ArrangementNode[], nodeId: string): ArrangementExecutionState {
  if (state.status === 'stopped' || state.status === 'completed') return state
  const current = state.nodes.find(node => node.nodeId === nodeId)
  if (!current || current.status !== 'completed' || !current.pendingConfirmation) return state
  const nodes = state.nodes.map(node => node.nodeId === nodeId ? { ...node, pendingConfirmation: false } : { ...node })
  const completed = new Set(nodes.filter(node => node.status === 'completed' && !node.pendingConfirmation).map(node => node.nodeId))
  const released = nodes.map(node => {
    if (node.status !== 'pending') return node
    const planNode = planNodes.find(item => item.id === node.nodeId)
    return planNode?.dependsOn.every(id => completed.has(id)) ? { ...node, status: 'ready' as const } : node
  })
  const status = released.some(node => node.status === 'running' || node.status === 'ready') ? 'running'
    : released.some(node => node.status === 'failed' || node.pendingConfirmation || node.inputRequest) ? 'waiting-user'
      : released.every(node => node.status === 'completed') ? 'completed' : 'running'
  return { ...state, status, nodes: released }
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
  const active = nodes.some(node => node.status === 'running' || node.status === 'ready')
  return { ...state, status: active ? 'running' : 'waiting-user', nodes, failureNodeIds: [...new Set([...state.failureNodeIds, nodeId])] }
}

export function markArrangementNodeWaitingForInput(
  state: ArrangementExecutionState, planNodes: readonly ArrangementNode[], nodeId: string, inputRequest: ArrangementInputRequest,
): ArrangementExecutionState {
  const current = nodeMap(state).get(nodeId)
  if (!current || current.status !== 'running') return state
  const blocked = descendantNodeIds(planNodes, nodeId)
  const nodes = state.nodes.map(node => node.nodeId === nodeId
    ? { ...node, status: 'interrupted' as const, error: null, inputRequest: structuredClone(inputRequest), inputReply: undefined }
    : blocked.has(node.nodeId) && node.status !== 'completed' ? { ...node, status: 'blocked' as const } : { ...node })
  return { ...state, status: nodes.some(node => node.status === 'running' || node.status === 'ready') ? 'running' : 'waiting-user', nodes }
}

export function retryArrangementNode(
  state: ArrangementExecutionState,
  planNodes: readonly ArrangementNode[],
  nodeId?: string,
  inputReply?: ArrangementInputReply,
): ArrangementExecutionState {
  if (state.status !== 'waiting-user' && state.status !== 'failed' && !(state.status === 'running' && nodeId)) return state
  if (!nodeId && state.nodes.some(node => node.pendingConfirmation)) return state
  if (inputReply && (!nodeId || !arrangementInputReplySchema.safeParse(inputReply).success ||
    !state.nodes.some(node => node.nodeId === nodeId && node.inputRequest?.requestId === inputReply.requestId))) return state
  if (inputReply && state.nodes.find(node => node.nodeId === nodeId)?.inputRequest?.requirements.some(requirement =>
    !Number.isSafeInteger((requirement.specRevision ?? 0) + 1))) return state
  const retryIds = new Set(state.nodes.filter(node => (!nodeId || node.nodeId === nodeId) &&
    (inputReply ? node.inputRequest?.requestId === inputReply.requestId && node.status === 'interrupted' : node.status === 'failed')).map(node => node.nodeId))
  if (retryIds.size === 0) return state
  const descendantsToRelease = new Set([...retryIds].flatMap(id => [...descendantNodeIds(planNodes, id)]))
  const stillBlocked = new Set(state.nodes.filter(node => (node.status === 'failed' || node.inputRequest) && !retryIds.has(node.nodeId))
    .flatMap(node => [...descendantNodeIds(planNodes, node.nodeId)]))
  const completedIds = new Set(state.nodes.filter(node => node.status === 'completed' && !node.pendingConfirmation).map(node => node.nodeId))
  const nodes = state.nodes.map(node => {
    // An explicit retry starts a fresh validation count; pause/resume preserves it.
    if (retryIds.has(node.nodeId)) return { ...node, status: 'ready' as const, error: null, inputRequest: undefined,
      ...(inputReply ? { inputReply: structuredClone(inputReply), mediaSpecRevisions: { ...node.mediaSpecRevisions,
        ...Object.fromEntries((node.inputRequest?.requirements ?? []).map(requirement => [requirement.id, (requirement.specRevision ?? 0) + 1])) } } : {}),
      ...(node.delivery ? { delivery: { ...node.delivery, validationAttempts: 0 } } : {}) }
    if (descendantsToRelease.has(node.nodeId) && !stillBlocked.has(node.nodeId) && node.status === 'blocked') {
      const ready = planNodes.find(item => item.id === node.nodeId)!.dependsOn.every(id => completedIds.has(id))
      return { ...node, status: ready ? 'ready' as const : 'pending' as const }
    }
    return { ...node }
  })
  return {
    ...state,
    status: 'running',
    nodes,
    failureNodeIds: state.failureNodeIds.filter(id => !retryIds.has(id)),
  }
}

export function stopArrangement(state: ArrangementExecutionState): ArrangementExecutionState {
  if (state.status === 'completed' || state.status === 'stopped') return state
  return { ...state, status: 'stopped', nodes: state.nodes.map(node => node.status === 'completed' ? { ...node } : { ...node, status: 'stopped' as const }) }
}

export function reopenArrangementNodeForRepair(state: ArrangementExecutionState, planNodes: readonly ArrangementNode[], nodeId: string, issues: readonly DeliveryIssue[]): ArrangementExecutionState {
  if (state.status === 'stopped') return state
  const affected = descendantNodeIds(planNodes, nodeId)
  affected.add(nodeId)
  return { ...state, status: 'running', failureNodeIds: state.failureNodeIds.filter(id => !affected.has(id)),
    nodes: state.nodes.map(node => {
      if (!affected.has(node.nodeId)) return node
      return { ...node, status: node.nodeId === nodeId ? 'ready' : 'pending', error: null, output: null, pendingConfirmation: false,
        delivery: { validationAttempts: node.delivery?.validationAttempts ?? 0, finalFiles: [],
          issues: node.nodeId === nodeId ? [...issues] : [{ code: 'PREDECESSOR_REPAIRED', message: '前置成果需要恢复或修复。重新读取本次提供的已核验前置成果，重新核实受影响的本节点文件；保留其他有效工作，不得使用旧版本直接交付。' }] } }
    }) }
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
  const resumed = {
    ...state,
    status: state.nodes.some(node => node.status === 'interrupted' && !node.inputRequest || node.status === 'ready') ? 'running' as const
      : state.nodes.some(node => node.pendingConfirmation || node.inputRequest) ? 'waiting-user' as const : 'running' as const,
    interruptionReason: null,
    nodes: state.nodes.map(node => node.status === 'interrupted' && !node.inputRequest ? { ...node, status: 'ready' as const } : { ...node }),
  }
  return resumed
}


