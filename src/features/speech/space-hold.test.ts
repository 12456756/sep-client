import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SpaceHold } from './space-hold'

function fixture() {
  const events: string[] = []
  let fire: (() => void) | undefined
  const hold = new SpaceHold({
    insertSpace: () => events.push('space'), start: () => events.push('start'), stop: () => events.push('stop'), cancel: () => events.push('cancel'),
    schedule: callback => { fire = callback; return () => { fire = undefined } },
  })
  return { hold, events, long: () => fire?.() }
}

describe('focused-input Space hold gesture', () => {
  it('short presses insert exactly one space', () => {
    const f = fixture()
    assert.equal(f.hold.down({ code: 'Space' }), true)
    f.hold.up('Space')
    assert.deepEqual(f.events, ['space'])
  })
  it('long holds start once and release stops without adding spaces', () => {
    const f = fixture()
    f.hold.down({ code: 'Space' })
    f.long()
    f.hold.down({ code: 'Space', repeat: true })
    f.hold.up('Space')
    assert.deepEqual(f.events, ['start', 'stop'])
  })
  it('leaves IME candidate selection and modified shortcuts alone', () => {
    const f = fixture()
    assert.equal(f.hold.down({ code: 'Space', isComposing: true }), false)
    assert.equal(f.hold.down({ code: 'Space', ctrlKey: true }), false)
    assert.equal(f.hold.down({ code: 'Space', shiftKey: true }), false)
    f.long()
    assert.deepEqual(f.events, [])
  })
  it('flushes pending space before subsequent ordinary typing', () => {
    const f = fixture()
    f.hold.down({ code: 'Space' })
    assert.equal(f.hold.down({ code: 'KeyA' }), false)
    f.hold.up('Space')
    assert.deepEqual(f.events, ['space'])
  })
  it('cancels on blur and never starts from an abandoned timer', () => {
    const f = fixture()
    f.hold.down({ code: 'Space' })
    f.hold.reset()
    f.long()
    assert.deepEqual(f.events, [])
    f.hold.down({ code: 'Space' })
    f.long()
    f.hold.reset()
    assert.deepEqual(f.events, ['start', 'cancel'])
  })
})
