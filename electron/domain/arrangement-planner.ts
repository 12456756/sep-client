import { buildArrangementPlannerInput, buildArrangementPlannerUserPrompt, type ArrangementPlanningStage } from './arrangement-planner-prompts'
import { planningContractFailure, planningFailure, planningFieldFailure, type PlanningDiagnosticContext, type PlanningPhase } from '../errors/planning-diagnostics'
import { arrangementMediaKindForFormat, arrangementNodeWorkContractSchema, validateArrangementDraft, type ArrangementCandidateMatch, type ArrangementDraft, type ArrangementIntentAnalysis, type ArrangementNode, type ArrangementUnresolvedStep } from './arrangement-plan'
import { normalizePlannerMediaContract } from './arrangement-planner-media'
import type { ArrangementMediaTools } from './arrangement-media-availability'

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
  mediaTools?: ArrangementMediaTools
  canApply?: boolean
  allowedModels: readonly string[]
  status: string
}

export interface ArrangementReplacementSearchInput {
  taskId: string
  planningId: string
  taskGoal: string
  node: ArrangementNode
  signal: AbortSignal
}

export interface ArrangementReplacementSearchResult {
  replacement: { subscriptionId: string; rationale: string } | null
  candidates: ArrangementCandidateMatch[]
}

export interface ArrangementPlanningProgress {
  sequence?: number
  owner?: { memberId: string; enterpriseId: string }
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

export type ArrangementPlannerDraft = ArrangementDraft & {
  plannerAttachmentMaterials?: import('./arrangement-planner-prompts').ArrangementPlannerInput['attachments']
  plannerKnowledgeCatalog?: import('./arrangement-planner-prompts').ArrangementPlannerInput['knowledgeCatalog']
  approvedEmployeeAssignments?: Array<{ stepId: string; employeeId: string; subscriptionId: string }>
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
    draft: ArrangementPlannerDraft
    employees: readonly ArrangementPlannerEmployee[]
    plannerEmployees?: readonly ArrangementPlannerEmployee[]
    plannerModelId?: string
    diagnosticContext?: PlanningDiagnosticContext
    signal?: AbortSignal
    onProgress: (event: ArrangementPlanningProgress) => void
  }): Promise<ArrangementPlanningResult>
  findReplacement?(input: {
    planningId: string
    taskGoal: string
    node: ArrangementNode
    stage?: ArrangementPlanningStage
    confirmedInputs?: readonly string[]
    dependencies?: readonly Pick<ArrangementNode, 'id' | 'title' | 'expectedOutput' | 'deliverables'>[]
    taskId?: string
    employees: readonly ArrangementPlannerEmployee[]
    plannerEmployees?: readonly ArrangementPlannerEmployee[]
    plannerModelId?: string
    signal?: AbortSignal
  }): Promise<{ subscriptionId: string; rationale: string } | null>
  cancel?(planningId: string): void
}

export function buildArrangementPlannerPrompt(
  draft: Pick<ArrangementDraft, 'goal' | 'confirmedInputs' | 'intentAnalysis' | 'unresolvedSteps' | 'nodes' | 'candidateMatches' | 'attachmentCandidates'> & { plannerAttachmentMaterials?: import('./arrangement-planner-prompts').ArrangementPlannerInput['attachments']; approvedEmployeeAssignments?: ArrangementPlannerDraft['approvedEmployeeAssignments'] },
  employees: readonly ArrangementPlannerEmployee[],
  planningStage: ArrangementPlanningStage = 'authorized',
): string {
  return buildArrangementPlannerUserPrompt(buildArrangementPlannerInput(draft, employees, planningStage))
}

export function parseArrangementPlannerOutput(
  raw: string,
  draft: ArrangementPlannerDraft,
  employees: readonly ArrangementPlannerEmployee[],
  onPhase?: (phase: PlanningPhase) => void,
): ArrangementPlanningResult {
  onPhase?.('json-extraction')
  const json = extractJson(raw)
  onPhase?.('json-parse')
  let value: unknown
  try { value = JSON.parse(json) as unknown } catch (error) { throw planningFailure('json-parse', 'invalid-json', error) }
  onPhase?.('output-validation')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw planningFieldFailure('output-validation', 'invalid-output-shape', [], '返回一个完整规划 JSON 对象，不能返回数组、null 或文字。')
  const record = value as Record<string, unknown>
  if (typeof record.title !== 'string' || !Array.isArray(record.nodes) || record.nodes.length > 32) {
    throw planningFieldFailure('output-validation', 'invalid-output-shape', typeof record.title !== 'string' ? ['title'] : ['nodes'], 'title 必须是字符串，nodes 必须是最多 32 项的数组；其余顶层结构按系统协议填写。')
  }
  const employeeById = new Map(employees.map(employee => [employee.subscriptionId, employee]))
  const intentAnalysis = parseIntentAnalysis(record.intentAnalysis)
  const unresolvedSteps = parseUnresolvedSteps(record.unresolvedSteps)
  const candidateMatches = parseCandidateMatches(record.candidateMatches, employees, intentAnalysis, unresolvedSteps)
  if (record.nodes.length === 0 && unresolvedSteps.length === 0) throw planningFieldFailure('output-validation', 'empty-plan', ['nodes'], '不能返回空计划；生成可执行节点，或将必要但未解决的工作保留在 unresolvedSteps。')
  const nodes = record.nodes.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw planningFieldFailure('output-validation', 'invalid-node', ['nodes', index], '每个执行节点必须是对象，字段按节点完整结构填写。')
    const item = normalizePlannerMediaContract(candidate as Record<string, unknown>)
    const subscriptionId = stringField(item.subscriptionId)
    const modelId = stringField(item.modelId)
    if (!subscriptionId || !modelId) throw planningFieldFailure('output-validation', 'missing-node-fields', ['nodes', index, !subscriptionId ? 'subscriptionId' : 'modelId'], '执行节点必须填写非空 subscriptionId 和 modelId，且逐字来自该员工目录。')
    const { knowledge: _modelKnowledge, ...plannerContract } = item
    const contract = arrangementNodeWorkContractSchema.safeParse(plannerContract)
    if (!contract.success) throw planningContractFailure(index, contract.error.issues)
    for (const [requirementIndex, requirement] of (contract.data.mediaRequirements ?? []).entries()) {
      if (requirement.required !== false && !requirement.inputFrom && (requirement.operation === 'edit' || requirement.operation === 'image-to-video')) {
        const bindings = (contract.data.inputRefs ?? []).filter(ref => ref.kind === 'attachment' && ref.purpose === 'media-source')
        const selectedImage = bindings.length === 1 && bindings.every(ref => ref.kind === 'attachment' &&
          draft.attachmentCandidates?.some(candidate => candidate.attachment.attachmentId === ref.attachment.attachmentId && candidate.attachment.sha256 === ref.attachment.sha256) &&
          draft.plannerAttachmentMaterials?.some(material => material.attachment.attachmentId === ref.attachment.attachmentId &&
            material.attachment.sha256 === ref.attachment.sha256 && material.mediaType.startsWith('image/')))
        if (!selectedImage) throw planningContractFailure(index, [{ path: ['mediaRequirements', requirementIndex, 'inputFrom'], code: 'custom' }],
          '请指定真实 inputFrom，或在 inputRefs 绑定唯一且已核验的图片附件并标记 purpose=media-source；多张附件须先明确选择，不得编造 artifactId。')
      }
    }
    for (const [fileIndex, file] of (contract.data.deliverables ?? []).entries()) {
      const kind = arrangementMediaKindForFormat(file.format)
      if (kind && contract.data.mediaRequirements?.some(requirement => requirement.kind === kind && requirement.generationMethod === 'ai-generated') &&
        file.artifact?.source !== 'media-output') {
        throw planningContractFailure(index, [{ path: ['deliverables', fileIndex, 'artifact', 'source'], code: 'custom' }], '用户要求 AI 生成的媒体必须关联真实媒体任务产物，不能以脚本生成的文件替代。')
      }
      if (!file.artifact && kind && contract.data.mediaRequirements?.some(requirement => requirement.kind === kind)) {
        throw planningContractFailure(index, [{ path: ['deliverables', fileIndex, 'artifact'], code: 'custom' }], '请明确该交付物的媒体来源与操作后重新规划。')
      }
      if (file.artifact?.source === 'media-output' && (!kind || kind !== file.artifact.kind)) {
        throw planningContractFailure(index, [{ path: ['deliverables', fileIndex, 'format'], code: 'custom' }], '媒体原文件的格式需与类型一致，当前支持 PNG、JPEG、WebP、MP4、WebM；其他格式请另行安排转换。')
      }
    }
    const existingKnowledge = draft.nodes.find(node => node.id === (stringField(item.id) ?? `node-${index + 1}`))?.knowledge
    return {
      id: stringField(item.id) ?? `node-${index + 1}`,
      subscriptionId,
      modelId,
      title: stringField(item.title) ?? '',
      instruction: stringField(item.instruction) ?? '',
      expectedOutput: stringField(item.expectedOutput) ?? '',
      ...(typeof item.knowledgeQuery === 'string' && item.knowledgeQuery.trim() ? { knowledgeQuery: item.knowledgeQuery.trim() } : {}),
      ...contract.data,
      ...(existingKnowledge ? { knowledge: structuredClone(existingKnowledge) } : {}),
      dependsOn: stringArray(item.dependsOn),
      skillIds: [],
      ...(stringField(item.stepId) ? { stepId: stringField(item.stepId)! } : {}),
    }
  })
  validateApprovedEmployeeAssignments(draft.approvedEmployeeAssignments ?? [], nodes, unresolvedSteps)
  const allowedAttachments = new Map((draft.attachmentCandidates ?? []).map(candidate => [candidate.attachment.attachmentId, candidate]))
  const usedAttachmentIds = new Set((draft.nodes ?? []).flatMap(node => (node.inputRefs ?? []).flatMap(ref => ref.kind === 'attachment' ? [ref.attachment.attachmentId] : [])))
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.inputRefs?.some(ref => ref.kind === 'deliverable')) throw planningFieldFailure('output-validation', 'invalid-planner-input-reference', ['nodes', nodeIndex, 'inputRefs'], '规划 inputRefs 仅允许 kind=attachment；上游媒体交付引用使用 inputFrom 和 dependsOn。')
    for (const [refIndex, ref] of (node.inputRefs ?? []).entries()) {
      if (ref.kind !== 'attachment') continue
      const allowed = allowedAttachments.get(ref.attachment.attachmentId)
      if (!allowed || allowed.attachment.sha256 !== ref.attachment.sha256) throw planningFieldFailure('output-validation', 'invalid-attachment-reference', ['nodes', nodeIndex, 'inputRefs', refIndex, 'attachment'], '附件编号及 sha256 必须逐字复制本轮 attachments 对应项的 attachment 对象，不能猜测或使用其他任务附件。')
      usedAttachmentIds.add(ref.attachment.attachmentId)
    }
  }
  if ((draft.attachmentCandidates ?? []).some(candidate => candidate.mustUse && !usedAttachmentIds.has(candidate.attachment.attachmentId))) {
    throw planningFieldFailure('output-validation', 'required-attachment-unassigned', ['nodes'], '本轮 attachments 中 mustUse=true 的每个附件必须绑定到至少一个执行节点，已有有效绑定可保留。')
  }
  for (const [index, node] of nodes.entries()) {
    if (!node.title || !node.instruction) throw planningFieldFailure('output-validation', 'missing-node-fields', ['nodes', index, !node.title ? 'title' : 'instruction'], '节点 title 和 instruction 必须是非空字符串，明确业务工作和执行要求。')
  }
  onPhase?.('employee-validation')
  for (const [index, node] of nodes.entries()) {
    const employee = employeeById.get(node.subscriptionId)
    if (!employee || employee.status !== 'ACTIVE' || employee.canExecute === false) throw planningFieldFailure('employee-validation', 'employee-unavailable', ['nodes', index, 'subscriptionId'], '执行节点必须选择本轮目录中可执行的有效员工订阅；待授权推荐阶段 nodes 返回空数组。')
  }
  onPhase?.('model-validation')
  for (const [index, node] of nodes.entries()) {
    if (!employeeById.get(node.subscriptionId)!.allowedModels.includes(node.modelId)) throw planningFieldFailure('model-validation', 'model-not-allowed', ['nodes', index, 'modelId'], 'modelId 必须逐字使用该节点员工 allowedModels 中的一个值，不得采用其他员工的模型权限。')
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

export function validateApprovedEmployeeAssignments(
  assignments: NonNullable<ArrangementPlannerDraft['approvedEmployeeAssignments']>,
  nodes: readonly ArrangementNode[],
  unresolvedSteps: readonly ArrangementUnresolvedStep[],
): void {
  for (const assignment of assignments) {
    const assignedNodes = nodes.filter(node => node.stepId === assignment.stepId)
    if (!assignedNodes.length || assignedNodes.some(node => node.subscriptionId !== assignment.subscriptionId) ||
      unresolvedSteps.some(step => step.stepId === assignment.stepId)) {
      throw planningFieldFailure('employee-validation', 'approved-employee-not-assigned', ['nodes'],
        `已批准员工必须填入原步骤 ${assignment.stepId}，使用订阅 ${assignment.subscriptionId}，不得改派或保留为未解决。`)
    }
  }
}


function parseIntentAnalysis(value: unknown): ArrangementIntentAnalysis | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw planningFieldFailure('output-validation', 'invalid-intent-analysis', ['intentAnalysis'], 'intentAnalysis 必须为含 summary 和非空 steps 的对象。')
  const record = value as Record<string, unknown>
  if (typeof record.summary !== 'string' || !Array.isArray(record.steps) || record.steps.length === 0) throw planningFieldFailure('output-validation', 'invalid-intent-analysis', ['intentAnalysis', typeof record.summary !== 'string' ? 'summary' : 'steps'], 'summary 必须为字符串，steps 必须为非空步骤对象数组。')
  const steps = record.steps.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw planningFieldFailure('output-validation', 'invalid-intent-step', ['intentAnalysis', 'steps', index], '意图步骤必须为对象，包含 id、title、能力字符串数组及 dependsOn 字符串数组。')
    const item = candidate as Record<string, unknown>
    const id = stringField(item.id)
    const title = stringField(item.title)
    if (!id || !title) throw planningFieldFailure('output-validation', 'invalid-intent-step', ['intentAnalysis', 'steps', index, !id ? 'id' : 'title'], '意图步骤 id、title 必须为非空字符串，能力与依赖字段为字符串数组。')
    const requiredCapabilityIds = stringArray(item.requiredCapabilityIds)
    return { id, title, requiredCapabilities: stringArray(item.requiredCapabilities), ...(requiredCapabilityIds.length ? { requiredCapabilityIds } : {}), dependsOn: stringArray(item.dependsOn) }
  })
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw planningFieldFailure('output-validation', 'duplicate-intent-step', ['intentAnalysis', 'steps'], '每个意图步骤 id 必须唯一，修正重复 ID 并同步关联引用。')
  return { summary: record.summary.trim(), steps }
}

function parseUnresolvedSteps(value: unknown): ArrangementUnresolvedStep[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw planningFieldFailure('output-validation', 'invalid-unresolved-steps', ['unresolvedSteps'], 'unresolvedSteps 必须是对象数组，没有未解决工作时返回 []。')
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw planningFieldFailure('output-validation', 'invalid-unresolved-step', ['unresolvedSteps', index], '未解决步骤必须是对象，包含 stepId、reason 和能力字符串数组。')
    const item = candidate as Record<string, unknown>
    const stepId = stringField(item.stepId)
    const reason = stringField(item.reason)
    if (!stepId || !reason) throw planningFieldFailure('output-validation', 'invalid-unresolved-step', ['unresolvedSteps', index, !stepId ? 'stepId' : 'reason'], 'stepId 和 reason 必须为非空字符串，指向实际步骤并说明未解决原因。')
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
