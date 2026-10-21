import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSubmitEnter } from './composer-shortcut'

const enter = {
  key: 'Enter', shiftKey: false, repeat: false, defaultPrevented: false,
  nativeEvent: { isComposing: false, keyCode: 13 },
}

describe('composer send shortcut', () => {
  it('sends with Enter', () => {
    assert.equal(isSubmitEnter(enter), true)
  })

  it('leaves Shift+Enter and other keys for editing', () => {
    assert.equal(isSubmitEnter({ ...enter, shiftKey: true }), false)
    assert.equal(isSubmitEnter({ ...enter, key: ' ' }), false)
  })

  it('does not send while selecting IME candidates', () => {
    assert.equal(isSubmitEnter({ ...enter, nativeEvent: { isComposing: true, keyCode: 13 } }), false)
    assert.equal(isSubmitEnter({ ...enter, nativeEvent: { isComposing: false, keyCode: 229 } }), false)
  })

  it('does not resend for held keys or already handled events', () => {
    assert.equal(isSubmitEnter({ ...enter, repeat: true }), false)
    assert.equal(isSubmitEnter({ ...enter, defaultPrevented: true }), false)
  })
})
