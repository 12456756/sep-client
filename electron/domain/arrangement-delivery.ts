import { z } from 'zod'
import { arrangementMediaArtifactIdSchema, arrangementMediaMimeByFormat, arrangementNodeWorkContractSchema, type ArrangementNode } from './arrangement-plan'

export const deliveryIssueSchema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(2_000),
  deliverableId: z.string().max(128).optional(),
  path: z.string().max(1_024).optional(),
  submissionStage: z.enum(['json', 'fields', 'node', 'manifest']).optional(),
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
  validationAttempts: z.number().int().min(0),
  issues: z.array(deliveryIssueSchema).max(128),
  finalFiles: z.array(finalDeliveryFileSchema).max(32),
  summary: z.string().max(4_000).optional(),
  pendingSubmission: submissionSchema.optional(),
  mediaPhase: z.enum(['waiting-media', 'materializing', 'delivered']).optional(),
  mediaWaitStartedAt: z.number().int().nonnegative().optional(),
  materializeMs: z.number().int().nonnegative().optional(),
  deliveryMs: z.number().int().nonnegative().optional(),
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
      if (file.artifact?.source === 'workspace' && (file.artifact.kind === 'image' || file.artifact.kind === 'video')) {
        issues.push({ code: 'WORKSPACE_MEDIA_UNSUPPORTED', deliverableId: file.id, path: file.path, message: '当前媒体编排尚不支持从工作区原生文件交付图片或视频，请改用媒体输出来源后再生成。' })
      }
      if (file.artifact?.source !== 'workspace' && file.artifact?.kind === 'image' &&
        !arrangementMediaMimeByFormat[file.format.toLowerCase()]?.includes('image/png')) {
        issues.push({ code: 'MEDIA_FORMAT_UNSUPPORTED', deliverableId: file.id, path: file.path, message: '当前媒体输出图片只能在生成前确认 PNG 交付；JPG、JPEG 或 WebP 不能在生成后静默转换，请调整格式或来源。' })
      }
      ids.add(file.id)
      paths.add(key)
    }
  }
  return issues
}

export function parseDeliverySubmission(node: ArrangementNode, text: string, stopReason?: string): DeliverySubmissionResult {
  const issue = (code: string, message: string, submissionStage?: DeliveryIssue['submissionStage']): DeliverySubmissionResult =>
    ({ ok: false, issues: [{ code, message, ...(submissionStage ? { submissionStage } : {}) }] })
  if (!node.deliverables?.length) return issue('MISSING_DELIVERY_CONTRACT', '节点缺少规定的交付物清单，不能确认最终成果。')
  if (stopReason === 'length') return issue('OUTPUT_TRUNCATED', '本轮回复达到输出上限，请缩短结束 JSON，不要省略交付文件。')
  if (stopReason && stopReason !== 'stop') return issue('NODE_NOT_SETTLED', '本轮没有正常结束，不能确认节点完成。')
  let value: unknown
  try {
    if (text.length > 128_000) return issue('INVALID_SUBMISSION', '结束 JSON 过长，请只提交简要说明及最终文件清单。')
    value = JSON.parse(text)
  } catch { return issue('INVALID_SUBMISSION', '节点结束时必须提交严格 JSON；不要使用 Markdown、普通文字或代码围栏。', 'json') }
  const parsed = submissionSchema.safeParse(value)
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 128).map(error => ({
    code: 'INVALID_SUBMISSION', submissionStage: 'fields', message: describeSubmissionField(error, value),
  })) }
  if (parsed.data.nodeId !== node.id) return issue('WRONG_NODE',
    `你提交的 nodeId：${JSON.stringify(parsed.data.nodeId)}\n当前节点要求的 nodeId：${JSON.stringify(node.id)}`, 'node')
  const byId = new Map(node.deliverables.map(file => [file.id, file]))
  const submitted = new Set<string>()
  const issues: DeliveryIssue[] = []
  for (const file of parsed.data.finalDeliverables) {
    const expected = byId.get(file.id)
    if (!expected) {
      issues.push({ code: 'DELIVERY_MANIFEST_MISMATCH', submissionStage: 'manifest', deliverableId: file.id, path: file.path,
        message: `计划外交付物：${JSON.stringify(file.id)}，提交路径：${displaySubmissionValue(file.path)}。请从最终清单删除该项。` })
    } else {
      if (submitted.has(file.id)) issues.push({ code: 'DELIVERY_MANIFEST_MISMATCH', submissionStage: 'manifest', deliverableId: file.id, path: file.path,
        message: `重复交付物：${JSON.stringify(file.id)}。finalDeliverables 中每个规定 ID 只能出现一次。` })
      if (file.path !== expected.path) issues.push({ code: 'DELIVERY_MANIFEST_MISMATCH', submissionStage: 'manifest', deliverableId: file.id, path: expected.path,
        message: `交付物 ${JSON.stringify(file.id)} 路径不符。提交路径：${displaySubmissionValue(file.path)}；规定路径：${displaySubmissionValue(expected.path)}。请修正回复中的 path，不要仅因该字段错误重新生成文件。` })
    }
    submitted.add(file.id)
  }
  for (const file of node.deliverables) {
    if (!submitted.has(file.id)) issues.push({ code: 'MISSING_DELIVERY', submissionStage: 'manifest', deliverableId: file.id, path: file.path,
      message: `缺少必需交付物：${JSON.stringify(file.id)}，规定路径：${displaySubmissionValue(file.path)}。请补入完整最终清单；这不代表该文件不存在。` })
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
  return issues.length ? { ok: false, issues: issues.slice(0, 128) } : { ok: true, submission: parsed.data }
}

function displaySubmissionValue(value: string): string {
  const text = JSON.stringify(value)
  return text.length > 512 ? text.slice(0, 509) + '...' : text
}

function describeSubmissionField(issue: z.ZodIssue, value: unknown): string {
  let received: unknown = value
  for (const key of issue.path) received = received !== null && typeof received === 'object' ? Reflect.get(received, key) : undefined
  const field = issue.path.length ? issue.path.map(String).join('.') : '根对象'
  let reason: string
  switch (issue.code) {
    case 'invalid_type': {
      const expected = issue.expected === 'string' ? '字符串' : issue.expected === 'array' ? '数组'
        : issue.expected === 'object' ? '对象' : issue.expected
      const actual = received === undefined ? '未提供' : received === null ? 'null' : Array.isArray(received) ? '数组' : typeof received
      reason = `必须是${expected}；实际为${actual}。`
      break
    }
    case 'too_small': reason = `${issue.origin === 'array' ? '数组项数' : '字符串长度'}至少为 ${issue.minimum}。`; break
    case 'too_big': reason = `${issue.origin === 'array' ? '数组项数' : '字符串长度'}最多为 ${issue.maximum}。`; break
    case 'unrecognized_keys': reason = `不允许的额外字段：${issue.keys.map(displaySubmissionValue).join('、')}。请删除这些字段。`; break
    case 'invalid_format': reason = '必须符合该字段规定的 ID 格式，请使用计划中的交付物 ID 或工具实际返回的资产 ID。'; break
    default: reason = issue.message
  }
  return `${field}：${reason}`.slice(0, 2_000)
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

export function buildDeliveryCorrection(issues: readonly DeliveryIssue[], node: ArrangementNode): string {
  const replyIssue = issues.find(issue => issue.submissionStage !== undefined ||
    ['INVALID_SUBMISSION', 'WRONG_NODE', 'DELIVERY_MANIFEST_MISMATCH', 'MISSING_DELIVERY'].includes(issue.code))
  if (replyIssue) return buildSubmissionCorrection(issues, node, replyIssue)
  const mediaMapping = issues.some(issue => ['DUPLICATE_MEDIA_DELIVERY', 'MEDIA_DELIVERY_MANIFEST_MISMATCH', 'MISSING_MEDIA_DELIVERY'].includes(issue.code))
  if (mediaMapping || issues.some(issue => !['MISSING_DELIVERY_CONTRACT', 'OUTPUT_TRUNCATED', 'NODE_NOT_SETTLED'].includes(issue.code))) {
    return [
      mediaMapping
        ? '当前最终回复的媒体资产映射未通过校验；映射错误不代表图片或视频生成失败。只修正 mediaDeliverables，保留原任务、已下载媒体和其他有效成果。'
        : '当前交付记录或实际文件未通过校验，当前节点尚未完成。仅修复下面列出的本节点普通文件，保留其他有效成果。',
      '【实际检查结果】' + '\n' + issues.map(issue => JSON.stringify({ code: issue.code, deliverableId: issue.deliverableId, path: issue.path, reason: issue.message })).join('\n'),
      '媒体必须引用当前节点同类型且 status=saved 的真实资产。补齐遗漏映射、删除重复或计划外映射、纠正错误 artifactId；不要猜测或任意选择多个候选。主进程负责原媒体下载和复制，不要重新生成图片或视频，不自行覆盖媒体交付路径。',
      '普通文件缺失或为空时实际生成并保存；格式损坏时修复真实内容，不要仅更改扩展名；文件仍在变化时先完成写入。不得修改前置节点文件、内部交付快照或交付计划。快照和原媒体由客户端恢复，不能用变化后的内容冒充原版本。',
      '【规定的完整交付清单】' + '\n' + JSON.stringify(node.deliverables ?? [], null, 2),
      '【当前节点完整提交结构】' + '\n' + JSON.stringify(deliverySubmissionShape(node), null, 2),
      'summary 填写真实工作摘要。MEDIA_ARTIFACT_ID 只替换为已核验的真实资产 ID。完成修复后重新提交完整 JSON，不附加说明或代码围栏，不只回复已修复。',
    ].join('\n\n')
  }
  // Persisted issues also identify which validation failed when execution resumes.
  const submissionFailed = issues.some(issue => [
    'MISSING_DELIVERY_CONTRACT', 'OUTPUT_TRUNCATED', 'NODE_NOT_SETTLED', 'INVALID_SUBMISSION',
    'WRONG_NODE', 'DELIVERY_MANIFEST_MISMATCH', 'MISSING_DELIVERY',
    'DUPLICATE_MEDIA_DELIVERY', 'MEDIA_DELIVERY_MANIFEST_MISMATCH', 'MISSING_MEDIA_DELIVERY',
  ].includes(issue.code))
  return submissionFailed
    ? '当前节点尚未通过最终交付校验。请承接已有上下文和工具结果，继续完成尚未完成的任务。\n\n保留并复用已经完成的工作、有效文件和已收集的信息，不要从头重做，不要重复创建已有有效文件或重复收集已有信息；允许按需补写、修改和修复未完成的文件。\n\n以实际工具执行结果和文件状态为准，不要把此前描述的计划当作已经执行。需要操作时实际调用工具，不要只说明接下来要做什么。\n\n如果工作已经完成，只需按要求提交最终 JSON；否则先完成剩余工作，再提交。'
    : '你的提交格式已通过校验，但实际交付文件未通过校验，当前节点尚未完成。请检查规定的交付文件是否已经保存、能够正常读取、内容非空，并且符合要求的文件格式和保存位置。\n\n修复存在问题的文件，保留其他有效成果，不要重复已完成的工作。完成保存后，按照当前节点要求重新提交完整结果，包含全部规定交付文件，不要只提交修复的部分，也不要只回复“已修复”。'
}

function buildSubmissionCorrection(issues: readonly DeliveryIssue[], node: ArrangementNode, replyIssue: DeliveryIssue): string {
  const stage = replyIssue.submissionStage ?? (replyIssue.code === 'WRONG_NODE' ? 'node'
    : ['DELIVERY_MANIFEST_MISMATCH', 'MISSING_DELIVERY'].includes(replyIssue.code) ? 'manifest' : undefined)
  const descriptions = {
    json: '你的最终回复不是合法的 JSON，当前提交未通过检查。\n字段、节点 ID、交付清单和实际文件检查尚未执行。\n\n请将最终回复改为一个完整、合法的 JSON 对象：\n使用英文双引号，不添加注释，不使用 Markdown 代码围栏，\n不在 JSON 前后添加解释文字，不在最后一个字段后添加逗号。',
    fields: '你的最终回复已成功解析为 JSON，但字段检查未通过。\n\n请修正下面列出的字段。nodeId 必须是字符串，summary 必须是非空字符串，\nfinalDeliverables 必须是非空数组，每项只能包含 id、path 两个字符串字段。\n需要媒体资产映射时，使用规定的 mediaDeliverables 字段。\n不要增加提交结构之外的字段。\n节点 ID、交付清单匹配和实际文件检查尚未执行。',
    node: '你的最终回复已通过 JSON 解析和字段检查，但 nodeId 不属于当前节点。\n\n请将 nodeId 修改为下面列出的正确值，不要修改节点计划或执行其他节点的工作。\n交付清单匹配和实际文件检查尚未执行。',
    manifest: '你的最终回复已通过 JSON、字段和节点 ID 检查，但交付清单不符合计划。\n\n请使 finalDeliverables 与下面的规定清单完全一致：\n补齐遗漏项、删除重复项和计划外项目、纠正不匹配的路径。\n不要修改交付计划，也不要把过程文件加入最终清单。\n实际文件检查尚未执行；清单错误不代表文件生成失败。',
  }
  const media = (node.deliverables ?? []).filter(file =>
    (file.artifact?.kind === 'image' || file.artifact?.kind === 'video') && file.artifact.source === 'media-output')
  const example = deliverySubmissionShape(node)
  return [
    stage ? descriptions[stage] : '你的最终回复未通过提交检查。下面列出已记录的问题；未标明失败步骤时，不推断哪些前序检查已经通过。实际文件检查尚未执行。',
    '【需要修正的问题】\n' + issues.map(issue => `- ${issue.message}`).join('\n'),
    `【规定的完整交付清单】\n${JSON.stringify((node.deliverables ?? []).map(file => ({ id: file.id, path: file.path })), null, 2)}`,
    '保留已有工作和有效成果。如果实际工作已经完成，只修正最终回复，\n不要因此重复研究、生成图片或视频、下载或者修改已有有效文件。\n如果实际工作尚未完成，先完成剩余工作，不得虚报完成。',
    `【当前节点完整提交结构】\n${JSON.stringify(example, null, 2)}`,
    '上述 summary 是填写说明，请替换为实际工作摘要。' + (media.length ? 'MEDIA_ARTIFACT_ID 必须替换为媒体工具实际返回的资产 ID，不得照抄、猜测或擅自选择尚未确定的资产。' : ''),
    '重新提交完整 JSON，不只提交修改部分，不附加说明文字或代码围栏。\n提交后仍需通过后续校验，才能确认节点完成。',
  ].join('\n\n')
}

function deliverySubmissionShape(node: ArrangementNode): DeliverySubmission {
  const media = (node.deliverables ?? []).filter(file =>
    (file.artifact?.kind === 'image' || file.artifact?.kind === 'video') && file.artifact.source === 'media-output')
  return { nodeId: node.id, summary: '请填写本节点实际完成的工作及成果简述',
    finalDeliverables: (node.deliverables ?? []).map(file => ({ id: file.id, path: file.path })),
    ...(media.length ? { mediaDeliverables: media.map(file => ({ deliverableId: file.id, artifactId: 'MEDIA_ARTIFACT_ID' })) } : {}) }
}
