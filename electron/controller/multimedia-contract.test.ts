import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import { test } from 'node:test'
import * as ts from 'typescript'
import { z } from 'zod'
import { INVOKE_CHANNELS } from './channels'
import type { RequestContext } from './request-context'
import type { Route } from './router'

test('multimedia settings IPC validates the subscription and delegates authorization', async () => {
  const source = readFileSync(new URL('./routes/multimedia.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const dependencies: Record<string, unknown> = { zod: { z }, '../channels': { INVOKE_CHANNELS },
    '../router': { route: (channel: string, schema: z.ZodType, handle: Route['handle']) => ({ channel, schema, handle }) } }
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => {
    assert.ok(Object.hasOwn(dependencies, id))
    return dependencies[id]
  }, module.exports, module)
  const [route] = (module.exports as { multimediaRoutes: Route[] }).multimediaRoutes
  assert.equal(route.channel, INVOKE_CHANNELS.MULTIMEDIA_GET_SETTINGS)
  for (const input of [null, {}, { subscriptionId: '' }, { subscriptionId: 1 }, { subscriptionId: 'a'.repeat(129) }, { subscriptionId: 'a', enterpriseId: 'other' }]) {
    assert.equal(route.schema.safeParse(input).success, false)
  }
  const data = { image: null, imageError: null, video: null }
  const calls: string[] = []
  const ctx = { employees: { describeMultimedia: async (id: string) => { calls.push(id); return data } } } as unknown as RequestContext
  assert.deepEqual(await route.handle(ctx, route.schema.parse({ subscriptionId: 'sub-a' }) as never), { success: true, data })
  assert.deepEqual(calls, ['sub-a'])
  ctx.employees.describeMultimedia = async () => { throw new Error('denied') }
  await assert.rejects(async () => route.handle(ctx, { subscriptionId: 'sub-b' } as never), /denied/)
})
