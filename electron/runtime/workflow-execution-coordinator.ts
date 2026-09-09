import { randomUUID } from 'node:crypto'
import type { TaskExecutionEvent } from '../../src/shared/types'
import type { TaskOwnerScope } from '../data/scope-path'
import type { TaskRunStorePort } from '../data/task-run-store'
import type { WorkflowCheckpoint, WorkflowCheckpointStorePort } from '../data/workflow-checkpoint-store'
import type { WorkPlan, ArrangementNode, EffectiveTaskPermissionPolicy } from '../domain/arrangement-plan'
import type { TaskManager } from './task-manager'
import {
  createWorkflowRunnerState,
  markNodeCompleted,
  markNodeFailed,
  markNodeRunning,
  resumeInterrupted,
  retryFailedNode,
  interruptWorkflow,
  stopWorkflow,
  type WorkflowRunnerState,
} from './workflow-runner'
import type { EmployeeRuntimeConfig, TaskToolPolicy, TaskWorkerPort } from './run-types'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'

export interface WorkflowExecutionResult {
  status: WorkflowRunnerState['status']
  state: WorkflowRunnerState
  error?: string
}

export interface WorkflowExecutionOptions {
  scope: TaskOwnerScope | null
  taskManager: TaskManager
  taskRunStore: TaskRunStorePort | null
  checkpointStore: WorkflowCheckpointStorePort | null
  createWorker: (options: PiTaskWorkerOptions) => TaskWorkerPort
  getRefreshToken: () => string
  onAuthenticationRequired: () => void
  onApprovalRequest: PiTaskWorkerOptions['onApprovalRequest']
  onEvent: (event: TaskExecutionEvent) => Promise<void>
  authorizeEmployee: (subscriptionId: string) => Promise<EmployeeRuntimeConfig | null>
  workspaceRoot: string
  workflowSubscriptionId: string
}

export interface WorkflowNodeEvent {
  type: 'workflow_node_started' | 'workflow_node_completed' | 'workflow_node_failed' | 'workflow_state_changed'
  workflowRunId: string
  nodeId?: string
  nodeRunId?: string
  subscriptionId?: string
  attempt?: number
  data?: unknown
}

export function buildWorkflowNodePrompt(plan: WorkPlan, node: ArrangementNode, dependencies: readonly { node: ArrangementNode; output: string | null }[]): string {
  const dependencyText = dependencies.length === 0
    ? 'No prerequisite node output is available.'
    : dependencies.map(({ node: dependency, output }) => [
      `PREREQUISITE: ${dependency.title} (${dependency.id})`,
      output?.trim() || '(The prerequisite completed without a textual output.)',
    ].join('\n')).join('\n\n')
  return [
    'You are executing one node inside an orchestrated work plan.',
    `OVERALL GOAL:\n${plan.goal}`,
    `CURRENT NODE:\n${node.title} (${node.id})`,
    `NODE INSTRUCTION:\n${node.instruction}`,
    `EXPECTED OUTPUT:\n${node.expectedOutput}`,
    `PREREQUISITE OUTPUTS:\n${dependencyText}`,
    'SHARED WORKSPACE:\nUse only the assigned shared workspace and do not replay or invent prerequisite tool calls.',
    'Return a concise result that can be consumed by downstream nodes. Do not reveal hidden reasoning.',
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

export class WorkflowExecutionCoordinator {
  private readonly activeWorkers = new Map<string, TaskWorkerPort>()
  private abortRequested = false
  private stopRequested = false

  constructor(private readonly options: WorkflowExecutionOptions) {}

  async abort(): Promise<void> {
    this.abortRequested = true
    await Promise.all([...this.activeWorkers.values()].map(worker => worker.abort().catch(() => undefined)))
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    await this.abort()
  }

  async execute(plan: WorkPlan, taskId: string, workflowRunId: string, requestedState?: WorkflowRunnerState): Promise<WorkflowExecutionResult> {
    this.abortRequested = false
    this.stopRequested = false
    const state = await this.loadState(plan, taskId, workflowRunId, requestedState)
    await this.persist(plan, taskId, workflowRunId, state)
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
        current = markNodeRunning(current, checkpoint.nodeId)
        return { checkpoint: current.nodes.find(node => node.nodeId === checkpoint.nodeId)!, node: nodes.get(checkpoint.nodeId)! }
      })
      await this.persist(plan, taskId, workflowRunId, current)
      const results = await Promise.all(batch.map(item => this.executeNode(plan, taskId, workflowRunId, item.node, item.checkpoint, current)))

      if (this.abortRequested) {
        current = this.stopRequested
          ? stopWorkflow(current)
          : interruptWorkflow(current, 'client-exit')
        await this.persist(plan, taskId, workflowRunId, current)
        return { status: current.status, state: current }
      }

      for (const result of results) {
        if (result.ok) current = markNodeCompleted(current, plan.nodes, result.nodeId, result.output)
        else current = markNodeFailed(current, plan.nodes, result.nodeId, result.error)
        await this.persist(plan, taskId, workflowRunId, current)
        await this.emitStateEvent(plan, taskId, workflowRunId, current, result.nodeId)
      }
      if (results.some(result => !result.ok)) return { status: current.status, state: current, error: results.find(result => !result.ok)?.error }
    }

    current = this.stopRequested
      ? stopWorkflow(current)
      : interruptWorkflow(current, 'client-exit')
    await this.persist(plan, taskId, workflowRunId, current)
    return { status: current.status, state: current }
  }

  retry(state: WorkflowRunnerState, plan: WorkPlan, nodeId: string): WorkflowRunnerState {
    return retryFailedNode(state, plan.nodes, nodeId)
  }

  resume(state: WorkflowRunnerState): WorkflowRunnerState {
    return resumeInterrupted(state)
  }

  private async loadState(plan: WorkPlan, taskId: string, workflowRunId: string, requestedState?: WorkflowRunnerState): Promise<WorkflowRunnerState> {
    if (requestedState) return requestedState.status === 'interrupted' ? resumeInterrupted(requestedState) : requestedState
    if (this.options.scope && this.options.checkpointStore) {
      const checkpoint = await this.options.checkpointStore.get(this.options.scope, taskId)
      if (checkpoint?.planHash === plan.planHash) {
        return checkpoint.state.status === 'interrupted' ? resumeInterrupted(checkpoint.state) : checkpoint.state
      }
    }
    void workflowRunId
    return createWorkflowRunnerState(plan.nodes)
  }

  private async executeNode(
    plan: WorkPlan,
    taskId: string,
    workflowRunId: string,
    node: ArrangementNode,
    checkpoint: WorkflowRunnerState['nodes'][number],
    state: WorkflowRunnerState,
  ): Promise<{ ok: true; nodeId: string; output: string | null } | { ok: false; nodeId: string; error: string }> {
    if (this.abortRequested) return { ok: false, nodeId: node.id, error: 'Workflow execution was interrupted.' }
    const employee = await this.options.authorizeEmployee(node.subscriptionId)
    if (!employee) return { ok: false, nodeId: node.id, error: 'The selected employee is no longer available.' }
    if (this.abortRequested) return { ok: false, nodeId: node.id, error: 'Workflow execution was interrupted.' }
    const nodeRunId = randomUUID()
    const workspaceDir = plan.workspace.path ?? this.options.workspaceRoot
    const paths = this.options.scope && this.options.taskRunStore
      ? this.options.taskRunStore.getPaths(this.options.scope, taskId, nodeRunId)
      : null
    const dependencies = node.dependsOn.map(id => ({ node: plan.nodes.find(item => item.id === id)!, output: state.nodes.find(item => item.nodeId === id)?.output ?? null }))
    const prompt = buildWorkflowNodePrompt(plan, node, dependencies)
    let output = ''
    let worker: TaskWorkerPort | null = null
    await this.emitNodeEvent(taskId, workflowRunId, {
      type: 'workflow_node_started', workflowRunId, nodeId: node.id, nodeRunId,
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
      await this.emitNodeEvent(taskId, workflowRunId, {
        type: 'workflow_node_completed', workflowRunId, nodeId: node.id, nodeRunId, subscriptionId: node.subscriptionId,
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
        await this.emitNodeEvent(taskId, workflowRunId, {
          type: 'workflow_node_failed', workflowRunId, nodeId: node.id, nodeRunId, subscriptionId: node.subscriptionId,
          attempt: checkpoint.attempt, data: { error: message },
        })
      }
      return { ok: false, nodeId: node.id, error: message }
    } finally {
      this.activeWorkers.delete(nodeRunId)
      await worker?.dispose().catch(() => undefined)
    }
  }

  private async persist(plan: WorkPlan, taskId: string, workflowRunId: string, state: WorkflowRunnerState): Promise<void> {
    if (!this.options.scope || !this.options.checkpointStore) return
    const checkpoint: WorkflowCheckpoint = {
      version: 1, taskId, owner: { ...this.options.scope }, planHash: plan.planHash,
      activeRunId: workflowRunId, state: structuredClone(state), updatedAt: Date.now(),
    }
    await this.options.checkpointStore.save(this.options.scope, checkpoint)
  }

  private async emitStateEvent(plan: WorkPlan, taskId: string, workflowRunId: string, state: WorkflowRunnerState, nodeId: string): Promise<void> {
    await this.emitNodeEvent(taskId, workflowRunId, {
      type: 'workflow_state_changed', workflowRunId, nodeId,
      data: { status: state.status, nodeId, nodeStatus: state.nodes.find(node => node.nodeId === nodeId)?.status, planHash: plan.planHash },
    })
  }

  private async emitNodeEvent(taskId: string, workflowRunId: string, event: WorkflowNodeEvent): Promise<void> {
    await this.options.onEvent({
      taskId, runId: workflowRunId, subscriptionId: this.options.workflowSubscriptionId, sequence: 0,
      type: event.type, occurredAt: Date.now(), data: { ...(event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}), nodeId: event.nodeId, nodeRunId: event.nodeRunId, attempt: event.attempt },
    })
  }
}
