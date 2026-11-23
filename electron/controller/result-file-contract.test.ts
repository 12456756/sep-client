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
  const copied: string[] = []
  const savedPath = 'D:/generated/2026-11-23/report/report.md'
  const dependencies: Record<string, unknown> = {
    electron: { clipboard: { writeText: (path: string) => copied.push(path) } }, '../../errors/app-error': {},
    '../../../src/shared/result-files': contracts, '../channels': { INVOKE_CHANNELS },
    '../router': { route: (channel: string, schema: z.ZodType, handle: Route['handle'], options: unknown) => ({ channel, schema, handle, options }) },
  }
  compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => { assert.ok(Object.hasOwn(dependencies, id), id); return dependencies[id] }, module.exports, module)
  const routes = module.exports.resultFileRoutes
  assert.equal(routes.length, 5)
  const calls: string[] = []
  const failed = { state: 'failed', message: '原文件已生成。保存位置空间不足，请释放空间或换个文件夹后重试。' }
  const ctx = { resultFiles: { async preview() { calls.push('preview'); return { url: 'url' } }, async release() { calls.push('release') }, async reveal() { calls.push('reveal') },
    async archiveStatus() { calls.push('status'); return failed },
    async copyPath(file: unknown, write: (path: string) => void) {
      assert.deepEqual(file, { taskId: 'task', fileId: 'task-file-0' }); calls.push('copy-path'); write(savedPath)
    },
    async retryArchive(_file: unknown, confirmation?: string) { calls.push(confirmation ?? 'retry') } } }
  for (const route of routes) {
    assert.deepEqual(route.options, { trustedMainFrame: true })
    if (route.channel === INVOKE_CHANNELS.RESULT_FILE_ACTION) {
      const file = { taskId: 'task', attachmentId: 'att', sha256: 'a'.repeat(64) }
      for (const action of ['open', 'copy-path', 'save-as']) {
        assert.equal(route.schema.safeParse({ action, file }).success, true)
        assert.equal(route.schema.safeParse({ action, file: { ...file, path: 'C:/private' } }).success, false)
        assert.equal(route.schema.safeParse({ action, file, destination: 'C:/private' }).success, false)
      }
      assert.equal(route.schema.safeParse({ action: 'attach', file, sessionId: 'session' }).success, true)
      assert.equal(route.schema.safeParse({ action: 'attach', file, sessionId: '../session' }).success, false)
      const retry = { action: 'retry-archive-elsewhere', file: { taskId: 'task', fileId: 'task-file-0' }, confirmation: 'c'.repeat(64) }
      const confirmed = route.schema.safeParse(retry)
      assert.equal(confirmed.success, true)
      assert.equal(route.schema.safeParse({ ...retry, confirmation: true }).success, false)
      assert.equal(route.schema.safeParse({ ...retry, destination: '/private/path' }).success, false)
      assert.equal(route.schema.safeParse({ action: 'retry-archive', file: retry.file, confirmation: retry.confirmation }).success, false)
      assert.deepEqual(await route.handle(ctx as never, confirmed.data as never), { success: true })
      const copy = route.schema.parse({ action: 'copy-path', file: retry.file })
      assert.deepEqual(await route.handle(ctx as never, copy as never), { success: true })
      continue
    }
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
    const result = await route.handle(ctx as never, input as never) as { success: boolean; data?: unknown }
    assert.equal(result.success, true)
    if (route.channel === INVOKE_CHANNELS.RESULT_FILE_SAVE_STATUS) assert.deepEqual(result.data, failed)
  }
  assert.deepEqual(calls, ['preview', 'release', 'reveal', 'status', 'c'.repeat(64), 'copy-path'])
  assert.deepEqual(copied, [savedPath])
})
