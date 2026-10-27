import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import { it } from 'node:test'
import * as ts from 'typescript'
import * as contracts from '../../src/shared/document-preview'
import { INVOKE_CHANNELS } from './channels'
import type { Route } from './router'

function previewRoute(): Route {
  const source = readFileSync(new URL('./routes/document-preview.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { documentPreviewRoutes: Route[] } }
  const dependencies: Record<string, unknown> = {
    '../../../src/shared/document-preview': contracts,
    '../channels': { INVOKE_CHANNELS },
    '../router': { route: (channel: string, schema: Route['schema'], handle: Route['handle']) => ({ channel, schema, handle }) },
  }
  compileFunction(compiled, ['require', 'exports', 'module'])((name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), name)
    return dependencies[name]
  }, module.exports, module)
  assert.equal(module.exports.documentPreviewRoutes.length, 1)
  return module.exports.documentPreviewRoutes[0]
}

it('document preview IPC accepts delivery identities only and delegates without filesystem paths', async () => {
  const route = previewRoute()
  assert.equal(route.channel, INVOKE_CHANNELS.ARRANGE_PREVIEW_DOCUMENT)
  const input = { taskId: 'task-a', nodeId: 'node-a', deliverableId: 'report' }
  assert.deepEqual(route.schema.parse(input), input)
  for (const invalid of [
    { ...input, path: 'C:\\private.docx' }, { ...input, taskId: '../task' },
    { ...input, nodeId: '../node' }, { ...input, deliverableId: '../report' },
    { ...input, deliverableId: 42 }, null,
  ]) assert.equal(route.schema.safeParse(invalid).success, false)
  const calls: unknown[] = []
  const preview = { name: 'report.docx' }
  const context = { documentPreviews: { preview: async (value: unknown) => { calls.push(value); return preview } } }
  assert.deepEqual(await route.handle(context as never, input as never), { success: true, data: preview })
  assert.deepEqual(calls, [input])
})

it('conversation preview accepts a task file identity, never a path or mixed node identity', async () => {
  const route = previewRoute()
  const input = { taskId: 'task-a', fileId: 'task-a-file-0' }
  assert.deepEqual(route.schema.parse(input), input)
  for (const invalid of [
    { ...input, path: 'C:\\private.docx' }, { ...input, fileId: '../secret' },
    { ...input, nodeId: 'node', deliverableId: 'report' }, { ...input, fileId: 0 },
    { ...input, taskId: '../task' }, { ...input, fileId: '' },
  ]) assert.equal(route.schema.safeParse(invalid).success, false)
  const calls: unknown[] = []
  const context = { documentPreviews: { preview: async (value: unknown) => { calls.push(value); return { name: 'report.docx' } } } }
  await route.handle(context as never, input as never)
  assert.deepEqual(calls, [input])
})
