import { deflateRawSync } from 'node:zlib'
import type { SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'
import { packageCrc32, packageSha256, type SkillPackageFile } from './skill-package-zip'
import { skillZipEnd } from '../../common/skill-zip-format'

export function zipFixture(files: readonly SkillPackageFile[], options: { deflate?: boolean; descriptor?: boolean; mode?: number; zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const directory = file.path.endsWith('/')
    const name = Buffer.from(file.path)
    const flags = 0x0800 | (options.descriptor && !directory ? 8 : 0)
    const method = options.deflate && !directory ? 8 : 0
    const compressed = method === 8 ? deflateRawSync(file.bytes) : file.bytes
    const crc = packageCrc32(file.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(file.bytes.length, 22)
    }
    local.writeUInt16LE(name.length, 26)
    const localExtra = Buffer.alloc(options.zip64 ? 20 : 0)
    if (options.zip64) {
      local.writeUInt16LE(45, 4); local.writeUInt32LE(0xffffffff, 18); local.writeUInt32LE(0xffffffff, 22)
      local.writeUInt16LE(20, 28)
      localExtra.writeUInt16LE(1); localExtra.writeUInt16LE(16, 2)
      localExtra.writeBigUInt64LE(BigInt(file.bytes.length), 4); localExtra.writeBigUInt64LE(BigInt(compressed.length), 12)
    }
    const descriptor = Buffer.alloc(flags & 8 ? (options.zip64 ? 24 : 16) : 0)
    if (flags & 8) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      if (options.zip64) {
        descriptor.writeBigUInt64LE(BigInt(compressed.length), 8); descriptor.writeBigUInt64LE(BigInt(file.bytes.length), 16)
      } else { descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(file.bytes.length, 12) }
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(file.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((options.mode ?? (directory ? 0x41c0 : 0x8180)) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    const centralExtra = Buffer.alloc(options.zip64 ? 28 : 0)
    if (options.zip64) {
      central.writeUInt16LE(45, 6); central.writeUInt32LE(0xffffffff, 20); central.writeUInt32LE(0xffffffff, 24)
      central.writeUInt32LE(0xffffffff, 42); central.writeUInt16LE(28, 30)
      centralExtra.writeUInt16LE(1); centralExtra.writeUInt16LE(24, 2)
      centralExtra.writeBigUInt64LE(BigInt(file.bytes.length), 4)
      centralExtra.writeBigUInt64LE(BigInt(compressed.length), 12)
      centralExtra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const record = Buffer.concat([local, name, localExtra, compressed, descriptor])
    locals.push(record)
    centrals.push(Buffer.concat([central, name, centralExtra]))
    offset += record.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = skillZipEnd(files.length, centralBytes.length, offset)
  return Buffer.concat([...locals, centralBytes, end])
}

export function zipDescriptor(bytes: Buffer, files: readonly SkillPackageFile[], entryPath = 'SKILL.md'): SkillArtifactAvailable {
  const entry = files.find(file => file.path === entryPath)!
  const hash = packageSha256(entry.bytes)
  return {
    protocolVersion: 1, status: 'AVAILABLE', format: 'zip', capabilityId: 'cap-a', versionId: 'version-v1',
    approvedContentSha256: hash, installationDirectory: 'orders', entryPath,
    entrySha256: hash, artifactSha256: packageSha256(bytes), byteLength: bytes.length,
    fileCount: files.filter(file => !file.path.endsWith('/')).length,
    downloadPath: '/client/subscriptions/sub-a/skills/cap-a/versions/version-v1/artifact',
  }
}
