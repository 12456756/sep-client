import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, realpath, rm } from 'node:fs/promises'
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
  await symlink(linked.path, join(linked.workspace, 'alias.mp4'))
  linked.file.path = 'alias.mp4'
  await assert.rejects(linked.store.open(scope, input))
})

test('conversation identities cannot reveal paths outside the workspace or directories', async () => {
  const f = await fixture(), conversation = { taskId: 'task', fileId: 'task-file-0' }
  assert.equal(await f.store.revealPath(scope, conversation), f.path)
  const outside = join(f.root, 'private.mp4'); await writeFile(outside, 'secret')
  f.task.files[0] = outside
  await assert.rejects(f.store.revealPath(scope, conversation))
  f.task.files[0] = f.workspace
  await assert.rejects(f.store.revealPath(scope, conversation))
  await assert.rejects(f.store.revealPath(scope, { taskId: 'task', fileId: 'task-file-99' }))
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

test('streams persisted conversation image and video outputs with owner and integrity checks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sep-result-history-')))
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
  const seeded = await seedConversationResults(root, scope, image, MOCK_VIDEO_BYTES)
  const task = { id: 'conversation-test', ownerId: scope.memberId, ownerEnterpriseId: scope.enterpriseId, subscriptionId: 'sub', workType: { state: 'resolved', kind: 'conversation' } } as unknown as TaskReadView
  const store = new ResultFileStore(root, {} as DocumentPreviewStore, async () => task, new MediaStore(root), new VideoStore(root))
  const imageInput = { taskId: 'conversation-test', assetId: seeded.images.assets[0].localAssetId }
  const videoInput = { taskId: 'conversation-test', jobId: 'video-job', outputId: seeded.videos.jobs[0].outputs[0].outputId }
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
