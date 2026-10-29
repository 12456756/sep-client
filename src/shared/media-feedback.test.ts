import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { mediaIssueMessage, mediaSpecFailureMessage } from './media-feedback'

it('explains specification failures instead of reporting unavailable employees or missing permissions', () => {
  const job = { generationStatus: 'FAILED', trackingStatus: 'STOPPED' as const, saveStatus: 'PENDING' as const }
  assert.match(mediaIssueMessage({ ...job, error: 'MISSING_SPEC' }, 'video')!, /规格尚未确定/)
  assert.match(mediaIssueMessage({ ...job, error: 'PRICE_UNAVAILABLE' }, 'image')!, /可靠报价/)
  assert.match(mediaIssueMessage({ ...job, error: 'OUTPUT_SPEC_MISMATCH' }, 'video')!, /实际产物/)
})

it('shows the safe failure source, field and suggested specifications without free-form upstream text', () => {
  const message = mediaSpecFailureMessage({ code: 'UPSTREAM_SPEC_UNSUPPORTED', message: 'secret upstream body',
    field: 'requestedSpec.durationSeconds', requestedValue: 8, source: 'provider', reasonCode: 'UNSUPPORTED_DURATION', alternatives: [{ durationSeconds: 6 }] })!
  assert.match(message, /上游模型/)
  assert.match(message, /时长.*8/)
  assert.match(message, /6/)
  assert.doesNotMatch(message, /secret upstream/)
  assert.equal(mediaSpecFailureMessage({ code: 'UNKNOWN', message: 'private' }), null)
})

it('preserves uncertain submission and never echoes raw supplier errors', () => {
  const job = { generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED' as const, saveStatus: 'PENDING' as const, error: 'INSUFFICIENT_FUNDS' }
  assert.equal(mediaIssueMessage(job, 'video'), '视频提交结果尚未确认，请查看原任务，勿重复提交')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', trackingStatus: 'STOPPED' }, 'video'), '可用资金不足，请联系平台管理员')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', error: 'secret token /private/file' }, 'image'), '图片任务跟踪中断，请联系平台管理员')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', error: null }, 'image'), null)
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', error: '__proto__' }, 'image'), '图片任务跟踪中断，请联系平台管理员')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'SUCCEEDED', error: 'RESULT_EXPIRED' }, 'image'), '图片结果已过期，无法重新下载')
})
