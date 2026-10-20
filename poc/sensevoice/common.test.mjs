import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { analyzeWaveform, buildRecognizerConfig, parseOptions, validateWav, verifyFile } from './common.mjs'

function fixtureWav() {
  const bytes = Buffer.alloc(48)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(40, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(4, 40)
  return bytes
}

describe('SenseVoice POC WAV container validation', () => {
  it('accepts a complete mono PCM16 16 kHz WAV', () => {
    assert.doesNotThrow(() => validateWav(fixtureWav()))
  })

  for (const [name, modify] of [
    ['stereo', bytes => bytes.writeUInt16LE(2, 22)],
    ['wrong rate', bytes => bytes.writeUInt32LE(48000, 24)],
    ['float codec', bytes => bytes.writeUInt16LE(3, 20)],
    ['wrong bits', bytes => bytes.writeUInt16LE(8, 34)],
    ['wrong byte rate', bytes => bytes.writeUInt32LE(1, 28)],
    ['wrong block alignment', bytes => bytes.writeUInt16LE(1, 32)],
    ['oversized chunk', bytes => bytes.writeUInt32LE(500, 16)],
    ['missing format', bytes => bytes.write('JUNK', 12)],
    ['missing data', bytes => bytes.write('JUNK', 36)],
    ['empty data', bytes => bytes.writeUInt32LE(0, 40)],
    ['invalid RIFF size', bytes => bytes.writeUInt32LE(500, 4)],
    ['invalid header', bytes => bytes.write('MP3!', 0)],
    ['invalid WAVE', bytes => bytes.write('wave', 8)],
  ]) {
    it(`rejects ${name} before native audio decoding`, () => {
      const bytes = fixtureWav()
      modify(bytes)
      assert.throws(() => validateWav(bytes))
    })
  }

  it('rejects truncated and excessive audio', () => {
    assert.throws(() => validateWav(Buffer.alloc(1)))
    assert.throws(() => validateWav(fixtureWav().subarray(0, 47)))
    assert.throws(() => validateWav(Buffer.alloc(2_000_001)))
  })
})

describe('SenseVoice POC options', () => {
  it('defaults to two CPU threads and three decodes using one model', () => {
    const options = parseOptions([])
    assert.equal(options.threads, 2)
    assert.equal(options.runs, 3)
    assert.equal(options.timeoutMs, 120_000)
    assert.ok(options.wav.endsWith('test_wavs/zh.wav') || options.wav.endsWith('test_wavs\\zh.wav'))
    assert.equal(options.fixture, true)
  })

  it('supports custom asset directories and recordings, including spaces', () => {
    const options = parseOptions(['--model-dir', 'path with spaces', '--wav', 'my recording.wav',
      '--threads', '1', '--runs', '2', '--timeout-ms', '30000', '--output', 'output/custom.json'])
    assert.equal(options.modelDir, resolve('path with spaces'))
    assert.equal(options.wav, resolve('my recording.wav'))
    assert.equal(options.fixture, false)
    assert.equal(options.threads, 1)
    assert.equal(options.runs, 2)
    assert.equal(options.timeoutMs, 30000)
    assert.equal(options.output, resolve('output/custom.json'))
  })

  it('derives the default fixture from a custom model directory', () => {
    assert.equal(parseOptions(['--model-dir', 'models']).wav, resolve('models/test_wavs/zh.wav'))
  })

  for (const args of [
    ['--unknown', 'x'], ['--threads'], ['--threads', '--runs'],
    ['--threads', '0'], ['--threads', '9'], ['--threads', '1.5'], ['--runs', '0'],
    ['--runs', '11'], ['--runs', 'NaN'], ['--runs', '2junk'], ['--timeout-ms', '0'],
    ['--timeout-ms', '300001'], ['--wav', ''], ['--runs', '1', '--runs', '2'],
  ]) {
    it(`rejects invalid arguments ${JSON.stringify(args)}`, () => {
      assert.throws(() => parseOptions(args))
    })
  }
})

describe('SenseVoice POC audio validation', () => {
  it('preserves normalized float samples and measures their levels', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1])
    const result = analyzeWaveform({ sampleRate: 16000, samples })
    assert.equal(result.sampleRate, 16000)
    assert.equal(result.sampleCount, 4)
    assert.equal(result.durationSeconds, 4 / 16000)
    assert.equal(result.peak, 1)
    assert.equal(result.clippedSamples, 1)
    assert.equal(result.rms, Math.sqrt(1.5 / 4))
    assert.deepEqual([...samples], [0, 0.5, -0.5, 1])
  })

  it('does not invent text or amplify silence', () => {
    assert.equal(analyzeWaveform({ sampleRate: 16000, samples: new Float32Array(160) }).rms, 0)
  })

  for (const wave of [
    null, {}, { sampleRate: 48000, samples: new Float32Array(10) },
    { sampleRate: 16000, samples: [] }, { sampleRate: 16000, samples: new Float32Array() },
    { sampleRate: 16000, samples: new Float32Array([NaN]) },
    { sampleRate: 16000, samples: new Float32Array([Infinity]) },
    { sampleRate: 16000, samples: new Float32Array([32767]) },
    { sampleRate: 16000, samples: new Float32Array(16000 * 30 + 1) },
  ]) {
    it('rejects invalid audio before inference', () => {
      assert.throws(() => analyzeWaveform(wave))
    })
  }
})

describe('SenseVoice POC configuration and asset integrity', () => {
  it('explicitly selects CPU and the INT8 model without downloading anything', () => {
    const config = buildRecognizerConfig({ modelDir: resolve('models'), threads: 2 })
    assert.equal(config.modelConfig.provider, 'cpu')
    assert.equal(config.modelConfig.numThreads, 2)
    assert.equal(config.modelConfig.debug, 0)
    assert.equal(config.modelConfig.senseVoice.model, resolve('models/model.int8.onnx'))
    assert.equal(config.modelConfig.tokens, resolve('models/tokens.txt'))
    assert.equal(config.featConfig.sampleRate, 16000)
  })

  it('accepts pinned hashes and rejects missing, damaged or wrong-size files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sensevoice-integrity-'))
    try {
      const path = join(directory, 'model')
      const bytes = Buffer.from('fixture')
      await writeFile(path, bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await verifyFile(path, { bytes: bytes.length, sha256 })
      await assert.rejects(verifyFile(path, { bytes: bytes.length, sha256: '0'.repeat(64) }), /checksum/i)
      await assert.rejects(verifyFile(path, { bytes: 1, sha256 }), /size/i)
      await assert.rejects(verifyFile(join(directory, 'absent'), { bytes: 1, sha256 }), /missing/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('can verify the Git blob hashes pinned by the upstream repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sensevoice-git-hash-'))
    try {
      const bytes = Buffer.from('tokens')
      const path = join(directory, 'tokens.txt')
      await writeFile(path, bytes)
      const gitSha1 = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      await verifyFile(path, { bytes: bytes.length, gitSha1 })
      await assert.rejects(verifyFile(path, { bytes: bytes.length, gitSha1: '0'.repeat(40) }), /checksum/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
