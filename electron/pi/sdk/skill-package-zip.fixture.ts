import { deflateRawSync } from 'node:zlib'
import type { SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'
import { packageCrc32, packageSha256, type SkillPackageFile } from './skill-package-zip'

export function zipFixture(files: readonly SkillPackageFile[], options: { deflate?: boolean; descriptor?: boolean; mode?: number } = {}): Buffer {
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
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0)
    if (flags & 8) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(compressed.length, 8)
      descriptor.writeUInt32LE(file.bytes.length, 12)
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
    const record = Buffer.concat([local, name, compressed, descriptor])
    locals.push(record)
    centrals.push(Buffer.concat([central, name]))
    offset += record.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
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
