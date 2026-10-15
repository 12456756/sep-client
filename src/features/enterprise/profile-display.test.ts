import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { displayedEnterpriseLogo, displayedUserAvatar } from './profile-display'

const initialAvatar = { name: '刘凌', avatar: 'https://example.com/login-avatar.png' }

const profile = {
  user: { id: 'u1', email: 'u@example.com', name: '刘凌', avatar: null, role: 'USER' },
  enterprise: { id: 'e1', name: '数易', logo: null },
}

describe('profile display precedence', () => {
  it('does not reuse a stale organization avatar after profile explicitly returns null', () => {
    assert.deepEqual(displayedUserAvatar(profile, initialAvatar, '登录用户'), {
      name: '刘凌',
      avatar: null,
    })
  })

  it('uses the temporary login avatar only until profile has loaded', () => {
    assert.deepEqual(displayedUserAvatar(null, initialAvatar, '登录用户'), initialAvatar)
  })

  it('does not reuse an organization logo after profile explicitly returns null', () => {
    assert.equal(displayedEnterpriseLogo(profile, 'https://example.com/organization-logo.png'), null)
    assert.equal(displayedEnterpriseLogo(null, 'https://example.com/organization-logo.png'), 'https://example.com/organization-logo.png')
  })
})
