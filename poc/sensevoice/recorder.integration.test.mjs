/* global window, document, navigator */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it, before, after } from 'node:test'
import { _electron } from 'playwright-core'
import electron from 'electron'
import { buildRecorder } from './record.mjs'

let directory, application, page
const evidenceDir = resolve('artifacts/sensevoice/recorder-tests')
const fixture = fileURLToPath(new URL('../../resources/speech/sensevoice-int8/test_wavs/zh.wav', import.meta.url))
const execute = promisify(execFile)

async function waitForVisibleCliWindow(parentId) {
  const script = `
    Add-Type -Namespace SpeechPocProbe -Name Native -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, System.IntPtr data);
    public delegate bool EnumWindowsProc(System.IntPtr handle, System.IntPtr data);
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr handle, out uint processId);
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr handle);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr handle, System.Text.StringBuilder text, int count);
'@
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while ([DateTime]::UtcNow -lt $deadline) {
      $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentId} AND Name='electron.exe'" | Select-Object -First 1
      if ($child) {
        $script:found = $false
        [SpeechPocProbe.Native]::EnumWindows({
          param($handle,$data)
          [uint32]$owner=0
          [void][SpeechPocProbe.Native]::GetWindowThreadProcessId($handle,[ref]$owner)
          if ($owner -eq $child.ProcessId -and [SpeechPocProbe.Native]::IsWindowVisible($handle)) {
            $title=[System.Text.StringBuilder]::new(512)
            [void][SpeechPocProbe.Native]::GetWindowText($handle,$title,512)
            if ($title.ToString().StartsWith('SenseVoice')) { $script:found=$true }
          }
          return $true
        },[IntPtr]::Zero) | Out-Null
        if ($script:found) { Write-Output 'VISIBLE'; exit 0 }
      }
      Start-Sleep -Milliseconds 200
    }
    Write-Output 'HIDDEN'; exit 1
  `
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000, windowsHide: true })
}
async function launch(extra = {}, args = []) {
  const env = { ...process.env, SEP_SPEECH_RECORDER_DIR: directory, SEP_SPEECH_POC_TEST: '1',
    SEP_SPEECH_POC_TEST_AUDIO: fixture, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: electron,
    args: [fileURLToPath(new URL('./recorder-main.mjs', import.meta.url)), ...args], env, timeout: 30_000 })
  try {
    const window = await app.firstWindow()
    window.setDefaultTimeout(10_000)
    await window.waitForFunction(() => Boolean(window.speechPoc) && document.body.dataset.phase === 'idle')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    return { app, window }
  } catch (error) { await app.close(); throw error }
}
async function phase(value) {
  try { await page.waitForFunction(expected => document.body.dataset.phase === expected, value, { timeout: 15_000 }) }
  catch (error) {
    const state = await page.evaluate(() => ({ phase: document.body.dataset.phase, error: document.getElementById('error').textContent }))
    throw new Error(`Expected ${value}; received ${JSON.stringify(state)}`, { cause: error })
  }
}

describe('microphone recorder in Electron (virtual microphone only)', { timeout: 180_000 }, () => {
  before(async () => {
    directory = await buildRecorder()
    await mkdir(evidenceDir, { recursive: true })
    const result = await launch()
    application = result.app
    page = result.window
  })
  after(async () => { await application?.close() })

  it('shows a real window when launched by the ordinary CLI without Playwright forcing it visible', { timeout: 30_000 }, async () => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('SEP_SPEECH_POC_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key]
    const child = spawn(process.execPath, [fileURLToPath(new URL('./record.mjs', import.meta.url))], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let diagnostics = ''
    child.stdout.on('data', chunk => { diagnostics += chunk })
    child.stderr.on('data', chunk => { diagnostics += chunk })
    const exited = new Promise(resolve => child.once('exit', resolve))
    try {
      const result = await waitForVisibleCliWindow(child.pid)
      assert.match(result.stdout, /VISIBLE/)
    } catch (error) {
      throw new Error(`Ordinary recorder CLI did not open a visible window. ${diagnostics}`, { cause: error })
    } finally {
      if (child.exitCode === null) await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      await exited
    }
  })

  it('opens a sandboxed window without Node, with no clipping at desktop and mobile widths', async () => {
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.deepEqual(await page.evaluate(() => Object.keys(window.speechPoc).sort()), ['arm', 'cancel', 'prepare', 'recognize'])
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 780 })
      await page.waitForFunction(expected => window.innerWidth === expected, width)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
        right: Math.max(...[...document.querySelectorAll('main, header, canvas, textarea, button')].map(element => element.getBoundingClientRect().right)) }))
      assert.ok(layout.right <= layout.width, JSON.stringify(layout))
      const pixels = await page.locator('canvas').evaluate(canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        let painted = 0
        for (let index = 3; index < data.length; index += 4) if (data[index]) painted++
        return painted
      })
      assert.ok(pixels > 0)
      await page.screenshot({ path: resolve(evidenceDir, `idle-${width}.png`), fullPage: true })
    }
    await page.setViewportSize({ width: 900, height: 780 })
  })

  it('resamples in the utility process with correct duration and anti-aliasing, retaining the final impulse', async () => {
    const result = await page.evaluate(async () => {
      const recordingId = crypto.randomUUID()
      const armed = await window.speechPoc.arm(recordingId)
      if (!armed.ok) throw new Error(armed.error)
      async function prepareAudio(samples, sampleRate) {
        const response = await window.speechPoc.prepare({ recordingId, samples, sampleRate })
        if (!response.ok) throw new Error(response.error)
        return response.data
      }
      try {
        const rate = 48000
        const low = new Float32Array(rate), high = new Float32Array(rate), tail = new Float32Array(rate)
        for (let i = 0; i < rate; i++) { low[i] = 0.25 * Math.sin(2 * Math.PI * 1000 * i / rate); high[i] = 0.25 * Math.sin(2 * Math.PI * 12000 * i / rate) }
        tail[rate - 12] = 0.5
        const first = await prepareAudio(low, rate), second = await prepareAudio(high, rate), third = await prepareAudio(tail, rate)
        const from44100 = await prepareAudio(new Float32Array(44100).fill(0.1), 44100)
        return { count: first.samples.length, duration: first.processed.durationSeconds,
          lowRms: first.processed.rms, highRms: second.processed.rms,
          tailPeak: Math.max(...third.samples.slice(-32).map(Math.abs)), otherCount: from44100.samples.length }
      } finally { await window.speechPoc.cancel(recordingId) }
    })
    assert.equal(result.count, 16000)
    assert.equal(result.otherCount, 16000)
    assert.equal(result.duration, 1)
    assert.ok(result.lowRms > 0.16 && result.lowRms < 0.19)
    assert.ok(result.highRms < result.lowRms * 0.1)
    assert.ok(result.tailPeak > 0.01)
  })

  it('rejects unbounded requests and renderer-supplied filesystem paths', async () => {
    const results = await page.evaluate(async () => {
      const base = { recordingId: 'invalid', sampleRate: 16000, samples: new Float32Array([0]) }
      return Promise.all([
        window.speechPoc.recognize({ ...base, modelDir: 'C:/' }),
        window.speechPoc.recognize({ ...base, samples: new Float32Array(480001) }),
        window.speechPoc.recognize({ ...base, samples: new Float32Array([NaN]) }),
        window.speechPoc.prepare({ ...base, sampleRate: 96000, samples: new Float32Array(2880001) }),
        window.speechPoc.prepare({ ...base, sampleRate: 1000 }),
        window.speechPoc.prepare(base),
      ])
    })
    assert.ok(results.every(result => result.ok === false))
  })

  it('denies microphone access without an armed session, and denies camera access even when armed', async () => {
    const result = await page.evaluate(async () => {
      async function denied(constraints) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints)
          stream.getTracks().forEach(track => track.stop())
          return false
        } catch (error) { return error.name === 'NotAllowedError' }
      }
      const microphone = await denied({ audio: true })
      const id = crypto.randomUUID()
      const armed = await window.speechPoc.arm(id)
      try { return { microphone, armed: armed.ok, camera: await denied({ video: true }) } }
      finally { await window.speechPoc.cancel(id) }
    })
    assert.deepEqual(result, { microphone: true, armed: true, camera: true })
  })

  it('does not invent a transcript for silence', async () => {
    const result = await page.evaluate(async () => {
      const recordingId = crypto.randomUUID()
      await window.speechPoc.arm(recordingId)
      try {
        const preparation = await window.speechPoc.prepare({ recordingId, sampleRate: 48000, samples: new Float32Array(48000) })
        if (!preparation.ok) throw new Error(preparation.error)
        return await window.speechPoc.recognize({ recordingId, sampleRate: 16000, samples: preparation.data.samples })
      } finally { await window.speechPoc.cancel(recordingId) }
    })
    assert.equal(result.ok, true)
    assert.equal(result.data.silent, true)
    assert.equal(result.data.text, '')
    assert.equal(result.data.modelLoadMs, 0)
  })

  it('captures virtual microphone audio, flushes it and recognizes it without writing a recording', async () => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.locator('#start').click()
    await phase('recording')
    await page.waitForTimeout(6500)
    await page.screenshot({ path: resolve(evidenceDir, 'recording.png'), fullPage: true })
    await page.locator('#stop').click()
    await phase('done')
    assert.ok((await page.locator('#transcript').inputValue()).length > 0)
    assert.equal(await page.locator('#output-rate').textContent(), '16,000 Hz')
    assert.equal(await page.locator('#start').isEnabled(), true)
    assert.equal(await page.locator('#stop').isEnabled(), false)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(evidenceDir, 'recognized.png'), fullPage: true })
  })

  it('can replay both waveforms and explicitly stop playback', async () => {
    for (const id of ['play-source', 'play-processed']) {
      await page.locator(`#${id}`).click()
      await page.waitForFunction(() => !document.getElementById('stop-playback').disabled)
      await page.locator('#stop-playback').click()
      assert.equal(await page.locator('#stop-playback').isEnabled(), false)
    }
  })

  it('reuses the loaded model for the next recording', async () => {
    await page.locator('#start').click()
    await phase('recording')
    await page.waitForTimeout(2000)
    await page.locator('#stop').click()
    await phase('done')
    assert.equal(await page.locator('#load-time').textContent(), '\u5df2\u590d\u7528')
  })

  it('cancels capture and can immediately restart', async () => {
    await page.locator('#start').click()
    await phase('recording')
    await page.locator('#cancel').click()
    await phase('cancelled')
    await page.locator('#start').click()
    await phase('recording')
    await page.locator('#cancel').click()
    await phase('cancelled')
    await page.waitForTimeout(500)
    assert.equal(await page.locator('#transcript').inputValue(), '')
    assert.equal(await page.locator('#start').isEnabled(), true)
  })

  it('cancels an active recognition worker and ignores its old result', async () => {
    const other = await launch()
    try {
      await other.window.locator('#start').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'recording')
      await other.window.waitForTimeout(2000)
      await other.window.locator('#stop').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'processing')
      await other.window.locator('#cancel').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'cancelled')
      await other.window.waitForTimeout(500)
      assert.equal(await other.window.locator('#transcript').inputValue(), '')
      assert.equal(await other.window.locator('#start').isEnabled(), true)
    } finally { await other.app.close() }
  })

  it('handles denied microphone access without leaving an active session', async () => {
    const other = await launch({ SEP_SPEECH_POC_DENY_MIC: '1' })
    try {
      await other.window.locator('#start').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'error')
      assert.equal(await other.window.locator('#error').isVisible(), true)
      assert.equal(await other.window.locator('#start').isEnabled(), true)
    } finally { await other.app.close() }
  })

  it('releases a timed-out worker and allows another recording attempt', async () => {
    const other = await launch({}, ['--timeout-ms', '1'])
    try {
      await other.window.locator('#start').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'recording')
      await other.window.waitForTimeout(1000)
      await other.window.locator('#stop').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'error')
      assert.match(await other.window.locator('#error').textContent(), /timed out/)
      await other.window.locator('#start').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'recording')
      await other.window.locator('#cancel').click()
      await other.window.waitForFunction(() => document.body.dataset.phase === 'cancelled')
    } finally { await other.app.close() }
  })
})
