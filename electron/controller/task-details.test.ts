import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import { INVOKE_CHANNELS } from './channels'
import * as knowledgeSelection from '../../src/shared/knowledge-selection'
import * as arrangementInput from '../../src/shared/arrangement-input'
import * as attachmentContracts from '../../src/shared/attachment-contracts'

interface TestRoute {
  channel: string
  schema: z.ZodType
  handle(ctx: unknown, input: unknown): Promise<unknown>
}

function updateRoute(channel: string = INVOKE_CHANNELS.TASK_UPDATE_DETAILS): TestRoute {
  const exports: { taskRoutes?: TestRoute[] } = {}
  const source = readFileSync(new URL('./routes/task.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const imports: Record<string, unknown> = {
    zod: { z },
    '../channels': { INVOKE_CHANNELS },
    '../router': {
      NO_INPUT: z.undefined(),
      route: (channel: string, schema: z.ZodType, handle: TestRoute['handle']) => ({ channel, schema, handle }),
    },
    '../../../src/shared/attachment-contracts': attachmentContracts,
    '../../../src/shared/knowledge-selection': knowledgeSelection,
    '../../../src/shared/arrangement-input': arrangementInput,
  }
  runInNewContext(compiled, { exports, require: (name: string) => {
    assert.ok(name in imports, `unexpected route dependency: ${name}`)
    return imports[name]
  } })
  const route = exports.taskRoutes?.find(entry => entry.channel === channel)
  assert.ok(route)
  return route
}

describe('task detail update IPC', () => {
  it('creates tasks with 10 attachment references and rejects 11', () => {
    const route = updateRoute(INVOKE_CHANNELS.TASK_CREATE)
    const input = { title: 'Images', prompt: 'Inspect attachments', subscriptionId: 'sub', attachmentSessionId: 'session',
      attachmentRefs: Array.from({ length: 10 }, (_, index) => ({ attachmentId: `attachment-${index}`, sha256: 'a'.repeat(64) })) }
    assert.equal(route.schema.safeParse(input).success, true)
    assert.equal(route.schema.safeParse({ ...input, attachmentRefs: [...input.attachmentRefs, input.attachmentRefs[0]] }).success, false)
  })
  it('validates rerun request identity and returns the newly created execution', async () => {
    const route = updateRoute(INVOKE_CHANNELS.TASK_RERUN)
    for (const input of ['task-a', { taskId: 'task-a' }, { taskId: '../task', requestId: 'request' },
      { taskId: 'task-a', requestId: '' }, { taskId: 'task-a', requestId: 'request', plan: {} }]) {
      assert.equal(route.schema.safeParse(input).success, false)
    }
    const calls: unknown[][] = []
    const result = await route.handle({ tasks: { async rerun(...args: unknown[]) { calls.push(args); return { id: 'task-b' } } } },
      route.schema.parse({ taskId: 'task-a', requestId: 'request' }))
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['task-a', 'request']])
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true, task: { id: 'task-b' } })
  })
  it('keeps single-task deletion compatible and routes grouped deletion explicitly', async () => {
    const route = updateRoute(INVOKE_CHANNELS.TASK_DELETE)
    const calls: string[] = []
    const ctx = { tasks: { async delete(id: string) { calls.push(`single:${id}`) }, async deleteExecutionGroup(id: string) { calls.push(`group:${id}`) } } }
    assert.equal(route.schema.safeParse({ taskId: 'task-a', includeExecutions: false }).success, false)
    await route.handle(ctx, route.schema.parse('task-a'))
    await route.handle(ctx, route.schema.parse({ taskId: 'task-a', includeExecutions: true }))
    assert.deepEqual(calls, ['single:task-a', 'group:task-a'])
  })
  it('binds clarification replies to a node and forwards the request identity', async () => {
    const route = updateRoute(INVOKE_CHANNELS.TASK_RETRY)
    const inputReply = { requestId: 'request-a', text: '  8 秒竖屏  ' }
    assert.equal(route.schema.safeParse({ taskId: 'task-a', inputReply }).success, false)
    assert.equal(route.schema.safeParse({ taskId: 'task-a', nodeId: 'node-a', inputReply: { ...inputReply, text: '' } }).success, false)
    const calls: unknown[][] = []
    await route.handle({ tasks: { async retry(...args: unknown[]) { calls.push(args) } } },
      route.schema.parse({ taskId: 'task-a', nodeId: 'node-a', inputReply }))
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['task-a', 'node-a', { requestId: 'request-a', text: '8 秒竖屏' }]])
  })
  it('rejects missing patches, unknown keys, invalid titles and nonboolean pins', () => {
    const route = updateRoute()
    for (const input of [
      { taskId: 'task-a' },
      { taskId: 'task-a', archived: true },
      { taskId: 'task-a', title: 'line\nbreak' },
      { taskId: 'task-a', title: '   ' },
      { taskId: 'task-a', pinned: 'yes' },
    ]) assert.equal(route.schema.safeParse(input).success, false)
    assert.equal(route.schema.safeParse({ taskId: 'task-a', title: 'x'.repeat(101) }).success, false)
    assert.equal(route.schema.safeParse({ taskId: 'task-a', title: `bad${String.fromCharCode(1)}title` }).success, false)
  })

  it('trims valid titles and forwards only the supplied fields to the task service', async () => {
    const route = updateRoute()
    const calls: unknown[][] = []
    const ctx = { tasks: { async updateDetails(...args: unknown[]) { calls.push(args); return { id: 'task-a' } } } }
    const parsed = route.schema.parse({ taskId: 'task-a', title: '  Quarterly report  ', pinned: true })
    await route.handle(ctx, parsed)
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['task-a', { title: 'Quarterly report', pinned: true }]])
    const pinOnly = route.schema.parse({ taskId: 'task-a', pinned: false })
    await route.handle(ctx, pinOnly)
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['task-a', { pinned: false }])
  })
})
