import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

describe('main window application icon', () => {
  it('uses a bundled asset for the window icon in development and packaged builds', () => {
    const source = readFileSync(new URL('./main-window.ts', import.meta.url), 'utf8')
    assert.match(source, /import appIcon from ['"]\.\.\/\.\.\/build\/icon\.png\?asset['"]/)
    assert.match(source, /\bicon:\s*appIcon\b/)
  })

  it('uses a valid square PNG suitable for the native window icon', () => {
    const png = readFileSync(new URL('../../build/icon.png', import.meta.url))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(png.readUInt32BE(16), 512)
    assert.equal(png.readUInt32BE(20), 512)
  })
})
