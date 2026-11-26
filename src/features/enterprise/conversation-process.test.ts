import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as jsxRuntime from 'react/jsx-runtime'
import * as icons from 'lucide-react'
import * as ts from 'typescript'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationProcessView } from '../../components/enterprise/ConversationProcess'
import { DiagnosticExport } from '../../components/enterprise/DiagnosticExport'
import * as transcript from './conversation-transcript'
import { buildConversationTranscript } from './conversation-transcript'
import type { WorkItem, WorkMessage } from './types'
import type { TaskExecutionEvent } from '../../shared/types'
import * as conversationResults from './conversation-results'
import { ResultFileCard } from '../../components/workspace/ResultFileCard'
import { DocumentPreviewButton } from '../../components/workspace/DocumentPreviewButton'
import { SaveWordCopyButton } from '../../components/workspace/SaveWordCopyButton'
import { FeedbackProvider } from '../../components/feedback/FeedbackProvider'
import * as fileMenuActions from '../../components/workspace/file-menu-actions'
import * as scheduledCreation from '../../shared/scheduled-creation'
import * as runtimeFeedback from '../../shared/runtime-feedback'
import { selectTranscriptEvent } from './arrangement-transcript'

const filename = fileURLToPath(new URL('../../components/enterprise/ConversationMessages.tsx', import.meta.url))
const dependencies: Record<string, unknown> = {
  react: { ...React, default: React }, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  '../../features/enterprise/use-arrangement-transcript': {},
  '../../features/enterprise/conversation-transcript': transcript,
  './ConversationProcess': { ConversationProcessView },
  './DiagnosticExport': { DiagnosticExport },
  './EmployeeFace': { EmployeeFace: () => null },
  './MessageContent': { MessageContent: ({ content }: { content: string }) => React.createElement('div', null, content) },
  '../ContentCopyMenu': { useContentCopy: () => ({ showMenu() {}, menu: null }), imageCopyHandlers: () => ({}) },
  '../../features/enterprise/conversation-media': {},
  '../../features/enterprise/conversation-results': conversationResults,
  '../workspace/ResultFileCard': { ResultFileCard },
  '../workspace/DocumentPreviewButton': { DocumentPreviewButton },
  '../workspace/SaveWordCopyButton': { SaveWordCopyButton },
  '../workspace/file-menu-actions': fileMenuActions,
  '../workspace/result-file-card.css': {},
  '../../shared/scheduled-creation': scheduledCreation,
  '../../shared/runtime-feedback': runtimeFeedback,
}
const componentModule = { exports: {} }
compileFunction(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, ['require', 'exports', 'module'], { filename })((id: string) => {
  assert.ok(Object.hasOwn(dependencies, id), `unexpected import: ${id}`)
  return dependencies[id]
}, componentModule.exports, componentModule)
const { ConversationMessagesView } = componentModule.exports as typeof import('../../components/enterprise/ConversationMessages')

test('renders a persisted schedule receipt in the correct reply without requiring assistant text', () => {
  const work = { id: 'task', currentEmployeeName: '员工', messages: [
    { id: 'request', role: 'user', content: '每天八点生成简报', runId: 'run-a', createdAt: 1 },
    { id: 'next', role: 'user', content: '其他问题', runId: 'run-b', createdAt: 2 },
  ] } as WorkItem
  const html = renderWithFeedback(React.createElement(ConversationMessagesView, {
    work, employees: [], preparing: false, loading: false, error: null, onReload() {}, onOpenSchedule() {},
    runs: [{ runId: 'run-a', entries: [], scheduleReceipt: { status: 'created', id: 'def', title: '销售简报',
      nextRunAt: Date.parse('2026-11-24T00:00:00Z'), timezone: 'Asia/Shanghai' } }],
  }))
  assert.ok(html.indexOf('每天八点生成简报') < html.indexOf('已启用「销售简报」'))
  assert.ok(html.indexOf('已启用「销售简报」') < html.indexOf('其他问题'))
  assert.match(html, /下次执行：[^<]*08:00/)
  assert.match(html, /查看任务/)
})

test('timed-out schedule actions are shown only while the corresponding draft remains open', () => {
  const draft = { id: '11111111-1111-4111-8111-111111111111', revision: 3 }
  const work = { id: 'task', currentEmployeeName: '员工', messages: [
    { id: 'u1', role: 'user', content: '昨天的请求', runId: 'run-a', createdAt: 1 },
    { id: 'u2', role: 'user', content: '今天的回复', runId: 'run-b', createdAt: 2 },
  ] } as WorkItem
  const expired: transcript.ConversationRunTranscript = { runId: 'run-a', entries: [],
    scheduleReceipt: { status: 'needs_confirmation', message: '上次确认已超时，任务未启用，草稿已保留。', draft } }
  const render = (runs: transcript.ConversationRunTranscript[]) => renderWithFeedback(React.createElement(ConversationMessagesView, {
    work, employees: [], preparing: false, loading: false, error: null, onReload() {}, runs, onScheduleAction: async () => true,
  }))
  assert.match(render([expired]), /重新确认/)
  assert.match(render([expired]), /修改时间/)
  assert.match(render([expired]), /放弃草稿/)
  assert.doesNotMatch(render([expired, { runId: 'run-b', entries: [], scheduleReceipt: {
    status: 'discarded', message: '已放弃草稿。', draft: { ...draft, revision: 4 },
  } }]), />重新确认<|>修改时间<|>放弃草稿</)
})

test('conversation process and every thinking block start folded, with tool names and states visible after expansion', () => {
  const events: TaskExecutionEvent[] = [
    { taskId: 'task', runId: 'run', subscriptionId: 'employee', sequence: 1, type: 'thinking_delta', occurredAt: 1, data: { text: '先检查资料' } },
    { taskId: 'task', runId: 'run', subscriptionId: 'employee', sequence: 2, type: 'tool_execution_start', occurredAt: 2, data: { toolId: 'read', toolName: 'read' } },
    { taskId: 'task', runId: 'run', subscriptionId: 'employee', sequence: 3, type: 'tool_execution_end', occurredAt: 3, data: { toolId: 'read', toolName: 'read', success: true } },
  ]
  const html = renderToStaticMarkup(React.createElement(ConversationProcessView, { entries: buildConversationTranscript(events)[0]!.entries, active: false, loading: false, error: null, onReload() {} }))
  assert.match(html, /<details[^>]+aria-label="工作过程"/)
  assert.doesNotMatch(html, /<details[^>]+open/)
  assert.match(html, /先检查资料/)
  assert.match(html, /思考过程/)
  assert.match(html, /读取文件/)
  assert.match(html, /已完成/)
  assert.match(html, />read</)
})

test('an unfinished historical tool is marked interrupted instead of running forever', () => {
  const runs = [{ runId: 'old', entries: [{ id: 'tool', kind: 'tool' as const, text: '执行命令', toolName: 'bash', state: 'running' as const, at: 1 }] }]
  const html = renderToStaticMarkup(React.createElement(ConversationProcessView, { entries: runs[0]!.entries, active: false, loading: false, error: null, onReload() {} }))
  assert.match(html, /已中断/)
  assert.doesNotMatch(html, /进行中/)
})

function renderMessages(messages: WorkMessage[], preparing: boolean, activeRunId: string | null = null) {
  return renderWithFeedback(React.createElement(ConversationMessagesView, {
    work: { id: 'task', currentEmployeeId: 'employee', currentEmployeeName: '电商分析师', createdAt: 1, updatedAt: 1,
      messages, activeRunId, isActive: !!activeRunId } as WorkItem,
    employees: [], preparing, loading: false, error: null, onReload() {},
    runs: buildConversationTranscript([
      { taskId: 'task', runId: 'run-a', subscriptionId: 'employee', sequence: 1, type: 'thinking_delta', occurredAt: 1, data: { text: '第一轮思考' } },
      { taskId: 'task', runId: 'run-b', subscriptionId: 'employee', sequence: 1, type: 'thinking_delta', occurredAt: 2, data: { text: '第二轮思考' } },
    ]),
  }))
}

function renderWithFeedback(element: React.ReactElement) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try { return renderToStaticMarkup(React.createElement(FeedbackProvider, null, element)) }
  finally {
    if (previous) Object.defineProperty(globalThis, 'React', previous)
    else Reflect.deleteProperty(globalThis, 'React')
  }
}

test('renders the employee immediately after the request while no execution data is available', () => {
  const html = renderMessages([{ id: 'user', role: 'user', content: '分析市场', createdAt: 1 }], true)
  assert.ok(html.indexOf('分析市场') < html.indexOf('电商分析师'))
  assert.match(html, /正在进行…/)
  assert.equal((html.match(/data-conversation-reply=/g) ?? []).length, 1)
})

test('places folded processes inside their own employee replies across consecutive runs', () => {
  const html = renderMessages([
    { id: 'u-a', role: 'user', content: '第一个问题', createdAt: 1, runId: 'run-a' },
    { id: 'a-a', role: 'employee', content: '第一个结果', createdAt: 1, runId: 'run-a' },
    { id: 'u-b', role: 'user', content: '第二个问题', createdAt: 2, runId: 'run-b' },
  ], false, 'run-b')
  assert.ok(html.indexOf('第一个问题') < html.indexOf('第一轮思考'))
  assert.ok(html.indexOf('第一轮思考') < html.indexOf('第一个结果'))
  assert.ok(html.indexOf('第一个结果') < html.indexOf('第二个问题'))
  assert.ok(html.indexOf('第二个问题') < html.indexOf('第二轮思考'))
  assert.equal((html.match(/data-conversation-reply=/g) ?? []).length, 2)
  assert.doesNotMatch(html, /<details[^>]+open/)
})

test('offers diagnostic export only on the failed reply with saved evidence', () => {
  const messages: WorkMessage[] = ['old', 'failed', 'retry'].map((runId, index) => ({
    id: `user-${runId}`, role: 'user', content: 'Question', createdAt: index + 1, runId,
  }))
  const events: TaskExecutionEvent[] = messages.map(({ runId }, index) => ({ taskId: 'task', runId: runId!, subscriptionId: 'employee',
    sequence: 1, occurredAt: index + 1, type: runId === 'retry' ? 'run_completed' : 'run_failed',
    data: { diagnosticAvailable: runId !== 'old', error: 'PRIVATE_FAILURE', text: 'PRIVATE_DETAIL' } }))
  const runs = buildConversationTranscript(events)
  assert.deepEqual(runs, [{ runId: 'failed', entries: [], diagnosticAvailable: true }])
  const html = renderWithFeedback(React.createElement(ConversationMessagesView, {
    work: { id: 'task', currentEmployeeName: '员工', messages } as WorkItem,
    employees: [], preparing: false, runs, loading: false, error: null, onReload() {},
    onExportDiagnostic: async () => ({ success: true }),
  }))
  assert.equal((html.match(/导出本次诊断/g) ?? []).length, 1)
  assert.ok(html.indexOf('data-run-id="failed"') < html.indexOf('导出本次诊断'))
  assert.ok(html.indexOf('导出本次诊断') < html.indexOf('data-run-id="retry"'))
  assert.doesNotMatch(html, /PRIVATE_/)
})

test('explains an oversized model request on its own reply, even without a saved diagnostic', () => {
  const message = runtimeFeedback.RUNTIME_FAILURE_MESSAGES.MODEL_REQUEST_TOO_LARGE
  const messages: WorkMessage[] = ['with-diagnostic', 'without-diagnostic', 'other'].map((runId, index) => ({
    id: `user-${runId}`, role: 'user', content: 'Question', createdAt: index + 1, runId,
  }))
  const projected = messages.flatMap(({ runId }, index) => {
    const event = selectTranscriptEvent({ taskId: 'task', runId: runId!, subscriptionId: 'employee', sequence: 1, occurredAt: index + 1,
      type: 'run_failed', data: { error: runId === 'other' ? `${message} PRIVATE_ERROR` : message,
        diagnosticAvailable: runId !== 'without-diagnostic', details: 'PRIVATE_DETAIL' } })
    return event ? [event] : []
  })
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_/)
  const runs = buildConversationTranscript(projected)
  assert.deepEqual(runs, [
    { runId: 'with-diagnostic', entries: [], diagnosticAvailable: true, failureMessage: message },
    { runId: 'without-diagnostic', entries: [], failureMessage: message },
    { runId: 'other', entries: [], diagnosticAvailable: true },
  ])
  const html = renderWithFeedback(React.createElement(ConversationMessagesView, {
    work: { id: 'task', currentEmployeeName: '员工', messages } as WorkItem,
    employees: [], preparing: false, runs, loading: false, error: null, onReload() {},
    onExportDiagnostic: async () => ({ success: true }),
  }))
  const withoutDiagnostic = html.slice(html.indexOf('data-run-id="without-diagnostic"'), html.indexOf('data-run-id="other"'))
  assert.ok(withoutDiagnostic.includes(message))
  assert.doesNotMatch(withoutDiagnostic, /本轮未返回回复|导出本次诊断/)
  assert.ok(html.indexOf(message) < html.indexOf('导出本次诊断'))
  assert.match(html.slice(html.indexOf('data-run-id="other"')), /本轮执行失败/)
  assert.doesNotMatch(html, /PRIVATE_/)
})

test('shows the latest oversized request failure before its timeline has been read', () => {
  const message = runtimeFeedback.RUNTIME_FAILURE_MESSAGES.MODEL_REQUEST_TOO_LARGE
  const messages: WorkMessage[] = ['previous', 'latest'].map((runId, index) => ({
    id: runId, role: 'user', content: 'Question', createdAt: index + 1, runId,
  }))
  const html = renderWithFeedback(React.createElement(ConversationMessagesView, {
    work: { id: 'task', currentEmployeeName: '员工', status: 'failed', lastRunId: 'latest', stopReason: message, messages } as WorkItem,
    employees: [], preparing: false, runs: [], loading: false, error: null, onReload() {},
  }))
  const latest = html.indexOf('data-run-id="latest"')
  assert.ok(latest >= 0)
  assert.doesNotMatch(html.slice(0, latest), /超过接收上限/)
  assert.ok(html.slice(latest).includes(message))
})

test('keeps image preview and lists PDF and Excel attachments without document preview actions', () => {
  const base = { byteLength: 2048, sha256: 'a'.repeat(64), importSource: 'picker' as const, extractionStatus: 'not-required' as const, warnings: [] }
  const html = renderMessages([{ id: 'user-images', role: 'user', content: '看一下图片', createdAt: 1, attachments: [
    { ...base, attachmentId: 'image', displayName: 'reference.png', mediaType: 'image/png', width: 1600, height: 900 },
    { ...base, attachmentId: 'document', displayName: 'brief.pdf', mediaType: 'application/pdf' },
    { ...base, attachmentId: 'sheet', displayName: 'sales.XLSX', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { ...base, attachmentId: 'text', displayName: 'notes.txt', mediaType: 'text/plain' },
  ] }], false)
  assert.match(html, /ent-message-attachment-preview/)
  assert.match(html, /1600 × 900/)
  assert.match(html, /图片加载中/)
  assert.match(html, /brief\.pdf/)
  assert.match(html, /sales\.XLSX/)
  assert.match(html, /notes\.txt/)
  assert.doesNotMatch(html, /预览文档：|另存为：/)
  assert.match(html, /2 KB/)
})

test('offers preview and download for an uploaded legacy Word attachment', () => {
  const html = renderMessages([{ id: 'user-doc', role: 'user', content: '请修改正文', createdAt: 1, attachments: [{
    attachmentId: 'doc', displayName: '旧版报告.doc', mediaType: 'application/msword', byteLength: 2048,
    sha256: 'a'.repeat(64), importSource: 'picker', extractionStatus: 'not-required', warnings: [],
  }] }], false)
  assert.match(html, /aria-label="预览文档：旧版报告\.doc"/)
  assert.match(html, /aria-label="另存为：旧版报告\.doc"/)
})

test('places generated document and media cards after their reply text and before its timestamp', () => {
  const work = { id: 'task', currentEmployeeId: 'employee', currentEmployeeName: '电商分析师', createdAt: 1, updatedAt: 2,
    messages: [{ id: 'reply', role: 'employee', content: '文件已保存：销售总结.md', createdAt: 2, runId: 'run' }],
    deliverables: [{ id: 'task-file-0', name: '销售总结.md', path: '成果/task/销售总结.md', note: '', format: 'md' }] } as WorkItem
  const html = renderWithFeedback(React.createElement(ConversationMessagesView, {
    work, employees: [], preparing: false, runs: [], loading: false, error: null, onReload() {},
    media: [{ runId: 'run', file: { id: 'image', name: '产品图.png', format: 'png', path: '', note: '', sourceArtifact: { kind: 'image', artifactId: 'image', sha256: '' } }, request: { taskId: 'task', assetId: 'image' } }],
  }))
  assert.ok(html.indexOf('文件已保存') < html.indexOf('ent-conversation-results'))
  assert.ok(html.indexOf('ent-conversation-results') < html.indexOf('ent-message-time'))
  assert.match(html, /预览文档：销售总结.md/)
  assert.match(html, /result-file-card-media/)
  assert.equal((html.match(/aria-label="产物 /g) ?? []).length, 2)
})
