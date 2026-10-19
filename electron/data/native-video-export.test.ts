import * as assert from 'node:assert/strict'
import { constants, promises as fs, type Mode, type PathLike } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, it, type TestContext } from 'node:test'
import { exportVideoBytes } from './native-video-export'

const directories: string[] = []
const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50])
const previous = Buffer.from('previous complete export')

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ directory: string; root: string; destination: string }> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-native-video-'))
  directories.push(directory)
  const root = join(directory, 'user-data')
  await mkdir(root)
  return { directory, root, destination: join(directory, 'export.mp4') }
}

function patchFs<K extends 'open' | 'rename'>(context: TestContext, method: K, implementation: typeof fs[K]): () => void {
  const mocked = context.mock.method(fs, method, implementation)
  syncBuiltinESMExports()
  return () => { mocked.mock.restore(); syncBuiltinESMExports() }
}

async function assertPreserved(directory: string, destination: string): Promise<void> {
  assert.deepEqual(await readFile(destination), previous)
  assert.deepEqual((await readdir(directory)).sort(), ['export.mp4', 'user-data'])
}

describe('exportVideoBytes', () => {
  it('exports exactly the supplied Uint8Array view without leaving temporary files', async () => {
    const { directory, root, destination } = await fixture()
    const padded = new Uint8Array([99, ...bytes, 88])
    await exportVideoBytes(root, destination, padded.subarray(1, -1), new AbortController().signal)
    assert.deepEqual(await readFile(destination), Buffer.from(bytes))
    assert.deepEqual((await readdir(directory)).sort(), ['export.mp4', 'user-data'])
    if (process.platform !== 'win32') assert.equal((await lstat(destination)).mode & 0o777, 0o600)
  })

  it('keeps the old file visible until a synced, closed, exclusive sibling is atomically renamed', async context => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    const open = fs.open
    const rename = fs.rename
    let synced = false
    let closed = false
    let published = false
    const restoreOpen = patchFs(context, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
      assert.equal(dirname(String(path)), directory)
      assert.match(String(path), /\.part$/)
      assert.equal(flags, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0))
      assert.equal(mode, 0o600)
      const handle = await open(path, flags, mode)
      const sync = handle.sync.bind(handle)
      const close = handle.close.bind(handle)
      context.mock.method(handle, 'sync', async () => { await sync(); synced = true })
      context.mock.method(handle, 'close', async () => { await close(); closed = true })
      return handle
    })
    const restoreRename = patchFs(context, 'rename', async (source: PathLike, target: PathLike) => {
      assert.equal(String(target), destination)
      assert.equal(dirname(String(source)), directory)
      assert.deepEqual(await readFile(destination), previous)
      assert.deepEqual(await readFile(source), Buffer.from(bytes))
      assert.equal(synced, true)
      assert.equal(closed, true)
      await rename(source, target)
      published = true
    })
    try {
      await exportVideoBytes(root, destination, bytes, new AbortController().signal)
      assert.equal(published, true)
      assert.deepEqual(await readFile(destination), Buffer.from(bytes))
      assert.deepEqual((await readdir(directory)).sort(), ['export.mp4', 'user-data'])
    } finally { restoreRename(); restoreOpen() }
  })

  it('rejects the protected root and descendants, including a missing protected directory', async () => {
    const { directory, root } = await fixture()
    const protectedFile = join(root, 'state.mp4')
    await writeFile(protectedFile, previous)
    for (const destination of [root, protectedFile, join(root, 'new.mp4'), join(root, 'nested', 'new.mp4')]) {
      await assert.rejects(exportVideoBytes(root, destination, bytes, new AbortController().signal), /persistence/)
    }
    const missing = join(directory, 'future-user-data')
    await assert.rejects(exportVideoBytes(missing, join(missing, 'new.mp4'), bytes, new AbortController().signal), /persistence/)
    assert.deepEqual(await readFile(protectedFile), previous)
    assert.deepEqual(await readdir(root), ['state.mp4'])
  })

  it('does not confuse a sibling sharing the protected-root name prefix with a descendant', async () => {
    const { root } = await fixture()
    const directory = `${root}-exports`
    await mkdir(directory)
    const destination = join(directory, 'export.mp4')
    await exportVideoBytes(root, destination, bytes, new AbortController().signal)
    assert.deepEqual(await readFile(destination), Buffer.from(bytes))
    assert.deepEqual(await readdir(directory), ['export.mp4'])
  })

  it('recognizes a protected root provided through a symbolic-link alias', async () => {
    const { directory, root } = await fixture()
    const alias = join(directory, 'user-data-alias')
    await symlink(root, alias, 'dir')
    await assert.rejects(exportVideoBytes(alias, join(root, 'state.mp4'), bytes, new AbortController().signal), /persistence/)
    await assert.rejects(exportVideoBytes(join(alias, 'future'), join(root, 'future'), bytes, new AbortController().signal), /persistence/)
    assert.deepEqual(await readdir(root), [])
  })

  it('rejects symbolic-link destinations, including dangling links, without changing targets', async () => {
    const { directory, root, destination } = await fixture()
    const target = join(directory, 'original.mp4')
    await writeFile(target, previous)
    for (const source of [target, join(directory, 'missing.mp4')]) {
      await symlink(source, destination)
      await assert.rejects(exportVideoBytes(root, destination, bytes, new AbortController().signal), /symbolic/)
      assert.equal((await lstat(destination)).isSymbolicLink(), true)
      assert.deepEqual(await readFile(target), previous)
      await rm(destination)
    }
    assert.deepEqual((await readdir(directory)).sort(), ['original.mp4', 'user-data'])
  })

  it('rejects symbolic-link ancestors without creating anything in their target directory', async () => {
    const { directory, root } = await fixture()
    const target = join(directory, 'real-directory')
    const alias = join(directory, 'linked-directory')
    await mkdir(target)
    await symlink(target, alias, 'dir')
    await assert.rejects(exportVideoBytes(root, join(alias, 'export.mp4'), bytes, new AbortController().signal), /symbolic/)
    await assert.rejects(exportVideoBytes(root, join(alias, 'absent', 'export.mp4'), bytes, new AbortController().signal), /symbolic/)
    assert.deepEqual(await readdir(target), [])
  })

  it('rejects hardlinked destinations and hardlinked files used as ancestors', async () => {
    const { directory, root, destination } = await fixture()
    const protectedFile = join(root, 'state.mp4')
    await writeFile(protectedFile, previous)
    await link(protectedFile, destination)
    await assert.rejects(exportVideoBytes(root, destination, bytes, new AbortController().signal), /hardlink/)
    await assert.rejects(exportVideoBytes(root, join(destination, 'nested.mp4'), bytes, new AbortController().signal), /invalid file type/)
    assert.deepEqual(await readFile(destination), previous)
    assert.deepEqual(await readFile(protectedFile), previous)
    assert.equal((await lstat(destination)).nlink, 2)
    assert.deepEqual((await readdir(directory)).sort(), ['export.mp4', 'user-data'])
  })

  it('rechecks destination links installed while the temporary file is being synced', async context => {
    const { directory, root, destination } = await fixture()
    const protectedFile = join(root, 'state.mp4')
    await writeFile(protectedFile, previous)
    const open = fs.open
    for (const kind of ['symlink', 'hardlink']) {
      const restore = patchFs(context, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
        const handle = await open(path, flags, mode)
        const sync = handle.sync.bind(handle)
        context.mock.method(handle, 'sync', async () => {
          await sync()
          if (kind === 'symlink') await symlink(protectedFile, destination)
          else await link(protectedFile, destination)
        })
        return handle
      })
      try {
        await assert.rejects(exportVideoBytes(root, destination, bytes, new AbortController().signal), /symbolic link, hardlink/)
        assert.deepEqual(await readFile(protectedFile), previous)
        assert.deepEqual((await readdir(directory)).sort(), ['export.mp4', 'user-data'])
      } finally { restore(); await rm(destination, { force: true }) }
    }
  })

  it('rejects an already-aborted operation without modifying an existing destination', async () => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    const controller = new AbortController()
    const reason = new Error('export cancelled')
    controller.abort(reason)
    await assert.rejects(exportVideoBytes(root, destination, bytes, controller.signal), error => error === reason)
    await assertPreserved(directory, destination)
  })

  it('preserves the old destination and cleans up when aborted after writing and syncing', async context => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    const controller = new AbortController()
    const reason = new Error('authorization cancelled')
    const open = fs.open
    const restore = patchFs(context, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
      const handle = await open(path, flags, mode)
      const sync = handle.sync.bind(handle)
      context.mock.method(handle, 'sync', async () => { await sync(); controller.abort(reason) })
      return handle
    })
    try {
      await assert.rejects(exportVideoBytes(root, destination, bytes, controller.signal), error => error === reason)
      await assertPreserved(directory, destination)
    } finally { restore() }
  })

  it('calls the synchronous authorization fence at entry and immediately before publication', async context => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    const controller = new AbortController()
    const reason = new Error('authorization revision changed')
    let revision = 7
    let validations = 0
    const validate = (): void => {
      validations++
      if (revision !== 7) throw reason
    }
    const open = fs.open
    const restore = patchFs(context, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
      const handle = await open(path, flags, mode)
      const sync = handle.sync.bind(handle)
      context.mock.method(handle, 'sync', async () => { await sync(); revision++ })
      return handle
    })
    try {
      await assert.rejects(exportVideoBytes(root, destination, bytes, controller.signal, validate), error => error === reason)
      assert.equal(validations, 2)
      assert.equal(controller.signal.aborted, false)
      await assertPreserved(directory, destination)
    } finally { restore() }
  })

  it('preserves the destination when validation throws at entry or aborts at the final fence', async () => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    const reason = new Error('authorization denied')
    await assert.rejects(exportVideoBytes(root, destination, bytes, new AbortController().signal, () => { throw reason }), error => error === reason)
    await assertPreserved(directory, destination)
    const controller = new AbortController()
    let validations = 0
    await assert.rejects(exportVideoBytes(root, destination, bytes, controller.signal, () => {
      if (++validations === 2) controller.abort(reason)
    }), error => error === reason)
    assert.equal(validations, 2)
    await assertPreserved(directory, destination)
  })

  it('cleans staged files after write, fsync, and rename failures while preserving the destination', async context => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    const open = fs.open
    for (const method of ['writeFile', 'sync', 'rename'] as const) {
      const reason = new Error(`${method} failed`)
      const restore = method === 'rename'
        ? patchFs(context, 'rename', async () => { throw reason })
        : patchFs(context, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
          const handle = await open(path, flags, mode)
          context.mock.method(handle, method, async () => { throw reason })
          return handle
        })
      try {
        await assert.rejects(exportVideoBytes(root, destination, bytes, new AbortController().signal), error => error === reason)
        await assertPreserved(directory, destination)
      } finally { restore() }
    }
  })

  it('never removes a preexisting file when exclusive temporary creation collides', async context => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    const open = fs.open
    let collision: PathLike | undefined
    const restore = patchFs(context, 'open', async (path: PathLike, flags?: string | number, mode?: Mode) => {
      collision = path
      await writeFile(path, 'another writer owns this file')
      return open(path, flags, mode)
    })
    try {
      await assert.rejects(exportVideoBytes(root, destination, bytes, new AbortController().signal), /EEXIST/)
      assert.ok(collision)
      assert.equal(await readFile(collision, 'utf8'), 'another writer owns this file')
      assert.deepEqual(await readFile(destination), previous)
      await rm(collision)
      await assertPreserved(directory, destination)
    } finally { restore() }
  })

  it('rejects relative, NUL, traversal, directory, missing-parent and file-parent paths', async () => {
    const { directory, root, destination } = await fixture()
    await writeFile(destination, previous)
    for (const path of ['', 'export.mp4', `bad${sep}export.mp4`, `${destination}\0.mp4`,
      `${directory}${sep}.${sep}other.mp4`, `${directory}${sep}missing${sep}..${sep}other.mp4`,
      `${destination}${sep}`, directory, join(directory, 'missing', 'export.mp4'), join(destination, 'nested.mp4')]) {
      await assert.rejects(exportVideoBytes(root, path, bytes, new AbortController().signal))
    }
    for (const invalidRoot of ['', 'relative-root', `${root}\0`]) {
      await assert.rejects(exportVideoBytes(invalidRoot, destination, bytes, new AbortController().signal), /absolute/)
    }
    await assertPreserved(directory, destination)
  })
})
