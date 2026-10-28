import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import ts from 'typescript'

test('authenticated workspace starts on the personal home and navigation can return to it', () => {
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
  }
  const imports = {
    react: hooks,
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
    '../../components/feedback/use-operation-feedback': { useOperationFeedback: () => ({ capture() {} }) },
    '../../components/feedback/FeedbackProvider': { useFeedback: () => ({ confirm: async () => false }) },
    './placeholder': { WORK_TEMPLATES: [] },
    './general-assistant': { GENERAL_ASSISTANT_ID: 'general', generalAssistant: () => ({ id: 'general' }) },
  }
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'module', 'exports'], { filename })(
    (id: string) => Reflect.get(imports, id) ?? {}, module, module.exports)
  const hook = (module.exports as typeof import('./useEnterpriseWorkspace')).useEnterpriseWorkspace
  const render = () => { cursor = 0; return hook({ userId: 'user', userName: 'User', enterpriseId: 'ent', enterpriseName: 'Enterprise', instances: [], employeeStatuses: [] }) }
  assert.equal(render().route.name, 'home')
  render().navigate({ name: 'organization' })
  assert.equal(render().route.name, 'organization')
  render().goBack()
  assert.equal(render().route.name, 'home')
})
