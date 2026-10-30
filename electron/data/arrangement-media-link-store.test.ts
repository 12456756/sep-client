import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArrangementMediaLinkStore } from './arrangement-media-link-store'
import { ScopePath } from './scope-path'
import type { ArrangementMediaLink } from '../domain/arrangement-media'

const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const roots: string[] = []
const link = (overrides: Partial<ArrangementMediaLink> = {}): ArrangementMediaLink => ({
  version: 1, owner: scope, taskId: 'task-a', arrangementRunId: 'run-a', nodeId: 'image', nodeRunId: 'node-run-a', attempt: 1,
  subscriptionId: 'sub-a', kind: 'image', operation: 'generate', jobId: 'job-a', inputs: [],
  outputs: [{ artifactId: 'img_1', sha256: 'a'.repeat(64), status: 'saved' }], materializations: [], createdAt: 1, updatedAt: 1,
  ...overrides,
})

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('ArrangementMediaLinkStore', () => {
  it('persists task-scoped media links and replaces the same attempt idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    const store = new ArrangementMediaLinkStore(root)
    await store.upsert(scope, link())
    await store.upsert(scope, link({ updatedAt: 2 }))
    assert.deepEqual((await store.list(scope, 'task-a')).map(item => item.outputs[0]?.sha256), ['a'.repeat(64)])
    assert.equal((await store.get(scope, 'task-a', 'image', 'job-a'))?.updatedAt, 2)
    assert.deepEqual(await store.list({ memberId: 'other', enterpriseId: scope.enterpriseId }, 'task-a'), [])
  })

  it('keeps independent attempts and rejects cross-scope links or invalid relations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    const store = new ArrangementMediaLinkStore(root)
    await store.upsert(scope, link({ nodeRunId: 'node-run-b', attempt: 2, jobId: 'job-b', nodeId: 'video', kind: 'video', operation: 'image-to-video', inputs: [{ artifactId: 'img_1', sha256: 'a'.repeat(64), sourceNodeId: 'image' }], outputs: [{ artifactId: 'video_1', status: 'pending' }] }))
    assert.equal((await store.list(scope, 'task-a')).length, 1)
    await assert.rejects(() => store.upsert(scope, link({ owner: { memberId: 'other', enterpriseId: scope.enterpriseId } })))
    await assert.rejects(() => store.upsert(scope, link({ materializations: [{ deliverableId: 'video', path: 'video.mp4', sourceArtifactId: 'missing', status: 'pending' }] })))
  })

  it('preserves unreadable evidence and refuses to overwrite a corrupt index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    const store = new ArrangementMediaLinkStore(root)
    await store.upsert(scope, link())
    const file = new ScopePath(root).arrangementMediaLinksFile(scope, 'task-a')
    const content = JSON.stringify([{ ...link(), owner: { memberId: 'other', enterpriseId: scope.enterpriseId } }])
    await writeFile(file, content)
    await assert.rejects(store.list(scope, 'task-a'), /unavailable/)
    await assert.rejects(store.upsert(scope, link()), /unavailable/)
    assert.equal(await readFile(file, 'utf8'), content)
  })

  it('rejects rebinding a job, changing known hashes, deleting outputs and stale updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    const store = new ArrangementMediaLinkStore(root)
    await store.upsert(scope, link({ updatedAt: 5 }))
    for (const change of [
      { nodeRunId: 'different-run' }, { subscriptionId: 'different-employee' },
      { inputs: [{ artifactId: 'other', sha256: 'b'.repeat(64) }] },
      { outputs: [{ artifactId: 'img_1', sha256: 'b'.repeat(64), status: 'saved' as const }] },
      { outputs: [] }, { updatedAt: 4 },
    ]) await assert.rejects(store.upsert(scope, link({ updatedAt: 6, ...change })))
    assert.deepEqual(await store.list(scope, 'task-a'), [link({ updatedAt: 5 })])
  })

  it('preserves simultaneous jobs from different store instances for one node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    await Promise.all(Array.from({ length: 20 }, (_, index) => new ArrangementMediaLinkStore(root).upsert(scope,
      link({ jobId: 'job-' + index, outputs: [{ artifactId: 'img_' + index, sha256: 'a'.repeat(64), status: 'saved' }] }),
    )))
    const store = new ArrangementMediaLinkStore(root)
    assert.equal((await store.list(scope, 'task-a')).length, 20)
    assert.equal((await store.get(scope, 'task-a', 'image', 'job-17'))?.outputs[0]?.artifactId, 'img_17')
    assert.deepEqual(await store.list(scope, 'other-task'), [])
  })

  it('only rebinds pending materializations that have never recorded a verified hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    const store = new ArrangementMediaLinkStore(root)
    const outputs: ArrangementMediaLink['outputs'] = [
      { artifactId: 'img_1', sha256: 'a'.repeat(64), status: 'saved' },
      { artifactId: 'img_2', sha256: 'b'.repeat(64), status: 'saved' },
    ]
    const pending = { deliverableId: 'image', path: 'image.png', sourceArtifactId: 'img_1', status: 'pending' as const }
    await store.upsert(scope, link({ outputs, materializations: [pending] }))
    const verified = { ...pending, sourceArtifactId: 'img_2', sha256: 'b'.repeat(64), status: 'saved' as const }
    await store.upsert(scope, link({ outputs, materializations: [verified], updatedAt: 2 }))
    await store.upsert(scope, link({ outputs, materializations: [{ ...verified, status: 'pending' }], updatedAt: 3 }))
    await assert.rejects(store.upsert(scope, link({ outputs, materializations: [{ ...pending, sha256: 'a'.repeat(64) }], updatedAt: 4 })))
    assert.equal((await store.get(scope, 'task-a', 'image', 'job-a'))!.materializations[0]!.sourceArtifactId, 'img_2')
  })

  it('rejects invalid operations, duplicate materializations and unsafe target paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    const store = new ArrangementMediaLinkStore(root)
    await assert.rejects(store.upsert(scope, link({ kind: 'video', operation: 'generate' })))
    const materialization = { deliverableId: 'image', path: 'image.png', sourceArtifactId: 'img_1', sha256: 'a'.repeat(64), status: 'saved' as const }
    await assert.rejects(store.upsert(scope, link({ materializations: [{ ...materialization, path: '../outside.png' }] })))
    await assert.rejects(store.upsert(scope, link({ materializations: [materialization, materialization] })))
    await assert.rejects(store.upsert(scope, link({ materializations: [{ ...materialization, sha256: 'b'.repeat(64) }] })))
  })

  it('recovers a valid backup without treating damaged evidence as an empty index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-media-links-'))
    roots.push(root)
    const store = new ArrangementMediaLinkStore(root)
    await store.upsert(scope, link())
    await store.upsert(scope, link({ updatedAt: 2 }))
    const file = new ScopePath(root).arrangementMediaLinksFile(scope, 'task-a')
    await writeFile(file, 'broken')
    assert.deepEqual(await store.list(scope, 'task-a'), [link()])
  })
})
