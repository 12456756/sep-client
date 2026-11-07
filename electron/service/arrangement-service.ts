import { createHash, randomUUID } from 'node:crypto'
import { AuthApiError, type Subscription } from '../common/platform/platform-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
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
import type { ArrangementCandidateDirectory, ArrangementEmployeeCapabilityDirectory, ArrangementPlannerPort, ArrangementPlannerDraft, ArrangementPlanningProgress, ArrangementPlannerEmployee, ArrangementPlanningResult, ArrangementReplacementSearchInput, ArrangementReplacementSearchResult } from '../domain/arrangement-planner'
import { validateApprovedEmployeeAssignments } from '../domain/arrangement-planner'
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
import { requiredArrangementMediaTools, unknownArrangementMediaTools, type ArrangementMediaTools } from '../domain/arrangement-media-availability'
import { planningRecordSummary, type PlanningRecordChange, type PlanningProgressSnapshot, type PlanningRecordSnapshot, type PlanningRecordSummary } from '../../src/shared/auto-planning'
import type { ArrangementProgressStorePort } from '../data/arrangement-progress-store'
import { WriteChain } from '../data/write-chain'

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
  knowledgeCatalog?: (ids: readonly string[]) => Promise<Array<{ id: string; name: string }>>
  candidateEmployees?: ArrangementCandidateDirectory
  employeeCapabilities?: ArrangementEmployeeCapabilityDirectory
  mediaToolAvailability?: (subscriptionId: string) => Promise<ArrangementMediaTools>
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
  conversationQueue?: Pick<import('./conversation-queue-service').ConversationQueueService, 'scheduleInitial'>
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

interface AuthorizedCandidateRecheck {
  employees: readonly ArrangementPlannerEmployee[]
  stepId: string
  employeeId: string
}

export class ArrangementService {
  private readonly creationGate: TaskCreationGate
  private readonly confirmationFlights = new Map<string, Promise<{ plan: WorkPlan; execution: null }>>()
  private generation = 0
  private readonly progress = new Map<string, PlanningProgressSnapshot>()
  private readonly planningOwners = new Map<string, { scope: { memberId: string; enterpriseId: string }; generation: number; draftId: string }>()
  private readonly planningStarts = new Map<string, Promise<{ draftId: string; planningId: string; status: 'planning' }>>()
  private readonly submissions = new Map<string, Promise<PlanningRecordSnapshot>>()
  private readonly replacementWrites = new WriteChain()

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

  async findEmployeeReplacement(input: ArrangementReplacementSearchInput): Promise<ArrangementReplacementSearchResult> {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    const check = () => { input.signal.throwIfAborted(); this.assertPlanningScope(scope, generation) }
    const plan = await this.deps.workPlans.get(scope, input.taskId)
    check()
    const node = plan?.nodes.find(item => item.id === input.node.id)
    if (!plan || !node || node.subscriptionId !== input.node.subscriptionId) throw new AppError('INVALID_STATE')
    const authorized = await this.loadAuthorizedPlannerEmployees({ taskId: plan.id, nodeId: node.id })
    check()
    const source = await this.deps.drafts.get(scope, plan.sourceDraftId)
    check()
    const plannerModelId = source?.planningModelId && authorized.some(employee => employee.allowedModels.includes(source.planningModelId!))
      ? source.planningModelId : authorized.some(employee => employee.allowedModels.includes(node.modelId)) ? node.modelId : undefined
    if (!this.deps.planner?.findReplacement || !authorized.some(employee => employee.allowedModels.length)) {
      return { replacement: null, candidates: [] }
    }
    const search = async (stage: 'authorized' | 'enterprise' | 'platform', employees: ArrangementPlannerEmployee[]) => {
      check()
      if (!employees.length) return null
      const result = await this.deps.planner!.findReplacement!({ ...input, taskGoal: plan.goal, node, stage, employees,
        plannerEmployees: authorized, plannerModelId, confirmedInputs: plan.confirmedInputs,
        dependencies: plan.nodes.filter(item => node.dependsOn.includes(item.id)).map(item => ({
          id: item.id, title: item.title, expectedOutput: item.expectedOutput, deliverables: item.deliverables,
        })),
      })
      check()
      if (result && !employees.some(employee => employee.subscriptionId === result.subscriptionId)) throw new AppError('PLANNING_FAILED')
      return result
    }
    const requiredMediaTools = requiredArrangementMediaTools(node)
    const available = authorized.filter(employee => employee.subscriptionId !== node.subscriptionId && employee.status === 'ACTIVE' &&
      employee.canExecute !== false && employee.allowedModels.includes(node.modelId) &&
      requiredMediaTools.every(tool => employee.mediaTools?.[tool].state === 'available'))
    const replacement = await search('authorized', available)
    if (replacement) return { replacement, candidates: [] }
    for (const stage of ['enterprise', 'platform'] as const) {
      const directory = stage === 'enterprise' ? await this.deps.candidateEmployees?.listEnterprise() : await this.deps.candidateEmployees?.listPlatform()
      check()
      const employees = (directory ?? []).filter(employee => employee.canApply && employee.source === stage)
      const result = await search(stage, employees)
      if (!result) continue
      const candidate = employees.find(employee => employee.subscriptionId === result.subscriptionId)!
      return { replacement: null, candidates: [{ stepId: node.id, employeeId: candidate.employeeId,
        subscriptionId: stage === 'enterprise' ? candidate.subscriptionId : null, source: stage, name: candidate.name,
        rationale: result.rationale, canExecute: false, canApply: true }] }
    }
    return { replacement: null, candidates: [] }
  }

  async listDrafts(): Promise<ArrangementDraft[]> {
    return this.deps.drafts.list(requireScope(this.deps.scope))
  }

  async requestReplacementEmployeeAccess(taskId: string, nodeId: string, employeeId: string): Promise<ArrangementExecutionSnapshot | null> {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    await this.replacementWrites.run(JSON.stringify([scope, taskId]), async () => {
      const { plan, checkpoint, replacement } = await this.replacementAccessContext(taskId, nodeId)
      this.assertPlanningScope(scope, generation)
      const candidate = replacement.candidates?.find(item => item.employeeId === employeeId && item.canApply)
      if (!candidate || !this.deps.employeeAccessRequests) throw new AppError('INVALID_ARGUMENT')
      const existing = replacement.accessRequests?.find(item => item.employeeId === employeeId && item.source === candidate.source)
      const capabilities = (await this.deps.drafts.get(scope, plan.sourceDraftId))?.intentAnalysis?.steps
        .find(step => step.id === (plan.nodes.find(node => node.id === nodeId)?.stepId ?? nodeId))?.requiredCapabilityIds ?? []
      this.assertPlanningScope(scope, generation)
      const request = existing ? await this.deps.employeeAccessRequests.get(existing.requestId) : await this.deps.employeeAccessRequests.create({
        targetType: candidate.source === 'enterprise' ? 'ENTERPRISE_SUBSCRIPTION' : 'PLATFORM_EMPLOYEE',
        subscriptionId: candidate.source === 'enterprise' ? candidate.subscriptionId : null,
        employeeId: candidate.source === 'platform' ? candidate.employeeId : null,
        reason: `原任务补充执行员工。任务：${plan.goal}\n节点：${plan.nodes.find(node => node.id === nodeId)?.title}\n匹配依据：${candidate.rationale}`.slice(0, 2000),
        requestedCapabilities: capabilities,
      }, accessRequestIdempotencyKey(taskId, nodeId, `${candidate.source}:${employeeId}`))
      this.assertPlanningScope(scope, generation)
      const current = await this.replacementAccessContext(taskId, nodeId)
      if (current.checkpoint.updatedAt !== checkpoint.updatedAt) throw new AppError('INVALID_STATE')
      const record = toArrangementAccessRequest(request, candidate, nodeId)
      await this.deps.arrangementCheckpoints!.save(scope, { ...checkpoint, updatedAt: Date.now(), state: { ...checkpoint.state,
        nodes: checkpoint.state.nodes.map(node => node.nodeId === nodeId ? { ...node, employeeReplacement: { ...replacement,
          updatedAt: Date.now(), accessRequests: [...(replacement.accessRequests ?? []).filter(item => item.requestId !== record.requestId), record] } } : node) } })
    })
    return this.refreshReplacementEmployeeAccess(taskId)
  }

  async refreshReplacementEmployeeAccess(taskId: string): Promise<ArrangementExecutionSnapshot | null> {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    let resumeNodeId: string | undefined
    await this.replacementWrites.run(JSON.stringify([scope, taskId]), async () => {
      if (!this.deps.arrangementCheckpoints || !this.deps.employeeAccessRequests) return
      const task = await this.deps.taskManager.getTask(taskId)
      this.assertPlanningScope(scope, generation)
      if (!task || task.activeRunId || task.status !== TaskStatus.PAUSED) return
      const checkpoint = await this.deps.arrangementCheckpoints.get(scope, taskId)
      if (!checkpoint || ['stopped', 'completed'].includes(checkpoint.state.status)) return
      const state = structuredClone(checkpoint.state)
      let changed = false
      for (const node of state.nodes.filter(node => node.status === 'waiting-employee')) {
        const replacement = node.employeeReplacement
        if (!replacement) continue
        for (const record of replacement.accessRequests ?? []) {
          if (record.status !== 'PENDING' && record.status !== 'APPROVED') continue
          const latest = await this.deps.employeeAccessRequests.get(record.requestId)
          this.assertPlanningScope(scope, generation)
          const candidate = replacement.candidates?.find(item => item.employeeId === record.employeeId && item.source === record.source)
          if (!candidate) continue
          Object.assign(record, toArrangementAccessRequest(latest, candidate, node.nodeId))
          changed = true
          if (record.status === 'APPROVED') {
            const employees = await this.deps.employees.refresh()
            this.assertPlanningScope(scope, generation)
            const plan = await this.deps.workPlans.get(scope, taskId)
            const planNode = plan?.nodes.find(item => item.id === node.nodeId)
            const authorized = employees.find(employee => employee.employeeId === record.employeeId &&
              employee.subscriptionId !== replacement.originalSubscriptionId && employee.status === 'ACTIVE' &&
              planNode && employee.allowedModels.includes(planNode.modelId))
            if (authorized && planNode) {
              const requiredMediaTools = requiredArrangementMediaTools(planNode)
              let mediaTools: ArrangementMediaTools | undefined
              if (requiredMediaTools.length && this.deps.mediaToolAvailability) {
                try { mediaTools = await this.deps.mediaToolAvailability(authorized.subscriptionId) } catch (error) {
                  log.warn('replacement employee media runtime unavailable during approval refresh', { taskId, nodeId: node.nodeId, ...planningErrorFields(error) })
                }
                this.assertPlanningScope(scope, generation)
              }
              if (requiredMediaTools.every(tool => mediaTools?.[tool].state === 'available')) resumeNodeId ??= node.nodeId
            }
          }
        }
      }
      const currentTask = await this.deps.taskManager.getTask(taskId)
      const current = await this.deps.arrangementCheckpoints.get(scope, taskId)
      this.assertPlanningScope(scope, generation)
      if (currentTask?.activeRunId || currentTask?.status !== TaskStatus.PAUSED || current?.updatedAt !== checkpoint.updatedAt) { resumeNodeId = undefined; return }
      if (changed) await this.deps.arrangementCheckpoints.save(scope, { ...checkpoint, state, updatedAt: Date.now() })
    })
    this.assertPlanningScope(scope, generation)
    if (resumeNodeId) {
      const execution = await this.deps.execution()
      this.assertPlanningScope(scope, generation)
      await execution.retryTask(taskId, { nodeId: resumeNodeId })
    }
    return this.getExecution(taskId)
  }

  private async replacementAccessContext(taskId: string, nodeId: string) {
    const scope = requireScope(this.deps.scope)
    const generation = this.generation
    const task = await this.deps.taskManager.getTask(taskId)
    const plan = await this.deps.workPlans.get(scope, taskId)
    const checkpoint = await this.deps.arrangementCheckpoints?.get(scope, taskId)
    this.assertPlanningScope(scope, generation)
    const node = checkpoint?.state.nodes.find(item => item.nodeId === nodeId)
    if (!task || task.activeRunId || task.status !== TaskStatus.PAUSED || !plan || checkpoint?.planHash !== plan.planHash ||
      !checkpoint || ['stopped', 'completed'].includes(checkpoint.state.status) || node?.status !== 'waiting-employee' || !node.employeeReplacement) {
      throw new AppError('INVALID_STATE')
    }
    return { plan, checkpoint, replacement: node.employeeReplacement }
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
      // A persisted planning record can outlive the process that started it. Reuse
      // the draft identity, but restart any planning that did not reach a terminal
      // result so retries do not silently return an unfinished record.
      if (!previous || previous.status === 'planning' || previous.status === 'planning-failed') {
        await this.startPlanning(draft.id, draft.revision, modelId)
      }
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
        ...(node.inputRequest ? { inputRequest: structuredClone(node.inputRequest) } : {}),
        ...(node.employeeReplacement ? { employeeReplacement: structuredClone(node.employeeReplacement) } : {}),
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
    if (draft.mode !== 'auto' || !['ready', 'preflight-failed'].includes(draft.status) || draft.confirmedWorkPlanId) throw new AppError('INVALID_STATE', { details: { reason: 'settings-locked' } })
    const nodeKnowledge = settings.nodeKnowledge ?? []
    const nodeKnowledgeIds = new Set(nodeKnowledge.map(item => item.nodeId))
    if (nodeKnowledgeIds.size !== nodeKnowledge.length || nodeKnowledge.some(item => !draft.nodes.some(node => node.id === item.nodeId))) throw new AppError('INVALID_ARGUMENT', { details: { reason: 'settings-node-invalid' } })
    return this.deps.drafts.update(scope, draftId, expectedRevision, {
      ...draft,
      ...(settings.knowledge ? { knowledge: structuredClone(settings.knowledge) } : {}),
      nodes: draft.nodes.map(node => {
        const override = nodeKnowledge.find(item => item.nodeId === node.id)
        return {
          ...node,
          modelId: settings.modelId ?? node.modelId,
          ...(override ? (override.knowledge === null ? { knowledge: undefined } : { knowledge: structuredClone(override.knowledge) }) : {}),
        }
      }),
      workspace: { ...draft.workspace, path: settings.workDir ?? draft.workspace.path },
      permissions: structuredClone(settings.permissions),
    })
  }

  async updateInputs(draftId: string, expectedRevision: number, inputs: { attachmentSessionId?: string; attachmentCandidates: DraftAttachmentCandidate[]; nodes?: Array<{ nodeId: string; inputRefs: NodeInputRef[] }> }): Promise<ArrangementDraft> {
    const scope = requireScope(this.deps.scope)
    const draft = await this.getDraft(draftId)
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    if (draft.confirmedWorkPlanId || draft.status === 'planning') throw new AppError('INVALID_STATE', { details: { reason: 'attachments-locked' } })
    if (inputs.attachmentCandidates.length && (!inputs.attachmentSessionId || !this.deps.attachments)) throw new AppError('INVALID_ARGUMENT', { details: { reason: 'attachment-session-unavailable' } })
    const refs = inputs.attachmentCandidates.map(item => item.attachment)
    if (inputs.attachmentSessionId && this.deps.attachments) await this.deps.attachments.claimDraft(inputs.attachmentSessionId, draftId, expectedRevision + 1, refs)
    const nodeBindings = new Map((inputs.nodes ?? []).map(item => [item.nodeId, item.inputRefs]))
    if ([...nodeBindings.keys()].some(id => !draft.nodes.some(node => node.id === id))) throw new AppError('INVALID_ARGUMENT', { details: { reason: 'attachment-node-missing' } })
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
    return this.beginPlanning(draftId, expectedRevision, modelId)
  }

  private async beginPlanning(draftId: string, expectedRevision: number, modelId?: string, recheck?: AuthorizedCandidateRecheck): Promise<{ draftId: string; planningId: string; status: 'planning' }> {
    const scope = requireScope(this.deps.scope)
    const key = JSON.stringify([scope, draftId])
    const existing = this.planningStarts.get(key)
    if (existing) return existing
    const flight = this.startPlanningOnce(draftId, expectedRevision, modelId, recheck)
    this.planningStarts.set(key, flight)
    try { return await flight } finally { if (this.planningStarts.get(key) === flight) this.planningStarts.delete(key) }
  }

  private async startPlanningOnce(draftId: string, expectedRevision: number, modelId?: string, recheck?: AuthorizedCandidateRecheck): Promise<{ draftId: string; planningId: string; status: 'planning' }> {
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
    void this.runPlanning(planningId, draftId, expectedRevision + 1, controller, modelId, recheck).catch(error => {
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
    const generation = this.generation
    const draft = await this.getDraft(draftId)
    if (draft.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
    if (draft.mode !== 'auto' || draft.status !== 'awaiting-employee') throw new AppError('INVALID_STATE')
    if (!(draft.unresolvedSteps ?? []).some(step => step.stepId === stepId)) throw new AppError('INVALID_ARGUMENT')
    const candidate = (draft.candidateMatches ?? []).find(match => match.stepId === stepId && match.employeeId === employeeId)
    if (!candidate) throw new AppError('INVALID_ARGUMENT')
    let authorized: Subscription[] = []
    try { authorized = await this.deps.employees.list() } catch (error) {
      if (isAuthorizationError(error)) throw error
    }
    this.assertPlanningScope(scope, generation)
    try {
      const refreshed = await this.deps.employees.refresh()
      authorized = refreshed ?? await this.deps.employees.list()
    } catch (error) {
      if (isAuthorizationError(error)) throw error
      log.warn('authorized employee refresh unavailable before access request', { draftId, stepId, employeeId, ...planningErrorFields(error) })
    }
    this.assertPlanningScope(scope, generation)
    if (authorized.some(employee => employee.employeeId === employeeId && employee.status === 'ACTIVE')) {
      const employees = await this.loadAuthorizedPlannerEmployees({ draftId, stepId, employeeId }, authorized)
      this.assertPlanningScope(scope, generation)
      await this.beginPlanning(draftId, expectedRevision, draft.planningModelId, { employees, stepId, employeeId })
      return this.getDraft(draftId)
    }
    const current = await this.getDraft(draftId)
    this.assertPlanningScope(scope, generation)
    if (current.revision !== expectedRevision) throw new AppError('DRAFT_REVISION_CONFLICT')
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

  private async runPlanning(planningId: string, draftId: string, planningRevision: number, controller: AbortController, modelId?: string, recheck?: AuthorizedCandidateRecheck): Promise<void> {
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
      const plannerKnowledgeCatalog = current.knowledge && current.knowledge.mode !== 'none' && current.knowledge.knowledgeBaseIds.length
        ? await this.loadPlannerKnowledgeCatalog(current.knowledge.knowledgeBaseIds)
        : []
      const planningSource = { ...current, plannerAttachmentMaterials, plannerKnowledgeCatalog }
      context.completedNodeCount = current.nodes.length
      context.unresolvedStepCount = current.unresolvedSteps?.length ?? 0
      nextPhase('employee-loading')
      const approvedRequests = recheck ? [] : (current.employeeAccessRequests ?? []).filter(request => request.status === 'APPROVED' &&
        current.unresolvedSteps?.some(step => step.stepId === request.stepId))
      if (approvedRequests.length) {
        await this.deps.employees.refresh()
        this.assertPlanningScope(owner.scope, owner.generation)
      }
      const authorized = recheck ? [...recheck.employees] : await this.loadAuthorizedPlannerEmployees({ ...context, ...diagnosticContext })
      this.assertPlanningScope(owner.scope, owner.generation)
      context.employeeCount = authorized.length
      let approvedEmployeeAssignments = approvedRequests.map(request => {
        const sameStep = approvedRequests.filter(item => item.stepId === request.stepId)
        if (sameStep.length !== 1) throw new AppError('INVALID_STATE', { message: `步骤 ${request.stepId} 有多个已批准员工，无法确定绑定关系。` })
        const employee = authorized.find(item => item.employeeId === request.employeeId && item.status === 'ACTIVE' && item.canExecute !== false && item.allowedModels.length > 0)
        if (!employee) throw new AppError('INVALID_STATE', { message: `已批准的员工“${request.name}”暂不可执行，请刷新授权后重试，不会自动改派其他员工。` })
        return { stepId: request.stepId, employeeId: employee.employeeId, subscriptionId: employee.subscriptionId }
      })
      let planningDraft: ArrangementPlannerDraft = { ...planningSource, approvedEmployeeAssignments }
      let employees: ArrangementPlannerEmployee[] = authorized
      let plannerEmployees: ArrangementPlannerEmployee[] = authorized
      const initialAuthorizedPlannerEmployees: ArrangementPlannerEmployee[] = authorized
      nextPhase('round-1')
      let result: ArrangementPlanningResult
      if (recheck) {
        const candidates = [...(current.candidateMatches ?? [])].sort((left, right) =>
          Number(right.stepId === recheck.stepId && right.employeeId === recheck.employeeId) -
          Number(left.stepId === recheck.stepId && left.employeeId === recheck.employeeId))
        const reconciled = await this.reconcileAuthorizedCandidates({
          planningId, controller, context, planningSource, currentNodes: current.nodes,
          intentAnalysis: current.intentAnalysis ?? null, unresolvedSteps: current.unresolvedSteps ?? [],
          candidateMatches: candidates, executableNodes: current.nodes, approvedEmployeeAssignments,
          fallback: authorized, authorized, modelId,
        })
        approvedEmployeeAssignments = reconciled.approvedEmployeeAssignments
        result = { title: current.title, nodes: reconciled.executableNodes, unresolvedSteps: reconciled.unresolvedSteps,
          candidateMatches: reconciled.candidateMatches, intentAnalysis: current.intentAnalysis ?? undefined }
      } else result = await this.deps.planner!.plan({
        planningId, planningStage: 'authorized', draft: { ...planningDraft, plannerAttachmentMaterials }, employees, plannerEmployees, signal: controller.signal,
        modelId, plannerModelId: modelId,
        diagnosticContext,
        onProgress: event => this.emitPlanning(event),
      })
      this.assertPlanningScope(owner.scope, owner.generation)
      const intentAnalysis = result.intentAnalysis ?? current.intentAnalysis ?? undefined
      let unresolvedSteps = result.unresolvedSteps ?? []
      let candidateMatches = result.candidateMatches ?? []
      let executableNodes = mergeExecutableNodes([], sanitizePlannerNodes(result.nodes, current.nodes))
      validateApprovedEmployeeAssignments(approvedEmployeeAssignments, executableNodes, unresolvedSteps)
      context.completedNodeCount = executableNodes.length
      context.unresolvedStepCount = unresolvedSteps.length
      if (!recheck && unresolvedSteps.length && this.deps.candidateEmployees) {
        nextPhase('employee-loading', { round: 2, employeeScope: 'enterprise' })
        const enterpriseCandidates = await this.deps.candidateEmployees.listEnterprise()
        this.assertPlanningScope(owner.scope, owner.generation)
        context.employeeCount = enterpriseCandidates.length
        if (enterpriseCandidates.length) {
          planningDraft = { ...planningSource, intentAnalysis: intentAnalysis ?? null, unresolvedSteps, nodes: executableNodes, candidateMatches }
          employees = enterpriseCandidates
          nextPhase('round-2')
          result = await this.deps.planner!.plan({
            planningId, planningStage: 'enterprise', draft: planningDraft, employees, plannerEmployees, signal: controller.signal,
            modelId, plannerModelId: modelId,
            diagnosticContext,
            onProgress: event => this.emitPlanning(event),
          })
          this.assertPlanningScope(owner.scope, owner.generation)
          executableNodes = mergeExecutableNodes(executableNodes, sanitizePlannerNodes(result.nodes, current.nodes))
          unresolvedSteps = result.unresolvedSteps ?? unresolvedSteps
          context.completedNodeCount = executableNodes.length
          context.unresolvedStepCount = unresolvedSteps.length
          const enterpriseMatches = matchCandidateEmployees(unresolvedSteps, enterpriseCandidates)
          candidateMatches = mergeCandidateMatches(
            mergeCandidateMatches(candidateMatches, result.candidateMatches ?? []),
            enterpriseMatches,
          )
          const reconciled = await this.reconcileAuthorizedCandidates({
            planningId, controller, context: { ...context, ...diagnosticContext }, planningSource, currentNodes: current.nodes,
            intentAnalysis: intentAnalysis ?? null, unresolvedSteps, candidateMatches, executableNodes,
            approvedEmployeeAssignments, fallback: initialAuthorizedPlannerEmployees, modelId,
          })
          plannerEmployees = reconciled.authorized
          executableNodes = reconciled.executableNodes
          unresolvedSteps = reconciled.unresolvedSteps
          candidateMatches = reconciled.candidateMatches
          approvedEmployeeAssignments = reconciled.approvedEmployeeAssignments
          context.completedNodeCount = executableNodes.length
          context.unresolvedStepCount = unresolvedSteps.length
        }
      }

      if (!recheck && unresolvedSteps.length && this.deps.candidateEmployees) {
        nextPhase('employee-loading', { round: 3, employeeScope: 'platform' })
        const platform = await this.deps.candidateEmployees.listPlatform()
        this.assertPlanningScope(owner.scope, owner.generation)
        context.employeeCount = platform.length
        if (platform.length) {
          planningDraft = { ...planningSource, intentAnalysis: intentAnalysis ?? null, unresolvedSteps, nodes: executableNodes, candidateMatches }
          employees = platform
          nextPhase('round-3')
          result = await this.deps.planner!.plan({
            planningId, planningStage: 'platform', draft: planningDraft, employees, plannerEmployees, signal: controller.signal,
            modelId, plannerModelId: modelId,
            diagnosticContext,
            onProgress: event => this.emitPlanning(event),
          })
          this.assertPlanningScope(owner.scope, owner.generation)
          executableNodes = mergeExecutableNodes(executableNodes, sanitizePlannerNodes(result.nodes, current.nodes))
          unresolvedSteps = result.unresolvedSteps ?? unresolvedSteps
          context.completedNodeCount = executableNodes.length
          context.unresolvedStepCount = unresolvedSteps.length
          candidateMatches = mergeCandidateMatches(
            mergeCandidateMatches(candidateMatches, result.candidateMatches ?? []),
            matchCandidateEmployees(unresolvedSteps, platform),
          )
          const reconciled = await this.reconcileAuthorizedCandidates({
            planningId, controller, context: { ...context, ...diagnosticContext }, planningSource, currentNodes: current.nodes,
            intentAnalysis: intentAnalysis ?? null, unresolvedSteps, candidateMatches, executableNodes,
            approvedEmployeeAssignments, fallback: initialAuthorizedPlannerEmployees, modelId,
          })
          plannerEmployees = reconciled.authorized
          executableNodes = reconciled.executableNodes
          unresolvedSteps = reconciled.unresolvedSteps
          candidateMatches = reconciled.candidateMatches
          approvedEmployeeAssignments = reconciled.approvedEmployeeAssignments
          context.completedNodeCount = executableNodes.length
          context.unresolvedStepCount = unresolvedSteps.length
        }
      }
      if (controller.signal.aborted) throw new PlanningCancelledError()
      validateApprovedEmployeeAssignments(approvedEmployeeAssignments, executableNodes, unresolvedSteps)
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

  private async loadPlannerKnowledgeCatalog(ids: readonly string[]): Promise<Array<{ id: string; name: string }>> {
    if (!this.deps.knowledgeCatalog) throw new AppError('INVALID_STATE', { message: '知识库目录服务不可用。' })
    const expected = new Set(ids)
    const catalog = await this.deps.knowledgeCatalog(ids)
    const seen = new Set<string>()
    for (const item of catalog) {
      if (!expected.has(item.id) || seen.has(item.id) || !item.name.trim()) {
        throw new AppError('INVALID_STATE', { message: '知识库目录与用户选择不一致。' })
      }
      seen.add(item.id)
    }
    if (catalog.length !== ids.length) {
      throw new AppError('INVALID_STATE', { message: '知识库目录与用户选择不一致。' })
    }
    return catalog.map(item => ({ id: item.id, name: item.name }))
  }

  private async reconcileAuthorizedCandidates(input: {
    planningId: string
    controller: AbortController
    context: LogFields
    planningSource: ArrangementPlannerDraft
    currentNodes: readonly ArrangementNode[]
    intentAnalysis: NonNullable<ArrangementPlannerDraft['intentAnalysis']> | null
    unresolvedSteps: readonly ArrangementUnresolvedStep[]
    candidateMatches: readonly ArrangementCandidateMatch[]
    executableNodes: readonly ArrangementNode[]
    approvedEmployeeAssignments: readonly ApprovedEmployeeAssignment[]
    fallback: readonly ArrangementPlannerEmployee[]
    authorized?: readonly ArrangementPlannerEmployee[]
    modelId?: string
  }): Promise<{
    authorized: ArrangementPlannerEmployee[]
    executableNodes: ArrangementNode[]
    unresolvedSteps: ArrangementUnresolvedStep[]
    candidateMatches: ArrangementCandidateMatch[]
    approvedEmployeeAssignments: ApprovedEmployeeAssignment[]
  }> {
    const owner = this.planningOwners.get(input.planningId)
    if (!owner) throw new AppError('INVALID_STATE')
    const loadAuthorized = async (): Promise<ArrangementPlannerEmployee[]> => {
      try {
        const subscriptions = await this.deps.employees.refresh()
        this.assertPlanningScope(owner.scope, owner.generation)
        return await this.loadAuthorizedPlannerEmployees(input.context, subscriptions)
      } catch (error) {
        if (isAuthorizationError(error)) throw error
        this.assertPlanningScope(owner.scope, owner.generation)
        log.warn('authorized employee refresh unavailable during candidate reconciliation', { ...input.context, ...planningErrorFields(error) })
        return [...input.fallback]
      }
    }
    if (input.controller.signal.aborted) throw new PlanningCancelledError()
    const authorized = input.authorized ? [...input.authorized] : await loadAuthorized()
    this.assertPlanningScope(owner.scope, owner.generation)
    if (input.controller.signal.aborted) throw new PlanningCancelledError()
    const assignments = selectAuthorizedCandidateAssignments(input.unresolvedSteps, input.candidateMatches, authorized, input.approvedEmployeeAssignments)
    if (!assignments.length) return {
      authorized,
      executableNodes: [...input.executableNodes],
      unresolvedSteps: [...input.unresolvedSteps],
      candidateMatches: [...input.candidateMatches],
      approvedEmployeeAssignments: [...input.approvedEmployeeAssignments],
    }

    const assignmentByStep = new Map(assignments.map(assignment => [assignment.stepId, assignment]))
    const reconciliationSteps = input.unresolvedSteps.filter(step => assignmentByStep.has(step.stepId))
    const reconciliationCandidates = input.candidateMatches.filter(match => assignmentByStep.has(match.stepId))
    let result: ArrangementPlanningResult
    try {
      result = await this.deps.planner!.plan({
        planningId: input.planningId, planningStage: 'authorized',
        draft: {
          ...input.planningSource,
          intentAnalysis: input.intentAnalysis,
          nodes: [...input.executableNodes],
          unresolvedSteps: reconciliationSteps,
          candidateMatches: reconciliationCandidates,
          approvedEmployeeAssignments: assignments,
          preserveExistingNodes: true,
        },
        employees: authorized, plannerEmployees: authorized, modelId: input.modelId, plannerModelId: input.modelId,
        signal: input.controller.signal, diagnosticContext: { round: 1, employeeScope: 'authorized' },
        onProgress: event => this.emitPlanning(event),
      })
      this.assertPlanningScope(owner.scope, owner.generation)
      if (input.controller.signal.aborted) throw new PlanningCancelledError()
      const addedNodes = sanitizePlannerNodes(result.nodes, input.currentNodes).filter(node => {
        const assignment = node.stepId ? assignmentByStep.get(node.stepId) : undefined
        return assignment && node.subscriptionId === assignment.subscriptionId
          && !input.executableNodes.some(existing => existing.id === node.id || existing.stepId === node.stepId)
      })
      validateApprovedEmployeeAssignments(assignments, addedNodes, result.unresolvedSteps ?? [])
      validateArrangementDraft({ ...input.planningSource, nodes: [...input.executableNodes, ...addedNodes] })
      result = { ...result, nodes: addedNodes }
    } catch (error) {
      this.assertPlanningScope(owner.scope, owner.generation)
      if (input.controller.signal.aborted || error instanceof PlanningCancelledError || isAuthorizationError(error)) throw error
      log.warn('authorized candidate reconciliation did not produce execution nodes', { ...input.context, ...planningErrorFields(error) })
      return {
        authorized,
        executableNodes: [...input.executableNodes],
        unresolvedSteps: [...input.unresolvedSteps],
        candidateMatches: [...input.candidateMatches],
        approvedEmployeeAssignments: [...input.approvedEmployeeAssignments],
      }
    }
    const reconciledNodes = mergeExecutableNodes(input.executableNodes, result.nodes)
    const completedSteps = new Set(assignments.map(assignment => assignment.stepId))
    return {
      authorized,
      executableNodes: reconciledNodes,
      unresolvedSteps: input.unresolvedSteps.filter(step => !completedSteps.has(step.stepId)),
      candidateMatches: input.candidateMatches.filter(match => !completedSteps.has(match.stepId)),
      approvedEmployeeAssignments: mergeApprovedEmployeeAssignments(input.approvedEmployeeAssignments, assignments),
    }
  }

  private async loadAuthorizedPlannerEmployees(context: LogFields, subscriptions?: readonly Subscription[]): Promise<ArrangementPlannerEmployee[]> {
    const employees = subscriptions ?? await this.deps.employees.list()
    return Promise.all(employees.map(async employee => {
      let capabilities: ArrangementPlannerEmployee['capabilities'] = []
      let mediaTools = unknownArrangementMediaTools()
      if (this.deps.mediaToolAvailability) {
        try {
          mediaTools = await this.deps.mediaToolAvailability(employee.subscriptionId)
        } catch (error) {
          log.warn('employee media runtime unavailable during planning', { ...context, employeeId: employee.employeeId, ...planningErrorFields(error) })
        }
      }
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
        mediaTools,
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
      issues.push({ code: 'EMPLOYEE_UNAVAILABLE', message: general ? '当前模型没有可用的员工授权，请更换模型或联系平台管理员配置员工授权。' : '所选员工当前不可用，请重新选择员工' })
    }
    if (modelIssues.length && !(general && !generalSubscription)) issues.push({
      code: 'MODEL_NOT_ALLOWED',
      message: draft.mode === 'auto' ? '自动编排选择的模型不可用，请更换模型或联系平台管理员检查模型授权。' : '所选员工不支持当前模型，请重新选择',
    })
    if (draft.mode === 'auto' && draft.unresolvedSteps?.length) issues.push({ code: 'UNRESOLVED_STEPS', message: '还有工作步骤缺少员工，请先完成员工匹配' })
    if (draft.mode === 'auto') {
      for (const issue of deliveryPlanIssues(draft.nodes)) issues.push({ code: 'DELIVERY_INVALID', message: issue.code === 'DUPLICATE_DELIVERY'
        ? '自动编排中多个步骤使用了相同的交付文件路径，请修改计划后重试。'
        : issue.code === 'MEDIA_FORMAT_UNSUPPORTED' ? '当前图片交付仅支持 PNG 格式，请调整要求后重新编排'
        : issue.code === 'WORKSPACE_MEDIA_UNSUPPORTED' ? '当前编排不支持所选图片或视频交付方式，请调整要求后重新编排'
        : '自动编排缺少必要的工作目标或交付要求，请补充计划后重试。' })
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
        ...(draft.knowledge ? { knowledge: structuredClone(draft.knowledge) } : {}),
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
      if (confirmed.plan.mode === 'conversation' && this.deps.conversationQueue) {
        this.deps.conversationQueue.scheduleInitial(task.id)
        return { plan: confirmed.plan, execution: { id: task.id, status: 'queued' } }
      }
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

function sanitizePlannerNodes(nodes: readonly ArrangementNode[], userNodes: readonly ArrangementNode[]): ArrangementNode[] {
  const knowledgeById = new Map(userNodes.filter(node => node.knowledge !== undefined).map(node => [node.id, node.knowledge]))
  return nodes.map(node => {
    const knowledge = knowledgeById.get(node.id)
    const { knowledge: _modelKnowledge, ...withoutModelKnowledge } = node
    return knowledge === undefined ? withoutModelKnowledge : { ...withoutModelKnowledge, knowledge: structuredClone(knowledge) }
  })
}

function requestedCapabilityIds(draft: ArrangementDraft, stepId: string): string[] {
  const step = draft.intentAnalysis?.steps.find(item => item.id === stepId)
  return step?.requiredCapabilityIds?.length ? [...step.requiredCapabilityIds] : []
}

type ApprovedEmployeeAssignment = NonNullable<ArrangementPlannerDraft['approvedEmployeeAssignments']>[number]

function isAuthorizationError(error: unknown): boolean {
  return error instanceof AuthenticationRequiredError || error instanceof AuthApiError && (error.isUnauthorized || error.isForbidden)
    || error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')
}

function selectAuthorizedCandidateAssignments(
  steps: readonly ArrangementUnresolvedStep[],
  candidates: readonly ArrangementCandidateMatch[],
  authorized: readonly ArrangementPlannerEmployee[],
  existing: readonly ApprovedEmployeeAssignment[],
): ApprovedEmployeeAssignment[] {
  const stepIds = new Set(steps.map(step => step.stepId))
  const assignedSteps = new Set(existing.map(assignment => assignment.stepId))
  const authorizedByEmployeeId = new Map(authorized
    .filter(employee => employee.status === 'ACTIVE' && employee.canExecute !== false && employee.allowedModels.length > 0)
    .map(employee => [employee.employeeId, employee]))
  const selected = new Map<string, ApprovedEmployeeAssignment>()
  for (const candidate of candidates) {
    if (!stepIds.has(candidate.stepId) || assignedSteps.has(candidate.stepId) || selected.has(candidate.stepId)) continue
    const employee = authorizedByEmployeeId.get(candidate.employeeId)
    if (!employee) continue
    selected.set(candidate.stepId, { stepId: candidate.stepId, employeeId: employee.employeeId, subscriptionId: employee.subscriptionId })
  }
  return [...selected.values()]
}

function mergeApprovedEmployeeAssignments(
  existing: readonly ApprovedEmployeeAssignment[],
  added: readonly ApprovedEmployeeAssignment[],
): ApprovedEmployeeAssignment[] {
  const byStep = new Map<string, ApprovedEmployeeAssignment>()
  for (const assignment of [...existing, ...added]) {
    const previous = byStep.get(assignment.stepId)
    if (previous && (previous.employeeId !== assignment.employeeId || previous.subscriptionId !== assignment.subscriptionId)) {
      throw new AppError('INVALID_STATE', { message: `步骤 ${assignment.stepId} 有冲突的员工绑定，无法确定执行员工。` })
    }
    byStep.set(assignment.stepId, assignment)
  }
  return [...byStep.values()]
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
