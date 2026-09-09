import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  createWorkflowRunnerState,
  interruptWorkflow,
  markNodeCompleted,
  markNodeFailed,
  markNodeRunning,
  resumeInterrupted,
  retryFailedNode,
  stopWorkflow,
} from './workflow-runner'
import type { ArrangementNode } from '../domain/arrangement-plan'

const node = (id: string, dependsOn: string[] = []): ArrangementNode => ({
  id, subscriptionId: 'sub-a', modelId: 'model-a', title: id, instruction: id,
  expectedOutput: 'output', dependsOn, skillIds: [], requiresUserConfirmation: false,
})

describe('WorkflowRunnerState', () => {
  it('starts roots ready and releases dependents only after all dependencies complete', () => {
    const plan = [node('a'), node('b'), node('c', ['a', 'b'])]
    let state = createWorkflowRunnerState(plan)
    assert.deepEqual(state.nodes.map(item => [item.nodeId, item.status]), [['a', 'ready'], ['b', 'ready'], ['c', 'pending']])
    state = markNodeRunning(state, 'a')
    state = markNodeCompleted(state, plan, 'a', 'A')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'pending')
    state = markNodeRunning(state, 'b')
    state = markNodeCompleted(state, plan, 'b', 'B')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'ready')
  })

  it('blocks all descendants and waits for a retry or stop after failure', () => {
    const plan = [node('a'), node('b', ['a']), node('c', ['b']), node('independent')]
    let state = createWorkflowRunnerState(plan)
    state = markNodeRunning(state, 'a')
    state = markNodeFailed(state, plan, 'a', 'boom')
    assert.equal(state.status, 'waiting-user')
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.status, 'blocked')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'blocked')
    assert.equal(state.nodes.find(item => item.nodeId === 'independent')?.status, 'ready')
    const retried = retryFailedNode(state, plan, 'a')
    assert.equal(retried.status, 'running')
    assert.equal(retried.nodes.find(item => item.nodeId === 'a')?.status, 'ready')
    assert.equal(retried.nodes.find(item => item.nodeId === 'b')?.status, 'pending')
    const stopped = stopWorkflow(state)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.nodes.find(item => item.nodeId === 'independent')?.status, 'stopped')
  })

  it('marks running nodes interrupted and resumes only those nodes', () => {
    const plan = [node('a'), node('b')]
    let state = createWorkflowRunnerState(plan)
    state = markNodeRunning(state, 'a')
    state = interruptWorkflow(state, 'client-crash')
    assert.equal(state.status, 'interrupted')
    assert.equal(state.nodes.find(item => item.nodeId === 'a')?.status, 'interrupted')
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.status, 'ready')
    const resumed = resumeInterrupted(state)
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.nodes.find(item => item.nodeId === 'a')?.status, 'ready')
  })
})
