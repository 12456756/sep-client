import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { inspectMediaImage, MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS } from './media-image'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')

function jpeg(width: number, height: number): Buffer {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9])
  data.writeUInt16BE(height, 7)
  data.writeUInt16BE(width, 9)
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
    const image = jpeg(640, 480)
    assert.deepEqual(inspectMediaImage(image), { mime: 'image/jpeg', width: 640, height: 480, size: image.length })
    const metadata = Buffer.from([0xff, 0xe1, 0, 4, 0, 0])
    assert.equal(inspectMediaImage(Buffer.concat([image.subarray(0, 2), metadata, image.subarray(2)])).height, 480)
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
