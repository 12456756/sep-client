import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { VideoPersistenceError, videoFileMissing } from './video-files'

function absolutePath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new VideoPersistenceError('A native absolute path is required.')
  }
}

function outside(root: string, destination: string): void {
  const path = relative(root, destination)
  if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
    throw new VideoPersistenceError('Video exports must not overwrite application persistence.')
  }
}

// Resolve existing ancestors even when the protected directory has not been created yet.
async function canonicalRoot(root: string): Promise<string> {
  let ancestor = root
  for (;;) {
    try { return resolve(await realpath(ancestor), relative(ancestor, root)) } catch (error) {
      if (!videoFileMissing(error) || dirname(ancestor) === ancestor) throw error
      ancestor = dirname(ancestor)
    }
  }
}

async function assertExportPath(target: string): Promise<void> {
  let current = parse(target).root
  const segments = relative(current, target).split(sep).filter(Boolean)
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory()) ||
        (current === target && (!stat.isFile() || stat.nlink !== 1))) {
        throw new VideoPersistenceError('Video export path contains a symbolic link, hardlink or invalid file type.')
      }
    } catch (error) {
      // Only the final file may be absent; never create native-dialog parent directories.
      if (!videoFileMissing(error) || current !== target) throw error
    }
  }
}

/** Native-dialog selections only. The caller owns video byte validation and size limits. */
export async function exportVideoBytes(
  protectedRoot: string,
  selectedPath: string,
  bytes: Uint8Array,
  signal: AbortSignal,
  validate?: () => void,
): Promise<void> {
  signal.throwIfAborted()
  validate?.()
  absolutePath(protectedRoot)
  absolutePath(selectedPath)
  if (selectedPath.endsWith(sep) || selectedPath.split(sep).some(segment => segment === '.' || segment === '..')) {
    throw new VideoPersistenceError('A native absolute save file path is required.')
  }
  const root = resolve(protectedRoot)
  const destination = resolve(selectedPath)
  outside(root, destination)
  const canonical = await canonicalRoot(root)
  const checkDestination = async (): Promise<void> => {
    await assertExportPath(destination)
    outside(canonical, join(await realpath(dirname(destination)), basename(destination)))
  }
  await checkDestination()
  const part = `${destination}.${randomUUID()}.part`
  let created = false
  try {
    signal.throwIfAborted()
    const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    created = true
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw new VideoPersistenceError('Invalid video export temporary file.')
      await handle.writeFile(bytes, { signal })
      await handle.sync()
    } finally { await handle.close() }
    await assertExportPath(part)
    await checkDestination()
    signal.throwIfAborted()
    // No await between the host's authorization fence and submitting the atomic publication.
    validate?.()
    signal.throwIfAborted()
    await rename(part, destination)
    created = false
  } finally {
    // An exclusive-open collision is not our file to remove.
    if (created) await rm(part, { force: true })
  }
}
