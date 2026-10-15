import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fstatSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { main, recordReleaseBuild } from './record-release-build.mjs'
import { verifyUpdateDirectory } from './verify-update-manifest.mjs'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./record-release-build.mjs', import.meta.url))
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const VERSION = '2.3.4-beta.2'
const digest = (data, algorithm, encoding) => createHash(algorithm).update(data).digest(encoding)

async function fixture(t, { platform = 'darwin', channel = 'beta', version = VERSION, dmgReferences = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-build-record-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'dist', channel)
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ version, build: { appId: 'cn.test.sep', productName: 'SEP' } }))
  const artifacts = platform === 'darwin'
    ? ['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(ext => `SEP-Client-${version}-mac-${arch}.${ext}`))
    : [`SEP-Client-${version}-win-x64.exe`]
  for (const name of artifacts) await writeFile(join(directory, name), `artifact:${name}`)
  if (platform === 'win32') {
    await mkdir(join(directory, 'win-unpacked'))
    await writeFile(join(directory, 'win-unpacked', 'SEP.exe'), 'unpacked executable')
    await writeFile(join(directory, `${artifacts[0]}.blockmap`), 'required blockmap')
  }
  const manifestName = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  const references = artifacts.filter(name => dmgReferences || !name.endsWith('.dmg'))
  const manifest = {
    version,
    files: await Promise.all(references.map(async url => {
      const bytes = await readFile(join(directory, url))
      return { url, size: bytes.length, sha512: digest(bytes, 'sha512', 'base64') }
    })),
  }
  await writeFile(join(directory, manifestName), JSON.stringify(manifest))
  const calls = []
  const options = {
    root, platform, commit: COMMIT, env: { PRIVATE_TOKEN: 'never-in-report' },
    signatureVerifier: async (requestedChannel, supplied) => {
      calls.push({ type: 'signature', channel: requestedChannel, options: supplied })
      return {
        channel, platform, version,
        files: [...artifacts.map(name => join(directory, name)), ...(platform === 'win32' ? [join(directory, 'win-unpacked', 'SEP.exe')] : [])],
      }
    },
    manifestVerifier: async (...args) => {
      calls.push({ type: 'manifest', args })
      return verifyUpdateDirectory(...args)
    },
  }
  return { root, directory, artifacts, manifestName, manifest, options, calls, channel, record: () => recordReleaseBuild(channel, options) }
}

async function noReport(f) {
  await assert.rejects(lstat(join(f.directory, 'release-build.json')), { code: 'ENOENT' })
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.release-build-')), false)
}

for (const platform of ['darwin', 'win32']) {
  for (const channel of ['beta', 'stable']) {
    test(`${platform}/${channel}: exact report schema, streaming digests and scoped verifier calls`, async t => {
      const f = await fixture(t, { platform, channel, version: channel === 'stable' ? '2.3.4' : VERSION })
      await writeFile(join(f.directory, 'SEP-Client-1.0.0-win-x64.exe'), 'stale')
      await writeFile(join(f.directory, 'latest-linux.yml'), 'irrelevant')
      if (platform === 'darwin') await writeFile(join(f.directory, `${f.artifacts[0]}.blockmap`), 'optional blockmap')
      const result = await f.record()
      const text = await readFile(join(f.directory, 'release-build.json'), 'utf8')
      assert.deepEqual(JSON.parse(text), result)
      assert.deepEqual(Object.keys(result), ['schemaVersion', 'channel', 'version', 'commit', 'platform', 'signatureVerified', 'files'])
      assert.equal(result.schemaVersion, 1)
      assert.equal(result.channel, channel)
      assert.equal(result.version, f.manifest.version)
      assert.equal(result.commit, COMMIT)
      assert.equal(result.platform, platform)
      assert.equal(result.signatureVerified, true)
      const expected = [...f.artifacts, f.manifestName, `${f.artifacts[0]}.blockmap`].sort()
      assert.deepEqual(result.files.map(file => file.name), expected)
      for (const file of result.files) {
        const data = await readFile(join(f.directory, file.name))
        assert.deepEqual(file, { name: file.name, size: data.length, sha256: digest(data, 'sha256', 'hex'), sha512: digest(data, 'sha512', 'base64') })
      }
      assert.doesNotMatch(text, /never-in-report|win-unpacked/)
      assert.equal(text.includes(f.root), false)
      assert.deepEqual(f.calls.map(call => call.type), ['signature', 'manifest'])
      assert.equal(f.calls[0].channel, channel)
      assert.equal(f.calls[0].options.root, f.root)
      assert.equal(f.calls[0].options.platform, platform)
      assert.equal(f.calls[0].options.env, f.options.env)
      assert.deepEqual(f.calls[1].args, [f.directory, { manifestName: f.manifestName }])
    })
  }
}

test('mac manifest may reference ZIPs only; all four distribution packages remain required', async t => {
  const f = await fixture(t, { dmgReferences: false })
  for (const name of f.artifacts) await writeFile(join(f.directory, `${name}.blockmap`), `map:${name}`)
  const result = await f.record()
  assert.equal(result.files.length, 9)
})

test('mac records exactly the four packages and raw manifest when no sidecars exist', async t => {
  const f = await fixture(t)
  const result = await f.record()
  assert.deepEqual(result.files.map(file => file.name), [...f.artifacts, f.manifestName].sort())
})

for (const artifact of ['mac-x64.dmg', 'mac-x64.zip', 'mac-arm64.dmg', 'mac-arm64.zip', 'win-x64.exe']) {
  test(`never fall back to stale or other-channel packages when ${artifact} is absent`, async t => {
    const f = await fixture(t, { platform: artifact.startsWith('win') ? 'win32' : 'darwin' })
    const name = `SEP-Client-${VERSION}-${artifact}`
    await rm(join(f.directory, name))
    await writeFile(join(f.directory, name.replace(VERSION, '1.0.0')), 'stale')
    const other = join(f.root, 'dist', 'stable')
    await mkdir(other)
    await writeFile(join(other, name), 'other channel')
    await assert.rejects(f.record())
    assert.equal(f.calls.length, 0)
    await noReport(f)
  })
}

for (const commit of ['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${COMMIT}\n`, '../../secret', null]) {
  test(`reject invalid declared commit ${JSON.stringify(commit)} before verifiers`, async t => {
    const f = await fixture(t)
    f.options.commit = commit
    await assert.rejects(f.record())
    assert.equal(f.calls.length, 0)
    await noReport(f)
  })
}

test('reject unsupported platform and invalid channel before verifiers', async t => {
  const f = await fixture(t)
  await assert.rejects(recordReleaseBuild('nightly', f.options))
  await assert.rejects(recordReleaseBuild('beta', { ...f.options, platform: 'linux' }))
  assert.equal(f.calls.length, 0)
  await noReport(f)
})

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: missing or empty required file fails before signature actions`, async t => {
    const f = await fixture(t, { platform })
    const name = platform === 'darwin' ? f.artifacts[0] : `${f.artifacts[0]}.blockmap`
    await rm(join(f.directory, name))
    await assert.rejects(f.record())
    await writeFile(join(f.directory, name), '')
    await assert.rejects(f.record())
    assert.equal(f.calls.length, 0)
    await noReport(f)
  })
}

for (const target of ['artifact', 'manifest', 'package', 'optional blockmap', 'required blockmap', 'unpacked EXE', 'unpacked directory', 'directory', 'dist', 'root', 'output', 'dangling output']) {
  test(`reject ${target} symlink, including in-directory links`, async t => {
    const f = await fixture(t, { platform: target === 'required blockmap' || target.startsWith('unpacked') ? 'win32' : 'darwin' })
    let path = join(f.directory, f.artifacts[0])
    if (target === 'manifest') path = join(f.directory, f.manifestName)
    if (target === 'package') path = join(f.root, 'package.json')
    if (target.includes('blockmap')) path = join(f.directory, `${f.artifacts[0]}.blockmap`)
    if (target.includes('output')) path = join(f.directory, 'release-build.json')
    if (target === 'directory') path = f.directory
    if (target === 'dist') path = join(f.root, 'dist')
    if (target === 'root') path = f.root
    if (target === 'unpacked EXE') path = join(f.directory, 'win-unpacked', 'SEP.exe')
    if (target === 'unpacked directory') path = join(f.directory, 'win-unpacked')
    const linkTarget = `${path}.original`
    const isDirectory = ['root', 'dist', 'directory', 'unpacked directory'].includes(target)
    if (isDirectory) {
      const { rename } = await import('node:fs/promises')
      await rename(path, linkTarget)
      t.after(() => rm(linkTarget, { recursive: true, force: true }))
    } else {
      await writeFile(linkTarget, target === 'package' ? await readFile(path) : 'link target')
      await rm(path, { force: true })
    }
    await symlink(target === 'dangling output' ? `${path}.absent` : linkTarget, path, isDirectory ? 'dir' : 'file')
    await assert.rejects(f.record())
    assert.equal(f.calls.length, 0)
    if (!target.includes('output')) await noReport(f)
  })
}

for (const change of ['wrong version', 'missing arch', 'nested path', 'path traversal', 'extra artifact', 'wrong hash', 'wrong size']) {
  test(`reject manifest ${change}`, async t => {
    const f = await fixture(t)
    if (change === 'wrong version') f.manifest.version = '8.0.0'
    if (change === 'missing arch') f.manifest.files = f.manifest.files.filter(file => !file.url.includes('-arm64.'))
    if (change === 'nested path') {
      await mkdir(join(f.directory, 'nested'))
      const entry = f.manifest.files[0]
      await writeFile(join(f.directory, 'nested', entry.url), await readFile(join(f.directory, entry.url)))
      entry.url = `nested/${entry.url}`
    }
    if (change === 'extra artifact') f.manifest.files.push({ ...f.manifest.files[0], url: `SEP-Client-${VERSION}-mac-ppc.zip` })
    if (change === 'path traversal') f.manifest.files[0].url = `../${f.manifest.files[0].url}`
    if (change === 'wrong hash') f.manifest.files[0].sha512 = digest('different', 'sha512', 'base64')
    if (change === 'wrong size') f.manifest.files[0].size += 1
    await writeFile(join(f.directory, f.manifestName), JSON.stringify(f.manifest))
    await assert.rejects(f.record())
    await noReport(f)
  })
}

for (const verifier of ['signatureVerifier', 'manifestVerifier']) {
  test(`${verifier} rejection never writes a report`, async t => {
    const f = await fixture(t)
    f.options[verifier] = async () => { throw new Error('secret-token') }
    await assert.rejects(f.record())
    await noReport(f)
  })
}

test('manifest verifier result must match parsed reference set, version and digests', async t => {
  const f = await fixture(t)
  const valid = await verifyUpdateDirectory(f.directory, { manifestName: f.manifestName })
  for (const change of [
    result => { result[0].version = '8.0.0' },
    result => { result[0].files.pop() },
    result => { result[0].files[0].sha512 = digest('wrong', 'sha512', 'base64') },
    result => { result.push(result[0]) },
  ]) {
    const result = structuredClone(valid)
    change(result)
    f.options.manifestVerifier = async () => result
    await assert.rejects(f.record())
    await noReport(f)
  }
})

test('signature verifier metadata must match current channel, platform, version and checked artifacts', async t => {
  const f = await fixture(t)
  const valid = await f.options.signatureVerifier(f.channel, f.options)
  for (const change of [
    result => { result.version = '8.0.0' },
    result => { result.channel = 'stable' },
    result => { result.platform = 'win32' },
    result => { result.files.pop() },
  ]) {
    const result = structuredClone(valid)
    change(result)
    f.options.signatureVerifier = async () => result
    await assert.rejects(f.record())
    await noReport(f)
  }
})

for (const phase of ['signatureVerifier', 'manifestVerifier']) {
  test(`detect optional sidecar addition during ${phase}`, async t => {
    const f = await fixture(t)
    const original = f.options[phase]
    f.options[phase] = async (...args) => {
      const result = await original(...args)
      await writeFile(join(f.directory, `${f.artifacts[0]}.blockmap`), 'new sidecar')
      return result
    }
    await assert.rejects(f.record())
    assert.ok(f.calls.some(call => call.type === (phase === 'signatureVerifier' ? 'signature' : 'manifest')))
    await noReport(f)
  })
  for (const target of ['artifact', 'manifest', 'blockmap', 'package', 'unpacked EXE', 'replace inode', 'symlink']) {
    test(`detect ${target} mutation during ${phase}, even if verifier succeeds`, async t => {
      const f = await fixture(t, { platform: 'win32' })
      const original = f.options[phase]
      f.options[phase] = async (...args) => {
        const result = await original(...args)
        let path = join(f.directory, f.artifacts[0])
        if (target === 'manifest') path = join(f.directory, f.manifestName)
        if (target === 'blockmap') path += '.blockmap'
        if (target === 'package') path = join(f.root, 'package.json')
        if (target === 'unpacked EXE') path = join(f.directory, 'win-unpacked', 'SEP.exe')
        if (target === 'replace inode') {
          const bytes = await readFile(path)
          await rm(path)
          await writeFile(path, bytes)
        } else if (target === 'symlink') {
          await rm(path)
          await symlink(join(f.directory, `${f.artifacts[0]}.blockmap`), path)
        } else await writeFile(path, 'changed source')
        return result
      }
      await assert.rejects(f.record())
      assert.ok(f.calls.some(call => call.type === (phase === 'signatureVerifier' ? 'signature' : 'manifest')))
      await noReport(f)
    })
  }
}

for (const stage of ['initial hash', 'final hash', 'after earlier file rehash']) {
  test(`detect source mutation during ${stage} using actual file streams`, async t => {
    const f = await fixture(t, { platform: 'win32' })
    const installer = join(f.directory, f.artifacts[0])
    const watched = stage === 'after earlier file rehash' ? join(f.directory, 'win-unpacked', 'SEP.exe') : installer
    const inode = (await lstat(watched, { bigint: true })).ino
    const handle = await open(watched)
    const prototype = Object.getPrototypeOf(handle)
    const createReadStream = prototype.createReadStream
    await handle.close()
    let active = stage === 'initial hash'
    let changed = false
    const original = f.options.manifestVerifier
    f.options.manifestVerifier = async (...args) => {
      const result = await original(...args)
      active = true
      return result
    }
    t.mock.method(prototype, 'createReadStream', function (...args) {
      const stream = createReadStream.apply(this, args)
      if (active && !changed && fstatSync(this.fd, { bigint: true }).ino === inode) {
        stream.once('data', () => {
          changed = true
          writeFileSync(installer, 'changed while streaming')
        })
      }
      return stream
    })
    await assert.rejects(f.record(), /changed/)
    assert.equal(changed, true)
    await noReport(f)
  })
}

test('never overwrite an existing report, including one created by a verifier', async t => {
  const f = await fixture(t)
  const path = join(f.directory, 'release-build.json')
  await writeFile(path, 'existing report')
  await assert.rejects(f.record())
  assert.equal(f.calls.length, 0)
  assert.equal(await readFile(path, 'utf8'), 'existing report')
  await rm(path)
  const original = f.options.manifestVerifier
  f.options.manifestVerifier = async (...args) => {
    const result = await original(...args)
    await writeFile(path, 'concurrent report')
    return result
  }
  await assert.rejects(f.record())
  assert.equal(await readFile(path, 'utf8'), 'concurrent report')
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.release-build-')), false)
})

test('concurrent recorders atomically publish exactly one complete report without replacement', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([
    f.record(),
    recordReleaseBuild(f.channel, { ...f.options, commit: 'a'.repeat(40) }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  const winner = results.find(result => result.status === 'fulfilled').value
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'release-build.json'), 'utf8')), winner)
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.release-build-')), false)
})

test('reject an output symlink inserted during verification without changing its target', async t => {
  const f = await fixture(t)
  const target = join(f.directory, 'protected.json')
  await writeFile(target, 'protected contents')
  const original = f.options.manifestVerifier
  f.options.manifestVerifier = async (...args) => {
    const result = await original(...args)
    await symlink(target, join(f.directory, 'release-build.json'))
    return result
  }
  await assert.rejects(f.record())
  assert.equal(await readFile(target, 'utf8'), 'protected contents')
  assert.equal((await lstat(join(f.directory, 'release-build.json'))).isSymbolicLink(), true)
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.release-build-')), false)
})

test('CLI parses only beta|stable --commit <sha> [--root <dir>] without native actions in tests', async t => {
  const f = await fixture(t)
  const result = await main(['beta', '--commit', COMMIT, '--root', f.root], f.options)
  assert.equal(result.commit, COMMIT)
  for (const args of [[], ['beta'], ['beta', '--commit', COMMIT, '--skip-signature'], ['beta', '--commit', COMMIT, '--commit', COMMIT], ['beta', '--root'], ['beta', '--commit', COMMIT, 'extra'], ['beta', '--commit', COMMIT, '--root', f.root, '--root', f.root]]) {
    await assert.rejects(main(args, f.options))
  }
})

test('real CLI errors are static and redact hostile input and filesystem diagnostics', async t => {
  const f = await fixture(t)
  for (const args of [
    ['beta', '--commit', 'private-commit-secret'],
    ['beta', '--commit', COMMIT, '--root', join(f.root, 'private-path-secret')],
    ['beta', '--commit', COMMIT, '--skip-signature'],
  ]) {
    await assert.rejects(execute(process.execPath, [script, ...args], { env: { ...process.env, SEP_MAC_TEAM_ID: 'private-identity-secret' } }), error => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, '')
      assert.equal(error.stderr, 'Release build recording failed. Check arguments, native signatures, current artifacts, manifests, and output safety; remove an existing report explicitly before retrying.\n')
      return true
    })
  }
})

test('Windows default signature verifier still checks installer AND win-unpacked EXE', async t => {
  const f = await fixture(t, { platform: 'win32' })
  // Inject the existing verifier with a fake command runner, never real credentials/tools.
  const { verifyReleaseSignatures } = await import('./verify-release-signatures.mjs')
  f.options.signatureVerifier = verifyReleaseSignatures
  f.options.env = { SEP_WINDOWS_PUBLISHER: 'Test Publisher' }
  const checked = []
  f.options.runner = async (_command, _args, options) => {
    checked.push(options.env.SEP_SIGNATURE_FILE)
    return { stdout: JSON.stringify({ valid: true, publisherMatches: true, timestamped: true }), stderr: '' }
  }
  const result = await f.record()
  assert.deepEqual(checked, [join(f.directory, f.artifacts[0]), join(f.directory, 'win-unpacked', 'SEP.exe')])
  assert.equal(result.files.some(file => file.name.includes('win-unpacked')), false)
})

test('installers are hashed using streams, not readFile or bounded manifest buffers', async t => {
  const source = await readFile(script, 'utf8')
  assert.match(source, /createReadStream/)
  assert.doesNotMatch(source, /\breadFile\b/)
  const f = await fixture(t, { platform: 'win32' })
  const path = join(f.directory, f.artifacts[0])
  await writeFile(path, Buffer.alloc(3 * 1024 * 1024, 0x61))
  const entry = f.manifest.files[0]
  const data = await readFile(path)
  entry.size = data.length
  entry.sha512 = digest(data, 'sha512', 'base64')
  await writeFile(join(f.directory, f.manifestName), JSON.stringify(f.manifest))
  const result = await f.record()
  assert.equal(result.files.find(file => file.name === entry.url).size, data.length)
})
