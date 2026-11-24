import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePrivateKey, parseArguments, pointerPublicationScript, rsyncArguments, shellQuote, sshConfig, upload, withSshContext } from './upload-download-update.mjs'
import { createClientRelease, RELEASE_POINTER_NAMES } from './client-release-manifest.mjs'

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

test('SSH publication switches all three metadata files and restores them on verification failure', async t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
  if (process.platform === 'win32' && !existsSync(bash)) return t.skip('Git Bash is required for shell transaction tests')
  const root = await mkdtemp(join(tmpdir(), 'sep-pointers-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const publicRoot = join(root, 'public')
  await mkdir(publicRoot)
  const posix = path => path.replaceAll('\\', '/')
  for (const mode of ['success', 'verification-failure', 'new-catalog-failure', 'partial-switch-failure', 'tampered-stage']) {
    const stage = join(root, mode), backup = join(root, mode + '-backup')
    await mkdir(stage)
    const records = []
    for (const name of RELEASE_POINTER_NAMES) {
      await writeFile(join(publicRoot, name), `old:${name}`)
      await writeFile(join(stage, name), `new:${name}`)
      records.push({ name, sha256: createHash('sha256').update(`new:${name}`).digest('hex') })
    }
    if (mode === 'new-catalog-failure') await rm(join(publicRoot, 'client-release.json'))
    if (mode === 'tampered-stage') await writeFile(join(stage, 'client-release.json'), 'tampered')
    if (mode === 'partial-switch-failure') await mkdir(join(stage, '.switch-client-release.json'))
    const script = pointerPublicationScript({ root: posix(publicRoot), stage: posix(stage), backup: posix(backup), records,
      verifyCommand: mode === 'success' ? 'true' : 'false' })
    const run = () => execFileSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 })
    if (mode === 'success') run()
    else assert.throws(run)
    for (const name of RELEASE_POINTER_NAMES) {
      if (mode === 'new-catalog-failure' && name === 'client-release.json') await assert.rejects(stat(join(publicRoot, name)), { code: 'ENOENT' })
      else assert.equal(await readFile(join(publicRoot, name), 'utf8'), `${mode === 'success' ? 'new' : 'old'}:${name}`, mode)
    }
  }
})

test('SSH uploader rejects missing, stale or mismatched metadata before accessing SSH credentials', async t => {
  const prepared = await mkdtemp(join(tmpdir(), 'sep-upload-metadata-'))
  t.after(() => rm(prepared, { recursive: true, force: true }))
  const version = '1.2.3', feed = 'https://sep.longdaoec.com/sep-client/stable/'
  const artifacts = ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe'].map(suffix => {
    const name = `SEP-Client-${version}-${suffix}`
    return { name, destination: `${version}/${name}`, url: `${feed}${version}/${name}` }
  })
  const plan = { schemaVersion: 1, channel: 'stable', version, feed, artifacts, publishLast: RELEASE_POINTER_NAMES }
  await writeFile(join(prepared, 'upload-plan.json'), JSON.stringify(plan))
  const run = () => upload({ source: prepared, prepared, channel: 'stable', env: {} })
  await assert.rejects(run, { code: 'ENOENT' })
  const catalog = createClientRelease(plan)
  await writeFile(join(prepared, 'client-release.json'), JSON.stringify({ ...catalog, version: '1.2.2' }))
  await assert.rejects(run, /catalog differs/)
  await writeFile(join(prepared, 'client-release.json'), JSON.stringify(catalog))
  const files = suffixes => suffixes.map(suffix => ({ url: `${version}/SEP-Client-${version}-${suffix}`, size: 1, sha512: Buffer.alloc(64).toString('base64') }))
  await writeFile(join(prepared, 'latest.yml'), JSON.stringify({ version, files: files(['win-x64.exe']) }))
  await writeFile(join(prepared, 'latest-mac.yml'), JSON.stringify({ version: '1.2.4', files: ['arm64', 'x64'].map(arch => ({ url: `1.2.4/SEP-Client-1.2.4-mac-${arch}.zip`, size: 1, sha512: Buffer.alloc(64).toString('base64') })) }))
  await assert.rejects(run, /versions must match/)
})
