import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ScheduledOccurrence } from '../../shared/scheduled-tasks'
import type { ArrangementExecutionSnapshot, TaskExecutionEvent } from '../../shared/types'
import { assessScheduledRun, scheduledDeliveryRunId } from './scheduled-assessment'
import { scheduledAttachmentEvidence, selectScheduledDeliveryEvent } from './scheduled-delivery-evidence'

const run: ScheduledOccurrence = {
  id: 'run', definitionId: 'definition', taskId: 'task', revision: 1,
  input: { name: 'Daily report', goal: 'Generate a report and email a@example.com', subscriptionId: 'sub', modelId: 'model',
    workDir: 'D:/reports', scheduledAt: 1, timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } },
  plan: { status: 'ready', objective: 'Report', instruction: 'Create report', expectedOutput: 'Report', deliverables: [], assessmentItems: [
    { kind: 'file', title: 'Report file', source: 'Generate a report', deliverableId: 'report' },
    { kind: 'external', title: 'Email recipient', source: 'email a@example.com', tool: 'qqmail_execute', target: 'a@example.com' },
  ] },
  status: 'completed', scheduledAt: 1, firstEligibleAt: 1, startDeadline: 10, startedAt: 1, finishedAt: 2,
  nextRetryAt: null, stopReason: null, error: null, attempts: [], operations: [
    { key: 'a'.repeat(64), tool: 'qqmail_execute', target: 'b@example.com', status: 'succeeded', receipt: 'receipt-for-another-target' },
    { key: 'b'.repeat(64), tool: 'qqmail_execute', target: 'a@example.com', status: 'succeeded' },
    { key: 'c'.repeat(64), tool: 'dingtalk_execute', status: 'not-executed', dingTalkAction: 'aitable psql' },
  ],
}
const execution: ArrangementExecutionSnapshot = { activeRunId: null, status: 'completed', updatedAt: 2, nodes: [
  { nodeId: 'employee-work', status: 'completed', finalFiles: [{ id: 'report', path: 'report.md', format: 'md', size: 10, sha256: 'a'.repeat(64), nodeRunId: 'node-run', validatedAt: 2 }] },
] }

test('assessment only reads finished runs and never changes their status or evidence', () => {
  const before = structuredClone(run)
  assert.deepEqual(assessScheduledRun({ ...run, status: 'running' }, execution), [])
  assert.deepEqual(assessScheduledRun(run, execution).map(row => row.label), ['已核验', '待核验'])
  assert.match(assessScheduledRun(run, execution)[1].detail, /回执/)
  assert.deepEqual(assessScheduledRun({ ...run, status: 'failed' }, execution), assessScheduledRun(run, execution))
  assert.deepEqual(run, before)
})

test('a receipt must match the target; file content and sent attachment are separate evidence', () => {
  const exact = structuredClone(run)
  exact.operations![1].receipt = 'receipt-for-exact-target'
  assert.deepEqual(assessScheduledRun(exact, execution).map(row => row.label), ['已核验', '已核验'])
  exact.plan.assessmentItems = exact.plan.assessmentItems!.map(item => item.kind === 'file'
    ? { ...item, contentCheck: 'Contains the daily statistics' } : { ...item, includesFile: true })
  assert.deepEqual(assessScheduledRun(exact, execution).map(row => row.label), ['文件已验收', '待核验'])
  exact.operations![1].status = 'unknown'
  assert.match(assessScheduledRun(exact, execution)[1].detail, /尚未确认/)
})

test('missing evidence and unplanned legacy runs do not imply success', () => {
  assert.equal(assessScheduledRun(run)[0].label, '待核验')
  assert.deepEqual(assessScheduledRun({ ...run, plan: { ...run.plan, assessmentItems: undefined } }, execution), [])
})

function dwsAttachmentEvents({ statusId = 'send-id', sendStatus = 'SUCCESS', recipient = 'person-id', path = 'report.md',
  contacts = [{ name: '张三', openDingTalkId: 'person-id' }], sizeBytes = 10, statusRun = 'node-run' } = {}) {
  const event = (sequence: number, type: string, data: unknown, runId = 'node-run'): TaskExecutionEvent => ({
    sequence, type, data, runId, taskId: 'task', subscriptionId: 'sub', occurredAt: sequence,
  })
  const start = (sequence: number, toolId: string, args: string[], runId?: string) => event(sequence, 'tool_execution_start', { toolId, toolName: 'dingtalk_execute', input: { args } }, runId)
  const result = (sequence: number, toolCallId: string, payload: unknown, runId?: string) => event(sequence, 'message_end', { message: {
    role: 'toolResult', toolName: 'dingtalk_execute', toolCallId, isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: { serverName: 'dingtalk', toolName: 'dingtalk_execute', isError: false },
  } }, runId)
  return [
    start(1, 'lookup', ['contact', 'user', 'search', '--query', '张三']),
    result(2, 'lookup', { success: true, result: contacts }),
    start(3, 'send', ['chat', '+messages-send', '--as', 'user', '--open-dingtalk-id', recipient, '--msg-type', 'file', '--file', path]),
    result(4, 'send', { ok: true, effectiveMessageType: 'file', file: { path, name: path.split('/').at(-1), sizeBytes },
      sendReceipt: { openTaskId: 'send-id' }, result: { success: true, result: { openTaskId: 'send-id' } } }),
    start(5, 'check', ['chat', '+messages-query-send-status', '--open-task-id', statusId], statusRun),
    result(6, 'check', { success: true, openTaskId: statusId, readyForMessageActions: true,
      result: { sendStatus, openConversationId: 'conversation-id', openMessageId: 'message-id' } }, statusRun),
  ]
}

test('verifies historical DingTalk delivery from matching tool results, not from assistant prose or submission alone', () => {
  const schedule = structuredClone(run)
  schedule.plan.assessmentItems = [
    { kind: 'file', title: 'Report', source: '生成统计报告', deliverableId: 'report', contentCheck: '复核数字' },
    { kind: 'external', title: 'Send', source: '通过钉钉向张三发送生成的报告', includesFile: true },
  ]
  schedule.operations = [{ key: 'a'.repeat(64), tool: 'dingtalk_execute', dingTalkAction: 'chat +messages-send', status: 'succeeded' }]
  const read = (events: TaskExecutionEvent[]) => scheduledAttachmentEvidence(events.flatMap(event => selectScheduledDeliveryEvent(event) ?? []), schedule.taskId)
  assert.equal(scheduledDeliveryRunId(schedule, execution), 'node-run')
  assert.equal(scheduledDeliveryRunId({ ...schedule, status: 'running' }, execution), undefined)
  assert.match(assessScheduledRun(schedule, execution, [], true)[1].detail, /正在读取/)
  const records = dwsAttachmentEvents()
  const rows = assessScheduledRun(schedule, execution, read(records))
  assert.deepEqual(rows.map(row => row.label), ['文件已验收', '已核验'])
  assert.match(rows[1].detail, /report\.md 已发送给张三，不代表已读/)
  for (const bad of [dwsAttachmentEvents({ statusId: 'other-task' }), dwsAttachmentEvents({ sendStatus: 'PROCESSING' }),
    dwsAttachmentEvents({ statusRun: 'other-run' }), dwsAttachmentEvents({ recipient: 'other-person' }),
    dwsAttachmentEvents({ path: 'other/report.md' }), dwsAttachmentEvents({ sizeBytes: 11 }),
    dwsAttachmentEvents({ contacts: [{ name: '张三', openDingTalkId: 'person-id' }, { name: '张三', openDingTalkId: 'other-person' }] }),
    [...records.slice(0, -1), { ...records[5], data: { message: { role: 'assistant', content: [{ type: 'text', text: 'SUCCESS' }] } } }],
    records.map(event => ({ ...event, taskId: 'other-task' })),
  ]) {
    assert.equal(assessScheduledRun(schedule, execution, read(bad))[1].label, '待核验')
  }
  schedule.plan.assessmentItems[1].source = '通过钉钉向小张三发送生成的报告'
  assert.equal(assessScheduledRun(schedule, execution, read(records))[1].label, '待核验')
  assert.equal(schedule.status, 'completed')
})
