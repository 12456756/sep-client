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

