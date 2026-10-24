import { buildArrangementPlannerInput, buildArrangementPlannerUserPrompt, type ArrangementPlanningStage } from './arrangement-planner-prompts'
import { planningContractFailure, planningFailure, type PlanningDiagnosticContext, type PlanningPhase } from '../errors/planning-diagnostics'
import { arrangementMediaKindForFormat, arrangementNodeWorkContractSchema, validateArrangementDraft, type ArrangementCandidateMatch, type ArrangementDraft, type ArrangementIntentAnalysis, type ArrangementNode, type ArrangementUnresolvedStep } from './arrangement-plan'
import { normalizePlannerMediaContract } from './arrangement-planner-media'

export interface ArrangementPlannerCapability {
  id: string
  name: string
  description: string
  type?: string
}

export interface ArrangementPlannerEmployee {
  subscriptionId: string
  source?: 'authorized' | 'enterprise' | 'platform'
  canExecute?: boolean
  employeeId: string
  name: string
  description?: string
  position?: string
  functionalCategory?: string
  capabilities?: readonly ArrangementPlannerCapability[]
  canApply?: boolean
  allowedModels: readonly string[]
  status: string
}

export interface ArrangementPlanningProgress {
  planningId: string
  draftId: string
  draftRevision: number
  type: 'arrangement_planning_started' | 'arrangement_plan_ready' | 'arrangement_employee_considering' | 'arrangement_employee_selected' | 'arrangement_planning_completed' | 'arrangement_planning_failed' | 'arrangement_planning_cancelled'
  occurredAt: number
  data: {
    subscriptionId?: string
    employeeId?: string
    stage?: string
    rationale?: string
    nodeId?: string
    title?: string
    message?: string
    planSummary?: string
    planSteps?: Array<{ id: string; title: string }>
  }
}

export interface ArrangementPlanningResult {
  title: string
  nodes: ArrangementNode[]
  intentAnalysis?: ArrangementIntentAnalysis
  unresolvedSteps?: ArrangementUnresolvedStep[]
  candidateMatches?: ArrangementCandidateMatch[]
}

export interface ArrangementCandidateDirectory {
  listEnterprise(): Promise<ArrangementPlannerEmployee[]>
  listPlatform(): Promise<ArrangementPlannerEmployee[]>
}

export interface ArrangementEmployeeCapabilityDirectory {
  list(employeeId: string): Promise<ArrangementPlannerCapability[]>
}

export interface ArrangementPlannerPort {
  plan(input: {
    planningId: string
    planningStage?: ArrangementPlanningStage
    modelId?: string
    draft: ArrangementDraft
    employees: readonly ArrangementPlannerEmployee[]
    plannerEmployees?: readonly ArrangementPlannerEmployee[]
    plannerModelId?: string
    diagnosticContext?: PlanningDiagnosticContext
    signal?: AbortSignal
    onProgress: (event: ArrangementPlanningProgress) => void
  }): Promise<ArrangementPlanningResult>
  cancel?(planningId: string): void
}

export function buildArrangementPlannerPrompt(
  draft: Pick<ArrangementDraft, 'goal' | 'confirmedInputs' | 'intentAnalysis' | 'unresolvedSteps' | 'nodes' | 'candidateMatches'>,
  employees: readonly ArrangementPlannerEmployee[],
  planningStage: ArrangementPlanningStage = 'authorized',
): string {
  return buildArrangementPlannerUserPrompt(buildArrangementPlannerInput(draft, employees, planningStage))
}

export function parseArrangementPlannerOutput(
  raw: string,
  draft: ArrangementDraft,
  employees: readonly ArrangementPlannerEmployee[],
  onPhase?: (phase: PlanningPhase) => void,
): ArrangementPlanningResult {
  onPhase?.('json-extraction')
  const json = extractJson(raw)
  onPhase?.('json-parse')
  let value: unknown
  try { value = JSON.parse(json) as unknown } catch (error) { throw planningFailure('json-parse', 'invalid-json', error) }
  onPhase?.('output-validation')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw planningFailure('output-validation', 'invalid-output-shape')
  const record = value as Record<string, unknown>
  if (typeof record.title !== 'string' || !Array.isArray(record.nodes) || record.nodes.length > 32) {
    throw planningFailure('output-validation', 'invalid-output-shape')
  }
  const employeeById = new Map(employees.map(employee => [employee.subscriptionId, employee]))
  const intentAnalysis = parseIntentAnalysis(record.intentAnalysis)
  const unresolvedSteps = parseUnresolvedSteps(record.unresolvedSteps)
  const candidateMatches = parseCandidateMatches(record.candidateMatches, employees, intentAnalysis, unresolvedSteps)
  if (record.nodes.length === 0 && unresolvedSteps.length === 0) throw planningFailure('output-validation', 'empty-plan')
  const nodes = record.nodes.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw planningFailure('output-validation', 'invalid-node')
    const item = normalizePlannerMediaContract(candidate as Record<string, unknown>)
    const subscriptionId = stringField(item.subscriptionId)
    const modelId = stringField(item.modelId)
    if (!subscriptionId || !modelId) throw planningFailure('output-validation', 'missing-node-fields')
    const contract = arrangementNodeWorkContractSchema.safeParse(item)
    if (!contract.success) throw planningContractFailure(index, contract.error.issues)
    for (const [requirementIndex, requirement] of (contract.data.mediaRequirements ?? []).entries()) {
      if (requirement.required !== false && !requirement.inputFrom && (requirement.operation === 'edit' || requirement.operation === 'image-to-video')) {
        throw planningContractFailure(index, [{ path: ['mediaRequirements', requirementIndex, 'inputFrom'], code: 'custom' }], '请指定已选图片或上游图片交付物后重新规划。')
      }
    }
    for (const [fileIndex, file] of (contract.data.deliverables ?? []).entries()) {
      const kind = arrangementMediaKindForFormat(file.format)
      if (!file.artifact && kind && contract.data.mediaRequirements?.some(requirement => requirement.kind === kind)) {
        throw planningContractFailure(index, [{ path: ['deliverables', fileIndex, 'artifact'], code: 'custom' }], '请明确该交付物的媒体来源与操作后重新规划。')
      }
      if (file.artifact?.source === 'media-output' && (!kind || kind !== file.artifact.kind)) {
        throw planningContractFailure(index, [{ path: ['deliverables', fileIndex, 'format'], code: 'custom' }], '媒体原文件的格式需与类型一致，当前支持 PNG、JPEG、WebP、MP4、WebM；其他格式请另行安排转换。')
      }
    }
    return {
      id: stringField(item.id) ?? `node-${index + 1}`,
      subscriptionId,
      modelId,
      title: stringField(item.title) ?? '',
      instruction: stringField(item.instruction) ?? '',
      expectedOutput: stringField(item.expectedOutput) ?? '',
      knowledgeQuery: stringField(item.knowledgeQuery) ?? '',
      ...contract.data,
      dependsOn: stringArray(item.dependsOn),
      skillIds: [],
      ...(stringField(item.stepId) ? { stepId: stringField(item.stepId)! } : {}),
    }
  })
  if (nodes.some(node => !node.title || !node.instruction || !node.knowledgeQuery)) throw planningFailure('output-validation', 'missing-node-fields')
  onPhase?.('employee-validation')
  for (const node of nodes) {
    const employee = employeeById.get(node.subscriptionId)
    if (!employee || employee.status !== 'ACTIVE' || employee.canExecute === false) throw planningFailure('employee-validation', 'employee-unavailable')
  }
  onPhase?.('model-validation')
  for (const node of nodes) {
    if (!employeeById.get(node.subscriptionId)!.allowedModels.includes(node.modelId)) throw planningFailure('model-validation', 'model-not-allowed')
  }
  const planned: ArrangementDraft = {
    ...structuredClone(draft),
    title: record.title.trim(),
    status: nodes.length === 0 ? 'awaiting-employee' : 'ready',
    nodes,
    intentAnalysis,
    unresolvedSteps,
    revision: draft.revision,
    updatedAt: Date.now(),
  }
  onPhase?.('dag-validation')
  try { validateArrangementDraft(planned) } catch (error) { throw planningFailure('dag-validation', 'invalid-draft', error) }
  return {
    title: planned.title,
    nodes: structuredClone(nodes),
    ...(intentAnalysis ? { intentAnalysis: structuredClone(intentAnalysis) } : {}),
    ...(unresolvedSteps.length ? { unresolvedSteps: structuredClone(unresolvedSteps) } : {}),
    ...(candidateMatches.length ? { candidateMatches: structuredClone(candidateMatches) } : {}),
  }
}


function parseIntentAnalysis(value: unknown): ArrangementIntentAnalysis | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw planningFailure('output-validation', 'invalid-intent-analysis')
  const record = value as Record<string, unknown>
  if (typeof record.summary !== 'string' || !Array.isArray(record.steps) || record.steps.length === 0) throw planningFailure('output-validation', 'invalid-intent-analysis')
  const steps = record.steps.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw planningFailure('output-validation', 'invalid-intent-step')
    const item = candidate as Record<string, unknown>
    const id = stringField(item.id)
    const title = stringField(item.title)
    if (!id || !title) throw planningFailure('output-validation', 'invalid-intent-step')
    const requiredCapabilityIds = stringArray(item.requiredCapabilityIds)
    return { id, title, requiredCapabilities: stringArray(item.requiredCapabilities), ...(requiredCapabilityIds.length ? { requiredCapabilityIds } : {}), dependsOn: stringArray(item.dependsOn) }
  })
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw planningFailure('output-validation', 'duplicate-intent-step')
  return { summary: record.summary.trim(), steps }
}

function parseUnresolvedSteps(value: unknown): ArrangementUnresolvedStep[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw planningFailure('output-validation', 'invalid-unresolved-steps')
  return value.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw planningFailure('output-validation', 'invalid-unresolved-step')
    const item = candidate as Record<string, unknown>
    const stepId = stringField(item.stepId)
    const reason = stringField(item.reason)
    if (!stepId || !reason) throw planningFailure('output-validation', 'invalid-unresolved-step')
    const requiredCapabilityIds = stringArray(item.requiredCapabilityIds)
    return { stepId, reason, requiredCapabilities: stringArray(item.requiredCapabilities), ...(requiredCapabilityIds.length ? { requiredCapabilityIds } : {}) }
  })
}

function parseCandidateMatches(
  value: unknown,
  employees: readonly ArrangementPlannerEmployee[],
  intentAnalysis: ArrangementIntentAnalysis | undefined,
  unresolvedSteps: readonly ArrangementUnresolvedStep[],
): ArrangementCandidateMatch[] {
  if (!Array.isArray(value)) return []
  const employeeById = new Map(employees.map(employee => [employee.employeeId, employee]))
  const stepIds = new Set([
    ...(intentAnalysis?.steps.map(step => step.id) ?? []),
    ...unresolvedSteps.map(step => step.stepId),
  ])
  // Candidate matches are advisory. Invalid suggestions must not discard a valid plan.
  return value.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const item = candidate as Record<string, unknown>
    const stepId = stringField(item.stepId)
    const employeeId = stringField(item.employeeId)
    const rationale = stringField(item.rationale)
    if (!stepId || !employeeId || !rationale || !stepIds.has(stepId)) return []
    const employee = employeeById.get(employeeId)
    if (!employee || (employee.source !== 'enterprise' && employee.source !== 'platform') || employee.canExecute !== false || employee.canApply === false) return []
    return {
      stepId,
      employeeId,
      subscriptionId: employee.source === 'enterprise' ? employee.subscriptionId : null,
      source: employee.source as 'enterprise' | 'platform',
      name: employee.name,
      rationale,
      canExecute: false,
      canApply: true,
    }
  })
}

function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw)?.[1]
  const candidate = (fenced ?? raw).trim()
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0) throw planningFailure('json-extraction', 'json-not-found')
  if (end <= start) return candidate.slice(start)
  return candidate.slice(start, end + 1)
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value.map(item => item.trim()).filter(Boolean) : []
}
