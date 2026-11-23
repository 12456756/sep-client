import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
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

test('an MP4 picked as a single file is video material and bypasses text extraction', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-attachment-media-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, '素材.MP4')
  await writeFile(path, 'sample bytes; container validation belongs to ffprobe')
  const service = new AttachmentService(new AttachmentStore(root, undefined, async () => assert.fail('unexpected text extraction')), () => ownerA)
  const session = await service.beginSession({ kind: 'compose', composerId: 'video-test' })
  const { item } = (await service.importFiles(session.sessionId, 'picker-test', [path]))[0]
  assert.equal(item.mediaType, 'video/mp4')
  assert.equal(item.extractionStatus, 'not-required')
  assert.deepEqual(item.warnings, [])
})

test('folder preview lists first-level media and only imports the confirmed scoped selection', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-folder-media-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, '素材')
  await mkdir(join(source, 'nested'), { recursive: true })
  const clip = join(source, 'clip.mp4')
  const large = join(source, 'large.mp4')
  await Promise.all([
    writeFile(clip, 'first clip'), writeFile(large, ''), writeFile(join(source, 'track.mp3'), 'audio'),
    writeFile(join(source, 'product.png'), png), writeFile(join(source, 'empty.wav'), ''),
    writeFile(join(source, 'notes.txt'), 'not media'), writeFile(join(source, 'nested', 'hidden.mp4'), 'not listed'),
  ])
  await truncate(large, 20 * 1024 * 1024 + 1)
  await symlink(join(source, 'nested'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  let owner = ownerA
  const service = new AttachmentService(new AttachmentStore(root), () => owner)
  const session = await service.beginSession({ kind: 'compose', composerId: 'folder-a' })
  const otherSession = await service.beginSession({ kind: 'compose', composerId: 'folder-b' })
  await assert.rejects(service.previewFolder(session.sessionId, join(root, 'link')), /ATTACHMENT_FOLDER_UNAVAILABLE/)
  const preview = await service.previewFolder(session.sessionId, source)
  assert.equal(preview.folderName, '素材')
  assert.deepEqual(preview.candidates.map(({ name, kind, unavailable }) => [name, kind, unavailable]), [
    ['clip.mp4', 'video', undefined], ['empty.wav', 'audio', 'empty'], ['large.mp4', 'video', 'too-large'],
    ['product.png', 'image', undefined], ['track.mp3', 'audio', undefined],
  ])
  assert.equal(JSON.stringify(preview).includes(root), false)
  assert.deepEqual((await service.listSession(session.sessionId))?.attachments, [])
  const videoId = preview.candidates[0].id
  await assert.rejects(service.importFolderSelection(otherSession.sessionId, preview.previewId, [videoId]), /ATTACHMENT_FOLDER_PREVIEW_EXPIRED/)
  owner = ownerB
  await assert.rejects(service.importFolderSelection(session.sessionId, preview.previewId, [videoId]), /ATTACHMENT_SESSION_EXPIRED/)
  owner = ownerA
  await assert.rejects(service.importFolderSelection(session.sessionId, preview.previewId, [preview.candidates[2].id]), /ATTACHMENT_TOO_LARGE/)
  const imported = await service.importFolderSelection(session.sessionId, preview.previewId, [videoId, preview.candidates[3].id])
  assert.deepEqual(imported.attachments.map(item => [item.displayName, item.mediaType]), [['clip.mp4', 'video/mp4'], ['product.png', 'image/png']])
  await assert.rejects(service.importFolderSelection(session.sessionId, preview.previewId, [videoId]), /ATTACHMENT_FOLDER_PREVIEW_EXPIRED/)
  const updated = await service.previewFolder(session.sessionId, source)
  await writeFile(clip, 'source changed after preview')
  await assert.rejects(service.importFolderSelection(session.sessionId, updated.previewId, [updated.candidates[0].id]), /ATTACHMENT_FOLDER_CHANGED/)
  assert.equal((await service.listSession(session.sessionId))?.attachments.length, 2)
})

test('resolves scoped reference excerpts from imported bytes and rejects stale digests and sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-reference-material-'))
  let owner = ownerA
  const service = new AttachmentService(new AttachmentStore(root, undefined, async (_type, bytes) => ({ status: 'ready', text: Buffer.from(bytes).toString(), warnings: [] })), () => owner)
  const session = await service.beginSession({ kind: 'compose', composerId: 'reference-compose' })
  const path = join(root, 'brief.txt')
  await writeFile(path, 'a'.repeat(4_500))
  const { attachmentId, sha256 } = (await service.importFiles(session.sessionId, 'op-ref', [path]))[0].item
  const request = { sessionId: session.sessionId, attachments: [{ attachmentId, sha256 }] }
  await writeFile(path, 'source changed')
  assert.deepEqual(await service.referenceMaterials(ownerA, request), [{ name: 'brief.txt', text: 'a'.repeat(4_000), truncated: true }])
  await assert.rejects(service.referenceMaterials(ownerA, { ...request, attachments: [{ attachmentId, sha256: 'b'.repeat(64) }] }), /文件引用已变化/)
  owner = ownerB
  await assert.rejects(service.referenceMaterials(ownerA, request), (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED')
  owner = ownerA
  await service.cancelSession(session.sessionId)
  await assert.rejects(service.referenceMaterials(ownerA, request), /文件引用已失效/)
})

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
  await assert.rejects(service.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256), (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED')
  current = ownerA
  const readTask = store.readTask.bind(store)
  store.readTask = async (...args) => { const bytes = await readTask(...args); current = ownerB; return bytes }
  await assert.rejects(service.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256), (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED')
  store.readTask = readTask
  current = ownerA
  await writeFile(store.taskReadPath(ownerA, 'task-preview', ref.attachmentId), 'corrupted')
  await assert.rejects(service.previewTaskAttachment('task-preview', ref.attachmentId, ref.sha256), /ATTACHMENT_INTEGRITY_MISMATCH/)
})

test('previews a draft image only while the matching composer session is open for the current owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-draft-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let owner = ownerA
  const store = new AttachmentStore(root)
  const service = new AttachmentService(store, () => owner)
  const { sessionId } = await service.beginSession({ kind: 'compose', composerId: 'image-compose' })
  const { item: image } = await service.importImageForSession(sessionId, 'op-image', png, 'preview.png', 'image/png')
  const preview = () => service.previewDraftAttachment(sessionId, image.attachmentId, image.sha256)
  assert.deepEqual(Buffer.from((await preview()).bytes), png)
  await assert.rejects(service.previewDraftAttachment(sessionId, image.attachmentId, 'b'.repeat(64)))
  owner = ownerB
  await assert.rejects(preview())
  owner = ownerA
  const read = store.read.bind(store)
  store.read = async (...args) => { const bytes = await read(...args); owner = ownerB; return bytes }
  await assert.rejects(preview(), (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED')
  owner = ownerA
  store.read = read
  await service.cancelSession(sessionId)
  await assert.rejects(preview())
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

test('reuses a saved attachment in a compose session with the original name and content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-attachment-reuse-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const imagePath = join(root, 'reference.png')
  await writeFile(imagePath, png)
  let scope = ownerA
  const store = new AttachmentStore(root)
  const service = new AttachmentService(store, () => scope)
  const original = await service.beginSession({ kind: 'conversation', taskId: 'task-a' })
  const { item } = (await service.importFiles(original.sessionId, 'original', [imagePath]))[0]!
  await service.claimTask(original.sessionId, 'task-a', [item])
  const file = await service.resolveTaskFile(ownerA, 'task-a', item.attachmentId, item.sha256)
  const draft = await service.beginSession({ kind: 'compose', composerId: 'draft' })
  const reused = await service.attachResultFile(ownerA, draft.sessionId, file.path, file.name)
  assert.equal(reused.attachments[0]?.displayName, 'reference.png')
  assert.equal(reused.attachments[0]?.mediaType, 'image/png')
  assert.deepEqual(await store.read(ownerA, draft.sessionId, reused.attachments[0]!.attachmentId), png)
  await assert.rejects(service.attachResultFile(ownerA, original.sessionId, file.path, file.name))
  scope = ownerB
  await assert.rejects(service.attachResultFile(ownerA, draft.sessionId, file.path, file.name))
  await assert.rejects(service.resolveTaskFile(ownerA, 'task-a', item.attachmentId, item.sha256))
})
