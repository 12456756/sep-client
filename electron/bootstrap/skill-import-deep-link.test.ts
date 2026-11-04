import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { installSkillImportDeepLinks } from './skill-import-deep-link'

class FakeApp extends EventEmitter {
  lock = true
  quits = 0
  requestSingleInstanceLock() { return this.lock }
  quit() { this.quits++ }
}
const url = (id: string) => `sep-import://skills/v1?instanceId=test&sessionId=${id}`
test('queues early cold-start URLs, deduplicates, and accepts non-final argv entries', async () => {
  const app = new FakeApp()
  const received: string[] = []
  const entry = installSkillImportDeepLinks(app as never, { argv: ['app', url('one'), '--flag'], trustedInstances: new Set(['test']), focus() {} })
  assert.equal(entry.hasPendingLinks(), true)
  app.emit('open-url', { preventDefault() {} }, url('one'))
  app.emit('open-url', { preventDefault() {} }, url('two'))
  entry.attach(async link => { received.push(link.sessionId) })
  await setImmediate()
  assert.deepEqual(received, ['one', 'two'])
  assert.equal(entry.hasPendingLinks(), false)
  app.emit('second-instance', {}, ['app', url('three'), '--flag'])
  await setImmediate()
  assert.deepEqual(received, ['one', 'two', 'three'])
  entry.dispose()
  app.emit('open-url', { preventDefault() {} }, url('four'))
  assert.equal(received.length, 3)
})
test('secondary process quits without consuming requests and queue remains bounded', async () => {
  const secondary = new FakeApp()
  secondary.lock = false
  const entry = installSkillImportDeepLinks(secondary as never, { argv: [url('one')], trustedInstances: new Set(['test']), focus() {} })
  assert.equal(entry.primary, false)
  assert.equal(secondary.quits, 1)
  assert.equal(secondary.listenerCount('open-url'), 0)
  const app = new FakeApp()
  const primary = installSkillImportDeepLinks(app as never, { argv: [], trustedInstances: new Set(['test']), focus() {} })
  for (let i = 0; i < 30; i++) app.emit('open-url', { preventDefault() {} }, url(String(i)))
  const received: string[] = []
  primary.attach(async link => { received.push(link.sessionId) })
  await setImmediate()
  assert.equal(received.length, 16)
  primary.dispose()
})

test('Web cold/hot/duplicate links never focus the client; an ordinary second launch still does', async () => {
  const app = new FakeApp()
  let focused = 0
  const entry = installSkillImportDeepLinks(app as never, { argv: ['app', url('one')], trustedInstances: new Set(['test']), focus() { focused++ } })
  app.emit('open-url', { preventDefault() {} }, url('one'))
  app.emit('second-instance', {}, ['app', url('two')])
  app.emit('second-instance', {}, ['app', 'sep-import://invalid'])
  entry.attach(async () => {})
  await setImmediate()
  assert.equal(focused, 0)
  app.emit('second-instance', {}, ['app'])
  assert.equal(focused, 1)
  entry.dispose()
})
