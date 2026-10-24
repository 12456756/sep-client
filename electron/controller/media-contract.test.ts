import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import { test } from 'node:test'
import * as ts from 'typescript'
import { z } from 'zod'
import { mediaGenerationInputSchema, mediaId } from '../common/platform/media-contract'
import { appError } from '../errors/app-error'
import { INVOKE_CHANNELS } from './channels'
import type { RequestContext } from './request-context'
import type { Route } from './router'

function loadTaskRoute(): Route {
  const source = readFileSync(new URL('./routes/media.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    electron: { dialog: {} }, zod: { z },
    '../../common/platform/media-contract': { mediaGenerationInputSchema, mediaId },
    '../../errors/app-error': { appError }, '../channels': { INVOKE_CHANNELS },
    '../router': { route: (channel: string, schema: z.ZodType, handle: Route['handle']) => ({ channel, schema, handle }) },
  }
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => {
    assert.ok(Object.hasOwn(dependencies, id), `Unexpected import: ${id}`)
    return dependencies[id]
  }, module.exports, module)
  const route = (module.exports as { mediaRoutes: Route[] }).mediaRoutes.find(entry => entry.channel === INVOKE_CHANNELS.MEDIA_GET_TASK)
  assert.ok(route)
  return route
}

test('media task reads preserve legacy callers and validate explicit capability refresh at IPC', async () => {
  const route = loadTaskRoute()
  const calls: unknown[][] = []
  const ctx = { media: { getTaskMedia: async (...args: unknown[]) => { calls.push(args); return { jobs: [] } } } } as unknown as RequestContext
  for (const input of ['task-a', { taskId: 'task-a' }, { taskId: 'task-a', refreshCapabilities: true }]) {
    const result = await route.handle(ctx, route.schema.parse(input) as never)
    assert.deepEqual(result, { success: true, data: { jobs: [] } })
  }
  assert.deepEqual(calls, [
    ['task-a', { refreshCapabilities: false }], ['task-a', { refreshCapabilities: false }], ['task-a', { refreshCapabilities: true }],
  ])
  for (const input of [{ taskId: '../other' }, { taskId: 'task-a', refreshCapabilities: 'true' },
    { taskId: 'task-a', refreshCapabilities: true, enterpriseId: 'other' }, null]) {
    assert.equal(route.schema.safeParse(input).success, false)
  }
})
