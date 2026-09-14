import { randomUUID } from 'node:crypto'
import type { Subscription } from '../common/platform/platform-api'
import type { ArrangementDraftStorePort } from '../data/arrangement-draft-store'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { TaskMetadataStore } from '../data/task-metadata-store'
import type { TaskManager } from '../runtime/task-manager'
import type { TaskExecutionPort } from './task-service'
import { TaskStatus } from '../../src/shared/types'
import { AppError } from '../errors/app-error'
import {
  effectivePermissionPolicy,
  preflightSubscription,
  validateArrangementDraft,
  validateNodeModels,
  type ArrangementDraft,
  type ArrangementMode,
  type ArrangementNode,
  type EffectiveTaskPermissionPolicy,
  type RequestedTaskPermissionPolicy,
  type WorkPlan,
} from '../domain/arrangement-plan'
import type { EmployeeAuthorizer } from './employee-authorizer'
import { requireScope, type ScopeSource } from './scope-guard'

export interface ArrangementServiceDependencies {
  scope: ScopeSource
  drafts: ArrangementDraftStorePort
  employees: EmployeeAuthorizer
  workPlans: WorkPlanStorePort
  taskMetadata: TaskMetadataStore
  taskManager: TaskManager
  execution: () => Promise<TaskExecutionPort>
}

export interface ArrangementContext {
  enterpriseId: string
  employees: Array<{
    subscriptionId: string
    employeeId: string
    name: string
    status: Subscription['status']
    allowedModels: string[]
    templateVersion: string
  }>
  permissionCeiling: { presets: Array<'read-only' | 'workspace-edit' | 'full-local'>; allowedTools: string[] }
  generatedAt: number
}

export interface DraftPreflight {
  preflightId: string
  draftId: string
  draftRevision: number
  valid: boolean
  canStart: boolean
  subscriptions: ReturnType<typeof preflightSubscription>[]
  modelIssues: string[]
  permissionPolicy: EffectiveTaskPermissionPolicy | null
  blockingIssues: string[]
  checkedAt: number
  expiresAt: number
}

const DEFAULT_SUBSCRIPTION_THRESHOLD_MS = 15 * 60 * 1000

export class ArrangementService {
  constructor(private readonly deps: ArrangementServiceDependencies) {}

  async context(): Promise<ArrangementContext> {
    const scope = requireScope(this.deps.scope)
    const employees = await this.deps.employees.list()
    return {
      enterpriseId: scope.enterpriseId,
      employees: employees.map(employee => ({
        subscriptionId: employee.subscriptionId,
        employeeId: employee.employeeId,
        name: employee.name,
        status: employee.status,
        allowedModels: [...employee.allowedModels],
        templateVersion: employee.templateVersion,
      })),
      permissionCeiling: {
        presets: ['read-only', 'workspace-edit', 'full-local'],
        allowedTools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
      },
      generatedAt: Date.now(),
    }
  }

  async listDrafts(): Promise<ArrangementDraft[]> {
    return this.deps.drafts.list(requireScope(this.deps.scope))
  }

  async getDraft(draftId: string): Promise<ArrangementDraft> {
    const draft = await this.deps.drafts.get(requireScope(this.deps.scope), draftId)
    if (!draft) throw new AppError('NOT_FOUND')
    return draft
  }

  async getPlan(taskId: string): Promise<WorkPlan | null> {
    return this.deps.workPlans.get(requireScope(this.deps.scope), taskId)
  }

  async createDraft(input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>): Promise<ArrangementDraft> {
    return this.deps.drafts.create(requireScope(this.deps.scope), input)
  }

  async updateDraft(
    draftId: string,
    expectedRevision: number,
    patch: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): Promise<ArrangementDraft> {
    return this.deps.drafts.update(requireScope(this.deps.scope), draftId, expectedRevision, {
      ...patch,
      status: 'editing',
      lastPlanning: null,
      confirmedWorkPlanId: null,
    })
  }

  async deleteDraft(draftId: string): Promise<boolean> {
    return this.deps.drafts.delete(requireScope(this.deps.scope), draftId)
  }

  async validateDraft(draftId: string): Promise<{ valid: boolean; issues: string[]; revision: number }> {
    const draft = await this.getDraft(draftId)
    try {
      validateArrangementDraft(draft)
      return { valid: true, issues: [], revision: draft.revision }
    } catch {
      return { valid: false, issues: ['draft-invalid'], revision: draft.revision }
    }
  }

  async preflightDraft(draftId: string, expectedRevision: number): Promise<DraftPreflight> {
    const draft = await this.getDraft(draftId)
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    if (draft.mode !== 'conversation' && draft.nodes.length === 0) throw new AppError('INVALID_STATE')
    const checkedAt = Date.now()
    const context = await this.context()
    const subscriptionIds = draft.mode === 'conversation'
      ? draft.conversation?.participants.map(participant => participant.subscriptionId) ?? []
      : draft.nodes.map(node => node.subscriptionId)
    const uniqueIds = [...new Set(subscriptionIds)]
    const subscriptions = uniqueIds.map(subscriptionId => {
      const employee = context.employees.find(item => item.subscriptionId === subscriptionId)
      return preflightSubscription({
        subscriptionId,
        employeeId: employee?.employeeId,
        status: employee?.status === 'ACTIVE' ? 'ACTIVE' : employee?.status === 'PAUSED' ? 'PAUSED' : 'TERMINATED',
        endDate: null,
        allowedModels: employee?.allowedModels ?? [],
      }, checkedAt, DEFAULT_SUBSCRIPTION_THRESHOLD_MS)
    })
    const modelIssues = draft.mode === 'conversation'
      ? (draft.conversation?.participants ?? []).flatMap(participant => {
          const employee = context.employees.find(item => item.subscriptionId === participant.subscriptionId)
          return employee?.allowedModels.includes(participant.modelId) ? [] : [`conversation:${participant.subscriptionId}:model-not-allowed`]
        })
      : validateNodeModels(draft.nodes, subscriptions.map(item => ({
          subscriptionId: item.subscriptionId,
          employeeId: item.employeeId ?? undefined,
          status: item.status,
          endDate: item.subscriptionEndAt,
          allowedModels: item.modelIds,
        })))
    const permissionPolicy = effectivePermissionPolicy(draft.permissions)
    const blockingIssues = [
      ...subscriptions.filter(item => !item.available || !item.passesThreshold).map(item => `${item.subscriptionId}:${item.reasonCode ?? 'unavailable'}`),
      ...modelIssues,
    ]
    return {
      preflightId: randomUUID(),
      draftId,
      draftRevision: draft.revision,
      valid: blockingIssues.length === 0,
      canStart: blockingIssues.length === 0,
      subscriptions,
      modelIssues,
      permissionPolicy,
      blockingIssues,
      checkedAt,
      expiresAt: checkedAt + 60_000,
    }
  }

  async confirmDraft(draftId: string, expectedRevision: number, idempotencyKey: string): Promise<{ plan: WorkPlan; execution: null }> {
    void idempotencyKey
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    if (draft.confirmedWorkPlanId) {
      const existing = await this.deps.workPlans.get(scope, draft.confirmedWorkPlanId)
      if (existing) return { plan: existing, execution: null }
    }
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    const preflight = await this.preflightDraft(draftId, expectedRevision)
    if (!preflight.canStart || !preflight.permissionPolicy) throw new AppError('INVALID_STATE')
    const primarySubscription = draft.mode === 'conversation'
      ? draft.conversation?.participants[0]?.subscriptionId
      : draft.nodes[0]?.subscriptionId
    if (!primarySubscription) throw new AppError('INVALID_ARGUMENT')
    const task = await this.deps.taskManager.createTask(draft.title || draft.goal, draft.goal, draft.workspace.path ?? undefined, primarySubscription)
    const plan = {
      id: task.id,
      schemaVersion: 1 as const,
      sourceDraftId: draft.id,
      sourceDraftRevision: draft.revision,
      owner: { ...scope },
      mode: draft.mode,
      title: draft.title || draft.goal,
      goal: draft.goal,
      conversation: draft.conversation ? structuredClone(draft.conversation) : null,
      nodes: structuredClone(draft.nodes),
      workspace: { mode: 'shared' as const, path: task.workDir },
      permissions: preflight.permissionPolicy,
      confirmedInputs: [...draft.confirmedInputs],
      planHash: `${draft.id}:${draft.revision}:${idempotencyKey}`,
      createdAt: Date.now(),
    }
    await this.deps.workPlans.save(scope, plan)
    await this.deps.taskMetadata.save(scope, {
      version: 1,
      taskId: task.id,
      kind: draft.mode === 'conversation' ? 'conversation' : 'arrangement',
      participantSubscriptionIds: draft.mode === 'conversation'
        ? [...new Set(draft.conversation?.participants.map(item => item.subscriptionId) ?? [])]
        : [...new Set(draft.nodes.map(node => node.subscriptionId))],
      currentSubscriptionId: primarySubscription,
      createdAt: Date.now(),
    })
    await this.deps.drafts.update(scope, draft.id, draft.revision, {
      ...draft,
      status: 'confirmed',
      confirmedWorkPlanId: plan.id,
    })
    return { plan, execution: null }
  }

  async confirmAndStart(draftId: string, expectedRevision: number, idempotencyKey: string): Promise<{ plan: WorkPlan; execution: { id: string; status: 'queued' | 'running' } }> {
    const confirmed = await this.confirmDraft(draftId, expectedRevision, idempotencyKey)
    const task = await this.deps.taskManager.getTask(confirmed.plan.id)
    if (!task) throw new AppError('NOT_FOUND')
    if (task.status === TaskStatus.PENDING && task.activeRunId === null) {
      await (await this.deps.execution()).executeTask(task.id, { conversation: confirmed.plan.mode === 'conversation' })
      return { plan: confirmed.plan, execution: { id: task.id, status: 'queued' } }
    }
    if (task.status === TaskStatus.PENDING && task.activeRunId !== null) {
      return { plan: confirmed.plan, execution: { id: task.id, status: 'queued' } }
    }
    if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.WAITING_APPROVAL) {
      return { plan: confirmed.plan, execution: { id: task.id, status: 'running' } }
    }
    throw new AppError('INVALID_STATE')
  }
}

export type { ArrangementMode, ArrangementNode, RequestedTaskPermissionPolicy }


