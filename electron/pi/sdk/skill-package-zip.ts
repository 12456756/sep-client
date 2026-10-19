import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { isSafeSkillPathComponent, maxSkillArtifactBytes, maxSkillEntryBytes, skillNameComparisonKey, type SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'

export const packageManifestName = '.sep-package-manifest.json'
export const maxSkillPackageExpandedBytes = 64 * 1024 * 1024
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
  return path.length > 0 && path.length <= 1024 && parts.every(part => {
    const key = skillNameComparisonKey(part)
    return isSafeSkillPathComponent(part) && !/[\p{Cc}\p{Cf}]/u.test(key)
      && key !== packageManifestName
  })
}

function validateExtra(bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) invalid()
    const id = bytes.readUInt16LE(offset)
    const length = bytes.readUInt16LE(offset + 2)
    // ZIP64 and alternative Unicode filenames introduce ambiguous identities.
    if (id === 0x0001 || id === 0x7075 || offset + 4 + length > bytes.length) invalid()
    offset += 4 + length
  }
}

/** Bounded in-memory ZIP reader. No extraction library, process, or dependency is needed. */
export function readSkillZip(bytes: Buffer, artifact: SkillArtifactAvailable): SkillPackageFile[] {
  if (bytes.length !== artifact.byteLength || bytes.length > maxSkillArtifactBytes || packageSha256(bytes) !== artifact.artifactSha256) invalid()
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) invalid()
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  const centralStart = bytes.readUInt32LE(end + 16)
  if (!count || count > 500 || bytes.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) invalid()
  const files: SkillPackageFile[] = []
  const paths = new Map<string, boolean>()
  const directorySpellings: string[] = []
  const ranges: Array<[number, number]> = []
  let total = 0
  let cursor = centralStart
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid()
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const attributes = bytes.readUInt32LE(cursor + 38)
    const local = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > end || bytes.readUInt16LE(cursor + 34) !== 0 || flags & ~0x080e || ![0, 8].includes(method)
      || (method === 0 && (flags & 6)) || size > maxSkillPackageExpandedBytes || compressed > maxSkillArtifactBytes) invalid()
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
    validateExtra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameLength) invalid()
    const localExtra = bytes.readUInt16LE(local + 28)
    const start = local + 30 + nameLength + localExtra
    const dataEnd = start + compressed
    if (dataEnd > centralStart || !bytes.subarray(local + 30, local + 30 + nameLength).equals(rawName)) invalid()
    validateExtra(bytes.subarray(local + 30 + nameLength, start))
    let rangeEnd = dataEnd
    if (flags & 8) {
      const descriptor = dataEnd + (dataEnd + 4 <= centralStart && bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0)
      if (descriptor + 12 > centralStart || bytes.readUInt32LE(descriptor) !== crc || bytes.readUInt32LE(descriptor + 4) !== compressed
        || bytes.readUInt32LE(descriptor + 8) !== size) invalid()
      rangeEnd = descriptor + 12
      for (const [offset, expected] of [[14, crc], [18, compressed], [22, size]]) {
        const value = bytes.readUInt32LE(local + offset)
        if (value !== 0 && value !== expected) invalid()
      }
    } else if (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size) invalid()
    ranges.push([local, rangeEnd])
    total += size
    if (total > maxSkillPackageExpandedBytes || directory && (size !== 0 || compressed !== 0 || crc !== 0)) invalid()
    if (!directory) {
      if (files.length >= 500 || path.split('/').at(-1) === 'SKILL.md' && size > maxSkillEntryBytes) invalid()
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
  if (cursor !== end || files.filter(file => !file.directory).length !== artifact.fileCount) invalid()
  ranges.sort((a, b) => a[0] - b[0])
  let previous = 0
  for (const [start, finish] of ranges) { if (start !== previous) invalid(); previous = finish }
  if (previous !== centralStart) invalid()
  const spellings = new Map<string, string>()
  for (const [key, directory] of paths) {
    const parts = key.split('/')
    for (let index = 1; index < parts.length; index++) if (paths.get(parts.slice(0, index).join('/')) === false) invalid()
    if (!directory && key.split('/').at(-1) === 'skill.md' && !files.some(file => file.path === artifact.entryPath && skillNameComparisonKey(file.path) === key)) invalid()
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
  files: z.array(z.object({ path: z.string().refine(safePackagePath), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().max(maxSkillPackageExpandedBytes) }).strict()).min(1).max(500),
  directories: z.array(z.string().refine(safePackagePath)).max(500).optional(),
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
  let total = 0
  let entries = 0
  const manifestPath = join(dirname(entryFile), packageManifestName)
  function walk(path: string, prefix: string): void {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    for (const name of readdirSync(path)) {
      if (++entries > 2000) invalid()
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
      total += file.byteLength
      if (total > maxSkillPackageExpandedBytes) invalid()
      expected.delete(relative)
    }
  }
  walk(root, '')
  if (expected.size || directories.size) invalid()
}
