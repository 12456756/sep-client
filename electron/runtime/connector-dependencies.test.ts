import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { ConnectorAssetStore } from '../data/connector-asset-store'
import { connectorDependencySchema } from '../domain/connector-dependencies'
import { ConnectorDependencies } from './connector-dependencies'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'connector-dependency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const contents = { 'tool.exe': strToU8('verified-native-code'), LICENSE: strToU8('fixture license') }
  const archive = zipSync(contents)
  const component = connectorDependencySchema.parse({ id: 'feishu', version: '1.0.100', platform: 'win32', arch: 'x64',
    binary: 'tool.exe', archive: 'component.zip', sha256: sha256(archive), bytes: archive.length,
    files: Object.entries(contents).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha256(bytes) })),
  })
  return { root, archive, component, store: new ConnectorAssetStore(root, component) }
}

test('downloads once for concurrent consumers, validates cache and repairs tampering', async t => {
  const { archive, store } = await fixture(t)
  let downloads = 0
  const dependency = new ConnectorDependencies(store, async (url, init) => {
    downloads++
    assert.equal(String(url), 'https://sep.longdaoec.com/sep-client/stable/connector-assets/component.zip')
    assert.equal(init?.redirect, 'error')
    return new Response(Uint8Array.from(archive))
  })
  const progress: string[] = []
  await Promise.all([dependency.ensure(new AbortController().signal, value => progress.push(value.phase)), dependency.ensure(new AbortController().signal, () => {})])
  assert.equal(downloads, 1)
  assert.ok(progress.includes('downloading') && progress.includes('verifying'))
  assert.equal(await readFile(store.path('tool.exe'), 'utf8'), 'verified-native-code')
  await dependency.ensure(new AbortController().signal, () => {})
  assert.equal(downloads, 1)
  await writeFile(store.path('tool.exe'), 'tampered')
  await dependency.ensure(new AbortController().signal, () => {})
  assert.equal(downloads, 2)
  assert.equal(await store.ready(), true)
})

test('rejects truncated, oversized or hash-mismatched downloads and allows retry', async t => {
  const { archive, store } = await fixture(t)
  let bytes = archive.slice(1)
  const dependency = new ConnectorDependencies(store, async () => new Response(Uint8Array.from(bytes)))
  await assert.rejects(dependency.ensure(new AbortController().signal, () => {}), /Incomplete/)
  assert.equal(await store.ready(), false)
  bytes = new Uint8Array(archive.length + 1)
  await assert.rejects(dependency.ensure(new AbortController().signal, () => {}), /exceeds/)
  bytes = new Uint8Array(archive.length)
  await assert.rejects(dependency.ensure(new AbortController().signal, () => {}), /checksum/)
  bytes = archive
  await dependency.ensure(new AbortController().signal, () => {})
  assert.equal(await store.ready(), true)
})

test('cancelling one consumer keeps another download alive; cancelling all aborts the request', async t => {
  const { archive, store } = await fixture(t)
  let release!: () => void
  let requestSignal: AbortSignal | undefined
  let started!: () => void
  const start = new Promise<void>(resolve => { started = resolve })
  const dependency = new ConnectorDependencies(store, async (_url, init) => {
    requestSignal = init?.signal ?? undefined
    started()
    await new Promise<void>(resolve => { release = resolve })
    return new Response(Uint8Array.from(archive))
  })
  const first = new AbortController()
  const second = new AbortController()
  const one = dependency.ensure(first.signal, () => {})
  const two = dependency.ensure(second.signal, () => {})
  await start
  first.abort()
  await assert.rejects(one, /cancelled/)
  assert.equal(requestSignal?.aborted, false)
  second.abort()
  await assert.rejects(two, /cancelled/)
  assert.equal(requestSignal?.aborted, true)
  release()
})

test('archive extraction accepts only bounded, declared flat files', async t => {
  const { root, component } = await fixture(t)
  const bad = zipSync({ '../escape.exe': strToU8('malicious') })
  const store = new ConnectorAssetStore(root, { ...component, sha256: sha256(bad), bytes: bad.length })
  await assert.rejects(store.install(bad, new AbortController().signal), /Unexpected/)
  assert.equal(await store.ready(), false)
  assert.throws(() => connectorDependencySchema.parse({ ...component, files: [{ ...component.files[0], name: '../escape' }] }))
  assert.throws(() => connectorDependencySchema.parse({ ...component, files: [component.files[0], component.files[0]] }))
})
