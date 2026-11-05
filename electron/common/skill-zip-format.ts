const uint32Max = 0xffffffff

function safe(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid ZIP record value.')
}

export interface SkillZipEntry { name: Buffer; size: number; crc: number; offset: number; directory?: boolean }

/** STORED, UTF-8 ZIP records, with ZIP64 only where legacy fields overflow. */
export function skillZipHeaders(entry: SkillZipEntry): { local: Buffer; central: Buffer } {
  const { name, size, crc, offset, directory } = entry
  for (const value of [size, crc, offset]) safe(value)
  if (!name.length || name.length > 0xffff || crc > uint32Max) throw new Error('Invalid ZIP entry.')
  const largeSize = size >= uint32Max
  const largeOffset = offset >= uint32Max
  const localExtra = largeSize ? 20 : 0
  const local = Buffer.alloc(30 + name.length + localExtra)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(largeSize ? 45 : 20, 4)
  local.writeUInt16LE(0x800, 6)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(largeSize ? uint32Max : size, 18)
  local.writeUInt32LE(largeSize ? uint32Max : size, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(localExtra, 28)
  name.copy(local, 30)
  if (largeSize) {
    const extra = 30 + name.length
    local.writeUInt16LE(1, extra); local.writeUInt16LE(16, extra + 2)
    local.writeBigUInt64LE(BigInt(size), extra + 4); local.writeBigUInt64LE(BigInt(size), extra + 12)
  }
  const centralExtra = largeSize || largeOffset ? 4 + (largeSize ? 16 : 0) + (largeOffset ? 8 : 0) : 0
  const central = Buffer.alloc(46 + name.length + centralExtra)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(0x32d, 4)
  central.writeUInt16LE(largeSize || largeOffset ? 45 : 20, 6)
  central.writeUInt16LE(0x800, 8)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(largeSize ? uint32Max : size, 20)
  central.writeUInt32LE(largeSize ? uint32Max : size, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(centralExtra, 30)
  central.writeUInt32LE(directory ? 0x41ed0010 : 0x81a40000, 38)
  central.writeUInt32LE(largeOffset ? uint32Max : offset, 42)
  name.copy(central, 46)
  if (centralExtra) {
    let extra = 46 + name.length
    central.writeUInt16LE(1, extra); central.writeUInt16LE(centralExtra - 4, extra + 2); extra += 4
    if (largeSize) { central.writeBigUInt64LE(BigInt(size), extra); central.writeBigUInt64LE(BigInt(size), extra + 8); extra += 16 }
    if (largeOffset) central.writeBigUInt64LE(BigInt(offset), extra)
  }
  return { local, central }
}

export function skillZipEnd(count: number, centralSize: number, centralOffset: number): Buffer {
  for (const value of [count, centralSize, centralOffset, centralSize + centralOffset]) safe(value)
  const zip64 = count >= 0xffff || centralSize >= uint32Max || centralOffset >= uint32Max
  const end = Buffer.alloc(zip64 ? 98 : 22)
  if (zip64) {
    end.writeUInt32LE(0x06064b50)
    end.writeBigUInt64LE(44n, 4)
    end.writeUInt16LE(45, 12); end.writeUInt16LE(45, 14)
    end.writeBigUInt64LE(BigInt(count), 24); end.writeBigUInt64LE(BigInt(count), 32)
    end.writeBigUInt64LE(BigInt(centralSize), 40); end.writeBigUInt64LE(BigInt(centralOffset), 48)
    end.writeUInt32LE(0x07064b50, 56)
    end.writeBigUInt64LE(BigInt(centralOffset + centralSize), 64); end.writeUInt32LE(1, 72)
  }
  const legacy = zip64 ? 76 : 0
  end.writeUInt32LE(0x06054b50, legacy)
  end.writeUInt16LE(Math.min(count, 0xffff), legacy + 8); end.writeUInt16LE(Math.min(count, 0xffff), legacy + 10)
  end.writeUInt32LE(Math.min(centralSize, uint32Max), legacy + 12); end.writeUInt32LE(Math.min(centralOffset, uint32Max), legacy + 16)
  return end
}
