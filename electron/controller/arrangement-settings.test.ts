import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import { INVOKE_CHANNELS } from './channels'

interface TestRoute {
  channel: string
  schema: z.ZodType
  handle(ctx: unknown, input: unknown): Promise<unknown>
}

function settingsRoute(): TestRoute {
  const exports: { arrangementRoutes?: TestRoute[] } = {}
  const source = readFileSync(new URL('./routes/arrangement.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const imports: Record<string, unknown> = {
    zod: { z }, '../channels': { INVOKE_CHANNELS },
    '../router': {
      NO_INPUT: z.undefined(),
      route: (channel: string, schema: z.ZodType, handle: TestRoute['handle']) => ({ channel, schema, handle }),
    },
  }
  runInNewContext(compiled, { exports, require: (name: string) => {
    assert.ok(name in imports, 'unexpected route dependency: ' + name)
    return imports[name]
  } })
  const route = exports.arrangementRoutes?.find(entry => entry.channel === INVOKE_CHANNELS.ARRANGE_UPDATE_EXECUTION_SETTINGS)
  assert.ok(route)
  assert.equal(exports.arrangementRoutes?.some(entry => entry.channel === 'arrange:update-draft'), false)
  return route
}

const input = { draftId: 'draft-a', expectedRevision: 3, settings: {
  modelId: 'model-a', workDir: 'D:/reports', permissions: { preset: 'workspace-edit' },
} }

describe('arrangement execution settings IPC', () => {
  it('forwards only validated execution settings to the service', async () => {
    const route = settingsRoute()
    const calls: unknown[][] = []
    await route.handle({ arrangements: { async updateExecutionSettings(...args: unknown[]) { calls.push(args); return {} } } }, route.schema.parse(input))
    assert.deepEqual(calls, [[input.draftId, input.expectedRevision, input.settings]])
  })

  it('rejects full documents and attempts to rewrite plan fields', () => {
    const route = settingsRoute()
    for (const patch of [{ title: 'Changed' }, { goal: 'Changed' }, { nodes: [] }, { mode: 'manual' }, { confirmedInputs: [] }, { intentAnalysis: null }]) {
      assert.equal(route.schema.safeParse({ ...input, settings: { ...input.settings, ...patch } }).success, false)
      assert.equal(route.schema.safeParse({ ...input, ...patch }).success, false)
    }
    assert.equal(route.schema.safeParse({ draftId: input.draftId, expectedRevision: 3, document: {} }).success, false)
  })

  it('rejects invalid models, revisions, directories and permissions', () => {
    const route = settingsRoute()
    for (const patch of [{ modelId: '' }, { workDir: 12 }, { permissions: { preset: 'invalid' } }]) {
      assert.equal(route.schema.safeParse({ ...input, settings: { ...input.settings, ...patch } }).success, false)
    }
    assert.equal(route.schema.safeParse({ ...input, expectedRevision: 0 }).success, false)
  })
})
