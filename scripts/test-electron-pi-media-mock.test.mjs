import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openWorkRecord, verifyCleanClose, verifyPersistedJobIdentity, verifyPiTimeline, verifyShutdownMarker } from './test-electron-pi-media-mock.mjs'

const context = { taskId: 'task-a', runId: 'run-a', subscriptionId: 'sub-a', scenario: 'SYNC',
  skillPath: '/approved/SKILL.md', referenceId: 'ref-a', jobId: 'job-a' }

function timeline() {
  const event = (sequence, occurredAt, type, data) => ({ taskId: context.taskId, runId: context.runId,
    subscriptionId: context.subscriptionId, sequence, occurredAt, type, data })
  const start = (seq, time, name, input) => event(seq, time, 'tool_execution_start', { toolName: name, toolId: name, input })
  const end = (seq, time, name) => event(seq, time, 'tool_execution_end', { toolName: name, toolId: name, success: true })
  const request = (seq, time, id, operation) => event(seq, time, 'approval_requested', {
    requestId: id, toolName: 'media_generate_image', input: { operation, referenceCount: 1 } })
  const decision = (seq, time, id) => event(seq, time, 'approval_resolved', {
    requestId: id, toolName: 'media_generate_image', approved: true })
  return [
    start(1, 1, 'read', { path: context.skillPath }), end(2, 2, 'read'),
    request(3, 7, 'upload', 'upload-references'),
    start(4, 3, 'media_get_capabilities', {}), end(5, 4, 'media_get_capabilities'),
    start(8, 6, 'media_generate_image', { profileId: 'mock-sync', operation: 'edit', localAssetIds: ['ref-a'],
      parameters: { aspectRatio: '1:1', count: 1, size: '1x1' } }),
    decision(9, 8, 'upload'), request(10, 9, 'generation', 'edit'), decision(11, 10, 'generation'),
    end(13, 11, 'media_generate_image'), start(15, 12, 'media_get_job', { jobId: 'job-a' }),
    end(16, 13, 'media_get_job'), event(17, 14, 'text_delta', { text: 'mock complete' }),
    event(18, 15, 'agent_end', { willRetry: false }),
  ]
}

test('accepts buffered worker persistence without losing the real approval boundary', () => {
  assert.equal(verifyPiTimeline(timeline(), context).approvals.length, 2)
})

test('rejects approval requested before generation actually starts', () => {
  const events = timeline()
  events[2].occurredAt = 5
  assert.throws(() => verifyPiTimeline(events, context), /APPROVAL_TOOL_ORDER/)
})

test('rejects an approval resolution after generation completes', () => {
  const events = timeline()
  events.find(event => event.sequence === 11).occurredAt = 12
  assert.throws(() => verifyPiTimeline(events, context), /APPROVAL_TOOL_ORDER/)
})

test('rejects missing or invalid timestamps instead of weakening temporal checks', () => {
  const events = timeline()
  delete events[2].occurredAt
  assert.throws(() => verifyPiTimeline(events, context), /TIMELINE_TIMESTAMP/)
})

test('accepts normal exit even if Playwright reports its target was already closed', () => {
  assert.equal(verifyCleanClose(undefined, 0, null).automationTargetClosed, false)
  assert.equal(verifyCleanClose(new Error('Target page, context or browser has been closed'), 0, null).automationTargetClosed, true)
})

test('never treats forced, unfinished or failed exits as clean', () => {
  for (const [code, signal] of [[null, 'SIGKILL'], [null, null], [1, null], [0, 'SIGTERM']]) {
    assert.throws(() => verifyCleanClose(undefined, code, signal), /PROCESS_EXIT_NOT_CLEAN/)
  }
})

test('does not hide an unrelated automation failure even after exit zero', () => {
  assert.throws(() => verifyCleanClose(new Error('unrelated failure'), 0, null), /AUTOMATION_CLOSE_FAILED/)
})

test('requires completion evidence from the exact closing process, not a previous launch', () => {
  assert.deepEqual(verifyShutdownMarker({ completed: true, shutdownId: 'current' }, 'current'), { cleanupCompleted: true })
  for (const value of [undefined, {}, { completed: false, shutdownId: 'current' }, { completed: true, shutdownId: 'old' }]) {
    assert.throws(() => verifyShutdownMarker(value, 'current'), /PROCESS_CLEANUP_NOT_VERIFIED/)
  }
})

test('checks original receipt, request and frozen configuration in the persisted job', () => {
  const task = { id: 'task-a', subscriptionId: 'sub-a', ownerId: 'user-a', ownerEnterpriseId: 'enterprise-a' }
  const job = { owner: { memberId: 'user-a', enterpriseId: 'enterprise-a' }, taskId: task.id,
    subscriptionId: task.subscriptionId, jobId: 'job-a', runId: 'run-a', submission: 'RECEIPTED',
    receiptId: 'receipt-a', clientRequestId: 'request-a', requestHash: 'a'.repeat(64),
    profile: { configVersion: 'config-a' },
    request: { clientRequestId: 'request-a', requestHash: 'a'.repeat(64), configVersion: 'config-a' } }
  const result = verifyPersistedJobIdentity(job, task, 'job-a', 'run-a')
  assert.equal(result.receiptId, 'receipt-a')
  assert.equal(result.configVersion, 'config-a')
  assert.match(result.frozenProfileSha256, /^[a-f0-9]{64}$/)
  for (const changed of [{ ...job, receiptId: null }, { ...job, runId: 'new-run' },
    { ...job, request: { ...job.request, clientRequestId: 'new-request' } },
    { ...job, profile: { configVersion: 'new-config' } }]) {
    assert.throws(() => verifyPersistedJobIdentity(changed, task, 'job-a', 'run-a'), /PERSISTED_(JOB|RECEIPT)_IDENTITY/)
  }
})

test('clears status, type and search filters before opening a recovered work record', async () => {
  const actions = []
  const page = {
    getByRole(role, options) {
      if (role === 'group') return { getByRole(childRole, childOptions) {
        assert.equal(childRole, 'button')
        assert.ok(childOptions.name.test('全部 3'))
        return { async click() { actions.push(options.name) } }
      } }
      if (role === 'searchbox') return { async fill(value) { assert.equal(value, ''); actions.push(options.name) } }
      return {
        async click() { actions.push(options.name) },
        async waitFor() { actions.push(options.name) },
      }
    },
    getByText(title) { return { first() { return { async click() { actions.push(title) } } } } },
  }
  await openWorkRecord(page, 'recovered task')
  assert.deepEqual(actions, ['工作记录', '按状态筛选工作记录', '按类型筛选工作记录', '搜索工作记录',
    'recovered task', '图片创作与成果'])
})
