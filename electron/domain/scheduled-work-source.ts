import { createHash } from 'node:crypto'
import { z } from 'zod'
import { attachmentRefSchema } from '../../src/shared/attachment-contracts'
import { knowledgeSelectionSchema } from '../../src/shared/knowledge-selection'
import { validateArrangementNodes, type WorkPlan } from './arrangement-plan'
import type { TaskOwnerScope } from '../data/scope-path'
import { AppError } from '../errors/app-error'
import { deliveryPlanIssues } from './arrangement-delivery'

const textList = z.array(z.string())
const sourcePlanSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), schemaVersion: z.union([z.literal(1), z.literal(2)]),
  sourceDraftId: z.string().min(1), sourceDraftRevision: z.number().int().positive(),
  owner: z.object({ memberId: z.string().min(1), enterpriseId: z.string().min(1) }),
  mode: z.enum(['auto', 'manual']), title: z.string().trim().min(1).max(160), goal: z.string().trim().min(1).max(16000),
  conversation: z.null(), nodes: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), subscriptionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    modelId: z.string().min(1).max(160), title: z.string().trim().min(1).max(160), instruction: z.string().trim().min(1).max(16000),
    expectedOutput: z.string().trim().min(1).max(4000), dependsOn: z.array(z.string()), skillIds: textList,
  }).passthrough()).min(1).max(32),
  workspace: z.object({ mode: z.literal('shared'), path: z.string().min(1) }),
  permissions: z.object({ preset: z.enum(['workspace-edit', 'full-local']), allowedTools: textList, allowedPaths: textList,
    deniedPaths: textList, requireApprovalFor: textList, commandPolicy: z.enum(['disabled', 'restricted', 'confirm-each']),
    approvalMode: z.enum(['confirm-each', 'auto-approve']).optional() }).strict(),
  confirmedInputs: textList, knowledge: knowledgeSelectionSchema.optional(),
  inputSnapshot: z.object({ snapshotId: z.string().min(1), attachments: z.array(attachmentRefSchema), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  planHash: z.string().min(1), createdAt: z.number().nonnegative(),
})

export function validateScheduledSource(plan: WorkPlan, scope: TaskOwnerScope): void {
  if (!sourcePlanSchema.safeParse(plan).success) throw new AppError('INVALID_ARGUMENT', { message: '此工作没有可复用的完整编排计划，或使用了不支持的只读权限。' })
  if (plan.owner.memberId !== scope.memberId || plan.owner.enterpriseId !== scope.enterpriseId) throw new AppError('PERMISSION_DENIED')
  validateArrangementNodes(plan.nodes)
  if (plan.mode === 'auto' && deliveryPlanIssues(plan.nodes).length) throw new AppError('INVALID_ARGUMENT', { message: '原编排计划缺少有效的目标或交付约定，不能直接启用定时执行。' })
  const byId = new Map(plan.nodes.map(node => [node.id, node]))
  for (const node of plan.nodes) {
    if (!Array.isArray(node.dependsOn) || !Array.isArray(node.skillIds) || !node.deliverables?.length) throw new AppError('INVALID_ARGUMENT', { message: '工作步骤缺少依赖配置或文件交付要求，不能直接设为定时任务。' })
    if (node.mediaRequirements?.some(item => item.inputFrom?.artifactId)) throw new AppError('INVALID_ARGUMENT', { message: '此工作引用了旧执行的媒体产物，暂不支持直接设为定时任务。请先将所需资料作为已确认附件。' })
    for (const ref of node.inputRefs ?? []) {
      const valid = ref.kind === 'attachment'
        ? plan.inputSnapshot?.attachments.some(item => item.attachmentId === ref.attachment.attachmentId && item.sha256 === ref.attachment.sha256)
        : node.dependsOn.includes(ref.nodeId) && byId.get(ref.nodeId)?.deliverables?.some(item => item.id === ref.deliverableId)
      if (!valid) throw new AppError('INVALID_ARGUMENT', { message: '工作输入引用不完整，不能安全复制。' })
    }
  }
}

export function sourceFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
