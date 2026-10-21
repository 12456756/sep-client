import { afterEach, test, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import { constants, promises as fs } from 'node:fs'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoFiles } from './video-files'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(): Promise<{ files: VideoFiles; directory: string }> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-files-'))
  directories.push(directory)
  return { files: new VideoFiles(directory), directory }
}

function platform(context: TestContext, value: NodeJS.Platform): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value })
  context.after(() => { Object.defineProperty(process, 'platform', descriptor) })
}

function patchOpen(context: TestContext, implementation: typeof fs.open): void {
  const mock = context.mock.method(fs, 'open', implementation)
  syncBuiltinESMExports()
  context.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}

test('publishes video JSON and can reopen it on the native platform', async () => {
  const { files, directory } = await fixture()
  const file = join(directory, 'job.json')
  await files.writeJson(file, { submission: 'NOT_SENT' })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { submission: 'NOT_SENT' })
  await files.writeJson(file, { submission: 'MAYBE_SENT' })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { submission: 'MAYBE_SENT' })
  assert.deepEqual(await readdir(directory), ['job.json'])
})

test('Windows directory synchronization validates paths without opening an unsupported directory handle', async context => {
  const { files, directory } = await fixture()
  platform(context, 'win32')
  let opens = 0
  patchOpen(context, async () => { opens++; throw Object.assign(new Error('directory fsync unsupported'), { code: 'EPERM' }) })
  await files.syncDirectory(directory)
  assert.equal(opens, 0)
  await assert.rejects(files.syncDirectory(join(directory, '..', 'outside')), /escaped/)
})

for (const failure of [null, 'EPERM', 'EIO'] as const) {
  test(`POSIX directory synchronization ${failure ? `propagates ${failure}` : 'flushes the directory'} and closes its handle`, async context => {
    const { files, directory } = await fixture()
    platform(context, 'linux')
    const error = Object.assign(new Error('directory fsync failed'), { code: failure })
    let synced = 0, closed = 0
    patchOpen(context, async path => {
      assert.equal(path, directory)
      return {
        sync: async () => { synced++; if (failure) throw error },
        close: async () => { closed++ },
      } as Awaited<ReturnType<typeof fs.open>>
    })
    if (failure) await assert.rejects(files.syncDirectory(directory), error)
    else await files.syncDirectory(directory)
    assert.equal(synced, 1)
    assert.equal(closed, 1)
  })
}

test('Windows still rejects file fsync errors before publishing a video manifest', async context => {
  const { files, directory } = await fixture()
  platform(context, 'win32')
  const open = fs.open
  const error = Object.assign(new Error('file fsync failed'), { code: 'EPERM' })
  let closed = false
  patchOpen(context, async (path, flags, mode) => {
    const handle = await open(path, flags, mode)
    const close = handle.close.bind(handle)
    context.mock.method(handle, 'sync', async () => { throw error })
    context.mock.method(handle, 'close', async () => { await close(); closed = true })
    return handle
  })
  await assert.rejects(files.writeJson(join(directory, 'job.json'), { submission: 'NOT_SENT' }), error)
  assert.equal(closed, true)
  assert.deepEqual(await readdir(directory), [])
})

test('Windows quarantine opens original bytes with write access so file fsync can preserve evidence', async context => {
  const { files, directory } = await fixture()
  const file = join(directory, 'corrupt.video')
  await files.writeJson(file, { damaged: true })
  platform(context, 'win32')
  const open = fs.open
  let sourceOpens = 0
  patchOpen(context, async (path, flags, mode) => {
    if (path === file) {
      sourceOpens++
      assert.equal(Number(flags) & constants.O_RDWR, constants.O_RDWR)
    }
    return open(path, flags, mode)
  })
  const evidence = join(directory, 'quarantine', 'evidence')
  await files.quarantine(file, evidence, { manifest: Buffer.from('manifest'), commit: Buffer.from('commit') }, new AbortController().signal)
  assert.equal(sourceOpens, 1)
  assert.deepEqual(JSON.parse(await readFile(join(evidence, 'corrupt.video'), 'utf8')), { damaged: true })
  assert.equal(await readFile(join(evidence, 'manifest.json'), 'utf8'), 'manifest')
  assert.equal(await readFile(join(evidence, 'commit.json'), 'utf8'), 'commit')
})
