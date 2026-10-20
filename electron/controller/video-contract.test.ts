/** 视频 IPC 契约：转译真实 routes/router，仅注入 Electron 与服务替身。 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compileFunction } from 'node:vm'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { z } from 'zod'
import { INVOKE_CHANNELS } from './channels'
import { AppError, appError } from '../errors/app-error'
import type { RequestContext } from './request-context'
import type { Route } from './router'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const taskId = 'task-a'
const jobId = 'job-a'
const outputId = 'output-a'
const channels = [
  INVOKE_CHANNELS.VIDEO_GET_TASK, INVOKE_CHANNELS.VIDEO_GET_REFERENCES, INVOKE_CHANNELS.VIDEO_IMPORT_REFERENCES,
  INVOKE_CHANNELS.VIDEO_GENERATE, INVOKE_CHANNELS.VIDEO_PREVIEW, INVOKE_CHANNELS.VIDEO_EXPORT,
  INVOKE_CHANNELS.VIDEO_RESUME, INVOKE_CHANNELS.VIDEO_RETRY_SAVE,
]

function loadSource<T>(path: string, dependencies: Record<string, unknown> = {}): T {
  const input = readFileSync(join(root, path), 'utf8')
  const compiled = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: path,
  }).outputText
  const module = { exports: {} }
  const requireStub = (id: string): unknown => {
    assert.ok(Object.hasOwn(dependencies, id), `unexpected runtime import: ${id}`)
    return dependencies[id]
  }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename: path })(requireStub, module.exports, module)
  return module.exports as T
}

function loadRoutes(dialog: Record<string, (...args: unknown[]) => unknown> = {}) {
  const routes = loadSource<{ videoRoutes: readonly Route[] }>('electron/controller/routes/video.ts', {
    electron: { dialog }, zod: { z },
    '../../../src/shared/video-host': { videoGenerationInputSchema: z.object({
      profileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      operation: z.enum(['image-to-video', 'text-to-video']),
      localAssetIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(4),
      creativeBrief: z.string().trim().min(1).max(4000),
      parameters: z.object({
        durationSeconds: z.number().int().positive().max(600), aspectRatio: z.string().regex(/^\d+:\d+$/),
        resolution: z.enum(['480p', '720p', '1080p', '4k']), frameRate: z.number().int().positive().max(120),
        audio: z.boolean(), outputFormat: z.enum(['video/mp4', 'video/webm']),
      }).strict(),
    }).strict() },
    '../../domain/video-media': { videoLocalIdSchema: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) },
    '../../errors/app-error': { appError, AppError },
    '../channels': { INVOKE_CHANNELS },
    '../router': { route: (channel: string, schema: z.ZodType, handle: Route['handle'], options = {}) => ({ channel, schema, handle, ...options }) },
  }).videoRoutes
  assert.ok(routes)
  return routes
}

type Call = { method: string; args: unknown[] }
function harness(options: {
  video?: Record<string, (...args: unknown[]) => unknown>
  open?: { canceled: boolean; filePaths: string[] }
  save?: { canceled: boolean; filePath?: string }
  preview?: unknown
} = {}) {
  const calls: Call[] = []
  let importCalls = 0
  let exportCalls = 0
  let openCalls = 0
  let saveCalls = 0
  const selection = {
    import: async (...args: unknown[]) => { importCalls++; calls.push({ method: 'import', args }); return ['asset-a'] },
    export: async (...args: unknown[]) => { exportCalls++; calls.push({ method: 'export', args }) },
  }
  const video = Object.fromEntries([
    ['getTaskVideo', async (...args: unknown[]) => { calls.push({ method: 'getTaskVideo', args }); return { mock: true } }],
    ['getReferences', async (...args: unknown[]) => { calls.push({ method: 'getReferences', args }); return [] }],
    ['nativeSelection', async (...args: unknown[]) => { calls.push({ method: 'nativeSelection', args }); return selection }],
    ['generate', async (...args: unknown[]) => { calls.push({ method: 'generate', args }); return { jobId } }],
    ['preview', async (...args: unknown[]) => { calls.push({ method: 'preview', args }); return options.preview ?? { mime: 'video/mp4' } }],
    ['outputInfo', async (...args: unknown[]) => { calls.push({ method: 'outputInfo', args }); return { mimeType: (options.preview as { mime?: string } | undefined)?.mime ?? 'video/mp4' } }],
    ['resume', async (...args: unknown[]) => { calls.push({ method: 'resume', args }) }],
    ['retrySave', async (...args: unknown[]) => { calls.push({ method: 'retrySave', args }) }],
    ['track', async (...args: unknown[]) => { calls.push({ method: 'track', args }) }],
  ])
  const dialog = {
    showOpenDialog: async (...args: unknown[]) => { openCalls++; calls.push({ method: 'showOpenDialog', args }); return options.open ?? { canceled: false, filePaths: ['/native/reference.png'] } },
    showSaveDialog: async (...args: unknown[]) => { saveCalls++; calls.push({ method: 'showSaveDialog', args }); return options.save ?? { canceled: false, filePath: '/native/export.mp4' } },
  }
  const routes = loadRoutes(dialog)
  const ctx = {
    video: Object.hasOwn(options, 'video') ? options.video : video,
    window: () => ({ nativeWindow: true }),
  } as unknown as RequestContext
  return {
    calls, routes, ctx, get counts() { return { importCalls, exportCalls, openCalls, saveCalls } },
    async invoke(channel: string, input: unknown) {
      const route = routes.find(candidate => candidate.channel === channel)
      assert.ok(route, `missing video route ${channel}`)
      const parsed = route.schema.safeParse(input)
      if (!parsed.success) return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'invalid' } }
      try { return await route.handle(ctx, parsed.data as never) }
      catch (error) {
        return { success: false, error: { code: (error as { code?: string }).code ?? 'INTERNAL_ERROR', message: 'mapped' } }
      }
    },
  }
}

const generation = {
  profileId: 'profile-a', operation: 'image-to-video', localAssetIds: ['asset-a'], creativeBrief: 'Make a short product video',
  parameters: { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' },
}

describe('video IPC contract', () => {
  it('defaults request context video to backend composition and preserves explicit harness injection', () => {
    const { createRequestContext } = loadSource<{ createRequestContext: typeof import('./request-context').createRequestContext }>('electron/controller/request-context.ts')
    const video = {} as NonNullable<RequestContext['video']>
    const backend = { video } as RequestContext['backend']
    assert.equal(createRequestContext(backend, () => null).video, video)
    const override = {} as NonNullable<RequestContext['video']>
    assert.equal(createRequestContext(backend, () => null, undefined, override).video, override)
    assert.equal(createRequestContext({} as RequestContext['backend'], () => null).video, undefined)
  })
  it('hides missing or revoked optional video while retaining storage errors', async () => {
    const denied = harness({ video: { getTaskVideo: async () => { throw new AppError('PERMISSION_DENIED') } } })
    assert.deepEqual(await denied.invoke(INVOKE_CHANNELS.VIDEO_GET_TASK, taskId), { success: true, data: null })
    const failed = harness({ video: { getTaskVideo: async () => { throw new Error('Disk unavailable') } } })
    assert.equal((await failed.invoke(INVOKE_CHANNELS.VIDEO_GET_TASK, taskId) as { error: { code: string } }).error.code, 'INTERNAL_ERROR')
  })
  it('declares all video routes with ordinary IPC error envelopes', () => {
    const test = harness()
    assert.deepEqual(test.routes.map(route => route.channel), channels)
    for (const route of test.routes) assert.equal(route.errorShape, 'ipc')
  })

  it('keeps production-default task reads empty and rejects commands before any native dialog', async () => {
    const test = harness({ video: undefined })
    assert.deepEqual(await test.invoke(INVOKE_CHANNELS.VIDEO_GET_TASK, taskId), { success: true, data: null })
    for (const channel of [INVOKE_CHANNELS.VIDEO_GET_REFERENCES, INVOKE_CHANNELS.VIDEO_IMPORT_REFERENCES,
      INVOKE_CHANNELS.VIDEO_GENERATE, INVOKE_CHANNELS.VIDEO_PREVIEW, INVOKE_CHANNELS.VIDEO_EXPORT,
      INVOKE_CHANNELS.VIDEO_RESUME, INVOKE_CHANNELS.VIDEO_RETRY_SAVE]) {
      const input = channel === INVOKE_CHANNELS.VIDEO_GENERATE ? { taskId, input: generation }
        : channel === INVOKE_CHANNELS.VIDEO_PREVIEW || channel === INVOKE_CHANNELS.VIDEO_EXPORT
          ? { taskId, jobId, outputId } : channel === INVOKE_CHANNELS.VIDEO_RESUME || channel === INVOKE_CHANNELS.VIDEO_RETRY_SAVE
            ? { taskId, jobId } : taskId
      assert.deepEqual(await test.invoke(channel, input), { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'mapped' } })
    }
    assert.deepEqual(test.counts, { importCalls: 0, exportCalls: 0, openCalls: 0, saveCalls: 0 })
  })

  it('strictly rejects paths, remote references, traversal IDs and extra fields before handlers execute', async () => {
    const test = harness()
    const cases: Array<[string, unknown]> = [
      [INVOKE_CHANNELS.VIDEO_GET_TASK, '../task'],
      [INVOKE_CHANNELS.VIDEO_GET_REFERENCES, '/private/task'],
      [INVOKE_CHANNELS.VIDEO_IMPORT_REFERENCES, { taskId, path: '/private/reference.png' }],
      [INVOKE_CHANNELS.VIDEO_GENERATE, { taskId, input: { ...generation, localAssetIds: ['../remote-ref'] } }],
      [INVOKE_CHANNELS.VIDEO_GENERATE, { taskId, input: { ...generation, referenceIds: ['remote-ref'] } }],
      [INVOKE_CHANNELS.VIDEO_GENERATE, { taskId, input: { ...generation, ...{ path: '/private/x' } } }],
      [INVOKE_CHANNELS.VIDEO_GENERATE, { taskId, input: { ...generation, parameters: { ...generation.parameters, path: '/private/x' } } }],
      [INVOKE_CHANNELS.VIDEO_PREVIEW, { taskId, jobId: '../job', outputId }],
      [INVOKE_CHANNELS.VIDEO_PREVIEW, { taskId, jobId, outputId: '../output' }],
      [INVOKE_CHANNELS.VIDEO_PREVIEW, { taskId, jobId, outputId, receiptId: 'remote-receipt' }],
      [INVOKE_CHANNELS.VIDEO_EXPORT, { taskId, jobId, outputId, path: '/private/export.mp4' }],
      [INVOKE_CHANNELS.VIDEO_RESUME, { taskId, jobId: '../job' }],
      [INVOKE_CHANNELS.VIDEO_RETRY_SAVE, { taskId, jobId, receiptId: 'receipt' }],
    ]
    for (const [channel, input] of cases) {
      const result = await test.invoke(channel, input) as { error?: { code?: string } }
      assert.equal(result.error?.code, 'INVALID_ARGUMENT', `${channel}: ${JSON.stringify(input)}`)
    }
    assert.deepEqual(test.calls, [])
    assert.deepEqual(test.counts, { importCalls: 0, exportCalls: 0, openCalls: 0, saveCalls: 0 })
  })

  it('task/reference reads and preview never start tracker recovery', async () => {
    const test = harness()
    assert.deepEqual(await test.invoke(INVOKE_CHANNELS.VIDEO_GET_TASK, taskId), { success: true, data: { mock: true } })
    assert.deepEqual(await test.invoke(INVOKE_CHANNELS.VIDEO_GET_REFERENCES, taskId), { success: true, data: [] })
    assert.deepEqual(await test.invoke(INVOKE_CHANNELS.VIDEO_PREVIEW, { taskId, jobId, outputId }), { success: true, data: { mime: 'video/mp4' } })
    assert.deepEqual(test.calls.map(call => call.method), ['getTaskVideo', 'getReferences', 'preview'])
  })

  it('starts tracking exactly once after each successful generate, resume or retry-save', async () => {
    for (const [channel, input, method] of [
      [INVOKE_CHANNELS.VIDEO_GENERATE, { taskId, input: generation }, 'generate'],
      [INVOKE_CHANNELS.VIDEO_RESUME, { taskId, jobId }, 'resume'],
      [INVOKE_CHANNELS.VIDEO_RETRY_SAVE, { taskId, jobId }, 'retrySave'],
    ] as const) {
      const test = harness()
      await test.invoke(channel, input)
      assert.deepEqual(test.calls.map(call => call.method), [method, 'track'])
      assert.deepEqual(test.calls.filter(call => call.method === 'track').map(call => call.args), [[taskId]])
    }
  })

  it('does not start tracking when a mutating host command fails', async () => {
    for (const [channel, input, method] of [
      [INVOKE_CHANNELS.VIDEO_GENERATE, { taskId, input: generation }, 'generate'],
      [INVOKE_CHANNELS.VIDEO_RESUME, { taskId, jobId }, 'resume'],
      [INVOKE_CHANNELS.VIDEO_RETRY_SAVE, { taskId, jobId }, 'retrySave'],
    ] as const) {
      const video = { [method]: async () => { throw Object.assign(new Error('host failed'), { code: 'PERMISSION_DENIED' }) } }
      const test = harness({ video })
      assert.equal((await test.invoke(channel, input) as { error: { code: string } }).error.code, 'PERMISSION_DENIED')
      assert.deepEqual(test.calls.map(call => call.method), [])
    }
  })

  it('native dialog cancellation does not import or export files', async () => {
    const importing = harness({ open: { canceled: true, filePaths: ['/ignored.png'] } })
    assert.deepEqual(await importing.invoke(INVOKE_CHANNELS.VIDEO_IMPORT_REFERENCES, taskId), { success: true, data: [] })
    assert.equal(importing.counts.openCalls, 1)
    assert.equal(importing.counts.importCalls, 0)

    const exporting = harness({ save: { canceled: true } })
    assert.deepEqual(await exporting.invoke(INVOKE_CHANNELS.VIDEO_EXPORT, { taskId, jobId, outputId }), { success: true, cancelled: true })
    assert.equal(exporting.counts.saveCalls, 1)
    assert.equal(exporting.counts.exportCalls, 0)
    assert.deepEqual(exporting.calls.map(call => call.method), ['nativeSelection', 'outputInfo', 'showSaveDialog'])
  })

  it('authorizes selection before dialogs and previews export before saving in the expected order', async () => {
    const importing = harness({ open: { canceled: false, filePaths: ['/native/reference.png'] } })
    assert.deepEqual(await importing.invoke(INVOKE_CHANNELS.VIDEO_IMPORT_REFERENCES, taskId), { success: true, data: ['asset-a'] })
    assert.deepEqual(importing.calls.map(call => call.method), ['nativeSelection', 'showOpenDialog', 'import'])
    assert.deepEqual(importing.calls.at(-1)?.args, [['/native/reference.png']])

    for (const [mime, extension] of [['video/mp4', 'mp4'], ['video/webm', 'webm']]) {
      const exporting = harness({ preview: { mime }, save: { canceled: false, filePath: `/native/export.${extension}` } })
      assert.deepEqual(await exporting.invoke(INVOKE_CHANNELS.VIDEO_EXPORT, { taskId, jobId, outputId }), { success: true, cancelled: false })
      assert.deepEqual(exporting.calls.map(call => call.method), ['nativeSelection', 'outputInfo', 'showSaveDialog', 'export'])
      const dialogArgs = exporting.calls[2].args[1] as { defaultPath: string; filters: Array<{ extensions: string[] }> }
      assert.equal(dialogArgs.defaultPath, `${outputId}.${extension}`)
      assert.deepEqual(dialogArgs.filters[0].extensions, [extension])
      assert.deepEqual(exporting.calls[3].args, [jobId, outputId, `/native/export.${extension}`])
    }
  })

  it('returns mapped plain IPC errors without authenticated flags or host details', async () => {
    const video = { getReferences: async () => { throw new Error('private path /Users/private/video.mp4') } }
    const test = harness({ video })
    const result = await test.invoke(INVOKE_CHANNELS.VIDEO_GET_REFERENCES, taskId) as Record<string, unknown>
    assert.deepEqual(Object.keys(result), ['success', 'error'])
    assert.equal('authenticated' in result, false)
    assert.deepEqual(result.error, { code: 'INTERNAL_ERROR', message: 'mapped' })
    assert.deepEqual(test.calls.map(call => call.method), [])
  })
})
