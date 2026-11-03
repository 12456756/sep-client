import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { ScheduledTaskStore } from '../data/scheduled-task-store'
import type { TaskOwnerScope } from '../data/scope-path'
import type { InputSnapshotRef } from '../../src/shared/attachment-contracts'
import type { ArrangementWorkPlan, ScheduledWorkSourceRef, WorkScheduleContext } from '../../src/shared/scheduled-tasks'
import type { WorkPlan } from '../domain/arrangement-plan'
import { sourceFingerprint, validateScheduledSource } from '../domain/scheduled-work-source'
import { AppError } from '../errors/app-error'
import { WriteChain } from '../data/write-chain'

interface Options {
  workPlans: WorkPlanStorePort
  storage: ScheduledTaskStore
  tasks: { getTask(id: string): Promise<{ id: string } | null | undefined> }
  metadata: { load(scope: TaskOwnerScope, id: string): Promise<{ kind: string } | null | undefined> }
  attachments?: { copyTaskInputs(scope: TaskOwnerScope, sourceId: string, targetId: string, snapshot: InputSnapshotRef): Promise<InputSnapshotRef> }
}
export class ScheduledWorkSource {
  private readonly writes = new WriteChain()
  constructor(private readonly options: Options) {}
  async original(scope: TaskOwnerScope, taskId: string): Promise<WorkPlan> {
    const task = await this.options.tasks.getTask(taskId)
    const metadata = await this.options.metadata.load(scope, taskId)
    const plan = await this.options.workPlans.get(scope, taskId)
    if (!task || metadata?.kind !== 'arrangement' || !plan || plan.id !== taskId) throw new AppError('INVALID_STATE', { message: '请选择已有完整编排计划的工作，不能使用对话或规划草稿。' })
    validateScheduledSource(plan, scope)
    return plan
  }
  async context(scope: TaskOwnerScope, taskId: string): Promise<WorkScheduleContext> {
    const plan = await this.original(scope, taskId)
    return { taskId, planHash: sourceFingerprint(plan), title: plan.title, subscriptionId: plan.nodes[0]!.subscriptionId, modelId: plan.nodes[0]!.modelId }
  }
  async capture(scope: TaskOwnerScope, taskId: string, expectedHash: string, definitionId: string, guard: () => void): Promise<WorkPlan> {
    const templateId = `scheduled-template-${definitionId}`
    return this.writes.run(JSON.stringify([scope, templateId]), async () => {
      guard()
      const existing = await this.options.storage.loadTemplate(scope, templateId)
      guard()
      if (existing) {
        if (existing.sourceDraftId !== taskId || existing.planHash !== expectedHash) throw new AppError('CONFLICT')
        return existing
      }
      const original = await this.original(scope, taskId)
      guard()
      if (sourceFingerprint(original) !== expectedHash) throw new AppError('DRAFT_REVISION_CONFLICT', { message: '原工作计划已变化，请关闭弹窗后重新打开。' })
      const plan = structuredClone(original)
      if (plan.inputSnapshot) {
        if (!this.options.attachments) throw new AppError('INVALID_STATE', { message: '附件复制服务不可用。' })
        plan.inputSnapshot = await this.options.attachments.copyTaskInputs(scope, taskId, templateId, plan.inputSnapshot)
        guard()
      }
      plan.id = templateId
      plan.sourceDraftId = taskId
      plan.planHash = expectedHash
      delete plan.scheduledOrigin
      plan.nodes = plan.nodes.map(node => ({ ...node, skillIds: [] }))
      await this.options.storage.validateWorkspace(plan.workspace.path!)
      guard()
      await this.options.storage.saveTemplate(scope, plan)
      guard()
      return plan
    })
  }
  view(plan: WorkPlan, taskId: string, requestKey: string): ArrangementWorkPlan {
    return { status: 'ready', kind: 'arrangement', title: plan.title, intentAnalysis: null,
      source: { taskId, templateId: plan.id, planHash: sourceFingerprint(plan), requestKey },
      nodes: plan.nodes.map(node => ({ id: node.id, subscriptionId: node.subscriptionId, modelId: node.modelId,
        title: node.title, ...(node.objective ? { objective: node.objective } : {}), instruction: node.instruction,
        expectedOutput: node.expectedOutput, deliverables: structuredClone(node.deliverables!), dependsOn: [...node.dependsOn], skillIds: [], requiresUserConfirmation: false,
        ...(node.stepId ? { stepId: node.stepId } : {}) })) }
  }
  async load(scope: TaskOwnerScope, source: ScheduledWorkSourceRef): Promise<WorkPlan> {
    const plan = await this.options.storage.loadTemplate(scope, source.templateId)
    if (!plan || plan.sourceDraftId !== source.taskId || sourceFingerprint(plan) !== source.planHash) throw new AppError('PERSISTENCE_ERROR', { message: '定时任务的独立计划副本缺失或已变化，已停止执行。' })
    return plan
  }
  async copyInputs(scope: TaskOwnerScope, plan: WorkPlan, targetId: string): Promise<InputSnapshotRef | undefined> {
    if (!plan.inputSnapshot) return undefined
    if (!this.options.attachments) throw new AppError('INVALID_STATE')
    return this.options.attachments.copyTaskInputs(scope, plan.id, targetId, plan.inputSnapshot)
  }
}
