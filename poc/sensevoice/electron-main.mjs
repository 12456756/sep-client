import { app, utilityProcess } from 'electron'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { parseOptions } from './common.mjs'

const options = parseOptions(process.argv.slice(2))
let profile
let worker, timer, heartbeat, finished = false
let beats = 0, maxMainLoopGapMs = 0, previousBeat = performance.now()
const startedAt = performance.now()

async function finish(passed, result) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  clearInterval(heartbeat)
  worker?.kill()
  const evidence = { passed, timestamp: new Date().toISOString(),
    execution: 'Electron utilityProcess', totalMs: performance.now() - startedAt,
    mainProcessHeartbeat: { beats, maxGapMs: maxMainLoopGapMs }, ...result }
  try {
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, JSON.stringify(evidence, null, 2) + '\n')
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(`Could not write POC evidence: ${String(error)}\n`)
    passed = false
  }
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  app.exit(passed ? 0 : 1)
}

async function main() {
  profile = await mkdtemp(join(tmpdir(), 'sep-sensevoice-poc-'))
  app.setPath('userData', profile)
  await app.whenReady()
  heartbeat = setInterval(() => {
    const now = performance.now()
    maxMainLoopGapMs = Math.max(maxMainLoopGapMs, now - previousBeat)
    previousBeat = now
    beats++
  }, 50)
  timer = setTimeout(() => void finish(false, { error: 'Speech worker timed out' }), options.timeoutMs)
  worker = utilityProcess.fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
    serviceName: 'SenseVoice CPU POC', stdio: 'pipe',
  })
  worker.stdout?.on('data', chunk => process.stdout.write(chunk))
  worker.stderr?.on('data', chunk => process.stderr.write(chunk))
  worker.once('spawn', () => {
    const { modelDir, wav, fixture, threads, runs } = options
    worker.postMessage({ modelDir, wav, fixture, threads, runs })
  })
  worker.once('message', message => {
    const parsed = z.discriminatedUnion('type', [
      z.object({ type: z.literal('result'), report: z.object({ fixtureMatches: z.boolean().optional(),
        runs: z.array(z.object({ text: z.string().min(1) }).passthrough()).min(1) }).passthrough() }),
      z.object({ type: z.literal('error'), error: z.string() }),
    ]).safeParse(message)
    if (!parsed.success) return void finish(false, { error: 'Invalid speech worker response' })
    const reply = parsed.data
    if (reply.type === 'error') return void finish(false, { error: reply.error })
    const repeatable = reply.report.runs.every(run => run.text === reply.report.runs[0].text)
    void finish(repeatable, { checks: { inference: true, repeatable,
      matchesPublishedReference: reply.report.fixtureMatches ?? null },
    accuracyReviewRequired: reply.report.fixtureMatches === false, report: reply.report })
  })
  worker.once('exit', code => { if (!finished) void finish(false, { error: `Speech worker exited unexpectedly: ${code}` }) })
}

// Do not await app.whenReady() at module scope: Electron waits for ESM evaluation before becoming ready.
void main().catch(error => finish(false, { error: error instanceof Error ? error.message : String(error) }))
