import { withApprovedSkillReadPaths } from './run-skill-policy'
/**
 * 编排式任务的节点执行器。
 *
 * 执行器读取已确认的 WorkPlan，从持久化状态中找出可运行节点；无依赖的节点并行执行，
 * 节点完成后才释放下游节点。每个节点拥有独立的 run 和 worker，但通过提示词接收依赖
 * 节点的最终文件路径；检查点、审批和运行事件都通过注入的端口交给外层处理。
 */
import { randomUUID } from 'node:crypto'
import { WriteChain } from '../data/write-chain'
import { recoverArrangementSession } from '../data/arrangement-session-recovery'
import { validateDeliveryFiles, resolveDeliveryFiles } from '../data/arrangement-delivery-files'
import { DeliveryExecutionError, buildDeliveryCorrection, deliveryPlanIssues, parseDeliverySubmission, type FinalDeliveryFile, type NodeDeliveryProgress } from '../domain/arrangement-delivery'
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
import { translatePiNativeSystemPrompt } from '../pi/sdk/pi-native-system-prompt'
import { buildArrangementNodeSystemPrompt } from './arrangement-node-prompts'
import { advanceModelRequestProgress, type ModelRequestKind, type ModelRequestProgress } from '../domain/model-request-progress'
import type { MediaRunPort } from '../domain/media-tools'
import type { VideoRunPort } from '../domain/video-tools'
import { formatKnowledgeContext, type KnowledgeSearchPort, type KnowledgeSearchResult } from '../common/knowledge-context'
import { logger } from '../common/logger'

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
  authorizeEmployee: (subscriptionId: string, modelId?: string) => Promise<EmployeeRuntimeConfig | null>
  workspaceRoot: string
  arrangementSubscriptionId: string
  media?: MediaRunPort
  video?: VideoRunPort
  knowledgeSearch?: KnowledgeSearchPort
}

export interface ArrangementNodeEvent {
  type: 'arrangement_node_started' | 'arrangement_node_completed' | 'arrangement_node_failed' | 'arrangement_state_changed' | 'arrangement_delivery_checked'
  arrangementRunId: string
  nodeId?: string
  nodeRunId?: string
  subscriptionId?: string
  attempt?: number
  data?: unknown
}

export function buildArrangementNodePrompt(plan: WorkPlan, node: ArrangementNode, dependencies: readonly { node: ArrangementNode; output?: string | null }[]): string {
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
    preset: policy.preset,
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
  private readonly checkpointWrites = new WriteChain()
  private readonly requestProgressWrites = new WriteChain()
  private abortRequested = false
  private stopRequested = false
  private failureRequested = false
  private validationCancellation = new AbortController()
  private taskId: string | null = null

  constructor(private readonly options: ArrangementExecutionOptions) {}

  async abort(): Promise<void> {
    this.abortRequested = true
    this.validationCancellation.abort()
    await Promise.all([
      ...[...this.activeWorkers.values()].map(worker => worker.abort().catch(() => undefined)),
      this.taskId ? this.options.media?.stopTask(this.taskId) : undefined,
      this.taskId ? this.options.video?.stopTask(this.taskId) : undefined,
    ])
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    await this.abort()
  }

  async execute(plan: WorkPlan, taskId: string, arrangementRunId: string, requestedState?: ArrangementExecutionState): Promise<ArrangementExecutionResult> {
    this.taskId = taskId
    this.abortRequested = false
    this.stopRequested = false
    this.failureRequested = false
    this.validationCancellation = new AbortController()
    const state = await this.loadState(plan, taskId, arrangementRunId, requestedState)
    if (plan.mode === 'auto') {
      const issues = deliveryPlanIssues(plan.nodes)
      if (issues.length) {
        const error = issues.map(issue => issue.message).join('\n')
        const failedNodeId = state.nodes.find(node => node.status !== 'completed')?.nodeId
        const failed = { ...state, status: 'failed' as const,
          failureNodeIds: [...new Set([...state.failureNodeIds, ...(failedNodeId ? [failedNodeId] : [])])],
          nodes: state.nodes.map(node => node.status === 'completed' ? { ...node } : {
            ...node, status: node.nodeId === failedNodeId ? 'failed' as const : 'blocked' as const,
            error: node.nodeId === failedNodeId ? error : node.error,
          }) }
        await this.persist(plan, taskId, arrangementRunId, failed)
        await this.emitStateEvent(plan, taskId, arrangementRunId, failed)
        return { status: 'failed', state: failed, error }
      }
    }
    await this.persist(plan, taskId, arrangementRunId, state)
    await this.emitStateEvent(plan, taskId, arrangementRunId, state)
    if (state.status === 'completed' || state.status === 'stopped' || state.status === 'waiting-user' || state.status === 'failed') return { status: state.status, state }

    let current = state
    const nodes = nodeMap(plan)
    while (!this.abortRequested) {
      const ready = current.nodes.filter(node => node.status === 'ready')
      if (ready.length === 0) {
        if (current.nodes.some(node => node.status === 'running')) {
          current = interruptArrangement(current, 'runtime-error')
          await this.persist(plan, taskId, arrangementRunId, current)
          await this.emitStateEvent(plan, taskId, arrangementRunId, current)
        }
        return { status: current.status, state: current }
      }

      const batch = ready.map(checkpoint => {
        current = markArrangementNodeRunning(current, checkpoint.nodeId)
        return { checkpoint: current.nodes.find(node => node.nodeId === checkpoint.nodeId)!, node: nodes.get(checkpoint.nodeId)! }
      })
      await this.persist(plan, taskId, arrangementRunId, current)
      const results = await Promise.all(batch.map(item => this.executeNode(plan, taskId, arrangementRunId, item.node, item.checkpoint, current, async sessionRunId => {
        current = { ...current, nodes: current.nodes.map(node => node.nodeId === item.node.id ? { ...node, sessionRunId } : node) }
        await this.persist(plan, taskId, arrangementRunId, current)
      }, (kind, recoveredSession) => this.requestProgressWrites.run(taskId, async () => {
        this.checkExecutionControl()
        const previous = current.nodes.find(node => node.nodeId === item.node.id)!.modelRequestProgress
        const next = advanceModelRequestProgress(previous, kind, recoveredSession ? 'since-resume' : undefined)
        current = { ...current, nodes: current.nodes.map(node => node.nodeId === item.node.id ? { ...node, modelRequestProgress: next } : node) }
        await this.persist(plan, taskId, arrangementRunId, current)
        this.checkExecutionControl()
        return next
      }), async delivery => {
        current = { ...current, nodes: current.nodes.map(node => node.nodeId === item.node.id ? { ...node, delivery } : node) }
        await this.persist(plan, taskId, arrangementRunId, current)
      }, async (nodeId, files) => {
        current = { ...current, nodes: current.nodes.map(node => node.nodeId === nodeId && node.delivery
          ? { ...node, delivery: { ...node.delivery, finalFiles: files } } : node) }
        await this.persist(plan, taskId, arrangementRunId, current)
      })))

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
        if (this.failureRequested) current = { ...current, status: 'failed' }
        await this.persist(plan, taskId, arrangementRunId, current)
        if (result.ok) await this.emitNodeEvent(taskId, arrangementRunId, result.completion)
        await this.emitStateEvent(plan, taskId, arrangementRunId, current, result.nodeId)
      }
      if (results.some(result => !result.ok && result.terminal)) {
        const error = results.find(result => !result.ok && result.terminal)
        current = { ...current, status: 'failed', nodes: current.nodes.map(node => ['ready', 'pending', 'running', 'interrupted'].includes(node.status) ? { ...node, status: 'blocked' as const } : node) }
        await this.persist(plan, taskId, arrangementRunId, current)
        await this.emitStateEvent(plan, taskId, arrangementRunId, current)
        await Promise.all([this.options.media?.stopTask(taskId), this.options.video?.stopTask(taskId)])
        return { status: 'failed', state: current, error: error && !error.ok ? error.error : undefined }
      }
      if (current.status === 'waiting-user') {
        await Promise.all([this.options.media?.stopTask(taskId), this.options.video?.stopTask(taskId)])
        return { status: current.status, state: current, error: current.nodes.find(node => node.status === 'failed')?.error ?? undefined }
      }
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
    saveSessionRun: (runId: string) => Promise<void>,
    saveModelRequestProgress: (kind: ModelRequestKind, recoveredSession: boolean) => Promise<ModelRequestProgress>,
    saveDelivery: (delivery: NodeDeliveryProgress) => Promise<void>,
    savePredecessorFiles: (nodeId: string, files: FinalDeliveryFile[]) => Promise<void>,
  ): Promise<{ ok: true; nodeId: string; output: string | null; completion: ArrangementNodeEvent } | { ok: false; nodeId: string; error: string; terminal: boolean }> {
    const nodeRunId = randomUUID()
    const workspaceDir = plan.workspace.path ?? this.options.workspaceRoot
    const paths = this.options.scope && this.options.taskRunStore
      ? this.options.taskRunStore.getPaths(this.options.scope, taskId, nodeRunId)
      : null
    const structured = plan.mode === 'auto' || !!node.deliverables?.length
    const fileOptions = { taskDirectory: paths?.taskDir, allowWorkspaceChanges: true }
    const dependencies: Array<{ node: ArrangementNode; output: string | null; files: (FinalDeliveryFile & { readPath?: string })[] }> = node.dependsOn.map(id => ({ node: plan.nodes.find(item => item.id === id)!, output: state.nodes.find(item => item.nodeId === id)?.output ?? null,
      files: state.nodes.find(item => item.nodeId === id)?.delivery?.finalFiles ?? [] }))
    let prompt = structured ? '开始你的工作。' : buildArrangementNodePrompt(plan, node, dependencies)
    let output = ''
    let worker: TaskWorkerPort | null = null
    let created = false
    let startedAt: string | undefined
    const metadata = () => ({ title: node.title, modelId: node.modelId, ...(startedAt ? { startedAt } : {}) })
    let delivery: NodeDeliveryProgress = checkpoint.delivery ?? { validationAttempts: 0, issues: [], finalFiles: [] }
    let accepted = !structured
    try {
      this.checkExecutionControl()
      if (structured) {
        for (const dependency of dependencies) {
          const progress = state.nodes.find(item => item.nodeId === dependency.node.id)
          const complete = progress?.status === 'completed' && parseDeliverySubmission(dependency.node, JSON.stringify({ nodeId: dependency.node.id, summary: 'verified', finalDeliverables: dependency.files.map(file => ({ id: file.id, path: file.path })) })).ok
          if (!complete) throw new DeliveryExecutionError(`前置节点 ${dependency.node.id} 缺少已确认的最终交付记录，不能启动下游节点。`)
          const resolved = await resolveDeliveryFiles(workspaceDir, dependency.files, this.validationCancellation.signal, fileOptions)
          if (resolved.issues.length) throw new DeliveryExecutionError(`前置最终文件失效：${resolved.issues.map(issue => `${issue.path ?? ''} ${issue.message}`).join('\n')}`)
          if (resolved.files.some((file, index) => file !== dependency.files[index])) {
            await savePredecessorFiles(dependency.node.id, resolved.files)
          }
          for (const warning of resolved.warnings) logger.child('arrangement').warn('legacy delivery restored from current workspace file', {
            taskId, nodeId: dependency.node.id, path: warning.path,
            approvedSha256: resolved.files.find(file => file.id === warning.deliverableId)?.sha256,
            recoverySha256: resolved.files.find(file => file.id === warning.deliverableId)?.snapshot?.sha256,
          })
          dependency.files = resolved.files.map((file, index) => ({ ...file, readPath: resolved.readPaths[index] }))
        }
        if (delivery.finalFiles.length) {
          const complete = parseDeliverySubmission(node, JSON.stringify({ nodeId: node.id, summary: delivery.summary ?? 'verified', finalDeliverables: delivery.finalFiles.map(file => ({ id: file.id, path: file.path })) })).ok
          const resolved = complete ? await resolveDeliveryFiles(workspaceDir, delivery.finalFiles, this.validationCancellation.signal, fileOptions) : null
          const issues = resolved?.issues ?? [{ message: '交付记录与计划不一致。' }]
          if (issues.length) throw new DeliveryExecutionError(`已验收最终文件失效：${issues.map(issue => issue.message).join('\n')}`)
          if (resolved) {
            delivery = { ...delivery, finalFiles: resolved.files }
            await saveDelivery(delivery)
          }
          this.checkExecutionControl()
          output = delivery.summary ?? ''
          startedAt = new Date().toISOString()
          if (this.options.scope && this.options.taskRunStore) {
            // Recovery gets a new completion receipt; prior terminal runs stay immutable.
            await this.options.taskRunStore.create(this.options.scope, {
              taskId, runId: nodeRunId, subscriptionId: node.subscriptionId, modelId: node.modelId,
              runtimeKey: `${node.subscriptionId}:${node.modelId}`, workspaceDir, prompt,
              arrangementNodeId: node.id, resumedFromRunId: delivery.finalFiles[0]!.nodeRunId,
            })
            created = true
            await this.options.taskRunStore.finish(this.options.scope, taskId, nodeRunId, 'completed')
          }
          return { ok: true, nodeId: node.id, output: output || null, completion: { type: 'arrangement_node_completed', arrangementRunId, nodeId: node.id,
            nodeRunId, subscriptionId: node.subscriptionId, attempt: checkpoint.attempt,
            data: { ...metadata(), output: output || null, finalDeliverables: delivery.finalFiles, status: 'COMPLETED', completedAt: new Date().toISOString() } } }
        }
      }
      const recovery = this.options.scope && this.options.taskRunStore
        ? await recoverArrangementSession(this.options.taskRunStore, this.options.scope, taskId, node, checkpoint, workspaceDir)
        : null
      if (recovery) prompt = structured
        ? '沿用当前节点保存的会话和进度，继续完成未完成的工作，不要重做已完成操作。'
        : '沿用此会话中已保存的任务目标、工具结果和执行进度，从中断处继续完成当前节点。不要重新开始任务，也不要重复已经完成的操作；对结果不确定的操作先核实。'
      const employee = await this.options.authorizeEmployee(node.subscriptionId, node.modelId)
      if (!employee) throw new Error('The selected employee is no longer available.')
      this.checkExecutionControl()
      let knowledgeContext = ''
      if (node.knowledgeQuery) {
        let result: KnowledgeSearchResult | null = null
        try {
          result = await this.options.knowledgeSearch?.(node.knowledgeQuery, this.validationCancellation.signal) ?? null
        } catch {
          this.validationCancellation.signal.throwIfAborted()
        }
        knowledgeContext = formatKnowledgeContext(node.knowledgeQuery, result)
      }
      this.checkExecutionControl()
      if (structured && delivery.issues.length) prompt += `\n\n${buildDeliveryCorrection(delivery.issues)}`
      if (this.options.scope && this.options.taskRunStore) {
        await this.options.taskRunStore.create(this.options.scope, {
          taskId, runId: nodeRunId, subscriptionId: node.subscriptionId, modelId: node.modelId,
          runtimeKey: `${node.subscriptionId}:${node.modelId}`, workspaceDir, prompt,
          arrangementNodeId: node.id, ...(recovery ? { resumedFromRunId: recovery.runId } : {}),
        })
        created = true
      }
      const toolPolicy = { ...withApprovedSkillReadPaths(toToolPolicy(plan.permissions, workspaceDir), employee)!,
        readableDeliveryPaths: dependencies.flatMap(dependency => dependency.files.flatMap(file => file.readPath ? [file.readPath] : [])) }
      const mediaTools = await this.options.media?.prepareRun({
        taskId, runId: nodeRunId, subscriptionId: node.subscriptionId, employee, toolPolicy,
        requestApproval: request => this.options.onApprovalRequest(request),
      })
      const videoTools = await this.options.video?.prepareRun({
        taskId, runId: nodeRunId, subscriptionId: node.subscriptionId, employee, toolPolicy,
        requestApproval: request => this.options.onApprovalRequest(request),
      })
      if (this.abortRequested) {
        await Promise.all([this.options.media?.stopTask(taskId), this.options.video?.stopTask(taskId)])
        throw new Error('Arrangement execution was interrupted.')
      }
      this.checkExecutionControl()
      worker = this.options.createWorker({
        context: {
          taskId, runId: nodeRunId, subscriptionId: node.subscriptionId, modelId: node.modelId,
          gatewayUrl: employee.gatewayUrl, workspaceDir,
          agentDir: paths?.agentDir ?? `${workspaceDir}/.pi-runs/${nodeRunId}`,
          sessionDir: paths?.sessionDir ?? `${workspaceDir}/.pi-sessions/${nodeRunId}`,
          ...(recovery ? { resumeSessionFile: recovery.sessionFile } : {}),
          additionalSkillPaths: employee.additionalSkillPaths,
          employeeProfile: employee.employeeProfile,
          arrangementNodeId: node.id,
          ...(structured ? {
            useNativeSystemPrompt: true,
            modelRequestAwareness: false,
            transformSystemPrompt: translatePiNativeSystemPrompt,
            fixedSystemPrompt: buildArrangementNodeSystemPrompt(plan, node, dependencies, employee, knowledgeContext),
          } : { systemPrompt: employee.systemPrompt }),
          mediaTools, videoTools, toolPolicy,
        },
        getRefreshToken: this.options.getRefreshToken,
        onAuthenticationRequired: this.options.onAuthenticationRequired,
        onApprovalRequest: request => this.options.onApprovalRequest(request),
        onModelRequest: structured ? kind => saveModelRequestProgress(kind, recovery !== null) : undefined,
        ...(structured ? { onResponseSettled: async (response: { text: string; stopReason?: string }): Promise<{ continueWith: string } | void> => {
          this.checkExecutionControl()
          await Promise.all([this.options.media?.waitForRun(taskId, nodeRunId), this.options.video?.waitForRun(taskId, nodeRunId)])
          this.checkExecutionControl()
          this.validationCancellation.signal.throwIfAborted()
          delivery = { ...delivery, validationAttempts: delivery.validationAttempts + 1, finalFiles: [], summary: undefined }
          await saveDelivery(delivery)
          const parsed = parseDeliverySubmission(node, response.text, response.stopReason)
          const result = parsed.ok
            ? await validateDeliveryFiles(workspaceDir, node, parsed.submission, nodeRunId, this.validationCancellation.signal, fileOptions)
            : parsed
          this.validationCancellation.signal.throwIfAborted()
          this.checkExecutionControl()
          if (result.ok && parsed.ok) {
            output = parsed.submission.summary
            accepted = true
            delivery = { ...delivery, issues: [], finalFiles: result.files, summary: output }
          } else {
            delivery = { ...delivery, issues: result.ok ? [] : result.issues }
          }
          await saveDelivery(delivery)
          await this.emitNodeEvent(taskId, arrangementRunId, { type: 'arrangement_delivery_checked', arrangementRunId, nodeId: node.id, nodeRunId,
            subscriptionId: node.subscriptionId, data: { validationAttempts: delivery.validationAttempts, accepted, issues: delivery.issues } })
          if (accepted) return
          return { continueWith: buildDeliveryCorrection(delivery.issues) }
        } } : {}),
        onEvent: async event => {
          if (event.type === 'turn_start') output = ''
          if (event.type === 'turn_end') {
            const data = event.data as { message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } } | null
            if (data?.message?.role === 'assistant' && !['error', 'aborted'].includes(data.message.stopReason ?? '')) {
              output = (data.message.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('')
            }
          }
          if (event.type === 'text_delta') {
            const data = event.data as { text?: unknown }
            if (typeof data.text === 'string') output += data.text
          }
          await this.options.onEvent(event)
        },
        onSessionCreated: async session => {
          if (this.options.scope && this.options.taskRunStore) {
            await this.options.taskRunStore.setSession(this.options.scope, taskId, nodeRunId, session)
            if (session.sessionFile) await saveSessionRun(nodeRunId)
          }
        },
      })
      this.activeWorkers.set(nodeRunId, worker)
      this.checkExecutionControl()
      startedAt = new Date().toISOString()
      await this.emitNodeEvent(taskId, arrangementRunId, {
        type: 'arrangement_node_started', arrangementRunId, nodeId: node.id, nodeRunId,
        subscriptionId: node.subscriptionId, attempt: checkpoint.attempt,
        data: { ...metadata(), prompt, status: 'RUNNING' },
      })
      // Start the worker before the second abort check: an abort can arrive while
      // the worker is being constructed, before it has installed its own stop hook.
      if (this.failureRequested) throw new Error('Another node failed delivery validation.')
      const runPromise = worker.run(`${prompt}${!structured && knowledgeContext ? `\n\n${knowledgeContext}` : ''}`)
      if (this.abortRequested) await worker.abort()
      await runPromise
      if (!this.abortRequested) await Promise.all([this.options.media?.waitForRun(taskId, nodeRunId), this.options.video?.waitForRun(taskId, nodeRunId)])
      if (this.abortRequested) throw new Error('Arrangement execution was interrupted.')
      this.checkExecutionControl()
      if (!accepted) throw new DeliveryExecutionError('节点未经过最终交付校验，不能确认完成。')
      if (this.options.scope && this.options.taskRunStore) await this.options.taskRunStore.finish(this.options.scope, taskId, nodeRunId, 'completed')
      const completion: ArrangementNodeEvent = {
        type: 'arrangement_node_completed', arrangementRunId, nodeId: node.id, nodeRunId, subscriptionId: node.subscriptionId,
        attempt: checkpoint.attempt, data: { ...metadata(), output: output || null, ...(structured ? { finalDeliverables: delivery.finalFiles } : {}), status: 'COMPLETED', completedAt: new Date().toISOString() },
      }
      return { ok: true, nodeId: node.id, output: output || null, completion }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const interrupted = this.abortRequested
      const terminal = error instanceof DeliveryExecutionError && !interrupted
      if (terminal) {
        this.failureRequested = true
        await Promise.all([...this.activeWorkers].filter(([id]) => id !== nodeRunId).map(([, active]) => active.abort().catch(() => undefined)))
      }
      if (created && this.options.scope && this.options.taskRunStore) {
        await this.options.taskRunStore.finish(this.options.scope, taskId, nodeRunId, interrupted ? 'interrupted' : 'failed', message).catch(() => undefined)
      }
      await this.emitNodeEvent(taskId, arrangementRunId, {
        type: 'arrangement_node_failed', arrangementRunId, nodeId: node.id, nodeRunId, subscriptionId: node.subscriptionId,
        attempt: checkpoint.attempt, data: { ...metadata(), output: output || null, error: message,
          status: interrupted ? this.stopRequested ? 'CANCELLED' : 'PAUSED' : 'FAILED', completedAt: new Date().toISOString() },
      })
      return { ok: false, nodeId: node.id, error: message, terminal }
    } finally {
      await this.options.video?.finishRun?.(taskId, nodeRunId)
      this.activeWorkers.delete(nodeRunId)
      await worker?.dispose().catch(() => undefined)
    }
  }

  private checkExecutionControl(): void {
    if (this.abortRequested) throw new Error('Arrangement execution was interrupted.')
    if (this.failureRequested) throw new Error('Another node failed delivery validation.')
  }

  private async persist(plan: WorkPlan, taskId: string, arrangementRunId: string, state: ArrangementExecutionState): Promise<void> {
    if (!this.options.scope || !this.options.checkpointStore) return
    const checkpoint: ArrangementCheckpoint = {
      version: 1, taskId, owner: { ...this.options.scope }, planHash: plan.planHash,
      activeRunId: arrangementRunId, state: structuredClone(state), updatedAt: Date.now(),
    }
    const scope = this.options.scope
    const store = this.options.checkpointStore
    await this.checkpointWrites.run(taskId, () => store.save(scope, checkpoint))
  }

  private async emitStateEvent(plan: WorkPlan, taskId: string, arrangementRunId: string, state: ArrangementExecutionState, nodeId?: string): Promise<void> {
    await this.emitNodeEvent(taskId, arrangementRunId, {
      type: 'arrangement_state_changed', arrangementRunId, nodeId,
      data: { status: state.status, nodeId, nodeStatus: state.nodes.find(node => node.nodeId === nodeId)?.status, planHash: plan.planHash,
        nodeStates: state.nodes.map(node => ({ nodeId: node.nodeId, status: node.status })) },
    })
  }

  private async emitNodeEvent(taskId: string, arrangementRunId: string, event: ArrangementNodeEvent): Promise<void> {
    await this.options.onEvent({
      taskId, runId: arrangementRunId, subscriptionId: this.options.arrangementSubscriptionId, sequence: 0,
      type: event.type, occurredAt: Date.now(), data: { ...(event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}), nodeId: event.nodeId, nodeRunId: event.nodeRunId, subscriptionId: event.subscriptionId, attempt: event.attempt },
    })
  }
}


