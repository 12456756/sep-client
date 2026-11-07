import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePrivateKey, parseArguments, shellQuote, sshConfig } from './upload-download-update.mjs'

test('upload CLI accepts exactly source, prepared directory and stable channel', () => {
  assert.deepEqual(parseArguments(['source', 'prepared', 'stable']), { source: 'source', prepared: 'prepared', channel: 'stable' })
  for (const args of [[], ['source'], ['source', 'prepared'], ['source', 'prepared', 'beta'], ['--source', 'prepared', 'stable']]) {
    assert.throws(() => parseArguments(args), /usage/)
  }
})

test('remote shell quoting preserves apostrophes as data', () => {
  assert.equal(shellQuote("/tmp/it's-safe"), "'/tmp/it'\\''s-safe'")
  assert.throws(() => shellQuote(''), /invalid remote path/)
  assert.throws(() => shellQuote('bad\0path'), /invalid remote path/)
})

test('SSH config pins one identity and host key policy for both ssh and rsync', () => {
  const config = sshConfig({
    host: '121.37.128.126', user: 'root', port: '22',
    key: '/tmp/sep-client-upload/id_ed25519', knownHosts: '/tmp/sep-client-upload/known_hosts',
  })
  assert.match(config, /^HostName 121\.37\.128\.126$/m)
  assert.match(config, /^User root$/m)
  assert.match(config, /^Port 22$/m)
  assert.match(config, /^IdentityFile \/tmp\/sep-client-upload\/id_ed25519$/m)
  assert.match(config, /^IdentitiesOnly yes$/m)
  assert.match(config, /^StrictHostKeyChecking yes$/m)
  assert.match(config, /^UserKnownHostsFile \/tmp\/sep-client-upload\/known_hosts$/m)
})

test('private key is restored from canonical base64 without altering OpenSSH line breaks', () => {
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nYWJjZA==\n-----END OPENSSH PRIVATE KEY-----\n'
  assert.equal(decodePrivateKey({ SEP_UPLOAD_SSH_KEY_BASE64: Buffer.from(privateKey).toString('base64') }), privateKey)
  assert.throws(() => decodePrivateKey({ SEP_UPLOAD_SSH_KEY_BASE64: 'not-base64!' }), /valid base64/)
  assert.throws(() => decodePrivateKey({ SEP_UPLOAD_SSH_KEY_BASE64: Buffer.from('not a private key').toString('base64') }), /private key/)
})
