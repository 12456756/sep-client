import { createHash, randomUUID } from 'node:crypto'
import type { Subscription } from '../common/platform/platform-api'
import type { ArrangementDraftStorePort } from '../data/arrangement-draft-store'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { TaskMetadataStore } from '../data/task-metadata-store'
import type { TaskManager } from '../runtime/task-manager'
import type { TaskExecutionPort } from './task-service'
import { TaskStatus } from '../../src/shared/types'
import { AppError } from '../errors/app-error'
import { operationFeedback } from '../errors/operation-feedback'
import type { ArrangementBlockingIssue } from '../../src/shared/arrangement-feedback'
import { logger, type LogFields } from '../common/logger'
import { describeError } from '../common/redact'
import { planningErrorFields, type PlanningDiagnosticContext, type PlanningPhase } from '../errors/planning-diagnostics'
import {
  effectivePermissionPolicy,
  preflightSubscription,
  validateArrangementDraft,
  validateNodeModels,
  type ArrangementDraft,
  type ArrangementExecutionSettings,
  type ArrangementMode,
  type ArrangementNode,
  type EffectiveTaskPermissionPolicy,
  type RequestedTaskPermissionPolicy,
  type WorkPlan,
} from '../domain/arrangement-plan'
import type { EmployeeAuthorizer } from './employee-authorizer'
import { requireScope, type ScopeSource } from './scope-guard'
import type { ArrangementCandidateDirectory, ArrangementEmployeeCapabilityDirectory, ArrangementPlannerPort, ArrangementPlannerDraft, ArrangementPlanningProgress, ArrangementPlannerEmployee } from '../domain/arrangement-planner'
import type { ArrangementUnresolvedStep, ArrangementCandidateMatch, ArrangementEmployeeAccessRequest } from '../domain/arrangement-plan'
import type { EmployeeAccessRequest, EmployeeAccessRequestInput } from '../common/platform/platform-api'
import { TaskCreationGate } from './task-creation-gate'
import { deliveryPlanIssues } from '../domain/arrangement-delivery'
import type { ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import type { ArrangementExecutionSnapshot, ArrangementMediaPhase, ArrangementMediaSummary } from '../../src/shared/types'
import type { ArrangementMediaLinkStorePort } from '../domain/arrangement-media'
import type { ArrangementMediaAssetsPort } from '../domain/arrangement-media-runtime'
import type { VideoStorePort } from '../domain/video-media'
import type { MediaStorePort } from '../domain/media'
import type { AttachmentService } from './attachment-service'
import type { DraftAttachmentCandidate, NodeInputRef } from '../../src/shared/attachment-contracts'
import type { ArrangementExecutionState } from '../domain/arrangement-execution'
import { planningRecordSummary, type PlanningRecordChange, type PlanningProgressSnapshot, type PlanningRecordSnapshot, type PlanningRecordSummary } from '../../src/shared/auto-planning'
import type { ArrangementProgressStorePort } from '../data/arrangement-progress-store'

export interface ArrangementServiceDependencies {
  scope: ScopeSource
  drafts: ArrangementDraftStorePort
  employees: EmployeeAuthorizer
  workPlans: WorkPlanStorePort
  taskMetadata: TaskMetadataStore
  taskManager: TaskManager
  creationGate?: TaskCreationGate
  execution: () => Promise<TaskExecutionPort>
  planner?: ArrangementPlannerPort
  candidateEmployees?: ArrangementCandidateDirectory
  employeeCapabilities?: ArrangementEmployeeCapabilityDirectory
  onPlanningEvent?: (event: ArrangementPlanningProgress) => void
  onPlanningRecordChanged?: (change: PlanningRecordChange) => void
  planningProgress?: ArrangementProgressStorePort
  employeeAccessRequests?: {
    create(input: EmployeeAccessRequestInput, idempotencyKey: string): Promise<EmployeeAccessRequest>
    get(requestId: string): Promise<EmployeeAccessRequest>
  }
  arrangementCheckpoints?: ArrangementCheckpointStorePort
  arrangementMediaLinks?: ArrangementMediaLinkStorePort
  arrangementMediaAssets?: ArrangementMediaAssetsPort
  videoStore?: VideoStorePort
  mediaStore?: MediaStorePort
  attachments?: AttachmentService
  confirmations?: import('../data/arrangement-confirmation-store').ArrangementConfirmationStorePort
}

export interface ArrangementContext {
  enterpriseId: string
  employees: Array<{
    subscriptionId: string
    employeeId: string
    name: string
    status: Subscription['status']
    allowedModels: string[]
    description?: string
    position?: string
    functionalCategory?: string
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
  issues: ArrangementBlockingIssue[]
  message: string | null
  checkedAt: number
  expiresAt: number
}

const DEFAULT_SUBSCRIPTION_THRESHOLD_MS = 15 * 60 * 1000
const log = logger.child('arrangement-service')

export class ArrangementService {
  private readonly creationGate: TaskCreationGate
  private readonly confirmationFlights = new Map<string, Promise<{ plan: WorkPlan; execution: null }>>()
  private generation = 0
  private readonly progress = new Map<string, PlanningProgressSnapshot>()
  private readonly planningOwners = new Map<string, { scope: { memberId: string; enterpriseId: string }; generation: number; draftId: string }>()
  private readonly planningStarts = new Map<string, Promise<{ draftId: string; planningId: string; status: 'planning' }>>()
  private readonly submissions = new Map<string, Promise<PlanningRecordSnapshot>>()

  constructor(private readonly deps: ArrangementServiceDependencies) {
    this.creationGate = deps.creationGate ?? new TaskCreationGate()
  }

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
        description: employee.description,
        position: employee.position,
        functionalCategory: employee.functionalCategory,
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

  async listPlanningRecords(): Promise<PlanningRecordSummary[]> {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    const drafts = await this.deps.drafts.list(scope)
    this.assertPlanningScope(scope, generation)
    const records: PlanningRecordSummary[] = []
    for (const draft of drafts) {
      if (draft.mode !== 'auto') continue
      if (!await this.isPlanningTaskVisible(draft, generation)) continue
      this.assertPlanningScope(scope, generation)
      records.push(planningRecordSummary(await this.reconcilePlanning(draft)))
    }
    this.assertPlanningScope(scope, generation)
    return records
  }

  async getPlanningRecord(draftId: string): Promise<PlanningRecordSnapshot> {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    const stored = await this.getDraft(draftId)
    this.assertPlanningScope(scope, generation)
    if (!await this.isPlanningTaskVisible(stored, generation)) throw new AppError('NOT_FOUND')
    const draft = await this.reconcilePlanning(stored)
    if (draft.mode !== 'auto') throw new AppError('INVALID_ARGUMENT')
    const key = JSON.stringify([draft.owner, draftId])
    const progress = this.progress.get(key) ?? await this.deps.planningProgress?.get(draft.owner, draftId) ?? null
    this.assertPlanningScope(scope, generation)
    return { draft, progress: progress && progress.planningId === draft.lastPlanning?.planningId ? structuredClone(progress) : null }
  }

  private async isPlanningTaskVisible(draft: ArrangementDraft, generation: number): Promise<boolean> {
    if (!draft.confirmedWorkPlanId) return true
    const task = await this.deps.taskManager.getTask(draft.confirmedWorkPlanId)
    this.assertPlanningScope(draft.owner, generation)
    if (!task) return false
    // Media deletion preserves the task for receipts; its archive also hides the linked draft.
    const archived = await this.deps.mediaStore?.isArchived(draft.owner, draft.confirmedWorkPlanId) ?? false
    this.assertPlanningScope(draft.owner, generation)
    return !archived
  }

  async createAndPlan(input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>, requestId: string, modelId: string): Promise<PlanningRecordSnapshot> {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    const key = JSON.stringify([scope, requestId])
    const existing = this.submissions.get(key)
    if (existing) return existing
    const flight = (async () => {
      if (input.mode !== 'auto' || input.nodes.length) throw new AppError('INVALID_ARGUMENT')
      const previous = (await this.deps.drafts.list(scope)).find(draft => draft.mode === 'auto' && draft.planningRequestId === requestId)
      this.assertPlanningScope(scope, generation)
      const draft = previous ?? await this.createDraft({ ...input, planningRequestId: requestId, planningModelId: modelId })
      this.assertPlanningScope(scope, generation)
      if (!previous) await this.startPlanning(draft.id, draft.revision, modelId)
      return this.getPlanningRecord(draft.id)
    })()
    this.submissions.set(key, flight)
    try { return await flight } finally { if (this.submissions.get(key) === flight) this.submissions.delete(key) }
  }

  private async reconcilePlanning(draft: ArrangementDraft): Promise<ArrangementDraft> {
    const generation = this.generation
    const key = JSON.stringify([draft.owner, draft.id])
    if (draft.status !== 'planning' || this.planningControllers.has(draft.lastPlanning?.planningId ?? '') || this.planningStarts.has(key)) return draft
    this.assertPlanningScope(draft.owner, this.generation)
    try {
      const updated = await this.deps.drafts.update(draft.owner, draft.id, draft.revision, { ...draft, status: 'planning-failed',
        lastPlanning: { planningId: draft.lastPlanning?.planningId ?? '', status: 'failed', message: '规划已中断，请重新规划' } })
      this.assertPlanningScope(draft.owner, generation)
      this.notifyPlanningRecord(updated)
      return updated
    } catch (error) {
      if (error instanceof AppError && error.code === 'DRAFT_REVISION_CONFLICT') return this.getDraft(draft.id)
      throw error
    }
  }

  private assertPlanningScope(scope: { memberId: string; enterpriseId: string }, generation: number): void {
    const current = this.deps.scope.currentScope()
    if (generation !== this.generation || !current || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
  }

  cancelAllPlanning(): void {
    this.generation++
    for (const [id, controller] of this.planningControllers) { controller.abort(); this.deps.planner?.cancel?.(id) }
    this.planningControllers.clear()
    this.planningOwners.clear()
    this.progress.clear()
    this.planningStarts.clear()
    this.submissions.clear()
  }

  private notifyPlanningRecord(draft: ArrangementDraft): void {
    if (draft.mode !== 'auto') return
    const current = this.deps.scope.currentScope()
    if (current?.memberId === draft.owner.memberId && current.enterpriseId === draft.owner.enterpriseId) {
      this.deps.onPlanningRecordChanged?.({ owner: draft.owner, draftId: draft.id, record: planningRecordSummary(draft) })
    }
  }

  async getDraft(draftId: string): Promise<ArrangementDraft> {
    const draft = await this.deps.drafts.get(requireScope(this.deps.scope), draftId)
    if (!draft) throw new AppError('NOT_FOUND')
    return draft
  }

  async getPlan(taskId: string): Promise<WorkPlan | null> {
    return this.deps.workPlans.get(requireScope(this.deps.scope), taskId)
  }

  async getExecution(taskId: string): Promise<ArrangementExecutionSnapshot | null> {
    const scope = requireScope(this.deps.scope)
    if (!this.deps.arrangementCheckpoints) return null
    const checkpoint = await this.deps.arrangementCheckpoints.get(scope, taskId)
    if (!checkpoint) return null
    const media = await this.mediaSummary(scope, taskId, checkpoint.state)
    return {
      activeRunId: checkpoint.activeRunId,
      status: checkpoint.state.status,
      updatedAt: checkpoint.updatedAt,
      nodes: checkpoint.state.nodes.map(node => ({
        nodeId: node.nodeId,
        status: node.status,
        ...(node.pendingConfirmation ? { pendingConfirmation: true } : {}),
        finalFiles: node.delivery?.finalFiles ? structuredClone(node.delivery.finalFiles) : [],
      })),
      ...(media.length ? { media } : {}),
    }
  }

  private async mediaSummary(scope: { memberId: string; enterpriseId: string }, taskId: string, state: ArrangementExecutionState): Promise<ArrangementMediaSummary[]> {
    if (!this.deps.arrangementMediaLinks) return []
    const links = await this.deps.arrangementMediaLinks.list(scope, taskId)
    return Promise.all(links.map(async link => {
      const assets = this.deps.arrangementMediaAssets ? await this.deps.arrangementMediaAssets.outputs(scope, taskId, link).catch(() => []) : []
      const assetById = new Map(assets.map(asset => [asset.artifactId, asset]))
      const videoAssets = link.kind === 'video' && this.deps.videoStore
        ? await this.deps.videoStore.listAssets({ ...scope, subscriptionId: link.subscriptionId }, taskId).catch(() => []) : []
      const outputIds = new Map(videoAssets.map(asset => [asset.localAssetId, asset.output.outputId]))
      const currentOutputs = new Map(link.outputs.map(output => [output.artifactId, output]))
      for (const asset of assets) currentOutputs.set(asset.artifactId, { artifactId: asset.artifactId, status: asset.status })
      const outputs = [...currentOutputs.values()].map(output => {
        const asset = assetById.get(output.artifactId)
        return { artifactId: output.artifactId, ...(asset ? { mime: asset.mime, size: asset.size } : {}), status: output.status, ...(link.kind === 'video' && outputIds.has(output.artifactId) ? { outputId: outputIds.get(output.artifactId) } : {}) }
      })
      const job = link.kind === 'image'
        ? await this.deps.mediaStore?.getJob(scope, taskId, link.jobId)
        : await this.deps.videoStore?.getJob({ ...scope, subscriptionId: link.subscriptionId }, taskId, link.jobId)
      const generation = job && ('generationStatus' in job ? job.generationStatus : job.receipt?.status)
      const node = state.nodes.find(node => node.nodeId === link.nodeId)
      const delivery = node?.delivery
      const materialization = link.materializations[link.materializations.length - 1]
      let phase: ArrangementMediaPhase
      if ((delivery?.mediaPhase === 'delivered' || node?.status === 'completed') && materialization?.status === 'saved' && outputs.some(output => output.status === 'saved')) phase = 'ready'
      else if (node && ['failed', 'blocked', 'interrupted', 'stopped'].includes(node.status) || materialization?.status === 'conflict' || job && (['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(generation ?? '') ||
        ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus) || job.trackingStatus !== 'ACTIVE' && job.saveStatus !== 'SAVED')) phase = 'blocked'
      else if (outputs.some(output => output.status === 'saved') || job?.saveStatus === 'SAVED') phase = 'materializing'
      else if (job?.saveStatus === 'SAVING' || ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(generation ?? '')) phase = 'saving'
      else if (generation === 'SUBMITTING') phase = 'preparing'
      else if (generation === 'QUEUED' || generation === 'SUBMISSION_UNKNOWN') phase = 'submitted'
      else phase = 'tracking'
      const pendingActions = phase === 'blocked' && (materialization?.status === 'conflict' || job && ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus)) ? ['retry-save' as const]
        : outputs.some(output => output.status === 'saved') ? ['export' as const] : []
      return { nodeId: link.nodeId, nodeRunId: link.nodeRunId, kind: link.kind, operation: link.operation,
        jobId: link.jobId, phase, inputs: link.inputs.map(input => ({ artifactId: input.artifactId, ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}) })),
        outputs, pendingActions,
        ...(job?.lastQueriedAt === undefined ? {} : { lastQueriedAt: job.lastQueriedAt }),
        ...(job && 'providerWaitMs' in job ? { providerWaitMs: job.providerWaitMs } : {}),
        ...(job && 'downloadMs' in job ? { downloadMs: job.downloadMs } : {}),
        ...(delivery?.materializeMs === undefined ? {} : { materializeMs: delivery.materializeMs }),
        ...(delivery?.deliveryMs === undefined ? {} : { deliveryMs: delivery.deliveryMs }),
      }
    }))
  }

  async createDraft(input: Omit<ArrangementDraft, 'id' | 'owner' | 'revision' | 'createdAt' | 'updatedAt'>): Promise<ArrangementDraft> {
    if (input.mode === 'auto' && input.nodes.length > 0) throw new AppError('INVALID_ARGUMENT')
    if (input.attachmentCandidates?.length && (!input.attachmentSessionId || !this.deps.attachments)) throw new AppError('INVALID_ARGUMENT', { message: '附件需要有效的导入会话。' })
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    const draft = await this.deps.drafts.create(scope, input)
    this.assertPlanningScope(scope, generation)
    if (input.attachmentCandidates?.length && input.attachmentSessionId && this.deps.attachments) {
      await this.deps.attachments.claimDraft(input.attachmentSessionId, draft.id, draft.revision, input.attachmentCandidates.map(item => item.attachment))
    }
    this.assertPlanningScope(scope, generation)
    this.notifyPlanningRecord(draft)
    return draft
  }

  async updateExecutionSettings(
    draftId: string,
    expectedRevision: number,
    settings: ArrangementExecutionSettings,
  ): Promise<ArrangementDraft> {
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    if (draft.mode !== 'auto' || !['ready', 'preflight-failed'].includes(draft.status) || draft.confirmedWorkPlanId) throw new AppError('INVALID_STATE')
    return this.deps.drafts.update(scope, draftId, expectedRevision, {
      ...draft,
      nodes: draft.nodes.map(node => ({ ...node, modelId: settings.modelId ?? node.modelId })),
      workspace: { ...draft.workspace, path: settings.workDir ?? draft.workspace.path },
      permissions: structuredClone(settings.permissions),
    })
  }

  async updateInputs(draftId: string, expectedRevision: number, inputs: { attachmentSessionId?: string; attachmentCandidates: DraftAttachmentCandidate[]; nodes?: Array<{ nodeId: string; inputRefs: NodeInputRef[] }> }): Promise<ArrangementDraft> {
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    if (draft.confirmedWorkPlanId || draft.status === 'planning') throw new AppError('INVALID_STATE')
    if (inputs.attachmentCandidates.length && (!inputs.attachmentSessionId || !this.deps.attachments)) throw new AppError('INVALID_ARGUMENT')
    const refs = inputs.attachmentCandidates.map(item => item.attachment)
    if (inputs.attachmentSessionId && this.deps.attachments) await this.deps.attachments.claimDraft(inputs.attachmentSessionId, draftId, expectedRevision + 1, refs)
    const nodeBindings = new Map((inputs.nodes ?? []).map(item => [item.nodeId, item.inputRefs]))
    if ([...nodeBindings.keys()].some(id => !draft.nodes.some(node => node.id === id))) throw new AppError('INVALID_ARGUMENT')
    return this.deps.drafts.update(scope, draftId, expectedRevision, {
      ...draft,
      schemaVersion: inputs.attachmentCandidates.length ? 2 : draft.schemaVersion,
      attachmentCandidates: structuredClone(inputs.attachmentCandidates),
      attachmentSessionId: inputs.attachmentSessionId,
      nodes: draft.nodes.map(node => ({ ...node, ...(nodeBindings.has(node.id) ? { inputRefs: structuredClone(nodeBindings.get(node.id)) } : {}) })),
    })
  }

  async deleteDraft(draftId: string): Promise<boolean> {
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    if (draft.status === 'planning' || draft.confirmedWorkPlanId) throw new AppError('INVALID_STATE')
    const deleted = await this.deps.drafts.delete(scope, draftId)
    if (deleted) {
      this.progress.delete(JSON.stringify([scope, draftId]))
      await this.deps.planningProgress?.delete(scope, draftId)
      this.deps.onPlanningRecordChanged?.({ owner: scope, draftId, record: null })
    }
    return deleted
  }

  async startPlanning(draftId: string, expectedRevision: number, modelId?: string): Promise<{ draftId: string; planningId: string; status: 'planning' }> {
    const scope = requireScope(this.deps.scope)
    const key = JSON.stringify([scope, draftId])
    const existing = this.planningStarts.get(key)
    if (existing) return existing
    const flight = this.startPlanningOnce(draftId, expectedRevision, modelId)
    this.planningStarts.set(key, flight)
    try { return await flight } finally { if (this.planningStarts.get(key) === flight) this.planningStarts.delete(key) }
  }

  private async startPlanningOnce(draftId: string, expectedRevision: number, modelId?: string): Promise<{ draftId: string; planningId: string; status: 'planning' }> {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    const draft = await this.getDraft(draftId)
    this.assertPlanningScope(scope, generation)
    if (draft.status === 'planning' && draft.lastPlanning && this.planningControllers.has(draft.lastPlanning.planningId)) {
      return { draftId, planningId: draft.lastPlanning.planningId, status: 'planning' }
    }
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    if (draft.mode !== 'auto' || draft.confirmedWorkPlanId || !this.deps.planner) throw new AppError('INVALID_STATE')
    const planningId = randomUUID()
    const updated = await this.deps.drafts.update(scope, draftId, expectedRevision, {
      ...draft,
      planningModelId: modelId ?? draft.planningModelId,
      status: 'planning',
      lastPlanning: { planningId, status: 'planning', message: null },
    })
    this.assertPlanningScope(scope, generation)
    const controller = new AbortController()
    this.planningControllers.set(planningId, controller)
    this.planningOwners.set(planningId, { scope, generation, draftId })
    this.progress.set(JSON.stringify([scope, draftId]), { owner: scope, draftId, planningId, modelId: modelId ?? draft.planningModelId ?? '', sequence: 0, events: [] })
    this.notifyPlanningRecord(updated)
    this.emitPlanning({ planningId, draftId, draftRevision: expectedRevision + 1, type: 'arrangement_planning_started', occurredAt: Date.now(), data: {} })
    void this.runPlanning(planningId, draftId, expectedRevision + 1, controller, modelId).catch(error => {
      log.error('background planning failed', {
        planningId,
        runId: planningId,
        draftId,
        ...planningErrorFields(error),
      })
    })
    return { draftId, planningId, status: 'planning' }
  }

  async cancelPlanning(draftId: string, planningId: string): Promise<{ cancelled: boolean }> {
    if (!this.deps.scope.currentScope()) return { cancelled: false }
    let draft: ArrangementDraft
    try {
      draft = await this.getDraft(draftId)
    } catch (error) {
      if (error instanceof AppError && error.code === 'AUTH_REQUIRED') return { cancelled: false }
      throw error
    }
    if (draft.lastPlanning?.planningId !== planningId || draft.lastPlanning.status !== 'planning') return { cancelled: false }
    this.planningControllers.get(planningId)?.abort()
    this.deps.planner?.cancel?.(planningId)
    return { cancelled: true }
  }

  async requestEmployeeAccess(draftId: string, expectedRevision: number, stepId: string, employeeId: string): Promise<ArrangementDraft> {
    if (!this.deps.employeeAccessRequests) throw new AppError('INVALID_STATE')
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    if (draft.mode !== 'auto' || draft.status !== 'awaiting-employee') throw new AppError('INVALID_STATE')
    if (!(draft.unresolvedSteps ?? []).some(step => step.stepId === stepId)) throw new AppError('INVALID_ARGUMENT')
    const candidate = (draft.candidateMatches ?? []).find(match => match.stepId === stepId && match.employeeId === employeeId)
    if (!candidate) throw new AppError('INVALID_ARGUMENT')
    const existing = draft.employeeAccessRequests?.find(request => request.stepId === stepId && request.employeeId === employeeId)
    const latest = existing ? await this.deps.employeeAccessRequests.get(existing.requestId) : await this.deps.employeeAccessRequests.create({
      targetType: candidate.source === 'enterprise' ? 'ENTERPRISE_SUBSCRIPTION' : 'PLATFORM_EMPLOYEE',
      subscriptionId: candidate.source === 'enterprise' ? candidate.subscriptionId : null,
      employeeId: candidate.source === 'platform' ? candidate.employeeId : null,
      reason: buildAccessRequestReason(draft, stepId, candidate),
      requestedCapabilities: requestedCapabilityIds(draft, stepId),
    }, accessRequestIdempotencyKey(draft.id, stepId, employeeId))
    const record = toArrangementAccessRequest(latest, candidate, stepId)
    const requests = [...(draft.employeeAccessRequests ?? []).filter(request => request.requestId !== record.requestId && !(request.stepId === stepId && request.employeeId === employeeId)), record]
    const updated = await this.deps.drafts.update(scope, draftId, expectedRevision, { ...draft, employeeAccessRequests: requests })
    this.notifyPlanningRecord(updated)
    return updated
  }

  async getEmployeeAccessRequest(draftId: string, requestId: string): Promise<ArrangementDraft> {
    if (!this.deps.employeeAccessRequests) throw new AppError('INVALID_STATE')
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    const existing = draft.employeeAccessRequests?.find(request => request.requestId === requestId)
    if (!existing) throw new AppError('NOT_FOUND')
    const latest = await this.deps.employeeAccessRequests.get(requestId)
    const candidate = (draft.candidateMatches ?? []).find(match => match.stepId === existing.stepId && match.employeeId === existing.employeeId)
    if (!candidate) throw new AppError('INVALID_STATE')
    const record = toArrangementAccessRequest(latest, candidate, existing.stepId)
    const requests = [...(draft.employeeAccessRequests ?? []).filter(request => request.requestId !== requestId), record]
    if (record.status === 'APPROVED') await this.deps.employees.refresh()
    const updated = await this.deps.drafts.update(scope, draftId, draft.revision, { ...draft, employeeAccessRequests: requests })
    this.notifyPlanningRecord(updated)
    return updated
  }

  private readonly planningControllers = new Map<string, AbortController>()

  private async runPlanning(planningId: string, draftId: string, planningRevision: number, controller: AbortController, modelId?: string): Promise<void> {
    const owner = this.planningOwners.get(planningId)!
    const context: LogFields = { planningId, runId: planningId, draftId, draftRevision: planningRevision, modelId, completedNodeCount: 0, unresolvedStepCount: 0 }
    let diagnosticContext: PlanningDiagnosticContext = { round: 1, employeeScope: 'authorized' }
    let phase: PlanningPhase = 'initialization'
    let phaseStartedAt = Date.now()
    const nextPhase = (next: PlanningPhase, nextContext = diagnosticContext): void => {
      log.info('planning phase completed', { ...context, ...diagnosticContext, phase, elapsedMs: Date.now() - phaseStartedAt })
      phase = next
      diagnosticContext = nextContext
      phaseStartedAt = Date.now()
      log.info('planning phase started', { ...context, ...diagnosticContext, phase })
    }
    log.info('planning phase started', { ...context, ...diagnosticContext, phase })
    try {
      const current = await this.getDraft(draftId)
      this.assertPlanningScope(owner.scope, owner.generation)
      context.taskTitle = current.goal
      if (current.attachmentCandidates?.some(candidate => candidate.mustUse) && !this.deps.attachments) {
        throw new AppError('INVALID_STATE', { message: '自动编排无法读取已要求使用的附件。' })
      }
      const plannerAttachmentMaterials = current.attachmentCandidates?.length && this.deps.attachments
        ? await this.deps.attachments.plannerMaterialsForDraft(draftId, current.attachmentCandidates).then(materials => materials.map(material => ({
          ...material, attachment: { attachmentId: material.attachmentId, sha256: material.sha256 },
          mustUse: current.attachmentCandidates?.find(candidate => candidate.attachment.attachmentId === material.attachmentId)?.mustUse ?? false,
        })))
        : []
      const planningSource = { ...current, plannerAttachmentMaterials }
      context.completedNodeCount = current.nodes.length
      context.unresolvedStepCount = current.unresolvedSteps?.length ?? 0
      nextPhase('employee-loading')
      const authorized = await this.loadAuthorizedPlannerEmployees({ ...context, ...diagnosticContext })
      this.assertPlanningScope(owner.scope, owner.generation)
      context.employeeCount = authorized.length
      let planningDraft: ArrangementPlannerDraft = planningSource
      let employees: ArrangementPlannerEmployee[] = authorized
      const plannerEmployees: ArrangementPlannerEmployee[] = authorized
      nextPhase('round-1')
      let result = await this.deps.planner!.plan({
        planningId, planningStage: 'authorized', draft: { ...planningDraft, plannerAttachmentMaterials }, employees, plannerEmployees, signal: controller.signal,
        modelId, plannerModelId: modelId,
        diagnosticContext,
        onProgress: event => this.emitPlanning(event),
      })
      this.assertPlanningScope(owner.scope, owner.generation)
      const intentAnalysis = result.intentAnalysis ?? current.intentAnalysis ?? undefined
      let unresolvedSteps = result.unresolvedSteps ?? []
      let candidateMatches = result.candidateMatches ?? []
      let executableNodes = mergeExecutableNodes([], result.nodes)
      context.completedNodeCount = executableNodes.length
      context.unresolvedStepCount = unresolvedSteps.length
      if (unresolvedSteps.length && this.deps.candidateEmployees) {
        nextPhase('employee-loading', { round: 2, employeeScope: 'enterprise' })
        const enterpriseCandidates = await this.deps.candidateEmployees.listEnterprise()
        this.assertPlanningScope(owner.scope, owner.generation)
        context.employeeCount = enterpriseCandidates.length
        if (enterpriseCandidates.length) {
          planningDraft = { ...planningSource, intentAnalysis: intentAnalysis ?? null, unresolvedSteps, nodes: executableNodes, candidateMatches }
          employees = enterpriseCandidates
          nextPhase('round-2')
          result = await this.deps.planner!.plan({
            planningId, planningStage: 'enterprise', draft: planningDraft, employees, plannerEmployees: authorized, signal: controller.signal,
            modelId, plannerModelId: modelId,
            diagnosticContext,
            onProgress: event => this.emitPlanning(event),
          })
          this.assertPlanningScope(owner.scope, owner.generation)
          executableNodes = mergeExecutableNodes(executableNodes, result.nodes)
          unresolvedSteps = result.unresolvedSteps ?? unresolvedSteps
          context.completedNodeCount = executableNodes.length
          context.unresolvedStepCount = unresolvedSteps.length
          const enterpriseMatches = matchCandidateEmployees(unresolvedSteps, enterpriseCandidates)
          candidateMatches = mergeCandidateMatches(
            mergeCandidateMatches(candidateMatches, result.candidateMatches ?? []),
            enterpriseMatches,
          )
        }
      }

      if (unresolvedSteps.length && this.deps.candidateEmployees) {
        nextPhase('employee-loading', { round: 3, employeeScope: 'platform' })
        const platform = await this.deps.candidateEmployees.listPlatform()
        this.assertPlanningScope(owner.scope, owner.generation)
        context.employeeCount = platform.length
        if (platform.length) {
          planningDraft = { ...planningSource, intentAnalysis: intentAnalysis ?? null, unresolvedSteps, nodes: executableNodes, candidateMatches }
          employees = platform
          nextPhase('round-3')
          result = await this.deps.planner!.plan({
            planningId, planningStage: 'platform', draft: planningDraft, employees, plannerEmployees: authorized, signal: controller.signal,
            modelId, plannerModelId: modelId,
            diagnosticContext,
            onProgress: event => this.emitPlanning(event),
          })
          this.assertPlanningScope(owner.scope, owner.generation)
          executableNodes = mergeExecutableNodes(executableNodes, result.nodes)
          unresolvedSteps = result.unresolvedSteps ?? unresolvedSteps
          context.completedNodeCount = executableNodes.length
          context.unresolvedStepCount = unresolvedSteps.length
          candidateMatches = mergeCandidateMatches(
            mergeCandidateMatches(candidateMatches, result.candidateMatches ?? []),
            matchCandidateEmployees(unresolvedSteps, platform),
          )
        }
      }
      if (controller.signal.aborted) throw new PlanningCancelledError()
      nextPhase('finalization')
      const latest = await this.deps.drafts.get(requireScope(this.deps.scope), draftId)
      this.assertPlanningScope(owner.scope, owner.generation)
      if (!latest || latest.revision !== planningRevision || latest.lastPlanning?.planningId !== planningId || latest.status !== 'planning') {
        log.info('planning result discarded', { ...context, ...diagnosticContext, phase, reason: 'draft-no-longer-current' })
        return
      }
      const updated = await this.deps.drafts.update(requireScope(this.deps.scope), draftId, planningRevision, {
        ...latest,
        title: result.title,
        nodes: executableNodes,
        intentAnalysis: result.intentAnalysis ?? intentAnalysis ?? null,
        unresolvedSteps,
        candidateMatches,
        status: unresolvedSteps.length ? 'awaiting-employee' : 'ready',
        lastPlanning: { planningId, status: 'ready', message: null },
      })
      this.assertPlanningScope(owner.scope, owner.generation)
      log.info('planning completed', { ...context, ...diagnosticContext, phase, status: updated.status, elapsedMs: Date.now() - phaseStartedAt })
      this.notifyPlanningRecord(updated)
      this.emitPlanning({ planningId, draftId, draftRevision: updated.revision, type: 'arrangement_planning_completed', occurredAt: Date.now(), data: { title: updated.title } })
    } catch (error) {
      if (error instanceof PlanningCancelledError || controller.signal.aborted) {
        log.info('planning cancelled', { ...context, ...diagnosticContext, phase })
        await this.finishCancelled(planningId, draftId, planningRevision)
      } else {
        await this.finishFailed(planningId, draftId, planningRevision, error, { ...context, ...diagnosticContext, phase })
      }
    } finally {
      this.planningControllers.delete(planningId)
      this.planningOwners.delete(planningId)
    }
  }

  private async loadAuthorizedPlannerEmployees(context: LogFields): Promise<ArrangementPlannerEmployee[]> {
    const employees = await this.deps.employees.list()
    return Promise.all(employees.map(async employee => {
      let capabilities: ArrangementPlannerEmployee['capabilities'] = []
      if (this.deps.employeeCapabilities) {
        try {
          capabilities = await this.deps.employeeCapabilities.list(employee.employeeId)
        } catch (error) {
          log.warn('employee capability summary unavailable during planning', {
            ...context,
            employeeId: employee.employeeId,
            ...planningErrorFields(error),
          })
        }
      }
      return {
        subscriptionId: employee.subscriptionId,
        employeeId: employee.employeeId,
        name: employee.name,
        description: employee.description,
        position: employee.position,
        functionalCategory: employee.functionalCategory,
        capabilities,
        allowedModels: [...employee.allowedModels],
        status: employee.status,
        source: 'authorized' as const,
        canExecute: true,
        canApply: false,
      } satisfies ArrangementPlannerEmployee
    }))
  }

  private async finishCancelled(planningId: string, draftId: string, revision: number): Promise<void> {
    // Authentication invalidation clears the scope before the detached planner settles.
    // There is no owner-safe draft transition left to write in that state.
    const scope = this.deps.scope.currentScope()
    if (!scope) return
    const owner = this.planningOwners.get(planningId)
    if (!owner || owner.generation !== this.generation || owner.scope.memberId !== scope.memberId || owner.scope.enterpriseId !== scope.enterpriseId) return
    const latest = await this.deps.drafts.get(scope, draftId)
    this.assertPlanningScope(owner.scope, owner.generation)
    if (!latest || latest.revision !== revision || latest.lastPlanning?.planningId !== planningId) return
    const updated = await this.deps.drafts.update(scope, draftId, revision, { ...latest, status: 'editing', lastPlanning: { planningId, status: 'cancelled', message: null } })
    if (owner.generation !== this.generation) return
    this.notifyPlanningRecord(updated)
    this.emitPlanning({ planningId, draftId, draftRevision: updated.revision, type: 'arrangement_planning_cancelled', occurredAt: Date.now(), data: {} })
  }

  private async finishFailed(planningId: string, draftId: string, revision: number, error: unknown, context: LogFields): Promise<void> {
    const fields = planningErrorFields(error)
    log.error('planning failed', { ...context, ...fields, phase: fields.phase ?? context.phase })
    // The planner can fail after authentication cleanup has already removed the scope.
    // Treat that cleanup race as terminal rather than throwing a second auth error.
    const scope = this.deps.scope.currentScope()
    if (!scope) return
    const owner = this.planningOwners.get(planningId)
    if (!owner || owner.generation !== this.generation || owner.scope.memberId !== scope.memberId || owner.scope.enterpriseId !== scope.enterpriseId) return
    const latest = await this.deps.drafts.get(scope, draftId)
    this.assertPlanningScope(owner.scope, owner.generation)
    if (!latest || latest.revision !== revision || latest.lastPlanning?.planningId !== planningId || latest.status !== 'planning') return
    const message = operationFeedback(error, 'planning').message
    const updated = await this.deps.drafts.update(scope, draftId, revision, { ...latest, status: 'planning-failed', lastPlanning: { planningId, status: 'failed', message } })
    if (owner.generation !== this.generation) return
    this.notifyPlanningRecord(updated)
    this.emitPlanning({ planningId, draftId, draftRevision: updated.revision, type: 'arrangement_planning_failed', occurredAt: Date.now(), data: { message: updated.lastPlanning?.message ?? undefined } })
  }

  private emitPlanning(event: ArrangementPlanningProgress): void {
    const owner = this.planningOwners.get(event.planningId)
    if (!owner || owner.generation !== this.generation) return
    const current = this.deps.scope.currentScope()
    if (!current || current.memberId !== owner.scope.memberId || current.enterpriseId !== owner.scope.enterpriseId) return
    const key = JSON.stringify([owner.scope, event.draftId])
    const previous = this.progress.get(key)
    if (!previous || previous.planningId !== event.planningId) return
    const next = { ...event, owner: owner.scope, sequence: previous.sequence + 1 }
    const snapshot = { ...previous, sequence: next.sequence, events: [...previous.events, next].slice(-128) }
    this.progress.set(key, snapshot)
    void this.deps.planningProgress?.save(owner.scope, snapshot).catch(error => log.error('planning progress persistence failed', { draftId: event.draftId, cause: describeError(error) }))
    this.deps.onPlanningEvent?.(next)
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
    const general = draft.mode === 'conversation' && draft.conversation?.kind === 'general'
    const generalSubscription = general
      ? context.employees.find(employee => employee.status === 'ACTIVE' && employee.allowedModels.includes(draft.conversation!.modelId!))
      : undefined
    const subscriptionIds = draft.mode === 'conversation'
      ? general ? generalSubscription ? [generalSubscription.subscriptionId] : [] : draft.conversation?.participants.map(participant => participant.subscriptionId) ?? []
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
      ? general ? generalSubscription ? [] : ['通用助手没有可用于所选模型的有效订阅。'] : (draft.conversation?.participants ?? []).flatMap(participant => {
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
      ...(draft.mode === 'auto' ? deliveryPlanIssues(draft.nodes).map(issue => issue.message) : []),
      ...(draft.mode === 'auto' && draft.unresolvedSteps?.length ? ['仍有未解决的工作步骤，不能启动不完整计划。'] : []),
      ...subscriptions.filter(item => !item.available || !item.passesThreshold).map(item => `${item.subscriptionId}:${item.reasonCode ?? 'unavailable'}`),
      ...modelIssues,
    ]
    const issues: ArrangementBlockingIssue[] = []
    if (subscriptions.some(item => !item.available || !item.passesThreshold) || general && !generalSubscription) {
      issues.push({ code: 'EMPLOYEE_UNAVAILABLE', message: general ? '当前模型没有可用的员工授权，请联系平台管理员' : '所选员工当前不可用，请重新选择员工' })
    }
    if (modelIssues.length && !(general && !generalSubscription)) issues.push({
      code: 'MODEL_NOT_ALLOWED',
      message: draft.mode === 'auto' ? '自动编排选择了不可用的模型，请联系平台管理员' : '所选员工不支持当前模型，请重新选择',
    })
    if (draft.mode === 'auto' && draft.unresolvedSteps?.length) issues.push({ code: 'UNRESOLVED_STEPS', message: '还有工作步骤缺少员工，请先完成员工匹配' })
    if (draft.mode === 'auto') {
      for (const issue of deliveryPlanIssues(draft.nodes)) issues.push({ code: 'DELIVERY_INVALID', message: issue.code === 'DUPLICATE_DELIVERY'
        ? '自动编排的交付文件冲突，请联系平台管理员'
        : issue.code === 'MEDIA_FORMAT_UNSUPPORTED' ? '当前图片交付仅支持 PNG 格式，请调整要求后重新编排'
        : issue.code === 'WORKSPACE_MEDIA_UNSUPPORTED' ? '当前编排不支持所选图片或视频交付方式，请调整要求后重新编排'
        : '自动编排的交付安排不完整，请联系平台管理员' })
    }
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
      issues,
      message: issues[0]?.message ?? null,
      checkedAt,
      expiresAt: checkedAt + 60_000,
    }
  }

  async confirmDraft(draftId: string, expectedRevision: number, idempotencyKey: string): Promise<{ plan: WorkPlan; execution: null }> {
    const flightKey = `${draftId}:${expectedRevision}`
    const active = this.confirmationFlights.get(flightKey)
    if (active) return active
    const flight = this.confirmDraftOnce(draftId, expectedRevision, idempotencyKey)
    this.confirmationFlights.set(flightKey, flight)
    try { return await flight }
    finally { if (this.confirmationFlights.get(flightKey) === flight) this.confirmationFlights.delete(flightKey) }
  }

  private async confirmDraftOnce(draftId: string, expectedRevision: number, idempotencyKey: string): Promise<{ plan: WorkPlan; execution: null }> {
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    if (draft.confirmedWorkPlanId) {
      const existing = await this.deps.workPlans.get(scope, draft.confirmedWorkPlanId)
      if (existing) return { plan: existing, execution: null }
    }
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    const preflight = await this.preflightDraft(draftId, expectedRevision)
    if (!preflight.canStart || !preflight.permissionPolicy) throw new AppError('INVALID_STATE', { message: preflight.message ?? undefined })
    const primarySubscription = draft.mode === 'conversation'
      ? draft.conversation?.kind === 'general' ? preflight.subscriptions[0]?.subscriptionId : draft.conversation?.participants[0]?.subscriptionId
      : draft.nodes[0]?.subscriptionId
    if (!primarySubscription) throw new AppError('INVALID_ARGUMENT')
    const current = requireScope(this.deps.scope)
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('AUTH_REQUIRED')
    const lease = this.creationGate.begin(scope)
    let success = false
    try {
      const confirmation = await this.deps.confirmations?.get(scope, draftId, expectedRevision)
      if (confirmation && confirmation.idempotencyKey !== idempotencyKey) throw new AppError('INVALID_ARGUMENT', { message: '该草稿版本已使用其他确认请求。' })
      const taskId = confirmation?.taskId ?? randomUUID()
      if (!confirmation) await this.deps.confirmations?.save(scope, { draftId, revision: expectedRevision, taskId, idempotencyKey, state: 'preparing' })
      const existingTask = confirmation ? await this.deps.taskManager.getTask(taskId) : null
      const task = existingTask ?? await this.deps.taskManager.createTask(draft.title || draft.goal, draft.goal, draft.workspace.path ?? undefined, primarySubscription, taskId)
      lease.taskCreated(task.id)
      const inputSnapshot = draft.attachmentCandidates?.length && this.deps.attachments
        ? await this.deps.attachments.freezeDraft(draft.id, task.id, draft.attachmentCandidates.map(item => item.attachment))
        : undefined
      const plan = {
        id: task.id,
        schemaVersion: 1 as const,
        sourceDraftId: draft.id,
        sourceDraftRevision: draft.revision,
        owner: { ...scope },
        mode: draft.mode,
        title: draft.title || draft.goal,
        goal: draft.goal,
        conversation: draft.conversation?.kind === 'general'
          ? { ...structuredClone(draft.conversation), participants: [{ subscriptionId: primarySubscription, modelId: draft.conversation.modelId! }], activeSubscriptionId: primarySubscription }
          : draft.conversation ? structuredClone(draft.conversation) : null,
        nodes: structuredClone(draft.nodes),
        workspace: { mode: 'shared' as const, path: task.workDir },
        permissions: preflight.permissionPolicy,
        confirmedInputs: [...draft.confirmedInputs],
        ...(inputSnapshot ? { inputSnapshot } : {}),
        planHash: `${draft.id}:${draft.revision}:${idempotencyKey}`,
        createdAt: Date.now(),
      }
      await this.deps.workPlans.save(scope, plan)
      await this.deps.taskMetadata.save(scope, {
        version: 1,
        taskId: task.id,
        kind: draft.mode === 'conversation' ? 'conversation' : 'arrangement',
        participantSubscriptionIds: draft.mode === 'conversation'
          ? draft.conversation?.kind === 'general' ? [] : [...new Set(draft.conversation?.participants.map(item => item.subscriptionId) ?? [])]
          : [...new Set(draft.nodes.map(node => node.subscriptionId))],
        currentSubscriptionId: draft.conversation?.kind === 'general' ? null : primarySubscription,
        createdAt: Date.now(),
      })
      const confirmedDraft = await this.deps.drafts.update(scope, draft.id, draft.revision, {
        ...draft,
        status: 'confirmed',
        confirmedWorkPlanId: plan.id,
      })
      this.notifyPlanningRecord(confirmedDraft)
      await this.deps.confirmations?.save(scope, { draftId, revision: expectedRevision, taskId: task.id, idempotencyKey, state: 'committed' })
      success = true
      return { plan, execution: null }
    } finally {
      lease.finish(success)
    }
  }

  async confirmAndStart(draftId: string, expectedRevision: number, idempotencyKey: string): Promise<{ plan: WorkPlan; execution: { id: string; status: 'queued' | 'running' } }> {
    const confirmed = await this.confirmDraft(draftId, expectedRevision, idempotencyKey)
    const task = await this.deps.taskManager.getTask(confirmed.plan.id)
    if (!task) throw new AppError('NOT_FOUND')
    if (task.status === TaskStatus.PENDING && task.activeRunId === null) {
      try {
        await (await this.deps.execution()).executeTask(task.id, { conversation: confirmed.plan.mode === 'conversation' })
      } catch (error) {
        try { await this.deps.taskManager.recordStartFailure?.(task.id, describeError(error)) } catch { /* preserve the original start error */ }
        throw error
      }
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

function mergeCandidateMatches(
  existing: readonly ArrangementCandidateMatch[],
  added: readonly ArrangementCandidateMatch[],
): ArrangementCandidateMatch[] {
  const byCandidate = new Map(existing.map(match => [`${match.stepId}:${match.employeeId}`, match]))
  for (const match of added) {
    byCandidate.set(`${match.stepId}:${match.employeeId}`, match)
  }
  return [...byCandidate.values()]
}

function mergeExecutableNodes(
  existing: readonly ArrangementNode[],
  added: readonly ArrangementNode[],
): ArrangementNode[] {
  const byStep = new Map<string, ArrangementNode>()
  const order: string[] = []
  for (const node of [...existing, ...added]) {
    const key = node.stepId ?? node.id
    if (!byStep.has(key)) order.push(key)
    byStep.set(key, node)
  }
  return order.map(key => byStep.get(key)!).filter(Boolean)
}

function requestedCapabilityIds(draft: ArrangementDraft, stepId: string): string[] {
  const step = draft.intentAnalysis?.steps.find(item => item.id === stepId)
  return step?.requiredCapabilityIds?.length ? [...step.requiredCapabilityIds] : []
}

function matchCandidateEmployees(
  steps: readonly ArrangementUnresolvedStep[],
  employees: readonly ArrangementPlannerEmployee[],
): ArrangementCandidateMatch[] {
  const matches: ArrangementCandidateMatch[] = []
  for (const step of steps) {
    const required = [...step.requiredCapabilityIds ?? [], ...step.requiredCapabilities]
      .map(normalizeMatchText)
      .filter(Boolean)
    if (!required.length) continue
    for (const employee of employees) {
      if (employee.canExecute !== false || employee.canApply !== true) continue
      const capabilities = employee.capabilities ?? []
      const covered = required.filter(need => capabilities.some(capability => {
        const fields = [capability.id, capability.name, capability.description].map(normalizeMatchText)
        return fields.some(field => field === need || field.includes(need) || need.includes(field))
      }))
      if (!covered.length) continue
      matches.push({
        stepId: step.stepId,
        employeeId: employee.employeeId,
        subscriptionId: employee.source === 'enterprise' ? employee.subscriptionId : null,
        source: employee.source === 'enterprise' ? 'enterprise' : 'platform',
        name: employee.name,
        rationale: `能力覆盖 ${covered.length}/${required.length}：${covered.join('、')}`,
        canExecute: false,
        canApply: true,
      })
    }
  }
  return matches
}

function normalizeMatchText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_\-/:：，。,.]+/g, '')
}

function accessRequestIdempotencyKey(draftId: string, stepId: string, employeeId: string): string {
  return createHash('sha256').update(`${draftId}:${stepId}:${employeeId}`).digest('hex')
}

function buildAccessRequestReason(draft: ArrangementDraft, stepId: string, candidate: ArrangementCandidateMatch): string {
  const step = draft.intentAnalysis?.steps.find(item => item.id === stepId)
  const capabilities = step?.requiredCapabilities.join('、') || '未指定能力'
  return `任务目标：${draft.goal}
所需步骤：${step?.title ?? stepId}
所需能力：${capabilities}
候选员工：${candidate.name}
匹配说明：${candidate.rationale}`.slice(0, 2000)
}

function toArrangementAccessRequest(
  request: EmployeeAccessRequest,
  candidate: ArrangementCandidateMatch,
  stepId: string,
): ArrangementEmployeeAccessRequest {
  return {
    requestId: request.requestId,
    stepId,
    employeeId: request.employee.employeeId,
    subscriptionId: request.employee.subscriptionId ?? candidate.subscriptionId,
    source: candidate.source,
    name: request.employee.name,
    status: request.status,
    requestedCapabilities: [...request.requestedCapabilities],
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    ...(request.message ? { message: request.message } : {}),
  }
}

class PlanningCancelledError extends Error {}

export type { ArrangementMode, ArrangementNode, RequestedTaskPermissionPolicy }
