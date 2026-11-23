import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ResultFileStore } from './result-file-store'
import type { DocumentPreviewStore } from './document-preview-store'
import type { TaskReadView } from '../../src/shared/types'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import { materializeArrangementMedia } from './arrangement-media-files'
import { ScopePath } from './scope-path'
import { MediaStore } from './media-store'
import { VideoStore } from './video-store'
import { seedConversationResults } from '../../scripts/fixtures/result-files-conversation'
import { MOCK_VIDEO_BYTES } from './mock-video-media-gateway'
import { validateDeliveryFiles } from './arrangement-delivery-files'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const input = { taskId: 'task', nodeId: 'node', deliverableId: 'file' }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-result-')))
  const workspace = join(root, 'workspace'); await mkdir(workspace)
  const path = join(workspace, 'final.mp4'), bytes = Buffer.from('test video bytes')
  await writeFile(path, bytes)
  const file: FinalDeliveryFile = { id: 'file', path: 'final.mp4', format: 'mp4', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), nodeRunId: 'run', validatedAt: 1 }
  let status = 'completed'
  const task = { id: 'task', ownerId: scope.memberId, ownerEnterpriseId: scope.enterpriseId, workDir: workspace, files: [path], workType: { state: 'resolved', kind: 'conversation' } } as unknown as TaskReadView
  const deliveries = { async getDelivery() { return { status, file, workspace } } } as unknown as DocumentPreviewStore
  const store = new ResultFileStore(root, deliveries, async () => task)
  return { store, path, root, workspace, file, task, pending: () => { status = 'running' } }
}

test('streams verified delivery files and reveals the workspace final file', async () => {
  const f = await fixture()
  assert.equal(await f.store.revealPath(scope, input), f.path)
  const file = await f.store.open(scope, input)
  assert.equal(file.mime, 'video/mp4')
  assert.equal(await new Response(file.stream(5, 9, new AbortController().signal, () => undefined)).text(), 'video')
  await file.close()
  await assert.rejects(file.validate())
})

test('rejects cross-owner, incomplete, changed and symlink delivery files', async () => {
  const f = await fixture()
  await assert.rejects(f.store.open({ ...scope, memberId: 'other' }, input))
  const opened = await f.store.open(scope, input)
  await writeFile(f.path, 'changed video')
  await assert.rejects(opened.validate()); await opened.close()
  await assert.rejects(f.store.open(scope, input)); await assert.rejects(f.store.revealPath(scope, input))
  f.pending(); await assert.rejects(f.store.open(scope, input))
  const linked = await fixture()
  await symlink(linked.workspace, join(linked.workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  linked.file.path = 'alias/final.mp4'
  await assert.rejects(linked.store.open(scope, input))
})

test('conversation identities cannot reveal paths outside the workspace or directories', async () => {
  const f = await fixture(), conversation = { taskId: 'task', fileId: 'task-file-0' }
  assert.equal(await f.store.revealPath(scope, conversation), f.path)
  const outside = join(f.root, 'private.mp4'); await writeFile(outside, 'secret')
  f.task.files[0] = outside
  await assert.rejects(f.store.revealPath(scope, conversation), { code: 'PERMISSION_DENIED', reason: 'outside' })
  f.task.files[0] = f.workspace
  await assert.rejects(f.store.revealPath(scope, conversation), { code: 'INVALID_ARGUMENT', reason: 'notFile' })
  f.task.files[0] = 'unavailable.md'
  await assert.rejects(f.store.revealPath(scope, conversation), { code: 'NOT_FOUND', reason: 'missing' })
  await assert.rejects(f.store.revealPath(scope, { taskId: 'task', fileId: 'task-file-99' }))
})

test('conversation file actions accept canonical paths under a configured workspace alias', async () => {
  const f = await fixture(), request = { taskId: 'task', fileId: 'task-file-0' }
  const alias = join(f.root, 'workspace-alias')
  await symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  f.task.workDir = alias
  assert.equal(await f.store.revealPath(scope, request), f.path)
  assert.equal((await f.store.actionFile(scope, request)).path, f.path)
})

test('conversation output location accepts different capitalization for the same Windows file', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(), request = { taskId: 'task', fileId: 'task-file-0' }
  f.task.files[0] = join(f.workspace, 'FINAL.MP4')
  assert.equal(await f.store.revealPath(scope, request), f.path)
  assert.equal((await f.store.actionFile(scope, request)).name, 'final.mp4')
})

test('managed attachments accept ordinary paths but still reject a directory link', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const request = { taskId: 'task', attachmentId: 'file', sha256: '0'.repeat(64) }
  const filename = process.platform === 'win32' ? 'FINAL.MP4' : 'final.mp4'
  let path = join(f.workspace, filename)
  const store = new ResultFileStore(f.root, {} as DocumentPreviewStore, async () => f.task, undefined, undefined,
    async () => ({ path, name: 'attachment.mp4', size: 0 }))
  assert.equal(await store.revealPath(scope, request), f.path)
  const alias = join(f.root, 'workspace-alias')
  await symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  path = join(alias, filename)
  await assert.rejects(store.revealPath(scope, request), { reason: 'link' })
})

test('locates explicitly empty text deliveries and still rejects a changed original', async () => {
  const f = await fixture()
  const file = join(f.workspace, 'empty.txt')
  await writeFile(file, '')
  Object.assign(f.file, { path: 'empty.txt', format: 'txt', contentPolicy: 'empty', size: 0, sha256: createHash('sha256').digest('hex') })
  assert.equal(await f.store.revealPath(scope, input), file)
  await writeFile(file, 'changed')
  await assert.rejects(f.store.revealPath(scope, input))
})

test('previews the accepted immutable snapshot while reveal always targets the original workspace file', async () => {
  const f = await fixture()
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
  const taskDir = new ScopePath(f.root).taskDir(scope, input.taskId)
  await mkdir(taskDir, { recursive: true })
  const delivered = await materializeArrangementMedia(f.workspace, { id: 'file', name: 'final.png', path: 'final.png', format: 'png', contentOutline: [], acceptanceCriteria: [] }, {
    kind: 'image', artifactId: 'asset', mime: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), stream: async function* () { yield bytes },
  }, 'run', taskDir, new AbortController().signal)
  Object.assign(f.file, delivered)
  const original = join(f.workspace, 'final.png')
  assert.equal(await f.store.revealPath(scope, input), original)
  await writeFile(original, 'user edited the original')
  const file = await f.store.open(scope, input)
  assert.deepEqual(Buffer.from(await new Response(file.stream(0, file.size - 1, new AbortController().signal, () => undefined)).arrayBuffer()), bytes)
  await assert.rejects(f.store.revealPath(scope, input))
  f.file.nodeRunId = 'replacement-run'
  await assert.rejects(file.authorize!())
  await file.close()
})

test('streams persisted conversation image and video outputs with owner and integrity checks', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-result-history-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
  const seeded = await seedConversationResults(root, scope, image, MOCK_VIDEO_BYTES)
  const task = { id: 'conversation-test', ownerId: scope.memberId, ownerEnterpriseId: scope.enterpriseId, subscriptionId: 'sub', workType: { state: 'resolved', kind: 'conversation' } } as unknown as TaskReadView
  const store = new ResultFileStore(root, {} as DocumentPreviewStore, async () => task, new MediaStore(root), new VideoStore(root))
  const imageInput = { taskId: 'conversation-test', assetId: seeded.images.assets[0].localAssetId }
  const videoOutput = seeded.videos.jobs.find(job => job.jobId === 'video-job')?.outputs[0]
  assert.ok(videoOutput)
  const videoInput = { taskId: 'conversation-test', jobId: 'video-job', outputId: videoOutput.outputId }
  const imageFile = await store.open(scope, imageInput)
  assert.equal(imageFile.mime, 'image/png')
  assert.equal((await new Response(imageFile.stream(0, imageFile.size - 1, new AbortController().signal, () => undefined)).arrayBuffer()).byteLength, image.length)
  assert.equal(await store.revealPath(scope, imageInput), seeded.imagePath)
  await imageFile.close()
  const videoFile = await store.open(scope, videoInput)
  assert.equal(videoFile.mime, 'video/mp4')
  assert.equal((await new Response(videoFile.stream(0, 9, new AbortController().signal, () => undefined)).arrayBuffer()).byteLength, 10)
  assert.equal(await store.revealPath(scope, videoInput), seeded.videoPath)
  await videoFile.close()
  await assert.rejects(store.open({ ...scope, memberId: 'other' }, imageInput))
  await rm(seeded.imagePath)
  await assert.rejects(store.open(scope, imageInput))
  await writeFile(seeded.videoPath, Buffer.from('tampered'))
  await assert.rejects(store.open(scope, videoInput))
})

test('result actions retain the original name when using an accepted document snapshot', async t => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const path = join(f.workspace, 'brief.txt')
  await writeFile(path, 'accepted text')
  const verified = await validateDeliveryFiles(f.workspace, {
    id: 'node', title: 'Write', subscriptionId: 'sub', modelId: 'model', instruction: 'Write', expectedOutput: 'Brief',
    dependsOn: [], skillIds: [], requiresUserConfirmation: false,
    deliverables: [{ id: 'file', name: 'brief.txt', format: 'txt', path: 'brief.txt', contentOutline: [], acceptanceCriteria: [] }],
  }, { nodeId: 'node', summary: 'Brief', finalDeliverables: [{ id: 'file', path: 'brief.txt' }] }, 'run', undefined, { taskDirectory: new ScopePath(f.root).taskDir(scope, 'task') })
  assert.ok(verified.ok)
  Object.assign(f.file, verified.files[0])
  const file = await f.store.actionFile(scope, input)
  assert.equal(file.name, 'brief.txt')
  assert.notEqual(file.path, path)
  assert.equal(await readFile(file.path, 'utf8'), 'accepted text')
})
