import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

const execute = promisify(execFile)
const electronVersion = createRequire(import.meta.url)('electron/package.json').version
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url))
const assets = fileURLToPath(new URL('../../resources/speech/sensevoice-int8/', import.meta.url))

async function withRun(args, verify) {
  const directory = await mkdtemp(join(tmpdir(), 'sep-speech-integration-'))
  try {
    const output = join(directory, 'evidence.json')
    const flags = typeof args === 'function' ? await args(directory) : args
    let exitCode = 0
    try {
      await execute(process.execPath, [runner, ...flags, '--output', output], {
        windowsHide: true, timeout: 150_000, maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      assert.equal(typeof error.code, 'number', `POC crashed or timed out: ${error.message}`)
      exitCode = error.code
    }
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    await verify(evidence, exitCode)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SenseVoice in the actual Electron utility process', { timeout: 150_000 }, () => {
  it('loads the pinned INT8 model once, decodes repeatedly and keeps the main loop alive', async () => {
    await withRun(['--runs', '3'], (evidence, code) => {
      assert.equal(code, 0)
      assert.equal(evidence.passed, true)
      assert.equal(evidence.execution, 'Electron utilityProcess')
      assert.equal(evidence.report.provider, 'cpu')
      assert.equal(evidence.report.electronVersion, electronVersion)
      assert.equal(evidence.report.runs.length, 3)
      assert.equal(evidence.checks.repeatable, true)
      assert.equal(evidence.accuracyReviewRequired, !evidence.checks.matchesPublishedReference)
      assert.ok(evidence.mainProcessHeartbeat.beats > 0)
      assert.ok(evidence.report.modelLoadMs > 0)
      assert.ok(evidence.report.peakRssMiB > 0)
      assert.equal(evidence.report.audio.sampleRate, 16000)
    })
  })

  it('accepts a local recording with a Unicode path and does not apply a fixture transcript to it', async () => {
    await withRun(async directory => {
      const wav = join(directory, '\u4e2d\u6587 recording.wav')
      await copyFile(join(assets, 'test_wavs/zh.wav'), wav)
      return ['--wav', wav, '--runs', '1']
    }, (evidence, code) => {
      assert.equal(code, 0)
      assert.equal(evidence.passed, true)
      assert.equal(evidence.checks.matchesPublishedReference, null)
      assert.equal(evidence.report.expectedText, undefined)
      assert.ok(evidence.report.runs[0].text.length > 0)
    })
  })

  it('reports a missing model instead of loading another model or downloading one', async () => {
    await withRun(directory => ['--model-dir', directory], (evidence, code) => {
      assert.equal(code, 1)
      assert.equal(evidence.passed, false)
      assert.match(evidence.error, /missing asset/i)
    })
  })

  it('rejects a non-WAV recording before calling the native reader', async () => {
    await withRun(['--wav', runner], (evidence, code) => {
      assert.equal(code, 1)
      assert.equal(evidence.passed, false)
      assert.match(evidence.error, /RIFF WAV/i)
    })
  })

  it('terminates an unfinished worker on timeout', async () => {
    await withRun(['--timeout-ms', '1'], (evidence, code) => {
      assert.equal(code, 1)
      assert.equal(evidence.passed, false)
      assert.match(evidence.error, /timed out/i)
    })
  })
})
