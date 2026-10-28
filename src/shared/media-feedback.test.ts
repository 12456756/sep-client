import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { mediaIssueMessage } from './media-feedback'

it('preserves uncertain submission and never echoes raw supplier errors', () => {
  const job = { generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED' as const, saveStatus: 'PENDING' as const, error: 'INSUFFICIENT_FUNDS' }
  assert.equal(mediaIssueMessage(job, 'video'), '视频提交结果尚未确认，请查看原任务，勿重复提交')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', trackingStatus: 'STOPPED' }, 'video'), '可用资金不足，请联系平台管理员')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', error: 'secret token /private/file' }, 'image'), '图片任务跟踪中断，请联系平台管理员')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', error: null }, 'image'), null)
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', error: '__proto__' }, 'image'), '图片任务跟踪中断，请联系平台管理员')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'SUCCEEDED', error: 'RESULT_EXPIRED' }, 'image'), '图片结果已过期，无法重新下载')
})
