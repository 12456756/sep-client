import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { BrowserWindow, Session, WebContents } from 'electron'
import { installSpeechPermissions } from './speech-permissions'

describe('speech media permission boundary', () => {
  it('permits only authorized main-frame audio and preserves existing clipboard writes', () => {
    let check!: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
    let request!: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
    let enabled = false
    let stops = 0
    const url = 'file:///trusted/index.html'
    const contents = Object.assign(new EventEmitter(), { getURL: () => url, session: {
      setPermissionCheckHandler: (callback: typeof check) => { check = callback },
      setPermissionRequestHandler: (callback: typeof request) => { request = callback },
    } })
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents })
    installSpeechPermissions(window as unknown as BrowserWindow, url, { canUseMicrophone: () => enabled, stop: () => { stops++ } })
    const owner = contents as unknown as WebContents
    const audio = { isMainFrame: true, mediaType: 'audio' } as const
    assert.equal(check(owner, 'media', '', audio), false)
    enabled = true
    assert.equal(check(owner, 'media', '', audio), true)
    assert.equal(check(owner, 'media', '', { ...audio, mediaType: 'video' }), false)
    assert.equal(check(owner, 'media', '', { ...audio, isMainFrame: false }), false)
    assert.equal(check(null, 'media', '', audio), false)
    assert.equal(check(owner, 'clipboard-sanitized-write', '', { isMainFrame: true }), true)
    let allowed = false
    request(owner, 'media', value => { allowed = value }, { isMainFrame: true, mediaTypes: ['audio'], requestingUrl: url, securityOrigin: 'file://' })
    assert.equal(allowed, true)
    request(owner, 'media', value => { allowed = value }, { isMainFrame: true, mediaTypes: ['audio', 'video'], requestingUrl: url, securityOrigin: 'file://' })
    assert.equal(allowed, false)
    window.emit('blur')
    window.emit('closed')
    contents.emit('render-process-gone')
    assert.equal(stops, 3)
    let prevented = false
    contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://untrusted.invalid')
    assert.equal(prevented, true)
  })
})
