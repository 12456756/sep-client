import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, stat } from 'node:fs/promises'
import { decodePrivateKey, parseArguments, rsyncArguments, shellQuote, sshConfig, withSshContext } from './upload-download-update.mjs'

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

test('rsync uses the SSH config without passing the host alias as a remote command', () => {
  const args = rsyncArguments({ config: '/tmp/sep-client-upload/ssh_config' }, '/tmp/client.zip', '/tmp/staging/client.zip')
  assert.deepEqual(args, [
    '--archive', '--checksum', '--protect-args', '-e', 'ssh -F \'/tmp/sep-client-upload/ssh_config\'',
    '/tmp/client.zip', 'sep-upload:/tmp/staging/client.zip',
  ])
})

test('private key is restored from canonical base64 without altering OpenSSH line breaks', () => {
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nYWJjZA==\n-----END OPENSSH PRIVATE KEY-----\n'
  assert.equal(decodePrivateKey({ SEP_UPLOAD_SSH_KEY_BASE64: Buffer.from(privateKey).toString('base64') }), privateKey)
  assert.throws(() => decodePrivateKey({ SEP_UPLOAD_SSH_KEY_BASE64: 'not-base64!' }), /valid base64/)
  assert.throws(() => decodePrivateKey({ SEP_UPLOAD_SSH_KEY_BASE64: Buffer.from('not a private key').toString('base64') }), /private key/)
})

test('both transfer methods get the pinned SSH configuration and credentials are removed after success or failure', async () => {
  const env = { SEP_UPLOAD_HOST: 'example.com', SEP_UPLOAD_USER: 'root', SEP_UPLOAD_ROOT: '/tmp/public', SEP_UPLOAD_KNOWN_HOSTS: 'example.com ssh-ed25519 fixture', SEP_UPLOAD_SSH_KEY_BASE64: Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n').toString('base64') }
  let key
  const check = async context => {
    key = context.key
    assert.equal(context.root, env.SEP_UPLOAD_ROOT)
    assert((await readFile(context.config, 'utf8')).includes('StrictHostKeyChecking yes'))
    assert.equal(await readFile(context.knownHosts, 'utf8'), env.SEP_UPLOAD_KNOWN_HOSTS)
  }
  await withSshContext(env, check)
  await assert.rejects(stat(key), { code: 'ENOENT' })
  await assert.rejects(withSshContext(env, async context => { await check(context); throw new Error('callback failure') }), /callback failure/)
  await assert.rejects(stat(key), { code: 'ENOENT' })
  for (const override of [{ SEP_UPLOAD_HOST: 'bad\nhost' }, { SEP_UPLOAD_USER: 'bad user' }, { SEP_UPLOAD_ROOT: '/' }, { SEP_UPLOAD_PORT: '99999' }]) {
    await assert.rejects(withSshContext({ ...env, ...override }, () => assert.fail('unsafe SSH configuration accepted')))
  }
})
