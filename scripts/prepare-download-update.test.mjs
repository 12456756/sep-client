import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { parseArguments, prepareDownloadUpdate } from './prepare-download-update.mjs'

async function fixture(t, version = '1.2.3') {
  const root = await mkdtemp(join(tmpdir(), 'sep-download-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const output = join(root, 'prepared')
  await mkdir(source)
  const names = [
    `SEP-Client-${version}-win-x64.exe`, `SEP-Client-${version}-win-x64.exe.blockmap`,
    ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].flatMap(ext => [
      `SEP-Client-${version}-mac-${arch}.${ext}`, `SEP-Client-${version}-mac-${arch}.${ext}.blockmap`,
    ])),
  ]
  const files = new Map()
  for (const name of names) {
    const bytes = Buffer.from(`fixture:${name}`)
    files.set(name, bytes)
    await writeFile(join(source, name), bytes)
  }
  const entry = name => ({
    url: name,
    sha512: createHash('sha512').update(files.get(name)).digest('base64'),
    size: files.get(name).length,
    blockMapSize: files.get(`${name}.blockmap`)?.length ?? 0,
  })
  const win = `SEP-Client-${version}-win-x64.exe`
  const macArm = `SEP-Client-${version}-mac-arm64.zip`
  const macX64 = `SEP-Client-${version}-mac-x64.zip`
  await writeFile(join(source, 'latest.yml'), yaml.dump({
    version, files: [entry(win)], path: win, sha512: entry(win).sha512, releaseDate: '2026-10-27T00:00:00.000Z',
  }))
  await writeFile(join(source, 'latest-mac.yml'), yaml.dump({
    version, files: [entry(macArm), entry(macX64)], path: macArm, sha512: entry(macArm).sha512,
    releaseDate: '2026-10-27T00:00:00.000Z',
  }))
  return { root, source, output, version, names }
}

test('prepares versioned root manifests and a non-approved upload plan without copying artifacts', async t => {
  const { source, output, version, names } = await fixture(t)
  const result = await prepareDownloadUpdate({ source, output, channel: 'stable' })
  assert.equal(result.version, version)
  for (const manifestName of ['latest.yml', 'latest-mac.yml']) {
    const manifest = yaml.load(await readFile(join(output, manifestName), 'utf8'))
    assert.ok(manifest.files.every(file => file.url === `${version}/${basename(file.url)}`))
    assert.equal(manifest.path, `${version}/${basename(manifest.path)}`)
  }
  const plan = JSON.parse(await readFile(join(output, 'upload-plan.json'), 'utf8'))
  assert.deepEqual({ mode: plan.mode, releaseApproved: plan.releaseApproved, signatureVerified: plan.signatureVerified }, {
    mode: 'unsigned-download-update', releaseApproved: false, signatureVerified: false,
  })
  assert.equal(plan.channel, 'stable')
  assert.equal(plan.version, version)
  assert.deepEqual(plan.artifacts.map(item => item.name), [...names].sort((a, b) => a.localeCompare(b, 'en')))
  assert.ok(plan.artifacts.every(item => item.destination === `${version}/${item.name}` && item.size > 0 && /^[a-f0-9]{64}$/.test(item.sha256)))
  assert.deepEqual(plan.publishLast, ['latest.yml', 'latest-mac.yml'])
  for (const name of names) await assert.rejects(readFile(join(output, name)), error => error.code === 'ENOENT')
})

test('rejects a modified artifact before creating output', async t => {
  const { source, output, version } = await fixture(t)
  await writeFile(join(source, `SEP-Client-${version}-win-x64.exe`), 'changed bytes')
  await assert.rejects(prepareDownloadUpdate({ source, output, channel: 'beta' }), /size mismatch|SHA512 hash mismatch/)
  await assert.rejects(readFile(output), error => error.code === 'ENOENT' || error.code === 'EISDIR')
})

test('requires matching platform manifests and a fresh disjoint output directory', async t => {
  const { root, source, output } = await fixture(t)
  const other = await fixture(t, '1.2.4')
  await cp(join(other.source, 'latest-mac.yml'), join(source, 'latest-mac.yml'))
  await assert.rejects(prepareDownloadUpdate({ source, output, channel: 'stable' }), /versions must match/)

  const fresh = await fixture(t)
  await mkdir(fresh.output)
  await assert.rejects(prepareDownloadUpdate({ source: fresh.source, output: fresh.output, channel: 'stable' }), /output already exists/)
  await assert.rejects(prepareDownloadUpdate({ source: fresh.source, output: join(fresh.source, 'nested'), channel: 'stable' }), /disjoint/)
  await assert.rejects(prepareDownloadUpdate({ source: fresh.source, output: root, channel: 'stable' }), /output already exists|disjoint/)
})

test('rejects incomplete local packages and invalid CLI arguments', async t => {
  const { source, output, version } = await fixture(t)
  await unlink(join(source, `SEP-Client-${version}-mac-x64.dmg`))
  await assert.rejects(prepareDownloadUpdate({ source, output, channel: 'stable' }), /required local package artifact is missing/)
  assert.deepEqual(parseArguments(['dist/local/beta', 'beta', '.release/prepared']), {
    source: 'dist/local/beta', channel: 'beta', output: '.release/prepared',
  })
  for (const args of [[], ['source', 'preview', 'output'], ['source', 'stable'], ['--source', 'stable', 'output']]) {
    assert.throws(() => parseArguments(args), /usage:/)
  }
})
