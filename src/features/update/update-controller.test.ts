import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IpcCommandResult, UpdateState, UpdateStateResult } from '../../shared/ipc'
import { createUpdateController, type UpdateAPI } from './update-controller'
import { parseUpdateState, updateErrorMessages, updateSnapshotError, type UpdateOperation } from './update-state'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const idle: UpdateState = { status: 'idle', currentVersion: '1.0.0' }
const available: UpdateState = {
  status: 'available', currentVersion: '1.0.0', version: '1.1.0',
  releaseDate: '2026-10-09T00:00:00.000Z', releaseNotes: ['改进体验'],
}
const downloading: UpdateState = {
  status: 'downloading', currentVersion: '1.0.0', version: '1.1.0',
  percent: 30, transferred: 30, total: 100, bytesPerSecond: 10,
}
const downloaded: UpdateState = { status: 'downloaded', currentVersion: '1.0.0', version: '1.1.0' }
const ok: IpcCommandResult = { success: true }
const fail: IpcCommandResult = { success: false, error: { message: 'secret token /private/path https://private' } }
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function harness(initial: UpdateState = idle) {
  const calls: string[] = []
  const subscriptions: Array<(value: UpdateState) => void> = []
  const active = new Set<(value: UpdateState) => void>()
  let current: UpdateState = initial
  let read = () => Promise.resolve<UpdateStateResult>({ success: true, state: current })
  let subscriptionFails = false
  const handlers: Record<UpdateOperation, () => Promise<IpcCommandResult>> = {
    check: async () => ok, download: async () => ok, cancel: async () => ok, install: async () => ok,
  }
  const invoke = (operation: UpdateOperation) => { calls.push(operation); return handlers[operation]() }
  const api: UpdateAPI = {
    getUpdateState: () => { calls.push('get'); return read() },
    onUpdateStateChanged(callback) {
      calls.push('subscribe')
      if (subscriptionFails) throw new Error('subscription secret')
      subscriptions.push(callback)
      active.add(callback)
      return () => { calls.push('unsubscribe'); active.delete(callback) }
    },
    checkForUpdate: () => invoke('check'), downloadUpdate: () => invoke('download'),
    cancelUpdateDownload: () => invoke('cancel'), installUpdate: () => invoke('install'),
  }
  const controller = createUpdateController(api)
  return {
    controller, calls, handlers, subscriptions, active, api,
    setRead: (next: typeof read) => { read = next },
    setCurrent: (next: UpdateState) => { current = next },
    setSubscriptionFails: (next: boolean) => { subscriptionFails = next },
    emit(value: unknown) {
      const parsed = parseUpdateState(value)
      if (parsed) current = parsed
      for (const callback of active) callback(value as UpdateState)
    },
  }
}

async function ready(state: UpdateState = idle) {
  const h = harness(state)
  const disconnect = h.controller.connect()
  await settle()
  return { ...h, disconnect }
}

for (const rejected of [false, true]) {
  test(`subscribe precedes fetch; pushed state wins a late initial ${rejected ? 'rejection' : 'snapshot'}`, async () => {
    const h = harness()
    const initial = deferred<UpdateStateResult>()
    h.setRead(() => initial.promise)
    const disconnect = h.controller.connect()
    assert.deepEqual(h.calls, ['subscribe', 'get'])
    h.emit(downloaded)
    if (rejected) initial.reject(new Error('secret'))
    else initial.resolve({ success: true, state: idle })
    await settle()
    assert.deepEqual(h.controller.getSnapshot().state, downloaded)
    assert.equal(h.controller.getSnapshot().error, null)
    disconnect()
  })
}

test('synchronous subscription push also wins the initial snapshot', async () => {
  const h = harness()
  const api = { ...h.api, onUpdateStateChanged(callback: (state: UpdateState) => void) { callback(downloaded); return () => undefined } }
  const controller = createUpdateController(api)
  const disconnect = controller.connect()
  await settle()
  assert.deepEqual(controller.getSnapshot().state, downloaded)
  disconnect()
})

test('successful commands never optimistically change state and recover through a main snapshot', async () => {
  const h = await ready()
  const work = deferred<IpcCommandResult>()
  h.handlers.check = () => work.promise
  const promise = h.controller.getSnapshot().check()
  assert.equal(h.controller.getSnapshot().pending, 'check')
  assert.deepEqual(h.controller.getSnapshot().state, idle)
  h.setCurrent(available)
  work.resolve(ok)
  await promise
  assert.deepEqual(h.controller.getSnapshot().state, available)
  assert.equal(h.controller.getSnapshot().pending, null)
  h.disconnect()
})

test('manual recovery snapshot supersedes an older initial snapshot without any pushed events', async () => {
  const h = harness()
  const initial = deferred<UpdateStateResult>()
  h.setRead(() => initial.promise)
  const disconnect = h.controller.connect()
  h.setRead(async () => ({ success: true, state: available }))
  await h.controller.getSnapshot().check()
  initial.resolve({ success: true, state: idle })
  await settle()
  assert.deepEqual(h.controller.getSnapshot().state, available)
  disconnect()
})

test('download settlement recovers a lost downloaded event after receiving progress', async () => {
  const h = await ready(available)
  const work = deferred<IpcCommandResult>()
  h.handlers.download = () => work.promise
  const promise = h.controller.getSnapshot().download()
  h.emit(downloading)
  h.setCurrent(downloaded)
  work.resolve(ok)
  await promise
  assert.deepEqual(h.controller.getSnapshot().state, downloaded)
  assert.equal(h.controller.getSnapshot().pending, null)
  h.disconnect()
})

test('push racing a command-settlement snapshot remains authoritative', async () => {
  const h = await ready(available)
  const snapshot = deferred<UpdateStateResult>()
  h.setRead(() => snapshot.promise)
  const promise = h.controller.getSnapshot().download()
  await settle()
  h.emit(downloaded)
  snapshot.resolve({ success: true, state: downloading })
  await promise
  assert.deepEqual(h.controller.getSnapshot().state, downloaded)
  h.disconnect()
})

for (const operation of ['check', 'download', 'cancel', 'install'] as const) {
  test(`${operation} locks immediately, ignores duplicate commands and releases for retry`, async () => {
    const h = await ready(operation === 'download' ? available : operation === 'cancel' ? downloading : operation === 'install' ? downloaded : idle)
    const work = deferred<IpcCommandResult>()
    h.handlers[operation] = () => work.promise
    const model = h.controller.getSnapshot()
    const first = model[operation]()
    await model[operation]()
    assert.equal(h.calls.filter(call => call === operation).length, 1)
    assert.equal(h.controller.getSnapshot().pending, operation)
    work.resolve(fail)
    await first
    assert.equal(h.controller.getSnapshot().error, updateErrorMessages[operation])
    assert.equal(h.controller.getSnapshot().pending, null)
    h.handlers[operation] = async () => ok
    await h.controller.getSnapshot()[operation]()
    assert.equal(h.calls.filter(call => call === operation).length, 2)
    assert.equal(h.controller.getSnapshot().error, null)
    h.disconnect()
  })
}

for (const downloadRejects of [false, true]) {
  test(`cancel interrupts pending download; late download ${downloadRejects ? 'rejection' : 'completion'} cannot clear cancel lock/error`, async () => {
    const h = await ready(available)
    const work = deferred<IpcCommandResult>()
    const cancellation = deferred<IpcCommandResult>()
    h.handlers.download = () => work.promise
    h.handlers.cancel = () => cancellation.promise
    const downloadPromise = h.controller.getSnapshot().download()
    h.emit(downloading)
    const cancelPromise = h.controller.getSnapshot().cancel()
    await h.controller.getSnapshot().cancel()
    assert.equal(h.calls.filter(call => call === 'cancel').length, 1)
    assert.equal(h.controller.getSnapshot().pending, 'cancel')
    if (downloadRejects) work.reject(new Error('raw secret'))
    else work.resolve(fail)
    await downloadPromise
    assert.equal(h.controller.getSnapshot().pending, 'cancel')
    assert.equal(h.controller.getSnapshot().error, null)
    cancellation.resolve(fail)
    await cancelPromise
    assert.deepEqual(h.controller.getSnapshot().state, downloading)
    assert.equal(h.controller.getSnapshot().pending, null)
    assert.equal(h.controller.getSnapshot().error, updateErrorMessages.cancel)
    h.disconnect()
  })
}

test('rejected cancellation restores download pending and allows another cancellation attempt', async () => {
  const h = await ready(available)
  const work = deferred<IpcCommandResult>()
  h.handlers.download = () => work.promise
  h.handlers.cancel = async () => fail
  const downloadPromise = h.controller.getSnapshot().download()
  h.emit(downloading)
  await h.controller.getSnapshot().cancel()
  assert.equal(h.controller.getSnapshot().pending, 'download')
  await h.controller.getSnapshot().cancel()
  assert.equal(h.calls.filter(call => call === 'cancel').length, 2)
  work.resolve(ok)
  await downloadPromise
  assert.equal(h.controller.getSnapshot().pending, null)
  assert.equal(h.controller.getSnapshot().state?.status, 'downloading')
  h.disconnect()
})

test('successful cancellation waits for authoritative idle and never guesses status', async () => {
  const h = await ready(downloading)
  h.handlers.cancel = async () => { h.emit(idle); return ok }
  await h.controller.getSnapshot().cancel()
  assert.deepEqual(h.controller.getSnapshot().state, idle)
  h.disconnect()
})

test('actual states guard every action and retryable error operation controls retries', async () => {
  const cases: Array<[UpdateState, UpdateOperation[]]> = [
    [idle, ['check']], [available, ['check', 'download']], [downloading, ['cancel']], [downloaded, ['install']],
    [{ ...idle, status: 'checking' }, []],
    [{ ...idle, status: 'not-available', checkedAt: '2026-10-09T00:00:00Z' }, ['check']],
    ...(['check', 'download', 'cancel', 'install'] as const).flatMap(operation => [
      [{ ...idle, status: 'error', operation, message: 'raw', retryable: true } as UpdateState,
        operation === 'download' ? ['check', 'download'] : ['check']] as [UpdateState, UpdateOperation[]],
      [{ ...idle, status: 'error', operation, message: 'raw', retryable: false } as UpdateState, []] as [UpdateState, UpdateOperation[]],
    ]),
  ]
  for (const [state, allowed] of cases) {
    for (const operation of ['check', 'download', 'cancel', 'install'] as const) {
      const h = await ready(state)
      await h.controller.getSnapshot()[operation]()
      assert.equal(h.calls.includes(operation), allowed.includes(operation), `${state.status}/${'operation' in state ? state.operation : ''}: ${operation}`)
      h.disconnect()
    }
  }
})

test('initial fetch failure leaves null state, and manual check recovers subscription and snapshot', async () => {
  const h = harness()
  h.setRead(async () => { throw new Error('IPC secret') })
  h.setSubscriptionFails(true)
  const disconnect = h.controller.connect()
  await settle()
  assert.equal(h.controller.getSnapshot().state, null)
  assert.equal(h.controller.getSnapshot().error, updateSnapshotError)
  h.setSubscriptionFails(false)
  h.setRead(async () => ({ success: true, state: available }))
  await h.controller.getSnapshot().check()
  assert.equal(h.active.size, 1)
  assert.deepEqual(h.controller.getSnapshot().state, available)
  assert.equal(h.controller.getSnapshot().error, null)
  disconnect()
})

test('a failed subscription still recovers authoritative state through command snapshots', async () => {
  const h = harness()
  h.setSubscriptionFails(true)
  const disconnect = h.controller.connect()
  await settle()
  h.setCurrent(available)
  await h.controller.getSnapshot().check()
  assert.deepEqual(h.controller.getSnapshot().state, available)
  assert.equal(h.active.size, 0)
  disconnect()
})

test('malformed IPC snapshots/envelopes preserve the last valid state with fixed messages', async () => {
  const h = await ready(available)
  for (const value of [null, {}, { ...downloading, transferred: -1 }, { ...downloading, percent: Infinity }, { ...available, releaseNotes: [42] }]) {
    h.emit(value)
    assert.deepEqual(h.controller.getSnapshot().state, available)
    assert.equal(h.controller.getSnapshot().error, updateSnapshotError)
  }
  h.emit({ ...downloaded, refreshToken: 'secret' })
  assert.deepEqual(h.controller.getSnapshot().state, downloaded)
  h.handlers.install = async () => ({ success: 'true', error: { message: 'secret' } } as unknown as IpcCommandResult)
  await h.controller.getSnapshot().install()
  assert.equal(h.controller.getSnapshot().error, updateErrorMessages.install)
  assert.deepEqual(h.controller.getSnapshot().state, downloaded)
  h.disconnect()
})

test('versions match the main semver schema, rejecting paths/URLs without exposing their text', async () => {
  const h = await ready(available)
  for (const version of ['1.2', '/private/install', 'https://private/1.2.3', '1.2.3\nsecret', '']) {
    h.emit({ ...available, version })
    assert.deepEqual(h.controller.getSnapshot().state, available)
    assert.equal(h.controller.getSnapshot().error, updateSnapshotError)
    h.emit({ ...idle, currentVersion: version })
    assert.deepEqual(h.controller.getSnapshot().state, available)
  }
  h.emit({ ...available, version: '1.2.3-beta.1+build.42' })
  assert.equal(h.controller.getSnapshot().release?.version, '1.2.3-beta.1+build.42')
  h.disconnect()
})

test('error-state messages are fixed Chinese text while operation/retryable stay authoritative', async () => {
  const h = await ready()
  for (const operation of ['check', 'download', 'cancel', 'install'] as const) {
    const state: UpdateState = { ...idle, status: 'error', operation, retryable: false, message: 'secret /path URL' }
    h.emit(state)
    assert.deepEqual(h.controller.getSnapshot().state, { ...state, message: updateErrorMessages[operation] })
    assert.equal(h.controller.getSnapshot().error, updateErrorMessages[operation])
  }
  h.disconnect()
})

test('rejected or thrown installation preserves downloaded for direct retry and exposes no IPC details', async () => {
  const h = await ready(downloaded)
  h.handlers.install = async () => { throw new Error('secret /path') }
  await h.controller.getSnapshot().install()
  assert.deepEqual(h.controller.getSnapshot().state, downloaded)
  assert.equal(h.controller.getSnapshot().error, updateErrorMessages.install)
  h.handlers.install = async () => fail
  await h.controller.getSnapshot().install()
  assert.equal(h.calls.filter(call => call === 'install').length, 2)
  assert.deepEqual(h.controller.getSnapshot().state, downloaded)
  h.disconnect()
})

test('progress is clamped/monotonic only within the same observed download and never infers downloaded', async () => {
  const h = await ready(downloading)
  h.emit({ ...downloading, percent: 20, transferred: 20 })
  assert.deepEqual(h.controller.getSnapshot().state, downloading)
  h.emit({ ...downloading, percent: 110, transferred: 110 })
  assert.equal(h.controller.getSnapshot().state?.status, 'downloading')
  assert.equal((h.controller.getSnapshot().state as typeof downloading).percent, 100)
  h.emit({ ...downloading, version: '1.2.0', percent: -10, transferred: 1 })
  assert.equal((h.controller.getSnapshot().state as typeof downloading).percent, 0)
  assert.equal((h.controller.getSnapshot().state as typeof downloading).transferred, 1)
  h.emit(idle)
  h.emit({ ...downloading, percent: 2, transferred: 2 })
  assert.equal((h.controller.getSnapshot().state as typeof downloading).percent, 2)
  h.emit({ ...downloading, currentVersion: '0.9.0', percent: 1, transferred: 1 })
  assert.equal((h.controller.getSnapshot().state as typeof downloading).percent, 1)
  h.disconnect()
})

test('release metadata survives same-version downloading/downloaded and clears on version mismatch or new check', async () => {
  const h = await ready(available)
  const release = { version: available.version, releaseDate: available.releaseDate, releaseNotes: available.releaseNotes }
  assert.deepEqual(h.controller.getSnapshot().release, release)
  h.emit(downloading)
  h.emit(downloaded)
  assert.deepEqual(h.controller.getSnapshot().release, release)
  h.emit({ ...downloaded, version: '1.2.0' })
  assert.equal(h.controller.getSnapshot().release, null)
  h.emit(available)
  h.emit({ ...idle, status: 'checking' })
  assert.equal(h.controller.getSnapshot().release, null)
  h.disconnect()
  const initial = await ready(downloaded)
  assert.equal(initial.controller.getSnapshot().release, null)
  initial.disconnect()
})

test('release cache survives download retries and subscription reconnects but does not fabricate notes', async () => {
  const h = await ready(available)
  const release = h.controller.getSnapshot().release
  h.emit(downloading)
  h.emit({ ...idle, status: 'error', operation: 'download', retryable: true, message: 'raw' })
  assert.deepEqual(h.controller.getSnapshot().release, release)
  h.emit(downloading)
  h.disconnect()
  h.setCurrent(downloaded)
  const reconnect = h.controller.connect()
  await settle()
  assert.deepEqual(h.controller.getSnapshot().release, release)
  h.emit({ ...downloading, version: '1.2.0' })
  assert.equal(h.controller.getSnapshot().release, null)
  h.emit({ ...downloaded, version: '1.2.0' })
  assert.equal(h.controller.getSnapshot().release, null)
  reconnect()
})

test('cleanup ignores late initial snapshots/events and reconnect reads fresh state (StrictMode)', async () => {
  const h = harness()
  const initial = deferred<UpdateStateResult>()
  h.setRead(() => initial.promise)
  const disconnect = h.controller.connect()
  disconnect()
  disconnect()
  const before = h.controller.getSnapshot()
  h.subscriptions[0](downloaded)
  initial.resolve({ success: true, state: available })
  await settle()
  assert.equal(h.controller.getSnapshot(), before)
  assert.equal(h.active.size, 0)
  h.setRead(async () => ({ success: true, state: idle }))
  const reconnect = h.controller.connect()
  await settle()
  h.subscriptions[0](available)
  assert.deepEqual(h.controller.getSnapshot().state, idle)
  assert.equal(h.active.size, 1)
  reconnect()
  assert.equal(h.active.size, 0)
})

test('late action errors cannot leak across reconnect; in-flight lock survives until settlement', async () => {
  const h = await ready(downloaded)
  const work = deferred<IpcCommandResult>()
  h.handlers.install = () => work.promise
  const promise = h.controller.getSnapshot().install()
  h.disconnect()
  const reconnect = h.controller.connect()
  await settle()
  await h.controller.getSnapshot().install()
  assert.equal(h.calls.filter(call => call === 'install').length, 1)
  work.reject(new Error('secret'))
  await promise
  assert.equal(h.controller.getSnapshot().error, null)
  assert.equal(h.controller.getSnapshot().pending, null)
  assert.deepEqual(h.controller.getSnapshot().state, downloaded)
  h.handlers.install = async () => ok
  await h.controller.getSnapshot().install()
  assert.equal(h.calls.filter(call => call === 'install').length, 2)
  reconnect()
})

test('unmounted action completion does not notify or mutate store; detached store listeners are silent', async () => {
  const h = await ready()
  const work = deferred<IpcCommandResult>()
  h.handlers.check = () => work.promise
  let notifications = 0
  const unsubscribe = h.controller.subscribe(() => { notifications++ })
  const promise = h.controller.getSnapshot().check()
  h.disconnect()
  const snapshot = h.controller.getSnapshot()
  const count = notifications
  work.resolve(fail)
  await promise
  assert.equal(h.controller.getSnapshot(), snapshot)
  assert.equal(notifications, count)
  unsubscribe()
  const reconnect = h.controller.connect()
  await settle()
  assert.equal(notifications, count)
  assert.equal(h.controller.getSnapshot().pending, null)
  reconnect()
})
