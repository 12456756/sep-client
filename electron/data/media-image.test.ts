import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { inspectMediaImage, MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS } from './media-image'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')

// Real 1x1 RGB images encoded by ImageIO, including tables and entropy-coded scans.
const baselineJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBARXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q==',
  'base64',
)
const progressiveJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBARXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8IAEQgAAQABAwERAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAMCBAEFAAYHCAkKC//EAMMQAAEDAwIEAwQGBAcGBAgGcwECAAMRBBIhBTETIhAGQVEyFGFxIweBIJFCFaFSM7EkYjAWwXLRQ5I0ggjhU0AlYxc18JNzolBEsoPxJlQ2ZJR0wmDShKMYcOInRTdls1V1pJXDhfLTRnaA40dWZrQJChkaKCkqODk6SElKV1hZWmdoaWp3eHl6hoeIiYqQlpeYmZqgpaanqKmqsLW2t7i5usDExcbHyMnK0NTV1tfY2drg5OXm5+jp6vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAQIAAwQFBgcICQoL/8QAwxEAAgIBAwMDAgMFAgUCBASHAQACEQMQEiEEIDFBEwUwIjJRFEAGMyNhQhVxUjSBUCSRoUOxFgdiNVPw0SVgwUThcvEXgmM2cCZFVJInotIICQoYGRooKSo3ODk6RkdISUpVVldYWVpkZWZnaGlqc3R1dnd4eXqAg4SFhoeIiYqQk5SVlpeYmZqgo6SlpqeoqaqwsrO0tba3uLm6wMLDxMXGx8jJytDT1NXW19jZ2uDi4+Tl5ufo6ery8/T19vf4+fr/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2gAMAwEAAhEDEQAAAf38r//aAAgBAQABBQJ//9oACAEDEQE/AX//2gAIAQIRAT8Bf//aAAgBAQAGPwJ//8QAMxABAAMAAgICAgIDAQEAAAILAREAITFBUWFxgZGhscHw0RDh8SAwQFBgcICQoLDA0OD/2gAIAQEAAT8hv//aAAwDAQACEQMRAAAQH//EADMRAQEBAAMAAQIFBQEBAAEBCQEAESExEEFRYSBx8JGBobHRweHxMEBQYHCAkKCwwNDg/9oACAEDEQE/EL//2gAIAQIRAT8Qv//aAAgBAQABPxC//9k=',
  'base64',
)

function jpeg(width = 1, height = 1): Buffer {
  const data = Buffer.from(baselineJpeg)
  const frame = data.indexOf(Buffer.from([0xff, 0xc0]))
  data.writeUInt16BE(height, frame + 5)
  data.writeUInt16BE(width, frame + 7)
  return data
}

function webp(type: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Buffer {
  const payload = Buffer.alloc(type === 'VP8L' ? 5 : 10)
  if (type === 'VP8L') {
    payload[0] = 0x2f
    payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
  } else if (type === 'VP8 ') {
    Buffer.from([0x9d, 0x01, 0x2a]).copy(payload, 3)
    payload.writeUInt16LE(width, 6)
    payload.writeUInt16LE(height, 8)
  } else {
    payload.writeUIntLE(width - 1, 4, 3)
    payload.writeUIntLE(height - 1, 7, 3)
  }
  const data = Buffer.alloc(20 + payload.length + payload.length % 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WEBP', 8)
  data.write(type, 12)
  data.writeUInt32LE(payload.length, 16)
  payload.copy(data, 20)
  return data
}

describe('inspectMediaImage', () => {
  it('detects PNG headers and dimensions without trusting filenames', () => {
    assert.deepEqual(inspectMediaImage(png), { mime: 'image/png', width: 1, height: 1, size: png.length })
    const padded = Buffer.concat([Buffer.from([0]), png, Buffer.from([0])])
    assert.equal(inspectMediaImage(padded.subarray(1, -1)).width, 1)
  })

  it('detects JPEG frame dimensions across preceding metadata segments', () => {
    const image = jpeg()
    assert.deepEqual(inspectMediaImage(image), { mime: 'image/jpeg', width: 1, height: 1, size: image.length })
    const metadata = Buffer.from([0xff, 0xe1, 0, 4, 0, 0])
    assert.equal(inspectMediaImage(Buffer.concat([image.subarray(0, 2), metadata, image.subarray(2)])).height, 1)
  })

  it('accepts complete progressive JPEG scans and tables between scans', () => {
    assert.deepEqual(inspectMediaImage(progressiveJpeg), { mime: 'image/jpeg', width: 1, height: 1, size: progressiveJpeg.length })
  })

  it('walks stuffed bytes, restart markers and fill bytes without ending a JPEG scan early', () => {
    const image = jpeg()
    const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff])
    assert.equal(inspectMediaImage(Buffer.concat([image.subarray(0, -2), scan, image.subarray(-2)])).mime, 'image/jpeg')
  })

  it('rejects JPEG frame headers without a complete SOS and nonempty scan', () => {
    const image = jpeg()
    const scan = image.indexOf(Buffer.from([0xff, 0xda]))
    const scanEnd = scan + 2 + image.readUInt16BE(scan + 2)
    const eoi = image.subarray(-2)
    const headerOnly = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9])
    for (const invalid of [headerOnly, Buffer.concat([image.subarray(0, scan), eoi]),
      Buffer.concat([image.subarray(0, scan + 3), eoi]), Buffer.concat([image.subarray(0, scanEnd - 1), eoi]),
      Buffer.concat([image.subarray(0, scanEnd), eoi]), Buffer.concat([image.subarray(0, scanEnd), Buffer.from([0xff, 0xd0]), eoi])]) {
      assert.throws(() => inspectMediaImage(invalid))
    }
  })

  it('rejects JPEG truncation or malformed segments after its frame header', () => {
    const image = jpeg()
    const scan = image.indexOf(Buffer.from([0xff, 0xda]))
    const scanEnd = scan + 2 + image.readUInt16BE(scan + 2)
    for (const invalid of [image.subarray(0, -1), image.subarray(0, -2), Buffer.concat([image, Buffer.from([0])]),
      Buffer.concat([image.subarray(0, scan), Buffer.from([0xff, 0xe1, 0, 20]), image.subarray(-2)]),
      Buffer.concat([image.subarray(0, scanEnd), Buffer.from([0x12, 0xff, 0xe1]), image.subarray(-2)]),
      Buffer.concat([image.subarray(0, scanEnd), Buffer.from([0x12, 0xff, 0xda, 0, 20]), image.subarray(-2)])]) {
      assert.throws(() => inspectMediaImage(invalid))
    }
    const wrongScanLength = jpeg()
    wrongScanLength.writeUInt16BE(2, scan + 2)
    assert.throws(() => inspectMediaImage(wrongScanLength))
    const unknownComponent = jpeg()
    unknownComponent[scan + 5] = 99
    assert.throws(() => inspectMediaImage(unknownComponent))
    const truncatedProgressive = progressiveJpeg.subarray(0, progressiveJpeg.lastIndexOf(Buffer.from([0xff, 0xda])) + 3)
    assert.throws(() => inspectMediaImage(Buffer.concat([truncatedProgressive, image.subarray(-2)])))
  })

  it('detects lossy and lossless WebP dimensions', () => {
    for (const type of ['VP8 ', 'VP8L'] as const) {
      const image = webp(type, 321, 123)
      assert.deepEqual(inspectMediaImage(image), { mime: 'image/webp', width: 321, height: 123, size: image.length })
    }
  })

  it('checks extended WebP canvas against its actual image', () => {
    const extended = webp('VP8X', 321, 123)
    const image = Buffer.concat([extended, webp('VP8L', 321, 123).subarray(12)])
    image.writeUInt32LE(image.length - 8, 4)
    assert.equal(inspectMediaImage(image).width, 321)
    image.writeUIntLE(400, 24, 3)
    assert.throws(() => inspectMediaImage(image))
    assert.throws(() => inspectMediaImage(extended))
  })

  it('rejects SVG, empty content, forged containers and truncated data', () => {
    for (const bytes of [Buffer.from('<svg width="1" height="1"/>'), Buffer.alloc(0), Buffer.from('RIFFxxxxWEBP'), png.subarray(0, 32), png.subarray(0, -1), jpeg(1, 1).subarray(0, -2)]) {
      assert.throws(() => inspectMediaImage(bytes))
    }
    const corrupted = Buffer.from(png)
    corrupted.writeUInt32BE(0xffffffff, 33)
    assert.throws(() => inspectMediaImage(corrupted))
    const invalidWebp = webp('VP8L', 1, 1)
    invalidWebp.writeUInt32LE(0xffffffff, 16)
    assert.throws(() => inspectMediaImage(invalidWebp))
  })

  it('rejects oversized byte payloads, dimensions, zero sizes and pixel bombs', () => {
    assert.throws(() => inspectMediaImage(Buffer.alloc(MAX_MEDIA_BYTES + 1)))
    assert.throws(() => inspectMediaImage(jpeg(0, 1)))
    assert.throws(() => inspectMediaImage(jpeg(32_769, 1)))
    assert.ok(8192 * 8192 > MAX_MEDIA_PIXELS)
    assert.throws(() => inspectMediaImage(jpeg(8192, 8192)))
    const hugePng = Buffer.from(png)
    hugePng.writeUInt32BE(100_000, 16)
    assert.throws(() => inspectMediaImage(hugePng))
  })

  it('rejects animated and invalid-version WebP containers', () => {
    const animated = webp('VP8X', 1, 1)
    animated[20] = 2
    assert.throws(() => inspectMediaImage(animated))
    const invalidVersion = webp('VP8L', 1, 1)
    invalidVersion[24] = 0xe0
    assert.throws(() => inspectMediaImage(invalidVersion))
  })
})
