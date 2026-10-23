import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocumentPreviewService } from './document-preview-service'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import type { DocumentPreviewContent } from '../../src/shared/document-preview'

function fixture() {
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'member', enterpriseId: 'enterprise' }
  let status = 'completed'
  let hash = 'a'.repeat(64)
  let renders = 0
  let reads = 0
  let release: (() => void) | undefined
  const file = (): FinalDeliveryFile => ({ id: 'report', path: 'report.md', format: 'md', size: 5, sha256: hash,
    nodeRunId: 'run-1', validatedAt: 1, snapshot: { sha256: hash, size: 5, source: 'confirmed' } })
  const service = new DocumentPreviewService({
    scope: { currentScope: () => scope },
    getDelivery: async (_scope, taskId, nodeId, id) => taskId === 'task' && nodeId === 'node' && id === 'report'
      ? { status, file: file(), workspace: '/unused' } : null,
    read: async () => { reads++; return { bytes: Buffer.from('hello'), source: 'snapshot' as const } },
    render: async (): Promise<DocumentPreviewContent> => { renders++; if (release) await new Promise<void>(resolve => { release = resolve }); return { kind: 'markdown', text: 'hello' } },
  })
  return { service, setScope: (value: typeof scope) => { scope = value }, setStatus: (value: string) => { status = value },
    changeVersion: () => { hash = 'b'.repeat(64) }, counts: () => ({ reads, renders }),
    defer: () => { release = () => undefined }, release: () => release?.() }
}
const request = { taskId: 'task', nodeId: 'node', deliverableId: 'report' }

test('an accepted node can preview while peers are running; repeated opens reuse conversion', async () => {
  const f = fixture()
  assert.equal((await f.service.preview(request)).content.kind, 'markdown')
  await f.service.preview(request)
  assert.deepEqual(f.counts(), { reads: 2, renders: 1 })
  f.changeVersion()
  assert.equal((await f.service.preview(request)).version, 'b'.repeat(64))
  assert.equal(f.counts().renders, 2)
})

test('running/unaccepted nodes, forged identities and unauthenticated users cannot read files', async () => {
  const f = fixture()
  f.setStatus('running')
  await assert.rejects(f.service.preview(request))
  f.setStatus('completed')
  await assert.rejects(f.service.preview({ ...request, nodeId: 'other' }))
  await assert.rejects(f.service.preview({ ...request, taskId: '../other' }))
  f.setScope(null)
  await assert.rejects(f.service.preview(request))
  assert.deepEqual(f.counts(), { reads: 0, renders: 0 })
})

test('account changes discard an in-flight result, without touching task state', async () => {
  const f = fixture()
  f.defer()
  const pending = f.service.preview(request)
  while (!f.counts().renders) await new Promise(resolve => setImmediate(resolve))
  f.setScope({ memberId: 'someone-else', enterpriseId: 'enterprise' })
  f.release()
  await assert.rejects(pending)
})

test('a new accepted version appearing during conversion discards the obsolete result', async () => {
  const f = fixture()
  f.defer()
  const pending = f.service.preview(request)
  while (!f.counts().renders) await new Promise(resolve => setImmediate(resolve))
  f.changeVersion()
  f.release()
  await assert.rejects(pending)
})

test('concurrent opens deduplicate conversion and clearing invalidates already cached content', async () => {
  const f = fixture()
  f.defer()
  const first = f.service.preview(request)
  const second = f.service.preview(request)
  while (f.counts().reads < 2 || !f.counts().renders) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.counts().renders, 1)
  f.release()
  await first; await second
  f.service.clear()
  assert.deepEqual(f.counts(), { reads: 2, renders: 1 })
})
