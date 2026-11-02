import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'

function mountPreview(api: unknown, request: import('../../shared/result-files').ResultFileRequest = { taskId: 'task-a', nodeId: 'node-a', deliverableId: 'image-a' }) {
  const states: unknown[] = []
  let cursor = 0
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  let pending: Array<() => void> = []
  const react = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useEffect(run: () => void | (() => void), deps: unknown[]) {
      const index = cursor++
      const old = effects.get(index)
      if (old && deps.every((value, i) => Object.is(value, old.deps[i]))) return
      pending.push(() => { old?.cleanup?.(); effects.set(index, { deps, cleanup: run() || undefined }) })
    },
    useRef(initial: unknown) {
      const index = cursor++
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
  }
  const filename = new URL('./use-result-file-preview.ts', import.meta.url)
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  compileFunction(output, ['require', 'module', 'exports', 'window'], { filename: filename.pathname })(() => react, module, module.exports, { electronAPI: api })
  const { useResultFilePreview: executeHook } = module.exports as typeof import('./use-result-file-preview')
  return {
    render() { cursor = 0; pending = []; const result = executeHook(request, 'v1'); pending.forEach(run => run()); return result },
    unmount() { effects.forEach(effect => effect.cleanup?.()); effects.clear() },
  }
}

test('loads a result by delivery identity and releases its URL on unmount', async () => {
  const calls: unknown[] = [], released: string[] = []
  const preview = { url: 'sep-result://media/token-a', mime: 'image/png', kind: 'image' as const }
  const hook = mountPreview({ previewResultFile: async (input: unknown) => { calls.push(input); return { success: true, data: preview } }, releaseResultFilePreview: async ({ url }: { url: string }) => { released.push(url) } })
  hook.render()
  await Promise.resolve()
  assert.deepEqual(hook.render().preview, preview)
  assert.deepEqual(calls, [{ taskId: 'task-a', nodeId: 'node-a', deliverableId: 'image-a' }])
  hook.unmount()
  assert.deepEqual(released, [preview.url])
})

test('releases a preview that arrives after the result card closes', async () => {
  let resolve!: (value: unknown) => void
  const released: string[] = []
  const hook = mountPreview({ previewResultFile: () => new Promise(done => { resolve = done }), releaseResultFilePreview: async ({ url }: { url: string }) => { released.push(url) } })
  hook.render()
  hook.unmount()
  resolve({ success: true, data: { url: 'sep-result://media/late', mime: 'image/png', kind: 'image' } })
  await Promise.resolve()
  assert.deepEqual(released, ['sep-result://media/late'])
})

test('failed media loads stay retryable without keeping a stale URL', async () => {
  let calls = 0
  const hook = mountPreview({ previewResultFile: async () => { calls++; return { success: false, error: { message: '文件不存在' } } }, releaseResultFilePreview: async () => undefined })
  hook.render()
  await Promise.resolve()
  assert.equal(hook.render().error, '文件不存在')
  hook.render().retry()
  hook.render()
  await Promise.resolve()
  assert.equal(calls, 2)
  assert.equal(hook.render().preview, null)
  hook.unmount()
})

test('releases a decoded preview immediately on media failure and retries with a fresh lease', async () => {
  let calls = 0
  const released: string[] = []
  const hook = mountPreview({
    previewResultFile: async () => {
      calls++
      return { success: true, data: { url: `sep-result://media/token-${calls}`, mime: 'image/png', kind: 'image' } }
    },
    releaseResultFilePreview: async ({ url }: { url: string }) => { released.push(url) },
  })
  hook.render()
  await Promise.resolve()
  const loaded = hook.render()
  assert.equal(loaded.preview?.url, 'sep-result://media/token-1')

  loaded.fail()
  assert.equal(hook.render().preview, null)
  assert.equal(hook.render().error, '媒体无法显示，请重试或打开所在文件夹查看。')
  assert.deepEqual(released, ['sep-result://media/token-1'])

  hook.render().retry()
  hook.render()
  await Promise.resolve()
  assert.equal(hook.render().preview?.url, 'sep-result://media/token-2')
  hook.unmount()
  assert.deepEqual(released, ['sep-result://media/token-1', 'sep-result://media/token-2'])
})

test('preserves asset and video output identities when requesting a preview', async () => {
  const calls: unknown[] = []
  const preview = { url: 'sep-result://media/identity', mime: 'video/mp4', kind: 'video' as const }
  const assetHook = mountPreview({ previewResultFile: async (input: unknown) => { calls.push(input); return { success: true, data: preview } }, releaseResultFilePreview: async () => undefined }, { taskId: 'task-a', assetId: 'asset-a' })
  assetHook.render()
  await Promise.resolve()
  const videoHook = mountPreview({ previewResultFile: async (input: unknown) => { calls.push(input); return { success: true, data: preview } }, releaseResultFilePreview: async () => undefined }, { taskId: 'task-a', jobId: 'job-a', outputId: 'output-a' })
  videoHook.render()
  await Promise.resolve()
  assert.deepEqual(calls, [{ taskId: 'task-a', assetId: 'asset-a' }, { taskId: 'task-a', jobId: 'job-a', outputId: 'output-a' }])
})
