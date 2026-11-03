import type { ArrangementWorkPlan, EmployeeWorkPlan, ScheduledOccurrence, ScheduledIssue } from '../../src/shared/scheduled-tasks'
import type { TaskManager } from '../runtime/task-manager'
import type { WorkPlanStore } from '../data/work-plan-store'
import type { TaskMetadataStore } from '../data/task-metadata-store'
import type { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import type { ScheduledTaskStore } from '../data/scheduled-task-store'
import type { TaskRunStore } from '../data/task-run-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { effectivePermissionPolicy, type WorkPlan } from '../domain/arrangement-plan'
import { AppError } from '../errors/app-error'
import { BeforeScheduledAdmissionError, type ScheduledRunnerPort } from './scheduled-dispatcher'
import { logger } from '../common/logger'
import type { ScheduledWorkSource } from './scheduled-work-source'

const log = logger.child('scheduled-runner')
const runLogFields = (run: ScheduledOccurrence) => ({
  scheduledTaskId: run.definitionId, occurrenceId: run.id, taskId: run.taskId,
  attemptId: run.attempts.at(-1)?.id ?? null,
})

export interface ScheduledRunnerOptions {
  source?: ScheduledWorkSource
  scope: { currentScope(): TaskOwnerScope | null }
  tasks: TaskManager; workPlans: WorkPlanStore; metadata: TaskMetadataStore
  checkpoints: ArrangementCheckpointStore; runs: TaskRunStore; storage: ScheduledTaskStore
  authorize(subscriptionId: string, modelId: string): Promise<unknown>
  resourcesConflict?(left: string, right: string): Promise<boolean>
  execution(): Promise<{ executeTask(taskId: string, options?: { beforeAdmission?: () => void }): Promise<void>; cancelTask(taskId: string, reason?: string): Promise<void> }>
}
export class ScheduledTaskRunner implements ScheduledRunnerPort {
  constructor(private readonly options: ScheduledRunnerOptions) {}
  private scope(): TaskOwnerScope { const scope = this.options.scope.currentScope(); if (!scope) throw new AppError('AUTH_REQUIRED'); return scope }
  private guard(scope: TaskOwnerScope): void { const current = this.scope(); if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED') }
  async conflicts(left: ScheduledOccurrence, right: ScheduledOccurrence): Promise<boolean> {
    if (left.input.permissions.preset === 'full-local' || right.input.permissions.preset === 'full-local' || !this.options.resourcesConflict) return true
    return this.options.resourcesConflict(left.input.workDir, right.input.workDir)
  }
  async prepare(run: ScheduledOccurrence, valid: () => void = () => undefined): Promise<void> {
    const scope = this.scope()
    const guard = () => { valid(); this.guard(scope) }
    guard()
    const arrangement = run.plan.kind === 'arrangement' ? run.plan as ArrangementWorkPlan : null
    const employeePlan = arrangement ? null : run.plan as EmployeeWorkPlan
    const template = arrangement?.source ? await this.options.source?.load(scope, arrangement.source) : null
    guard()
    if (arrangement?.source && !template) throw new AppError('PERSISTENCE_ERROR')
    const nodes = arrangement?.nodes ?? [{ subscriptionId: run.input.subscriptionId, modelId: run.input.modelId }]
    log.info('========== [SCHEDULED TASK] AUTHORIZATION PREFLIGHT ==========', {
      ...runLogFields(run),
      nodeCount: nodes.length, mode: arrangement ? 'arrangement' : 'employee',
    })
    for (const [index, node] of nodes.entries()) {
      log.info('========== [SCHEDULED TASK] EMPLOYEE AUTHORIZATION CHECK ==========', {
        ...runLogFields(run),
        nodeIndex: index + 1, nodeCount: nodes.length, subscriptionId: node.subscriptionId, modelId: node.modelId,
      })
      const authorized = await this.options.authorize(node.subscriptionId, node.modelId)
      guard()
      if (authorized === null || authorized === undefined || authorized === false) throw new AppError('EMPLOYEE_UNAVAILABLE')
      log.info('========== [SCHEDULED TASK] EMPLOYEE AUTHORIZATION PASSED ==========', {
        ...runLogFields(run),
        nodeIndex: index + 1, nodeCount: nodes.length, subscriptionId: node.subscriptionId, modelId: node.modelId,
      })
    }
    const directory = await this.options.storage.prepareWorkspace(run.input.workDir, run.id)
    guard()
    const primarySubscriptionId = nodes[0]!.subscriptionId
    const task = await this.options.tasks.createTask(run.input.name, run.input.goal, directory, primarySubscriptionId,
      { id: run.taskId, origin: { definitionId: run.definitionId, occurrenceId: run.id } })
    guard()
    if (task.scheduledAdmission || task.activeRunId || task.status !== 'pending') throw new AppError('INVALID_STATE')
    const context = `\n【本次执行上下文】\n原计划时间（UTC）：${new Date(run.scheduledAt).toISOString()}\n时区：${run.input.timezone}\n原计划当地时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: run.input.timezone, dateStyle: 'full', timeStyle: 'long' }).format(run.scheduledAt)}\n实际启动日期：${new Date().toISOString()}\n相对日期按原计划时间和时区计算。无人值守不代表自动批准；缺少必要输入时明确报告，不编造，不重复已完成操作。`
    const workNodes = arrangement
      ? (template?.nodes ?? arrangement.nodes).map(node => ({ ...structuredClone(node), skillIds: [], instruction: node.instruction + context }))
      : [{ id: 'employee-work', subscriptionId: run.input.subscriptionId, modelId: run.input.modelId,
        title: run.input.name, objective: employeePlan!.objective, instruction: employeePlan!.instruction + context, expectedOutput: employeePlan!.expectedOutput,
        deliverables: structuredClone(employeePlan!.deliverables), dependsOn: [], skillIds: [], requiresUserConfirmation: false }]
    const inputSnapshot = template ? await this.options.source!.copyInputs(scope, template, task.id) : undefined
    guard()
    const plan: WorkPlan = { ...(template ? structuredClone(template) : {}), id: task.id, schemaVersion: template?.schemaVersion ?? 1, sourceDraftId: run.definitionId, sourceDraftRevision: run.revision,
      owner: scope, mode: template?.mode ?? (arrangement ? 'auto' : 'manual'), title: run.input.name, goal: run.input.goal, conversation: null,
      nodes: workNodes,
      workspace: { mode: 'shared', path: directory }, permissions: template ? structuredClone(template.permissions) : effectivePermissionPolicy(run.input.permissions), confirmedInputs: template?.confirmedInputs ?? [],
      ...(inputSnapshot ? { inputSnapshot } : {}),
      planHash: `${run.id}:${run.revision}`, createdAt: Date.now(), scheduledOrigin: { definitionId: run.definitionId, occurrenceId: run.id } }
    await this.options.workPlans.save(scope, plan)
    guard()
    await this.options.metadata.save(scope, { version: 1, taskId: task.id, kind: 'arrangement', participantSubscriptionIds: [...new Set(nodes.map(node => node.subscriptionId))], currentSubscriptionId: primarySubscriptionId, ...(template?.knowledge ? { knowledge: structuredClone(template.knowledge) } : {}), createdAt: Date.now() })
    guard()
    log.info('========== [SCHEDULED TASK] EXISTING TASK CONFIG PREPARED ==========', {
      ...runLogFields(run),
      nodeCount: workNodes.length, workPlanSaved: true, taskMetadataSaved: true,
    })
  }
  async launch(run: ScheduledOccurrence, valid: () => void = () => undefined): Promise<void> {
    const scope = this.scope()
    try {
      const runtime = await this.options.execution()
      valid()
      this.guard(scope)
      log.info('========== [SCHEDULED TASK] EXISTING RUNTIME START ==========', {
        ...runLogFields(run),
      })
      await runtime.executeTask(run.taskId, { beforeAdmission: () => { valid(); this.guard(scope) } })
      log.info('========== [SCHEDULED TASK] EXISTING RUNTIME ACCEPTED ==========', {
        ...runLogFields(run),
      })
    } catch (error) {
      this.guard(scope)
      const task = await this.options.tasks.getTask(run.taskId)
      if (task?.status === 'pending' && !task.scheduledAdmission && !task.activeRunId) {
        log.warn('========== [SCHEDULED TASK] RUNTIME NOT ADMITTED ==========', {
          ...runLogFields(run),
          errorType: error instanceof Error ? error.name : typeof error,
        })
        throw new BeforeScheduledAdmissionError(error)
      }
      log.error('========== [SCHEDULED TASK] RUNTIME ADMISSION UNCERTAIN ==========', {
        ...runLogFields(run),
        taskStatus: task?.status ?? 'missing', scheduledAdmission: Boolean(task?.scheduledAdmission),
        activeRun: Boolean(task?.activeRunId), errorType: error instanceof Error ? error.name : typeof error,
      })
      throw error
    }
  }
  async inspect(run: ScheduledOccurrence): ReturnType<ScheduledRunnerPort['inspect']> {
    const scope = this.scope()
    const task = await this.options.tasks.getTask(run.taskId)
    this.guard(scope)
    if (!task || task.scheduledOrigin?.occurrenceId !== run.id) return { state: 'missing' }
    if (task.status === 'running') return { state: 'running' }
    if (task.status === 'waiting_approval') return { state: 'waiting_approval' }
    if (task.status === 'pending') return { state: task.scheduledAdmission && !task.activeRunId ? 'interrupted' : 'pending' }
    const checkpoint = await this.options.checkpoints.get(scope, task.id)
    this.guard(scope)
    const records = await this.options.runs.list(scope, task.id)
    for (const record of records) {
      const events = await this.options.runs.events.getTimeline(scope, task.id, record.id)
      if (events.some(event => event.type === 'SIDE_EFFECT_UNKNOWN')) return { state: 'interrupted' }
    }
    this.guard(scope)
    if (task.status === 'completed') {
      const expectedNodes = run.plan.kind === 'arrangement' ? run.plan.nodes : [{ id: 'employee-work', deliverables: run.plan.deliverables }]
      const delivered = checkpoint?.planHash === `${run.id}:${run.revision}` && checkpoint.state.status === 'completed'
        && checkpoint.state.nodes.length === expectedNodes.length && expectedNodes.every(node => {
          const state = checkpoint.state.nodes.find(item => item.nodeId === node.id)
          return state?.status === 'completed' && state.delivery?.finalFiles.length === (node.deliverables?.length ?? 0)
        })
      return { state: delivered ? 'completed' : 'interrupted' }
    }
    if (task.status === 'failed') {
      const blocked = checkpoint?.state.nodes[0]?.delivery?.issues.find(issue => issue.code === 'INPUT_REQUIRED')
      const issue: ScheduledIssue = { code: blocked ? 'INPUT_REQUIRED' : 'EXECUTION_FAILED', message: blocked?.message ?? '本次执行或交付校验失败，已有进度和文件已保留，请查看工作详情。', action: 'blocked' }
      return { state: 'failed', error: issue }
    }
    if (task.status === 'paused' && run.stopReason) return { state: 'failed' }
    if (['interrupted', 'paused'].includes(task.status)) return { state: 'interrupted' }
    return { state: 'interrupted' }
  }
  async cancel(run: ScheduledOccurrence): Promise<void> {
    const scope = this.scope()
    const runtime = await this.options.execution()
    this.guard(scope)
    await runtime.cancelTask(run.taskId, run.stopReason === 'timed_out' ? '定时任务执行超时' : '用户取消定时任务本次执行')
  }
}
