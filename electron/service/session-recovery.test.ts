import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TaskOwnerScope } from '../data/scope-path'
import { SessionRecovery } from './session-recovery'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

describe('session recovery', () => {
  it('starts every recovery independently and shares in-flight work', async () => {
    const history = deferred()
    const calls: string[] = []
    const recovery = new SessionRecovery({ currentScope: () => owner }, [
      { name: 'history', run: async () => { calls.push('history'); await history.promise } },
      { name: 'images', run: async () => { calls.push('images') } },
      { name: 'videos', run: async () => { calls.push('videos') } },
    ])
    const first = recovery.resume()
    assert.equal(recovery.resume(), first)
    await tick()
    assert.deepEqual(calls, ['history', 'images', 'videos'])
    history.resolve()
    await first
  })

  it('contains synchronous and asynchronous failures without skipping other recoveries', async () => {
    const calls: string[] = []
    const recovery = new SessionRecovery({ currentScope: () => owner }, [
      { name: 'history', run: () => { throw new Error('history unavailable') } },
      { name: 'images', run: async () => { throw new Error('images unavailable') } },
      { name: 'videos', run: async () => { calls.push('videos') } },
    ])
    await assert.doesNotReject(recovery.resume())
    assert.deepEqual(calls, ['videos'])
  })

  it('does not start recovery when signed out or cancelled before it starts', async () => {
    let scope: TaskOwnerScope | null = null
    let calls = 0
    const recovery = new SessionRecovery({ currentScope: () => scope }, [
      { name: 'history', run: async () => { calls++ } },
    ])
    await recovery.resume()
    scope = owner
    const pending = recovery.resume()
    recovery.stop()
    await pending
    assert.equal(calls, 0)
  })

  it('aborts old work on account changes and ignores its late completion', async () => {
    let scope: TaskOwnerScope = owner
    const gates = [deferred(), deferred()]
    const signals: AbortSignal[] = []
    const commits: string[] = []
    const recovery = new SessionRecovery({ currentScope: () => scope }, [{
      name: 'history', run: async signal => {
        const index = signals.length
        signals.push(signal)
        const memberId = scope.memberId
        await gates[index].promise
        if (!signal.aborted) commits.push(memberId)
      },
    }])
    const old = recovery.resume()
    await tick()
    scope = { ...owner, memberId: 'member-b' }
    const current = recovery.resume()
    await tick()
    assert.equal(signals[0].aborted, true)
    gates[0].resolve()
    await old
    assert.equal(recovery.resume(), current)
    assert.deepEqual(commits, [])
    gates[1].resolve()
    await current
    assert.deepEqual(commits, ['member-b'])
  })

  it('treats signing back into the same account as a new recovery session', async () => {
    const gates = [deferred(), deferred()]
    const signals: AbortSignal[] = []
    const recovery = new SessionRecovery({ currentScope: () => owner }, [{
      name: 'history', run: async signal => {
        const gate = gates[signals.length]
        signals.push(signal)
        await gate.promise
      },
    }])
    const old = recovery.resume()
    await tick()
    recovery.stop()
    const current = recovery.resume()
    await tick()
    assert.equal(signals[0].aborted, true)
    assert.equal(signals[1].aborted, false)
    gates[0].resolve()
    await old
    assert.equal(recovery.resume(), current)
    gates[1].resolve()
    await current
  })
})
