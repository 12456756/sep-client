import { createHash } from 'node:crypto'
import type { LogFields } from '../common/logger'
import { redactText } from '../common/redact'
import { AppError } from './app-error'

export type PlanningEmployeeScope = 'authorized' | 'enterprise' | 'platform'
export type PlanningPhase =
  | 'initialization' | 'employee-loading' | 'provider-request' | 'response-assembly'
  | 'json-extraction' | 'json-parse' | 'output-validation' | 'employee-validation'
  | 'model-validation' | 'dag-validation' | 'finalization' | 'cleanup'
  | 'round-1' | 'round-2' | 'round-3'

export interface PlanningDiagnosticContext {
  round: number
  employeeScope: PlanningEmployeeScope
}

export function planningFailure(phase: PlanningPhase, reason: string, cause?: unknown): AppError {
  const correctionIssues = planningCorrectionIssues(cause)
  return new AppError('PLANNING_FAILED', { cause, details: { phase, reason, ...(correctionIssues.length ? { correctionIssues } : {}) } })
}

export interface PlanningCorrectionIssue {
  path: string
  code: string
  expectation: string
}

export function planningFieldFailure(phase: PlanningPhase, reason: string, path: readonly PropertyKey[], expectation: string): AppError {
  return new AppError('PLANNING_FAILED', { details: { phase, reason,
    correctionIssues: [{ path: safeContractPath(path), code: 'custom', expectation }],
  } })
}

const contractFields = new Set([
  'objective', 'knowledgeQuery', 'deliverables', 'mediaRequirements', 'id', 'name', 'format', 'path',
  'contentOutline', 'acceptanceCriteria', 'artifact', 'kind', 'source', 'operation', 'required',
  'inputFrom', 'nodeId', 'deliverableId', 'artifactId', 'inputSelection', 'preferred',
  'aspectRatio', 'resolution', 'durationSeconds', 'frameRate', 'audio', 'outputFormat', 'count',
  'nodes', 'title', 'instruction', 'expectedOutput', 'stepId', 'subscriptionId', 'modelId', 'dependsOn',
  'intentAnalysis', 'summary', 'steps', 'requiredCapabilities', 'requiredCapabilityIds', 'unresolvedSteps',
  'candidateMatches', 'employeeId', 'rationale', 'reason', 'inputRefs', 'attachment', 'attachmentId', 'sha256', 'purpose',
  'specRevision', 'requiredSpec', 'proposedSpec', 'parameterSources', 'decisionRef', 'generationMethod', 'width', 'height', 'size', 'quality',
])

function safeContractPath(path: readonly PropertyKey[]): string {
  return path.slice(0, 12).map(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0
    ? String(part) : typeof part === 'string' && contractFields.has(part) ? part : 'field').join('.')
}

function contractExpectation(issue: { path: readonly PropertyKey[]; code: string; expected?: string; minimum?: number | bigint; maximum?: number | bigint }): string {
  const field = String(issue.path.at(-1) ?? '')
  if (issue.path.includes('inputRefs')) return '附件引用必须为 {"kind":"attachment","attachment":{"attachmentId":"本轮真实附件编号","sha256":"本轮真实64位指纹"},"required":true,"purpose":"media-source"}；purpose 也可为 reference、analysis、vision。编号与指纹逐字复制附件目录。'
  if (issue.code === 'unrecognized_keys') return '删除协议之外的额外字段，只保留系统提示词列出的字段。'
  if (issue.path.includes('parameterSources') && field === 'source') return '规格来源 source 只能是 user、model、upstream，按本轮实际决定依据填写。'
  if (issue.code === 'custom' && issue.path.includes('deliverables') && !issue.path.includes('artifact')) return '交付文件必须使用安全相对路径且扩展名与 format 一致；媒体输出文件格式必须与类型一致。'
  if (issue.code === 'invalid_type') return `字段必须是 ${issue.expected ?? '协议规定的类型'}，不能省略必需字段或用 null 替代。`
  if (issue.code === 'too_small') return `字段长度、数组项数或数值必须满足下限 ${String(issue.minimum ?? '系统协议要求')}。`
  if (issue.code === 'too_big') return `字段长度、数组项数或数值不能超过 ${String(issue.maximum ?? '系统协议上限')}。`
  const fields: Record<string, string> = {
    kind: 'kind 必须与场景及 operation 一致；媒体需求只使用 image 或 video。',
    operation: 'operation 只能是 generate、edit、image-to-video、text-to-video，必须与媒体类型一致。',
    source: 'source 只能是 workspace、media-output、either；AI 生成媒体交付物必须使用 media-output。',
    inputFrom: 'inputFrom 是单个对象，填写真实 artifactId 或前置 nodeId 与 deliverableId；绑定用户图片按系统附件规则处理，不得编造资产。',
    inputSelection: 'inputSelection 只能是 single、any、all、model、user；无输入时省略。',
    requiredSpec: '按 kind 使用图片或视频规格字段，数值类型、尺寸、比例必须一致。',
    proposedSpec: '按 kind 使用图片或视频规格字段，数值类型、尺寸、比例必须一致。',
    specRevision: '提供 requiredSpec、proposedSpec 或 parameterSources 时，specRevision 必须是正安全整数。',
    generationMethod: 'generationMethod 只能是 ai-generated、script、either。',
    path: 'path 必须是安全工作区相对路径，扩展名与 format 一致；不得包含绝对路径、上级跳转或非法文件名。',
    format: 'format 是不带点的文件扩展名，并且必须与 path 和媒体类型一致。',
    id: 'id 必须为 1 至 128 位英文字母、数字、下划线或连字符，且在所属范围内唯一。',
    aspectRatio: 'aspectRatio 使用正整数比例字符串，例如 16:9，且与 width、height、数值 size 一致。',
    durationSeconds: '视频结构化规格 durationSeconds 必须是正安全整数；preferred 中可使用正数。',
    parameterSources: '来源键只能是规格字段，值为 user/model/upstream，或 {"source":"user","decisionRef":"决定依据"}。',
  }
  return fields[field] ?? '按系统提示词中的完整字段结构、类型、取值和关联约束修正本字段。'
}

export function planningContractFailure(nodeIndex: number, issues: readonly { path: readonly PropertyKey[]; code: string; expected?: string; minimum?: number | bigint; maximum?: number | bigint }[], hint = '请重新规划。'): AppError {
  const validationIssues = issues.slice(0, 8).map(issue => ({
    path: safeContractPath(issue.path),
    code: /^[a-z_]{1,64}$/.test(issue.code) ? issue.code : 'invalid',
  }))
  return new AppError('PLANNING_FAILED', {
    message: `第 ${nodeIndex + 1} 个节点的媒体或交付字段不符合要求（${validationIssues[0]?.path || '节点字段'}），${hint}`,
    details: { phase: 'output-validation', reason: 'invalid-node-work-contract', nodeIndex, validationIssues,
      correctionIssues: issues.slice(0, 8).map((issue, index) => ({ path: `nodes.${nodeIndex}.${validationIssues[index]!.path}`,
        code: validationIssues[index]!.code, expectation: hint === '请重新规划。' ? contractExpectation(issue) : hint })),
    },
  })
}

export function planningCorrectionIssues(error: unknown): PlanningCorrectionIssue[] {
  if (!(error instanceof AppError) || !Array.isArray(error.details?.correctionIssues)) return []
  return error.details.correctionIssues.slice(0, 16).flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return []
    const issue = raw as Record<string, unknown>
    if (typeof issue.path !== 'string' || typeof issue.expectation !== 'string') return []
    return [{ path: safeContractPath(issue.path.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part)),
      code: typeof issue.code === 'string' && /^[a-z_]{1,64}$/.test(issue.code) ? issue.code : 'invalid',
      expectation: redactText(issue.expectation, 2_000) }]
  })
}

export function planningErrorFields(error: unknown): LogFields {
  let root = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && root instanceof Error && root.cause !== undefined && !seen.has(root); depth += 1) {
    seen.add(root)
    root = root.cause
  }
  const message = root instanceof Error ? root.message : typeof root === 'string' ? root : ''
  const record = root && typeof root === 'object' ? root as Record<string, unknown> : {}
  const status = record.status ?? record.statusCode
  const providerStatus = typeof status === 'number' && status >= 400 && status <= 599
    ? status : Number(/^(?:HTTP\s+)?([45]\d{2})(?:\D|$)/i.exec(message)?.[1]) || undefined
  const causeType = root instanceof Error ? root.name : typeof root
  const stack = root instanceof Error ? root.stack?.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 12).join('\n') : undefined
  const code = typeof record.code === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(record.code) ? record.code : undefined
  const reason = error instanceof AppError && typeof error.details?.reason === 'string' ? error.details.reason
    : error instanceof AppError && error.code === 'AUTH_REQUIRED' ? 'authentication-required'
    : (code && /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(code)) || /^(?:fetch failed|network error|network request failed|connect |connection |request timed out)/i.test(message) ? 'network-error'
      : /model_not_found/i.test(message) ? 'model-not-configured'
        : providerStatus ? 'provider-error' : 'internal-error'
  const parseOffset = root instanceof SyntaxError ? /(?:position|column)\s+(\d+)/i.exec(message)?.[1] : undefined
  return {
    errorCode: error instanceof AppError ? error.code : 'PLANNING_FAILED',
    ...(error instanceof AppError && typeof error.details?.phase === 'string' ? { phase: error.details.phase } : {}),
    reason,
    ...(error instanceof AppError && error.details?.reason === 'invalid-node-work-contract' &&
      Number.isSafeInteger(error.details.nodeIndex) && Array.isArray(error.details.validationIssues) ? {
        nodeIndex: error.details.nodeIndex,
        validationIssues: error.details.validationIssues.slice(0, 8).map((issue: unknown) => {
          const item = issue && typeof issue === 'object' ? issue as Record<string, unknown> : {}
          return {
            path: typeof item.path === 'string' ? safeContractPath(item.path.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part)) : 'field',
            code: typeof item.code === 'string' && /^[a-z_]{1,64}$/.test(item.code) ? item.code : 'invalid',
          }
        }),
      } : {}),
    causeMessage: reason,
    causeType: redactText(causeType, 80),
    causeMessageLength: message.length,
    causeFingerprint: createHash('sha256').update(message).digest('hex'),
    ...(providerStatus ? { providerStatus } : {}),
    ...(code ? { causeCode: code } : {}),
    ...(parseOffset ? { parseOffset: Number(parseOffset) } : {}),
    ...(stack ? { stack: redactText(stack, 4096) } : {}),
  }
}
