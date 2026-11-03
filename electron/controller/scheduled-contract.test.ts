import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import { test } from 'node:test'
import * as ts from 'typescript'
import { z } from 'zod'
import { scheduleInputSchema, scheduleTimeRequestSchema, createWorkScheduleSchema, editWorkScheduleSchema } from '../../src/shared/scheduled-tasks'
import { scheduledCreationRequestSchema } from '../../src/shared/scheduled-creation'
import { INVOKE_CHANNELS } from './channels'
import type { Route } from './router'
import type { RequestContext } from './request-context'

const source = readFileSync(new URL('./routes/scheduled.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const dependencies: Record<string, unknown> = {
  zod: { z }, '../../../src/shared/scheduled-tasks': { scheduleInputSchema, scheduleTimeRequestSchema, createWorkScheduleSchema, editWorkScheduleSchema }, '../channels': { INVOKE_CHANNELS },
  '../../../src/shared/scheduled-creation': { scheduledCreationRequestSchema },
  '../router': { NO_INPUT: z.undefined(), route: (channel: string, schema: z.ZodType, handle: Route['handle']) => ({ channel, schema, handle }) },
}
const loaded = { exports: {} as { scheduledRoutes?: Route[] } }
compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => { assert.ok(Object.hasOwn(dependencies, id)); return dependencies[id] }, loaded.exports, loaded)
const routes = loaded.exports.scheduledRoutes!
const entry = (channel: string) => { const result = routes.find(item => item.channel === channel); assert.ok(result); return result }

test('work import only accepts title, timing and source identity, never a renderer plan or permission override', async () => {
  const route = entry(INVOKE_CHANNELS.SCHEDULE_CREATE_FROM_WORK)
  const input = { requestId: '11111111-1111-4111-8111-111111111111', taskId: 'work', expectedPlanHash: 'a'.repeat(64), name: 'Report', scheduledAt: 2000, timezone: 'UTC', recurrence: { frequency: 'once', interval: 1 } }
  assert.equal(route.schema.safeParse(input).success, true)
  for (const extra of [{ plan: {} }, { modelId: 'other' }, { workDir: 'D:/other' }, { owner: {} }, { permissions: { preset: 'full-local' } }, { enabled: true }]) {
    assert.equal(route.schema.safeParse({ ...input, ...extra }).success, false)
  }
  assert.equal(route.schema.safeParse({ ...input, taskId: '../work' }).success, false)
  const calls: unknown[] = []
  const ctx = { scheduledTasks: { async createFromWork(value: unknown) { calls.push(value) } } } as unknown as RequestContext
  await route.handle(ctx, route.schema.parse(input) as never)
  assert.deepEqual(calls, [input])
})

test('backend wires scheduled admission to fresh employee authorization instead of the cached manual path', () => {
  const backend = readFileSync(new URL('../bootstrap/build-backend.ts', import.meta.url), 'utf8')
  assert.match(backend, /authorizeScheduledEmployee:\s*\(subscriptionId, modelId\)\s*=>\s*this\.employees\.authorizeScheduled\(subscriptionId, modelId\)/)
})

test('schedule mutations require a revision and cannot accept a renderer-authored plan or credentials', () => {
  const mutation = { id: 'task', expectedRevision: 1 }
  for (const channel of [INVOKE_CHANNELS.SCHEDULE_PLAN, INVOKE_CHANNELS.SCHEDULE_CONFIRM, INVOKE_CHANNELS.SCHEDULE_PAUSE, INVOKE_CHANNELS.SCHEDULE_DELETE]) {
    const schema = entry(channel).schema
    assert.equal(schema.safeParse(mutation).success, true)
    for (const value of [{ id: 'task' }, { ...mutation, expectedRevision: 0 }, { ...mutation, plan: {} }, { ...mutation, refreshToken: 'never-accept' }, { ...mutation, id: '../other' }]) assert.equal(schema.safeParse(value).success, false)
  }
})
test('ordinary checks and explicit review acknowledgements reach distinct service paths', async () => {
  const calls: unknown[][] = []
  const context = { scheduledTasks: { async check(...args: unknown[]) { calls.push(args) } } } as unknown as RequestContext
  const check = entry(INVOKE_CHANNELS.SCHEDULE_CHECK)
  const acknowledge = entry(INVOKE_CHANNELS.SCHEDULE_ACKNOWLEDGE)
  assert.equal(acknowledge.schema.safeParse({ id: 'run' }).success, false)
  assert.equal(acknowledge.schema.safeParse({ id: 'run', confirmed: false }).success, false)
  await check.handle(context, check.schema.parse('run') as never)
  await acknowledge.handle(context, acknowledge.schema.parse({ id: 'run', confirmed: true }) as never)
  assert.deepEqual(calls, [['run'], ['run', true]])
})

test('homepage creation rejects renderer-authored identity, plan, credentials and enabled state', async () => {
  const route = entry(INVOKE_CHANNELS.SCHEDULE_SUBMIT_CREATION)
  const input = { requestId: '11111111-1111-4111-8111-111111111111', message: 'Daily report at nine', modelId: 'model', workDir: 'D:/reports', timezone: 'UTC',
    permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
  assert.equal(route.schema.safeParse(input).success, true)
  for (const extra of [{ ownerId: 'other' }, { plan: {} }, { subscriptionId: 'other' }, { refreshToken: 'secret' }, { enabled: true }, { now: 1 }]) {
    assert.equal(route.schema.safeParse({ ...input, ...extra }).success, false)
  }
  const calls: unknown[] = []
  const context = { scheduledCreations: { async submit(value: unknown) { calls.push(value); return { id: input.requestId } } } } as unknown as RequestContext
  await route.handle(context, route.schema.parse(input) as never)
  assert.deepEqual(calls, [input])
  assert.equal(entry(INVOKE_CHANNELS.SCHEDULE_CANCEL_CREATION).schema.safeParse({ id: input.requestId }).success, false)
})
