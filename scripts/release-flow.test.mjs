import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { buildReleasePlan, collectRelease, copyReleaseFile, hashReleaseFile, validateReleaseIdentity } from './release-plan.mjs'
import { initializeFixture, publishLocal, rollbackLocal, recoverLocal } from './local-release-store.mjs'
import { verifyUpdateFeed } from './test-update-feed.mjs'

const commit = 'a'.repeat(40)
const digest = (data, algorithm, encoding = 'hex') => createHash(algorithm).update(data).digest(encoding)
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'sep-release-flow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function bundle(t, version = '0.1.3', channel = 'beta') {
  const root = await temporary(t)
  const directory = join(root, 'bundle')
  await mkdir(directory)
  const contents = new Map()
  const add = async (name, data) => {
    const bytes = Buffer.from(data)
    contents.set(name, bytes)
    await writeFile(join(directory, name), bytes)
  }
  const prefix = `SEP-Client-${version}`
  for (const suffix of ['win-x64.exe', 'mac-arm64.zip', 'mac-x64.zip', 'mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe.blockmap']) {
    await add(`${prefix}-${suffix}`, `fixture:${channel}:${version}:${suffix}`)
  }
  for (const [name, suffixes] of [['latest.yml', ['win-x64.exe']], ['latest-mac.yml', ['mac-arm64.zip', 'mac-x64.zip']]]) {
    await add(name, yaml.dump({ version, files: suffixes.map(suffix => {
      const name = `${prefix}-${suffix}`
      const bytes = contents.get(name)
      return { url: name, size: bytes.length, sha512: digest(bytes, 'sha512', 'base64') }
    }) }))
  }
  const descriptor = name => ({ name, size: contents.get(name).length, sha256: digest(contents.get(name), 'sha256'), sha512: digest(contents.get(name), 'sha512', 'base64') })
  const receipts = ['darwin', 'win32'].map(platform => ({
    schemaVersion: 1, channel, version, commit, platform, signatureVerified: false,
    files: [...contents.keys()].filter(name => platform === 'darwin' ? name.includes('-mac-') || name === 'latest-mac.yml' : name.includes('-win-') || name === 'latest.yml').map(descriptor),
  }))
  await add('release-builds.json', JSON.stringify(receipts))
  await add(`RELEASE-NOTES-${channel}.md`, `# SEP Client ${version} (${channel})\n\nFixture only.\n`)
  await add('SHA256SUMS.txt', [...contents.keys()].filter(name => /\.(exe|zip|dmg)(\.blockmap)?$/.test(name)).sort().map(name => `${digest(contents.get(name), 'sha256')}  ${name}\n`).join(''))
  return { root, directory, contents, receipts, descriptor, version, channel }
}
const options = b => ({ directory: b.directory, channel: b.channel, version: b.version, commit })
test('release identity accepts canonical build metadata but rejects invalid stable prereleases', () => {
  assert.doesNotThrow(() => validateReleaseIdentity({ channel: 'stable', version: '1.2.3+build.1', commit }))
  for (const version of ['v1.2.3', '01.2.3', '1.2.3-01', '1.2.3-beta.1']) {
    assert.throws(() => validateReleaseIdentity({ channel: 'stable', version, commit }))
  }
})
async function fixture(t) {
  const root = await temporary(t)
  const directory = join(root, 'feed')
  await initializeFixture(directory)
  return directory
}
async function feedState(directory, channel = 'beta') {
  const result = {}
  for (const name of ['latest.yml', 'latest-mac.yml', 'SHA256SUMS.txt', `RELEASE-NOTES-${channel}.md`]) {
    try { result[name] = await readFile(join(directory, channel, name), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return result
}
async function nativeInputs(b) {
  const mac = join(b.root, 'mac')
  const win = join(b.root, 'win')
  for (const [index, directory] of [mac, win].entries()) {
    await mkdir(directory)
    for (const entry of b.receipts[index].files) await writeFile(join(directory, entry.name), b.contents.get(entry.name))
    await writeFile(join(directory, 'release-build.json'), JSON.stringify(b.receipts[index]))
  }
  return { channel: b.channel, version: b.version, commit, mac, win, output: join(b.root, 'collected') }
}
const recordPath = (feed, record) => join(feed, '.release-state', record.channel, 'records', `${record.id}.json`)

test('plan is read-only, binds commit and both build receipts, and orders manifests last', async t => {
  const b = await bundle(t)
  const before = await readdir(b.directory)
  const plan = await buildReleasePlan(options(b))
  assert.equal(plan.releaseApproved, false)
  assert.equal(plan.mode, 'local-rehearsal')
  assert.equal(plan.commit, commit)
  assert.equal(plan.files.length, 11)
  assert.deepEqual(plan.files.slice(-2).map(file => file.name), ['latest.yml', 'latest-mac.yml'])
  assert.ok(plan.files.every(file => file.sha256 && file.sha512 && file.size > 0))
  assert.ok(!JSON.stringify(plan).includes(b.root))
  assert.deepEqual(await readdir(b.directory), before)
})
for (const name of ['SEP-Client-0.1.3-mac-arm64.dmg', 'SEP-Client-0.1.3-mac-x64.zip', 'SEP-Client-0.1.3-win-x64.exe.blockmap', 'latest.yml', 'release-builds.json']) {
  test(`plan rejects incomplete bundle: ${name}`, async t => {
    const b = await bundle(t)
    await rm(join(b.directory, name))
    await assert.rejects(buildReleasePlan(options(b)))
  })
}
test('plan rejects source symlinks, stale installers, invalid metadata and hash tampering', async t => {
  const b = await bundle(t)
  const name = 'SEP-Client-0.1.3-win-x64.exe'
  await writeFile(join(b.directory, name), 'corrupted')
  await assert.rejects(buildReleasePlan(options(b)))
  await writeFile(join(b.directory, name), b.contents.get(name))
  await writeFile(join(b.directory, 'SEP-Client-0.1.2-win-x64.exe'), 'stale')
  await assert.rejects(buildReleasePlan(options(b)), /unexpected|stale/)
  await rm(join(b.directory, 'SEP-Client-0.1.2-win-x64.exe'))
  await rm(join(b.directory, name))
  await symlink(join(b.root, 'outside.exe'), join(b.directory, name))
  await writeFile(join(b.root, 'outside.exe'), b.contents.get(name))
  await assert.rejects(buildReleasePlan(options(b)), /symbolic|regular/)
})
for (const mutation of [
  receipts => { receipts[0].commit = 'b'.repeat(40) },
  receipts => { receipts[0].channel = 'stable' },
  receipts => { receipts[1].version = '0.1.2' },
  receipts => { receipts[0].files[0].sha256 = '0'.repeat(64) },
  receipts => { receipts[0].files.push(receipts[0].files[0]) },
  receipts => { receipts[0].files[0].name = '../outside' },
  receipts => { receipts.pop() },
]) {
  test('plan rejects conflicting provenance or unsafe receipts', async t => {
    const b = await bundle(t)
    mutation(b.receipts)
    await writeFile(join(b.directory, 'release-builds.json'), JSON.stringify(b.receipts))
    await assert.rejects(buildReleasePlan(options(b)))
  })
}
test('collector creates a fresh complete bundle and refuses output reuse', async t => {
  const b = await bundle(t)
  const mac = join(b.root, 'mac')
  const win = join(b.root, 'win')
  for (const [index, directory] of [mac, win].entries()) {
    await mkdir(directory)
    for (const entry of b.receipts[index].files) await writeFile(join(directory, entry.name), b.contents.get(entry.name))
    await writeFile(join(directory, 'release-build.json'), JSON.stringify(b.receipts[index]))
  }
  const output = join(b.root, 'collected')
  const plan = await collectRelease({ channel: b.channel, version: b.version, commit, mac, win, output })
  assert.equal(plan.releaseApproved, false)
  assert.equal(plan.files.length, 11)
  await assert.rejects(collectRelease({ channel: b.channel, version: b.version, commit, mac, win, output }), /exist/)
  b.receipts[1].commit = 'b'.repeat(40)
  await writeFile(join(win, 'release-build.json'), JSON.stringify(b.receipts[1]))
  await assert.rejects(collectRelease({ channel: b.channel, version: b.version, commit, mac, win, output: join(b.root, 'invalid') }))
  assert.ok(!(await readdir(b.root)).includes('invalid'))
})
test('local publish requires an explicit marked fixture and supports independent channels', async t => {
  const b = await bundle(t)
  await assert.rejects(publishLocal({ ...options(b), fixture: b.root }), /fixture/)
  const feed = await fixture(t)
  const record = await publishLocal({ ...options(b), fixture: feed })
  assert.equal(record.status, 'published-local')
  assert.equal(record.releaseApproved, false)
  assert.equal(yaml.load((await feedState(feed))['latest.yml']).version, b.version)
  const stable = await bundle(t, '0.1.3', 'stable')
  await publishLocal({ ...options(stable), fixture: feed })
  assert.equal(yaml.load((await feedState(feed, 'stable'))['latest.yml']).version, stable.version)
})
test('publish streams immutable installers before any visible manifest and checks post-copy hashes', async t => {
  const b = await bundle(t)
  const feed = await fixture(t)
  const events = []
  await publishLocal({ ...options(b), fixture: feed, hook: async (event, name) => {
    events.push([event, name])
    if (event === 'before-manifest') {
      for (const file of b.receipts.flatMap(receipt => receipt.files).filter(file => file.name.startsWith('SEP-Client-'))) {
        assert.equal(digest(await readFile(join(feed, 'beta', file.name)), 'sha256'), file.sha256)
      }
    }
  } })
  assert.deepEqual(events.filter(([event]) => event === 'before-manifest').map(([, name]) => name), ['latest.yml', 'latest-mac.yml'])
})
for (const failure of ['before-artifact', 'before-metadata', 'before-manifest', 'after-first-manifest', 'before-final-verification']) {
  test(`failure ${failure} restores the exact previous manifests and metadata`, async t => {
    const old = await bundle(t, '0.1.2')
    const next = await bundle(t)
    const feed = await fixture(t)
    await publishLocal({ ...options(old), fixture: feed })
    const before = await feedState(feed)
    await assert.rejects(publishLocal({ ...options(next), fixture: feed, hook: async event => {
      if (event === failure) throw new Error('injected secret')
    } }), /failed|restored/)
    assert.deepEqual(await feedState(feed), before)
    await assert.rejects(publishLocal({ ...options(next), fixture: feed }), /version|reuse/)
  })
}
test('first-publication failure restores missing manifests rather than fabricating a baseline', async t => {
  const b = await bundle(t)
  const feed = await fixture(t)
  await assert.rejects(publishLocal({ ...options(b), fixture: feed, hook: async event => {
    if (event === 'after-first-manifest') throw new Error('failure')
  } }))
  assert.deepEqual(await feedState(feed), {})
})
test('failed restore blocks subsequent operations and explicit recovery restores the snapshot', async t => {
  const old = await bundle(t, '0.1.2')
  const b = await bundle(t)
  const feed = await fixture(t)
  await publishLocal({ ...options(old), fixture: feed })
  const before = await feedState(feed)
  await assert.rejects(publishLocal({ ...options(b), fixture: feed, hook: async event => {
    if (event === 'after-first-manifest' || event === 'before-restore') throw new Error('failure')
  } }), /recovery/)
  await assert.rejects(publishLocal({ ...options(await bundle(t, '0.1.4')), fixture: feed }), /recovery/)
  const recovered = await recoverLocal({ channel: 'beta', fixture: feed })
  assert.equal(recovered.status, 'recovered-local')
  assert.deepEqual(await feedState(feed), before)
})
test('manual rollback restores previous manifests, preserves installers, and rejects stale rollback', async t => {
  const old = await bundle(t, '0.1.2')
  const b = await bundle(t)
  const feed = await fixture(t)
  await publishLocal({ ...options(old), fixture: feed })
  const before = await feedState(feed)
  const record = await publishLocal({ ...options(b), fixture: feed })
  await rollbackLocal({ channel: 'beta', fixture: feed, record: record.id })
  assert.deepEqual(await feedState(feed), before)
  assert.ok((await readdir(join(feed, 'beta'))).includes('SEP-Client-0.1.3-win-x64.exe'))
  await assert.rejects(rollbackLocal({ channel: 'beta', fixture: feed, record: record.id }))
  await assert.rejects(publishLocal({ ...options(b), fixture: feed }), /version|reuse/)
})
test('publication lock rejects a competing operation instead of stealing the lock', async t => {
  const b = await bundle(t)
  const feed = await fixture(t)
  let release
  let ready
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { ready = resolve })
  const first = publishLocal({ ...options(b), fixture: feed, hook: async event => {
    if (event === 'before-artifact') { ready(); await gate }
  } })
  await started
  try { await assert.rejects(publishLocal({ ...options(b), fixture: feed }), /locked/) } finally { release() }
  await first
})
test('unsafe CLI operations fail without leaking inputs or performing network actions', () => {
  const script = new URL('./publish-release.mjs', import.meta.url)
  for (const args of [['publish', 'beta', '--source', 'secret-token'], ['plan', '__proto__'], ['init', '--fixture', 'https://secret.test']]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.ok(!result.stderr.includes('secret-token'))
    assert.ok(!result.stderr.includes('secret.test'))
  }
})
for (const [label, bytes] of [
  ['invalid UTF-8', Buffer.from([0xff])],
  ['control bytes', Buffer.from('secret\u0000binary')],
  ['whitespace', Buffer.from('  \n')],
  ['oversized', Buffer.alloc(128 * 1024 + 1, 65)],
]) {
  test(`plan and collector reject ${label} release notes`, async t => {
    const b = await bundle(t)
    const notes = join(b.directory, 'RELEASE-NOTES-beta.md')
    await writeFile(notes, bytes)
    await assert.rejects(buildReleasePlan(options(b)))
    const input = await nativeInputs(b)
    await assert.rejects(collectRelease({ ...input, notes }))
    assert.ok(!(await readdir(b.root)).includes('collected'))
    assert.ok(!(await readdir(b.root)).some(name => name.startsWith('.sep-release-collect-')))
  })
}
test('collector rejects symlink notes and stale native artifacts without creating a bundle', async t => {
  const b = await bundle(t)
  const input = await nativeInputs(b)
  const notes = join(b.root, 'notes.md')
  await symlink(join(b.directory, 'RELEASE-NOTES-beta.md'), notes)
  await assert.rejects(collectRelease({ ...input, notes }), /regular|symbolic/)
  await writeFile(join(input.mac, 'SEP-Client-0.1.2-mac-arm64.zip'), 'stale')
  await assert.rejects(collectRelease(input), /stale/)
})
test('collector copies optional macOS blockmaps and covers them in the plan and checksums', async t => {
  const b = await bundle(t)
  const name = 'SEP-Client-0.1.3-mac-arm64.zip.blockmap'
  b.contents.set(name, Buffer.from('optional-map'))
  b.receipts[0].files.push(b.descriptor(name))
  const input = await nativeInputs(b)
  const plan = await collectRelease(input)
  assert.equal(plan.files.length, 12)
  assert.ok(plan.files.some(file => file.name === name && file.phase === 'artifact'))
  assert.ok((await readFile(join(input.output, 'SHA256SUMS.txt'), 'utf8')).includes(name))
})
test('plan rejects invalid receipt JSON, oversized reports and incorrect checksums', async t => {
  const b = await bundle(t)
  const file = join(b.directory, 'release-builds.json')
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{}'), Buffer.alloc(1024 * 1024 + 1, 65)]) {
    await writeFile(file, bytes)
    await assert.rejects(buildReleasePlan(options(b)))
  }
  await writeFile(file, JSON.stringify(b.receipts))
  await writeFile(join(b.directory, 'SHA256SUMS.txt'), 'forged')
  await assert.rejects(buildReleasePlan(options(b)), /SHA256SUMS/)
})
for (const [phase, location, name] of [
  ['before-artifact', 'source', 'SEP-Client-0.1.3-win-x64.exe'],
  ['before-metadata', 'source', 'RELEASE-NOTES-beta.md'],
  ['before-manifest', 'source', 'latest.yml'],
  ['before-manifest', 'feed', 'SEP-Client-0.1.3-win-x64.exe'],
]) {
  test(`post-plan mutation at ${phase} of ${location}/${name} prevents publication`, async t => {
    const old = await bundle(t, '0.1.2')
    const b = await bundle(t)
    const feed = await fixture(t)
    await publishLocal({ ...options(old), fixture: feed })
    const before = await feedState(feed)
    let mutated = false
    await assert.rejects(publishLocal({ ...options(b), fixture: feed, hook: async event => {
      if (event === phase && !mutated) {
        mutated = true
        await writeFile(join(location === 'feed' ? join(feed, 'beta') : b.directory, name), 'changed-after-plan')
      }
    } }), /restored/)
    assert.deepEqual(await feedState(feed), before)
  })
}
test('fixture initialization rejects occupied directories and symlinks; publish rejects a symlink channel', async t => {
  const b = await bundle(t)
  await assert.rejects(initializeFixture(b.directory), /empty/)
  const link = join(b.root, 'linked')
  await symlink(b.directory, link)
  await assert.rejects(initializeFixture(link), /symbolic|real/)
  const feed = await fixture(t)
  await symlink(b.directory, join(feed, 'beta'))
  await assert.rejects(publishLocal({ ...options(b), fixture: feed }), /symbolic/)
  assert.ok(!(await readdir(join(feed, '.release-state', 'beta'))).includes('lock'))
})
test('publishing cannot use the fixture root itself as its source bundle', async t => {
  const b = await bundle(t)
  await writeFile(join(b.directory, '.sep-release-fixture.json'), '{"schemaVersion":1,"localOnly":true}')
  await assert.rejects(publishLocal({ ...options(b), fixture: b.directory }), /overlap/)
})
test('rollback of the first release restores absent metadata and keeps installers', async t => {
  const b = await bundle(t)
  const feed = await fixture(t)
  const record = await publishLocal({ ...options(b), fixture: feed })
  const result = await rollbackLocal({ channel: 'beta', fixture: feed, record: record.id })
  assert.equal(result.status, 'rolled-back-local')
  assert.deepEqual(await feedState(feed), {})
  assert.ok((await readdir(join(feed, 'beta'))).includes('SEP-Client-0.1.3-win-x64.exe'))
})
test('rollback refuses an older record after a newer version is published', async t => {
  const b = await bundle(t)
  const feed = await fixture(t)
  const record = await publishLocal({ ...options(b), fixture: feed })
  await publishLocal({ ...options(await bundle(t, '0.1.4')), fixture: feed })
  const before = await feedState(feed)
  await assert.rejects(rollbackLocal({ channel: 'beta', fixture: feed, record: record.id }), /hash/)
  assert.deepEqual(await feedState(feed), before)
})
for (const corrupt of [
  record => { record.before['latest.yml'] = { bytes: 'Zm9yZ2Vk', sha256: '0'.repeat(64) } },
  record => { record.plan.files[0].phase = 'metadata' },
  record => { record.plan.files[0].sha256 = 'bad' },
  record => { record.plan.files.push(record.plan.files[0]) },
]) {
  test('corrupted transaction records block further publication without changing the feed', async t => {
    const b = await bundle(t)
    const feed = await fixture(t)
    const record = await publishLocal({ ...options(b), fixture: feed })
    corrupt(record)
    await writeFile(recordPath(feed, record), JSON.stringify(record))
    const before = await feedState(feed)
    await assert.rejects(publishLocal({ ...options(await bundle(t, '0.1.4')), fixture: feed }))
    assert.deepEqual(await feedState(feed), before)
  })
}
test('recovery rejects externally changed metadata and failed recovery remains blocking', async t => {
  const b = await bundle(t)
  const feed = await fixture(t)
  await assert.rejects(publishLocal({ ...options(b), fixture: feed, hook: async event => {
    if (event === 'after-first-manifest' || event === 'before-restore') throw new Error('injected')
  } }))
  await assert.rejects(recoverLocal({ channel: 'beta', fixture: feed, hook: async () => { throw new Error('injected') } }))
  await writeFile(join(feed, 'beta', 'RELEASE-NOTES-beta.md'), 'external mutation')
  await assert.rejects(recoverLocal({ channel: 'beta', fixture: feed }), /outside|refused/)
  await assert.rejects(publishLocal({ ...options(await bundle(t, '0.1.4')), fixture: feed }), /recovery/)
})
test('CLI init, collection, plan, publish, rollback and recovery stay local and redact snapshots', async t => {
  const b = await bundle(t)
  const input = await nativeInputs(b)
  const script = new URL('./publish-release.mjs', import.meta.url).pathname
  const run = args => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, SEP_RELEASE_CHANNEL: 'beta' } })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const feed = join(b.root, 'cli-fixture')
  run(['init', '--fixture', feed])
  run(['collect', 'beta', '--mac', input.mac, '--win', input.win, '--output', input.output, '--version', b.version, '--commit', commit])
  const sourceFlags = ['--source', input.output, '--version', b.version, '--commit', commit]
  const plan = run(['plan', 'beta', ...sourceFlags])
  assert.equal(plan.releaseApproved, false)
  const record = run(['publish-local', 'beta', ...sourceFlags, '--fixture', feed])
  assert.equal(record.status, 'published-local')
  assert.equal(record.mode, 'local-rehearsal')
  assert.equal(record.before, undefined)
  run(['rollback-local', 'beta', '--fixture', feed, '--record', record.id])
  const next = await bundle(t, '0.1.4')
  await assert.rejects(publishLocal({ ...options(next), fixture: feed, hook: async event => {
    if (event === 'after-first-manifest' || event === 'before-restore') throw new Error('injected')
  } }))
  assert.equal(run(['recover-local', 'beta', '--fixture', feed]).status, 'recovered-local')
})
test('published fixture serves anonymous HTTP manifests and hashes, and rollback withdraws the newer version', async t => {
  const old = await bundle(t, '0.1.2')
  const b = await bundle(t)
  const feed = await fixture(t)
  await publishLocal({ ...options(old), fixture: feed })
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie })
    try {
      const name = request.url?.slice('/beta/'.length)
      if (!request.url?.startsWith('/beta/') || !name || name.includes('/') || name.includes('..')) throw new Error('invalid request')
      const bytes = await readFile(join(feed, 'beta', name))
      response.writeHead(200, { 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
      response.end(bytes)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const url = `http://127.0.0.1:${server.address().port}/beta/`
  const verify = () => verifyUpdateFeed(url, { allowLocalHttp: true, requireAllPlatforms: true })
  assert.ok((await verify()).every(manifest => manifest.version === old.version))
  const record = await publishLocal({ ...options(b), fixture: feed })
  assert.ok((await verify()).every(manifest => manifest.version === b.version))
  await rollbackLocal({ channel: 'beta', fixture: feed, record: record.id })
  assert.ok((await verify()).every(manifest => manifest.version === old.version))
  assert.equal(requests.length, 15)
  assert.ok(requests.every(request => request.authorization === undefined && request.cookie === undefined))
})
test('CLI rejects missing, duplicate and unsupported options and conflicting channel environment', () => {
  const script = new URL('./publish-release.mjs', import.meta.url).pathname
  for (const args of [
    [], ['init'], ['plan', 'beta'], ['init', '--fixture'], ['init', '--fixture', '--fixture'],
    ['init', '--fixture', 'sensitive', '--fixture', 'duplicate'], ['init', '--unknown', 'sensitive'],
    ['plan', 'beta', '--commit', commit], ['collect', 'beta', '--commit', commit],
    ['publish-local', 'beta', '--commit', commit, '--source', 'sensitive'],
    ['rollback-local', 'beta', '--fixture', 'sensitive'], ['recover-local', 'beta'],
    ['plan', 'stable', '--source', 'sensitive', '--commit', commit],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, SEP_RELEASE_CHANNEL: 'beta' } })
    assert.notEqual(result.status, 0)
    assert.ok(!result.stderr.includes('sensitive'))
  }
})
test('CLI defaults expected version to the local package without changing it', async t => {
  const b = await bundle(t)
  const pkg = join(b.root, 'package.json')
  const bytes = JSON.stringify({ version: b.version })
  await writeFile(pkg, bytes)
  const script = new URL('./publish-release.mjs', import.meta.url).pathname
  const result = spawnSync(process.execPath, [script, 'plan', 'beta', '--source', b.directory, '--commit', commit], {
    cwd: b.root, encoding: 'utf8', env: { ...process.env, SEP_RELEASE_CHANNEL: 'beta' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).version, b.version)
  assert.equal(await readFile(pkg, 'utf8'), bytes)
})
test('importing release plan, fixture store and CLI performs no work or output', async t => {
  const root = await temporary(t)
  const modules = ['release-plan.mjs', 'local-release-store.mjs', 'publish-release.mjs'].map(name => new URL(name, import.meta.url).href)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `for (const url of ${JSON.stringify(modules)}) await import(url)`], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.deepEqual(await readdir(root), [])
})
test('rollback failure records recovery-required and an explicit recovery finishes restoration', async t => {
  const b = await bundle(t)
  const feed = await fixture(t)
  const record = await publishLocal({ ...options(b), fixture: feed })
  await assert.rejects(rollbackLocal({ channel: 'beta', fixture: feed, record: record.id, hook: async () => { throw new Error('injected') } }), /recovery/)
  assert.equal(JSON.parse(await readFile(recordPath(feed, record), 'utf8')).status, 'recovery-required')
  assert.equal((await recoverLocal({ channel: 'beta', fixture: feed })).status, 'recovered-local')
  assert.deepEqual(await feedState(feed), {})
})
test('artifact copy streams multiple chunks and refuses to replace any existing target', async t => {
  const root = await temporary(t)
  const source = join(root, 'source')
  const target = join(root, 'target')
  await mkdir(source)
  await mkdir(target)
  const name = 'large.zip'
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  await writeFile(join(source, name), bytes)
  const file = await hashReleaseFile(source, name)
  await copyReleaseFile(source, target, file)
  assert.deepEqual(await readFile(join(target, name)), bytes)
  await assert.rejects(copyReleaseFile(source, target, file), /EEXIST/)
  assert.deepEqual(await hashReleaseFile(target, name), file)
})
test('canonical prerelease and build metadata survive assembly and same-precedence reuse is blocked', async t => {
  const b = await bundle(t, '0.1.3-beta.1+build.1')
  const input = await nativeInputs(b)
  const plan = await collectRelease(input)
  assert.equal(plan.version, b.version)
  const feed = await fixture(t)
  await publishLocal({ ...options(b), fixture: feed })
  const samePrecedence = await bundle(t, '0.1.3-beta.1+build.2')
  await assert.rejects(publishLocal({ ...options(samePrecedence), fixture: feed }), /reuse|version/)
})
for (const suffix of ['win-x64.exe', 'win-x64.exe.blockmap', 'mac-arm64.dmg']) {
  test(`rollback preflight refuses missing old ${suffix} before changing current manifests`, async t => {
    const old = await bundle(t, '0.1.2')
    const b = await bundle(t)
    const feed = await fixture(t)
    await publishLocal({ ...options(old), fixture: feed })
    const record = await publishLocal({ ...options(b), fixture: feed })
    const before = await feedState(feed)
    await rm(join(feed, 'beta', `SEP-Client-0.1.2-${suffix}`))
    await assert.rejects(rollbackLocal({ channel: 'beta', fixture: feed, record: record.id }))
    assert.deepEqual(await feedState(feed), before)
    assert.equal(JSON.parse(await readFile(recordPath(feed, record), 'utf8')).status, 'published-local')
  })
}
test('process interruption keeps its channel lock and recovery works only after confirmed exit and explicit unlock', async t => {
  const old = await bundle(t, '0.1.2')
  const b = await bundle(t)
  const feed = await fixture(t)
  await publishLocal({ ...options(old), fixture: feed })
  const before = await feedState(feed)
  const module = new URL('./local-release-store.mjs', import.meta.url).href
  const script = `import { publishLocal } from ${JSON.stringify(module)};
    await publishLocal({ ...${JSON.stringify(options(b))}, fixture: ${JSON.stringify(feed)},
      hook: async event => { if (event === 'after-first-manifest') process.exit(42) } });`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 42, child.stderr)
  const partial = await feedState(feed)
  assert.equal(yaml.load(partial['latest.yml']).version, b.version)
  assert.equal(yaml.load(partial['latest-mac.yml']).version, old.version)
  await assert.rejects(recoverLocal({ channel: 'beta', fixture: feed }), /locked/)
  assert.deepEqual(await feedState(feed), partial)
  // spawnSync confirms this child's exit; only its empty lock is explicitly removed.
  await rmdir(join(feed, '.release-state', 'beta', 'lock'))
  assert.equal((await recoverLocal({ channel: 'beta', fixture: feed })).status, 'recovered-local')
  assert.deepEqual(await feedState(feed), before)
})
