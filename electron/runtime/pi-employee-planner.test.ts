import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { EmployeeWorkPlan, ScheduleInput } from '../../src/shared/scheduled-tasks'
import { PiEmployeePlanner } from './pi-employee-planner'
import type { ScheduleInterpretation, ScheduledCreationInterpreterInput } from '../../src/shared/scheduled-creation'

const input: ScheduleInput = { name: 'Report', goal: 'Produce report', subscriptionId: 'sub', modelId: 'model', workDir: 'D:/reports', scheduledAt: 2000,
  timezone: 'Asia/Shanghai', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
const plan: EmployeeWorkPlan = { status: 'ready', objective: 'Report', instruction: 'Produce report', expectedOutput: 'File',
  deliverables: [{ id: 'file', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Sources'] }] }

test('employee planning disables tools, rejects invalid contracts and returns a settled file plan', async () => {
  let disposed = 0
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        assert.equal(options.context.disableTools, true)
        assert.equal(await options.onApprovalRequest({} as never), false)
        assert.match(options.context.fixedSystemPrompt ?? '', /SKILL.md/)
        const correction = await options.onResponseSettled?.({ text: 'invalid' })
        assert.match(correction?.continueWith ?? '', /JSON 解析未通过/)
        assert.match(correction?.continueWith ?? '', /字段.*尚未执行/)
        assert.match(correction?.continueWith ?? '', /不要执行工作/)
        await options.onResponseSettled?.({ text: JSON.stringify(plan), stopReason: 'stop' })
      }, async abort() {}, async dispose() { disposed++ },
    }),
  })
  assert.deepEqual(await planner.plan(input, { name: 'Researcher' }, new AbortController().signal), plan)
  assert.equal(disposed, 1)
})

test('employee planning follows corrections beyond two turns until a valid plan arrives', async () => {
  let calls = 0
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        for (let i = 0; i < 5; i++) { calls++; assert.ok((await options.onResponseSettled?.({ text: '{}' }))?.continueWith) }
        calls++; await options.onResponseSettled?.({ text: JSON.stringify(plan), stopReason: 'stop' })
      },
      async abort() {}, async dispose() {},
    }),
  })
  assert.deepEqual(await planner.plan(input, {}, new AbortController().signal), plan)
  assert.equal(calls, 6)
})

test('aborting a hanging employee planner stops its worker and releases it', async () => {
  let aborted = 0
  let disposed = 0
  const controller = new AbortController()
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: () => ({ run: () => new Promise<void>(() => {}), async abort() { aborted++ }, async dispose() { disposed++ } }),
  })
  const result = planner.plan(input, {}, controller.signal)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(aborted, 1); assert.equal(disposed, 1)
})

test('custom time interpretation disables tools and accepts only a scheduling expression', async () => {
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        assert.equal(options.context.disableTools, true)
        assert.match(options.context.fixedSystemPrompt ?? '', /五字段/)
        for (let i = 0; i < 5; i++) {
          const correction = await options.onResponseSettled?.({ text: '{"status":"ready","expression":"0 9 * * *","workDir":"C:/private"}' })
          assert.match(correction?.continueWith ?? '', /字段检查未通过/)
          assert.match(correction?.continueWith ?? '', /workDir/)
          assert.doesNotMatch(correction?.continueWith ?? '', /expected "blocked"/)
        }
        await options.onResponseSettled?.({ text: '{"status":"ready","expression":"30 9 1,15,30 * *"}', stopReason: 'stop' })
      }, async abort() {}, async dispose() {},
    }),
  })
  const result = await planner.interpretTime({ requestId: '00000000-0000-4000-8000-000000000000', description: '每个月 1、15、30 号早上九点半', subscriptionId: 'sub', modelId: 'model', timezone: 'Asia/Shanghai' }, new AbortController().signal)
  assert.deepEqual(result, { status: 'ready', expression: '30 9 1,15,30 * *' })
})

const creationInput: ScheduledCreationInterpreterInput = { subscriptionId: 'sub', modelId: 'model', referenceNow: Date.parse('2026-10-21T00:00:00Z'),
  timezone: 'Asia/Shanghai', employeeCatalog: [{ subscriptionId: 'sub', name: 'Analyst', position: 'Analyst', description: 'Reporting', functionalCategory: 'sales', allowedModels: ['model'] }],
  currentDraft: null, messages: [{ role: 'user', content: 'Report tomorrow at 9' }] }
const interpreted: ScheduleInterpretation = { status: 'ready', task: { title: 'Report', goal: 'Sales report', deliverables: ['report.md'],
  execution: { mode: 'employee', subscriptionId: 'sub' }, schedule: { kind: 'once', timezone: 'Asia/Shanghai', localDateTime: '2026-10-22T09:00', expression: null, description: null } }, questions: [], reasons: [] }

test('creation interpretation disables tools, uses fixed reference time and repairs using its own full contract', async () => {
  let disposed = 0
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        assert.equal(options.context.disableTools, true)
        assert.equal(options.context.modelId, 'model')
        assert.equal(await options.onApprovalRequest({} as never), false)
        assert.match(options.context.fixedSystemPrompt ?? '', /2026-10-21T00:00:00.000Z/)
        const correction = await options.onResponseSettled?.({ text: '{"status":"blocked","reasons":["legacy"]}' })
        assert.match(correction?.continueWith ?? '', /task/)
        assert.match(correction?.continueWith ?? '', /questions/)
        assert.match(correction?.continueWith ?? '', /reasons/)
        assert.match(correction?.continueWith ?? '', /needs_input requires empty reasons/)
        assert.match(correction?.continueWith ?? '', /blocked requires empty questions/)
        assert.match(correction?.continueWith ?? '', /reasons\.0/)
        await options.onResponseSettled?.({ text: JSON.stringify(interpreted), stopReason: 'stop' })
      }, async abort() {}, async dispose() { disposed++ },
    }),
  })
  assert.deepEqual(await planner.interpretCreation(creationInput, new AbortController().signal), interpreted)
  assert.equal(disposed, 1)
})

test('creation interpretation accepts clarification or blocked contracts without turning them into ready plans', async () => {
  for (const response of [
    { ...interpreted, status: 'needs_input', questions: [{ field: 'schedule', question: 'Which exact time?' }] },
    { ...interpreted, status: 'blocked', reasons: [{ code: 'UNSUPPORTED_SCHEDULE', message: 'Business days require a holiday calendar' }] },
  ]) {
    const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
      createWorker: options => ({ async run() { await options.onResponseSettled?.({ text: JSON.stringify(response) }) }, async abort() {}, async dispose() {} }),
    })
    assert.deepEqual(await planner.interpretCreation(creationInput, new AbortController().signal), response)
  }
})

test('creation corrections reject truncated and oversized JSON and continue beyond two turns', async () => {
  let calls = 0
  let disposed = 0
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        calls++
        const truncated = await options.onResponseSettled?.({ text: JSON.stringify(interpreted), stopReason: 'length' })
        assert.match(truncated?.continueWith ?? '', /OUTPUT_TRUNCATED/)
        assert.match(truncated?.continueWith ?? '', /未完成.*不能/)
        calls++; assert.ok((await options.onResponseSettled?.({ text: ' '.repeat(128001) + JSON.stringify(interpreted) }))?.continueWith)
        calls++; assert.ok((await options.onResponseSettled?.({ text: '{}' }))?.continueWith)
        calls++; await options.onResponseSettled?.({ text: JSON.stringify(interpreted), stopReason: 'stop' })
      }, async abort() {}, async dispose() { disposed++ },
    }),
  })
  assert.deepEqual(await planner.interpretCreation(creationInput, new AbortController().signal), interpreted)
  assert.equal(calls, 4)
  assert.equal(disposed, 1)
})

test('a blocked employee response is corrected against its own fields rather than the ready branch', async () => {
  const blocked = { status: 'blocked', reasons: ['Missing input'] }
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        const correction = await options.onResponseSettled?.({ text: '{"status":"blocked","reasons":[42]}' })
        assert.match(correction?.continueWith ?? '', /reasons\.0/)
        assert.doesNotMatch(correction?.continueWith ?? '', /objective|expected "ready"/)
        await options.onResponseSettled?.({ text: JSON.stringify(blocked), stopReason: 'stop' })
      }, async abort() {}, async dispose() {},
    }),
  })
  assert.deepEqual(await planner.plan(input, {}, new AbortController().signal), blocked)
})

test('provider error and aborted settlements stop immediately without requesting correction', async () => {
  for (const stopReason of ['error', 'aborted']) {
    let calls = 0, disposed = 0
    let correctionRequested = false
    const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
      createWorker: options => ({
        async run() {
          calls++
          correctionRequested = Boolean((await options.onResponseSettled?.({ text: JSON.stringify(interpreted), stopReason }))?.continueWith)
        },
        async abort() {}, async dispose() { disposed++ },
      }),
    })
    await assert.rejects(planner.interpretCreation(creationInput, new AbortController().signal))
    assert.equal(calls, 1)
    assert.equal(correctionRequested, false)
    assert.equal(disposed, 1)
  }
})

test('a worker ending after an invalid settlement cannot reuse an earlier valid result', async () => {
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        await options.onResponseSettled?.({ text: JSON.stringify(plan), stopReason: 'stop' })
        assert.ok((await options.onResponseSettled?.({ text: '{}' }))?.continueWith)
      }, async abort() {}, async dispose() {},
    }),
  })
  await assert.rejects(planner.plan(input, {}, new AbortController().signal), /有效的文件交付计划/)
})

test('cancellation terminates repeated correction requests and releases the worker', async () => {
  const controller = new AbortController()
  let calls = 0, aborted = 0, disposed = 0
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: options => ({
      async run() {
        for (let i = 0; i < 5; i++) { calls++; assert.ok((await options.onResponseSettled?.({ text: '{}' }))?.continueWith) }
        controller.abort()
        calls++; await options.onResponseSettled?.({ text: JSON.stringify(plan), stopReason: 'stop' })
      }, async abort() { aborted++ }, async dispose() { disposed++ },
    }),
  })
  await assert.rejects(planner.plan(input, {}, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 6)
  assert.equal(aborted, 1)
  assert.equal(disposed, 1)
})

test('creation interpretation honors cancellation before startup and while its worker is running', async () => {
  let started = 0, aborted = 0, disposed = 0
  const planner = new PiEmployeePlanner({ gatewayUrl: 'http://invalid', workspaceRoot: 'planning', getRefreshToken: () => 'test', onAuthenticationRequired() {},
    createWorker: () => { started++; return { run: () => new Promise<void>(() => {}), async abort() { aborted++ }, async dispose() { disposed++ } } },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(planner.interpretCreation(creationInput, controller.signal), { name: 'AbortError' })
  assert.equal(started, 0)
  const active = new AbortController()
  const pending = planner.interpretCreation(creationInput, active.signal)
  active.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(started, 1)
  assert.equal(aborted, 1)
  assert.equal(disposed, 1)
})
