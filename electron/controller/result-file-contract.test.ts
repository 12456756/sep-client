import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import type { z } from 'zod'
import * as contracts from '../../src/shared/result-files'
import { INVOKE_CHANNELS } from './channels'
import type { Route } from './router'

test('result file routes only accept trusted main-frame identities and never renderer paths', async () => {
  const source = readFileSync(new URL('./routes/result-files.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { resultFileRoutes: Array<Route & { options: unknown }> } }
  const dependencies: Record<string, unknown> = {
    '../../../src/shared/result-files': contracts, '../channels': { INVOKE_CHANNELS },
    '../router': { route: (channel: string, schema: z.ZodType, handle: Route['handle'], options: unknown) => ({ channel, schema, handle, options }) },
  }
  compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => { assert.ok(Object.hasOwn(dependencies, id), id); return dependencies[id] }, module.exports, module)
  const routes = module.exports.resultFileRoutes
  assert.equal(routes.length, 3)
  const calls: string[] = []
  const ctx = { resultFiles: { async preview() { calls.push('preview'); return { url: 'url' } }, async release() { calls.push('release') }, async reveal() { calls.push('reveal') } } }
  for (const route of routes) {
    assert.deepEqual(route.options, { trustedMainFrame: true })
    const release = route.channel === INVOKE_CHANNELS.RESULT_FILE_RELEASE
    const input = release ? { url: `sep-result://preview/${'a'.repeat(64)}` } : { taskId: 'task', nodeId: 'node', deliverableId: 'file' }
    assert.equal(route.schema.safeParse(input).success, true)
    assert.equal(route.schema.safeParse({ ...input, path: '/private/secret' }).success, false)
    if (!release) {
      assert.equal(route.schema.safeParse({ taskId: '../escape', fileId: 'file' }).success, false)
      assert.equal(route.schema.safeParse({ taskId: 'task', fileId: 'task-file-0' }).success, true)
      for (const identity of [{ taskId: 'task', assetId: 'image-output' }, { taskId: 'task', jobId: 'video-job', outputId: 'video-output' }]) {
        assert.equal(route.schema.safeParse(identity).success, true)
        assert.equal(route.schema.safeParse({ ...identity, path: '/private/secret' }).success, false)
        assert.equal(route.schema.safeParse({ ...identity, fileId: 'mixed-identity' }).success, false)
      }
      assert.equal(route.schema.safeParse({ taskId: 'task', jobId: 'job' }).success, false)
      assert.equal(route.schema.safeParse({ taskId: 'task', assetId: '../escape' }).success, false)
      assert.equal(route.schema.safeParse({ taskId: 'task', jobId: 'job', outputId: '../escape' }).success, false)
    }
    assert.equal((await route.handle(ctx as never, input as never) as { success: boolean }).success, true)
  }
  assert.deepEqual(calls, ['preview', 'release', 'reveal'])
})
