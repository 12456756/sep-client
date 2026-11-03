import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ScheduledTimer } from './scheduled-timer'

test('requests during a scan coalesce, stop releases timers, and faults remain visible', async () => {
  let release!: () => void
  let scans = 0
  const timer = new ScheduledTimer(async () => {
    scans++
    if (scans === 1) await new Promise<void>(resolve => { release = resolve })
    if (scans === 3) throw new Error('disk failure')
  }, async () => [], Date.now)
  timer.start(); timer.request(); timer.request()
  assert.equal(scans, 1)
  release()
  for (let i = 0; scans < 2 && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(scans, 2)
  timer.request()
  for (let i = 0; timer.state !== 'error' && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(timer.state, 'error')
  timer.request()
  assert.equal(scans, 3)
  timer.start()
  for (let i = 0; scans < 4 && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(timer.state, 'running')
  timer.stop()
  assert.equal(timer.state, 'stopped')
})

test('an obsolete scan failure after stop does not turn an intentional shutdown into a fault', async () => {
  let reject!: (error: Error) => void
  const timer = new ScheduledTimer(() => new Promise<void>((_resolve, fail) => { reject = fail }), async () => [], Date.now)
  timer.start(); timer.stop(); reject(new Error('stale generation'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timer.state, 'stopped')
})
