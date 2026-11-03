import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ScheduledSnapshot, EmployeeWorkPlan } from '../../src/shared/scheduled-tasks'
import type { ScheduledCreationInterpreterInput, ScheduledCreationRequest, ScheduleInterpretation } from '../../src/shared/scheduled-creation'
import type { ScheduledRepository } from '../data/scheduled-task-store'
import { WriteChain } from '../data/write-chain'
import { ScheduledTaskService } from './scheduled-task-service'
import { ScheduledCreationService } from './scheduled-creation-service'
import { AppError } from '../errors/app-error'

const request: ScheduledCreationRequest = {
  requestId: '11111111-1111-4111-8111-111111111111', message: 'Every day at nine create a report',
  modelId: 'model', workDir: 'D:/reports', timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' },
}
const interpretation: ScheduleInterpretation = {
  status: 'ready', task: { title: 'Daily report', goal: 'Produce report', deliverables: ['Markdown report'],
    execution: { mode: 'employee', subscriptionId: 'sub' },
    schedule: { kind: 'cron', timezone: 'UTC', localDateTime: null, expression: '0 9 * * *', description: 'Daily at 09:00' } },
  questions: [], reasons: [],
}
const plan: EmployeeWorkPlan = { status: 'ready', objective: 'Report', instruction: 'Produce a report file', expectedOutput: 'Markdown report',
  deliverables: [{ id: 'report', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Readable file'] }] }
const catalog = [{ subscriptionId: 'sub', name: 'Researcher', position: '', functionalCategory: '', description: '', allowedModels: ['model'] }]

function harness() {
  let data: ScheduledSnapshot = { definitions: [], occurrences: [] }
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'm', enterpriseId: 'e' }
  let now = Date.parse('2026-10-21T08:00:00Z')
  let interpretations = 0, plans = 0, launches = 0
  let interpret: (input: ScheduledCreationInterpreterInput) => Promise<ScheduleInterpretation> = async () => interpretation
  let planner: () => Promise<EmployeeWorkPlan> = async () => plan
  let validate: () => Promise<void> = async () => undefined
  let fault: 'before-enable' | 'after-enable' | null = null
  const writes = new WriteChain()
  const repository: ScheduledRepository = {
    async read() { return structuredClone(data) },
    update: (_scope, mutate) => writes.run('scope', async () => {
      const snapshot = structuredClone(data), result = mutate(snapshot)
      const enabling = snapshot.creations?.some(item => item.stage === 'completed') && !data.creations?.some(item => item.stage === 'completed')
      if (enabling && fault === 'before-enable') { fault = null; throw new AppError('PERSISTENCE_ERROR') }
      data = snapshot
      if (enabling && fault === 'after-enable') { fault = null; throw new AppError('PERSISTENCE_ERROR') }
      return structuredClone(result)
    }),
  }
  const scopes = { currentScope: () => scope }
  const schedules = new ScheduledTaskService({ repository, scope: scopes, now: () => now, employee: async () => ({}),
    planner: async () => { plans++; return planner() },
    arrangementPlanner: async () => ({ status: 'ready', kind: 'arrangement', title: 'Report', intentAnalysis: null,
      nodes: [{ id: 'work', subscriptionId: 'sub', modelId: 'model', title: 'Report', instruction: plan.instruction,
        expectedOutput: plan.expectedOutput, deliverables: plan.deliverables, dependsOn: [], skillIds: [], requiresUserConfirmation: false }] }),
    runner: { async prepare() {}, async launch() { launches++ }, async inspect() { return { state: 'running' } }, async cancel() {} },
  })
  const make = () => new ScheduledCreationService({ repository, scope: scopes, schedules, now: () => now,
    catalog: async () => catalog, authorize: async () => undefined, validateWorkspace: () => validate(),
    interpret: async input => { interpretations++; return interpret(input) },
  })
  const creation = make()
  return { creation, schedules, repository, make, get data() { return data }, get interpretations() { return interpretations }, get plans() { return plans }, get launches() { return launches },
    setInterpret(value: typeof interpret) { interpret = value }, setPlanner(value: typeof planner) { planner = value },
    setValidate(value: typeof validate) { validate = value }, setScope(value: typeof scope) { scope = value }, advance(value: number) { now = value },
    failEnable(value: typeof fault) { fault = value },
    stop() { creation.stop(); schedules.stop() },
  }
}

test('homepage creation plans and enables without confirmation, then repeated requests never duplicate or re-enable', async () => {
  const h = harness()
  try {
    const first = await h.creation.submit(request)
    assert.equal(first.stage, 'completed')
    assert.equal(h.data.definitions.length, 1)
    assert.equal(h.data.definitions[0].enabled, true)
    assert.ok(h.data.definitions[0].plan)
    assert.match(h.data.definitions[0].input.goal, /Markdown report/)
    assert.equal(h.launches, 0)
    await h.schedules.pause(first.definitionId!, h.data.definitions[0].revision)
    const again = await h.creation.submit(request)
    assert.equal(again.definitionId, first.definitionId)
    assert.equal(h.data.definitions[0].enabled, false)
    assert.equal(h.interpretations, 1)
    assert.equal(h.plans, 1)
    assert.equal(h.data.definitions.length, 1)
  } finally { h.stop() }
})

test('clarification continues the same persisted creation and automatic mode reuses arrangement planning', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), status: 'needs_input',
      task: { ...structuredClone(interpretation.task), schedule: { ...interpretation.task.schedule, expression: null } },
      questions: [{ field: 'schedule', question: 'What time?' }] }))
    const draft = await h.creation.submit(request)
    assert.equal(draft.stage, 'needs_input')
    assert.equal(h.data.definitions.length, 0)
    const recovered = h.make()
    h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), execution: { mode: 'auto', subscriptionId: null } } }))
    const result = await recovered.submit({ ...request, expectedRevision: draft.revision, message: 'Nine every morning' })
    assert.equal(result.id, draft.id)
    assert.equal(result.stage, 'completed')
    assert.equal(result.messages.length, 2)
    assert.equal(h.data.creations?.length, 1)
    assert.equal(h.data.definitions[0].plan?.kind, 'arrangement')
    assert.equal(h.data.definitions[0].enabled, true)
    recovered.stop()
  } finally { h.stop() }
})

test('clarifications timestamp the new answer without moving the original relative-date reference', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), status: 'needs_input',
      task: { ...structuredClone(interpretation.task), schedule: { ...interpretation.task.schedule, expression: null } },
      questions: [{ field: 'schedule', question: 'What time?' }] }))
    const first = await h.creation.submit(request)
    const originalReference = h.data.creations![0].referenceNow
    h.advance(originalReference + 86400000)
    h.setInterpret(async input => {
      assert.equal(input.referenceNow, originalReference)
      assert.equal(input.messages.at(-1)?.receivedAt, originalReference + 86400000)
      return structuredClone(interpretation)
    })
    await h.creation.submit({ ...request, expectedRevision: first.revision, message: 'At nine' })
  } finally { h.stop() }
})

test('concurrent identical submissions share one operation; different content cannot replace in-flight input', async () => {
  const h = harness()
  let finish!: (value: ScheduleInterpretation) => void
  h.setInterpret(() => new Promise(resolve => { finish = resolve }))
  try {
    const a = h.creation.submit(request), b = h.creation.submit(request)
    for (let i = 0; !finish && i < 30; i++) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(h.creation.submit({ ...request, message: 'Different task' }), { code: 'CONFLICT' })
    finish(interpretation)
    assert.equal((await a).definitionId, (await b).definitionId)
    assert.equal(h.interpretations, 1)
    assert.equal(h.data.definitions.length, 1)
  } finally { h.stop() }
})

test('planning failure resumes from saved parsing and does not add another definition after restart', async () => {
  const h = harness()
  try {
    h.setPlanner(async () => { throw new Error('temporary planner failure') })
    const failed = await h.creation.submit(request)
    assert.equal(failed.stage, 'failed')
    assert.equal(h.data.definitions.length, 1)
    h.setPlanner(async () => plan)
    const restarted = h.make()
    await restarted.recover()
    const done = await restarted.submit(request)
    assert.equal(done.stage, 'completed')
    assert.equal(h.interpretations, 1)
    assert.equal(h.data.definitions.length, 1)
    restarted.stop()
  } finally { h.stop() }
})

test('cancel while parsing prevents a late model response from creating or enabling work', async () => {
  const h = harness()
  let finish!: (value: ScheduleInterpretation) => void
  h.setInterpret(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = h.creation.submit(request)
    for (let i = 0; !finish && i < 30; i++) await new Promise(resolve => setImmediate(resolve))
    const current = h.data.creations![0]
    await h.creation.cancel(current.id, current.revision)
    finish(interpretation)
    assert.equal((await pending).stage, 'cancelled')
    assert.equal(h.data.definitions.length, 0)
    assert.equal(h.data.creations![0].stage, 'cancelled')
  } finally { h.stop() }
})

test('logout rejects late results and never creates protected work', async () => {
  const h = harness()
  let finish!: (value: ScheduleInterpretation) => void
  h.setInterpret(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = h.creation.submit(request)
    for (let i = 0; !finish && i < 30; i++) await new Promise(resolve => setImmediate(resolve))
    h.setScope(null); h.creation.stop(); finish(interpretation)
    await assert.rejects(pending, { code: 'AUTH_REQUIRED' })
    assert.equal(h.data.definitions.length, 0)
  } finally { h.stop() }
})

test('invalid employee, unsupported model and inaccessible directory never enable a task', async () => {
  for (const failure of ['employee', 'model', 'directory']) {
    const h = harness()
    try {
      if (failure === 'employee') h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), execution: { mode: 'employee', subscriptionId: 'invented' } } }))
      if (failure === 'directory') h.setValidate(async () => { throw { code: 'WORKSPACE_INVALID' } })
      const result = await h.creation.submit(failure === 'model' ? { ...request, modelId: 'invented' } : request)
      assert.notEqual(result.stage, 'completed')
      assert.equal(h.data.definitions.some(item => item.enabled), false)
      assert.equal(h.launches, 0)
    } finally { h.stop() }
  }
})

test('stale clarification revisions cannot overwrite newer persisted answers', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), status: 'needs_input', questions: [{ field: 'goal', question: 'Which report?' }] }))
    const first = await h.creation.submit(request)
    const second = await h.creation.submit({ ...request, expectedRevision: first.revision, message: 'Sales report' })
    await assert.rejects(h.creation.submit({ ...request, expectedRevision: first.revision, message: 'Marketing report' }), { code: 'DRAFT_REVISION_CONFLICT' })
    assert.equal(h.data.creations![0].revision, second.revision)
    assert.equal(h.data.creations![0].messages.at(-1)?.content, 'Sales report')
  } finally { h.stop() }
})

test('a due occurrence still uses the existing scheduled execution and repeated scans launch only once', async () => {
  const h = harness()
  try {
    await h.creation.submit(request)
    h.advance(Date.parse('2026-10-21T09:00:00Z'))
    await h.schedules.scan(); await h.schedules.scan()
    assert.equal(h.launches, 1)
    assert.equal(h.data.occurrences.length, 1)
  } finally { h.stop() }
})

test('enable checkpoint failure retries only the saved plan; a lost enable response returns the committed task', async () => {
  for (const fault of ['before-enable', 'after-enable'] as const) {
    const h = harness()
    try {
      h.failEnable(fault)
      const first = await h.creation.submit(request)
      assert.equal(first.stage, fault === 'before-enable' ? 'failed' : 'completed')
      assert.equal(h.data.definitions[0].enabled, fault === 'after-enable')
      const again = await h.creation.submit(request)
      assert.equal(again.stage, 'completed')
      assert.equal(h.data.definitions.length, 1)
      assert.equal(h.interpretations, 1)
      assert.equal(h.plans, 1)
    } finally { h.stop() }
  }
})

test('planning can ask for required input and a new answer edits the same task rather than reusing the old goal', async () => {
  const h = harness()
  try {
    h.setPlanner(async () => { throw new AppError('INVALID_ARGUMENT', { message: 'Which sales source should be used?' }) })
    const draft = await h.creation.submit(request)
    assert.equal(draft.stage, 'needs_input')
    assert.equal(draft.interpretation?.questions[0]?.field, 'goal')
    h.setPlanner(async () => plan)
    h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), goal: 'Produce report from sales.csv' } }))
    const result = await h.creation.submit({ ...request, expectedRevision: draft.revision, message: 'Use sales.csv' })
    assert.equal(result.stage, 'completed')
    assert.equal(h.data.definitions.length, 1)
    assert.match(h.data.definitions[0].input.goal, /sales.csv/)
    assert.equal(h.interpretations, 2)
  } finally { h.stop() }
})

test('one-off time that passes during planning asks for a new time without executing late', async () => {
  const h = harness()
  try {
    h.setInterpret(async () => ({ ...structuredClone(interpretation), task: { ...structuredClone(interpretation.task), schedule: {
      kind: 'once', timezone: 'UTC', localDateTime: '2026-10-21T08:01', expression: null, description: 'Once at 08:01',
    } } }))
    h.setPlanner(async () => { h.advance(Date.parse('2026-10-21T08:02:00Z')); return plan })
    const result = await h.creation.submit(request)
    assert.equal(result.stage, 'needs_input')
    assert.equal(result.interpretation?.questions[0]?.field, 'schedule')
    assert.equal(h.data.definitions[0].enabled, false)
    assert.equal(h.launches, 0)
  } finally { h.stop() }
})

test('cancel while the planner is awaiting cannot save a late plan or enable the definition', async () => {
  const h = harness()
  let finish!: (value: EmployeeWorkPlan) => void
  h.setPlanner(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = h.creation.submit(request)
    for (let i = 0; !finish && i < 50; i++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(finish)
    const current = h.data.creations![0]
    await h.creation.cancel(current.id, current.revision)
    finish(plan)
    assert.equal((await pending).stage, 'cancelled')
    assert.equal(h.data.definitions[0].enabled, false)
    assert.equal(h.data.definitions[0].plan, null)
  } finally { h.stop() }
})

test('recovering interrupted configuration does not automatically call a model or admit a task', async () => {
  const h = harness()
  try {
    h.setPlanner(async () => { throw new Error('Failure') })
    await h.creation.submit(request)
    await h.repository.update({ memberId: 'm', enterpriseId: 'e' }, data => { data.creations![0].stage = 'planning' })
    const restarted = h.make()
    await restarted.recover()
    assert.equal(h.data.creations![0].stage, 'failed')
    assert.equal(h.interpretations, 1)
    assert.equal(h.plans, 1)
    assert.equal(h.launches, 0)
    restarted.stop()
  } finally { h.stop() }
})
