import { describe, it, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import type { LocalVideoJob } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { VideoTracker, type VideoTrackerOptions, type VideoTrackerPort } from './video-tracker'

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

class Clock {
  private time = 0
  private readonly timers = new Set<{ at: number; ms: number; finish(error?: unknown): void }>()
  readonly now = (): number => this.time
  readonly delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const aborted = (): void => timer.finish(signal.reason)
    const timer = { at: this.time + ms, ms, finish: (error?: unknown): void => {
      this.timers.delete(timer)
      signal.removeEventListener('abort', aborted)
      if (error === undefined) resolve()
      else reject(error)
    } }
    this.timers.add(timer)
    signal.addEventListener('abort', aborted, { once: true })
  })
  get pending(): number[] { return [...this.timers].map(timer => timer.ms).sort((a, b) => a - b) }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    for (;;) {
      const next = [...this.timers].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.time = next.at
      next.finish()
      await flush()
    }
    this.time = target
    await flush()
  }
}

function job(pollAfterMs = 100): LocalVideoJob {
  return {
    version: 1, scope: { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' },
    taskId: 'task-a', jobId: 'job-a',
    request: { profileId: 'mock-video', configVersion: 'mock-video-v1', operation: 'text-to-video', referenceIds: [],
      creativeBrief: 'Mock clip', parameters: { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' },
      clientRequestId: 'request-a', quoteId: 'quote-a' },
    quote: { quoteId: 'quote-a', requestHash: 'a'.repeat(64), expiresAt: 10_000, status: 'quoted', amount: '0', currency: 'CNY' },
    submission: 'RECEIPTED', trackingStatus: 'ACTIVE', saveStatus: 'PENDING', error: null, createdAt: 0, updatedAt: 0,
    receipt: { mock: true, receiptId: 'receipt-a', clientRequestId: 'request-a', profileId: 'mock-video', configVersion: 'mock-video-v1', operation: 'text-to-video',
      status: 'RUNNING', pollAfterMs, outputs: [], billingStatus: 'MOCK_NOT_CHARGED', errorCode: null,
      recovery: { canQuery: true, canCancel: false, canDownload: false } },
  }
}

function setup(t: TestContext, recover: VideoTrackerPort['recover'], options: Partial<VideoTrackerOptions> = {}) {
  const clock = new Clock()
  const calls: number[] = []
  let resumes = 0
  const service: VideoTrackerPort = {
    recover: signal => { calls.push(clock.now()); return recover(signal) },
    resume: async () => { resumes++; return job() },
  }
  const tracker = new VideoTracker({ service, floorMs: 10, maxDelayMs: 200, maxAttempts: 10, budgetMs: 20_000, now: clock.now, delay: clock.delay, ...options })
  t.after(async () => { await tracker.stop(); assert.deepEqual(clock.pending, []); assert.equal(resumes, 0) })
  return { tracker, clock, calls }
}

describe('VideoTracker bounded scope polling', () => {
  it('keeps the original recovery alive while 429 cooling exceeds the normal tracking budget', async () => {
    const clock = new Clock()
    let waiting = true, recoveredAt = 0, calls = 0
    let inFlight: AbortSignal | undefined
    const tracker = new VideoTracker({ now: clock.now, delay: clock.delay, budgetMs: 50,
      floorMs: 10, maxDelayMs: 100, service: {
        resume: async () => job(),
        hasRateLimitWait: async () => waiting,
        recoveredFromRateLimitAt: () => recoveredAt,
        recover: async signal => {
          calls++; inFlight = signal
          await clock.delay(150, signal!)
          waiting = false; recoveredAt = clock.now()
          return []
        },
      } })
    const pending = tracker.start()
    try {
      await flush()
      await clock.advance(149)
      assert.equal(inFlight?.aborted, false)
      await clock.advance(1)
      await pending
      assert.equal(calls, 1)
      assert.deepEqual(clock.pending, [])
    } finally { await tracker.stop() }
  })
  it('uses v2 polling actions for delivery and respects their stop even if the composite status remains RUNNING', async t => {
    let rounds = 0
    const { tracker, clock, calls } = setup(t, async () => {
      const current = job(100)
      rounds++
      return [{ ...current, receipt: { ...current.receipt!, mock: false, billingStatus: 'RECONCILING', receiptVersion: 2,
        fileStatus: rounds === 1 ? 'download_failed' : 'unavailable',
        execution: { requestId: 'original', taskId: 'original-task', submissionStatus: 'accepted', generationStatus: 'completed',
          isFinal: true, observedAt: 0, statusSource: 'upstream', billing: { status: 'unknown', actualCostUsd: null } },
        clientActions: { submissionFinished: true, generationFinished: true, shouldPoll: rounds === 1,
          pollPurpose: rounds === 1 ? 'delivery' : 'none', canStartNewRequest: true, canRetryDownload: rounds === 1 } } }]
    })
    const running = tracker.start()
    await flush()
    assert.deepEqual(clock.pending, [100, 20_000])
    await clock.advance(100)
    await running
    assert.deepEqual(calls, [0, 100])
    assert.deepEqual(clock.pending, [])
  })
  for (const status of ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'] as const) {
    for (const billingStatus of ['RESERVED', 'RECONCILING'] as const) {
      it(`continues ${status}/${billingStatus} reconciliation with a null server poll hint`, async t => {
        let rounds = 0
        const { tracker, clock, calls } = setup(t, async () => {
          const current = job()
          return [{ ...current, executionMode: 'real', saveStatus: 'SAVED',
            trackingStatus: rounds++ === 0 ? 'ACTIVE' : 'STOPPED',
            receipt: { ...current.receipt!, mock: false, status, billingStatus: rounds === 1 ? billingStatus : 'SETTLED', pollAfterMs: null,
              recovery: { canQuery: rounds === 1, canCancel: false, canDownload: false } } }]
        })
        const running = tracker.start()
        await flush()
        assert.deepEqual(calls, [0]); assert.deepEqual(clock.pending, [10, 20_000])
        await clock.advance(9); assert.deepEqual(calls, [0])
        await clock.advance(1); await running
        assert.deepEqual(calls, [0, 10]); assert.deepEqual(clock.pending, [])
      })
    }
  }
  it('honors the slowest sibling hint even above maxDelayMs, without polling early', async t => {
    let first = true
    const { tracker, clock, calls } = setup(t, async () => {
      if (!first) return []
      first = false
      return [job(50), { ...job(4000), jobId: 'job-b' }]
    })
    const running = tracker.start()
    await flush()
    assert.deepEqual(clock.pending, [4000, 20_000])
    await clock.advance(3999)
    assert.deepEqual(calls, [0])
    await clock.advance(1)
    await running
    assert.deepEqual(calls, [0, 4000])
    assert.deepEqual(clock.pending, [])
  })

  it('coalesces start/wake in flight and during sleep without bypassing the floor', async t => {
    let release!: (jobs: LocalVideoJob[]) => void
    let first = true
    const { tracker, clock, calls } = setup(t, async () => {
      if (!first) return []
      first = false
      return new Promise(resolve => { release = resolve })
    })
    const running = tracker.start()
    assert.equal(tracker.start(), running)
    assert.equal(tracker.wake(), running)
    await flush()
    assert.deepEqual(calls, [0])
    release([job(0)])
    await flush()
    assert.equal(tracker.wake(), running)
    assert.deepEqual(clock.pending, [10, 20_000])
    await clock.advance(9)
    assert.deepEqual(calls, [0])
    await clock.advance(1)
    await running
    await tracker.start()
    assert.deepEqual(calls, [0, 10])
  })

  for (const code of ['RATE_LIMITED', 'NETWORK_ERROR'] as const) {
    it(`bounds thrown ${code} exponential backoff and total attempts`, async t => {
      const { tracker, clock, calls } = setup(t, async () => { throw new AppError(code) }, { maxAttempts: 6, maxDelayMs: 25 })
      const running = tracker.start()
      await flush()
      for (const ms of [10, 20, 25, 25, 25]) {
        assert.deepEqual(clock.pending, [ms, 20_000])
        await clock.advance(ms)
      }
      await running
      assert.deepEqual(calls, [0, 10, 30, 55, 80, 105])
      assert.deepEqual(clock.pending, [])
    })

    it(`backs off persisted ${code} jobs without calling explicit resume`, async t => {
      const { tracker, clock, calls } = setup(t, async () => [{ ...job(0), trackingStatus: 'INTERRUPTED', error: code }], { maxAttempts: 4, maxDelayMs: 25 })
      const running = tracker.start()
      await flush()
      await clock.advance(55)
      await running
      assert.deepEqual(calls, [0, 10, 30, 55])
    })
  }

  it('resets backoff after a healthy recovery', async t => {
    let attempt = 0
    const { tracker, clock, calls } = setup(t, async () => {
      attempt++
      if ([1, 2, 4].includes(attempt)) throw new AppError('NETWORK_ERROR')
      return attempt === 3 ? [job(0)] : []
    })
    const running = tracker.start()
    await flush()
    await clock.advance(50)
    await running
    assert.deepEqual(calls, [0, 10, 30, 40, 50])
  })

  it('does not let error backoff shorten a server hint', async t => {
    const { tracker, clock, calls } = setup(t, async () => [{ ...job(4000), error: 'RATE_LIMITED' }], { maxAttempts: 2 })
    const running = tracker.start()
    await flush()
    assert.deepEqual(clock.pending, [4000, 20_000])
    await clock.advance(4000)
    await running
    assert.deepEqual(calls, [0, 4000])
  })

  it('pauses on any AUTH_REQUIRED job until explicit host resume followed by wake', async t => {
    let authorized = false
    let explicitResumes = 0
    const hostPort: VideoTrackerPort = {
      recover: async () => authorized ? [] : [job(), { ...job(), jobId: 'job-b', trackingStatus: 'AUTH_REQUIRED' }],
      resume: async () => { explicitResumes++; authorized = true; return job() },
    }
    const { tracker, clock, calls } = setup(t, hostPort.recover)
    await tracker.start()
    await tracker.start()
    await clock.advance(10_000)
    assert.deepEqual(calls, [0])
    assert.deepEqual(clock.pending, [])
    assert.equal(explicitResumes, 0)
    await hostPort.resume('task-a', 'job-b')
    await tracker.wake()
    assert.equal(explicitResumes, 1)
    assert.deepEqual(calls, [0, 10_000])
  })

  for (const code of ['AUTH_REQUIRED', 'PERMISSION_DENIED'] as const) {
    it(`pauses on thrown ${code} without automatic retries`, async t => {
      const { tracker, clock, calls } = setup(t, async () => { throw new AppError(code) })
      await tracker.start()
      await clock.advance(1000)
      await tracker.start()
      assert.deepEqual(calls, [0])
      assert.deepEqual(clock.pending, [])
    })
  }

  for (const status of ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'] as const) {
    it(`does not loop on terminal ${status}, even with a pending save`, async t => {
      const terminal = job()
      terminal.receipt = { ...terminal.receipt!, status, pollAfterMs: null, recovery: { canQuery: false, canCancel: false, canDownload: false } }
      const { tracker, clock, calls } = setup(t, async () => [terminal])
      await tracker.start()
      await clock.advance(1000)
      assert.deepEqual(calls, [0])
      assert.deepEqual(clock.pending, [])
    })
  }

  it('does not loop for NOT_SENT, STOPPED, unqueryable or hintless jobs', async t => {
    const stopped = { ...job(), trackingStatus: 'STOPPED' as const }
    const notSent = { ...job(), receipt: null, submission: 'NOT_SENT' as const }
    const unqueryable = job()
    unqueryable.receipt!.recovery.canQuery = false
    const hintless = job()
    hintless.receipt!.pollAfterMs = null
    const { tracker, clock, calls } = setup(t, async () => [stopped, notSent, unqueryable, hintless])
    await tracker.start()
    await clock.advance(1000)
    assert.deepEqual(calls, [0])
    assert.deepEqual(clock.pending, [])
  })

  it('recovers MAYBE_SENT without a receipt using the positive floor', async t => {
    let attempt = 0
    const { tracker, clock, calls } = setup(t, async () => ++attempt === 1 ? [{ ...job(), receipt: null, submission: 'MAYBE_SENT' }] : [])
    const running = tracker.start()
    await flush()
    await clock.advance(10)
    await running
    assert.deepEqual(calls, [0, 10])
  })

  for (const hint of [50, 100, 2_147_483_648]) {
    it(`honors hint ${hint} without consuming the active tracking budget`, async t => {
      let polls = 0
      const { tracker, clock, calls } = setup(t, async () => ++polls === 1 ? [job(hint)] : [], { budgetMs: 50 })
      const running = tracker.start()
      await flush()
      await clock.advance(hint - 1)
      assert.deepEqual(calls, [0])
      await clock.advance(1)
      await running
      assert.deepEqual(calls, [0, hint])
      assert.deepEqual(clock.pending, [])
    })
  }

  it('counts in-flight work against budget and aborts it at the deadline', async t => {
    let inFlight: AbortSignal | undefined
    let settled = false
    const { tracker, clock, calls } = setup(t, signal => new Promise((_resolve, reject) => {
      inFlight = signal
      signal!.addEventListener('abort', () => { settled = true; reject(signal!.reason) }, { once: true })
    }), { budgetMs: 50 })
    const running = tracker.start()
    await flush()
    await clock.advance(49)
    assert.equal(inFlight?.aborted, false)
    await clock.advance(1)
    await running
    assert.equal(inFlight?.aborted, true)
    assert.equal(settled, true)
    assert.deepEqual(calls, [0])
    assert.deepEqual(clock.pending, [])
  })

  it('counts recovery work but excludes the advertised interval from its budget', async t => {
    const { tracker, clock, calls } = setup(t, async signal => { await clock.delay(45, signal!); return [job(10)] }, { budgetMs: 50 })
    const running = tracker.start()
    await flush()
    await clock.advance(45)
    await clock.advance(10)
    assert.deepEqual(calls, [0, 55])
    await clock.advance(5)
    await running
    assert.deepEqual(calls, [0, 55])
    assert.deepEqual(clock.pending, [])
  })

  it('aborts sleep, clears timers and permanently prevents start/wake after stop', async t => {
    const { tracker, clock, calls } = setup(t, async () => [job(100)])
    const running = tracker.start()
    await flush()
    assert.deepEqual(clock.pending, [100, 20_000])
    await tracker.stop()
    await running
    await tracker.wake()
    await tracker.start()
    await clock.advance(30_000)
    assert.deepEqual(calls, [0])
    assert.deepEqual(clock.pending, [])
  })

  it('waits for in-flight settlement after abort rather than detaching the operation', async t => {
    let signal: AbortSignal | undefined
    let release!: () => void
    const { tracker, clock, calls } = setup(t, received => {
      signal = received
      return new Promise(resolve => { release = () => resolve([]) })
    })
    const running = tracker.start()
    await flush()
    let stopped = false
    const stopping = tracker.stop().then(() => { stopped = true })
    await flush()
    assert.equal(signal?.aborted, true)
    assert.equal(stopped, false)
    assert.deepEqual(clock.pending, [])
    release()
    await Promise.all([running, stopping])
    assert.equal(stopped, true)
    assert.deepEqual(calls, [0])
  })

  it('can stop before startup without creating any timers or calling recover', async t => {
    const { tracker, clock, calls } = setup(t, async () => [])
    const running = tracker.start()
    await tracker.stop()
    await running
    assert.deepEqual(calls, [])
    assert.deepEqual(clock.pending, [])
  })

  it('propagates nonretryable errors while releasing the deadline timer', async t => {
    const failure = new AppError('INVALID_ARGUMENT')
    const { tracker, clock, calls } = setup(t, async () => { throw failure })
    await assert.rejects(tracker.start(), error => error === failure)
    assert.deepEqual(calls, [0])
    assert.deepEqual(clock.pending, [])
  })

  it('uses an abortable native delay that settles when stopped', async () => {
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    let calls = 0
    const service: VideoTrackerPort = {
      recover: async () => { calls++; entered(); return [job(60_000)] },
      resume: async () => { assert.fail('automatic resume is forbidden') },
    }
    const tracker = new VideoTracker({ service })
    const running = tracker.start()
    await ready
    await flush()
    await tracker.stop()
    await running
    assert.equal(calls, 1)
  })

  it('rejects nonpositive, noninteger, unbounded or inverted configuration', () => {
    const service: VideoTrackerPort = { recover: async () => [], resume: async () => job() }
    for (const key of ['floorMs', 'maxDelayMs', 'maxAttempts', 'budgetMs'] as const) {
      for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => new VideoTracker({ service, [key]: value }), RangeError)
    }
    assert.throws(() => new VideoTracker({ service, floorMs: 30, maxDelayMs: 20 }), RangeError)
    assert.throws(() => new VideoTracker({ service, budgetMs: 2_147_483_648 }), RangeError)
  })
})
