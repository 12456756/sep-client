import * as assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoReferenceStore } from './video-reference-store'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const scope = { enterpriseId: 'ent', memberId: 'member', subscriptionId: 'sub' }
const support = { maxCount: 3, maxInputBytes: 1024, mimeTypes: ['video/mp4', 'video/quicktime'] as ('video/mp4' | 'video/quicktime')[] }
const signal = new AbortController().signal
const validate = () => {}
async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-vref-')); roots.push(root)
  const mp4 = Buffer.alloc(32); mp4.writeUInt32BE(24, 0); mp4.write('ftypisom', 4)
  const mov = Buffer.from(mp4); mov.write('qt  ', 8)
  const paths = [join(root, 'second.mp4'), join(root, 'first.mov')]
  await writeFile(paths[0], mp4); await writeFile(paths[1], mov)
  return { root, paths, mp4, mov, store: new VideoReferenceStore(root) }
}
test('imports MP4/MOV originals in order, verifies streaming reads and keeps mappings scoped', async () => {
  const f = await setup()
  const assets = await f.store.import(scope, 'task', f.paths, support, signal, validate)
  assert.deepEqual(assets.map(asset => asset.mime), ['video/mp4', 'video/quicktime'])
  assert.deepEqual((await f.store.list(scope, 'task')).map(asset => asset.name), ['second.mp4', 'first.mov'])
  assert.deepEqual(Buffer.from(await (await f.store.open(scope, 'task', assets[0].localAssetId)).file.arrayBuffer()), f.mp4)
  const uploaded = { mock: false as const, kind: 'video' as const, referenceId: 'remote-id', profileId: 'profile', configVersion: 'cfg',
    mimeType: 'video/mp4' as const, sha256: assets[0].sha256, byteLength: 32, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  await f.store.saveUpload(scope, 'task', assets[0].localAssetId, uploaded)
  assert.equal((await new VideoReferenceStore(f.root).list(scope, 'task'))[0].uploaded?.referenceId, 'remote-id')
  const otherSubscription = await f.store.list({ ...scope, subscriptionId: 'other' }, 'task')
  assert.equal(otherSubscription.length, 2)
  assert.equal(otherSubscription[0].uploaded, undefined)
  assert.deepEqual(await f.store.list({ ...scope, memberId: 'other-member' }, 'task'), [])
  await assert.rejects(f.store.open(scope, 'other-task', assets[0].localAssetId))
  await assert.rejects(f.store.saveUpload(scope, 'task', assets[0].localAssetId, { ...uploaded, sha256: '0'.repeat(64) }))
  await f.store.remove(scope, 'task', assets[0].localAssetId)
  assert.equal((await f.store.list(scope, 'task')).length, 1)
})
test('rejects count, bytes, MIME, extension spoofing, traversal and cancellation', async () => {
  const f = await setup()
  await assert.rejects(f.store.import(scope, 'task', [...f.paths, ...f.paths], support, signal, validate))
  await assert.rejects(f.store.import(scope, 'task', [f.paths[0]], { ...support, maxInputBytes: 16 }, signal, validate))
  await assert.rejects(f.store.import(scope, 'task', [f.paths[0]], { ...support, mimeTypes: ['video/quicktime'] }, signal, validate))
  await writeFile(f.paths[0], f.mov)
  await assert.rejects(f.store.import(scope, 'task', [f.paths[0]], support, signal, validate))
  await assert.rejects(f.store.import(scope, '../escape', [f.paths[1]], support, signal, validate))
  await assert.rejects(f.store.import(scope, 'task', [f.paths[1]], support, AbortSignal.abort(), validate))
  assert.deepEqual(await f.store.list(scope, 'task'), [])
})
