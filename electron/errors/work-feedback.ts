import type { FeedbackOperation } from '../../src/shared/arrangement-feedback'
import type { ErrorCode } from './error-codes'
import { AppError } from './app-error'

// Only exact, locally owned reasons may become user-visible business messages.
const reasons: Readonly<Record<string, string>> = {
  '任务正在执行，无法删除。': '工作正在执行，请先终止工作，再删除记录',
  '未找到该执行记录。': '未找到这次执行记录，请重新加载工作过程',
  '通用助手会话不支持切换员工，请新建员工对话。': '通用助手会话不支持切换员工，请新建员工对话',
  '这项编排正在执行，请稍后再确认。': '工作正在执行，请等待当前操作完成',
  '编排状态已变化，无法确认。': '工作状态已变化，请重新加载后再确认',
  '存在不可确认的节点。': '工作状态已变化，请重新加载后再确认',
  '编排状态已变化，请刷新后再确认。': '工作状态已变化，请重新加载后再确认',
  '这项编排正在执行或提交重试，请等待当前操作完成。': '工作正在执行或提交重试，请等待当前操作完成',
  '当前编排仍在执行，只能重试已失败的指定节点。': '工作仍在执行，只能重试当前失败的节点',
  '只能重试当前失败的节点。': '只能重试当前失败的节点',
  '没有可重试的失败节点。': '当前没有可重试的失败节点',
  '这项编排已终止或完成，不能重试。': '这项编排已终止或完成，不能重试',
  '编排计划与恢复进度不一致，无法重试。': '工作恢复进度异常，请联系平台管理员',
  '当前编排状态不支持重试。': '当前工作状态不支持重试，请重新加载后再操作',
  '原请求尚未结束或提交状态不明，不能重做。': '原任务尚未结束，请等待处理完成后再重做',
  '原视频提交状态尚未确认，请查询或恢复原任务，不能重复生成。': '视频提交结果尚未确认，请查看原任务，勿重复提交',
  '报价授权已过期，请重新发起。': '本次报价已过期，请重新发起',
  '当前授权配置没有可用的图片模型。': '图片生成配置不可用，请联系平台管理员',
  '图片网关尚未接通，当前不能生成图片。': '图片生成服务不可用，请联系平台管理员',
  '当前比例没有合法尺寸，请刷新模型规格。': '图片生成配置不可用，请联系平台管理员',
  '图片比例与尺寸不匹配。': '图片比例与尺寸不匹配，请调整选择',
  '图片尚未完整交付，请查看图片任务状态。': '图片尚未完整交付，请等待原任务完成',
  '图片任务未在本地跟踪，请恢复原请求。': '图片任务跟踪已中断，请恢复原任务跟踪',
  '此节点尚无已验收的文档，请等待节点交付完成。': '当前节点尚无可预览文档，请等待交付完成',
  '此格式暂不支持文档预览，可复制路径查看原文件。': '当前格式暂不支持预览，请打开原文件查看',
  '验收版本不可读取或已被修改，可复制路径检查原文件。': '文档交付版本无法读取，请联系平台管理员',
  '文档交付版本已更新，请重新打开预览。': '文档交付版本已更新，请重新打开预览',
}

export function workFeedbackMessage(error: unknown, operation: FeedbackOperation, code?: ErrorCode): string | null {
  if (!operation.startsWith('work') && !operation.startsWith('image') && !operation.startsWith('video') && operation !== 'documentPreview') return null
  if (error instanceof AppError && Object.hasOwn(reasons, error.userMessage)) return reasons[error.userMessage]
  const messages: Partial<Record<ErrorCode, string>> = {
    INSUFFICIENT_FUNDS: '可用资金不足，请联系平台管理员',
    VIDEO_BUDGET_EXCEEDED: '已超过企业视频预算，请联系平台管理员',
    MEDIA_FORBIDDEN: '当前账号没有视频生成权限，请联系平台管理员',
    QUOTE_EXPIRED: '本次报价已过期，请重新发起',
    VIDEO_CONCURRENCY_LIMIT: '视频任务数已达上限，请稍后重试',
    SESSION_UNRECOVERABLE: '工作历史会话无法恢复，请联系平台管理员',
    RECOVERY_CONFIRMATION_REQUIRED: '工作历史会话需要恢复确认，请联系平台管理员',
  }
  if (code && messages[code]) return messages[code]!
  if (code === 'NOT_FOUND' && operation.startsWith('work')) return '未找到这项工作，请重新加载工作列表'
  if (code === 'CONFLICT' && operation === 'imageGenerate') return '图片请求正在处理，请勿重复提交'
  if (code === 'CONFLICT' && (operation.startsWith('image') || operation.startsWith('video'))) return '媒体任务正在处理，请等待当前操作完成'
  return null
}
