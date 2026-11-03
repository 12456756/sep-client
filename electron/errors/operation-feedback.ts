import { FEEDBACK_OPERATIONS, operationFailure, type FeedbackOperation } from '../../src/shared/arrangement-feedback'
import { AuthApiError } from '../common/platform/platform-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { AppError } from './app-error'
import type { ErrorCode } from './error-codes'
import { workFeedbackMessage } from './work-feedback'
import { DOCUMENT_PREVIEW_FAILURES } from './document-preview-error'

interface PublicError { code: ErrorCode; message: string; statusCode: number }

const planningMessages: Readonly<Record<string, string>> = {
  '自动编排模型返回了异常工具调用，已停止规划，请重试。': '编排模型返回了不支持的工具调用，已停止规划，请重新编排；持续失败请联系平台管理员检查模型配置。',
  '当前选择的模型未配置在服务端账号组中。请管理员同步可用模型，或选择其他模型后重试。': '所选模型尚未配置到当前账号，请更换模型；如需使用该模型，请联系平台管理员配置。',
  '规划模型输出达到上限，回复未完整生成。': '编排内容超过模型输出长度限制，请减少任务范围后重试。',
  '规划模型未正常结束，未生成可用的规划结果。': '编排模型响应中断，请重试。',
  '规划模型没有返回正文，无法生成规划。': '编排模型没有返回有效内容，请重试；持续失败时请联系平台管理员检查模型服务。',
}

const planningReasons: Readonly<Record<string, string>> = {
  'invalid-json': '自动编排返回内容格式异常', 'json-not-found': '自动编排返回内容格式异常',
  'invalid-output-shape': '自动编排返回内容格式异常', 'empty-plan': '自动编排未生成工作步骤',
  'invalid-node': '自动编排的工作步骤不完整', 'missing-node-fields': '自动编排的工作步骤不完整',
  'invalid-node-work-contract': '自动编排的媒体或交付安排不完整',
  'invalid-planner-input-reference': '自动编排的输入引用无效', 'invalid-attachment-reference': '自动编排的附件引用无效',
  'required-attachment-unassigned': '自动编排未分配必需附件',
  'employee-unavailable': '自动编排选择了不可用的员工', 'model-not-allowed': '自动编排选择了不可用的模型',
  'invalid-draft': '自动编排的工作安排校验未通过',
  'invalid-intent-analysis': '自动编排的工作目标分析异常', 'invalid-intent-step': '自动编排的工作目标分析异常',
  'duplicate-intent-step': '自动编排的工作步骤重复',
  'invalid-unresolved-steps': '自动编排的员工匹配结果异常', 'invalid-unresolved-step': '自动编排的员工匹配结果异常',
}

const actionableMessages = new Set([
  '当前模型没有可用的员工授权，请更换模型或联系平台管理员配置员工授权。',
  '当前模型没有可用的员工授权，请联系平台管理员', '所选员工当前不可用，请重新选择员工',
  '自动编排选择了不可用的模型，请联系平台管理员', '所选员工不支持当前模型，请重新选择',
  '还有工作步骤缺少员工，请先完成员工匹配', '自动编排的交付文件冲突，请联系平台管理员',
  '自动编排的交付安排不完整，请联系平台管理员',
  '当前图片交付仅支持 PNG 格式，请调整要求后重新编排', '当前编排不支持所选图片或视频交付方式，请调整要求后重新编排',
  '附件需要有效的导入会话。', '自动编排无法读取已要求使用的附件。',
  '请先完成麦克风授权。', '已有语音输入正在进行。', '语音输入已关闭，请在设置中开启。',
  '本次录音已取消，请重新录音。', '本次录音已取消。', '已有语音输入正在识别。', '本次语音输入已取消。',
  '系统麦克风授权超时，请完成授权后重新尝试。',
  '无法请求 macOS 麦克风权限，请检查系统设置后重试。',
  '当前平台不支持直接打开系统麦克风设置。', '无法打开系统麦克风设置，请手动打开系统隐私设置。',
  ...['Windows', 'macOS'].flatMap(platform => [
    `${platform} 未允许访问麦克风，请在个人设置中打开系统麦克风设置。`,
    `无法确认 ${platform} 麦克风权限，请检查系统设置后重试。`,
  ]),
])

const localMessages: Partial<Record<FeedbackOperation, Readonly<Record<string, string>>>> = {
  planning: {
    '知识库目录服务不可用。': '知识库目录暂时无法读取，请稍后重试；持续失败请联系平台管理员检查知识库服务。',
    '知识库目录与用户选择不一致。': '知识库目录与当前选择不一致，请重新选择知识库后重试。',
  },
  speech: {
    '语音识别超时，请重试。': '语音识别超时，请缩短录音后重试。',
    '无法启动语音识别，请重试。': '无法向语音识别进程发送音频，请重新录音后重试。',
    '语音识别进程已退出，请重试。': '语音识别进程已退出，请重新录音后重试。',
    '语音识别响应异常，请重试。': '语音识别返回的数据不完整，请重新录音后重试。',
    '语音识别响应不匹配，请重试。': '语音识别结果与本次录音不匹配，请重新录音后重试。',
    '语音识别失败，请重新录音。': '本次音频未能完成识别，请重新录音后重试。',
    '本地语音模型缺失或损坏，请检查安装资源。': '本地语音识别模型缺失或损坏，请重新安装或修复语音识别资源。',
  },
}

const operationReasons: Partial<Record<FeedbackOperation, Readonly<Record<string, string>>>> = {
  settings: {
    'settings-locked': '当前工作已经确认或正在规划，暂不能修改执行设置。',
    'settings-node-invalid': '执行设置中的工作步骤已不存在或被重复设置，请刷新计划后重试。',
  },
  attachments: {
    'attachments-locked': '当前工作正在规划或已经确认，暂不能调整附件分配。',
    'attachment-session-unavailable': '附件导入会话不可用，请重新添加附件后再分配。',
    'attachment-node-missing': '要分配附件的工作步骤已不存在，请刷新计划后重新分配。',
  },
  imageImport: {
    'reference-task-archived': '当前工作已归档，不能再导入或选择参考图。',
    'reference-import-limit': '每次最多导入 16 张参考图，请减少选择的图片数量后重试。',
  },
  videoImport: { 'reference-task-archived': '当前工作已归档，不能再导入或选择参考图。' },
  imageSelection: {
    'reference-task-archived': '当前工作已归档，不能再导入或选择参考图。',
    'reference-selection-limit': '参考图不能重复选择，最多选择 16 张，请调整选择后重试。',
    'reference-selection-missing': '选中的参考图已不存在或尚未保存，请刷新图片列表后重新选择。',
  },
  imageCancel: {
    'media-cancel-unavailable': '当前图片渠道不支持取消、任务凭据尚未取得或任务已结束，无法取消本次任务。',
    'media-cancel-denied': '未批准取消图片任务，原任务可能仍在执行。',
  },
}

const correctedMessages: Readonly<Record<string, string>> = {
  '当前模型没有可用的员工授权，请联系平台管理员': '当前员工没有所选模型的使用权限，请更换员工或联系平台管理员授权。',
  '自动编排选择了不可用的模型，请联系平台管理员': '自动编排选择的模型不可用，请更换模型或联系平台管理员检查模型授权。',
  '自动编排的交付文件冲突，请联系平台管理员': '自动编排中多个步骤使用了相同的交付文件路径，请修改计划后重试。',
  '自动编排的交付安排不完整，请联系平台管理员': '自动编排缺少必要的工作目标或交付要求，请补充计划后重试。',
}

/** Translate fixed local file reasons only, never arbitrary parser/provider diagnostics. */
function mediaFileMessage(error: unknown, operation: FeedbackOperation): string | null {
  if (!operation.startsWith('image') && !operation.startsWith('video') || !(error instanceof Error)) return null
  const name = operation.startsWith('video') ? '视频' : '图片'
  const importing = operation === 'imageImport' || operation === 'videoImport'
  const reasons: Readonly<Record<string, string>> = {
    'Invalid media file size or type.': '图片文件为空、超过 32 MiB 或不是普通文件，请更换图片后重试。',
    'Invalid or unsupported media image.': '图片内容无效或格式不支持，请使用有效的 PNG、JPEG 或 WebP 图片。',
    'Media image dimensions exceed the supported limit.': '图片尺寸超过限制：单边最多 32768 像素，总像素最多 4000 万，请缩小图片后重试。',
    'Media image size exceeds the supported limit.': '图片为空或超过 32 MiB，请更换图片后重试。',
    'Media asset content is not a valid image.': '图片内容无效，请重新保存图片后重试。',
    'Media asset content no longer matches its manifest.': '本地图片内容与保存记录不一致，请重新导入参考图或重新保存原生成结果。',
    'Media asset does not exist.': '本地图片文件记录不存在，请刷新图片列表后重试。',
    'Media output hash, type, size or dimensions do not match the receipt.': '下载的图片与平台声明的格式、大小、尺寸或校验值不一致，请重新保存原结果。',
    'Media stream exceeds the 32 MB limit.': '下载的图片超过 32 MiB，无法保存，请联系平台管理员检查图片输出大小。',
    'Media exports must not overwrite application persistence.': '导出位置不能覆盖应用内部数据，请选择其他保存位置。',
  }
  if (Object.hasOwn(reasons, error.message)) return reasons[error.message]
  const code = 'code' in error ? error.code : undefined
  if (code === 'ENOENT') return importing ? '找不到所选参考图，请确认文件仍存在后重新选择。' : `找不到本地${name}文件，请重新保存原结果后重试。`
  if (code === 'ENOSPC') return '磁盘空间不足，无法保存文件，请清理空间后重试。'
  if (code === 'EACCES' || code === 'EPERM') return '文件或保存目录没有访问权限，请选择有读写权限的位置后重试。'
  return null
}

export function transportKind(error: unknown, depth = 0): 'network' | 'timeout' | null {
  if (!(error instanceof Error) || depth > 3) return null
  const code = 'code' in error ? String(error.code) : ''
  if (error.name === 'TimeoutError' || error.name === 'APIConnectionTimeoutError' || error.message === 'Request timed out.' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout'
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) return 'network'
  return transportKind(error.cause, depth + 1)
    ?? (error instanceof TypeError && error.message === 'fetch failed' ? 'network' : null)
}

/** Raw platform messages are deliberately never copied into the public result. */
export function operationFeedback(error: unknown, operation: FeedbackOperation, mapped?: PublicError): PublicError {
  const fallback: PublicError = { code: 'INTERNAL_ERROR', statusCode: 500, message: operationFailure(operation) }
  const fileMessage = mediaFileMessage(error, operation)
  if (fileMessage) return { ...(mapped ?? fallback), message: fileMessage }
  const transport = transportKind(error)
  if (transport) return { code: 'NETWORK_ERROR', statusCode: 0, message: transport === 'timeout' ? '网络连接超时，请稍后重试' : '网络连接失败，请检查网络' }
  if (error instanceof AuthenticationRequiredError) return { code: 'AUTH_REQUIRED', statusCode: 401, message: '登录状态已失效，请重新登录' }
  if (error instanceof AuthApiError) {
    const statusCode = error.statusCode
    if (statusCode === 401) return { code: 'AUTH_REQUIRED', statusCode, message: '登录验证未通过，请重新登录' }
    if (statusCode === 403) return { code: 'PERMISSION_DENIED', statusCode, message: `${FEEDBACK_OPERATIONS[operation]}请求被平台拒绝，请检查账号权限；如需开通权限，请联系平台管理员。` }
    if (statusCode === 429) return { code: 'RATE_LIMITED', statusCode, message: '请求过于频繁，请稍后重试' }
    if (statusCode === 0 || statusCode === 408) return { code: 'NETWORK_ERROR', statusCode, message: statusCode === 408 ? '网络连接超时，请稍后重试' : '网络连接失败，请检查网络' }
    return { ...fallback, statusCode, code: statusCode >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message: statusCode >= 500 ? `${FEEDBACK_OPERATIONS[operation]}服务暂时不可用，请稍后重试；持续失败请联系平台管理员。` : fallback.message }
  }
  if (error instanceof Error && error.message.startsWith('ATTACHMENT_') && mapped && mapped.message !== '操作未能完成。') return mapped
  if (error instanceof AppError) {
    const base = { code: error.code, statusCode: mapped?.statusCode ?? 500 }
    const local = localMessages[operation]
    if (local && Object.hasOwn(local, error.userMessage)) return { ...base, message: local[error.userMessage] }
    if (Object.hasOwn(correctedMessages, error.userMessage)) return { ...base, message: correctedMessages[error.userMessage] }
    if (operation === 'documentPreview' && Object.values(DOCUMENT_PREVIEW_FAILURES).some(message => message === error.userMessage)) return { ...base, message: error.userMessage }
    const reason = error.details?.reason
    const reasons = operationReasons[operation]
    if (typeof reason === 'string' && reasons && Object.hasOwn(reasons, reason)) return { ...base, message: reasons[reason] }
    const workMessage = workFeedbackMessage(error, operation, error.code)
    if (workMessage) return { ...base, message: workMessage }
    if (error.userMessage === '自动编排无法读取已要求使用的附件。') return { ...base, message: '自动编排无法读取所需附件，请确认附件仍存在，重新添加附件后重试。' }
    if (error.code === 'PLANNING_FAILED' && Object.hasOwn(planningMessages, error.userMessage)) return { ...base, message: planningMessages[error.userMessage] }
    if (error.code === 'PLANNING_FAILED' && typeof reason === 'string' && Object.hasOwn(planningReasons, reason)) return { ...base, message: `${planningReasons[reason]}，请检查计划并重新编排；持续失败请联系平台管理员检查模型配置。` }
    if (actionableMessages.has(error.userMessage) || Object.values(correctedMessages).includes(error.userMessage)) return { ...base, message: error.userMessage }
    const messages: Partial<Record<ErrorCode, string>> = {
      AUTH_REQUIRED: '登录状态已失效，请重新登录',
      DRAFT_REVISION_CONFLICT: '工作安排已更新，请重新加载后再操作',
      MODEL_NOT_ALLOWED: operation === 'planning' ? correctedMessages['自动编排选择了不可用的模型，请联系平台管理员'] : '所选员工不支持当前模型，请重新选择',
      EMPLOYEE_UNAVAILABLE: '所选员工当前不可用，请重新选择员工',
      SUBSCRIPTION_EXPIRING: '员工授权剩余时间不足，无法开始工作',
      WORKSPACE_INVALID: '工作目录不可用，请重新选择目录',
      PERMISSION_DENIED: '当前工作权限不允许执行此操作，或本次操作未获批准，请检查工作权限和审批结果；如需授权，请联系平台管理员。',
      CONFLICT: '工作目录被其他任务占用，请稍后重试',
      NETWORK_ERROR: '网络连接失败，请检查网络', RATE_LIMITED: '请求过于频繁，请稍后重试',
    }
    if (error.code === 'INVALID_ARGUMENT' && operation === 'imageSelection') return { ...base,
      message: '参考图选择参数无效，请刷新图片列表后重新选择，最多选择 16 张且不能重复。' }
    if (messages[error.code]) return { ...base, message: messages[error.code]! }
    if (error.code === 'INVALID_ARGUMENT' && error.details?.reason === 'employee-unavailable') return { ...base, message: '所选员工当前不可用，请重新选择员工' }
    return { ...base, message: fallback.message }
  }
  if (mapped?.code === 'AUTH_REQUIRED') return { ...mapped, message: '登录状态已失效，请重新登录' }
  const workMessage = workFeedbackMessage(error, operation, mapped?.code)
  if (workMessage && mapped) return { ...mapped, message: workMessage }
  return { ...(mapped ?? fallback), message: fallback.message }
}
