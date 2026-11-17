import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { parseManifest, verifyUpdateDirectory } from './verify-update-manifest.mjs'
import { prepareDownloadUpdate } from './prepare-download-update.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sep-mac-manifests-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifests = {}
  for (const arch of ['arm64', 'x64']) {
    const files = []
    for (const ext of ['zip', 'dmg']) {
      const url = `SEP-Client-1.2.3-mac-${arch}.${ext}`
      const bytes = Buffer.from(url)
      await writeFile(join(root, url), bytes)
      files.push({ url, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64'), blockMapSize: 12 })
    }
    manifests[arch] = { version: '1.2.3', files, path: files[0].url, sha512: files[0].sha512,
      releaseDate: arch === 'arm64' ? '2026-11-17T10:00:00.000Z' : '2026-11-17T11:00:00.000Z', releaseNotes: 'Release notes' }
  }
  return { root, manifests }
}

async function execute(root, manifests) {
  for (const arch of ['arm64', 'x64']) await writeFile(join(root, `${arch}.yml`), yaml.dump(manifests[arch]))
  return spawnSync(process.execPath, [resolve('scripts/merge-mac-update-manifests.mjs'),
    join(root, 'arm64.yml'), join(root, 'x64.yml'), join(root, 'latest-mac.yml')], { encoding: 'utf8', timeout: 10000 })
}

test('merges parallel Mac manifests without losing files, legacy fields or release notes', async t => {
  const { root, manifests } = await fixture(t)
  const result = await execute(root, manifests)
  assert.equal(result.status, 0, result.stderr)
  const merged = parseManifest(await readFile(join(root, 'latest-mac.yml')), 'latest-mac.yml')
  assert.deepEqual(merged, { ...manifests.x64, files: [...manifests.x64.files, ...manifests.arm64.files] })
  const verified = await verifyUpdateDirectory(root, { manifestName: 'latest-mac.yml' })
  assert.equal(verified[0].files.length, 4)
  for (const arch of ['arm64', 'x64']) assert.deepEqual(yaml.load(await readFile(join(root, `${arch}.yml`), 'utf8')), manifests[arch])
})

test('merged Mac output and Windows artifacts produce a complete three-platform upload plan', async t => {
  const { root, manifests } = await fixture(t)
  const output = `${root}-prepared`
  t.after(() => rm(output, { recursive: true, force: true }))
  const result = await execute(root, manifests)
  assert.equal(result.status, 0, result.stderr)
  const url = 'SEP-Client-1.2.3-win-x64.exe'
  const bytes = Buffer.from(url)
  await writeFile(join(root, url), bytes)
  const windows = { version: '1.2.3', files: [{ url, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }] }
  await writeFile(join(root, 'latest.yml'), yaml.dump(windows))
  for (const file of [...windows.files, ...manifests.arm64.files, ...manifests.x64.files]) {
    await writeFile(join(root, `${file.url}.blockmap`), Buffer.alloc(12))
  }
  await verifyUpdateDirectory(root, { requireAllPlatforms: true })
  const releaseNotesDir = join(root, 'release-notes')
  await mkdir(releaseNotesDir)
  await writeFile(join(releaseNotesDir, '1.2.3.md'), 'Release notes')
  const prepared = await prepareDownloadUpdate({ source: root, output, channel: 'stable', releaseNotesDir })
  assert.equal(prepared.plan.artifacts.length, 10)
  assert.equal(new Set(prepared.plan.artifacts.map(file => file.name)).size, 10)
  const mac = parseManifest(await readFile(join(output, 'latest-mac.yml')), 'latest-mac.yml')
  assert.equal(mac.files.length, 4)
  assert.ok(mac.files.every(file => file.url.startsWith('1.2.3/')))
  assert.equal(mac.releaseNotes, 'Release notes')
})

test('merge CLI rejects missing input manifests and invalid argument counts', async t => {
  const { root } = await fixture(t)
  for (const args of [[], [join(root, 'missing-arm64.yml'), join(root, 'missing-x64.yml'), join(root, 'latest-mac.yml')]]) {
    const result = spawnSync(process.execPath, [resolve('scripts/merge-mac-update-manifests.mjs'), ...args], { encoding: 'utf8', timeout: 10000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /usage:|ENOENT/)
  }
  await assert.rejects(readFile(join(root, 'latest-mac.yml')), { code: 'ENOENT' })
})

for (const [label, mutate, pattern] of [
  ['different versions', m => { m.arm64.version = '1.2.4'; for (const f of m.arm64.files) f.url = f.url.replace('1.2.3', '1.2.4'); m.arm64.path = m.arm64.files[0].url }, /versions must match/],
  ['duplicate architecture', m => { m.arm64 = structuredClone(m.x64) }, /arm64/],
  ['nested artifact paths', m => { m.arm64.files[1].url = `nested/${m.arm64.files[1].url}` }, /root/],
  ['invalid legacy hash', m => { m.arm64.sha512 = m.x64.sha512 }, /legacy sha512/],
  ['different release notes', m => { m.arm64.releaseNotes = 'Other release' }, /releaseNotes/],
]) {
  test(`rejects ${label} before replacing the output manifest`, async t => {
    const { root, manifests } = await fixture(t)
    mutate(manifests)
    await writeFile(join(root, 'latest-mac.yml'), 'previous manifest')
    const result = await execute(root, manifests)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, pattern)
    assert.equal(await readFile(join(root, 'latest-mac.yml'), 'utf8'), 'previous manifest')
  })
}
