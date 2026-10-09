import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import {
  MAX_MANIFEST_BYTES, parseManifest, validateArtifactPath,
  verifyStream, verifyUpdateDirectory,
} from './verify-update-manifest.mjs'
import {
  normalizeFeedUrl, validateFeedRequestUrl, verifyUpdateFeed,
} from './test-update-feed.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(scriptDirectory, 'fixtures/update-feed')
const betaRoot = join(fixtureRoot, 'beta')
const windowsName = 'SEP-Client-0.1.3-beta.1-win-x64.exe'
const betaWindows = yaml.load(await readFile(join(betaRoot, 'latest.yml'), 'utf8'))
const betaMac = yaml.load(await readFile(join(betaRoot, 'latest-mac.yml'), 'utf8'))
const httpOptions = { allowLocalHttp: true, timeoutMs: 2000 }

function clone(value = betaWindows) {
  return structuredClone(value)
}

function encoded(value) {
  return yaml.dump(value, { lineWidth: -1 })
}

function parse(value, name = 'latest.yml') {
  return parseManifest(encoded(value), name)
}

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sep-update-feed-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function copyFixture(t) {
  const directory = await tempDirectory(t)
  await cp(betaRoot, directory, { recursive: true })
  return directory
}

async function serve(t, override = () => false) {
  const requests = []
  const server = http.createServer(async (request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    try {
      if (await override(request, response)) return
      const url = new URL(request.url, 'http://fixture.test')
      if (!/^\/(beta|stable)\/[A-Za-z0-9.+-]+$/.test(url.pathname)) {
        response.writeHead(404).end('missing fixture')
        return
      }
      const data = await readFile(join(fixtureRoot, url.pathname))
      response.writeHead(200, { 'Content-Length': data.length }).end(data)
    } catch {
      if (!response.headersSent) response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  return { origin: `http://127.0.0.1:${server.address().port}`, requests }
}

function spawnCli(script, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

async function* chunks(data, chunkSize = 7) {
  for (let offset = 0; offset < data.length; offset += chunkSize) yield data.subarray(offset, offset + chunkSize)
}

test('both channel fixtures pass full local validation and have distinct versions and hashes', async () => {
  const beta = await verifyUpdateDirectory(betaRoot, { requireAllPlatforms: true })
  const stable = await verifyUpdateDirectory(join(fixtureRoot, 'stable'), { requireAllPlatforms: true })
  for (const result of [beta, stable]) {
    assert.deepEqual(result.map(entry => entry.name), ['latest.yml', 'latest-mac.yml'])
    assert.deepEqual(result.map(entry => entry.files.length), [1, 2])
  }
  assert.notEqual(beta[0].version, stable[0].version)
  assert.notEqual(beta[0].files[0].sha512, stable[0].files[0].sha512)
})

test('parser retains actual builder metadata and accepts normal SemVer prerelease/build identifiers', () => {
  const manifest = clone()
  manifest.releaseDate = '2026-10-09T00:00:00.000Z'
  manifest.releaseNotes = 'A multiline note\nwith # YAML characters and & literal text'
  manifest.files[0].blockMapSize = 128
  manifest.packages = {}
  assert.deepEqual(parse(manifest), manifest)
  assert.deepEqual(parseManifest(Buffer.from(encoded(manifest)), 'latest.yml'), manifest)
  const versioned = clone()
  versioned.version = '1.2.3-rc.0+build.01'
  versioned.files[0].url = `SEP-Client-${versioned.version}-win-x64.exe`
  versioned.path = versioned.files[0].url
  assert.equal(parse(versioned).version, versioned.version)
})

for (const [label, input] of [
  ['empty', ''], ['scalar', 'text'], ['sequence', '- item'], ['broken syntax', 'files: ['],
  ['duplicate keys', 'version: 1.2.3\nversion: 2.0.0\n'],
  ['multiple documents', 'version: 1.2.3\n---\nversion: 2.0.0\n'],
  ['custom tags', 'version: !unsafe 1.2.3'],
  ['anchors', `${encoded(betaWindows)}unused: &shared [1]\nother: *shared\n`],
  ['recursive aliases', `${encoded(betaWindows)}unused: &shared [*shared]\n`],
  ['YAML merge aliases', `base: &base {version: 1.2.3}\n<<: *base\n`],
  ['invalid UTF-8', Buffer.from([0xff, 0xfe])],
  ['oversized YAML', 'x'.repeat(MAX_MANIFEST_BYTES + 1)],
  ['excessive nesting', `${encoded(betaWindows)}extra: ${'['.repeat(80)}0${']'.repeat(80)}\n`],
]) {
  test(`parser rejects ${label}`, () => {
    assert.throws(() => parseManifest(input, 'latest.yml'))
  })
}

for (const value of [undefined, null, 123, '', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-rc.01', '1.2.3-', '1.2.3+']) {
  test(`parser rejects invalid version ${JSON.stringify(value)}`, () => {
    const manifest = clone()
    manifest.version = value
    assert.throws(() => parse(manifest), /version/)
  })
}

for (const [label, mutate, pattern] of [
  ['missing files', m => { delete m.files }, /files/],
  ['empty files', m => { m.files = [] }, /files/],
  ['mapping files', m => { m.files = {} }, /files/],
  ['scalar entry', m => { m.files = ['bad'] }, /entry/],
  ['duplicate entry', m => { m.files.push(clone(m.files[0])) }, /duplicate/],
  ['missing url', m => { delete m.files[0].url }, /path/],
  ['missing size', m => { delete m.files[0].size }, /size/],
  ['string size', m => { m.files[0].size = '100' }, /size/],
  ['fractional size', m => { m.files[0].size = 1.5 }, /size/],
  ['zero size', m => { m.files[0].size = 0 }, /size/],
  ['negative size', m => { m.files[0].size = -1 }, /size/],
  ['unsafe integer size', m => { m.files[0].size = Number.MAX_SAFE_INTEGER + 1 }, /size/],
  ['missing SHA512', m => { delete m.files[0].sha512 }, /sha512/],
  ['hex SHA512', m => { m.files[0].sha512 = 'a'.repeat(128) }, /sha512/],
  ['short SHA512', m => { m.files[0].sha512 = Buffer.alloc(32).toString('base64') }, /sha512/],
  ['noncanonical SHA512 padding', m => { m.files[0].sha512 = 'A'.repeat(85) + 'B==' }, /sha512/],
  ['foreign version', m => { m.files[0].url = 'SEP-Client-9.9.9-win-x64.exe' }, /artifact name/],
  ['arbitrary name', m => { m.files[0].url = 'installer.exe' }, /artifact name/],
  ['non-NSIS extension', m => { m.files[0].url = `SEP-Client-${m.version}-win-x64.zip` }, /NSIS/],
  ['non-x64 Windows', m => { m.files[0].url = `SEP-Client-${m.version}-win-arm64.exe` }, /NSIS/],
  ['foreign legacy path', m => { m.path = 'missing.exe' }, /path/],
  ['mismatched legacy hash', m => { m.sha512 = Buffer.alloc(64).toString('base64') }, /legacy sha512/],
  ['mismatched legacy size', m => { m.size = m.files[0].size + 1 }, /legacy size/],
  ['legacy hash without path', m => { delete m.path }, /requires path/],
]) {
  test(`parser rejects ${label}`, () => {
    const manifest = clone()
    mutate(manifest)
    assert.throws(() => parse(manifest), pattern)
  })
}

for (const path of ['../stable/file.exe', './file.exe', '/tmp/file.exe', '//evil.test/file.exe', 'https://evil.test/file.exe', 'file:///tmp/file.exe', 'C:\\file.exe', 'folder\\file.exe', 'folder/../file.exe', 'folder//file.exe', 'folder/', '%2e%2e/file.exe', 'folder/%2fescape.exe', 'file.exe?token=secret', 'file.exe#fragment', 'file.exe\0', ' file.exe', '~user/file.exe']) {
  test(`artifact paths reject ${JSON.stringify(path)}`, () => {
    assert.throws(() => validateArtifactPath(path), /path/)
    const manifest = clone()
    manifest.files[0].url = path
    assert.throws(() => parse(manifest), /path/)
  })
}

test('nonempty or invalid packages are rejected; empty builder metadata is allowed', () => {
  for (const packages of [
    { x64: { file: 'web-installer.7z', sha512: 'unchecked digest' } },
    { x64: { file: 'https://user:package-secret@example.test/payload.7z' } },
    { unused: {} }, null, [], 'installer.7z', 1, false,
  ]) {
    const manifest = clone()
    manifest.packages = packages
    assert.throws(() => parse(manifest), error => {
      assert.match(error.message, /packages.*web installers/)
      assert.doesNotMatch(error.message, /package-secret|user:/)
      return true
    })
  }
  const emptyPackages = clone()
  emptyPackages.packages = {}
  assert.deepEqual(parse(emptyPackages).packages, {})
})

test('unsafe path diagnostics never echo credentials or invalid path values', () => {
  const paths = [
    'https://secret-user:secret-password@example.test/installer.exe?token=private-token',
    '../secret-password/installer.exe',
    'installer.exe?token=private-token',
    'folder%2fprivate-token/installer.exe',
  ]
  for (const path of paths) {
    for (const action of [
      () => validateArtifactPath(path),
      () => { const m = clone(); m.files[0].url = path; return parse(m) },
      () => { const m = clone(); m.path = path; return parse(m) },
    ]) {
      assert.throws(action, error => {
        assert.match(error.message, /unsafe file path/)
        assert.doesNotMatch(error.message, /secret-user|secret-password|private-token|example\.test/)
        return true
      })
    }
  }
})

test('mac requires at least one ZIP, allows legacy DMG entries, and rejects foreign platforms', () => {
  const manifest = clone(betaMac)
  const dmg = { ...manifest.files[0], url: manifest.files[0].url.replace('.zip', '.dmg') }
  manifest.files.push(dmg)
  assert.equal(parse(manifest, 'latest-mac.yml').files.length, 3)
  manifest.files = [dmg]
  assert.throws(() => parse(manifest, 'latest-mac.yml'), /at least one mac ZIP/)
  manifest.files = clone(betaWindows.files)
  assert.throws(() => parse(manifest, 'latest-mac.yml'), /mac ZIP\/DMG/)
})

test('default local mode accepts one manifest, strict mode requires both and mac ZIP architectures', async t => {
  const dir = await copyFixture(t)
  await rm(join(dir, 'latest.yml'))
  const singleMac = clone(betaMac)
  singleMac.files = singleMac.files.slice(0, 1)
  await writeFile(join(dir, 'latest-mac.yml'), encoded(singleMac))
  assert.equal((await verifyUpdateDirectory(dir)).length, 1)
  await assert.rejects(verifyUpdateDirectory(dir, { requireAllPlatforms: true }), /win-x64, mac-x64/)
  await writeFile(join(dir, 'latest.yml'), encoded(betaWindows))
  await assert.rejects(verifyUpdateDirectory(dir, { requireAllPlatforms: true }), /mac-x64/)
  assert.equal((await verifyUpdateDirectory(dir, { manifestName: 'latest.yml' })).length, 1)
  await assert.rejects(verifyUpdateDirectory(dir, { manifestName: 'latest.yml', requireAllPlatforms: true }), /mac-arm64, mac-x64/)
  await rm(join(dir, 'latest-mac.yml'))
  assert.equal((await verifyUpdateDirectory(dir)).length, 1)
})

test('local mode rejects missing/invalid manifests and mismatched versions', async t => {
  const dir = await tempDirectory(t)
  await assert.rejects(verifyUpdateDirectory(dir), /at least one/)
  await assert.rejects(verifyUpdateDirectory(dir, { manifestName: 'latest.yml' }), /ENOENT/)
  await assert.rejects(verifyUpdateDirectory(betaRoot, { manifestName: '../latest.yml' }), /manifest must/)
  await cp(betaRoot, dir, { recursive: true })
  await writeFile(join(dir, 'latest-mac.yml'), await readFile(join(fixtureRoot, 'stable/latest-mac.yml')))
  await assert.rejects(verifyUpdateDirectory(dir), /versions must match/)
  await writeFile(join(dir, 'latest.yml'), 'broken: [')
  await assert.rejects(verifyUpdateDirectory(dir), /invalid YAML/)
})

test('local mode checks actual size/hash, missing files and bounded manifests', async t => {
  const dir = await copyFixture(t)
  const installer = join(dir, windowsName)
  const data = await readFile(installer)
  await writeFile(installer, Buffer.alloc(data.length))
  await assert.rejects(verifyUpdateDirectory(dir), /SHA512 hash mismatch/)
  await writeFile(installer, data.subarray(0, data.length - 1))
  await assert.rejects(verifyUpdateDirectory(dir), /size mismatch/)
  await rm(installer)
  await assert.rejects(verifyUpdateDirectory(dir), /ENOENT/)
  await writeFile(join(dir, 'latest.yml'), 'x'.repeat(MAX_MANIFEST_BYTES + 1))
  await assert.rejects(verifyUpdateDirectory(dir), /maximum size/)
})

test('local containment rejects escaping file, parent and manifest symlinks, and dangling manifests', async t => {
  const root = await tempDirectory(t)
  const dir = join(root, 'beta')
  const outside = join(root, 'beta-outside')
  await cp(betaRoot, dir, { recursive: true })
  await mkdir(outside)
  await cp(join(betaRoot, windowsName), join(outside, windowsName))
  await rm(join(dir, windowsName))
  await symlink(join(outside, windowsName), join(dir, windowsName))
  await assert.rejects(verifyUpdateDirectory(dir), /escapes update directory/)
  await rm(join(dir, windowsName))
  await symlink(outside, join(dir, 'nested'), 'dir')
  const nested = clone()
  nested.files[0].url = `nested/${windowsName}`
  nested.path = nested.files[0].url
  await writeFile(join(dir, 'latest.yml'), encoded(nested))
  await assert.rejects(verifyUpdateDirectory(dir), /escapes update directory/)
  await rm(join(dir, 'latest.yml'))
  await symlink(join(betaRoot, 'latest.yml'), join(dir, 'latest.yml'))
  await assert.rejects(verifyUpdateDirectory(dir), /escapes update directory/)
  await rm(join(dir, 'latest.yml'))
  await symlink(join(outside, 'missing.yml'), join(dir, 'latest.yml'))
  await assert.rejects(verifyUpdateDirectory(dir), /ENOENT/)
})

test('safe subdirectories, directory aliases and contained symlinks work', async t => {
  const dir = await copyFixture(t)
  await mkdir(join(dir, 'nested'))
  await cp(join(dir, windowsName), join(dir, 'nested/payload'))
  await symlink('payload', join(dir, `nested/${windowsName}`))
  const manifest = clone()
  manifest.files[0].url = `nested/${windowsName}`
  manifest.path = manifest.files[0].url
  await writeFile(join(dir, 'latest.yml'), encoded(manifest))
  const alias = `${dir}-alias`
  await symlink(dir, alias, 'dir')
  t.after(() => rm(alias))
  assert.equal((await verifyUpdateDirectory(alias, { requireAllPlatforms: true }))[0].files.length, 1)
})

test('stream verifier hashes incremental chunks and rejects smaller, larger or corrupt downloads', async () => {
  const data = Buffer.from('a chunked fixture payload')
  const file = { url: 'payload', size: data.length, sha512: createHash('sha512').update(data).digest('base64') }
  assert.deepEqual(await verifyStream(chunks(data), file), file)
  await assert.rejects(verifyStream(chunks(data.subarray(1)), file), /size mismatch/)
  await assert.rejects(verifyStream(chunks(Buffer.concat([data, Buffer.from('x')])), file), /size mismatch/)
  await assert.rejects(verifyStream(chunks(Buffer.alloc(data.length)), file), /SHA512/)
})

test('URL policy requires HTTPS and restricts local HTTP, credentials and channel redirects', () => {
  assert.equal(normalizeFeedUrl('https://download.example/sep-client/beta').href, 'https://download.example/sep-client/beta/')
  for (const url of ['http://127.0.0.1/beta/', 'http://localhost/beta/', 'http://[::1]/beta/']) {
    assert.throws(() => normalizeFeedUrl(url), /HTTPS/)
    assert.equal(normalizeFeedUrl(url, { allowLocalHttp: true }).protocol, 'http:')
  }
  assert.equal(normalizeFeedUrl('http://127.20.30.40/beta/', { allowLocalHttp: true }).hostname, '127.20.30.40')
  for (const url of ['http://example.com/beta/', 'http://192.168.1.1/beta/', 'http://localhost.evil.test/beta/', 'http://[::2]/beta/', 'ftp://localhost/beta/']) {
    assert.throws(() => normalizeFeedUrl(url, { allowLocalHttp: true }), /HTTPS/)
  }
  for (const url of ['https://user:secret@example.test/beta/', 'https://example.test/beta/?token=secret', 'https://example.test/beta/#fragment', 'https://example.test/beta/%2fescape/', 'https://example.test\\beta/', 'https://example.test/beta/\n', 'not a URL']) {
    assert.throws(() => normalizeFeedUrl(url))
  }
  for (const url of [
    'https://example.test/beta/../stable/', 'https://example.test/beta/./',
    'https://example.test/beta/..', 'https://example.test/beta/%2e%2e/stable/',
    'https://example.test/beta/.%2e/stable/',
  ]) assert.throws(() => normalizeFeedUrl(url), /dot segments|encoded paths/)
  for (const code of [0, 9, 10, 13, 31, 127]) {
    assert.throws(() => normalizeFeedUrl(`https://example.test/be${String.fromCharCode(code)}ta/`), /invalid/)
  }
  const base = normalizeFeedUrl('https://download.example/sep-client/beta/')
  assert.equal(validateFeedRequestUrl('latest.yml', base).pathname, '/sep-client/beta/latest.yml')
  assert.throws(() => validateFeedRequestUrl('https://other.example/sep-client/beta/latest.yml', base), /cross-origin/)
  assert.throws(() => validateFeedRequestUrl('../stable/latest.yml', base), /cross-channel/)
  assert.throws(() => validateFeedRequestUrl('/sep-client/beta-evil/latest.yml', base), /cross-channel/)
  assert.throws(() => validateFeedRequestUrl('http://download.example/sep-client/beta/latest.yml', base), /HTTPS/)
})

test('remote default verifies both platforms in both channels over anonymous loopback HTTP', async t => {
  const { origin, requests } = await serve(t)
  for (const channel of ['beta', 'stable']) {
    const results = await verifyUpdateFeed(`${origin}/${channel}`, { ...httpOptions, requireAllPlatforms: true })
    assert.deepEqual(results.map(entry => entry.files.length), [1, 2])
    for (const result of results) {
      assert.match(result.files[0].url, new RegExp(result.version.replaceAll('.', '\\.')))
    }
  }
  assert.equal(requests.length, 10)
  for (const request of requests) {
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers.cookie, undefined)
    assert.equal(request.headers['accept-encoding'], 'identity')
  }
})

test('remote manifest selector checks only the requested platform', async t => {
  const { origin, requests } = await serve(t)
  const results = await verifyUpdateFeed(`${origin}/beta/`, { ...httpOptions, manifestName: 'latest.yml' })
  assert.equal(results.length, 1)
  assert.deepEqual(requests.map(request => request.url), ['/beta/latest.yml', `/beta/${windowsName}`])
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, { ...httpOptions, manifestName: 'latest.yml', requireAllPlatforms: true }), /missing required platforms/)
})

for (const target of ['latest.yml', windowsName]) {
  test(`remote rejects 404 for ${target}`, async t => {
    const { origin } = await serve(t, (request, response) => {
      if (request.url !== `/beta/${target}`) return false
      response.writeHead(404).end('not found')
      return true
    })
    await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /HTTP 404/)
  })
}

for (const [label, status, headers, body, pattern] of [
  ['bad YAML', 200, {}, 'version: [', /invalid YAML/],
  ['empty manifest', 200, {}, '', /manifest size/],
  ['wrong status', 206, {}, encoded(betaWindows), /HTTP 206/],
  ['authentication challenge', 401, {}, '', /HTTP 401/],
  ['oversized Content-Length', 200, { 'Content-Length': MAX_MANIFEST_BYTES + 1 }, 'x', /maximum size/],
  ['oversized chunked manifest', 200, {}, 'x'.repeat(MAX_MANIFEST_BYTES + 1), /maximum size/],
  ['compressed response', 200, { 'Content-Encoding': 'gzip' }, encoded(betaWindows), /encoded update responses/],
]) {
  test(`remote rejects ${label}`, async t => {
    const { origin } = await serve(t, (request, response) => {
      if (request.url !== '/beta/latest.yml') return false
      response.writeHead(status, headers).end(body)
      return true
    })
    await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), pattern)
  })
}

for (const [label, send, pattern] of [
  ['wrong Content-Length', response => response.writeHead(200, { 'Content-Length': 1 }).end('x'), /HTTP size mismatch/],
  ['short chunked download', response => response.writeHead(200).end('x'), /size mismatch/],
  ['oversized chunked download', response => response.writeHead(200).end('x'.repeat(betaWindows.files[0].size + 1)), /size mismatch/],
  ['same-size hash corruption', response => response.writeHead(200).end('x'.repeat(betaWindows.files[0].size)), /SHA512 hash mismatch/],
  ['truncated declared download', response => {
    response.writeHead(200, { 'Content-Length': betaWindows.files[0].size })
    response.write('partial')
    setImmediate(() => response.destroy())
  }, /aborted|reset|closed|socket/i],
]) {
  test(`remote rejects ${label}`, async t => {
    const { origin } = await serve(t, (request, response) => {
      if (request.url !== `/beta/${windowsName}`) return false
      send(response)
      return true
    })
    await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), pattern)
  })
}

test('remote manifest integrity/path/version/strict-platform failures fail before downloading artifacts', async t => {
  let manifest = clone()
  const { origin, requests } = await serve(t, (request, response) => {
    if (request.url !== '/beta/latest.yml') return false
    response.writeHead(200).end(encoded(manifest))
    return true
  })
  manifest.files[0].url = '../stable/installer.exe'
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /unsafe file path/)
  assert.equal(requests.length, 1)
  manifest = clone()
  manifest.files[0].size = 0
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /size/)
  manifest = clone()
  manifest.files[0].sha512 = 'invalid'
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /sha512/)
  manifest = yaml.load(await readFile(join(fixtureRoot, 'stable/latest.yml'), 'utf8'))
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /versions must match/)
  assert.ok(requests.every(request => request.url.endsWith('.yml')))
})

test('remote accepts chunked correct downloads and same-channel redirects', async t => {
  const data = await readFile(join(betaRoot, windowsName))
  const { origin, requests } = await serve(t, (request, response) => {
    if (request.url === '/beta/latest.yml') {
      response.writeHead(302, { Location: 'manifest-alias.yml' }).end()
    } else if (request.url === '/beta/manifest-alias.yml') {
      response.writeHead(200).end(encoded(betaWindows))
    } else if (request.url === `/beta/${windowsName}`) {
      response.writeHead(307, { Location: 'nested/payload.exe' }).end()
    } else if (request.url === '/beta/nested/payload.exe') {
      response.writeHead(308, { Location: 'final.exe' }).end()
    } else if (request.url === '/beta/nested/final.exe') {
      response.writeHead(200)
      for (let index = 0; index < data.length; index += 7) response.write(data.subarray(index, index + 7))
      response.end()
    } else return false
    return true
  })
  assert.equal((await verifyUpdateFeed(`${origin}/beta/`, { ...httpOptions, requireAllPlatforms: true })).length, 2)
  assert.ok(requests.some(request => request.url === '/beta/nested/final.exe'))
})

for (const target of ['latest.yml', windowsName]) {
  for (const location of ['../stable/latest.yml', '/beta-evil/latest.yml', '/beta/%2e%2e/stable/latest.yml']) {
    test(`redirect isolation rejects ${target} → ${location}`, async t => {
      const { origin, requests } = await serve(t, (request, response) => {
        if (request.url !== `/beta/${target}`) return false
        response.writeHead(302, { Location: location }).end()
        return true
      })
      await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /cross-channel|encoded paths/)
      assert.ok(requests.every(request => request.url.startsWith('/beta/')))
    })
  }
}

test('cross-origin manifest and artifact redirects are rejected before contacting the destination', async t => {
  const destination = await serve(t)
  let target = 'latest.yml'
  const { origin } = await serve(t, (request, response) => {
    if (request.url !== `/beta/${target}`) return false
    response.writeHead(302, { Location: `${destination.origin}/beta/${target}` }).end()
    return true
  })
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /cross-origin/)
  target = windowsName
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /cross-origin/)
  assert.equal(destination.requests.length, 0)
})

test('redirect loops and missing/credential/query redirect targets are rejected', async t => {
  let location = 'latest.yml'
  const { origin, requests } = await serve(t, (request, response) => {
    if (request.url !== '/beta/latest.yml') return false
    response.writeHead(302, location === undefined ? {} : { Location: location }).end()
    return true
  })
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /redirect limit/)
  assert.equal(requests.length, 6)
  location = undefined
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /missing redirect/)
  location = `${origin.replace('http://', 'http://user:secret@')}/beta/latest.yml`
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /credentials/)
  location = 'latest.yml?token=secret'
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, httpOptions), /query/)
})

test('HTTP fails without explicit local opt-in, including redirects after HTTPS', async t => {
  const { origin, requests } = await serve(t)
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`), /HTTPS/)
  assert.equal(requests.length, 0)
  const base = normalizeFeedUrl('https://localhost/beta/')
  assert.throws(() => validateFeedRequestUrl('http://localhost/beta/latest.yml', base, { allowLocalHttp: true }), /cross-origin/)
})

test('remote timeout covers slow headers and slow artifact bodies; invalid timeout settings fail', async t => {
  let target = 'latest.yml'
  const { origin } = await serve(t, (request, response) => {
    if (request.url !== `/beta/${target}`) return false
    if (target !== 'latest.yml') {
      response.writeHead(200)
      response.write('partial')
    }
    return true
  })
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, { ...httpOptions, timeoutMs: 60 }), /timed out/)
  target = windowsName
  await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, { ...httpOptions, timeoutMs: 60 }), /timed out/)
  for (const timeoutMs of [0, -1, 1.5, 120001]) {
    await assert.rejects(verifyUpdateFeed(`${origin}/beta/`, { ...httpOptions, timeoutMs }), /timeoutMs/)
  }
})

test('local CLI reports success/failure and validates its arguments', async () => {
  const script = join(scriptDirectory, 'verify-update-manifest.mjs')
  const success = await spawnCli(script, [betaRoot, '--require-all-platforms'])
  assert.equal(success.code, 0, success.stderr)
  assert.match(success.stdout, /verified latest.yml/)
  assert.match(success.stdout, /verified latest-mac.yml/)
  const selected = await spawnCli(script, [betaRoot, 'latest.yml'])
  assert.equal(selected.code, 0, selected.stderr)
  assert.doesNotMatch(selected.stdout, /latest-mac/)
  for (const args of [[], [betaRoot, 'unknown.yml'], [betaRoot, '--unknown'], [betaRoot, 'latest.yml', '--require-all-platforms']]) {
    const failure = await spawnCli(script, args)
    assert.notEqual(failure.code, 0)
    assert.match(failure.stderr, /failed/)
  }
})

test('remote CLI validates default/selected feeds, strict mode, and arguments', async t => {
  const { origin } = await serve(t)
  const script = join(scriptDirectory, 'test-update-feed.mjs')
  const baseUrl = `${origin}/beta/`
  const success = await spawnCli(script, [baseUrl, '--allow-local-http', '--require-all-platforms'])
  assert.equal(success.code, 0, success.stderr)
  assert.match(success.stdout, /verified anonymous feed latest.yml/)
  assert.match(success.stdout, /latest-mac.yml/)
  const selected = await spawnCli(script, [baseUrl, '--allow-local-http', '--manifest', 'latest.yml'])
  assert.equal(selected.code, 0, selected.stderr)
  assert.doesNotMatch(selected.stdout, /latest-mac/)
  for (const args of [[], [baseUrl], [baseUrl, '--manifest'], [baseUrl, '--manifest', 'invalid.yml'], [baseUrl, '--allow-local-http', '--unknown'], ['http://example.test/beta/', '--allow-local-http']]) {
    const failure = await spawnCli(script, args)
    assert.notEqual(failure.code, 0)
    assert.match(failure.stderr, /failed/)
  }
})

test('CLI main guards execute when launched through symlinked temporary paths (including macOS /var aliases)', async t => {
  const temporary = await tempDirectory(t)
  const { origin } = await serve(t)
  for (const [name, args, expected] of [
    ['verify-update-manifest.mjs', [betaRoot, '--require-all-platforms'], /verified latest.yml/],
    ['test-update-feed.mjs', [`${origin}/stable/`, '--allow-local-http', '--require-all-platforms'], /verified anonymous feed latest.yml/],
  ]) {
    const linked = join(temporary, name)
    await symlink(join(scriptDirectory, name), linked)
    const result = await spawnCli(linked, args, { cwd: temporary })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, expected)
    const failure = await spawnCli(linked, [], { cwd: temporary })
    assert.notEqual(failure.code, 0, 'guard must execute even for invalid CLI arguments')
    assert.match(failure.stderr, /usage/)
  }
})

test('importing either module performs no CLI work or output', async () => {
  const result = await spawnCli('--input-type=module', ['-e', `await import(${JSON.stringify(join(scriptDirectory, 'verify-update-manifest.mjs'))}); await import(${JSON.stringify(join(scriptDirectory, 'test-update-feed.mjs'))});`], { cwd: resolve(scriptDirectory, '..') })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
