import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SpeechService } from './speech-service'
import type { SpeechPermission } from '../../src/shared/speech-contracts'
import { SpeechSystemAccess } from '../bootstrap/speech-system-access'

function fixture(initial: SpeechPermission = 'prompt') {
  let permission = initial
  let authenticated = true
  let prompts = 0
  let stops = 0
  let systemStatus = 'granted'
  const opened: string[] = []
  const microphone = new SpeechSystemAccess({ platform: 'win32', status: () => systemStatus,
    request: async () => assert.fail('Windows must not request macOS authorization'), open: async url => { opened.push(url) } })
  const service = new SpeechService({
    microphone,
    scope: { currentScope: () => authenticated ? { enterpriseId: 'e', memberId: 'u' } : null },
    settings: { read: async () => permission, write: async value => { permission = value } },
    runtime: async () => ({ recognize: async input => ({ recordingId: input.recordingId, text: 'hello', silent: false }), stop: () => { stops++ } }),
    stopRuntime: () => { stops++ },
  })
  const ask = async () => { prompts++; return true }
  return { service, ask, opened, setSystemStatus: (value: string) => { systemStatus = value },
    get prompts() { return prompts }, get permission() { return permission }, get stops() { return stops }, logout: () => { authenticated = false } }
}

describe('speech authorization and session isolation', () => {
  it('persists first consent without starting a microphone session', async () => {
    const f = fixture()
    assert.deepEqual(await f.service.begin('first', f.ask), { recordingId: 'first', ready: false, permission: 'granted' })
    assert.equal(f.permission, 'granted')
    assert.equal(f.service.canUseMicrophone(), false)
    assert.equal((await f.service.begin('next', f.ask)).ready, true)
    assert.equal(f.prompts, 1)
    assert.equal(f.service.canUseMicrophone(), true)
    f.service.stop()
  })
  it('never prompts again after denial until explicitly enabled in settings', async () => {
    const f = fixture()
    await f.service.begin('first', async () => false)
    await assert.rejects(f.service.begin('next', f.ask), /设置/)
    assert.equal(f.prompts, 0)
    await f.service.setEnabled(true, f.ask)
    assert.equal((await f.service.begin('third', f.ask)).ready, true)
    f.service.stop()
  })
  it('rejects competing recordings and ignores cancellation of another session', async () => {
    const f = fixture('granted')
    await f.service.begin('a', f.ask)
    await assert.rejects(f.service.begin('b', f.ask))
    f.service.cancel('b')
    assert.equal(f.service.canUseMicrophone(), true)
    f.service.cancel('a')
    assert.equal(f.service.canUseMicrophone(), false)
  })
  it('does not arm a cancelled authorization request', async () => {
    const f = fixture()
    let allow!: (value: boolean) => void
    const pending = f.service.begin('a', () => new Promise(resolve => { allow = resolve }))
    await new Promise(resolve => setImmediate(resolve))
    f.service.cancel('a')
    allow(true)
    assert.equal((await pending).ready, false)
    assert.equal(f.service.canUseMicrophone(), false)
  })
  it('disabling speech revokes an active session before persistence finishes', async () => {
    const f = fixture('granted')
    await f.service.begin('a', f.ask)
    const disabled = f.service.setEnabled(false, f.ask)
    assert.equal(f.service.canUseMicrophone(), false)
    await disabled
    assert.equal(f.permission, 'denied')
  })
  it('requires login and refuses recognition for a different recording', async () => {
    const f = fixture('granted')
    await f.service.begin('a', f.ask)
    await assert.rejects(f.service.recognize({ recordingId: 'b', sampleRate: 16000, samples: new Float32Array(1600) }))
    f.logout()
    assert.equal(f.service.canUseMicrophone(), false)
    await assert.rejects(f.service.begin('c', f.ask))
    f.service.stop()
  })
  it('clears the session after inference and returns only the matching result', async () => {
    const f = fixture('granted')
    await f.service.begin('a', f.ask)
    assert.equal((await f.service.recognize({ recordingId: 'a', sampleRate: 16000, samples: new Float32Array(1600) })).text, 'hello')
    assert.equal(f.service.canUseMicrophone(), false)
  })
  it('does not show a late consent dialog after cancellation during settings IO', async () => {
    let read!: (permission: SpeechPermission) => void
    let prompts = 0
    const service = new SpeechService({
      microphone: new SpeechSystemAccess({ platform: 'win32', status: () => 'granted', request: async () => true, open: async () => {} }),
      scope: { currentScope: () => ({ enterpriseId: 'e', memberId: 'u' }) },
      settings: { read: () => new Promise(resolve => { read = resolve }), write: async () => {} },
      runtime: async () => { throw new Error('Must not load runtime') }, stopRuntime: () => {},
    })
    const pending = service.begin('a', async () => { prompts++; return true })
    service.cancel('a')
    read('prompt')
    assert.equal((await pending).ready, false)
    assert.equal(prompts, 0)
  })
  it('rechecks system access for saved grants and does not erase app consent when access is revoked', async () => {
    const f = fixture('granted')
    f.setSystemStatus('denied')
    await assert.rejects(f.service.begin('a', f.ask), /Windows.*设置/)
    assert.equal(f.service.canUseMicrophone(), false)
    assert.equal(f.permission, 'granted')
    assert.equal(f.prompts, 0)
    f.setSystemStatus('granted')
    assert.equal((await f.service.begin('b', f.ask)).ready, true)
    f.setSystemStatus('denied')
    assert.equal(f.service.canUseMicrophone(), false)
    await assert.rejects(f.service.recognize({ recordingId: 'b', sampleRate: 16000, samples: new Float32Array(1600) }))
    f.service.stop()
  })
  it('does not authorize from settings after cancellation while loading saved permission', async () => {
    let read!: (permission: SpeechPermission) => void
    let prompts = 0
    const service = new SpeechService({
      microphone: new SpeechSystemAccess({ platform: 'win32', status: () => 'granted', request: async () => true, open: async () => {} }),
      scope: { currentScope: () => ({ enterpriseId: 'e', memberId: 'u' }) },
      settings: { read: () => new Promise(resolve => { read = resolve }), write: async () => assert.fail('Must not persist a cancelled grant') },
      runtime: async () => assert.fail('Must not load runtime'), stopRuntime: () => {},
    })
    const pending = service.setEnabled(true, async () => { prompts++; return true })
    service.stop()
    read('prompt')
    assert.equal(await pending, 'prompt')
    assert.equal(prompts, 0)
    assert.equal(service.canUseMicrophone(), false)
  })
  it('checks system permission even when enabling an already granted setting', async () => {
    const f = fixture('granted')
    f.setSystemStatus('denied')
    await assert.rejects(f.service.setEnabled(true, f.ask), /Windows/)
    assert.equal(f.permission, 'granted')
  })
  it('opens system settings only for an authenticated explicit request', async () => {
    const f = fixture()
    await f.service.openSystemSettings()
    assert.deepEqual(f.opened, ['ms-settings:privacy-microphone'])
    assert.equal(f.prompts, 0)
    assert.equal(f.service.canUseMicrophone(), false)
    f.logout()
    await assert.rejects(f.service.openSystemSettings())
    assert.equal(f.opened.length, 1)
  })
  it('does not persist a late grant after cancelling consent or disabling speech', async () => {
    for (const disable of [false, true]) {
      const f = fixture()
      let allow!: (value: boolean) => void
      const pending = f.service.begin('a', () => new Promise(resolve => { allow = resolve }))
      await new Promise(resolve => setImmediate(resolve))
      if (disable) await f.service.setEnabled(false, f.ask)
      else f.service.cancel('a')
      allow(true)
      assert.equal((await pending).ready, false)
      assert.equal(f.permission, disable ? 'denied' : 'prompt')
      assert.equal(f.service.canUseMicrophone(), false)
    }
  })
  it('ignores a late authorization result after logout even if the same identity returns', async () => {
    const f = fixture()
    let allow!: (value: boolean) => void
    const pending = f.service.setEnabled(true, () => new Promise(resolve => { allow = resolve }))
    await new Promise(resolve => setImmediate(resolve))
    f.service.stop()
    allow(true)
    await pending
    assert.equal(f.permission, 'prompt')
  })
})

describe('macOS speech service authorization', () => {
  it('uses OS authorization, rechecks saved grants, and requires a new recording gesture', async () => {
    let status = 'not-determined'
    let permission: SpeechPermission = 'prompt'
    let requests = 0
    const service = new SpeechService({
      scope: { currentScope: () => ({ enterpriseId: 'e', memberId: 'u' }) },
      settings: { read: async () => permission, write: async value => { permission = value } },
      microphone: new SpeechSystemAccess({ platform: 'darwin', status: () => status,
        request: async () => { requests++; status = 'granted'; return true }, open: async () => {} }),
      runtime: async () => assert.fail('Authorization must not load the model'), stopRuntime: () => {},
    })
    const ask = async () => assert.fail('macOS must not show the extra app dialog')
    assert.equal((await service.begin('a', ask)).ready, false)
    assert.equal(requests, 1)
    assert.equal(permission, 'granted')
    assert.equal(service.canUseMicrophone(), false)
    assert.equal((await service.begin('b', ask)).ready, true)
    service.stop()
    status = 'not-determined'
    assert.equal((await service.begin('c', ask)).ready, false)
    assert.equal(service.canUseMicrophone(), false)
    assert.equal(requests, 2)
    assert.equal((await service.begin('d', ask)).ready, true)
    service.stop()
    status = 'denied'
    await assert.rejects(service.begin('e', ask), /macOS.*设置/)
    assert.equal(permission, 'granted')
    assert.equal(requests, 2)
  })
})
