import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDevelopmentAssets } from './dev-assets-cache.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(process.env.CSEP_TEST_TEMP ?? tmpdir(), 'dev-assets-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'archive')
  await writeFile(source, 'verified archive')
  const directory = join(root, 'output')
  let preparations = 0
  const options = { directory, sources: [source], outputs: ['tool', 'LICENSE'], platform: 'win32', arch: 'x64',
    prepare: async () => {
      preparations++
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'tool'), 'verified executable')
      await writeFile(join(directory, 'LICENSE'), 'license notice')
    } }
  return { options, source, count: () => preparations }
}

test('development assets reuse verified outputs and invalidate when source or target changes', async t => {
  const f = await fixture(t)
  await prepareDevelopmentAssets(f.options)
  await prepareDevelopmentAssets(f.options)
  assert.equal(f.count(), 1)
  await writeFile(f.source, 'updated verified archive')
  await prepareDevelopmentAssets(f.options)
  assert.equal(f.count(), 2)
  await prepareDevelopmentAssets({ ...f.options, arch: 'arm64' })
  assert.equal(f.count(), 3)
})

test('development assets repair tampered binaries, missing notices and damaged cache metadata', async t => {
  const f = await fixture(t)
  await prepareDevelopmentAssets(f.options)
  await writeFile(join(f.options.directory, 'tool'), 'tampered executable')
  await prepareDevelopmentAssets(f.options)
  assert.equal(await readFile(join(f.options.directory, 'tool'), 'utf8'), 'verified executable')
  await rm(join(f.options.directory, 'LICENSE'))
  await prepareDevelopmentAssets(f.options)
  assert.equal(await readFile(join(f.options.directory, 'LICENSE'), 'utf8'), 'license notice')
  await writeFile(join(f.options.directory, '.sep-dev-assets.json'), '{broken')
  await prepareDevelopmentAssets(f.options)
  assert.equal(f.count(), 4)
})

test('failed preparation never leaves a reusable successful cache', async t => {
  const f = await fixture(t)
  await assert.rejects(prepareDevelopmentAssets({ ...f.options, prepare: async () => { throw new Error('Checksum mismatch') } }), /Checksum mismatch/)
  await prepareDevelopmentAssets(f.options)
  assert.equal(f.count(), 1)
})
