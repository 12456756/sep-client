import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { AuthApiError } from '../common/platform/platform-api'
import { appError } from './app-error'
import { toEnvelope } from './error-mapper'
import { operationFeedback } from './operation-feedback'
import { planningFailure, planningContractFailure } from './planning-diagnostics'

it('does not classify an arrangement 403 as expired authentication or echo a platform response', () => {
  const result = toEnvelope(new AuthApiError({ statusCode: 403, message: 'secret server path /private/token' }, 'employee-access-requests'), { authenticated: true, feedbackOperation: 'request' })
  assert.equal(result.code, 'PERMISSION_DENIED')
  assert.equal(result.message, '员工申请请求被拒绝，请联系平台管理员')
  assert.doesNotMatch(JSON.stringify(result), /secret|private|token/)
})

it('distinguishes actual transport errors from server failures and unknown exceptions', () => {
  for (const [code, message] of [['ENOTFOUND', '网络连接失败，请检查网络'], ['ETIMEDOUT', '网络连接超时，请稍后重试']]) {
    const error = new Error('request failed', { cause: Object.assign(new Error('private diagnostics'), { code }) })
    assert.equal(operationFeedback(error, 'planning').message, message)
  }
  assert.equal(operationFeedback(new AuthApiError({ statusCode: 503, message: 'upstream unavailable' }), 'planning').message, '自动编排失败，请联系平台管理员')
  assert.equal(operationFeedback(new Error('ETIMEDOUT in an unrelated string'), 'start').message, '工作启动失败，请联系平台管理员')
})

it('preserves safe attachment and model reasons, but never trusts arbitrary AppError messages', () => {
  const context = { feedbackOperation: 'attachment' as const }
  assert.match(toEnvelope(new Error('ATTACHMENT_TOO_LARGE'), context).message, /20 MiB/)
  assert.equal(toEnvelope(appError('MODEL_NOT_ALLOWED'), { feedbackOperation: 'start' }).message, '所选员工不支持当前模型，请重新选择')
  assert.match(toEnvelope(appError('MODEL_NOT_ALLOWED'), { feedbackOperation: 'planning' }).message, /请联系平台管理员/)
  assert.equal(toEnvelope(appError('INVALID_STATE', { message: 'node:private-id:model-not-allowed' }), { feedbackOperation: 'preflight' }).message, '工作启动检查失败，请联系平台管理员')
})

it('treats subscription inactive as unavailable, without inventing an expiry date', () => {
  const result = operationFeedback(appError('EMPLOYEE_UNAVAILABLE'), 'start')
  assert.equal(result.message, '所选员工当前不可用，请重新选择员工')
  assert.doesNotMatch(result.message, /过期|到期/)
})

it('uses operation-specific work messages and preserves only verified business reasons', () => {
  assert.equal(toEnvelope(new Error('private path and token'), { feedbackOperation: 'workDelete' }).message, '工作记录删除失败，请联系平台管理员')
  assert.equal(toEnvelope(appError('INVALID_STATE', { message: '任务正在执行，无法删除。' }), { feedbackOperation: 'workDelete' }).message, '工作正在执行，请先终止工作，再删除记录')
  assert.equal(toEnvelope(appError('INVALID_STATE', { message: '只能重试当前失败的节点。' }), { feedbackOperation: 'workRetry' }).message, '只能重试当前失败的节点')
  assert.equal(toEnvelope(appError('CONFLICT'), { feedbackOperation: 'imageGenerate' }).message, '图片请求正在处理，请勿重复提交')
  assert.equal(toEnvelope(appError('INSUFFICIENT_FUNDS'), { feedbackOperation: 'videoRead' }).message, '可用资金不足，请联系平台管理员')
  assert.equal(toEnvelope(appError('NOT_FOUND', { message: '验收版本不可读取或已被修改，可复制路径检查原文件。' }), { feedbackOperation: 'documentPreview' }).message, '文档交付版本无法读取，请联系平台管理员')
  assert.doesNotMatch(toEnvelope(appError('INVALID_ARGUMENT', { message: 'private input' }), { feedbackOperation: 'imageGenerate' }).message, /private/)
})

it('preserves known planning reasons without exposing contract paths or model output', () => {
  const cases = [
    ['invalid-json', '自动编排返回内容格式异常'], ['empty-plan', '自动编排未生成工作步骤'],
    ['required-attachment-unassigned', '自动编排未分配必需附件'],
    ['model-not-allowed', '自动编排选择了不可用的模型'],
  ]
  for (const [reason, message] of cases) {
    assert.equal(operationFeedback(planningFailure('output-validation', reason, new Error('private model output')), 'planning').message, `${message}，请联系平台管理员`)
  }
  const contract = planningContractFailure(4, [{ path: ['mediaRequirements', 0, 'private-field'], code: 'invalid_type' }])
  assert.equal(operationFeedback(contract, 'planning').message, '自动编排的媒体或交付安排不完整，请联系平台管理员')
  assert.equal(operationFeedback(appError('PLANNING_FAILED', { message: '规划模型输出达到上限，回复未完整生成。' }), 'planning').message, '编排内容超过模型输出上限，请联系平台管理员')
  assert.equal(toEnvelope(new Error('ATTACHMENT_INTEGRITY_MISMATCH'), { feedbackOperation: 'attachment' }).message, '附件数据损坏，请联系平台管理员')
})
