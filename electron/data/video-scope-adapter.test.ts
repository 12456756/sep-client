import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MediaStore } from './media-store'
import { VideoStore } from './video-store'
import { createVideoScopeAdapter } from './video-scope-adapter'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../common/platform/sep-media-gateway-contract'
import { referenceImages } from './media-reference.test-helper'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

test('video references reuse strict member-owned MediaStore manifests across subscriptions', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-owner-'))
  directories.push(root)
  const path = join(root, 'reference.png'), media = new MediaStore(root)
  await writeFile(path, Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64'))
  const adapter = createVideoScopeAdapter(root, media, new VideoStore(root))
  const owner = { enterpriseId: 'enterprise-a', memberId: 'member-a' }
  const scope = { ...owner, subscriptionId: 'subscription-a' }
  const imported = await adapter.references.import(scope, 'task-a', [path], new AbortController().signal, () => {})
  const reference = imported[0]
  const manifest = await media.getAsset(owner, 'task-a', reference.localAssetId)
  assert.deepEqual(manifest?.owner, owner)
  assert.deepEqual(await adapter.references.list({ ...scope, subscriptionId: 'subscription-b' }, 'task-a'), imported)
  assert.deepEqual((await adapter.readReference(scope, 'task-a', reference.localAssetId)).bytes, Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64'))
  assert.deepEqual(await adapter.references.list({ ...scope, memberId: 'member-b' }, 'task-a'), [])
  await assert.rejects(adapter.readReference(scope, 'other-task', reference.localAssetId), { code: 'NOT_FOUND' })
})

test('video imports and reads mixed JPEG, PNG and WebP references without conversion', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-formats-'))
  directories.push(root)
  const paths = referenceImages.map(image => join(root, `reference.${image.extension}`))
  for (const [index, image] of referenceImages.entries()) await writeFile(paths[index]!, image.bytes)
  const adapter = createVideoScopeAdapter(root, new MediaStore(root), new VideoStore(root))
  const scope = { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' }
  const imported = await adapter.references.import(scope, 'task-a', paths, new AbortController().signal, () => {})
  assert.deepEqual(imported.map(asset => asset.mime), referenceImages.map(image => image.mime))
  for (const [index, asset] of imported.entries()) {
    assert.deepEqual((await adapter.readReference(scope, 'task-a', asset.localAssetId)).bytes, referenceImages[index]!.bytes)
  }
})
