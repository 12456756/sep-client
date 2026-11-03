import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocumentPreviewService } from './document-preview-service'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import type { DocumentPreviewContent } from '../../src/shared/document-preview'

function fixture(overrides: Partial<Pick<ConstructorParameters<typeof DocumentPreviewService>[0], 'getDeliveryPath' | 'getConversationPath' | 'openFileDirectory'>> = {}) {
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'member', enterpriseId: 'enterprise' }
  let status = 'completed'
  let hash = 'a'.repeat(64)
  let renders = 0
  let reads = 0
  const opened: string[] = []
  let release: (() => void) | undefined
  const file = (): FinalDeliveryFile => ({ id: 'report', path: 'report.md', format: 'md', size: 5, sha256: hash,
    nodeRunId: 'run-1', validatedAt: 1, snapshot: { sha256: hash, size: 5, source: 'confirmed' } })
  const service = new DocumentPreviewService({
    scope: { currentScope: () => scope },
    getDelivery: async (_scope, taskId, nodeId, id) => taskId === 'task' && nodeId === 'node' && id === 'report'
      ? { status, file: file(), workspace: '/unused' } : null,
    getDeliveryPath: async (_scope, taskId, nodeId, id) => taskId === 'task' && nodeId === 'node' && id === 'report' && status === 'completed' ? '/work/report.md' : null,
    getConversationPath: async (_scope, taskId, fileId) => taskId === 'task' && fileId === 'task-file-0' ? '/work/report.md' : null,
    openFileDirectory: async path => { opened.push(path) },
    read: async () => { reads++; return { bytes: Buffer.from('hello'), source: 'snapshot' as const } },
    render: async (): Promise<DocumentPreviewContent> => { renders++; if (release) await new Promise<void>(resolve => { release = resolve }); return { kind: 'markdown', text: 'hello' } },
    ...overrides,
  })
  return { service, setScope: (value: typeof scope) => { scope = value }, setStatus: (value: string) => { status = value },
    changeVersion: () => { hash = 'b'.repeat(64) }, counts: () => ({ reads, renders }),
    defer: () => { release = () => undefined }, release: () => release?.(), opened }
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

test('opens only registered completed output directories and requires authentication', async () => {
  const f = fixture()
  await f.service.openDirectory(request)
  await f.service.openDirectory(conversationRequest)
  assert.deepEqual(f.opened, ['/work/report.md', '/work/report.md'])
  f.setStatus('running')
  await assert.rejects(f.service.openDirectory(request))
  f.setScope(null)
  await assert.rejects(f.service.openDirectory(conversationRequest))
  assert.equal(f.opened.length, 2)
})

test('never opens an obsolete account directory after an in-flight lookup completes or fails', async () => {
  for (const input of [request, { taskId: 'task', fileId: 'task-file-0' }]) {
    for (const outcome of ['success', 'error', 'clear'] as const) {
      let resolve!: (path: string) => void
      let reject!: (error: Error) => void
      const lookup = new Promise<string>((done, fail) => { resolve = done; reject = fail })
      const f = fixture({ getConversationPath: () => lookup, getDeliveryPath: () => lookup })
      const pending = f.service.openDirectory(input)
      if (outcome === 'clear') f.service.clear()
      else f.setScope({ memberId: 'other', enterpriseId: 'enterprise' })
      if (outcome === 'error') reject(new Error('private filesystem diagnostics'))
      else resolve('/work/report.md')
      await assert.rejects(pending, { code: 'AUTH_REQUIRED' })
      assert.deepEqual(f.opened, [])
    }
  }
})

test('wraps directory opener failures without exposing filesystem diagnostics', async () => {
  const f = fixture({ openFileDirectory: async () => { throw new Error('private filesystem diagnostics') } })
  await assert.rejects(f.service.openDirectory(request), error => {
    assert.equal((error as { code: string }).code, 'INTERNAL_ERROR')
    assert.doesNotMatch((error as Error).message, /private/)
    return true
  })
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

function conversationFixture() {
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'member', enterpriseId: 'enterprise' }
  let version = 'a'.repeat(64)
  let available = true
  let renders = 0
  let release: (() => void) | undefined
  const service = new DocumentPreviewService({
    scope: { currentScope: () => scope },
    getDelivery: async () => null,
    getDeliveryPath: async () => null,
    openFileDirectory: async () => undefined,
    read: async () => { throw new Error('Conversation must not use node delivery reads') },
    readConversation: async (_scope, taskId, fileId) => available && taskId === 'task' && fileId === 'task-file-0'
      ? { name: 'report.md', format: 'md', version, bytes: Buffer.from('# conversation') } : null,
    render: async (): Promise<DocumentPreviewContent> => {
      renders++
      if (release) await new Promise<void>(resolve => { release = resolve })
      return { kind: 'markdown', text: '# conversation' }
    },
  })
  return { service, renders: () => renders, changeVersion: () => { version = 'b'.repeat(64) },
    remove: () => { available = false }, changeScope: () => { scope = { memberId: 'other', enterpriseId: 'enterprise' } },
    defer: () => { release = () => undefined }, release: () => release?.() }
}

const conversationRequest = { taskId: 'task', fileId: 'task-file-0' }

test('conversation previews reuse conversion but read and verify the current task file on every open', async () => {
  const f = conversationFixture()
  const result = await f.service.preview(conversationRequest)
  assert.equal(result.content.kind, 'markdown')
  assert.equal(result.source, 'conversation-file')
  assert.equal(result.name, 'report.md')
  await f.service.preview(conversationRequest)
  assert.equal(f.renders(), 1)
  f.changeVersion()
  assert.equal((await f.service.preview(conversationRequest)).version, 'b'.repeat(64))
  assert.equal(f.renders(), 2)
  f.remove()
  await assert.rejects(f.service.preview(conversationRequest))
})

test('conversation previews reject forged file identities and discard in-flight account, file and cache changes', async () => {
  const f = conversationFixture()
  await assert.rejects(f.service.preview({ ...conversationRequest, fileId: 'other-file-0' }))
  assert.equal(f.renders(), 0)
  for (const change of ['changeScope', 'changeVersion', 'remove', 'clear'] as const) {
    const pendingFixture = conversationFixture()
    pendingFixture.defer()
    const pending = pendingFixture.service.preview(conversationRequest)
    await Promise.race([pending, (async () => {
      while (!pendingFixture.renders()) await new Promise(resolve => setImmediate(resolve))
    })()])
    if (change === 'clear') pendingFixture.service.clear()
    else pendingFixture[change]()
    pendingFixture.release()
    await assert.rejects(pending)
  }
})
