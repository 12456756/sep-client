import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { settleWithTimeout, TimeoutError, withTimeout } from './with-timeout'

describe('withTimeout', () => {
  it('passes the value through when the work finishes in time', async () => {
    assert.equal(await withTimeout(Promise.resolve('done'), 1_000, 'work'), 'done')
  })

  it('rejects with TimeoutError once the budget is exceeded', async () => {
    const never = new Promise<void>(() => {})
    await assert.rejects(
      () => withTimeout(never, 20, 'stuck-work'),
      (error: unknown) => {
        assert.ok(error instanceof TimeoutError)
        assert.equal(error.operation, 'stuck-work')
        assert.equal(error.timeoutMs, 20)
        return true
      },
    )
  })

  it('propagates the original rejection rather than a timeout', async () => {
    const failure = new Error('boom')
    await assert.rejects(() => withTimeout(Promise.reject(failure), 1_000, 'work'), failure)
  })

  it('clears its timer so the process can exit immediately', async () => {
    const before = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
    await withTimeout(Promise.resolve(1), 60_000, 'work')
    const after = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
    assert.equal(after, before, '定时器未清理，进程会被拖住直到超时')
  })
})

describe('settleWithTimeout', () => {
  it('reports success without throwing', async () => {
    assert.deepEqual(await settleWithTimeout(Promise.resolve(), 1_000, 'work'), { ok: true })
  })

  it('reports a timeout without throwing', async () => {
    const result = await settleWithTimeout(new Promise<void>(() => {}), 20, 'stuck-work')
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.timedOut, true)
  })

  it('distinguishes a real failure from a timeout', async () => {
    const result = await settleWithTimeout(Promise.reject(new Error('boom')), 1_000, 'work')
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.timedOut, false)
    assert.equal(result.ok === false && (result.error as Error).message, 'boom')
  })
})
