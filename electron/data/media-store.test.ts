import { afterEach, describe, it, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs, type Mode, type PathLike } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LocalMediaJob, MediaOutput, MediaRunSnapshot } from '../domain/media'
import { MediaStore } from './media-store'
import { ScopePath } from './scope-path'
import { MAX_MEDIA_BYTES } from './media-image'

const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const other = { memberId: 'member-b', enterpriseId: 'enterprise-a' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
const hash = createHash('sha256').update(png).digest('hex')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ store: MediaStore; paths: ScopePath; directory: string; root: string; selected: string }> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-media-'))
  temporaryDirectories.push(directory)
  const root = join(directory, 'user-data')
  await mkdir(root)
  const selected = join(directory, 'selected.not-a-png-extension')
  await writeFile(selected, png)
  return { store: new MediaStore(root), paths: new ScopePath(root), directory, root, selected }
}

function output(outputId = 'output/opaque-id'): MediaOutput {
  return { outputId, mime: 'image/png', size: png.length, width: 1, height: 1, sha256: hash, expiresAt: null }
}

function job(overrides: Partial<LocalMediaJob> = {}): LocalMediaJob {
  const parameters = { aspectRatio: '1:1', count: 1 }
  const requestHash = 'a'.repeat(64)
  return {
    version: 1, owner, jobId: 'job-a', taskId: 'task-a', runId: 'original-run', subscriptionId: 'subscription-a',
    clientRequestId: 'request-a', requestHash,
    input: { profileId: 'profile-a', operation: 'generate', localAssetIds: [], creativeBrief: 'Product photo', parameters },
    profile: { profileId: 'profile-a', kind: 'image', displayName: 'Product', configVersion: 'config-a', operations: ['generate'],
      executionMode: 'async-query', capabilities: { referenceImage: true, cancel: true, recoverByRequestId: true }, allowedAspectRatios: ['1:1'], maxCount: 1 },
    request: { clientRequestId: 'request-a', requestHash, quoteId: 'quote-a', profileId: 'profile-a', configVersion: 'config-a',
      operation: 'generate', referenceIds: [], referenceHashes: [], creativeBrief: 'Product photo', parameters },
    quote: { quoteId: 'quote-a', requestHash, expiresAt: 100, status: 'quoted', amount: '1', currency: 'CNY', authorized: true, budgetAuthorized: true, allowUnknownCost: false },
    approval: 'manual', receiptId: 'receipt-a', submission: 'RECEIPTED', generationStatus: 'SUCCEEDED', trackingStatus: 'ACTIVE',
    saveStatus: 'PENDING', outputs: [output()], billingStatus: 'UNKNOWN', nextPollAt: 0, attempts: 1, error: null, createdAt: 1, updatedAt: 2,
    ...overrides,
  }
}

function snapshot(runId = 'run-a', createdAt = 1): MediaRunSnapshot {
  return { version: 1, owner, taskId: 'task-a', runId, subscriptionId: 'subscription-a', systemPrompt: 'Frozen prompt',
    skills: [{ path: 'skills/product/SKILL.md', sha256: 'b'.repeat(64), version: '1' }], capabilities: null, createdAt }
}

async function* stream(bytes: Uint8Array = png): AsyncIterable<Uint8Array> {
  yield bytes.subarray(0, 5)
  yield bytes.subarray(5)
}

function signal(): AbortSignal { return new AbortController().signal }

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function pauseRename(context: TestContext, destination: string): { entered: Promise<void>; release: () => void; restore: () => void } {
  const entered = deferred()
  const released = deferred()
  const original = fs.rename
  const mocked = context.mock.method(fs, 'rename', async (source: PathLike, target: PathLike) => {
    if (target === destination) {
      entered.resolve()
      await released.promise
    }
    return original(source, target)
  })
  syncBuiltinESMExports()
  return { entered: entered.promise, release: released.resolve, restore: () => { mocked.mock.restore(); syncBuiltinESMExports() } }
}

async function assertPublicationPending(reads: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The rename barrier fixes the interleaving; this timeout only bounds the pending-read assertion.
    const result = await Promise.race([
      reads.then(() => 'fulfilled', () => 'rejected'),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('pending'), 100) }),
    ])
    assert.equal(result, 'pending', 'Reads must wait for the live publication, not classify its temporary files as crash evidence.')
  } finally { clearTimeout(timer) }
}

describe('MediaStore output reference derivation', () => {
  it('derives a reusable task-local reference without changing the source output', async () => {
    const { store } = await fixture()
    await store.saveJob(owner, job())
    const source = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    const reference = await store.deriveReferenceFromOutput(owner, 'task-a', source.localAssetId, signal())
    assert.equal(reference.source, 'reference')
    assert.equal(reference.sha256, source.sha256)
    assert.equal(reference.jobId, null)
    assert.equal(reference.outputId, null)
    assert.deepEqual(reference.derivedFrom, { localAssetId: source.localAssetId, jobId: source.jobId, outputId: source.outputId, sha256: source.sha256 })
    assert.deepEqual(await store.getAsset(owner, 'task-a', source.localAssetId), source)
    assert.deepEqual(await store.readAsset(owner, 'task-a', reference.localAssetId), png)
    assert.deepEqual(await store.deriveReferenceFromOutput(owner, 'task-a', source.localAssetId, signal()), reference)
    assert.equal((await store.listAssets(owner, 'task-a')).length, 2)
  })

  it('reuses an imported reference with the same hash and preserves its identity', async () => {
    const { store, selected } = await fixture()
    const imported = await store.importReference(owner, 'task-a', selected)
    await store.saveJob(owner, job())
    const source = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    assert.deepEqual(await store.deriveReferenceFromOutput(owner, 'task-a', source.localAssetId, signal()), imported)
    assert.equal((await store.getAsset(owner, 'task-a', source.localAssetId))?.source, 'output')
  })

  it('rejects foreign owners, other tasks, missing sources, references and cancellation', async () => {
    const { store, selected } = await fixture()
    await store.saveJob(owner, job())
    const source = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    const reference = await store.importReference(owner, 'task-a', selected)
    await assert.rejects(store.deriveReferenceFromOutput(other, 'task-a', source.localAssetId, signal()))
    await assert.rejects(store.deriveReferenceFromOutput({ ...owner, enterpriseId: 'other-enterprise' }, 'task-a', source.localAssetId, signal()))
    await assert.rejects(store.deriveReferenceFromOutput(owner, 'other-task', source.localAssetId, signal()))
    await assert.rejects(store.deriveReferenceFromOutput(owner, 'task-a', reference.localAssetId, signal()))
    await assert.rejects(store.deriveReferenceFromOutput(owner, 'task-a', source.localAssetId, AbortSignal.abort()))
  })

  it('refuses corrupted source bytes and does not create a reference', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const source = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    await writeFile(join(paths.mediaRoot(owner, 'task-a'), source.relativePath), Buffer.from('damaged image'))
    await assert.rejects(store.deriveReferenceFromOutput(owner, 'task-a', source.localAssetId, signal()))
    assert.equal((await readdir(join(paths.mediaRoot(owner, 'task-a'), 'assets'))).filter(name => name.startsWith('ref_')).length, 0)
  })
})

describe('MediaStore concurrent publication', () => {
  it('reads the opened old manifest after atomic replacement unlinks its inode', { timeout: 5000 }, async context => {
    const { store, root, paths } = await fixture()
    await store.saveJob(owner, job())
    const file = join(paths.mediaRoot(owner, 'task-a'), 'jobs', 'job-a.json')
    const entered = deferred()
    const released = deferred()
    const original = fs.open
    let intercepted = false
    let links: number | undefined
    const mocked = context.mock.method(fs, 'open', async (path: PathLike, flags: string | number, mode?: Mode) => {
      const handle = await original(path, flags, mode)
      if (path === file && !intercepted) {
        intercepted = true
        const originalStat = handle.stat.bind(handle)
        context.mock.method(handle, 'stat', async () => {
          entered.resolve()
          await released.promise
          const stat = await originalStat()
          links = stat.nlink
          return stat
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    const reading = store.getJob(owner, 'task-a', 'job-a')
    void reading.catch(() => undefined)
    try {
      await entered.promise
      const next = job({ saveStatus: 'SAVED', updatedAt: 3 })
      await new MediaStore(root).saveJob(owner, next)
      released.resolve()
      assert.deepEqual(await reading, job())
      assert.equal(links, 0, 'The regression must exercise an unlinked but still readable descriptor.')
      assert.deepEqual(await store.getJob(owner, 'task-a', 'job-a'), next)
    } finally {
      released.resolve()
      await reading.catch(() => undefined)
      mocked.mock.restore()
      syncBuiltinESMExports()
    }
  })

  it('waits for a live first job publication across store instances', { timeout: 5000 }, async context => {
    const { store, root, paths } = await fixture()
    const file = join(paths.mediaRoot(owner, 'task-a'), 'jobs', 'job-a.json')
    const barrier = pauseRename(context, file)
    const publishing = store.saveJob(owner, job())
    void publishing.catch(() => undefined)
    let reads: Promise<unknown[]> | undefined
    try {
      await barrier.entered
      assert.ok((await readdir(join(paths.mediaRoot(owner, 'task-a'), 'jobs'))).some(name => /^job-a\.json\..+\.tmp$/.test(name)))
      const reader = new MediaStore(root)
      reads = Promise.all([reader.listJobs(owner), reader.getJob(owner, 'task-a', 'job-a')])
      await assertPublicationPending(reads)
      barrier.release()
      await publishing
      assert.deepEqual(await reads, [[job()], job()])
    } finally {
      barrier.release()
      await Promise.allSettled([publishing, ...(reads ? [reads] : [])])
      barrier.restore()
    }
  })

  for (const source of ['reference', 'output'] as const) {
    it(`waits for a live first ${source} asset commit across store instances`, { timeout: 5000 }, async context => {
      const { store, root, paths, selected } = await fixture()
      if (source === 'output') await store.saveJob(owner, job())
      const id = source === 'reference' ? `ref_${createHash('sha256').update(hash).digest('hex')}`
        : `out_${createHash('sha256').update(JSON.stringify(['job-a', output().outputId])).digest('hex')}`
      const file = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${id}.json`)
      const barrier = pauseRename(context, `${file}.commit`)
      const publishing = source === 'reference' ? store.importReference(owner, 'task-a', selected)
        : store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
      void publishing.catch(() => undefined)
      let reads: Promise<unknown[]> | undefined
      try {
        await barrier.entered
        assert.ok((await readdir(join(paths.mediaRoot(owner, 'task-a'), 'assets'))).some(name => name.startsWith(`${id}.json.commit.`) && name.endsWith('.tmp')))
        const reader = new MediaStore(root)
        reads = Promise.all([reader.listAssets(owner, 'task-a'), reader.getAsset(owner, 'task-a', id)])
        await assertPublicationPending(reads)
        barrier.release()
        const asset = await publishing
        assert.deepEqual(await reads, [[asset], asset])
        assert.deepEqual(await reader.readAsset(owner, 'task-a', id), png)
      } finally {
        barrier.release()
        await Promise.allSettled([publishing, ...(reads ? [reads] : [])])
        barrier.restore()
      }
    })
  }

  it('preserves abandoned asset commit temporary evidence and refuses to overwrite it', async () => {
    const { store, paths, selected } = await fixture()
    const directory = join(paths.mediaRoot(owner, 'task-a'), 'assets')
    await mkdir(directory, { recursive: true })
    const id = `ref_${createHash('sha256').update(hash).digest('hex')}`
    const temporary = join(directory, `${id}.json.commit.crash-id.tmp`)
    await writeFile(temporary, 'retained crash evidence')
    await assert.rejects(store.listAssets(owner, 'task-a'), /Incomplete media commit/)
    await assert.rejects(store.getAsset(owner, 'task-a', id), /preserved/)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /preserved/)
    assert.equal(await readFile(temporary, 'utf8'), 'retained crash evidence')
  })

  it('does not hide abandoned temporary job evidence beside a valid manifest', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const temporary = join(paths.mediaRoot(owner, 'task-a'), 'jobs', 'job-a.json.crash-id.tmp')
    await writeFile(temporary, 'retained crash evidence')
    await assert.rejects(store.listJobs(owner), /preserved/)
    assert.equal(await readFile(temporary, 'utf8'), 'retained crash evidence')
  })

  it('retries a missing manifest read when its first publication completes during the evidence scan', { timeout: 5000 }, async context => {
    const { store, root, paths } = await fixture()
    const file = join(paths.mediaRoot(owner, 'task-a'), 'jobs', 'job-a.json')
    const entered = deferred()
    const released = deferred()
    const original = fs.open
    let intercepted = false
    const mocked = context.mock.method(fs, 'open', async (path: PathLike, flags: string | number, mode?: Mode) => {
      if (path === file && !intercepted) {
        intercepted = true
        try { return await original(path, flags, mode) } catch (error) {
          entered.resolve()
          await released.promise
          throw error
        }
      }
      return original(path, flags, mode)
    })
    syncBuiltinESMExports()
    const reading = store.getJob(owner, 'task-a', 'job-a')
    void reading.catch(() => undefined)
    try {
      await entered.promise
      await new MediaStore(root).saveJob(owner, job())
      released.resolve()
      assert.deepEqual(await reading, job())
    } finally {
      released.resolve()
      await reading.catch(() => undefined)
      mocked.mock.restore()
      syncBuiltinESMExports()
    }
  })

  it('still rejects hardlinked and symbolic-link job manifests', async () => {
    const { store, paths, directory } = await fixture()
    await store.saveJob(owner, job())
    const file = join(paths.mediaRoot(owner, 'task-a'), 'jobs', 'job-a.json')
    const retained = join(directory, 'hardlinked-job.json')
    await link(file, retained)
    await assert.rejects(store.getJob(owner, 'task-a', 'job-a'), /size or type/)
    await assert.rejects(store.listJobs(owner), /size or type/)
    await rm(file)
    await symlink(retained, file)
    await assert.rejects(store.getJob(owner, 'task-a', 'job-a'), /symbolic/)
    await assert.rejects(store.saveJob(owner, job()), /symbolic/)
  })
})

describe('MediaStore jobs and snapshots', () => {
  it('persists scoped jobs, restores across instances and validates safe IDs', async () => {
    const { store, root } = await fixture()
    await store.saveJob(owner, job())
    assert.deepEqual(await new MediaStore(root).getJob(owner, 'task-a', 'job-a'), job())
    assert.deepEqual(await store.listJobs(owner), [job()])
    assert.equal(await store.getJob(other, 'task-a', 'job-a'), null)
    assert.deepEqual(await store.listJobs(other), [])
    await assert.rejects(store.getJob(owner, '../task', 'job-a'))
    await assert.rejects(store.getJob(owner, 'task-a', '../job'))
    await assert.rejects(store.saveJob(other, job()))
  })

  it('retains malformed MAYBE_SENT evidence and never overwrites it as a missing job', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const file = join(paths.mediaRoot(owner, 'task-a'), 'jobs', 'job-a.json')
    await writeFile(file, '{"submission":"MAYBE_SENT"')
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(store.getJob(owner, 'task-a', 'job-a'), /preserved/)
      await assert.rejects(store.listJobs(owner), /preserved/)
      await assert.rejects(store.saveJob(owner, job()), /preserved/)
    }
    assert.equal(await readFile(file, 'utf8'), '{"submission":"MAYBE_SENT"')
  })

  it('does not interpret backup or quarantined evidence as a new request', async () => {
    const { store, paths } = await fixture()
    const directory = join(paths.mediaRoot(owner, 'task-a'), 'jobs')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'job-a.json.bak')
    await writeFile(file, JSON.stringify(job()))
    await assert.rejects(store.getJob(owner, 'task-a', 'job-a'), /preserved/)
    await assert.rejects(store.listJobs(owner), /preserved/)
    await rm(file)
    await writeFile(join(directory, 'job-a.json.corrupt-test.json'), 'broken')
    await assert.rejects(store.getJob(owner, 'task-a', 'job-a'), /preserved/)
    await assert.rejects(store.listJobs(owner))
  })

  it('does not mistake an interrupted atomic job write for a never-submitted request', async () => {
    const { store, paths } = await fixture()
    const directory = join(paths.mediaRoot(owner, 'task-a'), 'jobs')
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, 'job-a.json.crash-id.tmp')
    await writeFile(temporary, JSON.stringify(job({ generationStatus: 'SUBMISSION_UNKNOWN', submission: 'MAYBE_SENT', receiptId: null })))
    await assert.rejects(store.getJob(owner, 'task-a', 'job-a'), /preserved/)
    await assert.rejects(store.listJobs(owner), /preserved/)
    await assert.rejects(store.saveJob(owner, job()), /preserved/)
    assert.ok((await readFile(temporary, 'utf8')).includes('MAYBE_SENT'))
  })

  it('validates persisted versions, owner, identity, enums and nested receipts', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const file = join(paths.mediaRoot(owner, 'task-a'), 'jobs', 'job-a.json')
    for (const corrupt of [{ version: 2 }, { owner: other }, { jobId: 'job-b' }, { taskId: 'task-b' }, { runId: '../run' },
      { generationStatus: 'COMPLETED' }, { trackingStatus: 'BOGUS' }, { saveStatus: 'DONE' }, { outputs: [{ ...output(), sha256: 'bad' }] },
      { request: { ...job().request, clientRequestId: 'request-b' } }]) {
      await writeFile(file, JSON.stringify({ ...job(), ...corrupt }))
      await assert.rejects(store.getJob(owner, 'task-a', 'job-a'))
    }
  })

  it('prevents changing stable request, original run, quote and completed output identity', async () => {
    const { store } = await fixture()
    await store.saveJob(owner, job())
    for (const change of [{ runId: 'run-b' }, { subscriptionId: 'subscription-b' }, { createdAt: 0 }, { updatedAt: 1 }, { attempts: -1 },
      { generationStatus: 'RUNNING' as const }, { receiptId: 'receipt-b' }, { outputs: [] }, { outputs: [{ ...output(), sha256: 'b'.repeat(64) }] },
      { clientRequestId: 'request-b', request: { ...job().request, clientRequestId: 'request-b' } },
      { requestHash: 'c'.repeat(64), request: { ...job().request, requestHash: 'c'.repeat(64) }, quote: { ...job().quote, requestHash: 'c'.repeat(64) } }]) {
      await assert.rejects(store.saveJob(owner, job(change)))
    }
    await store.saveJob(owner, job({ saveStatus: 'SAVED', updatedAt: 3 }))
    assert.equal((await store.getJob(owner, 'task-a', 'job-a'))?.saveStatus, 'SAVED')
  })

  it('serializes writes across instances and blocks duplicate request IDs across tasks', async () => {
    const { store, root } = await fixture()
    const otherStore = new MediaStore(root)
    const results = await Promise.allSettled([store.saveJob(owner, job()), otherStore.saveJob(owner, job({ taskId: 'task-b', jobId: 'job-b' }))])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await store.listJobs(owner)).length, 1)
    await store.saveJob(other, job({ owner: other }))
    assert.equal((await store.listJobs(other)).length, 1)
  })

  it('allows monotonic submission and generation updates but rejects regression', async () => {
    const { store } = await fixture()
    const initial = job({ submission: 'NOT_SENT', receiptId: null, generationStatus: 'SUBMITTING', outputs: [], attempts: 0 })
    await store.saveJob(owner, initial)
    const sent = { ...initial, submission: 'MAYBE_SENT' as const, generationStatus: 'SUBMISSION_UNKNOWN' as const, updatedAt: 3 }
    await store.saveJob(owner, sent)
    await assert.rejects(store.saveJob(owner, { ...initial, updatedAt: 4 }))
    const queued = { ...sent, submission: 'RECEIPTED' as const, receiptId: 'receipt-a', generationStatus: 'QUEUED' as const, updatedAt: 4 }
    await store.saveJob(owner, queued)
    await assert.rejects(store.saveJob(owner, { ...queued, generationStatus: 'SUBMITTING', updatedAt: 5 }))
    await store.saveJob(owner, { ...queued, generationStatus: 'RUNNING', updatedAt: 5 })
    await assert.rejects(store.saveJob(owner, { ...queued, updatedAt: 6 }))
    await store.saveJob(owner, job({ updatedAt: 6 }))
    await store.saveJob(owner, job({ generationStatus: 'RESULT_EXPIRED', updatedAt: 7 }))
  })

  it('stores immutable per-run snapshots and selects the latest run by timestamp', async () => {
    const { store, root } = await fixture()
    assert.equal(await store.getSnapshot(owner, 'task-a'), null)
    await store.saveSnapshot(owner, snapshot('run-a', 10))
    await store.saveSnapshot(owner, snapshot('run-b', 5))
    await store.saveSnapshot(owner, snapshot('run-a', 10))
    await assert.rejects(store.saveSnapshot(owner, { ...snapshot('run-a', 10), systemPrompt: 'Changed' }), /immutable/)
    assert.deepEqual(await new MediaStore(root).getSnapshot(owner, 'task-a'), snapshot('run-a', 10))
    assert.deepEqual(await store.getSnapshot(owner, 'task-a', 'run-b'), snapshot('run-b', 5))
    assert.equal(await store.getSnapshot(other, 'task-a'), null)
    await assert.rejects(store.saveSnapshot(other, snapshot()))
  })

  it('preserves snapshot corruption and refuses invalid owners/ids/versions', async () => {
    const { store, paths } = await fixture()
    await store.saveSnapshot(owner, snapshot())
    const file = join(paths.mediaRoot(owner, 'task-a'), 'snapshots', 'run-a.json')
    for (const corruption of [{ version: 2 }, { owner: other }, { taskId: 'task-b' }, { runId: 'run-b' }, { capabilities: {} }]) {
      await writeFile(file, JSON.stringify({ ...snapshot(), ...corruption }))
      await assert.rejects(store.getSnapshot(owner, 'task-a'))
      await assert.rejects(store.saveSnapshot(owner, snapshot()))
    }
  })

  it('treats an undefined optional runtime snapshot as absent across repeated saves', async () => {
    const { store, root } = await fixture()
    const value = { ...snapshot(), runtimeSnapshot: undefined }
    await store.saveSnapshot(owner, value)
    await store.saveSnapshot(owner, value)
    await new MediaStore(root).saveSnapshot(owner, snapshot())
    assert.deepEqual(await store.getSnapshot(owner, 'task-a'), snapshot())
  })

  it('preserves the complete employee runtime snapshot immutably and validates its owner and installed skills', async () => {
    const { store, root } = await fixture()
    const runtimeSnapshot = {
      manifestVersion: 1 as const, subscriptionId: 'subscription-a', enterpriseId: owner.enterpriseId, memberId: owner.memberId,
      employeeId: 'employee-a', templateVersion: 'template-1', employeeVersion: 'employee-2', maxSteps: 20,
      systemPrompt: 'Frozen prompt', modelId: 'model-a', allowedModels: ['model-a', 'model-b'],
      approvedSkills: [{ capabilityId: 'product', name: 'Product', description: null, versionId: 'approved-1', version: '0.9', content: 'Approved skill' }],
      skills: [{ capabilityId: 'product', versionId: 'local-1', baseSkillVersionId: 'approved-1', version: '1', source: 'owner-local' as const,
        name: 'product', description: 'Product skill', content: 'Installed owner skill', path: 'skills/product/SKILL.md', sha256: 'b'.repeat(64) }],
    }
    const complete = { ...snapshot(), runtimeSnapshot }
    await store.saveSnapshot(owner, complete)
    assert.deepEqual(await new MediaStore(root).getSnapshot(owner, 'task-a', 'run-a'), complete)
    await assert.rejects(store.saveSnapshot(owner, { ...complete, runtimeSnapshot: { ...runtimeSnapshot, modelId: 'model-b' } }), /immutable/)
    for (const invalid of [{ enterpriseId: 'other-enterprise' }, { memberId: 'other-member' }, { subscriptionId: 'other-subscription' },
      { systemPrompt: 'Different prompt' }, { skills: [] }, { manifestVersion: 2 }]) {
      await assert.rejects(store.saveSnapshot(owner, { ...complete, runId: 'run-invalid', runtimeSnapshot: { ...runtimeSnapshot, ...invalid } } as MediaRunSnapshot))
    }
  })

  it('rejects a snapshot whose serialized multibyte prompt would exceed the readable manifest limit', async () => {
    const { store } = await fixture()
    await assert.rejects(store.saveSnapshot(owner, { ...snapshot(), systemPrompt: '\u4e00'.repeat(1_500_000) }), /manifest exceeds/)
    assert.equal(await store.getSnapshot(owner, 'task-a'), null)
  })

  it('archives without losing job/assets/snapshots or hiding jobs from background scans', async () => {
    const { store, selected, paths } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    await store.saveJob(owner, job())
    await store.saveSnapshot(owner, snapshot())
    assert.equal(await store.isArchived(owner, 'task-a'), false)
    await store.archive(owner, 'task-a')
    await store.archive(owner, 'task-a')
    assert.equal(await store.isArchived(owner, 'task-a'), true)
    assert.equal(await store.isArchived(other, 'task-a'), false)
    assert.equal((await store.listJobs(owner)).length, 1)
    assert.equal((await store.listAssets(owner, 'task-a')).length, 1)
    assert.deepEqual(await store.readAsset(owner, 'task-a', asset.localAssetId), png)
    assert.deepEqual(await store.getSnapshot(owner, 'task-a'), snapshot())
    const archive = join(paths.mediaRoot(owner, 'task-a'), 'archive.json')
    await writeFile(archive, 'invalid')
    await assert.rejects(store.isArchived(owner, 'task-a'))
    await assert.rejects(store.archive(owner, 'task-a'))
  })
})

describe('MediaStore images', () => {
  it('copies native selections into scope-owned files and deduplicates references', async () => {
    const { store, paths, selected, root } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    assert.equal(asset.mime, 'image/png')
    assert.equal(asset.sha256, hash)
    assert.equal(asset.source, 'reference')
    assert.match(asset.localAssetId, /^ref_[a-f0-9]{64}$/)
    assert.ok(!JSON.stringify(asset).includes(selected))
    await rm(selected)
    assert.deepEqual(await new MediaStore(root).readAsset(owner, 'task-a', asset.localAssetId), png)
    await writeFile(selected, png)
    assert.deepEqual(await store.importReference(owner, 'task-a', selected), asset)
    const internal = join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)
    assert.deepEqual(await readFile(internal), png)
    assert.equal(await store.getAsset(other, 'task-a', asset.localAssetId), null)
    assert.equal(await store.getAsset(owner, 'task-b', asset.localAssetId), null)
  })

  it('recovers a reference whose image rename failed after its commit without changing identity', async context => {
    const { store, paths, selected, root } = await fixture()
    const id = `ref_${createHash('sha256').update(hash).digest('hex')}`
    const mediaRoot = paths.mediaRoot(owner, 'task-a')
    const file = join(mediaRoot, 'files', `${id}.png`)
    const manifest = join(mediaRoot, 'assets', `${id}.json`)
    const original = fs.rename
    const failing = context.mock.method(fs, 'rename', async (source: PathLike, target: PathLike) => {
      if (target === file) throw new Error('Mock crash before reference image rename')
      return original(source, target)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(store.importReference(owner, 'task-a', selected), /Mock crash/)
    } finally { failing.mock.restore(); syncBuiltinESMExports() }
    const commit = await readFile(`${manifest}.commit`, 'utf8')
    const committed = JSON.parse(commit)
    assert.equal(committed.localAssetId, id)
    assert.equal((await store.getAsset(owner, 'task-a', id))?.status, 'MISSING')
    assert.deepEqual(await readdir(join(mediaRoot, 'files')), [])
    const reopened = new MediaStore(root)
    assert.deepEqual(await reopened.importReference(owner, 'task-a', selected), committed)
    assert.equal(await readFile(`${manifest}.commit`, 'utf8'), commit)
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), committed)
    assert.deepEqual(await reopened.readAsset(owner, 'task-a', id), png)
    assert.deepEqual(await reopened.importReference(owner, 'task-a', selected), committed)
  })

  it('restores missing reference bytes from a repeated selection while retaining all original metadata', async () => {
    const { store, paths, selected, root } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const file = join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)
    await rm(file)
    assert.equal((await store.getAsset(owner, 'task-a', asset.localAssetId))?.status, 'MISSING')
    assert.deepEqual(await new MediaStore(root).importReference(owner, 'task-a', selected), asset)
    assert.deepEqual(await store.readAsset(owner, 'task-a', asset.localAssetId), png)
  })

  it('serializes repeated reference recovery across store instances without changing identity or commit evidence', async () => {
    const { store, paths, selected, root } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json`)
    const commit = await readFile(`${manifest}.commit`, 'utf8')
    await rm(join(paths.mediaRoot(owner, 'task-a'), asset.relativePath))
    await rm(manifest)
    const recovered = await Promise.all([store.importReference(owner, 'task-a', selected),
      new MediaStore(root).importReference(owner, 'task-a', selected)])
    assert.deepEqual(recovered, [asset, asset])
    assert.equal(await readFile(`${manifest}.commit`, 'utf8'), commit)
    assert.deepEqual(await store.listAssets(owner, 'task-a'), [asset])
    assert.deepEqual(await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files')), [`${asset.localAssetId}.png`])
  })

  it('restores a missing reference manifest from a verified commit without replacing its image', async context => {
    const { store, paths, selected, root } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const file = join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json`)
    await rm(manifest)
    const original = fs.rename
    const guarded = context.mock.method(fs, 'rename', async (source: PathLike, target: PathLike) => {
      assert.notEqual(target, file, 'Verified reference bytes must not be overwritten during manifest recovery.')
      return original(source, target)
    })
    syncBuiltinESMExports()
    try {
      assert.deepEqual(await new MediaStore(root).importReference(owner, 'task-a', selected), asset)
      assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), asset)
    } finally { guarded.mock.restore(); syncBuiltinESMExports() }
  })

  it('does not recover a missing reference when its commit metadata disagrees with the selected image', async () => {
    const { store, paths, selected } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const file = join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json`)
    await rm(file)
    await rm(manifest)
    const changedCommit = JSON.stringify({ ...asset, width: 2 })
    await writeFile(`${manifest}.commit`, changedCommit)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /differs/)
    assert.equal(await readFile(`${manifest}.commit`, 'utf8'), changedCommit)
    await assert.rejects(readFile(file), { code: 'ENOENT' })
    await assert.rejects(readFile(manifest), { code: 'ENOENT' })
  })

  it('refuses orphaned reference files without recreating metadata or overwriting the bytes', async () => {
    const { store, paths, selected } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const file = join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json`)
    await rm(manifest)
    await rm(`${manifest}.commit`)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /Orphaned/)
    assert.deepEqual(await readFile(file), png)
    await assert.rejects(readFile(manifest), { code: 'ENOENT' })
    await assert.rejects(readFile(`${manifest}.commit`), { code: 'ENOENT' })
  })

  it('refuses to overwrite tampered reference bytes during repeated import', async () => {
    const { store, paths, selected } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const file = join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)
    const tampered = Buffer.from(png)
    tampered[45] ^= 1
    await writeFile(file, tampered)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /match/)
    assert.deepEqual(await readFile(file), tampered)
  })

  it('rejects header-only JPEG references and outputs even when receipt metadata matches', async () => {
    const { store, selected, paths } = await fixture()
    const headerOnly = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9])
    await writeFile(selected, headerOnly)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /Invalid/)
    const expected: MediaOutput = { ...output(), mime: 'image/jpeg', size: headerOnly.length, sha256: createHash('sha256').update(headerOnly).digest('hex') }
    await store.saveJob(owner, job({ outputs: [expected] }))
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', expected, stream(headerOnly), signal()), /Invalid/)
    assert.deepEqual(await store.listAssets(owner, 'task-a'), [])
    assert.deepEqual(await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files')), [])
  })

  it('streams validated outputs and deduplicates output IDs without consuming another stream', async () => {
    const { store, root, paths } = await fixture()
    await store.saveJob(owner, job())
    const asset = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    assert.match(asset.localAssetId, /^out_[a-f0-9]{64}$/)
    assert.equal(asset.outputId, output().outputId)
    assert.deepEqual(await store.readAsset(owner, 'task-a', asset.localAssetId), png)
    const neverConsume = (async function* () { throw new Error('Must not download twice'); yield png })()
    assert.deepEqual(await new MediaStore(root).saveOutput(owner, 'task-a', 'job-a', output(), neverConsume, signal()), asset)
    assert.equal((await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files'))).some(name => name.endsWith('.part')), false)
  })

  it('recovers a renamed output with a missing manifest from its durable commit without downloading', async () => {
    const { store, root, paths } = await fixture()
    await store.saveJob(owner, job())
    const asset = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json`)
    await rm(manifest)
    const reopened = new MediaStore(root)
    assert.deepEqual(await reopened.listAssets(owner, 'task-a'), [asset])
    const unused = (async function* () { throw new Error('No regeneration/download on recovery'); yield png })()
    assert.deepEqual(await reopened.saveOutput(owner, 'task-a', 'job-a', output(), unused, signal()), asset)
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), asset)
  })

  it('recovers after the actual final manifest write fails following a successful image rename', async () => {
    const { store, root, paths, selected } = await fixture()
    await store.saveJob(owner, job())
    const id = `out_${createHash('sha256').update(JSON.stringify(['job-a', output().outputId])).digest('hex')}`
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${id}.json`)
    const failing = (async function* () {
      yield png
      await mkdir(join(paths.mediaRoot(owner, 'task-a'), 'assets'), { recursive: true })
      await symlink(selected, manifest)
    })()
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), failing, signal()), /symbolic/)
    assert.deepEqual(await readFile(join(paths.mediaRoot(owner, 'task-a'), 'files', `${id}.png`)), png)
    assert.equal(JSON.parse(await readFile(`${manifest}.commit`, 'utf8')).localAssetId, id)
    await rm(manifest)
    const unused = (async function* () { throw new Error('Must recover without consuming stream'); yield png })()
    const asset = await new MediaStore(root).saveOutput(owner, 'task-a', 'job-a', output(), unused, signal())
    assert.equal(asset.localAssetId, id)
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), asset)
  })

  it('serializes simultaneous output saves across instances without duplicate downloads', async () => {
    const { store, root } = await fixture()
    await store.saveJob(owner, job())
    let downloads = 0
    const tracked = (): AsyncIterable<Uint8Array> => (async function* () { downloads++; yield png })()
    const assets = await Promise.all([store.saveOutput(owner, 'task-a', 'job-a', output(), tracked(), signal()),
      new MediaStore(root).saveOutput(owner, 'task-a', 'job-a', output(), tracked(), signal())])
    assert.equal(downloads, 1)
    assert.deepEqual(assets[0], assets[1])
    assert.equal((await store.listAssets(owner, 'task-a')).length, 1)
  })

  it('rejects orphaned output files rather than overwriting or redownloading them', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const asset = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json`)
    await rm(manifest)
    await rm(`${manifest}.commit`)
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal()), /Orphaned/)
    assert.deepEqual(await readFile(join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)), png)
  })

  it('validates receipt hash, MIME, byte size and dimensions before committing output', async () => {
    const { store, paths } = await fixture()
    for (const mismatch of [{ sha256: 'b'.repeat(64) }, { mime: 'image/jpeg' as const }, { size: png.length + 1 }, { width: 2 }, { height: 2 }]) {
      const expected = { ...output(), ...mismatch }
      await store.saveJob(owner, job())
      await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', expected, stream(), signal()), /authorized/)
    }
    // A receipt can itself be wrong: the store must check the streamed bytes too.
    for (let index = 0; index < 5; index++) {
      const mismatch = [{ sha256: 'b'.repeat(64) }, { mime: 'image/jpeg' as const }, { size: png.length + 1 }, { width: 2 }, { height: 2 }][index]
      const expected = { ...output(`output-${index}`), ...mismatch }
      const record = job({ jobId: `job-${index}`, clientRequestId: `request-${index}`, request: { ...job().request, clientRequestId: `request-${index}` }, outputs: [expected] })
      await store.saveJob(owner, record)
      await assert.rejects(store.saveOutput(owner, 'task-a', record.jobId, expected, stream(), signal()), /match/)
    }
    assert.deepEqual(await store.listAssets(owner, 'task-a'), [])
    assert.deepEqual(await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files')), [])
  })

  it('rejects oversized inputs, invalid SVG images and oversized output streams', async () => {
    const { store, selected, paths } = await fixture()
    await writeFile(selected, '<svg width="1" height="1"/>')
    await assert.rejects(store.importReference(owner, 'task-a', selected))
    await writeFile(selected, Buffer.alloc(MAX_MEDIA_BYTES + 1))
    await assert.rejects(store.importReference(owner, 'task-a', selected))
    await store.saveJob(owner, job())
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), stream(Buffer.alloc(MAX_MEDIA_BYTES + 1)), signal()), /32 MB/)
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), stream(Buffer.from('<svg/>')), signal()))
    assert.deepEqual(await store.listAssets(owner, 'task-a'), [])
    assert.deepEqual(await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files')), [])
  })

  it('cleans .part files after cancellation and interrupted streams, and permits retry', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const controller = new AbortController()
    const cancelled = (async function* () { yield png.subarray(0, 5); controller.abort(); yield png.subarray(5) })()
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), cancelled, controller.signal))
    const failed = (async function* () { yield png.subarray(0, 5); throw new Error('Network lost') })()
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), failed, signal()), /Network lost/)
    assert.deepEqual(await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files')), [])
    assert.equal((await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())).status, 'SAVED')
  })

  it('refuses invalid stream chunks and already-aborted transfers without leaving output files', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const invalid = (async function* () { yield 'untrusted string' as unknown as Uint8Array })()
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), invalid, signal()), /chunk/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), controller.signal))
    assert.deepEqual(await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files')), [])
  })

  it('aborts promptly while a content iterator is stalled', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const controller = new AbortController()
    const stalled: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
    const pending = store.saveOutput(owner, 'task-a', 'job-a', output(), stalled, controller.signal)
    const timer = setTimeout(() => controller.abort(), 25)
    try { await assert.rejects(pending) } finally { clearTimeout(timer) }
    assert.deepEqual(await readdir(join(paths.mediaRoot(owner, 'task-a'), 'files')), [])
  })

  it('maps missing assets to MISSING without deleting manifests and can redownload the same output', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const asset = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    await rm(join(paths.mediaRoot(owner, 'task-a'), asset.relativePath))
    assert.equal((await store.listAssets(owner, 'task-a'))[0]?.status, 'MISSING')
    await assert.rejects(store.readAsset(owner, 'task-a', asset.localAssetId))
    await assert.rejects(store.exportAsset(owner, 'task-a', asset.localAssetId, join(paths.dataRoot(), 'missing-export.png')))
    assert.deepEqual(await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal()), asset)
  })

  it('rejects file tampering and manifest hash/MIME/dimensions/path/identity mismatches', async () => {
    const { store, paths, selected } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const root = paths.mediaRoot(owner, 'task-a')
    const file = join(root, asset.relativePath)
    const manifest = join(root, 'assets', `${asset.localAssetId}.json`)
    const tampered = Buffer.from(png)
    tampered[45] ^= 1
    await writeFile(file, tampered)
    await assert.rejects(store.readAsset(owner, 'task-a', asset.localAssetId), /match/)
    await assert.rejects(store.listAssets(owner, 'task-a'), /match/)
    await writeFile(file, png)
    await rm(`${manifest}.commit`)
    for (const mismatch of [{ relativePath: '../../secret.png' }, { relativePath: `/tmp/${asset.localAssetId}.png` }, { owner: other },
      { width: 2 }, { mime: 'image/jpeg' }, { size: png.length + 1 }, { localAssetId: 'other' }, { version: 2 }, { status: 'SAVING' }]) {
      await writeFile(manifest, JSON.stringify({ ...asset, ...mismatch }))
      await assert.rejects(store.readAsset(owner, 'task-a', asset.localAssetId))
    }
    await writeFile(manifest, 'broken')
    await assert.rejects(store.listAssets(owner, 'task-a'))
    assert.equal(await readFile(manifest, 'utf8'), 'broken')
  })

  it('checks actual output hash even when its valid manifest is changed in isolation', async () => {
    const { store, paths } = await fixture()
    await store.saveJob(owner, job())
    const asset = await store.saveOutput(owner, 'task-a', 'job-a', output(), stream(), signal())
    const manifest = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json`)
    await rm(`${manifest}.commit`)
    await writeFile(manifest, JSON.stringify({ ...asset, sha256: 'b'.repeat(64) }))
    await assert.rejects(store.readAsset(owner, 'task-a', asset.localAssetId), /match/)
  })

  it('rejects disagreement or corruption in retained commit records rather than hiding evidence', async () => {
    const { store, paths, selected } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const commit = join(paths.mediaRoot(owner, 'task-a'), 'assets', `${asset.localAssetId}.json.commit`)
    await writeFile(commit, JSON.stringify({ ...asset, createdAt: asset.createdAt + 1 }))
    await assert.rejects(store.readAsset(owner, 'task-a', asset.localAssetId), /disagree/)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /disagree/)
    await writeFile(commit, 'broken')
    await assert.rejects(store.getAsset(owner, 'task-a', asset.localAssetId), /preserved/)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /preserved/)
    assert.equal(await readFile(commit, 'utf8'), 'broken')
  })

  it('refuses symbolic links and hardlinked internal files', async () => {
    const { store, paths, selected, directory } = await fixture()
    const linkedInput = join(directory, 'linked-input.png')
    await symlink(selected, linkedInput)
    await assert.rejects(store.importReference(owner, 'task-a', linkedInput), /symbolic/)
    const asset = await store.importReference(owner, 'task-a', selected)
    const file = join(paths.mediaRoot(owner, 'task-a'), asset.relativePath)
    await rm(file)
    await symlink(selected, file)
    await assert.rejects(store.readAsset(owner, 'task-a', asset.localAssetId), /symbolic/)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /symbolic/)
    await assert.rejects(store.exportAsset(owner, 'task-a', asset.localAssetId, join(directory, 'export.png')), /symbolic/)
    await rm(file)
    await symlink(join(directory, 'missing.png'), file)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /symbolic/)
    await rm(file)
    await link(selected, file)
    await assert.rejects(store.readAsset(owner, 'task-a', asset.localAssetId), /type/)
    await assert.rejects(store.importReference(owner, 'task-a', selected), /type/)
  })

  it('refuses directory symlinks before reading or writing scope data', async () => {
    const { store, paths, selected, directory } = await fixture()
    const task = paths.taskDir(owner, 'task-a')
    await mkdir(task, { recursive: true })
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await symlink(outside, join(task, 'media'))
    await assert.rejects(store.importReference(owner, 'task-a', selected), /symbolic/)
    await assert.rejects(store.saveJob(owner, job()), /symbolic/)
    await assert.rejects(store.listJobs(owner), /symbolic/)
    assert.deepEqual(await readdir(outside), [])
  })

  it('exports verified images only to native absolute destinations and rejects symlink destinations', async () => {
    const { store, selected, directory, root } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const destination = join(directory, 'export.png')
    await writeFile(destination, 'Previous export')
    await store.exportAsset(owner, 'task-a', asset.localAssetId, destination)
    assert.deepEqual(await readFile(destination), png)
    await assert.rejects(store.exportAsset(owner, 'task-a', asset.localAssetId, 'relative.png'))
    await assert.rejects(store.importReference(owner, 'task-a', 'relative.png'))
    await assert.rejects(store.exportAsset(owner, 'task-a', asset.localAssetId, join(root, 'overwrite.json')), /persistence/)
    await rm(destination)
    await symlink(selected, destination)
    await assert.rejects(store.exportAsset(owner, 'task-a', asset.localAssetId, destination), /symbolic/)
    assert.deepEqual(await readFile(selected), png)
    const linkDir = join(directory, 'linked-dir')
    await symlink(directory, linkDir)
    await assert.rejects(store.exportAsset(owner, 'task-a', asset.localAssetId, join(linkDir, 'export.png')), /symbolic/)
  })
})

describe('MediaStore reference import authorization fencing', () => {
  const id = `ref_${createHash('sha256').update(hash).digest('hex')}`

  for (const stage of ['part write', 'part sync', 'commit publication'] as const) {
    for (const interruption of ['revoke', 'abort'] as const) {
      it(`does not publish reference bytes after ${interruption} during ${stage}`, async context => {
        const { store, paths, selected, root } = await fixture()
        const mediaRoot = paths.mediaRoot(owner, 'task-a')
        const files = join(mediaRoot, 'files')
        const assets = join(mediaRoot, 'assets')
        const file = join(files, `${id}.png`)
        const manifest = join(assets, `${id}.json`)
        const commit = `${manifest}.commit`
        await mkdir(assets, { recursive: true })
        const controller = new AbortController()
        const reason = new Error(`Import ${interruption} at ${stage}`)
        let revision = 1, intercepted = false
        const published: string[] = []
        const interrupt = (): void => {
          intercepted = true
          if (interruption === 'abort') controller.abort(reason)
          else revision++
        }
        const validate = (): void => { if (revision !== 1) throw reason }
        const originalOpen = fs.open
        const originalRename = fs.rename
        const mockedOpen = context.mock.method(fs, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
          const handle = await originalOpen(path, flags, mode)
          if (String(path).startsWith(`${file}.`) && String(path).endsWith('.part')) {
            if (stage === 'part write') {
              const write = handle.write.bind(handle)
              context.mock.method(handle, 'write', async (buffer: Uint8Array, offset: number, length: number) => {
                const result = await write(buffer, offset, length)
                interrupt()
                return result
              })
            } else if (stage === 'part sync') {
              const sync = handle.sync.bind(handle)
              context.mock.method(handle, 'sync', async () => { await sync(); interrupt() })
            }
          }
          return handle
        })
        const mockedRename = context.mock.method(fs, 'rename', async (source: PathLike, target: PathLike) => {
          if (target === file || target === manifest) published.push(String(target))
          await originalRename(source, target)
          if (stage === 'commit publication' && target === commit) interrupt()
        })
        syncBuiltinESMExports()
        try {
          await assert.rejects(store.importReference(owner, 'task-a', selected, controller.signal, validate), error => error === reason)
          assert.equal(intercepted, true, 'The intended asynchronous boundary must have been exercised.')
          assert.equal(controller.signal.aborted, interruption === 'abort')
          assert.deepEqual(published, [], 'Neither the reference image nor the delivery manifest may be published.')
          assert.deepEqual(await readdir(files), [], 'Cancelled/revoked copies must clean all .part files.')
          if (stage === 'commit publication') {
            // A commit completed before revocation is retained evidence, not a delivered image.
            assert.deepEqual(await readdir(assets), [`${id}.json.commit`])
            assert.equal(JSON.parse(await readFile(commit, 'utf8')).localAssetId, id)
            assert.equal((await store.getAsset(owner, 'task-a', id))?.status, 'MISSING')
          } else {
            assert.deepEqual(await readdir(assets), [])
            assert.deepEqual(await store.listAssets(owner, 'task-a'), [])
          }
          assert.deepEqual(await readFile(selected), png)
        } finally {
          mockedRename.mock.restore()
          mockedOpen.mock.restore()
          syncBuiltinESMExports()
        }
        // Cancellation/revocation cannot poison a later authorized legacy import or recovery.
        const reopened = new MediaStore(root)
        const asset = await reopened.importReference(owner, 'task-a', selected)
        assert.equal(asset.localAssetId, id)
        assert.deepEqual(await reopened.readAsset(owner, 'task-a', id), png)
        assert.deepEqual(await readdir(files), [`${id}.png`])
        assert.deepEqual((await readdir(assets)).sort(), [`${id}.json`, `${id}.json.commit`])
      })
    }
  }

  it('rejects entry cancellation and validation errors before reading or publishing', async context => {
    const { store, selected, root } = await fixture()
    const reason = new Error('Import authorization unavailable')
    const controller = new AbortController()
    controller.abort(reason)
    const originalOpen = fs.open
    const opened: PathLike[] = []
    const mocked = context.mock.method(fs, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
      opened.push(path)
      return originalOpen(path, flags, mode)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(store.importReference(owner, 'task-a', selected, controller.signal), error => error === reason)
      await assert.rejects(store.importReference(owner, 'task-a', selected, signal(), () => { throw reason }), error => error === reason)
      assert.deepEqual(opened, [])
      assert.deepEqual(await readdir(root), [])
      assert.deepEqual(await readFile(selected), png)
    } finally { mocked.mock.restore(); syncBuiltinESMExports() }
  })

  for (const interruption of ['revoke', 'abort'] as const) {
    it(`preserves an existing reference when ${interruption} occurs during deduplication verification`, async context => {
      const { store, selected, paths } = await fixture()
      const asset = await store.importReference(owner, 'task-a', selected)
      const mediaRoot = paths.mediaRoot(owner, 'task-a')
      const file = join(mediaRoot, asset.relativePath)
      const manifest = join(mediaRoot, 'assets', `${id}.json`)
      const originalManifest = await readFile(manifest)
      const originalCommit = await readFile(`${manifest}.commit`)
      const originalOpen = fs.open
      const originalRename = fs.rename
      const controller = new AbortController()
      const reason = new Error(`Existing reference ${interruption}`)
      let revision = 1, intercepted = false, renames = 0
      const mockedOpen = context.mock.method(fs, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
        const handle = await originalOpen(path, flags, mode)
        if (path === file) {
          const stat = handle.stat.bind(handle)
          context.mock.method(handle, 'stat', async () => {
            const result = await stat()
            intercepted = true
            if (interruption === 'abort') controller.abort(reason)
            else revision++
            return result
          })
        }
        return handle
      })
      const mockedRename = context.mock.method(fs, 'rename', async (source: PathLike, target: PathLike) => {
        renames++
        return originalRename(source, target)
      })
      syncBuiltinESMExports()
      try {
        await assert.rejects(store.importReference(owner, 'task-a', selected, controller.signal, () => {
          if (revision !== 1) throw reason
        }), error => error === reason)
        assert.equal(intercepted, true)
        assert.equal(renames, 0, 'A stale deduplication must not rewrite the existing manifest.')
        assert.deepEqual(await readFile(file), png)
        assert.deepEqual(await readFile(manifest), originalManifest)
        assert.deepEqual(await readFile(`${manifest}.commit`), originalCommit)
        assert.deepEqual(await readdir(join(mediaRoot, 'files')), [`${id}.png`])
        assert.deepEqual((await readdir(join(mediaRoot, 'assets'))).sort(), [`${id}.json`, `${id}.json.commit`])
      } finally {
        mockedRename.mock.restore()
        mockedOpen.mock.restore()
        syncBuiltinESMExports()
      }
      assert.deepEqual(await store.importReference(owner, 'task-a', selected), asset)
      assert.deepEqual(await store.readAsset(owner, 'task-a', id), png)
    })
  }

  for (const metadata of ['commit', 'existing manifest', 'final manifest'] as const) {
    for (const interruption of ['revoke', 'abort'] as const) {
      it(`does not publish ${metadata} after ${interruption} during its temporary JSON write`, async context => {
        const { store, selected, paths } = await fixture()
        const mediaRoot = paths.mediaRoot(owner, 'task-a')
        const assets = join(mediaRoot, 'assets')
        const file = join(mediaRoot, 'files', `${id}.png`)
        const manifest = join(assets, `${id}.json`)
        const target = metadata === 'commit' ? `${manifest}.commit` : manifest
        let retainedCommit: Buffer | undefined
        if (metadata === 'existing manifest') {
          await store.importReference(owner, 'task-a', selected)
          retainedCommit = await readFile(`${manifest}.commit`)
          await rm(manifest)
        }
        const controller = new AbortController()
        const reason = new Error(`${metadata} ${interruption} before JSON publication`)
        let revision = 1, intercepted = false
        const originalOpen = fs.open
        const mocked = context.mock.method(fs, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
          const handle = await originalOpen(path, flags, mode)
          const name = String(path)
          if (name.startsWith(`${target}.`) && /^[^.]+\.tmp$/.test(name.slice(target.length + 1))) {
            const write = handle.writeFile.bind(handle)
            context.mock.method(handle, 'writeFile', async (...args: Parameters<typeof handle.writeFile>) => {
              await write(...args)
              intercepted = true
              if (interruption === 'abort') controller.abort(reason)
              else revision++
            })
          }
          return handle
        })
        syncBuiltinESMExports()
        try {
          const outcome = await store.importReference(owner, 'task-a', selected, controller.signal, () => {
            if (revision !== 1) throw reason
          }).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
          assert.equal(intercepted, true, 'Revocation must occur after staging JSON but before submitting its rename.')
          const names = await readdir(assets)
          assert.deepEqual(names.sort(), metadata === 'commit' ? [] : [`${id}.json.commit`],
            'No new commit or repaired manifest may be published after the authorization lease is invalidated.')
          assert.equal(outcome.error, reason, 'Revoked/cancelled imports must reject, including existing-reference repairs.')
          assert.equal(outcome.value, undefined)
          assert.deepEqual(await readdir(join(mediaRoot, 'files')), metadata === 'commit' ? [] : [`${id}.png`])
          if (retainedCommit) {
            assert.deepEqual(await readFile(`${manifest}.commit`), retainedCommit)
            assert.deepEqual(await readFile(file), png)
          }
          assert.deepEqual(await readFile(selected), png)
        } finally { mocked.mock.restore(); syncBuiltinESMExports() }
      })
    }
  }

  it('keeps the legacy three-argument import and guarded existing-reference imports compatible', async () => {
    const { store, selected, paths, root } = await fixture()
    const asset = await store.importReference(owner, 'task-a', selected)
    const mediaRoot = paths.mediaRoot(owner, 'task-a')
    const manifest = join(mediaRoot, 'assets', `${id}.json`)
    const originalManifest = await readFile(manifest)
    const originalCommit = await readFile(`${manifest}.commit`)
    let validations = 0
    assert.deepEqual(await store.importReference(owner, 'task-a', selected, signal(), () => { validations++ }), asset)
    assert.ok(validations >= 3, 'Entry, source-read and existing-reference branches must be validated.')
    assert.deepEqual(await new MediaStore(root).importReference(owner, 'task-a', selected), asset)
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), JSON.parse(originalManifest.toString('utf8')))
    assert.deepEqual(await readFile(`${manifest}.commit`), originalCommit)
    assert.deepEqual(await store.readAsset(owner, 'task-a', id), png)
    assert.deepEqual(await store.listAssets(owner, 'task-a'), [asset])
    assert.deepEqual(await readdir(join(mediaRoot, 'files')), [`${id}.png`])
    assert.deepEqual((await readdir(join(mediaRoot, 'assets'))).sort(), [`${id}.json`, `${id}.json.commit`])
  })
})
