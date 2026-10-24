import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeToolText, OrderedToolOutput, utf8ChildEnvironment } from './pi-text-encoding'

const chinese = '\u4e2d\u6587\u6d4b\u8bd5'
const gbk = Buffer.from('d6d0cec4b2e2cad4'.repeat(10), 'hex')

describe('tool byte decoding', () => {
  it('leaves valid UTF-8, literal replacement characters and existing mojibake untouched', () => {
    for (const text of ['hello', chinese, '\ufffd', '\u9225\u72b2\u7c8b', '\ufeff' + chinese, '\ud83d\ude00']) {
      assert.equal(decodeToolText(Buffer.from(text), () => { throw new Error('must not detect UTF-8') }), text)
    }
  })

  it('recovers a high-confidence GB18030 sample before UTF-8 decoding loses bytes', () => {
    assert.equal(decodeToolText(gbk), chinese.repeat(10))
  })

  it('recognizes UTF-16 BOMs without modifying source bytes', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(chinese, 'utf16le')])
    const be = Buffer.from(le).swap16()
    assert.equal(decodeToolText(le), chinese)
    assert.equal(decodeToolText(be), chinese)
    assert.equal(le.toString('hex'), 'fffe2d4e87654b6dd58b')
  })

  it('does not confuse UTF-32 or binary input with UTF-16', () => {
    const bytes = Buffer.from('fffe00002d4e0000', 'hex')
    assert.equal(decodeToolText(bytes), bytes.toString('utf8'))
  })

  it('keeps baseline text when detection is ambiguous, throws, or decoding fails', () => {
    const invalid = Buffer.from([0xff, 0xc0, 0x81, 0x80, 0xff, 0xfe, 0xff, 0x80])
    const detectors = [
      () => [],
      () => [{ name: 'GB18030', confidence: 50 }],
      () => [{ name: 'GB18030', confidence: 99 }, { name: 'Big5', confidence: 98 }],
      () => [{ name: 'unsupported-charset', confidence: 100 }],
      () => [{ name: 'utf-8', confidence: 100 }],
      () => { throw new Error('detector unavailable') },
    ]
    for (const detect of detectors) assert.equal(decodeToolText(invalid, detect), invalid.toString('utf8'))
    const brokenUtf16 = Buffer.from([0xff, 0xfe, 0x2d])
    assert.equal(decodeToolText(brokenUtf16), brokenUtf16.toString('utf8'))
    assert.equal(decodeToolText(Buffer.from([0xd6, 0xd0])), Buffer.from([0xd6, 0xd0]).toString('utf8'))
  })
})

describe('ordered streaming tool output', () => {
  function output(recover?: (bytes: Buffer) => string) {
    const chunks: Buffer[] = []
    const stream = new OrderedToolOutput(bytes => chunks.push(bytes), recover)
    return { stream, value: () => Buffer.concat(chunks).toString('utf8') }
  }

  it('streams ordinary output immediately and preserves every UTF-8 byte split', () => {
    const text = chinese + '\ud83d\ude00\n'
    const bytes = Buffer.from(text)
    for (let split = 1; split < bytes.length; split++) {
      const { stream, value } = output()
      stream.write('stdout', Buffer.from('start\n'))
      assert.equal(value(), 'start\n')
      stream.write('stdout', bytes.subarray(0, split))
      stream.write('stdout', bytes.subarray(split))
      stream.finish()
      stream.finish()
      assert.equal(value(), 'start\n' + text)
    }
  })

  it('keeps stdout and stderr character state separate without moving intervening output', () => {
    const { stream, value } = output()
    const bytes = Buffer.from(chinese)
    stream.write('stdout', bytes.subarray(0, 1))
    stream.write('stderr', Buffer.from('error\n'))
    stream.write('stdout', bytes.subarray(1))
    stream.finish()
    assert.equal(value(), chinese[0] + 'error\n' + chinese.slice(1))
  })

  it('recovers legacy output with arbitrary byte chunks and flushes its tail', () => {
    const { stream, value } = output()
    for (const byte of gbk) stream.write('stdout', Buffer.from([byte]))
    stream.write('stderr', Buffer.from('tail'))
    stream.finish()
    assert.equal(value(), chinese.repeat(10) + 'tail')
  })

  it('decodes UTF-16 streams with split BOMs and split code units', () => {
    for (const bytes of [
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(chinese + '\n', 'utf16le')]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(chinese + '\n', 'utf16le')]).swap16(),
    ]) {
      const { stream, value } = output()
      for (const byte of bytes) stream.write('stdout', Buffer.from([byte]))
      stream.finish()
      assert.equal(value(), chinese + '\n')
    }
  })

  it('preserves UTF-32 fallback with every byte boundary', () => {
    const bytes = Buffer.from('fffe00002d4e0000', 'hex')
    for (let split = 1; split < bytes.length; split++) {
      const { stream, value } = output()
      stream.write('stdout', bytes.subarray(0, split))
      stream.write('stdout', bytes.subarray(split))
      stream.finish()
      assert.equal(value(), bytes.toString('utf8'))
    }
  })

  it('preserves long UTF-8 across reproducible irregular chunks', () => {
    const text = (chinese + '\ud83d\ude00\r\n' + 'ASCII '.repeat(10)).repeat(300)
    const bytes = Buffer.from(text)
    for (let seed = 1; seed < 20; seed++) {
      const { stream, value } = output()
      let random = seed
      for (let offset = 0; offset < bytes.length;) {
        random = (random * 1664525 + 1013904223) >>> 0
        const length = random % 8000 + 1
        stream.write('stdout', bytes.subarray(offset, offset + length))
        offset += length
      }
      stream.finish()
      assert.equal(value(), text)
    }
  })

  it('retains unrecovered bytes in place when recovery throws, without stopping output', () => {
    const { stream, value } = output(() => { throw new Error('repair failed') })
    const bad = Buffer.from([0xff, 0x81, 0x0a])
    stream.write('stdout', Buffer.from('before\n'))
    stream.write('stdout', bad)
    stream.write('stdout', Buffer.from('after\n'))
    stream.finish()
    assert.equal(value(), 'before\n' + bad.toString('utf8') + 'after\n')
  })

  it('bounds buffering for invalid output and an unfinished character on another stream', () => {
    const { stream, value } = output(() => { throw new Error('repair failed') })
    stream.write('stdout', Buffer.from([0xe4]))
    stream.write('stderr', Buffer.alloc(200_000, 0xff))
    assert.ok(value().length > 100_000)
    stream.finish()
    assert.equal(value(), '\ufffd'.repeat(200_001))
  })
})

describe('child-only UTF-8 defaults', () => {
  it('sets defaults without mutating parent environment or overriding explicit settings', () => {
    const env = { PATH: 'path', KEEP: 'value' }
    const child = utf8ChildEnvironment(env)
    assert.equal(child.PYTHONIOENCODING, 'utf-8')
    assert.equal(child.PYTHONUTF8, '1')
    assert.equal(child.LANG, 'C.UTF-8')
    assert.deepEqual(env, { PATH: 'path', KEEP: 'value' })
    assert.equal(utf8ChildEnvironment({ PYTHONIOENCODING: 'gbk' }).PYTHONIOENCODING, 'gbk')
  })
})
