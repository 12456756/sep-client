import { createHash } from 'node:crypto'
import { appendFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { materializeArrangementMedia, resolveArrangementMedia, type ArrangementMediaSource } from './arrangement-media-files'
import type { ArrangementDeliverable } from '../domain/arrangement-plan'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f3261766331', 'hex')
const deliverable = (format: string, path = `deliverables/output.${format}`): ArrangementDeliverable => ({
  id: 'output', name: 'Output', format, path, contentOutline: ['media'], acceptanceCriteria: ['valid media'], artifact: { kind: format === 'mp4' ? 'video' : 'image', source: 'media-output' },
})
const source = (bytes: Buffer, kind: 'image' | 'video', mime: string, artifactId = 'asset-1'): ArrangementMediaSource => ({
  kind, artifactId, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime,
  stream: async function* () { yield bytes.subarray(0, 3); yield bytes.subarray(3) },
})
const signal = () => new AbortController().signal

describe('arrangement media files', () => {
  it('materializes image and resolves the verified snapshot idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-'))
    const task = join(root, 'task'); const media = source(PNG, 'image', 'image/png')
    const first = await materializeArrangementMedia(root, deliverable('png'), media, 'run-1', task, signal())
    const second = await materializeArrangementMedia(root, deliverable('png'), media, 'run-1', task, signal())
    assert.equal(first.sha256, media.sha256); assert.deepEqual(second.snapshot, first.snapshot)
    assert.deepEqual(await readFile(join(root, first.path)), PNG)
    assert.equal(await resolveArrangementMedia(root, first, task, signal()), await import('node:fs/promises').then(fs => fs.realpath(join(task, 'delivery-snapshots', `${media.sha256}.png`))))
  })

  it('keeps different bytes at an existing destination and publishes a suffixed path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task')
    const media = source(PNG, 'image', 'image/png'); await materializeArrangementMedia(root, deliverable('png'), media, 'run-1', task, signal())
    await writeFile(join(root, 'deliverables/output.png'), Buffer.from('different'))
    const result = await materializeArrangementMedia(root, deliverable('png'), media, 'run-2', task, signal())
    assert.equal(result.path, 'deliverables/output-2.png')
    assert.deepEqual(await readFile(join(root, result.path)), PNG)
    assert.deepEqual(await readFile(join(root, 'deliverables/output.png')), Buffer.from('different'))
  })

  it('validates video magic and keeps the 256 MiB video ceiling separate from document limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const media = source(MP4, 'video', 'video/mp4')
    const result = await materializeArrangementMedia(root, deliverable('mp4'), media, 'run-1', join(root, 'task'), signal())
    assert.equal(result.sourceArtifact?.kind, 'video')
  })

  it('cleans up on cancellation and rejects symlink destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task'); const media = source(PNG, 'image', 'image/png')
    const controller = new AbortController(); const stream = async function* () { yield PNG.subarray(0, 10); controller.abort(); yield PNG.subarray(10) }
    await assert.rejects(materializeArrangementMedia(root, deliverable('png'), { ...media, stream }, 'run-1', task, controller.signal), /aborted/i)
    const outside = join(root, 'outside'); await writeFile(outside, Buffer.from('keep')); await symlink(outside, join(root, 'linked.png'))
    await assert.rejects(materializeArrangementMedia(root, deliverable('png', 'linked.png'), media, 'run-1', task, signal()), /UNSAFE_PATH/)
    assert.equal((await lstat(outside)).isFile(), true)
  })

  it('does not fall back to a workspace file when a declared snapshot is damaged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task'); const media = source(PNG, 'image', 'image/png')
    const file = await materializeArrangementMedia(root, deliverable('png'), media, 'run-1', task, signal())
    await writeFile(join(task, 'delivery-snapshots', `${media.sha256}.png`), Buffer.from('damaged'))
    await assert.rejects(resolveArrangementMedia(root, file, task, signal()), /SNAPSHOT_CHANGED/)
  })

  it('requires the task directory when a frozen snapshot was declared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task')
    const file = await materializeArrangementMedia(root, deliverable('png'), source(PNG, 'image', 'image/png'), 'run-1', task, signal())
    await assert.rejects(resolveArrangementMedia(root, file, undefined, signal()), /SNAPSHOT_UNAVAILABLE/)
  })

  it('rechecks the snapshot directory after the authorization callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task'); const outside = join(root, 'outside')
    await mkdir(outside)
    let validations = 0
    await assert.rejects(materializeArrangementMedia(root, deliverable('png'), source(PNG, 'image', 'image/png'), 'run-1', task, signal(), () => {
      if (++validations !== 2) return
      rmSync(join(task, 'delivery-snapshots'), { recursive: true }); symlinkSync(outside, join(task, 'delivery-snapshots'))
    }), /UNSAFE_PATH/)
    assert.deepEqual(readdirSync(outside), [])
    await assert.rejects(lstat(join(root, 'deliverables/output.png')), { code: 'ENOENT' })
  })

  it('rejects bytes appended after stream validation before workspace publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task')
    let validations = 0
    await assert.rejects(materializeArrangementMedia(root, deliverable('png'), source(PNG, 'image', 'image/png'), 'run-1', task, signal(), () => {
      if (++validations !== 2) return
      const part = readdirSync(task).find(name => name.startsWith('.media-'))!
      appendFileSync(join(task, part), Buffer.from('appended'))
    }), /MEDIA_INTEGRITY_MISMATCH/)
    await assert.rejects(lstat(join(root, 'deliverables/output.png')), { code: 'ENOENT' })
  })

  it('revalidates an idempotent publication after authorization checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task'); const media = source(PNG, 'image', 'image/png')
    await materializeArrangementMedia(root, deliverable('png'), media, 'run-1', task, signal())
    let validations = 0
    await assert.rejects(materializeArrangementMedia(root, deliverable('png'), media, 'run-1', task, signal(), () => {
      if (++validations === 2) writeFileSync(join(root, 'deliverables/output.png'), Buffer.alloc(PNG.length))
    }), /MEDIA_INTEGRITY_MISMATCH/)
  })

  it('fails closed when the snapshot directory is a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const task = join(root, 'task'); const outside = join(root, 'outside')
    await mkdir(task, { recursive: true }); await mkdir(outside); await symlink(outside, join(task, 'delivery-snapshots'))
    await assert.rejects(materializeArrangementMedia(root, deliverable('png'), source(PNG, 'image', 'image/png'), 'run-1', task, signal()), /UNSAFE_PATH/)
  })

  it('streams a video larger than the document limit without buffering it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const size = 65 * 1024 * 1024
    const hash = createHash('sha256'); hash.update(MP4)
    const chunk = Buffer.alloc(1024 * 1024); for (let offset = MP4.length; offset < size; offset += chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, size - offset)))
    const media: ArrangementMediaSource = { kind: 'video', artifactId: 'large', sha256: hash.digest('hex'), size, mime: 'video/mp4', stream: async function* () { yield MP4; for (let offset = MP4.length; offset < size; offset += chunk.length) yield chunk.subarray(0, Math.min(chunk.length, size - offset)) } }
    const result = await materializeArrangementMedia(root, deliverable('mp4'), media, 'run-1', join(root, 'task'), signal())
    assert.equal(result.size, size)
  })

  it('honors cancellation after validation before target publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arrangement-media-')); const controller = new AbortController()
    let validations = 0
    await assert.rejects(materializeArrangementMedia(root, deliverable('png'), source(PNG, 'image', 'image/png'), 'run-1', join(root, 'task'), controller.signal, () => { if (++validations === 2) controller.abort() }), /aborted/i)
    await assert.rejects(lstat(join(root, 'deliverables/output.png')), { code: 'ENOENT' })
  })
})
