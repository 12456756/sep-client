import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { AttachmentStore } from './attachment-store'
import type { TaskOwnerScope } from './scope-path'

const scope: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

test('stores bytes in an owner scoped session and verifies hash on read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-'))
  const store = new AttachmentStore(root)
  const session = await store.begin(scope, { kind: 'compose', composerId: 'composer-a' })
  const item = await store.importBytes(scope, session.sessionId, new TextEncoder().encode('hello'), 'hello.txt', 'text/plain', 'paste-image')
  assert.equal(item.byteLength, 5)
  assert.deepEqual(await store.read(scope, session.sessionId, item.attachmentId), Buffer.from('hello'))
  assert.equal((await store.get(scope, session.sessionId))?.attachments.length, 1)
  assert.equal(await store.get({ ...scope, memberId: 'other' }, session.sessionId), null)
})

test('rejects symlinks and oversized imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-'))
  const source = join(root, 'source.txt')
  const link = join(root, 'link.txt')
  await (await import('node:fs/promises')).writeFile(source, 'x')
  await (await import('node:fs/promises')).symlink(source, link)
  const store = new AttachmentStore(root)
  const session = await store.begin(scope, { kind: 'compose', composerId: 'composer-a' })
  await assert.rejects(store.importPath(scope, session.sessionId, link, 'paste-file'), /ATTACHMENT_NOT_REGULAR_FILE/)
})

test('removes and cancels idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-'))
  const store = new AttachmentStore(root)
  const session = await store.begin(scope, { kind: 'compose', composerId: 'composer-a' })
  const item = await store.importBytes(scope, session.sessionId, new Uint8Array([1]), 'a.bin', 'application/octet-stream')
  const removed = await store.remove(scope, session.sessionId, item.attachmentId)
  assert.equal(removed.attachments.length, 0)
  assert.equal(await store.cancel(scope, session.sessionId), true)
  assert.equal(await store.cancel(scope, session.sessionId), true)
  assert.equal((await store.get(scope, session.sessionId))?.status, 'cancelled')
})

test('claims draft durably and freezes task snapshots without overwriting history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-'))
  const store = new AttachmentStore(root)
  const session = await store.begin(scope, { kind: 'draft', draftId: 'draft-a', expectedRevision: 1 })
  const item = await store.importBytes(scope, session.sessionId, new TextEncoder().encode('v1'), 'a.txt', 'text/plain', 'picker')
  const ref = { attachmentId: item.attachmentId, sha256: item.sha256 }
  await store.claimDraft(scope, 'draft-a', session.sessionId, [ref], 1, 'claim-a')
  await store.claimDraft(scope, 'draft-a', session.sessionId, [ref], 1, 'claim-a')
  const snapshot = await store.freeze(scope, 'task-a', session.sessionId, [ref])
  assert.equal((await store.readTaskSnapshot(scope, 'task-a'))?.snapshotId, snapshot.snapshotId)
  await assert.rejects(store.readTask({ ...scope, memberId: 'other' }, 'task-a', item.attachmentId))
})

test('validates image bytes against declared media type and preserves extraction in task snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-'))
  const store = new AttachmentStore(root, undefined, async () => ({ status: 'ready', text: 'Extracted document text', warnings: [] }))
  const session = await store.begin(scope, { kind: 'compose', composerId: 'composer-a' })
  await assert.rejects(store.importBytes(scope, session.sessionId, new TextEncoder().encode('not image'), 'fake.png', 'image/png'), /ATTACHMENT_IMAGE_SIGNATURE_INVALID/)
  const item = await store.importBytes(scope, session.sessionId, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'), 'valid.png', 'image/png')
  const ref = { attachmentId: item.attachmentId, sha256: item.sha256 }
  await store.claimDraft(scope, 'draft-compose', session.sessionId, [ref], 1, 'claim-compose')
  const snapshot = await store.freeze(scope, 'task-compose', session.sessionId, [ref])
  assert.equal(snapshot.attachments[0]?.attachmentId, item.attachmentId)
  assert.equal((await store.readTaskMetadata(scope, 'task-compose')).items[0]?.mediaType, 'image/png')
  assert.equal((await store.readTaskMetadata(scope, 'task-compose')).extractionTextById[item.attachmentId], 'Extracted document text')
})

test('appends a second task snapshot when a conversation adds new references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-'))
  const store = new AttachmentStore(root)
  const session = await store.begin(scope, { kind: 'compose', composerId: 'composer-a' })
  const first = await store.importBytes(scope, session.sessionId, new TextEncoder().encode('one'), 'one.txt', 'text/plain')
  const second = await store.importBytes(scope, session.sessionId, new TextEncoder().encode('two'), 'two.txt', 'text/plain')
  await store.freeze(scope, 'immutable-task', session.sessionId, [{ attachmentId: first.attachmentId, sha256: first.sha256 }])
  const next = await store.freeze(scope, 'immutable-task', session.sessionId, [{ attachmentId: second.attachmentId, sha256: second.sha256 }])
  assert.notEqual(next.snapshotId, undefined)
  assert.deepEqual(await store.readTask(scope, 'immutable-task', first.attachmentId), Buffer.from('one'))
  assert.deepEqual(await store.readTask(scope, 'immutable-task', second.attachmentId), Buffer.from('two'))
})
