import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EmployeeDirectory } from './employee-directory'
import type { Subscription } from '../common/platform/platform-api'

function instance(id: string, status: string): Subscription {
  return { id, status, template: { id: `${id}-template` }, allowedModels: ['model-a'] } as unknown as Subscription
}

describe('EmployeeDirectory', () => {
  it('serves the cached snapshot inside the TTL without hitting the platform', async () => {
    let calls = 0
    let clock = 1_000
    const directory = new EmployeeDirectory(async () => {
      calls += 1
      return [instance('a', 'ACTIVE')]
    }, 15_000, () => clock)

    assert.equal((await directory.list('token')).length, 1)
    clock += 14_999
    await directory.list('token')
    assert.equal(calls, 1, 'TTL 内不该再发请求')

    clock += 2
    await directory.list('token')
    assert.equal(calls, 2, 'TTL 过期后必须重新拉取')
  })

  it('collapses concurrent misses into a single request', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const directory = new EmployeeDirectory(async () => {
      calls += 1
      await gate
      return [instance('a', 'ACTIVE')]
    })

    const results = Promise.all([directory.list('token'), directory.list('token'), directory.refresh('token')])
    release()
    for (const listed of await results) assert.equal(listed.length, 1)
    assert.equal(calls, 1, '并发请求未合并，会对平台形成惊群')
  })

  it('keeps only ACTIVE subscriptions', async () => {
    const directory = new EmployeeDirectory(async () => [
      instance('a', 'ACTIVE'),
      instance('b', 'SUSPENDED'),
      instance('c', 'ACTIVE'),
    ])
    assert.deepEqual((await directory.list('token')).map(item => item.id), ['a', 'c'])
    assert.deepEqual(directory.snapshot().map(item => item.id), ['a', 'c'])
  })

  it('propagates failures and does not cache them', async () => {
    let calls = 0
    const directory = new EmployeeDirectory(async () => {
      calls += 1
      if (calls === 1) throw new Error('platform down')
      return [instance('a', 'ACTIVE')]
    })

    await assert.rejects(() => directory.list('token'), /platform down/)
    assert.deepEqual(directory.snapshot(), [], '失败不该留下快照')
    assert.equal((await directory.list('token')).length, 1, '失败后应允许重试')
  })

  it('refresh bypasses the TTL', async () => {
    let calls = 0
    const clock = 0
    const directory = new EmployeeDirectory(async () => {
      calls += 1
      return [instance('a', 'ACTIVE')]
    }, 60_000, () => clock)

    await directory.list('token')
    await directory.list('token')
    assert.equal(calls, 1)
    await directory.refresh('token')
    assert.equal(calls, 2, 'refresh 必须绕过 TTL')
  })

  it('invalidate drops the snapshot', async () => {
    let calls = 0
    const directory = new EmployeeDirectory(async () => {
      calls += 1
      return [instance('a', 'ACTIVE')]
    }, 60_000)

    await directory.list('token')
    directory.invalidate()
    assert.deepEqual(directory.snapshot(), [])
    await directory.list('token')
    assert.equal(calls, 2)
  })
})
