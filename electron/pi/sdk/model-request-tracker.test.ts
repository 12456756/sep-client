import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { advanceModelRequestProgress, type ModelRequestKind, type ModelRequestProgress } from '../../domain/model-request-progress'
import { ModelRequestTracker, buildModelRequestAwareness } from './model-request-tracker'

function fixture() {
  const kinds: ModelRequestKind[] = []
  let progress: ModelRequestProgress | undefined
  const tracker = new ModelRequestTracker(async kind => {
    kinds.push(kind)
    progress = advanceModelRequestProgress(progress, kind)
    return progress
  })
  return { tracker, kinds }
}

describe('model request tracker', () => {
  it('consumes retry markers once and counts tool continuations and corrections as new rounds', async () => {
    const { tracker, kinds } = fixture()
    assert.equal((await tracker.prepare()).progress.executionRounds, 1)
    tracker.observe({ type: 'auto_retry_start' })
    assert.equal((await tracker.prepare()).progress.executionRounds, 1)
    tracker.observe({ type: 'auto_retry_end' })
    assert.equal((await tracker.prepare()).progress.executionRounds, 2)
    assert.equal((await tracker.prepare()).progress.executionRounds, 3)
    assert.deepEqual(kinds, ['execution', 'retry', 'execution', 'execution'])
  })

  it('isolates compaction retries and reuses the failed round only for overflow recovery', async () => {
    const { tracker, kinds } = fixture()
    await tracker.prepare()
    tracker.observe({ type: 'compaction_start', reason: 'overflow' })
    await tracker.prepare()
    tracker.observe({ type: 'summarization_retry_scheduled' })
    await tracker.prepare()
    tracker.observe({ type: 'compaction_end', reason: 'overflow', willRetry: true, aborted: false })
    assert.equal((await tracker.prepare()).progress.executionRounds, 1)
    assert.equal((await tracker.prepare()).progress.executionRounds, 2)
    tracker.observe({ type: 'compaction_start', reason: 'threshold' })
    await tracker.prepare()
    tracker.observe({ type: 'compaction_end', reason: 'threshold', willRetry: true })
    assert.equal((await tracker.prepare()).progress.executionRounds, 3)
    assert.deepEqual(kinds, ['execution', 'compaction', 'compaction', 'recovery', 'execution', 'compaction', 'execution'])
  })

  it('does not reuse aborted recovery or cancelled retries in a later prompt', async () => {
    const { tracker, kinds } = fixture()
    await tracker.prepare()
    tracker.observe({ type: 'compaction_start', reason: 'overflow' })
    tracker.observe({ type: 'compaction_end', reason: 'overflow', willRetry: false, aborted: true })
    await tracker.prepare()
    tracker.observe({ type: 'auto_retry_start' })
    tracker.observe({ type: 'auto_retry_end' })
    await tracker.prepare()
    assert.deepEqual(kinds, ['execution', 'execution', 'execution'])
  })

  it('awaits persistence, stops on storage failure and honors cancellation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tracker = new ModelRequestTracker(async () => { await gate; return advanceModelRequestProgress(undefined, 'execution') })
    let ready = false
    const pending = tracker.prepare().then(() => { ready = true })
    await Promise.resolve()
    assert.equal(ready, false)
    release()
    await pending
    assert.equal(ready, true)
    let calls = 0
    const broken = new ModelRequestTracker(async () => { calls++; throw new Error('disk full') })
    await assert.rejects(broken.prepare(), /计数保存失败/)
    await assert.rejects(broken.prepare(), /计数保存失败/)
    assert.equal(calls, 1)
    assert.ok(broken.failure)
    const { tracker: cancelled, kinds } = fixture()
    await assert.rejects(cancelled.prepare(AbortSignal.abort()), { name: 'AbortError' })
    assert.deepEqual(kinds, [])
  })

  it('keeps cancelled persistence from creating a usable request snapshot', async () => {
    const controller = new AbortController()
    const tracker = new ModelRequestTracker(async () => {
      controller.abort()
      return advanceModelRequestProgress(undefined, 'execution')
    })
    await assert.rejects(tracker.prepare(controller.signal), { name: 'AbortError' })
    assert.equal(tracker.failure, null)
  })

  it('renders awareness without budgets or relaxed quality requirements', () => {
    const text = buildModelRequestAwareness({ executionRounds: 18, requestAttempts: 21, executionRetries: 2, compactionAttempts: 1 }, 'execution')
    assert.match(text, /第 18 次/)
    assert.match(text, /不代表剩余预算/)
    assert.match(text, /不得因为请求次数增加/)
    assert.match(text, /skill/)
    assert.match(text, /全部工作完成/)
    assert.match(buildModelRequestAwareness({ executionRounds: 18, requestAttempts: 21, executionRetries: 2, compactionAttempts: 1 }, 'retry'), /网关自动重试/)
    assert.match(buildModelRequestAwareness({ executionRounds: 18, requestAttempts: 21, executionRetries: 2, compactionAttempts: 1 }, 'recovery'), /上下文恢复/)
  })

  it('clears transient request kinds for a new prompt, without resetting cumulative state', async () => {
    const { tracker, kinds } = fixture()
    await tracker.prepare()
    tracker.observe({ type: 'auto_retry_start' })
    tracker.startPrompt()
    assert.equal((await tracker.prepare()).progress.executionRounds, 2)
    tracker.observe({ type: 'compaction_start', reason: 'overflow' })
    tracker.observe({ type: 'auto_retry_start' })
    tracker.startPrompt()
    assert.equal((await tracker.prepare()).progress.executionRounds, 3)
    assert.deepEqual(kinds, ['execution', 'execution', 'execution'])
  })

  it('rejects invalid host snapshots instead of sending an incorrect round', async () => {
    const tracker = new ModelRequestTracker(async () => ({ executionRounds: 1, requestAttempts: 0, executionRetries: 0, compactionAttempts: 0 }))
    await assert.rejects(tracker.prepare(), /计数保存失败/)
    assert.ok(tracker.failure)
  })

  for (const priorRounds of [0, 2]) {
    it(`counts the first execution after preflight overflow compaction as new with ${priorRounds} prior rounds`, async () => {
      const { tracker, kinds } = fixture()
      for (let round = 0; round < priorRounds; round++) await tracker.prepare()
      tracker.startPrompt()
      tracker.observe({ type: 'compaction_start', reason: 'overflow' })
      await tracker.prepare()
      tracker.observe({ type: 'compaction_end', reason: 'overflow', willRetry: true, aborted: false })
      const snapshot = await tracker.prepare()
      assert.equal(snapshot.kind, 'execution')
      assert.equal(snapshot.progress.executionRounds, priorRounds + 1)
      assert.deepEqual(kinds.slice(-2), ['compaction', 'execution'])
      tracker.observe({ type: 'compaction_start', reason: 'overflow' })
      await tracker.prepare()
      tracker.observe({ type: 'compaction_end', reason: 'overflow', willRetry: true, aborted: false })
      assert.equal((await tracker.prepare()).kind, 'recovery')
    })
  }

  it('explains missing historical counts without implying a fresh node or a reset on later resumes', () => {
    let progress = advanceModelRequestProgress(undefined, 'execution', 'since-resume')
    const text = buildModelRequestAwareness(progress, 'execution')
    assert.match(text, /自恢复统计起点以来第 1 次/)
    assert.match(text, /此前执行次数未记录/)
    assert.match(text, /后续恢复继续累计/)
    assert.match(text, /已有工作和历史结果仍然有效/)
    assert.doesNotMatch(text, /当前是本节点第 1 次/)
    progress = advanceModelRequestProgress(progress, 'execution')
    assert.match(buildModelRequestAwareness(progress, 'execution'), /自恢复统计起点以来第 2 次/)
  })
})
