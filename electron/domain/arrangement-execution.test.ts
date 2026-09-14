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

