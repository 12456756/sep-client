import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { resolveNotificationAction } from './notification-action'

it('only opens notification links on the trusted SEP web origin', () => {
  const base = 'https://sep.example.com'
  assert.equal(resolveNotificationAction('/subscriptions/requests/request_1', base), base + '/subscriptions/requests/request_1')
  assert.equal(resolveNotificationAction(base + '/wallet', base), base + '/wallet')
  for (const url of ['https://evil.example/phish', '//evil.example', 'javascript:alert(1)', 'file:///tmp/secret', 'https://user:pass@sep.example.com/wallet', '/api/client/auth/logout', '/wallet?accessToken=secret', '/wallet\n']) {
    assert.throws(() => resolveNotificationAction(url, base))
  }
})
