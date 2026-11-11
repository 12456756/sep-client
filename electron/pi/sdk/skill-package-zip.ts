import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { isSafeSkillPathComponent, skillNameComparisonKey, type SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'

export const packageManifestName = '.sep-package-manifest.json'
export interface SkillPackageFile { path: string; bytes: Buffer; directory?: true }

export function assertSkillPathParents(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()
        && (!['/var', '/tmp', '/etc'].includes(current) || realpathSync(current) !== `/private${current}`)) invalid()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (dirname(current) === current) break
  }
}

function invalid(): never { throw new Error('Invalid or unsafe approved skill ZIP package.') }
export function packageSha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})
export function packageCrc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

export function safePackagePath(path: string): boolean {
  const parts = path.split('/')
  return path.length > 0 && parts.every(part => {
    const key = skillNameComparisonKey(part)
    return isSafeSkillPathComponent(part) && !/[\p{Cc}\p{Cf}]/u.test(key)
      && key !== packageManifestName
  })
}

function uint64(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 8 > bytes.length) invalid()
  const value = bytes.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
  return Number(value)
}

function zip64Extra(bytes: Buffer, fields: readonly boolean[]): number[] {
  let zip64: Buffer | undefined
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) invalid()
    const id = bytes.readUInt16LE(offset)
    const length = bytes.readUInt16LE(offset + 2)
    // Alternative filenames and duplicate ZIP64 fields have ambiguous identities.
    if (id === 0x7075 || offset + 4 + length > bytes.length) invalid()
    if (id === 1) {
      if (zip64) invalid()
      zip64 = bytes.subarray(offset + 4, offset + 4 + length)
    }
    offset += 4 + length
  }
  const required = fields.filter(Boolean).length * 8
  if (required ? !zip64 || zip64.length !== required : zip64 !== undefined) invalid()
  let cursor = 0
  return fields.map(required => {
    if (!required) return 0
    const value = uint64(zip64!, cursor); cursor += 8; return value
  })
}

/** Authenticated in-memory ZIP reader. No extraction library, process, or dependency is needed. */
export function readSkillZip(bytes: Buffer, artifact: SkillArtifactAvailable): SkillPackageFile[] {
  if (bytes.length !== artifact.byteLength || packageSha256(bytes) !== artifact.artifactSha256) invalid()
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) invalid()
  let count = bytes.readUInt16LE(end + 10)
  let centralSize = bytes.readUInt32LE(end + 12)
  let centralStart = bytes.readUInt32LE(end + 16)
  let centralEnd = end
  if (bytes.readUInt16LE(end + 8) !== count) invalid()
  const locator = end - 20
  if (locator >= 0 && bytes.readUInt32LE(locator) === 0x07064b50) {
    if (bytes.readUInt32LE(locator + 4) !== 0 || bytes.readUInt32LE(locator + 16) !== 1) invalid()
    const record = uint64(bytes, locator + 8)
    if (record + 56 > locator || bytes.readUInt32LE(record) !== 0x06064b50
      || uint64(bytes, record + 4) < 44 || uint64(bytes, record + 4) !== locator - record - 12
      || bytes.readUInt32LE(record + 16) !== 0 || bytes.readUInt32LE(record + 20) !== 0) invalid()
    const fullCount = uint64(bytes, record + 32)
    const fullSize = uint64(bytes, record + 40)
    const fullStart = uint64(bytes, record + 48)
    if (uint64(bytes, record + 24) !== fullCount
      || (count !== 0xffff && count !== fullCount)
      || (centralSize !== 0xffffffff && centralSize !== fullSize)
      || (centralStart !== 0xffffffff && centralStart !== fullStart)) invalid()
    count = fullCount; centralSize = fullSize; centralStart = fullStart; centralEnd = record
  } else if (centralSize === 0xffffffff || centralStart === 0xffffffff) invalid()
  if (!count || count > centralSize / 46 || centralStart + centralSize !== centralEnd) invalid()
  const files: SkillPackageFile[] = []
  const paths = new Map<string, boolean>()
  const directorySpellings: string[] = []
  const ranges: Array<[number, number]> = []
  let cursor = centralStart
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid()
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    let compressed = bytes.readUInt32LE(cursor + 20)
    let size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const attributes = bytes.readUInt32LE(cursor + 38)
    let local = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > centralEnd || bytes.readUInt16LE(cursor + 34) !== 0 || flags & ~0x080e || ![0, 8].includes(method)
      || (method === 0 && (flags & 6))) invalid()
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    if (!(flags & 0x0800) && rawName.some(byte => byte >= 128)) invalid()
    let name: string
    try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawName) } catch { invalid() }
    const directory = name.endsWith('/')
    const path = directory ? name.slice(0, -1) : name
    if (!safePackagePath(path)) invalid()
    const key = skillNameComparisonKey(path)
    const type = (attributes >>> 16) & 0xf000
    if (paths.has(key) || (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) || Boolean(attributes & 0x10) && !directory) invalid()
    paths.set(key, directory)
    if (directory) directorySpellings.push(path)
    const extended = zip64Extra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength),
      [size === 0xffffffff, compressed === 0xffffffff, local === 0xffffffff])
    const centralZip64Size = size === 0xffffffff || compressed === 0xffffffff
    if (size === 0xffffffff) size = extended[0]
    if (compressed === 0xffffffff) compressed = extended[1]
    if (local === 0xffffffff) local = extended[2]
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameLength) invalid()
    const localExtra = bytes.readUInt16LE(local + 28)
    const start = local + 30 + nameLength + localExtra
    const dataEnd = start + compressed
    if (start > centralStart || dataEnd > centralStart || !bytes.subarray(local + 30, local + 30 + nameLength).equals(rawName)) invalid()
    let localCompressed = bytes.readUInt32LE(local + 18)
    let localSize = bytes.readUInt32LE(local + 22)
    const localZip64Size = localSize === 0xffffffff || localCompressed === 0xffffffff
    const localExtended = zip64Extra(bytes.subarray(local + 30 + nameLength, start), [localSize === 0xffffffff, localCompressed === 0xffffffff])
    if (localSize === 0xffffffff) localSize = localExtended[0]
    if (localCompressed === 0xffffffff) localCompressed = localExtended[1]
    let rangeEnd = dataEnd
    if (flags & 8) {
      const descriptor = dataEnd + (dataEnd + 4 <= centralStart && bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0)
      const wide = localZip64Size || centralZip64Size
      const descriptorSize = wide ? 20 : 12
      if (descriptor + descriptorSize > centralStart || bytes.readUInt32LE(descriptor) !== crc
        || (wide ? uint64(bytes, descriptor + 4) : bytes.readUInt32LE(descriptor + 4)) !== compressed
        || (wide ? uint64(bytes, descriptor + 12) : bytes.readUInt32LE(descriptor + 8)) !== size) invalid()
      rangeEnd = descriptor + descriptorSize
      for (const [value, expected] of [[bytes.readUInt32LE(local + 14), crc], [localCompressed, compressed], [localSize, size]]) {
        if (value !== 0 && value !== expected) invalid()
      }
    } else if (bytes.readUInt32LE(local + 14) !== crc || localCompressed !== compressed || localSize !== size) invalid()
    ranges.push([local, rangeEnd])
    if (directory && (size !== 0 || compressed !== 0 || crc !== 0)) invalid()
    if (!directory) {
      const compressedBytes = bytes.subarray(start, dataEnd)
      let data: Buffer
      try {
        if (method === 0) data = Buffer.from(compressedBytes)
        else {
          const inflated = inflateRawSync(compressedBytes, { maxOutputLength: Math.max(1, size), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
          if (inflated.engine.bytesWritten !== compressed) invalid()
          data = inflated.buffer
        }
      } catch { invalid() }
      if (data.length !== size || packageCrc32(data) !== crc) invalid()
      files.push({ path, bytes: data })
    } else {
      files.push({ path, bytes: Buffer.alloc(0), directory: true })
    }
    cursor = next
  }
  if (cursor !== centralEnd || files.filter(file => !file.directory).length !== artifact.fileCount) invalid()
  ranges.sort((a, b) => a[0] - b[0])
  let previous = 0
  for (const [start, finish] of ranges) { if (start !== previous) invalid(); previous = finish }
  if (previous !== centralStart) invalid()
  const spellings = new Map<string, string>()
  for (const key of paths.keys()) {
    const parts = key.split('/')
    for (let index = 1; index < parts.length; index++) if (paths.get(parts.slice(0, index).join('/')) === false) invalid()
  }
  // Case/normalization aliases of implicit parent directories are also collisions.
  for (const path of [...files.filter(file => !file.directory).map(file => file.path), ...directorySpellings]) {
    const parts = path.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const spelling = parts.slice(0, index).join('/')
      const key = skillNameComparisonKey(spelling)
      if (spellings.has(key) && spellings.get(key) !== spelling) invalid()
      spellings.set(key, spelling)
    }
  }
  const entry = files.find(file => file.path === artifact.entryPath)
  if (!entry || packageSha256(entry.bytes) !== artifact.entrySha256) invalid()
  return files
}

const cacheSchema = z.object({
  entryPath: z.string().refine(safePackagePath),
  files: z.array(z.object({ path: z.string().refine(safePackagePath), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().safe() }).strict()).min(1),
  directories: z.array(z.string().refine(safePackagePath)).optional(),
}).passthrough()

export function packageCache(files: readonly SkillPackageFile[], entryPath: string): { entryPath: string; files: Array<{ path: string; sha256: string; byteLength: number }>; directories: string[] } {
  return { entryPath, files: files.filter(file => !file.directory).map(file => ({ path: file.path, sha256: packageSha256(file.bytes), byteLength: file.bytes.length })), directories: files.filter(file => file.directory).map(file => file.path) }
}

/** Verify every cached attachment and directory, not just SKILL.md, on reuse/reload. */
export function verifyPackageCache(entryFile: string, manifestBytes: Buffer): void {
  const cache = cacheSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)))
  const depth = cache.entryPath.split('/').length - 1
  const root = resolve(dirname(entryFile), ...Array.from({ length: depth }, () => '..'))
  assertSkillPathParents(root)
  if (resolve(root, cache.entryPath) !== resolve(entryFile)) invalid()
  const expected = new Map(cache.files.map(file => [file.path, file]))
  const directories = new Set(cache.directories ?? [])
  if (expected.size !== cache.files.length || !expected.has(cache.entryPath)) invalid()
  const manifestPath = join(dirname(entryFile), packageManifestName)
  function walk(path: string, prefix: string): void {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    for (const name of readdirSync(path)) {
      const fullPath = join(path, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const info = lstatSync(fullPath)
      if (info.isSymbolicLink()) invalid()
      if (info.isDirectory()) {
        if (!directories.has(relative) && !cache.files.some(file => file.path.startsWith(`${relative}/`))
          && ![...directories].some(path => path.startsWith(`${relative}/`))) invalid()
        directories.delete(relative)
        walk(fullPath, relative); continue
      }
      if (!info.isFile()) invalid()
      if (fullPath === manifestPath) { if (!readFileSync(fullPath).equals(manifestBytes)) invalid(); continue }
      const file = expected.get(relative)
      if (!file || info.size !== file.byteLength || packageSha256(readFileSync(fullPath)) !== file.sha256) invalid()
      expected.delete(relative)
    }
  }
  walk(root, '')
  if (expected.size || directories.size) invalid()
}
