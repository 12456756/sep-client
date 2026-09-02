import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { TaskStatus } from '../../src/shared/types'
import {
  assertTaskTransition,
  canTransitionTask,
  InvalidTaskTransitionError,
} from './task-state-machine'

describe('task state machine', () => {
  it('allows the conversation lifecycle and retry transitions', () => {
    assert.equal(canTransitionTask(TaskStatus.PENDING, TaskStatus.RUNNING), true)
    assert.equal(canTransitionTask(TaskStatus.RUNNING, TaskStatus.WAITING_APPROVAL), true)
    assert.equal(canTransitionTask(TaskStatus.WAITING_APPROVAL, TaskStatus.RUNNING), true)
    assert.equal(canTransitionTask(TaskStatus.RUNNING, TaskStatus.COMPLETED), true)
    assert.equal(canTransitionTask(TaskStatus.COMPLETED, TaskStatus.PENDING), true)
    assert.equal(canTransitionTask(TaskStatus.FAILED, TaskStatus.PENDING), true)
  })

  it('rejects skipping an execution state', () => {
    assert.throws(
      () => assertTaskTransition(TaskStatus.PENDING, TaskStatus.COMPLETED),
      InvalidTaskTransitionError,
    )
  })
})
