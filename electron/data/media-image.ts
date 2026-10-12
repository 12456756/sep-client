import type { ImageMime } from '../../src/shared/media'

export const MAX_MEDIA_BYTES = 32 * 1024 * 1024
export const MAX_MEDIA_PIXELS = 40_000_000
export const MAX_MEDIA_DIMENSION = 32_768

export interface MediaImageInfo {
  mime: ImageMime
  width: number
  height: number
  size: number
}

function invalid(): never {
  throw new Error('Invalid or unsupported media image.')
}

function dimensions(mime: ImageMime, width: number, height: number, size: number): MediaImageInfo {
  if (width < 1 || height < 1 || width > MAX_MEDIA_DIMENSION || height > MAX_MEDIA_DIMENSION || width * height > MAX_MEDIA_PIXELS) {
    throw new Error('Media image dimensions exceed the supported limit.')
  }
  return { mime, width, height, size }
}

/** Inspect container headers only; never decode untrusted pixel data in the main process. */
export function inspectMediaImage(bytes: Uint8Array): MediaImageInfo {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('Media image size exceeds the supported limit.')
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') invalid()
    const colorDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
    if (!colorDepths[data[25]]?.includes(data[24]) || data[26] !== 0 || data[27] !== 0 || data[28] > 1) invalid()
    let imageData = false
    let ended = false
    for (let offset = 8; offset < data.length;) {
      if (offset + 12 > data.length) invalid()
      const length = data.readUInt32BE(offset)
      const type = data.toString('ascii', offset + 4, offset + 8)
      if (offset + 12 + length > data.length || (offset > 8 && type === 'IHDR')) invalid()
      if (type === 'IDAT' && length > 0) imageData = true
      offset += 12 + length
      if (type === 'IEND') {
        if (length !== 0 || offset !== data.length) invalid()
        ended = true
        break
      }
    }
    if (!imageData || !ended) invalid()
    return dimensions('image/png', data.readUInt32BE(16), data.readUInt32BE(20), data.length)
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) invalid()
    let offset = 2
    while (offset < data.length - 2) {
      if (data[offset++] !== 0xff) invalid()
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]
      if (marker === 0xda || marker === 0xd9 || marker === undefined) invalid()
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > data.length) invalid()
      const length = data.readUInt16BE(offset)
      if (length < 2 || offset + length > data.length - 2) invalid()
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8 || ![8, 12, 16].includes(data[offset + 2]) || length !== 8 + 3 * data[offset + 7]) invalid()
        return dimensions('image/jpeg', data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3), data.length)
      }
      offset += length
    }
    invalid()
  }
  if (data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.readUInt32LE(4) + 8 !== data.length) invalid()
    let canvas: { width: number; height: number } | undefined
    let image: { width: number; height: number } | undefined
    for (let offset = 12; offset < data.length;) {
      if (offset + 8 > data.length) invalid()
      const type = data.toString('ascii', offset, offset + 4)
      const length = data.readUInt32LE(offset + 4)
      const start = offset + 8
      const end = start + length
      if (end + (length % 2) > data.length) invalid()
      if (type === 'VP8X') {
        if (offset !== 12 || length !== 10 || (data[start] & 0xc3) !== 0 || data.readUIntLE(start + 1, 3) !== 0) invalid()
        canvas = { width: 1 + data.readUIntLE(start + 4, 3), height: 1 + data.readUIntLE(start + 7, 3) }
      } else if (type === 'VP8 ') {
        if (image || length < 10 || (data[start] & 1) !== 0 || !data.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalid()
        image = { width: data.readUInt16LE(start + 6) & 0x3fff, height: data.readUInt16LE(start + 8) & 0x3fff }
      } else if (type === 'VP8L') {
        if (image || length < 5 || data[start] !== 0x2f) invalid()
        const bits = data.readUInt32LE(start + 1)
        if ((bits >>> 29) !== 0) invalid()
        image = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
      } else if (type === 'ANIM' || type === 'ANMF') invalid()
      offset = end + (length % 2)
    }
    if (!image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) invalid()
    return dimensions('image/webp', image.width, image.height, data.length)
  }
  return invalid()
}
