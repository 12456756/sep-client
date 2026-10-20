import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SpeechService } from './speech-service'
import type { SpeechPermission } from '../../src/shared/speech-contracts'

function fixture(initial: SpeechPermission = 'prompt') {
  let permission = initial
  let authenticated = true
  let prompts = 0
  let stops = 0
  const service = new SpeechService({
    scope: { currentScope: () => authenticated ? { enterpriseId: 'e', memberId: 'u' } : null },
    settings: { read: async () => permission, write: async value => { permission = value } },
    runtime: async () => ({ recognize: async input => ({ recordingId: input.recordingId, text: 'hello', silent: false }), stop: () => { stops++ } }),
    stopRuntime: () => { stops++ },
  })
  const ask = async () => { prompts++; return true }
  return { service, ask, get prompts() { return prompts }, get permission() { return permission }, get stops() { return stops }, logout: () => { authenticated = false } }
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
})
