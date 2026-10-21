import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SpeechSystemAccess } from './speech-system-access'

function fixture(platform: NodeJS.Platform = 'darwin', initial = 'not-determined') {
  let status = initial
  let requests = 0
  let confirms = 0
  let readFails = false
  const opened: string[] = []
  const access = new SpeechSystemAccess({
    platform,
    status: () => { if (readFails) throw new Error('private details'); return status },
    request: async () => { requests++; status = 'granted'; return true },
    open: async url => { opened.push(url) },
  })
  return { access, opened, confirm: async () => { confirms++; return true },
    setStatus: (value: string) => { status = value }, failStatus: () => { readFails = true },
    get requests() { return requests }, get confirms() { return confirms } }
}

describe('platform-specific system microphone access', () => {
  it('shares concurrent native prompts and recovers cleanly after system denial', async () => {
    let finish!: (allowed: boolean) => void
    let requests = 0
    let status = 'not-determined'
    const access = new SpeechSystemAccess({ platform: 'darwin', status: () => status,
      request: () => { requests++; return new Promise(resolve => { finish = resolve }) }, open: async () => {} })
    const first = access.prepare()
    const second = access.prepare()
    const rejected = Promise.all([assert.rejects(first, /未允许/), assert.rejects(second, /未允许/)])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests, 1)
    status = 'denied'
    finish(false)
    await rejected
    assert.equal(access.canRecord(), false)
    await assert.rejects(access.prepare(), /未允许/)
    assert.equal(requests, 1)
    status = 'granted'
    assert.equal(await access.prepare(), true)
  })
  it('macOS asks the system once and never opens an extra application consent dialog', async () => {
    const f = fixture()
    assert.equal(f.access.canRecord(), false)
    assert.equal(await f.access.authorize(f.confirm), true)
    assert.equal(f.requests, 1)
    assert.equal(f.confirms, 0)
    assert.equal(await f.access.prepare(), true)
    assert.equal(f.requests, 1)
    assert.equal(f.access.canRecord(), true)
  })
  it('a macOS prompt with a previously saved app grant never starts capture on its own', async () => {
    const f = fixture()
    assert.equal(await f.access.prepare(), false)
    assert.equal(f.requests, 1)
    assert.equal(await f.access.prepare(), true)
  })
  it('already granted macOS permission does not prompt again', async () => {
    const f = fixture('darwin', 'granted')
    assert.equal(await f.access.authorize(f.confirm), true)
    assert.equal(f.requests, 0)
    assert.equal(f.confirms, 0)
  })
  it('denied/restricted macOS permissions guide users to settings without repeated prompts', async () => {
    for (const status of ['denied', 'restricted']) {
      const f = fixture('darwin', status)
      await assert.rejects(f.access.authorize(f.confirm), /macOS.*设置/)
      await assert.rejects(f.access.prepare(), /macOS.*设置/)
      assert.equal(f.access.canRecord(), false)
      assert.equal(f.requests, 0)
      assert.equal(f.confirms, 0)
      assert.deepEqual(f.opened, [])
    }
  })
  it('Windows checks global permission and confirms locally without calling the macOS API', async () => {
    const f = fixture('win32', 'granted')
    assert.equal(await f.access.authorize(f.confirm), true)
    assert.equal(f.confirms, 1)
    assert.equal(f.requests, 0)
    assert.equal(await f.access.prepare(), true)
    f.setStatus('denied')
    assert.equal(f.access.canRecord(), false)
    await assert.rejects(f.access.prepare(), /Windows.*设置/)
    await assert.rejects(f.access.authorize(f.confirm), /Windows.*设置/)
    assert.equal(f.confirms, 1)
  })
  it('a Windows decline is respected and revocation during confirmation cannot grant access', async () => {
    const f = fixture('win32', 'granted')
    assert.equal(await f.access.authorize(async () => false), false)
    await assert.rejects(f.access.authorize(async () => { f.setStatus('denied'); return true }), /Windows/)
  })
  it('failed or unknown status checks never silently authorize recording', async () => {
    const f = fixture('win32', 'unexpected')
    await assert.rejects(f.access.prepare(), /无法确认/)
    f.failStatus()
    assert.equal(f.access.canRecord(), false)
    await assert.rejects(f.access.authorize(f.confirm), /无法确认/)
  })
  it('only explicit settings actions open fixed OS destinations', async () => {
    for (const [platform, url] of [
      ['win32', 'ms-settings:privacy-microphone'],
      ['darwin', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'],
    ] as const) {
      const f = fixture(platform)
      await f.access.openSettings()
      assert.deepEqual(f.opened, [url])
      assert.equal(f.requests, 0)
    }
  })
  it('other platforms retain app consent without calling unsupported system APIs', async () => {
    const f = fixture('linux')
    assert.equal(await f.access.authorize(f.confirm), true)
    assert.equal(await f.access.prepare(), true)
    assert.equal(f.access.canRecord(), true)
    assert.equal(f.requests, 0)
    await assert.rejects(f.access.openSettings(), /不支持/)
  })
  it('OS denial and failures never leak native error details', async () => {
    for (const request of [async () => false, async () => { throw new Error('private details') }]) {
      const access = new SpeechSystemAccess({ platform: 'darwin', status: () => 'not-determined', request, open: async () => {} })
      await assert.rejects(access.prepare(), error => error instanceof Error && !error.message.includes('private details'))
    }
    const access = new SpeechSystemAccess({ platform: 'win32', status: () => 'granted', request: async () => true,
      open: async () => { throw new Error('private details') } })
    await assert.rejects(access.openSettings(), /无法打开/)
  })
  it('a pending OS prompt is reused, times out safely and cannot start recording after timeout', async () => {
    let resolve!: (allowed: boolean) => void
    let requests = 0
    const access = new SpeechSystemAccess({ platform: 'darwin', status: () => 'not-determined', timeoutMs: 5,
      request: () => { requests++; return new Promise(yes => { resolve = yes }) }, open: async () => {} })
    const keepAlive = setTimeout(() => {}, 1000)
    try {
      await assert.rejects(access.prepare(), /超时/)
      await assert.rejects(access.prepare(), /超时/)
      assert.equal(requests, 1)
      resolve(true)
      await new Promise(yes => setImmediate(yes))
      assert.equal(access.canRecord(), false)
    } finally { clearTimeout(keepAlive) }
  })
})
