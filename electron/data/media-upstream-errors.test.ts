import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { SepRealMediaGateway } from './sep-real-media-gateway'
import { SepRealVideoGateway } from './sep-video-media-gateway'
import { AppError } from '../errors/app-error'
import { mediaToolFailureFrom } from '../errors/media-tool-error'
import { videoToolFailureFrom } from '../errors/video-tool-error'
import { mediaIssueMessage } from '../../src/shared/media-feedback'
import { videoReceiptSchema } from '../../src/shared/video-media'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'

const signal = new AbortController().signal
for (const kind of ['image', 'video'] as const) {
  for (const body of ['Supplier account disabled', { error: { code: 'supplier_denied', message: 'Supplier account disabled' } }]) {
    test(`${kind} retains upstream 401 ${typeof body} errors without treating them as SEP authentication`, async () => {
      let calls = 0
      const fetcher: typeof fetch = async () => {
        calls++
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 401,
          headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'X-SEP-Error-Source': 'upstream' } })
      }
      const options = { baseUrl: 'https://sep.invalid/api', token: async () => 'fixture-token', fetch: fetcher }
      try {
        if (kind === 'image') await new SepRealMediaGateway(options).getReceipt('sub', 'receipt', signal)
        else await new SepRealVideoGateway({ ...options, mock: false, subscriptionId: 'sub' }).getReceipt('receipt', signal)
        assert.fail('expected upstream error')
      } catch (error) {
        assert.ok(error instanceof AppError)
        assert.notEqual(error.code, 'AUTH_REQUIRED')
        assert.equal(error.details?.source, 'upstream')
        const failure = kind === 'image' ? mediaToolFailureFrom(error) : videoToolFailureFrom(error)
        assert.match(failure.error.message, /生成供应商账号已停用/)
        assert.doesNotMatch(failure.error.message, /Supplier account disabled|重新登录|余额不足/)
      }
      assert.equal(calls, 1)
    })
  }
}
test('asynchronous upstream errors survive receipt validation and become visible task errors', () => {
  const upstreamError = { status: 200, body: { error: { code: 'supplier_failed', message: 'Reference subject rejected' } } }
  const receipt = videoReceiptSchema.parse({ ...fixture.receipts.failed, upstreamError })
  assert.deepEqual(receipt.upstreamError, upstreamError)
  assert.match(mediaIssueMessage({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', saveStatus: 'PENDING', error: null, upstreamError }, 'video')!, /参考内容被生成服务拒绝/)
})
