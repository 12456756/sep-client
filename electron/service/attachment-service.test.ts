import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { AttachmentStore } from '../data/attachment-store'
import type { TaskOwnerScope } from '../data/scope-path'
import { AttachmentService } from './attachment-service'
import { AppError } from '../errors/app-error'

const ownerA: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const ownerB: TaskOwnerScope = { memberId: 'member-b', enterpriseId: 'enterprise-a' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')

test('imports files, claims draft, freezes task, and resolves durable metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-service-'))
  const source = join(root, 'reference.png')
  await writeFile(source, png)
  let current: TaskOwnerScope | null = ownerA
  const store = new AttachmentStore(root, undefined, async mediaType => ({ status: mediaType === 'image/png' ? 'ready' : 'unsupported', text: 'extracted text', warnings: [] }))
  const service = new AttachmentService(store, () => current)
  const session = await service.beginSession({ kind: 'compose', composerId: 'composer-a' })
  const imported = (await service.importFiles(session.sessionId, 'op-1', [source]))[0]
  const ref = { attachmentId: imported.item.attachmentId, sha256: imported.item.sha256 }
  await service.claimDraft(session.sessionId, 'draft-a', 1, [ref])
  assert.equal(await service.cancelSession(session.sessionId), true)
  const snapshot = await service.freezeDraft('draft-a', 'task-a', [ref])
  const resolved = await service.resolveTaskInputs(ownerA, 'task-a', [ref])
  assert.equal(snapshot.attachments[0]?.attachmentId, ref.attachmentId)
  assert.equal(resolved.attachments[0]?.displayName, 'reference.png')
  assert.equal(resolved.attachments[0]?.mediaType, 'image/png')
  assert.equal(resolved.attachments[0]?.extractedText, 'extracted text')
  assert.equal(resolved.images[0]?.mediaType, 'image/png')
  assert.equal(resolved.images[0]?.width, 1)
  assert.equal(resolved.images[0]?.height, 1)
  assert.ok(resolved.attachments[0]?.readPath)
  current = ownerB
  await assert.rejects(service.resolveTaskInputs(ownerB, 'task-a', [ref]), /ATTACHMENT_REFERENCE_INVALID|ENOENT|ATTACHMENT_NOT_FOUND/)
})

test('appends later task snapshot and keeps the first frozen bytes after source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-service-'))
  const source = join(root, 'note.txt')
  await writeFile(source, 'first')
  const current: TaskOwnerScope | null = ownerA
  const service = new AttachmentService(new AttachmentStore(root), () => current)
  const session = await service.beginSession({ kind: 'conversation', taskId: 'task-b' })
  const first = (await service.importFiles(session.sessionId, 'op-1', [source]))[0].item
  const firstRef = { attachmentId: first.attachmentId, sha256: first.sha256 }
  await service.claimTask(session.sessionId, 'task-b', [firstRef])
  await writeFile(source, 'second')
  const second = (await service.importFiles(session.sessionId, 'op-2', [source]))[0].item
  const secondRef = { attachmentId: second.attachmentId, sha256: second.sha256 }
  await service.claimTask(session.sessionId, 'task-b', [secondRef])
  const resolved = await service.resolveTaskInputs(ownerA, 'task-b', [firstRef, secondRef])
  assert.equal(resolved.attachments.length, 2)
  assert.equal((await (await import('node:fs/promises')).readFile(resolved.attachments[0]!.readPath!)).toString(), 'first')
  assert.equal((await (await import('node:fs/promises')).readFile(resolved.attachments[1]!.readPath!)).toString(), 'second')
})

test('previews only an image claimed by the current task and verifies its digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-preview-'))
  const imagePath = join(root, 'preview.png')
  await writeFile(imagePath, png)
  let current: TaskOwnerScope | null = ownerA
  const store = new AttachmentStore(root)
  const service = new AttachmentService(store, () => current)
  const session = await service.beginSession({ kind: 'conversation', taskId: 'task-preview' })
  const image = (await service.importFiles(session.sessionId, 'op-image', [imagePath]))[0]!.item
  const ref = { attachmentId: image.attachmentId, sha256: image.sha256 }
  await service.claimTask(session.sessionId, 'task-preview', [ref])
  const preview = await service.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256)
  assert.equal(preview.mediaType, 'image/png')
  assert.deepEqual(Buffer.from(preview.bytes), png)
  await assert.rejects(service.previewTaskAttachment('task-preview', ref.attachmentId, 'b'.repeat(64)), /ATTACHMENT_REFERENCE_INVALID/)
  const other = new AttachmentService(new AttachmentStore(root), () => ownerB)
  await assert.rejects(other.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256))
  current = null
  await assert.rejects(service.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256), /AUTH_REQUIRED/)
  current = ownerA
  const readTask = store.readTask.bind(store)
  store.readTask = async (...args) => { const bytes = await readTask(...args); current = ownerB; return bytes }
  await assert.rejects(service.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256), (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED')
  store.readTask = readTask
  current = ownerA
  await writeFile(store.taskReadPath(ownerA, 'task-preview', ref.attachmentId), 'corrupted')
  await assert.rejects(service.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256), /ATTACHMENT_INTEGRITY_MISMATCH/)
})

test('does not preview non-image task attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-preview-'))
  const textPath = join(root, 'note.txt')
  await writeFile(textPath, 'not an image')
  const service = new AttachmentService(new AttachmentStore(root), () => ownerA)
  const session = await service.beginSession({ kind: 'conversation', taskId: 'task-text' })
  const file = (await service.importFiles(session.sessionId, 'op-text', [textPath]))[0]!.item
  const ref = { attachmentId: file.attachmentId, sha256: file.sha256 }
  await service.claimTask(session.sessionId, 'task-text', [ref])
  await assert.rejects(service.previewTaskAttachment('task-text', ref.attachmentId, ref.sha256), /ATTACHMENT_PREVIEW_UNSUPPORTED/)
})
