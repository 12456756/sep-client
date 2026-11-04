import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { acceptedScopeHash, challengeMessage, consentHash, generateDeviceKeyPair, signChallenge, verifyChallenge } from './skill-import'

test('normalizes consent and scope hashes', () => {
  assert.equal(consentHash(true, 'user', ['root_b', 'root_a', 'root_a']), consentHash(true, 'user', ['root_a', 'root_b']))
  assert.notEqual(consentHash(true, 'user', ['root_a']), acceptedScopeHash('user', ['root_a']))
})

test('signs and verifies the canonical challenge', () => {
  const pair = generateDeviceKeyPair()
  const challenge = { purpose: 'session-grant' as const, instanceId: 'sep-default', sessionId: 'session_1', pairingId: 'pairing_1', deviceId: null, keyFingerprint: pair.keyFingerprint, challengeId: 'challenge_1', nonce: 'nonce_nonce_nonce', expiresAt: '2026-11-03T10:00:00.000Z' }
  const signature = signChallenge(pair.privateKey, challenge, consentHash(false, 'user', ['root_a']))
  assert.equal(verifyChallenge(pair.publicKey, signature, challenge, consentHash(false, 'user', ['root_a'])), true)
  assert.equal(verifyChallenge(pair.publicKey, signature, challenge, consentHash(false, 'project', ['root_a'])), false)
  assert.equal(challengeMessage(challenge, 'x').toString('utf8').startsWith('["SEP-SKILL-IMPORT",1,"session-grant"'), true)
})
