import { AppError } from '../errors/app-error'
import { validateArrangementDraft, type ArrangementDraft, type ArrangementNode } from './arrangement-plan'

export interface ArrangementPlannerEmployee {
  subscriptionId: string
  employeeId: string
  name: string
  description?: string
  position?: string
  functionalCategory?: string
  allowedModels: readonly string[]
  status: string
}

export interface ArrangementPlanningProgress {
  planningId: string
  draftId: string
  draftRevision: number
  type: 'arrangement_planning_started' | 'arrangement_employee_considering' | 'arrangement_employee_selected' | 'arrangement_planning_completed' | 'arrangement_planning_failed' | 'arrangement_planning_cancelled'
  occurredAt: number
  data: {
    subscriptionId?: string
    employeeId?: string
    stage?: string
    rationale?: string
    nodeId?: string
    title?: string
    message?: string
  }
}

export interface ArrangementPlanningResult {
  title: string
  nodes: ArrangementNode[]
}

export interface ArrangementPlannerPort {
  plan(input: {
    planningId: string
    draft: ArrangementDraft
    employees: readonly ArrangementPlannerEmployee[]
    signal?: AbortSignal
    onProgress: (event: ArrangementPlanningProgress) => void
  }): Promise<ArrangementPlanningResult>
  cancel?(planningId: string): void
}

export function buildArrangementPlannerPrompt(
  draft: Pick<ArrangementDraft, 'goal' | 'confirmedInputs' | 'sharedSkillIds'>,
  employees: readonly ArrangementPlannerEmployee[],
): string {
  const catalog = employees.map(employee => ({
    subscriptionId: employee.subscriptionId,
    employeeId: employee.employeeId,
    name: employee.name,
    description: employee.description ?? '',
    position: employee.position ?? '',
    functionalCategory: employee.functionalCategory ?? '',
    allowedModels: [...employee.allowedModels],
  }))
  return [
    '你是 SEP 自动编排 Agent。请根据用户目标生成一个可执行的编排草稿。',
    '只返回严格 JSON，不要返回 Markdown、解释、思维链或 reasoning 字段。',
    '当前阶段只选择员工并规划流程，不执行用户任务，不调用任何工具。所需员工信息已经包含在 employeeCatalog 中。',
    '只能从 employeeCatalog 中选择员工，只能使用对应员工 allowedModels 中的模型。结果必须是合法 DAG。',
    `用户目标：${draft.goal}`,
    `已确认输入材料：${JSON.stringify(draft.confirmedInputs)}`,
    `用户选择的共享技能：${JSON.stringify(draft.sharedSkillIds)}`,
    `employeeCatalog：${JSON.stringify(catalog)}`,
    'JSON 格式：{"title":"...","nodes":[{"id":"node-1","subscriptionId":"...","modelId":"...","title":"...","instruction":"...","expectedOutput":"...","dependsOn":[],"skillIds":[],"requiresUserConfirmation":false}]}',
  ].join('\n')
}

export function parseArrangementPlannerOutput(
  raw: string,
  draft: ArrangementDraft,
  employees: readonly ArrangementPlannerEmployee[],
): ArrangementPlanningResult {
  const value = JSON.parse(extractJson(raw)) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('PLANNING_FAILED')
  const record = value as Record<string, unknown>
  if (typeof record.title !== 'string' || !Array.isArray(record.nodes) || record.nodes.length === 0 || record.nodes.length > 32) {
    throw new AppError('PLANNING_FAILED')
  }
  const employeeById = new Map(employees.map(employee => [employee.subscriptionId, employee]))
  const nodes = record.nodes.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new AppError('PLANNING_FAILED')
    const item = candidate as Record<string, unknown>
    const subscriptionId = stringField(item.subscriptionId)
    const modelId = stringField(item.modelId)
    if (!subscriptionId || !modelId) throw new AppError('PLANNING_FAILED')
    const employee = employeeById.get(subscriptionId)
    if (!employee || employee.status !== 'ACTIVE' || !employee.allowedModels.includes(modelId)) throw new AppError('PLANNING_FAILED')
    const skillIds = stringArray(item.skillIds)
    if (skillIds.some(skillId => !draft.sharedSkillIds.includes(skillId))) throw new AppError('PLANNING_FAILED')
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
    }
  })
  const planned: ArrangementDraft = {
    ...structuredClone(draft),
    title: record.title.trim(),
    status: 'ready',
    nodes,
    revision: draft.revision,
    updatedAt: Date.now(),
  }
  try { validateArrangementDraft(planned) } catch { throw new AppError('PLANNING_FAILED') }
  return { title: planned.title, nodes: structuredClone(nodes) }
}

function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw)?.[1]
  const candidate = (fenced ?? raw).trim()
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AppError('PLANNING_FAILED')
  return candidate.slice(start, end + 1)
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value.map(item => item.trim()).filter(Boolean) : []
}
