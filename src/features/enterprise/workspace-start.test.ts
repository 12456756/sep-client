import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { responseError } from '../../shared/arrangement-feedback'
import { mergeTaskUpdate } from './task-read-cache'
import { runtimeKey } from '../../shared/work-activity'
import { resolveTaskModel } from '../../shared/model-preferences'
import { conversationDocument, defaultConversationRunSettings, FULL_FILE_ACCESS_CONFIRMATION } from './run-settings'
import { GENERAL_ASSISTANT_ID } from './general-assistant'
import type { ElectronAPI } from '../../shared/ipc'
import type { ArrangementPermissionPreset } from '../../shared/types'

function mountWorkspace(cancelTask: (id: string, reason: string) => Promise<{ success: boolean; error?: { message: string } }> = async () => ({ success: true }), api: Partial<ElectronAPI> = {}, defaultModelId = '', permission?: { preset: ArrangementPermissionPreset; confirm?: () => Promise<boolean> }) {
  const confirmations: unknown[] = []
  const failures: unknown[] = []
  const notices: Array<{ message: string; tone: string }> = []
  const filename = fileURLToPath(new URL('./useEnterpriseWorkspace.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const cells: unknown[] = []
  let cursor = 0
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (value: unknown) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef(current: unknown) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current }
      return cells[index]
    },
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useEffect() {},
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }
  const imports = {
    react: hooks,
    './auto-planning-scope': { usePlanningSession: () => ({ subscribe() {}, getRecords: () => [] }) },
    './planning-records': { mergePlanningRecords: (items: unknown) => items },
    './use-arrangement-plans': { useArrangementPlans: () => ({ plans: {}, events: {}, executions: {}, recordEvent() {} }) },
    './use-skill-library': { useSkillLibrary: () => ({ skills: [] }) },
    './skill-load-state': { needsSkillLibrary: () => false },
    './skill-page-state': {
      createSkillPageState: () => ({ query: '', employeeFilterId: '', versionFilter: 'all', sort: 'name', scrollTop: 0, focusId: null, anchorId: null, anchorOffset: 0, notice: '' }),
      enterSkillPage: (state: unknown) => state,
      createSkillLeaveRegistry: () => ({ register: () => () => {}, mayLeave: () => true }),
    },
    './employee-page-state': {
      createEmployeePageState: () => ({ scope: 'mine', search: '', availability: '', view: 'cards', scrollTop: 0, focusId: null }),
      employeeBackgroundRoute: (route: unknown) => route,
      enterEmployeePage: (state: unknown) => state,
      readEmployeeView: () => 'cards',
      saveEmployeeView() {},
    },
    '../../components/feedback/use-operation-feedback': { useOperationFeedback: () => ({ capture: () => ({
      isCurrent: () => true, fail: (error: unknown) => failures.push(error),
      show: (message: string, tone: string) => notices.push({ message, tone }),
    }) }) },
    '../../components/feedback/FeedbackProvider': { useFeedback: () => ({ confirm: async (input: unknown) => { confirmations.push(input); return permission?.confirm?.() ?? false } }) },
    '../../shared/arrangement-feedback': { responseError },
    '../../shared/run-response': { RunResponseBuffer: class { get() {} keys() { return [][Symbol.iterator]() } delete() {} clear() {} } },
    './placeholder': { WORK_TEMPLATES: [] },
    './general-assistant': { GENERAL_ASSISTANT_ID, generalAssistant: () => ({ id: GENERAL_ASSISTANT_ID, allowedModels: ['model-a', 'model-b'] }) },
    './run-settings': { conversationDocument, defaultConversationRunSettings, FULL_FILE_ACCESS_CONFIRMATION },
    '../../shared/model-preferences': { resolveTaskModel },
    './task-read-cache': { mergeTaskUpdate },
    './work-mapping': { getArrangementDisplayEvents: () => [], buildWorkItem: ({ task }: { task: { id: string; workType: unknown } }) => ({ id: task.id, workType: task.workType, kind: 'conversation', participants: [], steps: [] }) },
    '../../shared/work-activity': { runtimeKey },
  }
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'module', 'exports', 'window'], { filename })(
    (id: string) => Reflect.get(imports, id) ?? {}, module, module.exports, { electronAPI: { cancelTask, ...api } })
  const hook = (module.exports as typeof import('./useEnterpriseWorkspace')).useEnterpriseWorkspace
  const render = () => { cursor = 0; return hook({ userId: 'user', userName: 'User', enterpriseId: 'ent', enterpriseName: 'Enterprise', instances: [], employeeStatuses: [], defaultModelId, defaultConversationPermission: permission?.preset }) }
  return { render, confirmations, failures, notices }
}

test('authenticated workspace starts on the personal home and navigation can return to it', () => {
  const { render } = mountWorkspace()
  assert.equal(render().route.name, 'home')
  render().navigate({ name: 'organization' })
  assert.equal(render().route.name, 'organization')
  render().goBack()
  assert.equal(render().route.name, 'home')
})

test('stopping work cancels immediately without confirmation and tracks pending state', async () => {
  const calls: Array<[string, string]> = []
  let finish!: (result: { success: boolean }) => void
  const ui = mountWorkspace((id, reason) => {
    calls.push([id, reason])
    return new Promise(resolve => { finish = resolve })
  })
  const pending = ui.render().stopWork('task', '  stop now  ')
  assert.deepEqual(calls, [['task', 'stop now']])
  assert.equal(ui.render().busy, true)
  assert.deepEqual(ui.confirmations, [])
  finish({ success: true })
  assert.equal(await pending, true)
  assert.equal(ui.render().busy, false)
})

test('stopping work reports IPC failure without a confirmation and uses a default reason', async () => {
  let seenReason = ''
  const ui = mountWorkspace(async (_id, reason) => {
    seenReason = reason
    return { success: false, error: { message: 'Cancellation failed' } }
  })
  assert.equal(await ui.render().stopWork('task', '  '), false)
  assert.equal(seenReason, '用户终止了这项工作')
  assert.deepEqual(ui.confirmations, [])
  assert.equal(ui.failures.length, 1)
  assert.equal(ui.render().busy, false)
})

test('first submission enters the created conversation without a redundant renderer preflight or waiting for execution', async () => {
  const ui = mountWorkspace(undefined, {
    async createArrangementDraft(document) {
      assert.equal(document.conversation?.kind, 'general')
      if (document.conversation?.kind === 'general') assert.equal(document.conversation.modelId, 'model-b')
      return { success: true, draft: { id: 'draft', revision: 1 } } as Awaited<ReturnType<ElectronAPI['createArrangementDraft']>>
    },
    async preflightArrangementDraft() { assert.fail('confirmation already validates the draft') },
    async confirmAndStartArrangement() {
      return { success: true, task: { id: 'new-task', ownerId: 'user', ownerEnterpriseId: 'ent', status: 'pending', activeRunId: null, workType: { state: 'resolved', kind: 'conversation' } },
        execution: { id: 'new-task', status: 'queued' } } as Awaited<ReturnType<ElectronAPI['confirmAndStartArrangement']>>
    },
  }, 'model-b')
  assert.equal(await ui.render().startConversation(GENERAL_ASSISTANT_ID, '分析电商市场'), true)
  assert.equal(ui.render().route.name, 'work')
  assert.equal(ui.render().works[0]?.id, 'new-task')
  assert.equal(ui.render().busy, false)
  assert.deepEqual(ui.failures, [])
})

test('new conversation default is applied unless the draft explicitly overrides it', async () => {
  const presets: string[] = []
  const ui = mountWorkspace(undefined, {
    async createArrangementDraft(document) {
      presets.push(document.permissions.preset)
      return { success: true, draft: { id: 'draft', revision: 1 } } as Awaited<ReturnType<ElectronAPI['createArrangementDraft']>>
    },
    async confirmAndStartArrangement(input) {
      assert.equal(input.fullFileAccess, undefined)
      return { success: true, execution: { id: 'work', status: 'queued' } }
    },
  }, '', { preset: 'read-only' })
  assert.equal(await ui.render().startConversation(GENERAL_ASSISTANT_ID, '使用默认档位'), true)
  assert.equal(await ui.render().startConversation(GENERAL_ASSISTANT_ID, '更改本次档位', { permissions: defaultConversationRunSettings('workspace-edit').permissions }), true)
  assert.deepEqual(presets, ['read-only', 'workspace-edit'])
  assert.deepEqual(ui.confirmations, [])
})

test('a saved full access default skips the send prompt but does not override a lower draft permission', async () => {
  const presets: ArrangementPermissionPreset[] = []
  const grants: Array<true | undefined> = []
  const ui = mountWorkspace(undefined, {
    async createArrangementDraft(document) {
      presets.push(document.permissions.preset)
      return { success: true, draft: { id: 'draft', revision: 1 } } as Awaited<ReturnType<ElectronAPI['createArrangementDraft']>>
    },
    async confirmAndStartArrangement(input) {
      grants.push(input.fullFileAccess)
      return { success: true, execution: { id: 'work', status: 'queued' } }
    },
  }, '', { preset: 'full-local' })

  assert.equal(await ui.render().startConversation(GENERAL_ASSISTANT_ID, '首页使用默认档位'), true)
  assert.equal(await ui.render().startConversation(GENERAL_ASSISTANT_ID, '对话使用默认档位', { permissions: defaultConversationRunSettings('full-local').permissions }), true)
  assert.equal(await ui.render().startConversation(GENERAL_ASSISTANT_ID, '本次仅查看', { permissions: defaultConversationRunSettings('read-only').permissions }), true)
  assert.deepEqual(presets, ['full-local', 'full-local', 'read-only'])
  assert.deepEqual(grants, [true, true, undefined])
  assert.deepEqual(ui.confirmations, [])
})

test('temporary full access requires fresh confirmation before each draft and cannot be double submitted', async () => {
  let answer!: (accepted: boolean) => void
  let created = 0
  const grants: Array<true | undefined> = []
  const ui = mountWorkspace(undefined, {
    async createArrangementDraft(document) {
      assert.equal(document.permissions.preset, 'full-local')
      created++
      return { success: true, draft: { id: 'draft', revision: 1 } } as Awaited<ReturnType<ElectronAPI['createArrangementDraft']>>
    },
    async confirmAndStartArrangement(input) {
      grants.push(input.fullFileAccess)
      return { success: true, execution: { id: 'work', status: 'queued' } }
    },
  }, '', { preset: 'workspace-edit', confirm: () => new Promise(resolve => { answer = resolve }) })
  const options = { permissions: defaultConversationRunSettings('full-local').permissions }

  const first = ui.render().startConversation(GENERAL_ASSISTANT_ID, '第一个会话', options)
  assert.equal(created, 0)
  assert.equal(await ui.render().startConversation(GENERAL_ASSISTANT_ID, '重复点击', options), false)
  assert.deepEqual(ui.confirmations, [{ ...FULL_FILE_ACCESS_CONFIRMATION, key: 'new-conversation-full-file-access' }])
  answer(true)
  assert.equal(await first, true)
  assert.deepEqual(grants, [true])

  const second = ui.render().startConversation(GENERAL_ASSISTANT_ID, '第二个会话', options)
  assert.equal(ui.confirmations.length, 2)
  assert.equal(created, 1)
  answer(false)
  assert.equal(await second, false)
  assert.equal(created, 1)
  assert.deepEqual(grants, [true])
  assert.deepEqual(ui.failures, [])
  assert.equal(ui.render().busy, false)
})

test('shows queue success only after the additional message was persisted and does not show it on overflow', async () => {
  let finish!: (value: Awaited<ReturnType<ElectronAPI['continueTask']>>) => void
  const ui = mountWorkspace(undefined, { continueTask: () => new Promise(resolve => { finish = resolve }) })
  const pending = ui.render().sendMessage('task', '追加信息', [], undefined, undefined, 'message')
  assert.deepEqual(ui.notices, [])
  finish({ success: true, queued: true })
  assert.equal(await pending, true)
  assert.deepEqual(ui.notices, [{ message: '任务已加入队列', tone: 'success' }])

  const rejected = mountWorkspace(undefined, { async continueTask() { return { success: false, error: { code: 'CONVERSATION_QUEUE_FULL', message: '任务队列已经满了' } } } })
  assert.equal(await rejected.render().sendMessage('task', '追加信息'), false)
  assert.deepEqual(rejected.notices, [])
  assert.equal(rejected.failures.length, 1)
})

test('an idle additional message succeeds without a queued notice', async () => {
  const ui = mountWorkspace(undefined, { async continueTask() { return { success: true, queued: false } } })
  assert.equal(await ui.render().sendMessage('task', '立即执行'), true)
  assert.deepEqual(ui.notices, [])
  assert.deepEqual(ui.failures, [])
})
