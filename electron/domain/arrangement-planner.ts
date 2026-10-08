import { planningFailure, type PlanningDiagnosticContext, type PlanningPhase } from '../errors/planning-diagnostics'
import { validateArrangementDraft, type ArrangementCandidateMatch, type ArrangementDraft, type ArrangementIntentAnalysis, type ArrangementNode, type ArrangementUnresolvedStep } from './arrangement-plan'

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
  listPlatform(input: { keywords: readonly string[]; capabilityIds?: readonly string[] }): Promise<ArrangementPlannerEmployee[]>
}

export interface ArrangementEmployeeCapabilityDirectory {
  list(employeeId: string): Promise<ArrangementPlannerCapability[]>
}

export interface ArrangementPlannerPort {
  plan(input: {
    planningId: string
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
  draft: Pick<ArrangementDraft, 'goal' | 'confirmedInputs' | 'sharedSkillIds' | 'intentAnalysis' | 'unresolvedSteps' | 'nodes'>,
  employees: readonly ArrangementPlannerEmployee[],
): string {
  const catalog = employees.map(employee => ({
    subscriptionId: employee.subscriptionId,
    employeeId: employee.employeeId,
    name: employee.name,
    description: employee.description ?? '',
    position: employee.position ?? '',
    functionalCategory: employee.functionalCategory ?? '',
    capabilities: employee.capabilities ? employee.capabilities.map(capability => ({ ...capability })) : [],
    canApply: employee.canApply ?? false,
    allowedModels: [...employee.allowedModels],
    source: employee.source ?? 'authorized',
    canExecute: employee.canExecute ?? true,
  }))
  return [
    '你是 SEP 自动编排 Agent。请根据用户目标生成一个可执行的编排草稿。',
    '只返回严格 JSON，不要返回 Markdown、解释、思维链或 reasoning 字段。',
    draft.intentAnalysis
      ? '已有意图快照，禁止重新识别整个任务；只针对 unresolvedSteps 中的步骤，在当前 employeeCatalog 中继续匹配。'
      : '先识别用户意图，再拆解步骤并提取每一步所需能力；然后只在当前 employeeCatalog 中匹配员工。',
    '当前阶段只选择员工并规划流程，不执行用户任务，不调用任何工具。所需员工信息已经包含在 employeeCatalog 中。',
    '如果当前候选员工无法覆盖某一步，必须把该步骤放入 unresolvedSteps，不得伪造员工、订阅或模型。候选员工 canExecute=false 时只能作为建议，不能生成执行节点。建议员工只能通过 candidateMatches 返回。',
    '只能从 employeeCatalog 中选择员工，只能使用对应员工 allowedModels 中的模型。结果必须是合法 DAG。',
    `用户目标：${draft.goal}`,
    `已确认输入材料：${JSON.stringify(draft.confirmedInputs)}`,
    `用户选择的共享技能：${JSON.stringify(draft.sharedSkillIds)}`,
    `已有意图快照：${JSON.stringify(draft.intentAnalysis ?? null)}`,
    `待解决步骤：${JSON.stringify(draft.unresolvedSteps ?? [])}`,
    `已有执行节点（只需补充新节点）：${JSON.stringify(draft.nodes.map(node => ({ id: node.id, stepId: node.stepId, title: node.title, dependsOn: node.dependsOn })))}`,
    `employeeCatalog：${JSON.stringify(catalog)}`,
    'JSON 格式：{"title":"...","intentAnalysis":{"summary":"...","steps":[{"id":"step-1","title":"...","requiredCapabilities":["能力名称"],"requiredCapabilityIds":["capability-id"],"dependsOn":[]}]},"unresolvedSteps":[{"stepId":"step-1","reason":"...","requiredCapabilities":["能力名称"],"requiredCapabilityIds":["capability-id"]}],"candidateMatches":[{"stepId":"step-1","employeeId":"...","rationale":"..."}],"nodes":[{"id":"node-1","stepId":"step-1","subscriptionId":"...","modelId":"...","title":"...","instruction":"...","expectedOutput":"...","dependsOn":[],"skillIds":[],"requiresUserConfirmation":false}]}',
  ].join('\n')
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
    const item = candidate as Record<string, unknown>
    const subscriptionId = stringField(item.subscriptionId)
    const modelId = stringField(item.modelId)
    if (!subscriptionId || !modelId) throw planningFailure('output-validation', 'missing-node-fields')
    const skillIds = stringArray(item.skillIds)
    if (skillIds.some(skillId => !draft.sharedSkillIds.includes(skillId))) throw planningFailure('output-validation', 'skill-not-allowed')
    return {
      id: stringField(item.id) ?? `node-${index + 1}`,
      subscriptionId,
      modelId,
      title: stringField(item.title) ?? '',
      instruction: stringField(item.instruction) ?? '',
      expectedOutput: stringField(item.expectedOutput) ?? '',
      dependsOn: stringArray(item.dependsOn),
      skillIds,
      requiresUserConfirmation: item.requiresUserConfirmation === true,
      ...(stringField(item.stepId) ? { stepId: stringField(item.stepId)! } : {}),
    }
  })
  if (nodes.some(node => !node.title || !node.instruction)) throw planningFailure('output-validation', 'missing-node-fields')
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
