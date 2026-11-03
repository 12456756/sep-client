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

const filename = fileURLToPath(new URL('../../components/enterprise/ConversationMessages.tsx', import.meta.url))
const dependencies: Record<string, unknown> = {
  react: { ...React, default: React }, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  '../../features/enterprise/use-arrangement-transcript': {},
  '../../features/enterprise/conversation-transcript': transcript,
  './ConversationProcess': { ConversationProcessView },
  './EmployeeFace': { EmployeeFace: () => null },
  './MessageContent': { MessageContent: ({ content }: { content: string }) => React.createElement('div', null, content) },
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
  return renderToStaticMarkup(React.createElement(ConversationMessagesView, {
    work: { id: 'task', currentEmployeeId: 'employee', currentEmployeeName: '电商分析师', createdAt: 1, updatedAt: 1,
      messages, activeRunId, isActive: !!activeRunId } as WorkItem,
    employees: [], preparing, loading: false, error: null, onReload() {},
    runs: buildConversationTranscript([
      { taskId: 'task', runId: 'run-a', subscriptionId: 'employee', sequence: 1, type: 'thinking_delta', occurredAt: 1, data: { text: '第一轮思考' } },
      { taskId: 'task', runId: 'run-b', subscriptionId: 'employee', sequence: 1, type: 'thinking_delta', occurredAt: 2, data: { text: '第二轮思考' } },
    ]),
  }))
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
