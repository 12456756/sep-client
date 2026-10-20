import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { promises as fs, type PathLike } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOCK_VIDEO_BYTES, MOCK_VIDEO_SHA256 } from './mock-video-media-gateway'
import { VideoStore } from './video-store'
import { VideoFiles, videoSha256 } from './video-files'
import { ScopePath, encodeTaskScopeSegment } from './scope-path'
import type { LocalVideoJob, VideoScope } from '../domain/video-media'
import type { VideoOutput } from '../../src/shared/video-media'

const scope: VideoScope = { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const signal = (): AbortSignal => new AbortController().signal
async function* stream(bytes: Uint8Array = MOCK_VIDEO_BYTES): AsyncIterable<Uint8Array> { yield bytes.subarray(0, 7); yield bytes.subarray(7) }
const output = (outputId = 'output-a'): VideoOutput => ({ outputId, kind: 'video', mimeType: 'video/mp4', byteLength: MOCK_VIDEO_BYTES.length,
  sha256: MOCK_VIDEO_SHA256, durationSeconds: 5, width: 720, height: 1280, frameRate: 24, thumbnailOutputId: null, expiresAt: null })

function pending(overrides: Partial<LocalVideoJob> = {}): LocalVideoJob {
  return {
    version: 1, scope, taskId: 'task-a', jobId: 'job-a',
    request: { profileId: 'video-profile', configVersion: 'v1', operation: 'image-to-video', referenceIds: ['reference-a'], creativeBrief: 'Product animation',
      parameters: { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' },
      clientRequestId: 'request-a', quoteId: 'quote-a' },
    quote: { quoteId: 'quote-a', requestHash: 'f'.repeat(64), expiresAt: Date.now() + 60_000, status: 'quoted', amount: '0', currency: 'MOCK' },
    submission: 'NOT_SENT', receipt: null, trackingStatus: 'ACTIVE', saveStatus: 'PENDING', error: null, createdAt: 1, updatedAt: 1, ...overrides,
  }
}
async function fixture(receipted = true): Promise<{ store: VideoStore; root: string; directory: string; task: string; job: LocalVideoJob }> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-store-'))
  directories.push(directory)
  const root = join(directory, 'user-data')
  const task = join(new ScopePath(root).ownerRoot(scope), 'video', 'v1', encodeTaskScopeSegment(scope.subscriptionId, 'subscriptionId'), 'tasks', 'task-a')
  const store = new VideoStore(root)
  let job = pending()
  await store.createJob(scope, job)
  if (receipted) job = await store.updateJob(scope, job.taskId, job.jobId, value => ({ ...value, submission: 'RECEIPTED', receipt: {
    mock: true, receiptId: 'receipt-a', clientRequestId: value.request.clientRequestId, profileId: value.request.profileId,
    configVersion: value.request.configVersion, operation: value.request.operation, status: 'SUCCEEDED', outputs: [output()],
    pollAfterMs: null, billingStatus: 'MOCK_NOT_CHARGED', errorCode: null, recovery: { canQuery: false, canCancel: false, canDownload: true },
  } }))
  return { store, root, directory, task, job }
}

describe('VideoStore disk durability and scope safety', () => {
  it('rebuilds jobs, original receipts and validated MP4 assets from disk', async () => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    const reopened = new VideoStore(f.root)
    assert.deepEqual(await reopened.getJob(scope, 'task-a', 'job-a'), f.job)
    assert.deepEqual(await reopened.listJobs(scope), [f.job])
    assert.deepEqual(await reopened.listAssets(scope, 'task-a'), [asset])
    assert.deepEqual(await reopened.readAsset(scope, 'task-a', 'job-a', 'output-a'), MOCK_VIDEO_BYTES)
    assert.equal(asset.output.sha256, MOCK_VIDEO_SHA256)
    assert.equal((await readdir(join(f.task, 'files'))).some(name => name.endsWith('.part')), false)
  })

  it('isolates enterprise, member and subscription, including reused local IDs', async () => {
    const f = await fixture()
    for (const other of [{ ...scope, enterpriseId: 'enterprise-b' }, { ...scope, memberId: 'member-b' }, { ...scope, subscriptionId: 'subscription-b' }]) {
      assert.equal(await f.store.getJob(other, 'task-a', 'job-a'), null)
      assert.deepEqual(await f.store.listJobs(other), [])
      assert.deepEqual(await f.store.listAssets(other, 'task-a'), [])
      await assert.rejects(f.store.createJob(other, pending()), /scope/)
      await f.store.createJob(other, pending({ scope: other }))
      assert.equal((await f.store.listJobs(other)).length, 1)
    }
  })

  it('rejects arbitrary paths in scope, identifiers, manifests and output IDs', async () => {
    const f = await fixture()
    for (const id of ['../other', '/tmp/secret', 'a/b', 'a\\b', '..']) {
      await assert.rejects(f.store.getJob(scope, id, 'job-a'))
      await assert.rejects(f.store.getJob(scope, 'task-a', id))
      await assert.rejects(f.store.getAsset(scope, 'task-a', 'job-a', id))
      await assert.rejects(f.store.listJobs({ ...scope, subscriptionId: id }))
    }
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    const manifest = join(f.task, 'assets', `${asset.localAssetId}.json`)
    await rm(`${manifest}.commit`)
    await writeFile(manifest, JSON.stringify({ ...asset, relativePath: '../../secret.mp4' }))
    await assert.rejects(f.store.readAsset(scope, 'task-a', 'job-a', 'output-a'), /path/)
  })

  it('freezes requests, quotes, client IDs and original receipts; prevents state regression', async () => {
    const f = await fixture(false)
    await assert.rejects(f.store.createJob(scope, pending({ jobId: 'duplicate' })), /already exists/)
    for (const change of [{ request: { ...f.job.request, creativeBrief: 'Different request' } },
      { quote: { ...f.job.quote, requestHash: 'e'.repeat(64) } }, { scope: { ...scope, memberId: 'other' } }]) {
      await assert.rejects(f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, ...change })), /identity/)
    }
    await f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, submission: 'MAYBE_SENT' }))
    await assert.rejects(f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, submission: 'NOT_SENT' })), /submission/)
    assert.equal((await new VideoStore(f.root).getJob(scope, 'task-a', 'job-a'))?.submission, 'MAYBE_SENT')
  })

  it('does not persist SAVED until every receipt output has verified local bytes', async () => {
    const f = await fixture()
    await assert.rejects(f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, saveStatus: 'SAVED' })), /verified/)
    assert.equal((await f.store.getJob(scope, 'task-a', 'job-a'))?.saveStatus, 'PENDING')
    await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    assert.equal((await f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, saveStatus: 'SAVED' }))).saveStatus, 'SAVED')
  })

  it('rejects receipt substitution, status regression and changed content metadata', async () => {
    const f = await fixture()
    for (const change of [{ receiptId: 'replacement' }, { clientRequestId: 'other' }, { profileId: 'other' }, { configVersion: 'other' },
      { operation: 'text-to-video' as const }, { status: 'RUNNING' as const }, { outputs: [{ ...output(), sha256: '0'.repeat(64) }] }]) {
      await assert.rejects(f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, receipt: { ...job.receipt!, ...change } })))
    }
    assert.deepEqual(await f.store.getJob(scope, 'task-a', 'job-a'), f.job)
  })

  it('rejects unauthorized outputs and truncated, oversized or mismatching content', async () => {
    const f = await fixture()
    await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', { ...output(), sha256: '0'.repeat(64) }, stream(), signal()), /authorized/)
    for (const bytes of [MOCK_VIDEO_BYTES.subarray(0, MOCK_VIDEO_BYTES.length - 1), Buffer.concat([MOCK_VIDEO_BYTES, Buffer.from([0])]), Buffer.alloc(MOCK_VIDEO_BYTES.length)]) {
      await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(bytes), signal()), /hash|size/)
    }
    assert.deepEqual(await f.store.listAssets(scope, 'task-a'), [])
    assert.deepEqual(await readdir(join(f.task, 'files')), [])
  })

  it('checks container signature as well as size/hash without pretending to decode video', async () => {
    const f = await fixture(false)
    const bytes = Buffer.alloc(32)
    const invalid = { ...output(), byteLength: bytes.length, sha256: videoSha256(bytes) }
    await f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, submission: 'RECEIPTED', receipt: {
      mock: true, receiptId: 'receipt-a', clientRequestId: job.request.clientRequestId, profileId: job.request.profileId, configVersion: job.request.configVersion,
      operation: job.request.operation, status: 'SUCCEEDED', outputs: [invalid], pollAfterMs: null, billingStatus: 'MOCK_NOT_CHARGED', errorCode: null,
      recovery: { canQuery: false, canCancel: false, canDownload: true },
    } }))
    await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', invalid, stream(bytes), signal()), /container/)
    assert.deepEqual(await f.store.listAssets(scope, 'task-a'), [])
  })

  it('cleans temporary bytes after stream failures, cancellation and invalid chunks', async () => {
    const f = await fixture()
    const failure = (async function* () { yield MOCK_VIDEO_BYTES.subarray(0, 4); throw new Error('network interrupted') })()
    await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), failure, signal()), /interrupted/)
    const controller = new AbortController()
    const stalled: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
    const saving = f.store.saveOutput(scope, 'task-a', 'job-a', output(), stalled, controller.signal)
    const timer = setTimeout(() => controller.abort(), 20)
    try { await assert.rejects(saving) } finally { clearTimeout(timer) }
    const invalid = (async function* () { yield 'bad' as unknown as Uint8Array })()
    await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), invalid, signal()), /chunk/)
    assert.deepEqual(await readdir(join(f.task, 'files')), [])
  })

  it('deduplicates simultaneous saves across rebuilt stores without consuming another stream', async () => {
    const f = await fixture()
    let downloaded = 0
    const tracked = (): AsyncIterable<Uint8Array> => (async function* () { downloaded++; yield* stream() })()
    const assets = await Promise.all([f.store.saveOutput(scope, 'task-a', 'job-a', output(), tracked(), signal()),
      new VideoStore(f.root).saveOutput(scope, 'task-a', 'job-a', output(), tracked(), signal())])
    assert.deepEqual(assets[0], assets[1])
    assert.equal(downloaded, 1)
  })

  it('recovers commit+renamed video after final manifest publication fails without downloading', async context => {
    const f = await fixture()
    const id = `vout_${videoSha256(JSON.stringify(['job-a', 'output-a']))}`
    const manifest = join(f.task, 'assets', `${id}.json`)
    const rename = fs.rename
    const mock = context.mock.method(fs, 'rename', async (source: PathLike, target: PathLike) => {
      if (target === manifest) throw new Error('manifest publication failed')
      return rename(source, target)
    })
    syncBuiltinESMExports()
    try { await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()), /publication/) }
    finally { mock.mock.restore(); syncBuiltinESMExports() }
    assert.deepEqual(await readFile(join(f.task, 'files', `${id}.mp4`)), MOCK_VIDEO_BYTES)
    assert.equal(JSON.parse(await readFile(`${manifest}.commit`, 'utf8')).receiptId, 'receipt-a')
    const never = (async function* () { throw new Error('must not download'); yield MOCK_VIDEO_BYTES })()
    const asset = await new VideoStore(f.root).saveOutput(scope, 'task-a', 'job-a', output(), never, signal())
    assert.equal(asset.status, 'SAVED')
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).localAssetId, id)
  })

  it('redownloads missing final bytes using the original commit and preserves missing state', async () => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    await rm(join(f.task, asset.relativePath))
    assert.equal((await new VideoStore(f.root).getAsset(scope, 'task-a', 'job-a', 'output-a'))?.status, 'MISSING')
    await assert.rejects(f.store.readAsset(scope, 'task-a', 'job-a', 'output-a'), /missing/)
    assert.deepEqual(await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()), asset)
  })

  it('preserves orphaned/tampered bytes and disagreed commit evidence instead of overwriting', async () => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    const manifest = join(f.task, 'assets', `${asset.localAssetId}.json`)
    await writeFile(`${manifest}.commit`, JSON.stringify({ ...asset, createdAt: asset.createdAt + 1 }))
    await assert.rejects(f.store.getAsset(scope, 'task-a', 'job-a', 'output-a'), /disagree/)
    await writeFile(`${manifest}.commit`, JSON.stringify(asset))
    const bad = Buffer.from(MOCK_VIDEO_BYTES); bad[bad.length - 1] ^= 1
    await writeFile(join(f.task, asset.relativePath), bad)
    await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()), /hash/)
    assert.deepEqual(await readFile(join(f.task, asset.relativePath)), bad)
    await rm(manifest); await rm(`${manifest}.commit`)
    await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()), /Orphaned/)
    assert.deepEqual(await readFile(join(f.task, asset.relativePath)), bad)
  })

  for (const corruption of ['hash', 'truncated', 'container'] as const) {
    it(`explicitly quarantines ${corruption} damage and restores only the original output after reconstruction`, async () => {
      const f = await fixture()
      const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
      await f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, saveStatus: 'SAVED' }))
      const manifest = join(f.task, 'assets', `${asset.localAssetId}.json`)
      const before = await readFile(manifest)
      const bad = Buffer.from(MOCK_VIDEO_BYTES)
      bad[corruption === 'container' ? 4 : bad.length - 1] ^= 1
      const damaged = corruption === 'truncated' ? bad.subarray(0, 8) : bad
      await writeFile(join(f.task, asset.relativePath), damaged)
      await assert.rejects(f.store.getAsset(scope, 'task-a', 'job-a', 'output-a'))
      await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()))
      const reopened = new VideoStore(f.root)
      assert.equal((await reopened.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal())).status, 'MISSING')
      assert.equal((await reopened.getJob(scope, 'task-a', 'job-a'))?.saveStatus, 'MISSING')
      assert.equal((await reopened.getAsset(scope, 'task-a', 'job-a', 'output-a'))?.status, 'MISSING')
      const quarantines = await readdir(join(f.task, 'quarantine'))
      assert.equal(quarantines.length, 1)
      const evidence = join(f.task, 'quarantine', quarantines[0])
      assert.deepEqual(await readFile(join(evidence, 'corrupt.video')), damaged)
      assert.deepEqual(await readFile(join(evidence, 'manifest.json')), before)
      assert.deepEqual(await readFile(join(evidence, 'commit.json')), before)
      assert.deepEqual(await readFile(manifest), before)
      assert.deepEqual(await readFile(`${manifest}.commit`), before)
      // Repeated repair and a restart do not lose evidence or require another request.
      assert.equal((await new VideoStore(f.root).repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal())).status, 'MISSING')
      let downloads = 0
      const source = (async function* () { downloads++; yield* stream() })()
      assert.deepEqual(await new VideoStore(f.root).saveOutput(scope, 'task-a', 'job-a', output(), source, signal()), asset)
      assert.equal(downloads, 1)
      assert.deepEqual(await reopened.readAsset(scope, 'task-a', 'job-a', 'output-a'), MOCK_VIDEO_BYTES)
      assert.deepEqual((await reopened.getJob(scope, 'task-a', 'job-a'))?.request, f.job.request)
      assert.deepEqual((await reopened.getJob(scope, 'task-a', 'job-a'))?.receipt, f.job.receipt)
      assert.deepEqual(await readFile(join(evidence, 'corrupt.video')), damaged)
      assert.equal((await reopened.getJob(scope, 'task-a', 'job-a'))?.saveStatus, 'MISSING')
    })
  }

  it('does not quarantine healthy outputs, and serializes concurrent explicit repairs', async () => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    assert.deepEqual(await f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), asset)
    await assert.rejects(readdir(join(f.task, 'quarantine')), { code: 'ENOENT' })
    await writeFile(join(f.task, asset.relativePath), Buffer.alloc(0))
    const results = await Promise.all([f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()),
      new VideoStore(f.root).repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal())])
    assert.ok(results.every(result => result.status === 'MISSING'))
    assert.equal((await readdir(join(f.task, 'quarantine'))).length, 1)
  })

  for (const unavailable of ['expired-output', 'download-disabled', 'expired-receipt'] as const) {
    it(`preserves corrupt bytes and evidence in place for ${unavailable}`, async () => {
      const f = await fixture()
      const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
      await f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, receipt: { ...job.receipt!,
        ...(unavailable === 'expired-output' ? { outputs: [{ ...output(), expiresAt: new Date(Date.now() - 1).toISOString() }] } : {}),
        ...(unavailable === 'expired-receipt' ? { status: 'RESULT_EXPIRED' as const } : {}),
        recovery: { ...job.receipt!.recovery, canDownload: unavailable === 'expired-output' },
      } }))
      const manifest = join(f.task, 'assets', `${asset.localAssetId}.json`)
      const before = await readFile(manifest)
      await writeFile(join(f.task, asset.relativePath), Buffer.alloc(1))
      await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /unavailable/)
      assert.deepEqual(await readFile(join(f.task, asset.relativePath)), Buffer.alloc(1))
      assert.deepEqual(await readFile(manifest), before)
      assert.deepEqual(await readFile(`${manifest}.commit`), before)
      await assert.rejects(readdir(join(f.task, 'quarantine')), { code: 'ENOENT' })
    })
  }

  for (const evidence of ['missing-manifest', 'missing-commit', 'disagree', 'malformed', 'foreign-receipt', 'path', 'orphan'] as const) {
    it(`refuses explicit repair with ${evidence} evidence without moving bytes`, async () => {
      const f = await fixture()
      const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
      const manifest = join(f.task, 'assets', `${asset.localAssetId}.json`)
      const file = join(f.task, asset.relativePath)
      const bad = Buffer.alloc(1)
      await writeFile(file, bad)
      if (evidence === 'missing-manifest' || evidence === 'orphan') await rm(manifest)
      if (evidence === 'missing-commit' || evidence === 'orphan') await rm(`${manifest}.commit`)
      if (evidence === 'disagree') await writeFile(`${manifest}.commit`, JSON.stringify({ ...asset, createdAt: asset.createdAt + 1 }))
      if (evidence === 'malformed') await writeFile(manifest, 'broken')
      if (evidence === 'foreign-receipt' || evidence === 'path') {
        const value = { ...asset, ...(evidence === 'foreign-receipt' ? { receiptId: 'other' } : { relativePath: '../../outside' }) }
        await writeFile(manifest, JSON.stringify(value)); await writeFile(`${manifest}.commit`, JSON.stringify(value))
      }
      await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()))
      assert.deepEqual(await readFile(file), bad)
      await assert.rejects(readdir(join(f.task, 'quarantine')), { code: 'ENOENT' })
    })
  }

  it('rejects links, foreign scopes, invalid IDs and cancellation during explicit repair', async () => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    const file = join(f.task, asset.relativePath)
    const external = join(f.directory, 'external.mp4')
    await writeFile(external, Buffer.alloc(1))
    await rm(file); await symlink(external, file)
    await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /symbolic/)
    await rm(file); await link(external, file)
    await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /hardlink/)
    await assert.rejects(f.store.repairCorruptOutput({ ...scope, memberId: 'other' }, 'task-a', 'job-a', 'output-a', signal()))
    await assert.rejects(f.store.repairCorruptOutput(scope, '../outside', 'job-a', 'output-a', signal()))
    const controller = new AbortController(); controller.abort()
    await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', controller.signal))
    assert.deepEqual(await readFile(external), Buffer.alloc(1))
    await assert.rejects(readdir(join(f.task, 'quarantine')), { code: 'ENOENT' })
  })

  it('preserves bytes and never claims repair success when evidence fsync fails', async context => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    await f.store.updateJob(scope, 'task-a', 'job-a', job => ({ ...job, saveStatus: 'SAVED' }))
    const bad = Buffer.alloc(1)
    await writeFile(join(f.task, asset.relativePath), bad)
    const sync = VideoFiles.prototype.syncDirectory
    const failing = context.mock.method(VideoFiles.prototype, 'syncDirectory', async function(this: VideoFiles, directory: string) {
      if (directory.includes('quarantine')) throw new Error('quarantine fsync failed')
      return sync.call(this, directory)
    })
    try { await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /fsync/) }
    finally { failing.mock.restore() }
    assert.deepEqual(await readFile(join(f.task, asset.relativePath)), bad)
    assert.equal((await f.store.getJob(scope, 'task-a', 'job-a'))?.saveStatus, 'MISSING')
    await assert.rejects(f.store.getAsset(scope, 'task-a', 'job-a', 'output-a'))
    assert.equal((await f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal())).status, 'MISSING')
    assert.equal((await readdir(join(f.task, 'quarantine'))).length, 2)
  })

  it('refuses linked repair evidence and a symlinked quarantine directory', async () => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    const manifest = join(f.task, 'assets', `${asset.localAssetId}.json`)
    const external = join(f.directory, 'evidence.json')
    const original = await readFile(manifest)
    await writeFile(external, original)
    await writeFile(join(f.task, asset.relativePath), Buffer.alloc(1))
    await rm(manifest); await symlink(external, manifest)
    await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /symbolic/)
    await rm(manifest); await link(external, manifest)
    await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /hardlink/)
    await rm(manifest); await writeFile(manifest, original)
    const outside = join(f.directory, 'outside'); await mkdir(outside)
    await symlink(outside, join(f.task, 'quarantine'))
    await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /symbolic/)
    assert.deepEqual(await readdir(outside), [])
    assert.deepEqual(await readFile(join(f.task, asset.relativePath)), Buffer.alloc(1))
    assert.deepEqual(await readFile(external), original)
  })

  it('retains quarantine after a failed final directory sync and permits recovery from disk', async context => {
    const f = await fixture()
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    const bad = Buffer.alloc(1)
    await writeFile(join(f.task, asset.relativePath), bad)
    const sync = VideoFiles.prototype.syncDirectory
    const failing = context.mock.method(VideoFiles.prototype, 'syncDirectory', async function(this: VideoFiles, directory: string) {
      if (directory === join(f.task, 'files')) throw new Error('final directory fsync failed')
      return sync.call(this, directory)
    })
    try { await assert.rejects(f.store.repairCorruptOutput(scope, 'task-a', 'job-a', 'output-a', signal()), /fsync/) }
    finally { failing.mock.restore() }
    const [quarantine] = await readdir(join(f.task, 'quarantine'))
    assert.deepEqual(await readFile(join(f.task, 'quarantine', quarantine, 'corrupt.video')), bad)
    const reopened = new VideoStore(f.root)
    assert.equal((await reopened.getAsset(scope, 'task-a', 'job-a', 'output-a'))?.status, 'MISSING')
    assert.equal((await reopened.getJob(scope, 'task-a', 'job-a'))?.saveStatus, 'MISSING')
    assert.deepEqual(await reopened.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()), asset)
  })

  it('rejects symlink directories, symlink files and hardlinks before reading or writing', async () => {
    const f = await fixture()
    const outside = join(f.directory, 'outside'); await mkdir(outside)
    await symlink(outside, join(f.task, 'files'))
    await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()), /symbolic/)
    assert.deepEqual(await readdir(outside), [])
    await rm(join(f.task, 'files'))
    const asset = await f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal())
    const file = join(f.task, asset.relativePath)
    const external = join(outside, 'video.mp4'); await writeFile(external, MOCK_VIDEO_BYTES)
    await rm(file); await symlink(external, file)
    await assert.rejects(f.store.readAsset(scope, 'task-a', 'job-a', 'output-a'), /symbolic/)
    await rm(file); await link(external, file)
    await assert.rejects(f.store.readAsset(scope, 'task-a', 'job-a', 'output-a'), /hardlink/)
  })

  it('preserves corrupted and incomplete job evidence; does not restore a stale backup', async () => {
    const f = await fixture(false)
    const file = join(f.task, 'jobs', 'job-a.json')
    await writeFile(`${file}.bak`, JSON.stringify(f.job))
    await writeFile(file, 'broken evidence')
    await assert.rejects(new VideoStore(f.root).getJob(scope, 'task-a', 'job-a'), /preserved/)
    assert.equal(await readFile(file, 'utf8'), 'broken evidence')
    await rm(file)
    await assert.rejects(new VideoStore(f.root).getJob(scope, 'task-a', 'job-a'), /evidence/)
    await assert.rejects(new VideoStore(f.root).listJobs(scope), /evidence/)
  })

  it('never publishes a successful save after fsync failure', async context => {
    const f = await fixture()
    const sync = context.mock.method(VideoFiles.prototype, 'syncDirectory', async () => { throw new Error('disk sync failed') })
    try { await assert.rejects(f.store.saveOutput(scope, 'task-a', 'job-a', output(), stream(), signal()), /sync/) }
    finally { sync.mock.restore() }
    assert.equal((await f.store.getJob(scope, 'task-a', 'job-a'))?.saveStatus, 'PENDING')
    // The durable commit may already exist; final video has not been published.
    assert.equal((await f.store.getAsset(scope, 'task-a', 'job-a', 'output-a'))?.status, 'MISSING')
  })
})
