import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { ArrangementMediaAssets } from './arrangement-media-assets'

it('maps only task-owned verified image attachments into durable media references', async () => {
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const ref = { attachmentId: 'att', sha256: 'a'.repeat(64) }
  const calls: unknown[] = []
  const images = { async importReference(...args: unknown[]) { calls.push(args.slice(0, 3)); return { localAssetId: 'reference-hash', sha256: ref.sha256 } } }
  const inputs = { async resolveTaskInputs(...args: unknown[]) { calls.push(args); return { attachments: [{ ...ref, mediaType: 'image/png', readPath: '/private/snapshot/source' }], images: [], digest: 'digest' } } }
  const adapter = new ArrangementMediaAssets('/tmp/attachment-media-test', images as never, undefined, inputs as never)
  assert.deepEqual(await adapter.attachmentReference(scope, 'task', ref, new AbortController().signal, () => {}), { artifactId: 'reference-hash', sha256: ref.sha256 })
  assert.deepEqual(calls, [[scope, 'task', [ref]], [scope, 'task', '/private/snapshot/source']])
})

it('refuses non-image input or changed media content', async () => {
  const ref = { attachmentId: 'att', sha256: 'a'.repeat(64) }
  for (const mediaType of ['text/plain', 'image/png']) {
    const adapter = new ArrangementMediaAssets('/tmp/attachment-media-test', { async importReference() { return { localAssetId: 'asset', sha256: 'b'.repeat(64) } } } as never, undefined,
      { async resolveTaskInputs() { return { attachments: [{ ...ref, mediaType, readPath: '/private/source' }], images: [], digest: '' } } } as never)
    await assert.rejects(adapter.attachmentReference({ memberId: 'member', enterpriseId: 'enterprise' }, 'task', ref, new AbortController().signal, () => {}))
  }
})
