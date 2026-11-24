import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientRelease, parseClientRelease, readClientRelease } from './client-release-manifest.mjs'

const feed = 'https://sep.longdaoec.com/sep-client/stable/'
const version = '1.2.3'
const artifacts = ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe'].map(suffix => {
  const name = `SEP-Client-${version}-${suffix}`
  return { name, destination: `${version}/${name}`, url: `${feed}${version}/${name}` }
})
const plan = { version, feed, artifacts }

test('website catalog is generated from verified release artifacts, not previous website data', () => {
  const release = createClientRelease(plan)
  assert.equal(release.version, version)
  assert.equal(release.artifacts.length, 3)
  assert.deepEqual(parseClientRelease(JSON.stringify(release), plan), release)
  assert.throws(() => createClientRelease({ ...plan, artifacts: artifacts.slice(1) }), /installer/)
  assert.throws(() => createClientRelease({ ...plan, version: '../bad' }), /version/)
  assert.throws(() => createClientRelease({ ...plan, feed: 'https://foreign.test/' }), /feed/)
})

test('rejects stale versions, duplicate platforms, foreign URLs, mismatched filenames and invalid JSON', () => {
  const release = createClientRelease(plan)
  for (const change of [
    value => { value.version = '1.2.2' },
    value => { value.artifacts[0].url = value.artifacts[0].url.replace('/1.2.3/', '/1.2.2/') },
    value => { value.artifacts[0].url = 'https://foreign.test/file.dmg' },
    value => { value.artifacts[0].fileName = 'wrong.dmg' },
    value => { value.artifacts[1] = value.artifacts[0] },
    value => { value.artifacts.pop() },
  ]) {
    const modified = structuredClone(release)
    change(modified)
    assert.throws(() => parseClientRelease(JSON.stringify(modified), plan), /catalog/)
  }
  assert.throws(() => parseClientRelease('{', plan), /catalog/)
  assert.throws(() => parseClientRelease(' '.repeat(65537), plan), /catalog/)
})

test('catalog files must be regular, nonempty, bounded and match the current release', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sep-catalog-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'client-release.json')
  await assert.rejects(readClientRelease(directory, plan), { code: 'ENOENT' })
  for (const text of ['', ' '.repeat(65537)]) {
    await writeFile(file, text)
    await assert.rejects(readClientRelease(directory, plan), /Unsafe or oversized/)
  }
  const catalog = createClientRelease(plan)
  await writeFile(file, JSON.stringify(catalog))
  assert.deepEqual(await readClientRelease(directory, plan), catalog)
  await rm(file)
  await mkdir(file)
  await assert.rejects(readClientRelease(directory, plan), /Unsafe or oversized/)
})
