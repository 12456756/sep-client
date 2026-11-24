import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import * as contracts from '../../src/shared/attachment-contracts'
import type { ElectronAPI } from '../../src/shared/ipc'
import * as channels from './channels'
import { INVOKE_CHANNELS } from './channels'
import { AppError } from '../errors/app-error'
import type { Route } from './router'
import { getWindowChromeConfig } from '../common/window-layout'

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
  assert.equal(list.length, 10)
  for (const route of list) assert.deepEqual((route as unknown as { options: unknown }).options, { trustedMainFrame: true })
  const files = list.find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_IMPORT_FILES)!
  const input = { sessionId: 'session-a', operationId: 'op-a', paths: ['/tmp/report.txt'] }
  assert.deepEqual(files.schema.parse(input), input)
  assert.equal(files.schema.safeParse({ ...input, paths: Array(10).fill('/tmp/report.txt') }).success, true)
  for (const invalid of [{ ...input, sessionId: '../escape' }, { ...input, paths: [] }, { ...input, paths: Array(11).fill('/tmp/report.txt') }, { ...input, allowAll: true }]) assert.equal(files.schema.safeParse(invalid).success, false)
  const image = list.find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_IMPORT_IMAGE)!
  const base = { sessionId: 'session-a', operationId: 'op-a', name: 'screenshot.png', type: 'image/png' }
  assert.equal(image.schema.safeParse({ ...base, bytes: new Uint8Array([1]) }).success, true)
  assert.equal(image.schema.safeParse({ ...base, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }).success, false)
  assert.equal(image.schema.safeParse({ ...base, bytes: [1] }).success, false)
  const preview = list.find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_PREVIEW)!
  const previewInput = { taskId: 'task-a', attachmentId: 'attachment-a', sha256: 'a'.repeat(64) }
  const draftPreviewInput = { sessionId: 'session-a', attachmentId: previewInput.attachmentId, sha256: previewInput.sha256 }
  assert.deepEqual(preview.schema.parse(previewInput), previewInput)
  assert.deepEqual(preview.schema.parse(draftPreviewInput), draftPreviewInput)
  assert.equal(preview.schema.safeParse({ ...draftPreviewInput, taskId: 'task-a' }).success, false)
  assert.equal(preview.schema.safeParse({ ...draftPreviewInput, sessionId: '../session' }).success, false)
  for (const invalid of [{ ...previewInput, taskId: '../task' }, { ...previewInput, attachmentId: '../image' }, { ...previewInput, sha256: 'A'.repeat(64) }, { ...previewInput, path: 'secret' }]) assert.equal(preview.schema.safeParse(invalid).success, false)
})

test('folder preview accepts one local drive path and confirmation accepts only distinct candidate IDs', () => {
  const specs = routes()
  const preview = specs.find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_FOLDER_PREVIEW)!
  const confirm = specs.find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_FOLDER_IMPORT)!
  const sessionId = 'session-a'
  assert.ok(preview.schema.safeParse({ sessionId, path: 'D:\\资料\\素材' }).success)
  for (const path of ['D:\\', '\\\\host\\share\\folder', 'D:\\folder\\..\\secrets', 'D:\\folder:stream', 'https://example.test', 'D:\\a\nD:\\b']) {
    assert.equal(preview.schema.safeParse({ sessionId, path }).success, false, path)
  }
  const input = { sessionId, previewId: 'preview-a', candidateIds: ['media-a'] }
  assert.ok(confirm.schema.safeParse(input).success)
  for (const rejected of [{ ...input, path: 'D:\\a' }, { ...input, candidateIds: ['../other'] }, { ...input, candidateIds: ['a', 'a'] }, { ...input, candidateIds: [] }]) {
    assert.equal(confirm.schema.safeParse(rejected).success, false)
  }
})

function mockAttachmentPreload() {
  const source = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  let api!: ElectronAPI
  const calls: unknown[][] = []
  const dependencies: Record<string, unknown> = {
    electron: { contextBridge: { exposeInMainWorld: (_name: string, value: ElectronAPI) => { api = value } },
      webUtils: { getPathForFile: (file: { nativePath?: string }) => file.nativePath ?? '' },
      ipcRenderer: { on() {}, invoke: async (...args: unknown[]) => { calls.push(args); return { success: true } } } },
    '../src/shared/attachment-contracts': contracts, './controller/channels': channels,
    './common/window-layout': { getWindowChromeConfig }, '../src/shared/window-close': {},
  }
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const document = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: (event: unknown) => void) { listeners.get(type)?.delete(listener) },
  }
  compileFunction(compiled, ['require', 'exports', 'process', 'globalThis'])((id: string) => {
    assert.ok(Object.hasOwn(dependencies, id), id)
    return dependencies[id]
  }, {}, { platform: 'win32' }, { document })
  return { api, calls, dispatch: (type: string, event: unknown) => { for (const listener of listeners.get(type) ?? []) listener(event) } }
}

test('the preload previews only a trusted clipboard path bound to the current composer', async () => {
  const { api, calls, dispatch } = mockAttachmentPreload()
  let pasteId: string | null = null
  const binding = { composerId: 'compose', sessionId: 'session', target: { kind: 'compose' as const, composerId: 'compose' } }
  const dispose = api.bindAttachmentPaste(Object.freeze({ ...binding, onFolderPaste: id => { pasteId = id } }))
  const clipboardData = { getData: () => '"D:\\商品 素材"', files: [] }
  const target = { matches: () => true, closest: () => ({ getAttribute: () => binding.composerId }) }
  dispatch('paste', { isTrusted: false, target, clipboardData })
  assert.equal(pasteId, null)
  dispatch('paste', { isTrusted: true, target, clipboardData, preventDefault: () => assert.fail('plain text paste must be preserved') })
  assert.ok(pasteId)
  assert.deepEqual(calls, [])
  const request = { composerId: binding.composerId, sessionId: binding.sessionId, pasteId }
  assert.deepEqual(await api.previewAttachmentFolder({ ...request, sessionId: 'another-session' }), { success: false })
  assert.deepEqual(await api.previewAttachmentFolder(request), { success: true })
  assert.deepEqual(calls, [[INVOKE_CHANNELS.ATTACHMENT_FOLDER_PREVIEW, { sessionId: 'session', path: 'D:\\商品 素材' }]])
  dispose()
  assert.deepEqual(await api.previewAttachmentFolder(request), { success: false })
})

test('trusted file drops batch only native files into the active, matching composer session', async () => {
  const { api, calls, dispatch } = mockAttachmentPreload()
  const events: Parameters<Parameters<ElectronAPI['onAttachmentPaste']>[0]>[0][] = []
  const unsubscribe = api.onAttachmentPaste(event => events.push(event))
  let enabled = true
  const dispose = api.bindAttachmentPaste({ composerId: 'compose', sessionId: 'session', target: { kind: 'compose', composerId: 'compose' }, isEnabled: () => enabled })
  const files = ['D:\\report.txt', 'D:\\image.png'].map(nativePath => ({ nativePath }))
  const drop = ({ isTrusted = true, composer = 'compose', disabled = false, payload = files }: { isTrusted?: boolean; composer?: string; disabled?: boolean; payload?: object[] } = {}) => {
    let prevented = false
    dispatch('drop', { isTrusted, dataTransfer: { files: payload }, preventDefault: () => { prevented = true },
      target: { closest: (selector: string) => selector === '[data-attachment-drop-zone]' ? {
        getAttribute: (name: string) => name === 'data-attachment-drop-zone' ? composer : disabled ? '' : null,
      } : null } })
    return prevented
  }
  assert.equal(drop({ isTrusted: false }), false)
  assert.equal(drop({ composer: 'other' }), false)
  assert.equal(drop({ payload: [] }), false)
  assert.equal(drop({ disabled: true }), true)
  enabled = false
  assert.equal(drop(), true)
  assert.deepEqual(calls, [])
  assert.equal(events.length, 0)

  enabled = true
  assert.equal(drop({ payload: [...files, { path: 'D:\\spoofed.txt' }] }), true)
  assert.equal(events[1]?.status, 'failed')
  assert.match(events[1]?.error ?? '', /无法读取拖入的文件/)
  events.length = 0
  assert.equal(drop({ payload: Array(11).fill(files[0]) }), true)
  assert.equal(events[1]?.status, 'failed')
  assert.match(events[1]?.error ?? '', /10 个附件/)
  assert.deepEqual(calls, [])
  events.length = 0

  assert.equal(drop(), true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(events.map(event => event.status), ['started', 'completed'])
  assert.deepEqual(events.map(event => event.source), ['drop', 'drop'])
  const operationId = events[0]?.operationId
  assert.ok(operationId)
  assert.equal(events[1]?.operationId, operationId)
  assert.deepEqual(calls, [[INVOKE_CHANNELS.ATTACHMENT_IMPORT_FILES, { sessionId: 'session', operationId, paths: files.map(file => file.nativePath) }]])
  dispose()
  unsubscribe()
  assert.equal(drop(), false)
  assert.equal(calls.length, 1)
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

test('preview checks task access before reading attachment bytes', async () => {
  const preview = routes().find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_PREVIEW)!
  const input = { taskId: 'task-a', attachmentId: 'image-a', sha256: 'a'.repeat(64) }
  const calls: string[] = []
  const data = { bytes: new Uint8Array([1]), mediaType: 'image/png' }
  const ctx = {
    tasks: { async get(id: string) { assert.equal(id, input.taskId); calls.push('authorize'); return {} } },
    attachments: { async previewTaskAttachment(...args: string[]) { assert.deepEqual(args, Object.values(input)); calls.push('read'); return data } },
  }
  assert.deepEqual(await preview.handle(ctx as never, input as never), { success: true, data })
  assert.deepEqual(calls, ['authorize', 'read'])
  ctx.tasks.get = async () => { throw new AppError('NOT_FOUND') }
  calls.length = 0
  await assert.rejects(async () => preview.handle(ctx as never, input as never))
  assert.deepEqual(calls, [])
})

test('draft image preview routes only through the scoped attachment service', async () => {
  const preview = routes().find(route => route.channel === INVOKE_CHANNELS.ATTACHMENT_PREVIEW)!
  const input = { sessionId: 'session-a', attachmentId: 'image-a', sha256: 'a'.repeat(64) }
  const data = { bytes: new Uint8Array([1]), mediaType: 'image/png' }
  const ctx = { attachments: { async previewDraftAttachment(...args: string[]) { assert.deepEqual(args, Object.values(input)); return data } } }
  assert.deepEqual(await preview.handle(ctx as never, input as never), { success: true, data })
})
