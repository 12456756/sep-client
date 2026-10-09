import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readZipEntries, runCommand, validateArchiveEntries, validateMacIdentity, verifyReleaseSignatures } from './verify-release-signatures.mjs'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./verify-release-signatures.mjs', import.meta.url))
const TEAM = 'AB12CD34EF'
const VERSION = '2.3.4-beta.2'
const PRODUCT = 'SEP Test Client'
const APP_ID = 'cn.test.sep-client'
const SECRET = 'private-subprocess-token-never-log'
const ok = (stdout = '', stderr = '') => ({ stdout, stderr })
const identity = () => `Identifier=${APP_ID}\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1\nAuthority=Developer ID Application: Test Company (${TEAM})\nAuthority=Developer ID Certification Authority\nTeamIdentifier=${TEAM}\n`

async function fixture(t, { platform = 'darwin', channel = 'beta', version = VERSION, productName = PRODUCT } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sep-signature-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ version, build: { appId: APP_ID, productName } }))
  const directory = join(root, 'dist', channel)
  await mkdir(join(directory, 'win-unpacked'), { recursive: true })
  const files = platform === 'darwin'
    ? ['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(ext => join(directory, `SEP-Client-${version}-mac-${arch}.${ext}`)))
    : [join(directory, `SEP-Client-${version}-win-x64.exe`), join(directory, 'win-unpacked', `${productName}.exe`)]
  for (const file of files) await writeFile(file, 'unchanged-build-output')
  const calls = []
  const temporaries = new Set()
  const appName = `${productName}.app`
  const appArchitectures = new Map()
  async function createApp(directory, file) {
    const app = join(directory, appName)
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(app, 'Contents', 'Info.plist'), 'mock plist')
    await writeFile(join(app, 'Contents', 'MacOS', 'Client'), 'mock executable')
    appArchitectures.set(app, file.includes('-x64.') ? 'x86_64' : 'arm64')
  }
  const state = {
    entries: [`${appName}/`, `${appName}/Contents/`, `${appName}/Contents/file`],
    links: {},
    display: identity(),
    windows: { valid: true, publisherMatches: true, timestamped: true },
    intercept: async () => undefined,
  }
  const runner = async (command, args, options) => {
    const call = { command, args, options }
    calls.push(call)
    if (command.endsWith('hdiutil') && args[0] === 'attach') temporaries.add(dirname(args[args.indexOf('-mountpoint') + 1]))
    if (command.endsWith('ditto')) temporaries.add(args.at(-1))
    const override = await state.intercept(call)
    if (override !== undefined) return override
    if (command.endsWith('hdiutil') && args[0] === 'attach') {
      await createApp(args[args.indexOf('-mountpoint') + 1], args.at(-1))
    } else if (command.endsWith('ditto')) {
      await createApp(args.at(-1), args.at(-2))
    } else if (command.endsWith('unzip')) {
      if (args[0] === '-Z1') return ok(`${state.entries.join('\n')}\n`)
    } else if (command.endsWith('plutil')) {
      return ok(args[1] === 'CFBundleShortVersionString' ? `${version}\n` : 'Client\n')
    } else if (command.endsWith('lipo')) {
      return ok(`${appArchitectures.get(dirname(dirname(dirname(args.at(-1))))) || (calls.filter(c => c.command.endsWith('lipo')).length <= 2 ? 'x86_64' : 'arm64')}\n`)
    } else if (command.endsWith('codesign') && args[0] === '-dv') {
      return ok('', state.display)
    } else if (command === 'powershell.exe') {
      return ok(JSON.stringify(state.windows))
    }
    return ok()
  }
  const archiveReader = async () => state.entries.map(name => ({ name, mode: Object.hasOwn(state.links, name) ? 'l' : name.endsWith('/') ? 'd' : '-', target: state.links[name] }))
  const options = { root, platform, env: { SEP_MAC_TEAM_ID: TEAM, SEP_WINDOWS_PUBLISHER: 'Test Company' }, runner, archiveReader }
  return { root, directory, files, calls, temporaries, state, options, verify: () => verifyReleaseSignatures(channel, options) }
}

async function assertClean(f) {
  assert.ok(f.temporaries.size > 0)
  for (const temporary of f.temporaries) await assert.rejects(access(temporary))
  for (const file of f.files) assert.equal(await readFile(file, 'utf8'), 'unchanged-build-output')
}

test('macOS checks both formats and architectures, mounted/extracted apps only, with cleanup', async t => {
  const f = await fixture(t)
  await mkdir(join(f.directory, 'mac', `${PRODUCT}.app`), { recursive: true })
  const result = await f.verify()
  assert.deepEqual(result, { channel: 'beta', platform: 'darwin', version: VERSION, files: f.files })
  const attachments = f.calls.filter(c => c.command.endsWith('hdiutil') && c.args[0] === 'attach')
  assert.equal(attachments.length, 2)
  for (const call of attachments) assert.deepEqual(call.args.slice(0, 4), ['attach', '-readonly', '-nobrowse', '-mountpoint'])
  assert.equal(f.calls.filter(c => c.command.endsWith('hdiutil') && c.args[0] === 'detach').length, 2)
  const appChecks = f.calls.filter(c => c.command.endsWith('codesign') && c.args.includes('--deep'))
  assert.equal(appChecks.length, 4)
  for (const call of appChecks) {
    assert.deepEqual(call.args.slice(0, 3), ['--verify', '--deep', '--strict'])
    assert.equal(basename(call.args.at(-1)), `${PRODUCT}.app`)
    assert.ok([...f.temporaries].some(temp => call.args.at(-1).startsWith(`${temp}/`)))
  }
  assert.equal(f.calls.filter(c => c.command.endsWith('spctl') && c.args.slice(0, 3).join(' ') === '--assess --type execute').length, 4)
  const tickets = f.calls.filter(c => c.command.endsWith('xcrun'))
  assert.equal(tickets.length, 4)
  for (const call of tickets) {
    assert.deepEqual(call.args.slice(0, 2), ['stapler', 'validate'])
    assert.ok(call.args.at(-1).endsWith('.app'))
  }
  assert.equal((await lstat(join(f.directory, 'mac', `${PRODUCT}.app`))).isDirectory(), true)
  await assertClean(f)
})

test('Windows checks exact stable installer and unpacked executable using env data only', async t => {
  const f = await fixture(t, { platform: 'win32', channel: 'stable', version: '3.4.5', productName: "Test ' $(throw 1) Client" })
  f.options.env.SEP_WINDOWS_PUBLISHER = "Publisher ' ; $(throw 'injected')"
  const result = await f.verify()
  assert.equal(result.version, '3.4.5')
  assert.equal(f.calls.length, 2)
  for (const [i, call] of f.calls.entries()) {
    assert.equal(call.command, 'powershell.exe')
    assert.equal(call.options.env.SEP_SIGNATURE_FILE, f.files[i])
    assert.equal(call.options.env.SEP_SIGNATURE_PUBLISHER, f.options.env.SEP_WINDOWS_PUBLISHER)
    assert.ok(call.args.includes('-NoProfile') && call.args.includes('-NonInteractive'))
    assert.match(call.args.at(-1), /Get-AuthenticodeSignature -LiteralPath \$env:SEP_SIGNATURE_FILE/)
    assert.match(call.args.at(-1), /-ceq \$env:SEP_SIGNATURE_PUBLISHER/)
    assert.match(call.args.at(-1), /TimeStamperCertificate/)
    assert.match(call.args.at(-1), /commonNames.Count -eq 1/)
    assert.ok(!call.args.join(' ').includes(f.options.env.SEP_WINDOWS_PUBLISHER))
    assert.ok(!call.args.join(' ').includes(f.files[i]))
    assert.equal(await readFile(f.files[i], 'utf8'), 'unchanged-build-output')
  }
})

for (const platform of ['darwin', 'win32']) {
  test(`${platform} reads current package version without stale artifact fallback`, async t => {
    const f = await fixture(t, { platform })
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ version: '9.8.7', build: { appId: APP_ID, productName: PRODUCT } }))
    await assert.rejects(f.verify(), /current-version artifact/)
    assert.equal(f.calls.length, 0)
  })
  test(`${platform} does not fall back to artifacts in the other channel`, async t => {
    const f = await fixture(t, { platform })
    await assert.rejects(verifyReleaseSignatures('stable', f.options), /current-version artifact/)
    assert.equal(f.calls.length, 0)
  })
}

for (const index of [0, 1, 2, 3]) {
  test(`macOS requires artifact ${index + 1} before invoking tools`, async t => {
    const f = await fixture(t)
    await rm(f.files[index])
    await assert.rejects(f.verify(), /current-version artifact/)
    assert.equal(f.calls.length, 0)
  })
}
for (const index of [0, 1]) {
  test(`Windows requires artifact ${index + 1} before invoking tools`, async t => {
    const f = await fixture(t, { platform: 'win32' })
    await rm(f.files[index])
    await assert.rejects(f.verify(), /current-version artifact/)
    assert.equal(f.calls.length, 0)
  })
}

for (const [label, change, pattern] of [
  ['wrong app identifier', text => text.replace(APP_ID, 'cn.wrong.app'), /identifier/],
  ['wrong team', text => text.replace(`TeamIdentifier=${TEAM}`, 'TeamIdentifier=ZZZZZZZZZZ'), /team/],
  ['wrong authority', text => text.replace('Developer ID Application:', 'Apple Development:'), /authority/],
  ['missing authority', text => text.replace(/^Authority=.*\n/gm, ''), /authority/],
  ['missing team', text => text.replace(/^TeamIdentifier=.*\n/gm, ''), /team/],
  ['duplicate identifier', text => `${text}Identifier=${APP_ID}\n`, /identifier/],
  ['duplicate team', text => `${text}TeamIdentifier=${TEAM}\n`, /team/],
  ['runtime text without flag bit', text => text.replace('0x10000', '0x0'), /runtime/],
  ['missing runtime', text => text.replace(/^CodeDirectory.*\n/gm, ''), /runtime/],
]) {
  test(`macOS rejects ${label}`, () => {
    assert.throws(() => validateMacIdentity(change(identity()), { appId: APP_ID, teamId: TEAM }), pattern)
  })
}

test('hardened runtime bit accepts additional flags; DMG does not require app runtime/identifier', () => {
  validateMacIdentity(identity().replace('0x10000(runtime)', '0x10002(adhoc,runtime)'), { appId: APP_ID, teamId: TEAM })
  validateMacIdentity(identity().replace(/^CodeDirectory.*\n/gm, '').replace(APP_ID, 'disk-image'), { teamId: TEAM, requireRuntime: false })
})

for (const [key, pattern] of [['valid', /status Valid/], ['publisherMatches', /signer CN/], ['timestamped', /timestamp/]]) {
  for (const value of [false, undefined, 'true']) {
    test(`Windows fails closed for ${key}=${value}`, async t => {
      const f = await fixture(t, { platform: 'win32' })
      f.state.windows[key] = value
      await assert.rejects(f.verify(), pattern)
      assert.equal(f.calls.length, 1)
    })
  }
}

for (const [label, matches] of [
  ['DMG codesign', c => c.command.endsWith('codesign') && c.args[0] === '--verify' && c.args.at(-1).endsWith('.dmg')],
  ['app codesign', c => c.command.endsWith('codesign') && c.args.includes('--deep')],
  ['app trust', c => c.command.endsWith('spctl')],
  ['app ticket', c => c.command.endsWith('xcrun')],
  ['mount attach', c => c.command.endsWith('hdiutil') && c.args[0] === 'attach'],
  ['ZIP extraction', c => c.command.endsWith('ditto')],
  ['ZIP app trust', c => c.command.endsWith('spctl') && !c.args.at(-1).includes('/mount/')],
]) {
  test(`${label} failures hide subprocess secrets and clean allocated temporary directories`, async t => {
    const f = await fixture(t)
    f.state.intercept = async call => {
      if (matches(call)) throw Object.assign(new Error(SECRET), { stdout: SECRET, stderr: SECRET })
    }
    await assert.rejects(f.verify(), error => {
      assert.doesNotMatch(error.message, new RegExp(SECRET))
      assert.equal(error.cause, undefined)
      return true
    })
    if (f.temporaries.size) await assertClean(f)
    if (f.calls.some(c => c.command.endsWith('hdiutil') && c.args[0] === 'attach')) {
      assert.ok(f.calls.some(c => c.command.endsWith('hdiutil') && c.args[0] === 'detach'))
    }
  })
}

test('identity failure after mounting still detaches and cleans', async t => {
  const f = await fixture(t)
  f.state.intercept = async call => {
    if (call.command.endsWith('codesign') && call.args[0] === '-dv' && call.args.at(-1).endsWith('.app')) return ok('', identity().replace(APP_ID, 'wrong'))
  }
  await assert.rejects(f.verify(), /identifier/)
  assert.equal(f.calls.at(-1).args[0], 'detach')
  await assertClean(f)
})

test('failed normal detach retries force detach before deleting temporary mount', async t => {
  const f = await fixture(t)
  f.state.intercept = async call => {
    if (call.command.endsWith('hdiutil') && call.args[0] === 'detach' && !call.args.includes('-force')) throw new Error(SECRET)
  }
  await f.verify()
  assert.equal(f.calls.filter(c => c.args[0] === 'detach' && c.args.includes('-force')).length, 2)
  await assertClean(f)
})

for (const entry of ['/outside', '../outside', 'Test.app/../outside', 'C:/outside', '\\outside', 'Test.app\\..\\outside', 'Test.app//file', './Test.app/file', 'Test.app/file\0', 'Test.app/file\r']) {
  test(`ZIP rejects malicious entry ${JSON.stringify(entry)} before extraction`, async t => {
    const f = await fixture(t)
    f.state.entries.push(entry)
    await assert.rejects(f.verify(), /ZIP/)
    assert.ok(!f.calls.some(c => c.command.endsWith('ditto')))
    await assertClean(f)
  })
}

test('ZIP rejects duplicate and case-colliding entry names', () => {
  for (const text of ['Test.app/\nTest.app/\n', 'Test.app/file\nTest.app/FILE\n', 'Test.app/caf\u00e9\nTest.app/cafe\u0301\n']) assert.throws(() => validateArchiveEntries(text), /colliding/)
})

for (const target of ['/outside', '../../outside', '../Contents/link', 'bad\0target', 'C:\\outside']) {
  test(`ZIP rejects escaping/cyclic symbolic link ${JSON.stringify(target)}`, async t => {
    const f = await fixture(t)
    const link = `${PRODUCT}.app/Contents/link`
    f.state.entries.push(link)
    f.state.links[link] = target
    await assert.rejects(f.verify(), /ZIP/)
    assert.ok(!f.calls.some(c => c.command.endsWith('ditto')))
    await assertClean(f)
  })
}

test('ZIP resolves symlinks before parent traversal, not lexical normalization', async t => {
  const f = await fixture(t)
  f.state.links = { [`${PRODUCT}.app/Contents/up`]: '..', [`${PRODUCT}.app/Contents/escape`]: 'up/../outside' }
  f.state.entries.push(...Object.keys(f.state.links))
  await assert.rejects(f.verify(), /escapes/)
  assert.ok(!f.calls.some(c => c.command.endsWith('ditto')))
})

test('ZIP symlink pivots are rejected on case-insensitive filesystems too', async t => {
  const f = await fixture(t)
  f.state.links = { [`${PRODUCT}.app/Contents/UP`]: '..', [`${PRODUCT}.app/Contents/escape`]: 'up/../outside' }
  f.state.entries.push(...Object.keys(f.state.links))
  await assert.rejects(f.verify(), /escapes/)
  assert.ok(!f.calls.some(c => c.command.endsWith('ditto')))
})

for (const [label, command, key, output, pattern] of [
  ['stale bundle version', 'plutil', 'CFBundleShortVersionString', '0.0.1\n', /bundle version/],
  ['unsafe bundle executable', 'plutil', 'CFBundleExecutable', '../../outside\n', /executable name/],
  ['wrong executable architecture', 'lipo', '-archs', 'arm64\n', /architecture/],
  ['universal executable in a per-arch artifact', 'lipo', '-archs', 'x86_64 arm64\n', /architecture/],
]) {
  test(`macOS rejects ${label} and detaches`, async t => {
    const f = await fixture(t)
    f.state.intercept = async call => call.command.endsWith(command) && call.args.includes(key) ? ok(output) : undefined
    await assert.rejects(f.verify(), pattern)
    assert.equal(f.calls.at(-1).args[0], 'detach')
    await assertClean(f)
  })
}

test('post-extraction bundle containment rejects an escaping internal symlink', async t => {
  const f = await fixture(t)
  f.state.intercept = async call => {
    if (call.command.endsWith('ditto')) {
      const app = join(call.args.at(-1), `${PRODUCT}.app`)
      await mkdir(join(app, 'Contents'), { recursive: true })
      await symlink(f.directory, join(app, 'Contents', 'escape'))
      return ok()
    }
  }
  await assert.rejects(f.verify(), /escapes its bundle/)
  await assertClean(f)
})

test('ZIP accepts contained framework-style relative symbolic links', async t => {
  const f = await fixture(t)
  f.state.links = { [`${PRODUCT}.app/Contents/link`]: 'file' }
  f.state.entries.push(...Object.keys(f.state.links))
  await f.verify()
  await assertClean(f)
})

test('ZIP missing its own app never uses the sibling build bundle', async t => {
  const f = await fixture(t)
  await mkdir(join(f.directory, 'mac', `${PRODUCT}.app`), { recursive: true })
  f.state.intercept = async call => call.command.endsWith('ditto') ? ok() : undefined
  await assert.rejects(f.verify(), /packaged application/)
  await assertClean(f)
})

test('ZIP rejects app-root symlink after extraction', async t => {
  const f = await fixture(t)
  const sibling = join(f.directory, `${PRODUCT}.app`)
  await mkdir(sibling)
  f.state.intercept = async call => {
    if (call.command.endsWith('ditto')) {
      await symlink(sibling, join(call.args.at(-1), `${PRODUCT}.app`))
      return ok()
    }
  }
  await assert.rejects(f.verify(), /packaged application/)
  await assertClean(f)
  assert.equal((await lstat(sibling)).isDirectory(), true)
})

test('artifact symlinks cannot substitute different build outputs', async t => {
  const f = await fixture(t)
  await rm(f.files[0])
  await symlink(f.files[1], f.files[0])
  await assert.rejects(f.verify(), /unsafe/)
  assert.equal(f.calls.length, 0)
})

test('unsupported hosts, bad channels, mismatched channel env and missing/invalid identities fail closed', async t => {
  const f = await fixture(t)
  await assert.rejects(verifyReleaseSignatures('beta', { ...f.options, platform: 'linux' }), /macOS or Windows/)
  await assert.rejects(verifyReleaseSignatures('../stable', f.options), /channel/)
  await assert.rejects(verifyReleaseSignatures('beta', { ...f.options, env: { ...f.options.env, SEP_RELEASE_CHANNEL: 'stable' } }), /conflicts/)
  for (const team of [undefined, '', 'abc123def4', 'ABCDE1234', 'ABCDE123456', 'ABCDE-2345', `${TEAM}\n`]) {
    await assert.rejects(verifyReleaseSignatures('beta', { ...f.options, env: { SEP_MAC_TEAM_ID: team } }), /SEP_MAC_TEAM_ID/)
  }
  for (const publisher of [undefined, '', ' ', 'private\nsecret']) {
    await assert.rejects(verifyReleaseSignatures('beta', { ...f.options, platform: 'win32', env: { SEP_WINDOWS_PUBLISHER: publisher } }), /SEP_WINDOWS_PUBLISHER/)
  }
  assert.equal(f.calls.length, 0)
})

test('invalid package metadata is rejected without executing native tools', async t => {
  const f = await fixture(t)
  for (const pkg of [null, {}, { version: '../secret' }, { version: VERSION, build: { appId: '../secret', productName: PRODUCT } }, { version: VERSION, build: { appId: APP_ID, productName: '../secret' } }]) {
    await writeFile(join(f.root, 'package.json'), JSON.stringify(pkg))
    await assert.rejects(f.verify())
  }
  await writeFile(join(f.root, 'package.json'), SECRET)
  await assert.rejects(f.verify(), /cannot read current package.json/)
  assert.equal(f.calls.length, 0)
})

test('malformed/nonzero runner responses and Windows output do not leak diagnostics', async t => {
  const f = await fixture(t, { platform: 'win32' })
  for (const response of [ok(SECRET, SECRET), { code: 1, stdout: SECRET, stderr: SECRET }, { signal: 'SIGTERM', stdout: SECRET, stderr: SECRET }, undefined, {}]) {
    f.options.runner = async () => response
    await assert.rejects(f.verify(), error => {
      assert.doesNotMatch(error.message, new RegExp(SECRET))
      assert.equal(error.cause, undefined)
      return true
    })
  }
})

test('CLI fails closed with sanitized stderr, including incorrect argument count', async t => {
  const f = await fixture(t)
  for (const args of [[], ['invalid-channel'], ['beta', 'extra'], ['beta']]) {
    await assert.rejects(execute(process.execPath, [script, ...args], { cwd: f.root, env: { ...process.env, SEP_MAC_TEAM_ID: SECRET, SEP_WINDOWS_PUBLISHER: '' } }), error => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, '')
      assert.match(error.stderr, /Native release signature verification failed/)
      assert.doesNotMatch(error.stderr, new RegExp(SECRET))
      return true
    })
  }
})

test('default runner captures output without shell expansion', async () => {
  const value = "$(echo unsafe); ' private"
  assert.equal((await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value], { env: process.env })).stdout, value)
})

test('installed macOS ZIP tools support the preflight and contained symlinks with Unicode product names', { skip: process.platform !== 'darwin', timeout: 10_000 }, async t => {
  const f = await fixture(t, { productName: '\u7845\u57fa\u5458\u5de5\u5e73\u53f0' })
  const app = join(f.root, '\u7845\u57fa\u5458\u5de5\u5e73\u53f0.app')
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(app, 'Contents', 'Info.plist'), 'mock plist')
  await writeFile(join(app, 'Contents', 'MacOS', 'Client'), 'mock executable')
  await writeFile(join(app, 'Contents/file'), 'test')
  await symlink('file', join(app, 'Contents/link'))
  for (const file of f.files.filter(name => name.endsWith('.zip'))) {
    await rm(file)
    await runCommand('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, file], { env: process.env })
  }
  const mocked = f.options.runner
  f.options.archiveReader = readZipEntries
  f.options.runner = async (command, args, options) => {
    if (command.endsWith('ditto')) f.temporaries.add(args.at(-1))
    return command.endsWith('unzip') || command.endsWith('ditto') ? runCommand(command, args, options) : mocked(command, args, options)
  }
  await f.verify()
  for (const temporary of f.temporaries) await assert.rejects(access(temporary))
})

test('installed ZIP reader exposes actual escaping symlink targets before extraction', { skip: process.platform !== 'darwin', timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const app = join(f.root, `${PRODUCT}.app`)
  await mkdir(join(app, 'Contents'), { recursive: true })
  await symlink('/outside', join(app, 'Contents', 'escape'))
  const zip = f.files.find(name => name.endsWith('.zip'))
  await rm(zip)
  await runCommand('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip], { env: process.env })
  const records = await readZipEntries(zip)
  const link = records.find(record => record.mode === 'l')
  assert.equal(link.name, `${PRODUCT}.app/Contents/escape`)
  assert.equal(link.target, '/outside')
  f.options.archiveReader = readZipEntries
  const mocked = f.options.runner
  f.options.runner = async (command, args, options) => command.endsWith('unzip') ? runCommand(command, args, options) : mocked(command, args, options)
  await assert.rejects(f.verify(), /unsafe symbolic link/)
  assert.ok(!f.calls.some(c => c.command.endsWith('ditto')))
})

test('invalid ZIP parser errors are sanitized', async t => {
  const f = await fixture(t)
  await assert.rejects(readZipEntries(f.files[1]), error => {
    assert.match(error.message, /ZIP metadata/)
    assert.ok(!error.message.includes(f.root))
    assert.equal(error.cause, undefined)
    return true
  })
})

test('ZIP reader caps aggregate declared uncompressed size before extraction', { skip: process.platform !== 'darwin', timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const app = join(f.root, `${PRODUCT}.app`)
  await mkdir(app)
  await writeFile(join(app, 'payload'), 'more than one byte')
  const zip = f.files[1]
  await rm(zip)
  await runCommand('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip], { env: process.env })
  await assert.rejects(readZipEntries(zip, { maxUncompressedBytes: 1 }), /^Error: ZIP metadata or symbolic link inspection failed$/)
  assert.ok((await readZipEntries(zip)).length > 0)
})
