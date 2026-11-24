import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import type { RetainedAttachmentState, AttachmentComposerOptions } from './use-attachment-composer'

// Hook lifecycle harness: no browser is needed to check session ownership and IPC calls.
function mountHook(api: unknown, options: AttachmentComposerOptions) {
  const cells: unknown[] = []
  let cursor = 0
  let pending: (() => void)[] = []
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  const effect = (run: () => void | (() => void), deps: unknown[] = []) => {
    const index = cursor++
    const old = effects.get(index)
    if (old && old.deps.length === deps.length && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return
    pending.push(() => { old?.cleanup?.(); effects.set(index, { deps, cleanup: run() || undefined }) })
  }
  const react = {
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in cells)) cells[index] = initial
      return [cells[index], (value: unknown) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef: (initial: unknown) => { const index = cursor++; return cells[index] ??= { current: initial } },
    useEffect: effect, useLayoutEffect: effect,
    useCallback: (callback: unknown, deps: unknown[]) => {
      const index = cursor++
      const previous = cells[index] as { callback: unknown; deps: unknown[] } | undefined
      if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return previous.callback
      cells[index] = { callback, deps }
      return callback
    },
  }
  const filename = new URL('./use-attachment-composer.ts', import.meta.url)
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  compileFunction(output, ['require', 'module', 'exports', 'window'], { filename: filename.pathname })(() => react, module, module.exports, { electronAPI: api })
  const { useAttachmentComposer: executeHook } = module.exports as typeof import('./use-attachment-composer')
  return {
    render() { cursor = 0; pending = []; const result = executeHook(options); pending.forEach(run => run()); return result },
    unmount() { effects.forEach(item => item.cleanup?.()); effects.clear() },
  }
}

test('restores and rebinds retained attachments without starting or cancelling their session on work switch', () => {
  let began = 0
  let cancelled = 0
  let unbound = 0
  const bound: string[] = []
  const retained = { session: { sessionId: 'session-a', status: 'open', attachments: [] }, attachments: [{ attachmentId: 'file-a' }] } as unknown as RetainedAttachmentState
  const api = { beginAttachmentImport: () => { began++; return Promise.resolve({ success: false }) }, cancelAttachmentImport: () => { cancelled++; return Promise.resolve({ success: true }) }, bindAttachmentPaste: (input: { sessionId: string }) => { bound.push(input.sessionId); return () => { unbound++ } } }
  const options = { target: { kind: 'compose' as const, composerId: 'work-a' }, bindingKey: 'scope-a', retainedState: retained }
  const first = mountHook(api, options)
  const original = first.render()
  assert.equal(original.session?.sessionId, 'session-a')
  assert.equal(original.attachments[0]?.attachmentId, 'file-a')
  first.unmount()
  assert.equal(cancelled, 0)
  assert.equal(unbound, 1)
  const restored = mountHook(api, options)
  assert.equal(restored.render().attachments[0]?.attachmentId, 'file-a')
  assert.deepEqual(bound, ['session-a', 'session-a'])
  assert.equal(began, 0)
  restored.unmount()
})

test('ordinary composers still cancel their open import session on unmount', async () => {
  const cancelled: string[] = []
  const api = { beginAttachmentImport: async () => ({ success: true, data: { sessionId: 'ordinary', status: 'open', attachments: [] } }), cancelAttachmentImport: async (input: { sessionId: string }) => { cancelled.push(input.sessionId) } }
  const hook = mountHook(api, { target: { kind: 'compose', composerId: 'new' } })
  hook.render()
  await Promise.resolve()
  assert.equal(hook.render().session?.sessionId, 'ordinary')
  hook.unmount()
  assert.deepEqual(cancelled, ['ordinary'])
})

test('file import keeps the composer busy until the refreshed attachments are available', async () => {
  type Event = { composerId: string; sessionId: string; operationId: string; status: 'started' | 'completed' }
  let receive!: (event: Event) => void
  let refresh!: (result: unknown) => void
  const session = { sessionId: 'session-a', status: 'open', attachments: [] }
  const retained = { session, attachments: [] } as unknown as RetainedAttachmentState
  const hook = mountHook({
    onAttachmentPaste: (callback: typeof receive) => { receive = callback; return () => {} },
    listAttachments: () => new Promise(resolve => { refresh = resolve }),
  }, { target: { kind: 'compose', composerId: 'drop' }, retainedState: retained })
  hook.render()
  const event = { composerId: 'drop', sessionId: session.sessionId, operationId: 'drop-a' }
  receive({ ...event, status: 'started' })
  assert.equal(hook.render().busy, true)
  receive({ ...event, status: 'completed' })
  assert.equal(hook.render().busy, true)
  refresh({ success: true, data: [{ attachmentId: 'dropped-file' }] })
  await new Promise<void>(resolve => setImmediate(resolve))
  const result = hook.render()
  assert.equal(result.busy, false)
  assert.equal(result.attachments[0]?.attachmentId, 'dropped-file')
  hook.unmount()
})

test('pasted folders wait for preview and explicit selection without changing attachments on cancel', async () => {
  const session = { sessionId: 'folder-session', status: 'open', attachments: [] } as unknown as NonNullable<RetainedAttachmentState['session']>
  const preview = { previewId: 'preview-a', folderName: '素材', candidates: [{ id: 'clip', name: 'clip.mp4', byteLength: 100, kind: 'video' }], truncated: false }
  const added = { attachmentId: 'video-attachment' }
  const calls: unknown[] = []
  let paste: ((id: string | null) => void) | undefined
  const hook = mountHook({ platform: 'win32', bindAttachmentPaste: (input: { onFolderPaste?: typeof paste }) => { paste = input.onFolderPaste; return () => {} },
    previewAttachmentFolder: async (input: unknown) => { calls.push(input); return { success: true, data: preview } },
    importAttachmentFolder: async (input: unknown) => { calls.push(input); return { success: true, data: { ...session, attachments: [added] } } },
  }, { target: { kind: 'compose', composerId: 'folder-composer' }, retainedState: { session, attachments: [] }, allowFolderPaste: true })
  hook.render()
  assert.ok(paste)
  paste('paste-a')
  assert.equal(hook.render().folderPaste, true)
  assert.deepEqual(calls, [])
  await hook.render().viewFolder()
  assert.deepEqual(calls, [{ composerId: 'folder-composer', sessionId: 'folder-session', pasteId: 'paste-a' }])
  assert.equal(hook.render().folderPreview, preview)
  hook.render().closeFolder()
  assert.equal(hook.render().folderPreview, null)
  assert.deepEqual(hook.render().attachments, [])
  await hook.render().viewFolder()
  await hook.render().importFolder(['clip'])
  assert.deepEqual(calls.at(-1), { sessionId: 'folder-session', previewId: 'preview-a', candidateIds: ['clip'] })
  assert.deepEqual(hook.render().attachments, [added])
  assert.equal(hook.render().folderPaste, false)
  hook.unmount()
})

test('adding a result targets the active compose session and updates the draft attachment list', async () => {
  const session = { sessionId: 'draft-session', status: 'open', attachments: [] } as unknown as NonNullable<RetainedAttachmentState['session']>
  const retained: RetainedAttachmentState = { session, attachments: [] }
  const calls: unknown[] = []
  const file = { taskId: 'result-task', fileId: 'result-task-file-0' }
  const attachment = { attachmentId: 'added-file' }
  const hook = mountHook({ runResultFileAction: async (input: unknown) => {
    calls.push(input)
    return { success: true, data: { ...session, attachments: [attachment] } }
  } }, { target: { kind: 'compose', composerId: 'current' }, retainedState: retained })
  await hook.render().addFile(file)
  assert.deepEqual(calls, [{ action: 'attach', file, sessionId: 'draft-session' }])
  assert.deepEqual(hook.render().attachments, [attachment])
  assert.deepEqual(retained.attachments, [attachment])
  hook.unmount()
})

test('a late session created after unmount is cancelled even when retaining drafts', async () => {
  let resolve!: (value: unknown) => void
  const result = new Promise(done => { resolve = done })
  const cancelled: string[] = []
  const api = { beginAttachmentImport: () => result, cancelAttachmentImport: async (input: { sessionId: string }) => { cancelled.push(input.sessionId) } }
  const retained: RetainedAttachmentState = { session: null, attachments: [] }
  const hook = mountHook(api, { target: { kind: 'compose', composerId: 'late' }, retainedState: retained })
  hook.render()
  hook.unmount()
  resolve({ success: true, data: { sessionId: 'late-session', status: 'open', attachments: [] } })
  await Promise.resolve()
  assert.deepEqual(cancelled, ['late-session'])
  assert.equal(retained.session, null)
})

test('a failed automatic import session reports once and only retries on explicit selection', async () => {
  let calls = 0
  const errors: string[] = []
  const hook = mountHook({ beginAttachmentImport: async () => { calls++; return { success: false, error: { message: '附件会话创建失败，请联系平台管理员' } } } }, {
    target: { kind: 'compose', composerId: 'failed' }, onError: message => errors.push(message),
  })
  hook.render()
  await Promise.resolve()
  hook.render()
  hook.render()
  assert.equal(calls, 1)
  assert.equal(errors.length, 1)
  await hook.render().select()
  assert.equal(calls, 2)
  hook.unmount()
})

test('effect replay restarts an interrupted initialization and cancels its stale session', async () => {
  const pending: Array<(result: unknown) => void> = []
  const cancelled: string[] = []
  const hook = mountHook({
    beginAttachmentImport: () => new Promise(resolve => pending.push(resolve)),
    cancelAttachmentImport: async ({ sessionId }: { sessionId: string }) => { cancelled.push(sessionId) },
  }, { target: { kind: 'compose', composerId: 'strict' } })
  hook.render()
  hook.unmount()
  hook.render()
  assert.equal(pending.length, 2)
  pending[0]({ success: true, data: { sessionId: 'stale', status: 'open', attachments: [] } })
  pending[1]({ success: true, data: { sessionId: 'current', status: 'open', attachments: [] } })
  await Promise.resolve()
  assert.equal(hook.render().session?.sessionId, 'current')
  assert.deepEqual(cancelled, ['stale'])
  hook.unmount()
})

test('late failures after composer disposal do not notify the next page', async () => {
  let reject!: (reason: unknown) => void
  const errors: string[] = []
  const hook = mountHook({ beginAttachmentImport: () => new Promise((_resolve, fail) => { reject = fail }) }, {
    target: { kind: 'compose', composerId: 'stale' }, onError: message => errors.push(message),
  })
  hook.render()
  hook.unmount()
  reject(new Error('private diagnostics'))
  await Promise.resolve()
  assert.deepEqual(errors, [])
})
