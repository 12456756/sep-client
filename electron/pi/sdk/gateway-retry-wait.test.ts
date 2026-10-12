import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { GatewayRetryWait, waitForGatewayRetry } from './gateway-retry-wait'

function response(headers: Record<string, string> = {}, status = 429): Response {
  return new Response(null, { status, headers })
}

describe('gateway retry wait', () => {
  it('uses seconds and HTTP dates from Retry-After, including zero', () => {
    for (const [header, expected] of [['3', 3000], ['0', 0], ['0.25', 250], ['0.0005', 1]]) {
      const retry = new GatewayRetryWait()
      assert.equal(retry.inspect(response({ 'Retry-After': String(header) }), 0), true)
      assert.equal(retry.schedule(), expected)
    }
    const retry = new GatewayRetryWait()
    retry.inspect(response({ 'Retry-After': new Date(5000).toUTCString() }), 1000)
    assert.equal(retry.schedule(), 4000)
  })

  it('supports millisecond hints and falls back for absent or invalid hints', () => {
    for (const header of [undefined, 'invalid', '-2', 'Infinity']) {
      const retry = new GatewayRetryWait()
      retry.inspect(response(header === undefined ? {} : { 'Retry-After': header }))
      assert.equal(retry.schedule(), 2000)
      retry.inspect(response())
      assert.equal(retry.schedule(), 4000)
      retry.inspect(response())
      assert.equal(retry.schedule(), 8000)
    }
    const retry = new GatewayRetryWait()
    retry.inspect(response({ 'retry-after-ms': '150', 'Retry-After': '5' }))
    assert.equal(retry.schedule(), 150)
  })

  it('rejects excessive server waits instead of retrying before recovery', async () => {
    const retry = new GatewayRetryWait()
    assert.equal(retry.inspect(response({ 'Retry-After': '301' })), false)
    assert.match(retry.terminalError ?? '', /300000/)
    await assert.rejects(retry.wait(), /300000/)
    retry.reset()
    assert.equal(retry.terminalError, undefined)
    assert.equal(retry.inspect(response({ 'Retry-After': '300' })), true)
    assert.equal(retry.schedule(), 300000)
    assert.equal(retry.inspect(response({ 'Retry-After': '9'.repeat(400) })), false)
  })

  it('accepts a ninety-second server wait without shortening it', () => {
    const retry = new GatewayRetryWait()
    assert.equal(retry.inspect(response({ 'Retry-After': '90' })), true)
    assert.equal(retry.terminalError, undefined)
    assert.equal(retry.schedule(), 90000)
  })

  it('honors an explicit non-retryable response and clears stale header hints', async () => {
    const retry = new GatewayRetryWait()
    assert.equal(retry.inspect(response({ 'x-should-retry': 'false' })), false)
    await assert.rejects(retry.wait(), /disabled automatic retry/)
    retry.reset()
    retry.inspect(response({ 'Retry-After': '10' }))
    retry.schedule()
    retry.inspect(response({}, 200))
    assert.equal(retry.schedule(), 4000)
  })

  it('keeps concurrent sessions independent and consumes a scheduled wait only once', async () => {
    const first = new GatewayRetryWait()
    const second = new GatewayRetryWait()
    first.inspect(response({ 'Retry-After': '0.01' }))
    second.inspect(response({ 'Retry-After': '30' }))
    assert.equal(first.schedule(), 10)
    assert.equal(second.schedule(), 30000)
    await first.wait()
    await first.wait()
    second.reset()
    await second.wait()
    assert.equal(second.schedule(), 2000)
  })

  it('aborts waits immediately, including an already aborted signal', async () => {
    const controller = new AbortController()
    const waiting = waitForGatewayRetry(300000, controller.signal)
    controller.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    await assert.rejects(waitForGatewayRetry(1, controller.signal), { name: 'AbortError' })
    await waitForGatewayRetry(1)
  })
})
