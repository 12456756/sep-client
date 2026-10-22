import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inspectMediaImage } from './media-image'
import { MAX_VIDEO_BYTES } from './video-files'
import { isSafeDeliveryPath, type ArrangementDeliverable } from '../domain/arrangement-plan'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'

export interface ArrangementMediaSource {
  kind: 'image' | 'video'
  artifactId: string
  sha256: string
  size: number
  mime: string
  stream: () => AsyncIterable<Uint8Array>
}

const MIME_BY_FORMAT: Record<string, string[]> = {
  png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], webp: ['image/webp'],
  mp4: ['video/mp4'], webm: ['video/webm'],
}

function fail(message: string): never { throw new Error(message) }
function extension(deliverable: ArrangementDeliverable): string { return deliverable.format.toLowerCase() }
function snapshotPath(taskDirectory: string, sha256: string, format: string): string {
  return join(taskDirectory, 'delivery-snapshots', `${sha256}.${format.toLowerCase()}`)
}
function within(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function assertSafeExistingPath(root: string, target: string, allowMissing = true): Promise<void> {
  const absoluteRoot = resolve(root)
  const absoluteTarget = resolve(target)
  if (!within(absoluteRoot, absoluteTarget)) fail('UNSAFE_PATH')
  let current = absoluteRoot
  const parts = relative(absoluteRoot, absoluteTarget).split(sep).filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    try {
      const info = await lstat(current)
      const final = index === parts.length - 1
      if (info.isSymbolicLink() || (!final && !info.isDirectory()) || (final && !info.isFile() && !info.isDirectory())) fail('UNSAFE_PATH')
      if (final && info.isFile() && info.nlink > 1) fail('UNSAFE_PATH')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) break
      throw error
    }
  }
}

async function ensureDirectory(root: string, directory: string): Promise<void> {
  await assertSafeExistingPath(root, directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertSafeExistingPath(root, directory, false)
}

function sameFileVersion(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && after.nlink === 1
    && before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

async function readAndVerify(file: string, source: { sha256: string; size: number; kind: 'image' | 'video'; mime: string }, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(source.size) || source.size <= 0 || source.size > (source.kind === 'video' ? MAX_VIDEO_BYTES : 32 * 1024 * 1024)) fail('MEDIA_TOO_LARGE')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink > 1 || info.size !== source.size) fail('MEDIA_INTEGRITY_MISMATCH')
    const hash = createHash('sha256')
    const imageChunks: Buffer[] = []
    let magic = Buffer.alloc(0)
    const buffer = Buffer.alloc(64 * 1024)
    let length = 0
    for (;;) {
      signal?.throwIfAborted()
      const result = await handle.read(buffer, 0, Math.min(buffer.length, source.size - length + 1), length)
      if (!result.bytesRead) break
      if (length + result.bytesRead > source.size) fail('MEDIA_INTEGRITY_MISMATCH')
      const chunk = Buffer.from(buffer.subarray(0, result.bytesRead))
      hash.update(chunk)
      if (source.kind === 'image') imageChunks.push(chunk)
      else if (magic.length < 16) magic = Buffer.concat([magic, chunk]).subarray(0, 16)
      length += result.bytesRead
    }
    signal?.throwIfAborted()
    if (length !== source.size || hash.digest('hex') !== source.sha256.toLowerCase()
      || !sameFileVersion(info, await handle.stat()) || !sameFileVersion(info, await lstat(file))) fail('MEDIA_INTEGRITY_MISMATCH')
    if (source.kind === 'image') {
      const image = inspectMediaImage(Buffer.concat(imageChunks))
      if (image.mime !== source.mime) fail('MEDIA_MIME_MISMATCH')
    } else {
      const valid = source.mime === 'video/mp4'
        ? magic.length >= 16 && magic.toString('ascii', 4, 8) === 'ftyp'
        : magic.length >= 4 && magic.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      if (!valid) fail('MEDIA_MIME_MISMATCH')
    }
  } finally { await handle.close() }
}

async function existingMatches(file: string, source: { sha256: string; size: number }, signal?: AbortSignal): Promise<boolean> {
  try {
    signal?.throwIfAborted()
    const info = await lstat(file)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) fail('UNSAFE_PATH')
    if (info.size !== source.size) return false
    const hash = createHash('sha256')
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (!sameFileVersion(info, await handle.stat())) return false
      const buffer = Buffer.alloc(64 * 1024); let offset = 0
      for (;;) {
        signal?.throwIfAborted()
        const result = await handle.read(buffer, 0, Math.min(buffer.length, source.size - offset + 1), offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
        if (offset > source.size) return false
        hash.update(buffer.subarray(0, result.bytesRead))
      }
      signal?.throwIfAborted()
      if (offset !== source.size || !sameFileVersion(info, await handle.stat()) || !sameFileVersion(info, await lstat(file))) return false
    } finally { await handle.close() }
    return hash.digest('hex') === source.sha256.toLowerCase()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeChunk(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (!result.bytesWritten) fail('MEDIA_WRITE_FAILED')
    offset += result.bytesWritten
  }
}

async function publishNoClobber(part: string, target: string, source: { sha256: string; size: number }, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  try {
    const { link, unlink } = await import('node:fs/promises')
    await link(part, target)
    await unlink(part)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (!(await existingMatches(target, source, signal))) fail('MEDIA_DESTINATION_CONFLICT')
      await rm(part, { force: true }); return
    }
    throw error
  }
}

export async function materializeArrangementMedia(
  workspace: string, deliverable: ArrangementDeliverable, source: ArrangementMediaSource,
  nodeRunId: string, taskDirectory: string, signal: AbortSignal, validate?: () => void,
): Promise<FinalDeliveryFile> {
  signal.throwIfAborted(); validate?.()
  if (!isSafeDeliveryPath(deliverable.path)) fail('UNSAFE_PATH')
  const format = extension(deliverable)
  if (!MIME_BY_FORMAT[format]?.includes(source.mime)) fail('MEDIA_MIME_MISMATCH')
  if (source.kind === 'image' && source.size > 32 * 1024 * 1024) fail('MEDIA_TOO_LARGE')
  if (source.kind === 'video' && source.size > MAX_VIDEO_BYTES) fail('MEDIA_TOO_LARGE')
  if (!/^[a-f0-9]{64}$/i.test(source.sha256) || !Number.isSafeInteger(source.size) || source.size <= 0) fail('MEDIA_INTEGRITY_MISMATCH')
  const root = await realpath(workspace)
  const taskRoot = await realpath(taskDirectory).catch(async () => {
    const parent = dirname(resolve(taskDirectory)); const canonicalParent = await realpath(parent); return resolve(canonicalParent, resolve(taskDirectory).slice(parent.length + 1))
  })
  const target = resolve(root, ...deliverable.path.split(/[\\/]/)); const snapshot = snapshotPath(taskRoot, source.sha256.toLowerCase(), format)
  await ensureDirectory(root, dirname(target)); await ensureDirectory(taskRoot, dirname(snapshot))
  await assertSafeExistingPath(root, target); await assertSafeExistingPath(taskRoot, snapshot)
  if (await existingMatches(snapshot, source, signal)) {
    if (await existingMatches(target, source, signal)) {
      validate?.(); signal.throwIfAborted()
      await assertSafeExistingPath(taskRoot, snapshot, false); await assertSafeExistingPath(root, target, false)
      await readAndVerify(snapshot, source, signal); await readAndVerify(target, source, signal)
      return { id: deliverable.id, path: deliverable.path, format: deliverable.format, size: source.size, sha256: source.sha256.toLowerCase(), sourceArtifact: { kind: source.kind, artifactId: source.artifactId, sha256: source.sha256.toLowerCase() }, nodeRunId, validatedAt: Date.now(), snapshot: { sha256: source.sha256.toLowerCase(), size: source.size, source: 'confirmed' } }
    }
    if (await lstat(target).catch(() => undefined)) fail('MEDIA_DESTINATION_CONFLICT')
  } else if (await lstat(snapshot).catch(() => undefined)) fail('SNAPSHOT_CHANGED')
  const part = join(taskRoot, `.media-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    let length = 0; const hash = createHash('sha256')
    for await (const chunk of source.stream()) {
      signal.throwIfAborted(); if (!(chunk instanceof Uint8Array)) fail('MEDIA_INVALID_STREAM')
      const bytes = Buffer.from(chunk); length += bytes.length
      if (length > source.size || length > (source.kind === 'video' ? MAX_VIDEO_BYTES : 32 * 1024 * 1024)) fail('MEDIA_TOO_LARGE')
      hash.update(bytes); await writeChunk(handle, bytes)
    }
    signal.throwIfAborted(); if (length !== source.size || hash.digest('hex') !== source.sha256.toLowerCase()) fail('MEDIA_INTEGRITY_MISMATCH')
    await handle.sync(); await handle.close(); handle = undefined
    await readAndVerify(part, source, signal)
    validate?.(); signal.throwIfAborted()
    await assertSafeExistingPath(taskRoot, snapshot)
    if (!(await existingMatches(snapshot, source, signal))) await publishNoClobber(part, snapshot, source, signal)
    await assertSafeExistingPath(taskRoot, snapshot, false)
    const targetPart = `${target}.${randomUUID()}.tmp`
    try {
      await assertSafeExistingPath(root, target)
      await copyFile(snapshot, targetPart, constants.COPYFILE_EXCL)
      signal.throwIfAborted(); validate?.(); signal.throwIfAborted()
      await assertSafeExistingPath(taskRoot, snapshot, false); await assertSafeExistingPath(root, target)
      await readAndVerify(targetPart, source, signal)
      await publishNoClobber(targetPart, target, source, signal)
      await assertSafeExistingPath(root, target, false)
      if (!(await existingMatches(snapshot, source, signal))) fail('SNAPSHOT_CHANGED')
      await readAndVerify(target, source, signal)
      validate?.(); signal.throwIfAborted()
    } finally { await rm(targetPart, { force: true }) }
    return { id: deliverable.id, path: deliverable.path, format: deliverable.format, size: source.size, sha256: source.sha256.toLowerCase(), sourceArtifact: { kind: source.kind, artifactId: source.artifactId, sha256: source.sha256.toLowerCase() }, nodeRunId, validatedAt: Date.now(), snapshot: { sha256: source.sha256.toLowerCase(), size: source.size, source: 'confirmed' } }
  } finally { if (handle) await handle.close(); await rm(part, { force: true }) }
}

export async function resolveArrangementMediaFile(workspace: string, file: FinalDeliveryFile, taskDirectory: string | undefined, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); if (!isSafeDeliveryPath(file.path)) fail('UNSAFE_PATH')
  const source = { sha256: file.sha256, size: file.size }
  if (!Number.isSafeInteger(source.size) || source.size <= 0 || !/^[a-f0-9]{64}$/i.test(source.sha256)) fail('MEDIA_INTEGRITY_MISMATCH')
  if (file.snapshot) {
    if (!taskDirectory) fail('SNAPSHOT_UNAVAILABLE')
    if (!/^[A-Za-z0-9][A-Za-z0-9_+-]{0,31}$/.test(file.format)) fail('INVALID_FORMAT')
    if (file.sourceArtifact && file.sourceArtifact.sha256 !== file.sha256) fail('SNAPSHOT_CHANGED')
    const root = await realpath(taskDirectory); const path = snapshotPath(root, file.snapshot.sha256, file.format)
    if (file.snapshot.sha256 !== file.sha256 || file.snapshot.size !== file.size) fail('SNAPSHOT_CHANGED')
    await assertSafeExistingPath(root, path)
    if (await existingMatches(path, source, signal)) { await readAndVerify(path, { ...source, kind: file.sourceArtifact?.kind ?? 'image', mime: MIME_BY_FORMAT[file.format.toLowerCase()]?.[0] ?? '' }, signal); return path }
    try { await lstat(path); fail('SNAPSHOT_CHANGED') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    fail('SNAPSHOT_UNAVAILABLE')
  }
  const root = await realpath(workspace); const path = resolve(root, ...file.path.split(/[\\/]/))
  await assertSafeExistingPath(root, path, false); if (!(await existingMatches(path, source, signal))) fail('MEDIA_INTEGRITY_MISMATCH')
  return path
}

export const resolveArrangementMedia = resolveArrangementMediaFile
