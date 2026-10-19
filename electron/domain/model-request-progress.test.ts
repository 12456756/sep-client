import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { advanceModelRequestProgress, modelRequestProgressSchema } from './model-request-progress'

describe('node model request progress', () => {
  it('counts execution, retries, overflow recovery and compaction independently', () => {
    let progress = advanceModelRequestProgress(undefined, 'execution')
    progress = advanceModelRequestProgress(progress, 'retry')
    progress = advanceModelRequestProgress(progress, 'compaction')
    progress = advanceModelRequestProgress(progress, 'compaction')
    progress = advanceModelRequestProgress(progress, 'recovery')
    const previous = structuredClone(progress)
    assert.deepEqual(advanceModelRequestProgress(progress, 'execution'), {
      executionRounds: 2, requestAttempts: 6, executionRetries: 2, compactionAttempts: 2,
    })
    assert.deepEqual(progress, previous)
  })

  it('does not impose an execution budget and accepts compaction before the first execution', () => {
    const progress = { executionRounds: 10_000, requestAttempts: 10_000, executionRetries: 0, compactionAttempts: 0 }
    assert.equal(advanceModelRequestProgress(progress, 'execution').executionRounds, 10_001)
    assert.deepEqual(advanceModelRequestProgress(undefined, 'compaction'), {
      executionRounds: 0, requestAttempts: 1, executionRetries: 0, compactionAttempts: 1,
    })
  })

  it('rejects corrupt counters and retries without an execution round', () => {
    const progress = advanceModelRequestProgress(undefined, 'execution')
    for (const patch of [{ executionRounds: -1 }, { executionRounds: 1.5 }, { requestAttempts: 0 },
      { requestAttempts: Number.MAX_SAFE_INTEGER + 1 }, { executionRetries: 1 }, { extra: true }]) {
      assert.equal(modelRequestProgressSchema.safeParse({ ...progress, ...patch }).success, false)
    }
    assert.throws(() => advanceModelRequestProgress(undefined, 'retry'))
    assert.throws(() => advanceModelRequestProgress(undefined, 'recovery'))
    assert.throws(() => advanceModelRequestProgress({ ...progress, executionRounds: -1 }, 'execution'))
  })

  it('preserves a legacy recovery counting scope through compaction, retries and later resumes', () => {
    let progress = advanceModelRequestProgress(undefined, 'compaction', 'since-resume')
    assert.equal(progress.countingScope, 'since-resume')
    progress = advanceModelRequestProgress(progress, 'execution')
    progress = advanceModelRequestProgress(progress, 'retry')
    progress = advanceModelRequestProgress(progress, 'execution')
    assert.deepEqual(progress, { executionRounds: 2, requestAttempts: 4, executionRetries: 1, compactionAttempts: 1, countingScope: 'since-resume' })
    const complete = advanceModelRequestProgress(undefined, 'execution')
    assert.deepEqual(advanceModelRequestProgress(complete, 'execution', 'since-resume'), {
      executionRounds: 2, requestAttempts: 2, executionRetries: 0, compactionAttempts: 0,
    })
    assert.equal(modelRequestProgressSchema.safeParse({ ...progress, countingScope: 'unknown' }).success, false)
  })
})
