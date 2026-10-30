import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { responseError } from '../../shared/arrangement-feedback'

function mountWorkspace(cancelTask: (id: string, reason: string) => Promise<{ success: boolean; error?: { message: string } }> = async () => ({ success: true })) {
  const confirmations: unknown[] = []
  const failures: unknown[] = []
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
    useRef: (current: unknown) => ({ current }),
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
    }) }) },
    '../../components/feedback/FeedbackProvider': { useFeedback: () => ({ confirm: async (input: unknown) => { confirmations.push(input); return false } }) },
    '../../shared/arrangement-feedback': { responseError },
    '../../shared/run-response': { RunResponseBuffer: class { keys() { return [][Symbol.iterator]() } delete() {} clear() {} } },
    './placeholder': { WORK_TEMPLATES: [] },
    './general-assistant': { GENERAL_ASSISTANT_ID: 'general', generalAssistant: () => ({ id: 'general' }) },
  }
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'module', 'exports', 'window'], { filename })(
    (id: string) => Reflect.get(imports, id) ?? {}, module, module.exports, { electronAPI: { cancelTask } })
  const hook = (module.exports as typeof import('./useEnterpriseWorkspace')).useEnterpriseWorkspace
  const render = () => { cursor = 0; return hook({ userId: 'user', userName: 'User', enterpriseId: 'ent', enterpriseName: 'Enterprise', instances: [], employeeStatuses: [] }) }
  return { render, confirmations, failures }
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
