import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep, parse } from 'node:path'
import type { ZodType } from 'zod'

export const MAX_VIDEO_BYTES = 256 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024

export class VideoPersistenceError extends Error {
  constructor(message = 'Video persistence unavailable; existing evidence was preserved.') {
    super(message)
    this.name = 'VideoPersistenceError'
  }
}
/** Only verified regular-file content failures permit explicit quarantine repair. */
export class VideoIntegrityError extends VideoPersistenceError {}
export function videoFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
export function videoSha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Main-process internal paths only. No renderer/native-dialog path is accepted. */
export class VideoFiles {
  readonly root: string
  constructor(root: string) { this.root = resolve(root) }

  async assertPath(file: string): Promise<void> {
    const target = resolve(file)
    const path = relative(this.root, target)
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new VideoPersistenceError('Video path escaped persistence root.')
    // Include ancestors of userData so a symlinked parent cannot redirect scope data.
    let current = parse(target).root
    for (const segment of target.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, segment)
      try {
        const stat = await lstat(current)
        if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory()) ||
          (current === target && !stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) {
          throw new VideoPersistenceError('Video path contains a symbolic link, hardlink or invalid file type.')
        }
      } catch (error) { if (!videoFileMissing(error)) throw error; break }
    }
  }

  async names(directory: string): Promise<string[]> {
    await this.assertPath(directory)
    try { return (await readdir(directory)).sort() } catch (error) { if (!videoFileMissing(error)) throw error; return [] }
  }

  async exists(file: string): Promise<boolean> {
    await this.assertPath(file)
    try { await lstat(file); return true } catch (error) { if (!videoFileMissing(error)) throw error; return false }
  }

  async bytes(file: string, max = MAX_MANIFEST_BYTES): Promise<Buffer> {
    await this.assertPath(file)
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink > 1 || stat.size <= 0 || stat.size > max) throw new VideoPersistenceError('Invalid video file size or type.')
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) throw new VideoPersistenceError('Video file changed during reading.')
        offset += bytesRead
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new VideoPersistenceError('Video file changed during reading.')
      return bytes
    } finally { await handle.close() }
  }

  async json<T>(file: string, schema: ZodType<T>): Promise<T | null> {
    let bytes: Buffer
    try { bytes = await this.bytes(file) } catch (error) {
      if (!videoFileMissing(error)) throw error
      const name = file.slice(dirname(file).length + 1)
      if ((await this.names(dirname(file))).some(entry => entry.startsWith(`${name}.`) && entry !== `${name}.commit`)) {
        throw new VideoPersistenceError('Incomplete video manifest evidence requires recovery.')
      }
      return null
    }
    try { return schema.parse(JSON.parse(bytes.toString('utf8')) as unknown) } catch {
      throw new VideoPersistenceError('Invalid video manifest; existing evidence was preserved.')
    }
  }

  async directory(directory: string): Promise<void> {
    await this.assertPath(directory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.assertPath(directory)
  }

  async syncDirectory(directory: string): Promise<void> {
    await this.assertPath(directory)
    // Node cannot fsync directory handles on Windows; file data is synced before rename.
    if (process.platform === 'win32') return
    const handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { await handle.sync() } finally { await handle.close() }
  }

  async publish(part: string, file: string): Promise<void> {
    await this.assertPath(part)
    await this.assertPath(file)
    await rename(part, file)
    await this.syncDirectory(dirname(file))
  }

  async writeJson(file: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > MAX_MANIFEST_BYTES) throw new VideoPersistenceError('Video manifest exceeds limit.')
    const part = `${file}.${randomUUID()}.tmp`
    await this.directory(dirname(file))
    await this.assertPath(file)
    try {
      const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      // No backup rollback: MAYBE_SENT must never revert to NOT_SENT.
      await this.publish(part, file)
    } finally { await rm(part, { force: true }) }
  }

  /** Keep original evidence durable before moving corrupt bytes out of delivery. */
  async quarantine(file: string, directory: string, evidence: { manifest: Uint8Array; commit: Uint8Array }, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.assertPath(file)
    // Windows file fsync requires a writable handle, including preserved corrupt bytes.
    const source = await open(file, (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await source.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw new VideoPersistenceError('Invalid video quarantine source.')
      await this.directory(dirname(directory))
      await this.assertPath(directory)
      // Exclusive directory: no existing evidence or bytes can be overwritten.
      await mkdir(directory, { mode: 0o700 })
      for (const [name, bytes] of Object.entries(evidence)) {
        signal.throwIfAborted()
        const snapshot = join(directory, `${name}.json`)
        await this.assertPath(snapshot)
        const handle = await open(snapshot, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      }
      await this.syncDirectory(directory)
      await this.syncDirectory(dirname(directory))
      await this.syncDirectory(dirname(dirname(directory)))
      await source.sync()
      signal.throwIfAborted()
      await this.assertPath(file)
      const current = await lstat(file)
      if (!current.isFile() || current.nlink !== 1 || current.dev !== stat.dev || current.ino !== stat.ino) {
        throw new VideoPersistenceError('Video quarantine source changed.')
      }
      await this.publish(file, join(directory, 'corrupt.video'))
      await this.syncDirectory(dirname(file))
    } finally { await source.close() }
  }

  async verify(file: string, expected: { byteLength: number; sha256: string; mimeType: string }): Promise<void> {
    await this.assertPath(file)
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink > 1) throw new VideoPersistenceError('Video type does not match receipt.')
      if (stat.size !== expected.byteLength || stat.size > MAX_VIDEO_BYTES) throw new VideoIntegrityError('Video size does not match receipt.')
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let length = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, length)
        if (!bytesRead) break
        if (length === 0) {
          // Only recognized containers are decoded locally; others stay opaque hash-verified .bin exports.
          const valid = expected.mimeType === 'video/mp4' ? bytesRead >= 16 && buffer.toString('ascii', 4, 8) === 'ftyp' :
            expected.mimeType === 'video/webm' ? bytesRead >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : /^video\/[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(expected.mimeType)
          if (!valid) throw new VideoIntegrityError('Video container does not match receipt MIME type.')
        }
        length += bytesRead
        if (length > expected.byteLength) throw new VideoIntegrityError('Video exceeds receipt size.')
        hash.update(buffer.subarray(0, bytesRead))
      }
      if (length !== expected.byteLength || hash.digest('hex') !== expected.sha256.toLowerCase()) throw new VideoIntegrityError('Video hash or size does not match receipt.')
    } finally { await handle.close() }
  }

  async stream(part: string, source: AsyncIterable<Uint8Array>, expected: { byteLength: number; sha256: string }, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.directory(dirname(part))
    await this.assertPath(part)
    const iterator = source[Symbol.asyncIterator]()
    const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    const hash = createHash('sha256')
    let complete = false
    let length = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const next = await abortableVideo(iterator.next(), signal)
        if (next.done) { complete = true; break }
        signal.throwIfAborted()
        if (!(next.value instanceof Uint8Array)) throw new VideoPersistenceError('Invalid video stream chunk.')
        const bytes = Buffer.from(next.value)
        length += bytes.length
        if (length > expected.byteLength || length > MAX_VIDEO_BYTES) throw new VideoPersistenceError('Video stream exceeds receipt size.')
        hash.update(bytes)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
          if (!bytesWritten) throw new VideoPersistenceError('Video write made no progress.')
          offset += bytesWritten
        }
      }
      signal.throwIfAborted()
      if (length !== expected.byteLength || hash.digest('hex') !== expected.sha256.toLowerCase()) throw new VideoPersistenceError('Video hash or size does not match receipt.')
      await handle.sync()
    } finally {
      await handle.close()
      if (!complete && iterator.return) void iterator.return().catch(() => undefined)
    }
  }
}

export async function abortableVideo<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = (): void => undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Video operation aborted.'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try { return await Promise.race([promise, cancelled]) } finally { signal.removeEventListener('abort', onAbort) }
}
