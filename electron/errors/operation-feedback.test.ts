import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { AuthApiError } from '../common/platform/platform-api'
import { appError } from './app-error'
import { toEnvelope } from './error-mapper'
import { operationFeedback } from './operation-feedback'
import { planningFailure, planningContractFailure } from './planning-diagnostics'

it('keeps actionable task, document and speech causes through the IPC envelope', () => {
  const cases = [
    ['workRetry', '这项工作有尚未结束的运行，请先结束后再重新执行。', '当前工作还有未结束的运行，请先结束当前运行后再重新执行。'],
    ['workRetry', '只有已确认计划的流程工作支持重新执行。', '只有已确认计划的流程工作支持重新执行，当前记录没有可复用的确认计划。'],
    ['workRetry', '无法复制已确认的输入附件。', '重新执行所需的原附件复制失败，请确认附件仍存在后重试。'],
    ['workDelete', '工作状态已变化，无法删除，请刷新后重试。', '工作状态已变化，暂时无法删除，请刷新工作记录后重试。'],
    ['documentPreview', '对话成果文件已更新，请重新打开预览。', '文件在预览期间发生变化，请重新打开预览。'],
    ['speech', '语音识别超时，请重试。', '语音识别超时，请缩短录音后重试。'],
    ['speech', '语音识别进程已退出，请重试。', '语音识别进程已退出，请重新录音后重试。'],
    ['planning', '知识库目录与用户选择不一致。', '知识库目录与当前选择不一致，请重新选择知识库后重试。'],
  ] as const
  for (const [feedbackOperation, message, expected] of cases) {
    const result = toEnvelope(appError('INVALID_STATE', { message, cause: new Error('private token /secret') }), { feedbackOperation })
    assert.equal(result.message, expected)
    assert.doesNotMatch(JSON.stringify(result), /private|token|secret/)
  }
})

it('uses operation-scoped reasons without exposing arbitrary reason strings', () => {
  assert.equal(operationFeedback(appError('INVALID_STATE', { details: { reason: 'settings-locked' } }), 'settings').message,
    '当前工作已经确认或正在规划，暂不能修改执行设置。')
  assert.equal(operationFeedback(appError('INVALID_STATE', { details: { reason: 'reference-task-archived' } }), 'imageImport').message,
    '当前工作已归档，不能再导入或选择参考图。')
  const unknown = operationFeedback(appError('INVALID_STATE', { details: { reason: 'private-token' }, message: 'private-token' }), 'settings')
  assert.doesNotMatch(unknown.message, /private-token/)
})

it('explains attachment, reference and cancellation restrictions without changing the error code', () => {
  const cases = [
    ['attachments', 'attachments-locked', /正在规划或已经确认/],
    ['attachments', 'attachment-session-unavailable', /导入会话不可用/],
    ['attachments', 'attachment-node-missing', /工作步骤已不存在/],
    ['settings', 'settings-node-invalid', /工作步骤已不存在或被重复设置/],
    ['imageSelection', 'reference-selection-limit', /最多选择 16 张/],
    ['imageSelection', 'reference-selection-missing', /不存在或尚未保存/],
    ['imageImport', 'reference-import-limit', /最多导入 16 张/],
    ['imageCancel', 'media-cancel-unavailable', /不支持取消.*任务已结束/],
    ['imageCancel', 'media-cancel-denied', /未批准取消/],
  ] as const
  for (const [operation, reason, expected] of cases) {
    const result = toEnvelope(appError('INVALID_STATE', { details: { reason, privatePath: '/secret' } }), { feedbackOperation: operation })
    assert.equal(result.code, 'INVALID_STATE')
    assert.match(result.message, expected)
    assert.doesNotMatch(JSON.stringify(result), /secret|privatePath/)
  }
})

it('translates fixed local image errors and never copies raw file or provider diagnostics', () => {
  for (const [message, expected] of [
    ['Invalid media file size or type.', /32 MiB/],
    ['Invalid or unsupported media image.', /PNG、JPEG 或 WebP/],
    ['Media image dimensions exceed the supported limit.', /4000 万/],
    ['Media asset content no longer matches its manifest.', /本地图片内容与保存记录不一致/],
    ['Media exports must not overwrite application persistence.', /导出位置不能覆盖应用内部数据/],
  ] as const) assert.match(operationFeedback(new Error(message), 'imageImport').message, expected)
  for (const code of ['ENOENT', 'ENOSPC', 'EACCES', 'EPERM']) {
    const result = toEnvelope(Object.assign(new Error('private /secret'), { code }), { feedbackOperation: 'imageImport' })
    assert.doesNotMatch(JSON.stringify(result), /private|secret/)
    assert.doesNotMatch(result.message, /没有取得具体原因/)
  }
  assert.match(operationFeedback(appError('PERMISSION_DENIED'), 'imageGenerate').message, /工作权限.*审批结果/)
  assert.match(operationFeedback(appError('INVALID_ARGUMENT'), 'imageSelection').message, /参数无效.*16 张/)
})

it('does not classify an arrangement 403 as expired authentication or echo a platform response', () => {
  const result = toEnvelope(new AuthApiError({ statusCode: 403, message: 'secret server path /private/token' }, 'employee-access-requests'), { authenticated: true, feedbackOperation: 'request' })
  assert.equal(result.code, 'PERMISSION_DENIED')
  assert.equal(result.message, '员工申请请求被平台拒绝，请检查账号权限；如需开通权限，请联系平台管理员。')
  assert.doesNotMatch(JSON.stringify(result), /secret|private|token/)
})

it('distinguishes actual transport errors from server failures and unknown exceptions', () => {
  for (const [code, message] of [['ENOTFOUND', '网络连接失败，请检查网络'], ['ETIMEDOUT', '网络连接超时，请稍后重试']]) {
    const error = new Error('request failed', { cause: Object.assign(new Error('private diagnostics'), { code }) })
    assert.equal(operationFeedback(error, 'planning').message, message)
  }
  assert.equal(operationFeedback(new AuthApiError({ statusCode: 503, message: 'upstream unavailable' }), 'planning').message, '自动编排服务暂时不可用，请稍后重试；持续失败请联系平台管理员。')
  assert.equal(operationFeedback(new Error('ETIMEDOUT in an unrelated string'), 'start').message, '工作启动失败，客户端没有取得具体原因，请重试；持续失败请联系平台管理员。')
})

it('preserves safe attachment and model reasons, but never trusts arbitrary AppError messages', () => {
  const context = { feedbackOperation: 'attachment' as const }
  assert.match(toEnvelope(new Error('ATTACHMENT_TOO_LARGE'), context).message, /20 MiB/)
  assert.equal(toEnvelope(appError('MODEL_NOT_ALLOWED'), { feedbackOperation: 'start' }).message, '所选员工不支持当前模型，请重新选择')
  assert.match(toEnvelope(appError('MODEL_NOT_ALLOWED'), { feedbackOperation: 'planning' }).message, /模型不可用.*模型授权/)
  assert.equal(toEnvelope(appError('INVALID_STATE', { message: 'node:private-id:model-not-allowed' }), { feedbackOperation: 'preflight' }).message, '工作启动检查失败，客户端没有取得具体原因，请重试；持续失败请联系平台管理员。')
})

it('treats subscription inactive as unavailable, without inventing an expiry date', () => {
  const result = operationFeedback(appError('EMPLOYEE_UNAVAILABLE'), 'start')
  assert.equal(result.message, '所选员工当前不可用，请重新选择员工')
  assert.doesNotMatch(result.message, /过期|到期/)
})

it('uses operation-specific work messages and preserves only verified business reasons', () => {
  assert.equal(toEnvelope(appError('CONVERSATION_QUEUE_FULL'), { feedbackOperation: 'workSend' }).message, '任务队列已经满了')
  assert.equal(toEnvelope(new Error('private path'), { feedbackOperation: 'workOpenDirectory' }).message, '无法打开文件所在目录，请确认文件和目录仍存在，并检查系统访问权限。')
  assert.equal(toEnvelope(new Error('private path and token'), { feedbackOperation: 'workDelete' }).message, '工作记录删除失败，客户端没有取得具体原因，请重试；持续失败请联系平台管理员。')
  assert.equal(toEnvelope(appError('INVALID_STATE', { message: '任务正在执行，无法删除。' }), { feedbackOperation: 'workDelete' }).message, '工作正在执行，请先终止工作，再删除记录')
  assert.equal(toEnvelope(appError('INVALID_STATE', { message: '只能重试当前失败的节点。' }), { feedbackOperation: 'workRetry' }).message, '只能重试当前失败的节点')
  assert.equal(toEnvelope(appError('CONFLICT'), { feedbackOperation: 'imageGenerate' }).message, '图片请求正在处理，请勿重复提交')
  assert.equal(toEnvelope(appError('INSUFFICIENT_FUNDS'), { feedbackOperation: 'videoRead' }).message, '当前账号可用资金不足，请联系企业管理员补充资金后重试。')
  assert.equal(toEnvelope(appError('NOT_FOUND', { message: '验收版本不可读取或已被修改，可复制路径检查原文件。' }), { feedbackOperation: 'documentPreview' }).message, '已验收文件的原交付版本缺失、被修改或无法读取，请检查原文件。')
  assert.doesNotMatch(toEnvelope(appError('INVALID_ARGUMENT', { message: 'private input' }), { feedbackOperation: 'imageGenerate' }).message, /private/)
})

it('preserves known planning reasons without exposing contract paths or model output', () => {
  const cases = [
    ['invalid-json', '自动编排返回内容格式异常'], ['empty-plan', '自动编排未生成工作步骤'],
    ['required-attachment-unassigned', '自动编排未分配必需附件'],
    ['model-not-allowed', '自动编排选择了不可用的模型'],
  ]
  for (const [reason, message] of cases) {
    assert.equal(operationFeedback(planningFailure('output-validation', reason, new Error('private model output')), 'planning').message, `${message}，请检查计划并重新编排；持续失败请联系平台管理员检查模型配置。`)
  }
  const contract = planningContractFailure(4, [{ path: ['mediaRequirements', 0, 'private-field'], code: 'invalid_type' }])
  assert.equal(operationFeedback(contract, 'planning').message, '自动编排的媒体或交付安排不完整，请检查计划并重新编排；持续失败请联系平台管理员检查模型配置。')
  assert.equal(operationFeedback(appError('PLANNING_FAILED', { message: '规划模型输出达到上限，回复未完整生成。' }), 'planning').message, '编排内容超过模型输出长度限制，请减少任务范围后重试。')
  assert.equal(toEnvelope(new Error('ATTACHMENT_INTEGRITY_MISMATCH'), { feedbackOperation: 'attachment' }).message, '附件快照已损坏，请重新添加附件。')
})
