import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import { INVOKE_CHANNELS } from './channels'
import * as knowledgeSelection from '../../src/shared/knowledge-selection'

interface TestRoute {
  channel: string
  schema: z.ZodType
  handle(ctx: unknown, input: unknown): Promise<unknown>
}

function updateRoute(): TestRoute {
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
    '../../../src/shared/attachment-contracts': { attachmentRefSchema: z.any() },
    '../../../src/shared/knowledge-selection': knowledgeSelection,
  }
  runInNewContext(compiled, { exports, require: (name: string) => {
    assert.ok(name in imports, `unexpected route dependency: ${name}`)
    return imports[name]
  } })
  const route = exports.taskRoutes?.find(entry => entry.channel === INVOKE_CHANNELS.TASK_UPDATE_DETAILS)
  assert.ok(route)
  return route
}

describe('task detail update IPC', () => {
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
