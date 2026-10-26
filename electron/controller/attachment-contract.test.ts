import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import * as contracts from '../../src/shared/attachment-contracts'
import { INVOKE_CHANNELS } from './channels'
import { AppError } from '../errors/app-error'
import type { Route } from './router'

function routes(): Route[] {
  const compiled = ts.transpileModule(readFileSync(new URL('./routes/attachments.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { attachmentRoutes: Route[] } }
  const dependencies: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'operation-test' },
    electron: { dialog: { showOpenDialog: async () => ({ canceled: true }) } },
    zod: { z }, '../../../src/shared/attachment-contracts': contracts,
    '../../errors/app-error': { AppError }, '../channels': { INVOKE_CHANNELS },
    '../router': { route: (channel: string, schema: z.ZodType, handle: Route['handle'], options: unknown) => ({ channel, schema, handle, options }) },
  }
  compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => {
    assert.ok(Object.hasOwn(dependencies, id), id)
    return dependencies[id]
  }, module.exports, module)
  return module.exports.attachmentRoutes
}

test('all attachment routes require trusted main-frame calls and bounded strict inputs', () => {
  const list = routes()
  assert.equal(list.length, 7)
  for (const route of list) assert.deepEqual((route as unknown as { options: unknown }).options, { trustedMainFrame: true })
  const files = list.find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_IMPORT_FILES)!
  const input = { sessionId: 'session-a', operationId: 'op-a', paths: ['/tmp/report.txt'] }
  assert.deepEqual(files.schema.parse(input), input)
  for (const invalid of [{ ...input, sessionId: '../escape' }, { ...input, paths: [] }, { ...input, paths: Array(11).fill('/tmp/report.txt') }, { ...input, allowAll: true }]) assert.equal(files.schema.safeParse(invalid).success, false)
  const image = list.find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_IMPORT_IMAGE)!
  const base = { sessionId: 'session-a', operationId: 'op-a', name: 'screenshot.png', type: 'image/png' }
  assert.equal(image.schema.safeParse({ ...base, bytes: new Uint8Array([1]) }).success, true)
  assert.equal(image.schema.safeParse({ ...base, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }).success, false)
  assert.equal(image.schema.safeParse({ ...base, bytes: [1] }).success, false)
})

test('draft-node imports reject stale revision and unknown nodes before opening a session', async () => {
  const begin = routes().find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_BEGIN)!
  const context = { arrangements: { async getDraft() { return { revision: 2, nodes: [{ id: 'node-a' }], status: 'editing' } } }, attachments: { async beginSession() { assert.fail('must reject') } } }
  await assert.rejects(async () => begin.handle(context as never, { target: { kind: 'draft-node', draftId: 'draft-a', expectedRevision: 1, nodeId: 'node-a' } } as never), (error: unknown) => error instanceof AppError && error.code === 'DRAFT_REVISION_CONFLICT')
  await assert.rejects(async () => begin.handle(context as never, { target: { kind: 'draft-node', draftId: 'draft-a', expectedRevision: 2, nodeId: 'missing' } } as never), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND')
})

test('canceling a native picker preserves the existing session without import', async () => {
  const select = routes().find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_SELECT)!
  const session = { sessionId: 'session-a', status: 'open', attachments: [] }
  const result = await select.handle({ window: () => ({}), attachments: { async listSession() { return session }, async importFiles() { assert.fail('must not import') } } } as never, { sessionId: 'session-a' } as never)
  assert.deepEqual(result, { success: true, cancelled: true, data: session })
})
