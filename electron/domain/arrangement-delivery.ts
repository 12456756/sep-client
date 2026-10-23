import { z } from 'zod'
import { arrangementMediaArtifactIdSchema, arrangementNodeWorkContractSchema, type ArrangementNode } from './arrangement-plan'

export const MAX_DELIVERY_VALIDATIONS = 5
export const deliveryIssueSchema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(2_000),
  deliverableId: z.string().max(128).optional(),
  path: z.string().max(1_024).optional(),
}).strict()
export type DeliveryIssue = z.infer<typeof deliveryIssueSchema>

export const finalDeliveryFileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  path: z.string().min(1).max(1_024),
  format: z.string().min(1).max(32),
  size: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceArtifact: z.object({
    kind: z.enum(['image', 'video']),
    artifactId: arrangementMediaArtifactIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  nodeRunId: z.string().min(1).max(128),
  validatedAt: z.number().int().positive(),
  snapshot: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().safe(),
    source: z.enum(['confirmed', 'workspace-recovery']),
  }).strict().optional(),
}).strict().superRefine((file, context) => {
  if (file.sourceArtifact?.kind !== 'video' && (file.size > 64 * 1024 * 1024 || (file.snapshot?.size ?? 0) > 64 * 1024 * 1024)) {
    context.addIssue({ code: 'custom', path: ['size'], message: 'Document delivery exceeds the supported size.' })
  }
  if (file.sourceArtifact && (file.sourceArtifact.sha256 !== file.sha256 ||
    (file.snapshot && (file.snapshot.sha256 !== file.sha256 || file.snapshot.size !== file.size)))) {
    context.addIssue({ code: 'custom', path: ['sourceArtifact'], message: 'Media delivery bytes must match the source artifact and its snapshot.' })
  }
})
export type FinalDeliveryFile = z.infer<typeof finalDeliveryFileSchema>

const submissionSchema = z.object({
  nodeId: z.string().min(1).max(128),
  summary: z.string().trim().min(1).max(4_000),
  finalDeliverables: z.array(z.object({ id: z.string().min(1).max(128), path: z.string().min(1).max(1_024) }).strict()).min(1).max(32),
  mediaDeliverables: z.array(z.object({
    deliverableId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    artifactId: arrangementMediaArtifactIdSchema,
  }).strict()).max(32).optional(),
}).strict()
export type DeliverySubmission = z.infer<typeof submissionSchema>
export type DeliverySubmissionResult = { ok: true; submission: DeliverySubmission } | { ok: false; issues: DeliveryIssue[] }

export const nodeDeliveryProgressSchema = z.object({
  validationAttempts: z.number().int().min(0).max(MAX_DELIVERY_VALIDATIONS),
  issues: z.array(deliveryIssueSchema).max(128),
  finalFiles: z.array(finalDeliveryFileSchema).max(32),
  summary: z.string().max(4_000).optional(),
  pendingSubmission: submissionSchema.optional(),
}).strict()
export type NodeDeliveryProgress = z.infer<typeof nodeDeliveryProgressSchema>

export function deliveryPathKey(path: string): string { return path.replace(/\\/g, '/').normalize('NFC').toLowerCase() }

export function deliveryPlanIssues(nodes: readonly ArrangementNode[]): DeliveryIssue[] {
  const paths = new Set<string>()
  const issues: DeliveryIssue[] = []
  for (const node of nodes) {
    if (!node.objective?.trim() || !node.deliverables?.length || !arrangementNodeWorkContractSchema.safeParse(node).success) {
      issues.push({ code: 'MISSING_DELIVERY_CONTRACT', message: `节点 ${node.id} 缺少完整目标或文件交付要求，请补齐规划后启动。` })
      continue
    }
    const ids = new Set<string>()
    for (const file of node.deliverables) {
      const key = deliveryPathKey(file.path)
      if (ids.has(file.id) || paths.has(key)) issues.push({ code: 'DUPLICATE_DELIVERY', deliverableId: file.id, path: file.path, message: '交付物 ID 或最终文件路径重复；不同节点不得覆盖同一最终文件。' })
      ids.add(file.id)
      paths.add(key)
    }
  }
  return issues
}

export function parseDeliverySubmission(node: ArrangementNode, text: string, stopReason?: string): DeliverySubmissionResult {
  const issue = (code: string, message: string): DeliverySubmissionResult => ({ ok: false, issues: [{ code, message }] })
  if (!node.deliverables?.length) return issue('MISSING_DELIVERY_CONTRACT', '节点缺少规定的交付物清单，不能确认最终成果。')
  if (stopReason === 'length') return issue('OUTPUT_TRUNCATED', '本轮回复达到输出上限，请缩短结束 JSON，不要省略交付文件。')
  if (stopReason && stopReason !== 'stop') return issue('NODE_NOT_SETTLED', '本轮没有正常结束，不能确认节点完成。')
  let value: unknown
  try {
    if (text.length > 128_000) return issue('INVALID_SUBMISSION', '结束 JSON 过长，请只提交简要说明及最终文件清单。')
    value = JSON.parse(text)
  } catch { return issue('INVALID_SUBMISSION', '节点结束时必须提交严格 JSON；不要使用 Markdown、普通文字或代码围栏。') }
  const parsed = submissionSchema.safeParse(value)
  if (!parsed.success) return issue('INVALID_SUBMISSION', '结束 JSON 必须包含 nodeId、非空 summary 和完整 finalDeliverables（每项只有 id、path）。')
  if (parsed.data.nodeId !== node.id) return issue('WRONG_NODE', `提交的 nodeId 必须是 ${node.id}。`)
  const byId = new Map(node.deliverables.map(file => [file.id, file]))
  const submitted = new Set<string>()
  const issues: DeliveryIssue[] = []
  for (const file of parsed.data.finalDeliverables) {
    const expected = byId.get(file.id)
    if (!expected || submitted.has(file.id) || file.path !== expected.path) {
      issues.push({ code: 'DELIVERY_MANIFEST_MISMATCH', message: '只提交规定的交付物 ID 与原定相对路径，不得重复、改路径或夹带过程文件。' })
    }
    submitted.add(file.id)
  }
  for (const file of node.deliverables) {
    if (!submitted.has(file.id)) issues.push({ code: 'MISSING_DELIVERY', deliverableId: file.id, path: file.path, message: '最终提交清单遗漏此必需文件。' })
  }
  const mediaDeliverables = parsed.data.mediaDeliverables ?? []
  const mediaByDeliverableId = new Map(mediaDeliverables.map(item => [item.deliverableId, item]))
  if (mediaByDeliverableId.size !== mediaDeliverables.length) {
    issues.push({ code: 'DUPLICATE_MEDIA_DELIVERY', message: '媒体交付物不能重复映射。' })
  }
  const expectedMediaDeliverables = node.deliverables.filter(file =>
    (file.artifact?.kind === 'image' || file.artifact?.kind === 'video') && file.artifact.source === 'media-output',
  )
  for (const mapping of mediaDeliverables) {
    const expected = node.deliverables.find(file => file.id === mapping.deliverableId)
    if (!expected || (expected.artifact?.kind !== 'image' && expected.artifact?.kind !== 'video') || expected.artifact.source === 'workspace') {
      issues.push({ code: 'MEDIA_DELIVERY_MANIFEST_MISMATCH', deliverableId: mapping.deliverableId, message: '媒体资产只能映射到计划中的图片或视频交付物。' })
    }
  }
  for (const deliverable of expectedMediaDeliverables) {
    if (!mediaByDeliverableId.has(deliverable.id)) issues.push({
      code: 'MISSING_MEDIA_DELIVERY', deliverableId: deliverable.id, path: deliverable.path,
      message: '计划要求从媒体库交付该图片或视频，但提交内容缺少对应资产 ID。',
    })
  }
  return issues.length ? { ok: false, issues } : { ok: true, submission: parsed.data }
}

export function parseRecordedDeliverySubmission(node: ArrangementNode, files: readonly FinalDeliveryFile[], summary = 'verified'): DeliverySubmissionResult {
  for (const file of files) {
    const expected = node.deliverables?.find(deliverable => deliverable.id === file.id)
    if (!finalDeliveryFileSchema.safeParse(file).success || (file.sourceArtifact && file.sourceArtifact.kind !== expected?.artifact?.kind)) {
      return { ok: false, issues: [{ code: 'INVALID_DELIVERY_RECORD', deliverableId: file.id, message: '已验收交付记录的媒体来源或哈希与计划不一致。' }] }
    }
  }
  const mediaDeliverables = files.flatMap(file => file.sourceArtifact ? [{ deliverableId: file.id, artifactId: file.sourceArtifact.artifactId }] : [])
  const finalDeliverables = files.map(file => ({ id: file.id, path: file.sourceArtifact ? node.deliverables!.find(item => item.id === file.id)?.path ?? file.path : file.path }))
  return parseDeliverySubmission(node, JSON.stringify({
    nodeId: node.id, summary,
    finalDeliverables,
    ...(mediaDeliverables.length ? { mediaDeliverables } : {}),
  }))
}

export class DeliveryExecutionError extends Error {
  constructor(message: string) { super(message); this.name = 'DeliveryExecutionError' }
}

export function buildDeliveryCorrection(attempt: number, issues: readonly DeliveryIssue[]): string {
  const progress = attempt === 0
    ? `上次执行的交付校验失败，本次手动重试最多允许 ${MAX_DELIVERY_VALIDATIONS} 次校验。`
    : `第 ${attempt} 次交付校验失败，最多允许 ${MAX_DELIVERY_VALIDATIONS} 次。`
  return `${progress}节点尚未完成。\n失败项目：\n${JSON.stringify(issues, null, 2)}\n请修复实际文件或提交内容，保留其他有效成果，不重复已完成的操作。重新确认节点全部工作结束后，按固定提示词提交完整最终 JSON。不得只回复“已修复”。`
}
