import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { AppError } from '../errors/app-error'
import { rateLimitRetryDelay, retryRateLimited, waitForRetry } from './rate-limit-retry'

test('SEP 429 delay accepts all documented envelopes and prefers the standard header', () => {
  for (const body of [
    { retryAfterSeconds: 12 }, { error: { retryAfterSeconds: 12 } },
    { error: { rateLimit: { retryAfterSeconds: 12 } } },
  ]) assert.equal(rateLimitRetryDelay({ httpStatus: 429, body }, 0), 12000)
  assert.equal(rateLimitRetryDelay({ httpStatus: 429, headers: { 'Retry-After': '600' }, body: { retryAfterSeconds: 1 } }, 0), 600000)
  assert.equal(rateLimitRetryDelay({ httpStatus: 429, headers: { 'retry-after': new Date(20000).toUTCString() } }, 1000), 19000)
  assert.equal(rateLimitRetryDelay({ httpStatus: 429, headers: { 'retry-after-chat': '9' } }, 0), 9000)
  assert.equal(rateLimitRetryDelay({ httpStatus: 429, body: { retryAfterSeconds: -1 } }, 0), undefined)
})

test('SEP 429 retries the same operation beyond five attempts without shortening server waits', async () => {
  let calls = 0
  const waits: number[] = []
  const transitions: boolean[] = []
  const request = { clientRequestId: 'original', quoteId: 'quote-original' }
  const result = await retryRateLimited(async () => {
    if (++calls <= 7) throw new AppError('RATE_LIMITED', { diagnostic: { httpStatus: 429,
      headers: { 'retry-after': '600' }, body: { message: 'Too many requests' } } })
    return request
  }, { sleep: async ms => { waits.push(ms) }, onWait: wait => { transitions.push(wait !== undefined) } })
  assert.equal(result, request)
  assert.equal(calls, 8)
  assert.deepEqual(waits, Array(7).fill(600000))
  assert.deepEqual(transitions, [...Array(7).fill(true), false])
})

test('SEP 429 wait does not consume the per-attempt timeout and cancellation sends no further request', async () => {
  let calls = 0
  const controller = new AbortController()
  await assert.rejects(retryRateLimited(async () => {
    calls++
    throw new AppError('RATE_LIMITED', { diagnostic: { httpStatus: 429 } })
  }, { signal: controller.signal, timeoutMs: 10, sleep: async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(controller.signal.aborted, false)
    controller.abort(new Error('User stopped waiting'))
  } }), /User stopped waiting/)
  assert.equal(calls, 1)
})

test('SEP auth throttling pauses for valid authentication instead of retrying an invalid token', async () => {
  let calls = 0
  await assert.rejects(retryRateLimited(async () => {
    calls++
    throw new AppError('RATE_LIMITED', { diagnostic: { httpStatus: 429,
      body: { error: { code: 'GATEWAY_AUTH_RATE_LIMIT_EXCEEDED' } } } })
  }, { sleep: async () => assert.fail('An invalid token must not be retried') }), { code: 'AUTH_REQUIRED' })
  assert.equal(calls, 1)
})

test('SEP non-429 failures are never retried as rate limits', async () => {
  const failure = new AppError('SERVICE_UNAVAILABLE', { diagnostic: { httpStatus: 502 } })
  await assert.rejects(retryRateLimited(async () => { throw failure }, {
    sleep: async () => assert.fail('No 429 was received'),
  }), error => error === failure)
})

test('media shutdown preserves a waiting deadline for disk recovery', async () => {
  const controller = new AbortController()
  const transitions: (number | undefined)[] = []
  await assert.rejects(retryRateLimited(async () => {
    throw new AppError('RATE_LIMITED', { diagnostic: { httpStatus: 429, headers: { 'retry-after': '600' } } })
  }, { signal: controller.signal, preserveWaitOnAbort: true, onWait: value => { transitions.push(value?.retryAt) },
    sleep: async () => { controller.abort(new Error('Shutdown')) } }), /Shutdown/)
  assert.equal(transitions.length, 1)
  assert.ok(transitions[0]! > Date.now())
})

test('short retry sleeps settle even when the wall clock is fixed', async context => {
  context.mock.method(Date, 'now', () => 4000000000000)
  await waitForRetry(1, new AbortController().signal)
})
