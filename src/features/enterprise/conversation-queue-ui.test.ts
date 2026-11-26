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
import * as composerConnectors from './composer-connectors'
import { generalAssistant, GENERAL_ASSISTANT_ID } from './general-assistant'
import type { ConversationQueueView } from '../../shared/conversation-queue'
import * as mediaRetry from '../../shared/media-retry'
import * as scheduledCreation from '../../shared/scheduled-creation'
import { AttachmentDropZone } from '../../components/enterprise/attachments/AttachmentDropZone'
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
  './attachments/AttachmentDropZone': { AttachmentDropZone },
  './attachments/FileMentionPicker': { FileMentionPicker: empty, FileMentionChips: empty, useFileMention: () => ({}) },
  './attachments/FileMentionEditor': { FileMentionEditor: React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<'textarea'> & { mention: unknown }>(({ mention: _mention, ...props }, ref) => React.createElement('textarea', { ...props, ref })) },
  '../workspace/ResultFileCard': { resultFileRequest: () => null },
  '../../features/enterprise/conversation-media': { useConversationMedia: () => ({ results: [] }) },
  '../../features/enterprise/conversation-sessions': sessions,
  '../../features/enterprise/composer-connectors': composerConnectors,
  '../../features/enterprise/general-assistant': { GENERAL_ASSISTANT_ID, generalAssistant },
  './ModelSelector': { ModelSelector: ({ value, disabled, models }: { value: string; disabled: boolean; models: string[] }) => React.createElement('button', { 'aria-label': '模型', disabled, 'data-models': models.join(',') }, value) },
  './KnowledgeSelector': { KnowledgeSelector: empty },
  './ConversationEmployeePicker': { ConversationEmployeePicker: ({ label, disabled, employees }: { label: string; disabled: boolean; employees: { id: string }[] }) => React.createElement('button', { 'aria-label': label, disabled, 'data-employees': employees.map(item => item.id).join(',') }) },
  '../../shared/knowledge-selection': { noKnowledgeSelection: () => ({ mode: 'none', knowledgeBaseIds: [] }) },
  '../../shared/media-retry': mediaRetry,
  '../../shared/scheduled-creation': scheduledCreation,
  '../../features/enterprise/use-conversation-queue': { useConversationQueue: () => ({ queue, busy: false, async refresh() {}, async resume() {}, async prioritize() {} }) },
  './ConversationMessages': { ConversationMessages: empty },
  '../workspace/ContextUsageIndicator': { ContextUsageIndicator: empty },
  '../workspace/file-menu-actions': { FileAttachmentTarget: React.createContext(null) },
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

function render(status: WorkItem['status'] = 'completed', employeeId = 'employee', mediaRetryState?: mediaRetry.MediaRetryState) {
  const work = { id: 'task', title: '测试', currentEmployeeId: 'employee', currentEmployeeName: '电商员工',
    kind: 'conversation', status, modelId: 'model-a', isActive: status === 'running', messages: [] } as unknown as WorkItem
  work.currentEmployeeId = employeeId
  const workspace = { employees: [], myEmployees: [{ id: 'employee', name: '电商员工', allowedModels: ['model-a', 'model-b'] }], busy: false, attachmentScopeKey: 'account' } as unknown as EnterpriseWorkspace
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try {
    return renderToStaticMarkup(React.createElement(WorkConversation, { work, workspace, mediaRetryState }))
  } finally {
    if (previousReact) Object.defineProperty(globalThis, 'React', previousReact)
    else Reflect.deleteProperty(globalThis, 'React')
  }
}

test('conversation shows persisted pending text and attachment names, count and employee-switch lock', () => {
  queue = { paused: false, failed: null, items: [{ id: 'one', prompt: '分析销量', createdAt: 1, attachmentNames: ['销量.xlsx'] }] }
  const html = render('running')
  assert.match(html, />优先执行<\/button>/)
  assert.match(html, /等待处理 1\/10/)
  assert.match(html, /分析销量/)
  assert.match(html, /附件：销量.xlsx/)
  assert.match(html, /<button aria-label="换一位员工接手" disabled=""/)
  assert.match(html, /补充信息将排队依次处理/)
  assert.match(html, /data-attachment-drop-zone="conversation-task"/)
  assert.doesNotMatch(html, /重试并继续|继续处理<\/button>/)
})

test('existing employee and general conversations show the saved model and lock changes while busy', () => {
  queue = { paused: false, failed: null, items: [] }
  assert.match(render(), /aria-label="模型" data-models="model-a,model-b">model-a/)
  assert.match(render('completed', GENERAL_ASSISTANT_ID), /aria-label="模型" data-models="model-a,model-b">model-a/)
  assert.match(render('running'), /aria-label="模型" disabled=""/)
  queue = { paused: true, failed: null, items: [{ id: 'pending', prompt: '等待处理', createdAt: 1, attachmentNames: [] }] }
  assert.match(render(), /aria-label="模型" disabled=""/)
})

test('general assistant conversations expose the same employee picker and keep the busy and queue guards', () => {
  queue = { paused: false, failed: null, items: [] }
  for (const employeeId of ['employee', GENERAL_ASSISTANT_ID]) {
    assert.match(render('completed', employeeId), /<button aria-label="换一位员工接手" data-employees="builtin:general-assistant,employee"><\/button>/)
    assert.match(render('running', employeeId), /<button aria-label="换一位员工接手" disabled=""/)
  }
  queue = { paused: true, failed: null, items: [{ id: 'pending', prompt: '等待处理', createdAt: 1, attachmentNames: [] }] }
  assert.match(render('completed', GENERAL_ASSISTANT_ID), /<button aria-label="换一位员工接手" disabled=""/)
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

test('only a live background preparation is shown as preparing; restored unstarted work has a start action', () => {
  queue = { preparing: true, paused: false, items: [], failed: null }
  assert.match(render('arranging'), /正在准备执行，请稍候/)
  assert.doesNotMatch(render('arranging'), />开始执行<\/button>/)
  queue = { preparing: false, paused: false, items: [], failed: null }
  assert.match(render('arranging'), /尚未开始/)
  assert.match(render('arranging'), />开始执行<\/button>/)
})

test('a damaged session exposes explicit reconstruction instead of an ineffective retry', () => {
  queue = { paused: true, items: [], failed: { id: 'failed', prompt: '未完成的问题', createdAt: 1, attachmentNames: [], recoveryConfirmationRequired: true } }
  const html = render()
  assert.match(html, /会话文件已损坏，需要确认后根据任务历史重建上下文/)
  assert.match(html, />重建会话并继续<\/button>/)
  assert.doesNotMatch(html, />重试并继续<\/button>/)
})

test('unverified media suppresses queue replay and offers skipping after the media check', () => {
  for (const recoveryConfirmationRequired of [false, true]) {
    queue = { paused: true, items: [], skipToken: 'a'.repeat(64), failed: { id: 'failed', prompt: '原生成请求', createdAt: 1, attachmentNames: [], recoveryConfirmationRequired } }
    for (const state of ['checking', 'unavailable', 'unconfirmed'] as const) {
      const html = render('failed', 'employee', state)
      assert.match(html, /正在核实媒体任务状态|勿重复提交/)
      assert.doesNotMatch(html, /本轮回复中断，请查看提示后重试|>重试并继续<|>重建会话并继续</)
      assert.match(html, /aria-label="给员工的下一句话"/)
      if (state === 'checking') assert.doesNotMatch(html, /跳过本轮，继续对话/)
      else assert.match(html, /跳过本轮，继续对话/)
    }
  }
})

test('an initial run can be skipped without waiting entries and a skipped conversation can send new messages', () => {
  queue = { paused: true, items: [], failed: null, skipToken: 'a'.repeat(64) }
  const blocked = render('failed', 'employee', 'unconfirmed')
  assert.doesNotMatch(blocked, /ent-conversation-queue/)
  assert.match(blocked, /跳过本轮，继续对话/)
  assert.match(blocked, /队列已暂停，跳过本轮后可发送新消息/)
  queue = { paused: false, items: [], failed: null, skipped: true }
  const skipped = render('failed', 'employee', 'unconfirmed')
  assert.match(skipped, /已跳过未完成的请求，可以发送新消息/)
  assert.doesNotMatch(skipped, /跳过本轮，继续对话|等待处理|重试并继续/)
  queue = { paused: true, items: [{ id: 'new', prompt: '继续编辑', createdAt: 1, attachmentNames: [] }], failed: null, skipped: true }
  const restored = render('failed', 'employee', 'unconfirmed')
  assert.match(restored, />继续处理<\/button>/)
  assert.doesNotMatch(restored, /重试并继续|本轮回复中断，请查看提示后重试/)
})
