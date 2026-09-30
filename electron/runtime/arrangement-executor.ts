/**
 * 编排式任务的节点执行器。
 *
 * 执行器读取已确认的 WorkPlan，从持久化状态中找出可运行节点；无依赖的节点并行执行，
 * 节点完成后才释放下游节点。每个节点拥有独立的 run 和 worker，但通过提示词接收依赖
 * 节点的文本产出；检查点、审批和运行事件都通过注入的端口交给外层处理。
 */
import { randomUUID } from 'node:crypto'
import type { TaskExecutionEvent } from '../../src/shared/types'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskRunStorePort } from '../data/task-run-store'
import type { ArrangementCheckpoint, ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import type { WorkPlan, ArrangementNode, EffectiveTaskPermissionPolicy } from '../domain/arrangement-plan'
import type { TaskManager } from './task-manager'
import {
  createArrangementExecutionState,
  markArrangementNodeCompleted,
  markArrangementNodeFailed,
  markArrangementNodeRunning,
  resumeArrangement,
  retryArrangementNode,
  interruptArrangement,
  stopArrangement,
  type ArrangementExecutionState,
} from '../domain/arrangement-execution'
import type { EmployeeRuntimeConfig, TaskToolPolicy, TaskWorkerPort } from './run-types'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'

export interface ArrangementExecutionResult {
  status: ArrangementExecutionState['status']
  state: ArrangementExecutionState
  error?: string
}

export interface ArrangementExecutionOptions {
  scope: TaskOwnerScope | null
  taskManager: TaskManager
  taskRunStore: TaskRunStorePort | null
  checkpointStore: ArrangementCheckpointStorePort | null
  createWorker: (options: PiTaskWorkerOptions) => TaskWorkerPort
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  onApprovalRequest: PiTaskWorkerOptions['onApprovalRequest']
  onEvent: (event: TaskExecutionEvent) => Promise<void>
  authorizeEmployee: (subscriptionId: string) => Promise<EmployeeRuntimeConfig | null>
  workspaceRoot: string
  arrangementSubscriptionId: string
}

export interface ArrangementNodeEvent {
  type: 'arrangement_node_started' | 'arrangement_node_completed' | 'arrangement_node_failed' | 'arrangement_state_changed'
  arrangementRunId: string
  nodeId?: string
  nodeRunId?: string
  subscriptionId?: string
  attempt?: number
  data?: unknown
}

export function buildArrangementNodePrompt(plan: WorkPlan, node: ArrangementNode, dependencies: readonly { node: ArrangementNode; output: string | null }[]): string {
  const dependencyText = dependencies.length === 0
    ? '没有可用的前置节点输出。'
    : dependencies.map(({ node: dependency, output }) => [
      `前置节点：${dependency.title}（${dependency.id}）`,
      output?.trim() || '（前置节点完成时没有产生文本输出。）',
    ].join('\n')).join('\n\n')
  return [
    '你正在执行编排工作计划中的一个节点。',
    `总体目标：\n${plan.goal}`,
    `当前节点：\n${node.title}（${node.id}）`,
    `节点执行指令：\n${node.instruction}`,
    `预期输出：\n${node.expectedOutput}`,
    `前置节点输出：\n${dependencyText}`,
    '共享工作区：\n只能使用分配的共享工作区，不要重放或虚构前置节点的工具调用。',
    '请返回可供后续节点使用的简洁结果，不要透露隐藏的推理过程。',
  ].join('\n\n')
}

function toToolPolicy(policy: EffectiveTaskPermissionPolicy, workspaceDir: string): TaskToolPolicy {
  return {
    allowedTools: [...policy.allowedTools],
    allowedPaths: [...policy.allowedPaths],
    deniedPaths: [...policy.deniedPaths],
    commandPolicy: policy.commandPolicy,
    approvalMode: policy.approvalMode ?? 'confirm-each',
    workspaceDir,
  }
}

function nodeMap(plan: WorkPlan): Map<string, ArrangementNode> {
  return new Map(plan.nodes.map(node => [node.id, node]))
}

export class ArrangementExecutor {
  private readonly activeWorkers = new Map<string, TaskWorkerPort>()
  private abortRequested = false
  private stopRequested = false

  constructor(private readonly options: ArrangementExecutionOptions) {}

  async abort(): Promise<void> {
    this.abortRequested = true
    await Promise.all([...this.activeWorkers.values()].map(worker => worker.abort().catch(() => undefined)))
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    await this.abort()
  }

  async execute(plan: WorkPlan, taskId: string, arrangementRunId: string, requestedState?: ArrangementExecutionState): Promise<ArrangementExecutionResult> {
    this.abortRequested = false
    this.stopRequested = false
    const state = await this.loadState(plan, taskId, arrangementRunId, requestedState)
    await this.persist(plan, taskId, arrangementRunId, state)
    if (state.status === 'completed' || state.status === 'stopped' || state.status === 'waiting-user') return { status: state.status, state }

    let current = state
    const nodes = nodeMap(plan)
    while (!this.abortRequested) {
      const ready = current.nodes.filter(node => node.status === 'ready')
      if (ready.length === 0) {
        if (current.nodes.some(node => node.status === 'running')) continue
        return { status: current.status, state: current }
      }

      const batch = ready.map(checkpoint => {
        current = markArrangementNodeRunning(current, checkpoint.nodeId)
        return { checkpoint: current.nodes.find(node => node.nodeId === checkpoint.nodeId)!, node: nodes.get(checkpoint.nodeId)! }
      })
      await this.persist(plan, taskId, arrangementRunId, current)
      const results = await Promise.all(batch.map(item => this.executeNode(plan, taskId, arrangementRunId, item.node, item.checkpoint, current)))

      if (this.abortRequested) {
        current = this.stopRequested
          ? stopArrangement(current)
          : interruptArrangement(current, 'client-exit')
        await this.persist(plan, taskId, arrangementRunId, current)
        return { status: current.status, state: current }
      }

      for (const result of results) {
        if (result.ok) current = markArrangementNodeCompleted(current, plan.nodes, result.nodeId, result.output)
        else current = markArrangementNodeFailed(current, plan.nodes, result.nodeId, result.error)
        await this.persist(plan, taskId, arrangementRunId, current)
        await this.emitStateEvent(plan, taskId, arrangementRunId, current, result.nodeId)
      }
      if (results.some(result => !result.ok)) return { status: current.status, state: current, error: results.find(result => !result.ok)?.error }
    }

    current = this.stopRequested
      ? stopArrangement(current)
      : interruptArrangement(current, 'client-exit')
    await this.persist(plan, taskId, arrangementRunId, current)
    return { status: current.status, state: current }
  }

  retry(state: ArrangementExecutionState, plan: WorkPlan, nodeId: string): ArrangementExecutionState {
    return retryArrangementNode(state, plan.nodes, nodeId)
  }

  resume(state: ArrangementExecutionState): ArrangementExecutionState {
    return resumeArrangement(state)
  }

  private async loadState(plan: WorkPlan, taskId: string, arrangementRunId: string, requestedState?: ArrangementExecutionState): Promise<ArrangementExecutionState> {
    if (requestedState) return requestedState.status === 'interrupted' ? resumeArrangement(requestedState) : requestedState
    if (this.options.scope && this.options.checkpointStore) {
      const checkpoint = await this.options.checkpointStore.get(this.options.scope, taskId)
      if (checkpoint?.planHash === plan.planHash) {
        return checkpoint.state.status === 'interrupted' ? resumeArrangement(checkpoint.state) : checkpoint.state
      }
    }
    void arrangementRunId
    return createArrangementExecutionState(plan.nodes)
  }

  private async executeNode(
    plan: WorkPlan,
    taskId: string,
    arrangementRunId: string,
    node: ArrangementNode,
    checkpoint: ArrangementExecutionState['nodes'][number],
    state: ArrangementExecutionState,
  ): Promise<{ ok: true; nodeId: string; output: string | null } | { ok: false; nodeId: string; error: string }> {
    if (this.abortRequested) return { ok: false, nodeId: node.id, error: 'Arrangement execution was interrupted.' }
    const employee = await this.options.authorizeEmployee(node.subscriptionId)
    if (!employee) return { ok: false, nodeId: node.id, error: 'The selected employee is no longer available.' }
    if (this.abortRequested) return { ok: false, nodeId: node.id, error: 'Arrangement execution was interrupted.' }
    const nodeRunId = randomUUID()
    const workspaceDir = plan.workspace.path ?? this.options.workspaceRoot
    const paths = this.options.scope && this.options.taskRunStore
      ? this.options.taskRunStore.getPaths(this.options.scope, taskId, nodeRunId)
      : null
    const dependencies = node.dependsOn.map(id => ({ node: plan.nodes.find(item => item.id === id)!, output: state.nodes.find(item => item.nodeId === id)?.output ?? null }))
    const prompt = buildArrangementNodePrompt(plan, node, dependencies)
    let output = ''
    let worker: TaskWorkerPort | null = null
    await this.emitNodeEvent(taskId, arrangementRunId, {
      type: 'arrangement_node_started', arrangementRunId, nodeId: node.id, nodeRunId,
      subscriptionId: node.subscriptionId, attempt: checkpoint.attempt,
      data: { title: node.title, modelId: node.modelId },
    })
    try {
      if (this.options.scope && this.options.taskRunStore) {
        await this.options.taskRunStore.create(this.options.scope, {
          taskId, runId: nodeRunId, subscriptionId: node.subscriptionId, modelId: node.modelId,
          runtimeKey: `${node.subscriptionId}:${node.modelId}`, workspaceDir, prompt,
        })
      }
      worker = this.options.createWorker({
        context: {
          taskId, runId: nodeRunId, subscriptionId: node.subscriptionId, modelId: node.modelId,
          gatewayUrl: employee.gatewayUrl, workspaceDir,
          agentDir: paths?.agentDir ?? `${workspaceDir}/.pi-runs/${nodeRunId}`,
          sessionDir: paths?.sessionDir ?? `${workspaceDir}/.pi-sessions/${nodeRunId}`,
          additionalSkillPaths: employee.additionalSkillPaths,
          toolPolicy: toToolPolicy(plan.permissions, workspaceDir),
        },
        getRefreshToken: this.options.getRefreshToken,
        onAuthenticationRequired: this.options.onAuthenticationRequired,
        onApprovalRequest: request => this.options.onApprovalRequest(request),
        onEvent: async event => {
          if (event.type === 'text_delta') {
            const data = event.data as { text?: unknown }
            if (typeof data.text === 'string') output += data.text
          }
          await this.options.onEvent(event)
        },
        onSessionCreated: async session => {
          if (this.options.scope && this.options.taskRunStore) await this.options.taskRunStore.setSession(this.options.scope, taskId, nodeRunId, session)
        },
      })
      this.activeWorkers.set(nodeRunId, worker)
      // Start the worker before the second abort check: an abort can arrive while
      // the worker is being constructed, before it has installed its own stop hook.
      const runPromise = worker.run(prompt)
      if (this.abortRequested) await worker.abort()
      await runPromise
      if (this.options.scope && this.options.taskRunStore) await this.options.taskRunStore.finish(this.options.scope, taskId, nodeRunId, 'completed')
      await this.emitNodeEvent(taskId, arrangementRunId, {
        type: 'arrangement_node_completed', arrangementRunId, nodeId: node.id, nodeRunId, subscriptionId: node.subscriptionId,
        attempt: checkpoint.attempt, data: { output: output || null },
      })
      return { ok: true, nodeId: node.id, output: output || null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const interrupted = this.abortRequested
      if (this.options.scope && this.options.taskRunStore) {
        await this.options.taskRunStore.finish(this.options.scope, taskId, nodeRunId, interrupted ? 'interrupted' : 'failed', message)
      }
      if (!interrupted) {
        await this.emitNodeEvent(taskId, arrangementRunId, {
          type: 'arrangement_node_failed', arrangementRunId, nodeId: node.id, nodeRunId, subscriptionId: node.subscriptionId,
          attempt: checkpoint.attempt, data: { error: message },
        })
      }
      return { ok: false, nodeId: node.id, error: message }
    } finally {
      this.activeWorkers.delete(nodeRunId)
      await worker?.dispose().catch(() => undefined)
    }
  }

  private async persist(plan: WorkPlan, taskId: string, arrangementRunId: string, state: ArrangementExecutionState): Promise<void> {
    if (!this.options.scope || !this.options.checkpointStore) return
    const checkpoint: ArrangementCheckpoint = {
      version: 1, taskId, owner: { ...this.options.scope }, planHash: plan.planHash,
      activeRunId: arrangementRunId, state: structuredClone(state), updatedAt: Date.now(),
    }
    await this.options.checkpointStore.save(this.options.scope, checkpoint)
  }

  private async emitStateEvent(plan: WorkPlan, taskId: string, arrangementRunId: string, state: ArrangementExecutionState, nodeId: string): Promise<void> {
    await this.emitNodeEvent(taskId, arrangementRunId, {
      type: 'arrangement_state_changed', arrangementRunId, nodeId,
      data: { status: state.status, nodeId, nodeStatus: state.nodes.find(node => node.nodeId === nodeId)?.status, planHash: plan.planHash },
    })
  }

  private async emitNodeEvent(taskId: string, arrangementRunId: string, event: ArrangementNodeEvent): Promise<void> {
    await this.options.onEvent({
      taskId, runId: arrangementRunId, subscriptionId: this.options.arrangementSubscriptionId, sequence: 0,
      type: event.type, occurredAt: Date.now(), data: { ...(event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}), nodeId: event.nodeId, nodeRunId: event.nodeRunId, attempt: event.attempt },
    })
  }
}


