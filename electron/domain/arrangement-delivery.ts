import { z } from 'zod'
import { arrangementNodeWorkContractSchema, type ArrangementNode } from './arrangement-plan'

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
  size: z.number().int().positive().max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodeRunId: z.string().min(1).max(128),
  validatedAt: z.number().int().positive(),
}).strict()
export type FinalDeliveryFile = z.infer<typeof finalDeliveryFileSchema>

export const nodeDeliveryProgressSchema = z.object({
  validationAttempts: z.number().int().min(0).max(MAX_DELIVERY_VALIDATIONS),
  issues: z.array(deliveryIssueSchema).max(128),
  finalFiles: z.array(finalDeliveryFileSchema).max(32),
  summary: z.string().max(4_000).optional(),
}).strict()
export type NodeDeliveryProgress = z.infer<typeof nodeDeliveryProgressSchema>

const submissionSchema = z.object({
  nodeId: z.string().min(1).max(128),
  summary: z.string().trim().min(1).max(4_000),
  finalDeliverables: z.array(z.object({ id: z.string().min(1).max(128), path: z.string().min(1).max(1_024) }).strict()).min(1).max(32),
}).strict()
export type DeliverySubmission = z.infer<typeof submissionSchema>
export type DeliverySubmissionResult = { ok: true; submission: DeliverySubmission } | { ok: false; issues: DeliveryIssue[] }

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
  return issues.length ? { ok: false, issues } : { ok: true, submission: parsed.data }
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
