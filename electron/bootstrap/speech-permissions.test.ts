import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { BrowserWindow, Session, WebContents } from 'electron'
import { installSpeechPermissions } from './speech-permissions'

describe('speech media permission boundary', () => {
  it('permits trusted main-frame fullscreen, clipboard writes and authorized audio', () => {
    let check!: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
    let request!: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
    let enabled = false
    let stops = 0
    let blurStops = 0
    const url = 'file:///trusted/index.html'
    let currentUrl = url
    let destroyed = false
    const contents = Object.assign(new EventEmitter(), { getURL: () => currentUrl, session: {
      setPermissionCheckHandler: (callback: typeof check) => { check = callback },
      setPermissionRequestHandler: (callback: typeof request) => { request = callback },
    } })
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, webContents: contents })
    installSpeechPermissions(window as unknown as BrowserWindow, url, {
      canUseMicrophone: () => enabled,
      stop: () => { stops++ },
      stopForWindowBlur: () => { blurStops++ },
    })
    const owner = contents as unknown as WebContents
    const audio = { isMainFrame: true, mediaType: 'audio' } as const
    const fullscreen = { isMainFrame: true, requestingUrl: url, securityOrigin: 'file://' }
    const other = { getURL: () => url } as WebContents
    let fullscreenAllowed = false
    request(owner, 'fullscreen', value => { fullscreenAllowed = value }, fullscreen)
    assert.equal(fullscreenAllowed, true, 'fullscreen must work without enabling the microphone')
    assert.equal(check(owner, 'fullscreen', '', { isMainFrame: true }), true)
    assert.equal(check(null, 'fullscreen', '', { isMainFrame: true }), false)
    assert.equal(check(other, 'fullscreen', '', { isMainFrame: true }), false)
    request(other, 'fullscreen', value => { fullscreenAllowed = value }, fullscreen)
    assert.equal(fullscreenAllowed, false)
    assert.equal(check(owner, 'fullscreen', '', { isMainFrame: false }), false)
    request(owner, 'fullscreen', value => { fullscreenAllowed = value }, { ...fullscreen, isMainFrame: false })
    assert.equal(fullscreenAllowed, false)
    currentUrl = 'https://untrusted.invalid'
    assert.equal(check(owner, 'fullscreen', '', { isMainFrame: true }), false)
    request(owner, 'fullscreen', value => { fullscreenAllowed = value }, fullscreen)
    assert.equal(fullscreenAllowed, false)
    currentUrl = url
    destroyed = true
    assert.equal(check(owner, 'fullscreen', '', { isMainFrame: true }), false)
    request(owner, 'fullscreen', value => { fullscreenAllowed = value }, fullscreen)
    assert.equal(fullscreenAllowed, false)
    destroyed = false
    assert.equal(check(owner, 'notifications', '', { isMainFrame: true }), false)
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
    assert.equal(blurStops, 1)
    assert.equal(stops, 2)
    let prevented = false
    contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://untrusted.invalid')
    assert.equal(prevented, true)
  })
})
