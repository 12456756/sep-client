import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as icons from 'lucide-react'
import * as ts from 'typescript'
import * as sessions from './conversation-sessions'
import type { ConversationQueueView } from '../../shared/conversation-queue'
import type { WorkItem } from './types'
import type { EnterpriseWorkspace } from './useEnterpriseWorkspace'

let queue: ConversationQueueView = { paused: false, items: [], failed: null }
const empty = () => null
const dependencies: Record<string, unknown> = {
  react: { ...React, useLayoutEffect() {} }, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  '../../shared/composer-shortcut': { isSubmitEnter: () => false },
  '../../features/enterprise/use-drawer': { useDrawer: () => ({ current: null }) },
  './EmployeeFace': { EmployeeFace: empty }, './MessageContent': { MessageContent: empty },
  '../../styles/conversation.css': {},
  '../../features/speech/use-speech-input': { useSpeechInput: () => ({ busy: false, inputProps: { onKeyDown() {} }, isComposing: () => false }) },
  '../speech/SpeechInputActions': { SpeechInputActions: empty },
  './attachments/AttachmentComposer': { AttachmentComposer: empty },
  '../../features/enterprise/conversation-sessions': sessions,
  '../../features/enterprise/general-assistant': { GENERAL_ASSISTANT_ID: 'general' },
  './KnowledgeSelector': { KnowledgeSelector: empty },
  '../../shared/knowledge-selection': { noKnowledgeSelection: () => ({ mode: 'none', knowledgeBaseIds: [] }) },
  '../../features/enterprise/conversation-media': { ConversationMedia: empty },
  '../../features/enterprise/use-conversation-queue': { useConversationQueue: () => ({ queue, busy: false, async refresh() {}, async resume() {} }) },
}
const filename = fileURLToPath(new URL('../../components/enterprise/WorkTalkDrawer.tsx', import.meta.url))
const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const componentModule = { exports: {} }
compileFunction(source, ['require', 'exports', 'module'], { filename })((id: string) => {
  assert.ok(Object.hasOwn(dependencies, id), `unexpected import: ${id}`)
  return dependencies[id]
}, componentModule.exports, componentModule)
const { WorkConversation } = componentModule.exports as typeof import('../../components/enterprise/WorkTalkDrawer')

function render(status: WorkItem['status'] = 'completed') {
  const work = { id: 'task', title: '测试', currentEmployeeId: 'employee', currentEmployeeName: '电商员工',
    kind: 'conversation', status, isActive: status === 'running', messages: [] } as unknown as WorkItem
  const workspace = { employees: [], myEmployees: [{ id: 'employee', name: '电商员工' }], busy: false, attachmentScopeKey: 'account' } as unknown as EnterpriseWorkspace
  return renderToStaticMarkup(React.createElement(WorkConversation, { work, workspace }))
}

test('conversation shows persisted pending text and attachment names, count and employee-switch lock', () => {
  queue = { paused: false, failed: null, items: [{ id: 'one', prompt: '分析销量', createdAt: 1, attachmentNames: ['销量.xlsx'] }] }
  const html = render('running')
  assert.match(html, /等待处理 1\/10/)
  assert.match(html, /分析销量/)
  assert.match(html, /附件：销量.xlsx/)
  assert.match(html, /<select[^>]+disabled=""/)
  assert.match(html, /补充信息将排队依次处理/)
  assert.doesNotMatch(html, /重试并继续|继续处理<\/button>/)
})

test('paused failed work offers retry first; a restored pending queue offers explicit continuation', () => {
  queue = { paused: true, items: [], failed: { id: 'failed', prompt: '未完成的问题', createdAt: 1, attachmentNames: [] } }
  const failed = render('failed')
  assert.match(failed, /等待处理 0\/10 · 已暂停/)
  assert.match(failed, /未完成：未完成的问题/)
  assert.match(failed, />重试并继续<\/button>/)
  queue = { paused: true, failed: null, items: [{ id: 'pending', prompt: '等待恢复', createdAt: 2, attachmentNames: [] }] }
  assert.match(render(), />继续处理<\/button>/)
  queue = { paused: false, failed: null, items: [] }
  const idle = render()
  assert.doesNotMatch(idle, /ent-conversation-queue|<select[^>]+disabled/)
})
