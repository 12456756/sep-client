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
import * as transcript from './conversation-transcript'
import { buildConversationTranscript } from './conversation-transcript'
import type { WorkItem, WorkMessage } from './types'
import type { TaskExecutionEvent } from '../../shared/types'
import * as conversationResults from './conversation-results'
import { ResultFileCard } from '../../components/workspace/ResultFileCard'
import { DocumentPreviewButton } from '../../components/workspace/DocumentPreviewButton'
import { SaveWordCopyButton } from '../../components/workspace/SaveWordCopyButton'
import { FeedbackProvider } from '../../components/feedback/FeedbackProvider'

const filename = fileURLToPath(new URL('../../components/enterprise/ConversationMessages.tsx', import.meta.url))
const dependencies: Record<string, unknown> = {
  react: { ...React, default: React }, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  '../../features/enterprise/use-arrangement-transcript': {},
  '../../features/enterprise/conversation-transcript': transcript,
  './ConversationProcess': { ConversationProcessView },
  './EmployeeFace': { EmployeeFace: () => null },
  './MessageContent': { MessageContent: ({ content }: { content: string }) => React.createElement('div', null, content) },
  '../../features/enterprise/conversation-media': {},
  '../../features/enterprise/conversation-results': conversationResults,
  '../workspace/ResultFileCard': { ResultFileCard },
  '../workspace/DocumentPreviewButton': { DocumentPreviewButton },
  '../workspace/SaveWordCopyButton': { SaveWordCopyButton },
  '../workspace/result-file-card.css': {},
}
const componentModule = { exports: {} }
compileFunction(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, ['require', 'exports', 'module'], { filename })((id: string) => {
  assert.ok(Object.hasOwn(dependencies, id), `unexpected import: ${id}`)
  return dependencies[id]
}, componentModule.exports, componentModule)
const { ConversationMessagesView } = componentModule.exports as typeof import('../../components/enterprise/ConversationMessages')

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

test('keeps image preview space and dimensions visible while preserving ordinary file attachments', () => {
  const base = { byteLength: 2048, sha256: 'a'.repeat(64), importSource: 'picker' as const, extractionStatus: 'not-required' as const, warnings: [] }
  const html = renderMessages([{ id: 'user-images', role: 'user', content: '看一下图片', createdAt: 1, attachments: [
    { ...base, attachmentId: 'image', displayName: 'reference.png', mediaType: 'image/png', width: 1600, height: 900 },
    { ...base, attachmentId: 'document', displayName: 'brief.pdf', mediaType: 'application/pdf' },
  ] }], false)
  assert.match(html, /ent-message-attachment-preview/)
  assert.match(html, /1600 × 900/)
  assert.match(html, /图片加载中/)
  assert.match(html, /brief.pdf/)
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
