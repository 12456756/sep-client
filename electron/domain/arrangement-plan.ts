import { AppError } from '../errors/app-error'

export type ArrangementMode = 'conversation' | 'auto' | 'manual'
export type DraftStatus = 'editing' | 'planning' | 'planning-failed' | 'ready' | 'preflight-failed' | 'confirmed'
export type PermissionPreset = 'read-only' | 'workspace-edit' | 'full-local'
export type CommandPolicy = 'disabled' | 'restricted' | 'confirm-each'
/** 工具调用的用户确认策略。默认逐次确认；自动放行只取消交互确认，不绕过安全检查。 */
export type ApprovalMode = 'confirm-each' | 'auto-approve'

export interface ConversationParticipant {
  subscriptionId: string
  modelId: string
}

export interface ConversationArrangement {
  participants: ConversationParticipant[]
  activeSubscriptionId: string | null
}

export interface ArrangementNode {
  id: string
  subscriptionId: string
  modelId: string
  title: string
  instruction: string
  expectedOutput: string
  dependsOn: string[]
  skillIds: string[]
  requiresUserConfirmation: boolean
}

export interface SharedWorkspace {
  mode: 'shared'
  path: string | null
}

export interface RequestedTaskPermissionPolicy {
  preset: PermissionPreset
  allowedPaths?: string[]
  deniedPaths?: string[]
  commandPolicy?: CommandPolicy
  /** 用户明确选择“无需确认”时为 true。保留布尔字段便于草稿协议直观表达。 */
  allowWithoutApproval?: boolean
  /** 与 allowWithoutApproval 等价的规范化表示。 */
  approvalMode?: ApprovalMode
}

export interface EffectiveTaskPermissionPolicy {
  preset: PermissionPreset
  allowedTools: string[]
  allowedPaths: string[]
  deniedPaths: string[]
  requireApprovalFor: string[]
  commandPolicy: CommandPolicy
  approvalMode?: ApprovalMode
}

export interface ArrangementDraft {
  id: string
  schemaVersion: 1
  revision: number
  owner: { memberId: string; enterpriseId: string }
  mode: ArrangementMode
  status: DraftStatus
  title: string
  goal: string
  confirmedInputs: string[]
  sharedSkillIds: string[]
  conversation: ConversationArrangement | null
  nodes: ArrangementNode[]
  workspace: SharedWorkspace
  permissions: RequestedTaskPermissionPolicy
  createdAt: number
  updatedAt: number
  lastPlanning: { planningId: string; status: 'planning' | 'ready' | 'failed' | 'cancelled'; message: string | null } | null
  confirmedWorkPlanId?: string | null
}

export interface WorkPlan {
  id: string
  schemaVersion: 1
  sourceDraftId: string
  sourceDraftRevision: number
  owner: { memberId: string; enterpriseId: string }
  mode: ArrangementMode
  title: string
  goal: string
  conversation: ConversationArrangement | null
  nodes: ArrangementNode[]
  workspace: SharedWorkspace
  permissions: EffectiveTaskPermissionPolicy
  confirmedInputs: string[]
  planHash: string
  createdAt: number
}

export interface SubscriptionPreflightInput {
  subscriptionId: string
  employeeId?: string
  status: 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'TERMINATED'
  endDate: number | null
  allowedModels: readonly string[]
}

export interface SubscriptionPreflightResult {
  subscriptionId: string
  employeeId: string | null
  status: SubscriptionPreflightInput['status']
  subscriptionEndAt: number | null
  remainingTimeMs: number | null
  thresholdTimeMs: number
  available: boolean
  passesThreshold: boolean
  modelIds: string[]
  reasonCode: 'inactive' | 'expired' | 'expiring' | null
}

export const PERMISSION_TOOLS: Record<PermissionPreset, readonly string[]> = {
  'read-only': ['read', 'grep', 'find', 'ls'],
  'workspace-edit': ['read', 'grep', 'find', 'ls', 'write', 'edit'],
  'full-local': ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
}

export function effectivePermissionPolicy(
  requested: RequestedTaskPermissionPolicy,
  ceiling: PermissionPreset = 'full-local',
): EffectiveTaskPermissionPolicy {
  const order: PermissionPreset[] = ['read-only', 'workspace-edit', 'full-local']
  const requestedIndex = order.indexOf(requested.preset)
  const ceilingIndex = order.indexOf(ceiling)
  const preset = order[Math.min(requestedIndex < 0 ? 0 : requestedIndex, ceilingIndex < 0 ? 0 : ceilingIndex)] as PermissionPreset
  const allowedPaths = requested.allowedPaths?.filter(path => path.trim().length > 0).map(path => path.trim()) ?? []
  const deniedPaths = requested.deniedPaths?.filter(path => path.trim().length > 0).map(path => path.trim()) ?? []
  return {
    preset,
    allowedTools: [...PERMISSION_TOOLS[preset]],
    allowedPaths,
    deniedPaths,
    requireApprovalFor: ['write', 'edit', 'bash'],
    commandPolicy: requested.commandPolicy ?? (preset === 'full-local' ? 'confirm-each' : 'disabled'),
    approvalMode: requested.approvalMode ?? (requested.allowWithoutApproval === true ? 'auto-approve' : 'confirm-each'),
  }
}

export function validateArrangementDraft(draft: ArrangementDraft): void {
  if (!draft.id || !draft.owner.memberId || !draft.owner.enterpriseId) throw new AppError('INVALID_ARGUMENT')
  if (!draft.title.trim() && !draft.goal.trim()) throw new AppError('INVALID_ARGUMENT')
  if (draft.mode === 'conversation') {
    if (!draft.conversation?.participants.length) throw new AppError('INVALID_ARGUMENT')
    for (const participant of draft.conversation.participants) {
      if (!participant.subscriptionId || !participant.modelId) throw new AppError('INVALID_ARGUMENT')
    }
    return
  }
  if (draft.nodes.length === 0 && draft.mode === 'auto' && (draft.status === 'editing' || draft.status === 'planning' || draft.status === 'planning-failed')) return
  if (draft.nodes.length === 0) throw new AppError('INVALID_ARGUMENT')
  validateArrangementNodes(draft.nodes)
}

export function validateArrangementNodes(nodes: readonly ArrangementNode[]): void {
  const ids = new Set<string>()
  const byId = new Map<string, ArrangementNode>()
  for (const node of nodes) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(node.id) || ids.has(node.id)) throw new AppError('INVALID_ARGUMENT')
    if (!node.subscriptionId || !node.modelId || !node.title.trim() || !node.instruction.trim()) {
      throw new AppError('INVALID_ARGUMENT')
    }
    ids.add(node.id)
    byId.set(node.id, node)
  }
  for (const node of nodes) {
    const dependencies = new Set<string>()
    for (const dependency of node.dependsOn) {
      if (dependency === node.id || !byId.has(dependency) || dependencies.has(dependency)) throw new AppError('INVALID_ARGUMENT')
      dependencies.add(dependency)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new AppError('INVALID_ARGUMENT')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
}

export function preflightSubscription(
  input: SubscriptionPreflightInput,
  now: number,
  thresholdTimeMs: number,
): SubscriptionPreflightResult {
  const remainingTimeMs = input.endDate === null ? null : input.endDate - now
  const available = input.status === 'ACTIVE'
  const passesThreshold = available && (remainingTimeMs === null || remainingTimeMs >= thresholdTimeMs)
  const reasonCode = !available
    ? input.status === 'EXPIRED' || (input.endDate !== null && input.endDate <= now) ? 'expired' : 'inactive'
    : !passesThreshold ? 'expiring' : null
  return {
    subscriptionId: input.subscriptionId,
    employeeId: input.employeeId ?? null,
    status: input.status,
    subscriptionEndAt: input.endDate,
    remainingTimeMs,
    thresholdTimeMs,
    available,
    passesThreshold,
    modelIds: [...input.allowedModels],
    reasonCode,
  }
}

export function validateNodeModels(nodes: readonly ArrangementNode[], subscriptions: readonly SubscriptionPreflightInput[]): string[] {
  const byId = new Map(subscriptions.map(subscription => [subscription.subscriptionId, subscription]))
  const issues: string[] = []
  for (const node of nodes) {
    const subscription = byId.get(node.subscriptionId)
    if (!subscription) {
      issues.push(`${node.id}:subscription-unavailable`)
    } else if (!subscription.allowedModels.includes(node.modelId)) {
      issues.push(`${node.id}:model-not-allowed`)
    }
  }
  return issues
}


