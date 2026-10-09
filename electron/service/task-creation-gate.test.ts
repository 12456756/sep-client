import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { TaskCreationGate } from './task-creation-gate'

const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a' }

it('waits for all overlapping creations and invalidates stale reads', async () => {
  const gate = new TaskCreationGate()
  const version = await gate.waitForIdle(scope)
  const first = gate.begin(scope)
  const second = gate.begin(scope)
  let idle = false
  const waiting = gate.waitForIdle(scope).then(() => { idle = true })
  first.finish(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(idle, false)
  second.finish(true)
  await waiting
  assert.equal(gate.isStable(scope, version), false)
  assert.equal(gate.isStable(scope, await gate.waitForIdle(scope)), true)
})

it('isolates scopes and retains failure evidence after finally release', async () => {
  const gate = new TaskCreationGate()
  const lease = gate.begin(scope)
  lease.taskCreated('task-a')
  const other = { ...scope, memberId: 'other' }
  assert.equal(gate.isStable(other, await gate.waitForIdle(other)), true)
  lease.finish(false)
  lease.finish(true)
  await gate.waitForIdle(scope)
  assert.equal(gate.hasFailed(scope, 'task-a'), true)
  assert.equal(gate.hasFailed(other, 'task-a'), false)
})
