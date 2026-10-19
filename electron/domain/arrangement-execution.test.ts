import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  createArrangementExecutionState,
  interruptArrangement,
  markArrangementNodeCompleted,
  markArrangementNodeFailed,
  markArrangementNodeRunning,
  resumeArrangement,
  retryArrangementNode,
  stopArrangement,
} from './arrangement-execution'
import type { ArrangementNode } from '../domain/arrangement-plan'

const node = (id: string, dependsOn: string[] = []): ArrangementNode => ({
  id, subscriptionId: 'sub-a', modelId: 'model-a', title: id, instruction: id,
  expectedOutput: 'output', dependsOn, skillIds: [], requiresUserConfirmation: false,
})

describe('ArrangementExecutionState', () => {
  it('starts roots ready and releases dependents only after all dependencies complete', () => {
    const plan = [node('a'), node('b'), node('c', ['a', 'b'])]
    let state = createArrangementExecutionState(plan)
    assert.deepEqual(state.nodes.map(item => [item.nodeId, item.status]), [['a', 'ready'], ['b', 'ready'], ['c', 'pending']])
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeCompleted(state, plan, 'a', 'A')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'pending')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'b', 'B')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'ready')
  })

  it('blocks all descendants and waits for a retry or stop after failure', () => {
    const plan = [node('a'), node('b', ['a']), node('c', ['b']), node('independent')]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeFailed(state, plan, 'a', 'boom')
    assert.equal(state.status, 'waiting-user')
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.status, 'blocked')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'blocked')
    assert.equal(state.nodes.find(item => item.nodeId === 'independent')?.status, 'ready')
    const retried = retryArrangementNode(state, plan, 'a')
    assert.equal(retried.status, 'running')
    assert.equal(retried.nodes.find(item => item.nodeId === 'a')?.status, 'ready')
    assert.equal(retried.nodes.find(item => item.nodeId === 'b')?.status, 'pending')
    const stopped = stopArrangement(state)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.nodes.find(item => item.nodeId === 'independent')?.status, 'stopped')
  })

  it('retries all failed nodes without changing completed outputs or attempts', () => {
    const plan = [node('done'), node('a'), node('b'), node('join', ['a', 'b'])]
    let state = createArrangementExecutionState(plan)
    for (const id of ['done', 'a', 'b']) state = markArrangementNodeRunning(state, id)
    state = markArrangementNodeCompleted(state, plan, 'done', 'saved output')
    state = markArrangementNodeFailed(state, plan, 'a', '429')
    state = markArrangementNodeFailed(state, plan, 'b', '429')
    const original = structuredClone(state)
    const retried = retryArrangementNode(state, plan)
    assert.equal(retried.status, 'running')
    assert.deepEqual(retried.failureNodeIds, [])
    assert.deepEqual(retried.nodes.map(item => item.status), ['completed', 'ready', 'ready', 'pending'])
    assert.deepEqual(retried.nodes[0], state.nodes[0])
    assert.deepEqual(retried.nodes.map(item => item.attempt), [1, 1, 1, 0])
    assert.deepEqual(state, original)
  })

  it('keeps shared dependents blocked and waits for remaining failures after a targeted retry', () => {
    const plan = [node('a'), node('b'), node('join', ['a', 'b'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeFailed(state, plan, 'a', 'A failed')
    state = markArrangementNodeFailed(state, plan, 'b', 'B failed')
    state = retryArrangementNode(state, plan, 'a')
    assert.equal(state.nodes.find(item => item.nodeId === 'join')?.status, 'blocked')
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeCompleted(state, plan, 'a', 'A recovered')
    assert.equal(state.status, 'waiting-user')
    assert.deepEqual(state.failureNodeIds, ['b'])
    state = retryArrangementNode(state, plan, 'b')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'b', 'B recovered')
    assert.equal(state.nodes.find(item => item.nodeId === 'join')?.status, 'ready')
  })

  for (const status of ['failed', 'waiting-user'] as const) {
    it(`renews only the selected failed node's validation budget from ${status}`, () => {
      const plan = [node('done'), node('a'), node('b'), node('join', ['a', 'b']), node('independent')]
      const state = createArrangementExecutionState(plan)
      state.status = status
      state.failureNodeIds = ['a', 'b']
      state.nodes = state.nodes.map(item => ({ ...item,
        status: item.nodeId === 'done' ? 'completed' : ['a', 'b'].includes(item.nodeId) ? 'failed' : 'blocked',
        attempt: item.nodeId === 'done' ? 1 : 2,
        sessionRunId: `session-${item.nodeId}`,
        delivery: { validationAttempts: 5, issues: [{ code: 'INVALID_SUBMISSION', message: 'invalid JSON' }], finalFiles: [] },
        modelRequestProgress: { executionRounds: 17, requestAttempts: 26, executionRetries: 0, compactionAttempts: 9 },
      }))
      const original = structuredClone(state)
      const retried = retryArrangementNode(state, plan, 'a')
      assert.equal(retried.status, 'running')
      assert.equal(retried.nodes[1]?.status, 'ready')
      assert.equal(retried.nodes[1]?.delivery?.validationAttempts, 0)
      assert.deepEqual(retried.nodes[1]?.delivery?.issues, state.nodes[1]?.delivery?.issues)
      assert.equal(retried.nodes[1]?.sessionRunId, 'session-a')
      assert.deepEqual(retried.nodes[1]?.modelRequestProgress, state.nodes[1]?.modelRequestProgress)
      assert.equal(retried.nodes[1]?.attempt, 2)
      assert.deepEqual(retried.nodes[0], state.nodes[0])
      assert.deepEqual(retried.nodes[2], state.nodes[2])
      assert.equal(retried.nodes[3]?.status, 'blocked')
      assert.equal(retried.nodes[4]?.status, status === 'failed' ? 'ready' : 'blocked')
      assert.deepEqual(retried.failureNodeIds, ['b'])
      assert.deepEqual(state, original)
    })
  }

  it('releases terminally blocked independent branches according to their dependencies', () => {
    const plan = [node('a'), node('b', ['a']), node('independent'), node('later', ['independent'])]
    const state = createArrangementExecutionState(plan)
    state.status = 'failed'
    state.failureNodeIds = ['a']
    state.nodes[0]!.status = 'failed'
    for (const item of state.nodes.slice(1)) item.status = 'blocked'
    const retried = retryArrangementNode(state, plan)
    assert.deepEqual(retried.nodes.map(item => item.status), ['ready', 'pending', 'ready', 'pending'])
  })

  it('does not retry completed, stopped, active, interrupted, or non-failed nodes', () => {
    const plan = [node('a')]
    const state = createArrangementExecutionState(plan)
    state.nodes[0]!.status = 'failed'
    for (const status of ['completed', 'stopped', 'running', 'interrupted', 'queued'] as const) {
      state.status = status
      assert.equal(retryArrangementNode(state, plan), state)
    }
    state.status = 'failed'
    assert.equal(retryArrangementNode(state, plan, 'missing'), state)
    state.nodes[0]!.status = 'completed'
    assert.equal(retryArrangementNode(state, plan), state)
  })

  it('does not lose waiting-user status when another node in the same batch succeeds', () => {
    const plan = [node('a'), node('b')]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeFailed(state, plan, 'a', '429')
    state = markArrangementNodeCompleted(state, plan, 'b', 'B complete')
    assert.equal(state.status, 'waiting-user')
  })

  it('marks running nodes interrupted and resumes only those nodes', () => {
    const plan = [node('a'), node('b')]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = interruptArrangement(state, 'client-crash')
    assert.equal(state.status, 'interrupted')
    assert.equal(state.nodes.find(item => item.nodeId === 'a')?.status, 'interrupted')
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.status, 'ready')
    const resumed = resumeArrangement(state)
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.nodes.find(item => item.nodeId === 'a')?.status, 'ready')
  })
})

