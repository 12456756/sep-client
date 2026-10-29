import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  createArrangementExecutionState,
  confirmArrangementNode,
  interruptArrangement,
  markArrangementNodeCompleted,
  markArrangementNodeFailed,
  markArrangementNodeRunning,
  markArrangementNodeWaitingForInput,
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
  it('waits for a matching reply without failing or completing the node, then resumes only the affected branch', () => {
    const plan = [node('done'), node('video', ['done']), node('dependent', ['video'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'done')
    state = markArrangementNodeCompleted(state, plan, 'done', 'Saved original image')
    state = markArrangementNodeRunning(state, 'video')
    const inputRequest = { requestId: 'request', kind: 'media-spec' as const, question: '需要多长的视频？', requirements: [{ id: 'video', specRevision: 2 }] }
    state = markArrangementNodeWaitingForInput(state, plan, 'video', inputRequest)
    assert.equal(state.status, 'waiting-user')
    assert.equal(state.nodes[1]!.status, 'interrupted')
    assert.equal(state.nodes[1]!.error, null)
    assert.deepEqual(state.failureNodeIds, [])
    assert.equal(retryArrangementNode(state, plan, 'video'), state)
    assert.equal(retryArrangementNode(state, plan, 'video', { requestId: 'old', text: '8 秒' }), state)
    const resumed = retryArrangementNode(state, plan, 'video', { requestId: 'request', text: '8 秒，竖屏' })
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.nodes[1]!.status, 'ready')
    assert.equal(resumed.nodes[1]!.inputRequest, undefined)
    assert.equal(resumed.nodes[1]!.inputReply?.text, '8 秒，竖屏')
    assert.equal(resumed.nodes[1]!.mediaSpecRevisions?.video, 3)
    assert.deepEqual(resumed.nodes[0], state.nodes[0])
    assert.equal(resumed.nodes[2]!.status, 'pending')
    assert.deepEqual(resumed.nodes[1]!.delivery, state.nodes[1]!.delivery)
  })
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
    assert.equal(state.status, 'running')
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
      assert.equal(retried.nodes[4]?.status, 'blocked')
      assert.deepEqual(retried.failureNodeIds, ['b'])
      assert.deepEqual(state, original)
    })
  }

  it('does not release unrelated blocked branches during a targeted retry', () => {
    const plan = [node('a'), node('b', ['a']), node('independent'), node('later', ['independent'])]
    const state = createArrangementExecutionState(plan)
    state.status = 'failed'
    state.failureNodeIds = ['a']
    state.nodes[0]!.status = 'failed'
    for (const item of state.nodes.slice(1)) item.status = 'blocked'
    const retried = retryArrangementNode(state, plan, 'a')
    assert.deepEqual(retried.nodes.map(item => item.status), ['ready', 'pending', 'blocked', 'blocked'])
  })

  it('allows a targeted retry while an independent node runs without changing that node', () => {
    const plan = [node('a'), node('b'), node('child', ['a']), node('join', ['a', 'b'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeFailed(state, plan, 'a', 'failed')
    assert.equal(state.status, 'running')
    const b = structuredClone(state.nodes[1])
    assert.equal(retryArrangementNode(state, plan), state)
    state = retryArrangementNode(state, plan, 'a')
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeCompleted(state, plan, 'a', 'recovered')
    assert.deepEqual(state.nodes[1], b)
    assert.equal(state.nodes[2]?.status, 'ready')
    assert.equal(state.nodes[3]?.status, 'pending')
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

  it('holds confirmed nodes and releases dependents only after explicit confirmation', () => {
    const plan = [node('a'), { ...node('b', ['a']), requiresUserConfirmation: true }, node('c', ['b'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeCompleted(state, plan, 'a', 'A')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'b', 'B')
    assert.equal(state.status, 'waiting-user')
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.pendingConfirmation, true)
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'pending')
    const confirmed = confirmArrangementNode(state, plan, 'b')
    assert.equal(confirmed.nodes.find(item => item.nodeId === 'b')?.pendingConfirmation, false)
    assert.equal(confirmed.nodes.find(item => item.nodeId === 'c')?.status, 'ready')
    assert.equal(confirmArrangementNode(confirmed, plan, 'b'), confirmed)
    assert.equal(confirmArrangementNode(state, plan, 'missing'), state)
  })

  it('keeps independent nodes runnable while a completed node awaits confirmation', () => {
    const plan = [{ ...node('a'), requiresUserConfirmation: true }, node('b'), node('c', ['a'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeCompleted(state, plan, 'a')
    assert.equal(state.status, 'running')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'b')
    assert.equal(state.status, 'waiting-user')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'pending')
  })

  it('retries only a failed peer without confirming another node or releasing its children', () => {
    const plan = [{ ...node('a'), requiresUserConfirmation: true }, node('b'), node('c', ['a', 'b'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'a')
    state = markArrangementNodeFailed(state, plan, 'b', 'failure')
    assert.equal(retryArrangementNode(state, plan), state)
    state = retryArrangementNode(state, plan, 'b')
    assert.equal(state.nodes.find(item => item.nodeId === 'a')?.pendingConfirmation, true)
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.status, 'ready')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'pending')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'b')
    assert.equal(state.status, 'waiting-user')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'pending')
  })

  it('runs confirmed dependents even when an independent node remains failed', () => {
    const plan = [{ ...node('a'), requiresUserConfirmation: true }, node('b'), node('c', ['a'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'a')
    state = markArrangementNodeFailed(state, plan, 'b', 'failure')
    state = confirmArrangementNode(state, plan, 'a')
    assert.equal(state.status, 'running')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'ready')
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.status, 'failed')
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

  it('does not resume past a pending confirmation', () => {
    const plan = [{ ...node('a'), requiresUserConfirmation: true }]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeCompleted(state, plan, 'a', 'done')
    state = interruptArrangement(state, 'client-crash')
    assert.equal(resumeArrangement(state).status, 'waiting-user')
  })

  it('keeps a parallel media question waiting after confirming completed work', () => {
    const plan = [{ ...node('review'), requiresUserConfirmation: true }, node('media')]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'review')
    state = markArrangementNodeRunning(state, 'media')
    state = markArrangementNodeWaitingForInput(state, plan, 'media', { requestId: 'question', kind: 'media-spec', question: '视频多长？', requirements: [] })
    state = markArrangementNodeCompleted(state, plan, 'review', 'done')
    const question = structuredClone(state.nodes[1])
    state = confirmArrangementNode(state, plan, 'review')
    assert.equal(state.status, 'waiting-user')
    assert.equal(state.nodes[0]?.pendingConfirmation, false)
    assert.deepEqual(state.nodes[1], question)
  })

  it('resumes only interrupted peers while retaining unanswered questions and stopped evidence', () => {
    const plan = [node('media'), node('peer')]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'media')
    state = markArrangementNodeRunning(state, 'peer')
    state = markArrangementNodeWaitingForInput(state, plan, 'media', { requestId: 'question', kind: 'media-spec', question: '视频多长？', requirements: [] })
    const question = structuredClone(state.nodes[0])
    const resumed = resumeArrangement(interruptArrangement(state, 'client-crash'))
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.nodes[1]?.status, 'ready')
    assert.deepEqual(resumed.nodes[0], question)
    state = markArrangementNodeCompleted(state, plan, 'peer', 'done')
    const waiting = resumeArrangement(interruptArrangement(state, 'client-exit'))
    assert.equal(waiting.status, 'waiting-user')
    assert.deepEqual(waiting.nodes[0], question)
    const stopped = stopArrangement(waiting)
    assert.deepEqual(stopped.nodes[0]?.inputRequest, question?.inputRequest)
    assert.equal(resumeArrangement(stopped), stopped)
  })

  it('resumes an interrupted independent peer without approving a completed node', () => {
    const plan = [{ ...node('a'), requiresUserConfirmation: true }, node('b'), node('c', ['a'])]
    let state = createArrangementExecutionState(plan)
    state = markArrangementNodeRunning(state, 'a')
    state = markArrangementNodeRunning(state, 'b')
    state = markArrangementNodeCompleted(state, plan, 'a')
    state = resumeArrangement(interruptArrangement(state, 'client-crash'))
    assert.equal(state.status, 'running')
    assert.equal(state.nodes.find(item => item.nodeId === 'a')?.pendingConfirmation, true)
    assert.equal(state.nodes.find(item => item.nodeId === 'b')?.status, 'ready')
    assert.equal(state.nodes.find(item => item.nodeId === 'c')?.status, 'pending')
  })
})

