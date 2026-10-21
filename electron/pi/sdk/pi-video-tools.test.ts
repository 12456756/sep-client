import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { VideoHostTools, VideoToolName } from '../../domain/video-tools'
import type { VideoJobView, VideoTaskView } from '../../../src/shared/video-host'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import { buildExtensions, PiCodingAgentAdapter, sessionToolOptions } from './pi-coding-agent-adapter'
import { setLogSink } from '../../common/logger'
import { createPiVideoModelMock, PI_VIDEO_MODEL_MOCK_PROMPT } from '../../../scripts/pi-video-model-mock'
import * as videoFixture from '../../../src/shared/fixtures/media-video-v1.json'
import { videoRuntimeSchema } from '../../../src/shared/video-media'
import { AppError } from '../../errors/app-error'

const names: VideoToolName[] = ['video_from_image', 'video_generate', 'video_get_job']
const parameters = { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p' as const, frameRate: 24, audio: false, outputFormat: 'video/mp4' as const }
const generation = { profileId: 'profile-a', operation: 'text-to-video' as const, localAssetIds: [], creativeBrief: 'A product video', parameters }
const job: VideoJobView = {
  jobId: 'job-a', taskId: 'task-a', profileId: 'profile-a', operation: 'text-to-video', parameters,
  generationStatus: 'QUEUED', trackingStatus: 'ACTIVE', saveStatus: 'PENDING', billingStatus: 'MOCK_NOT_CHARGED',
  createdAt: 1, updatedAt: 2, error: null, outputs: [],
}
const output = {
  outputId: 'output-a', kind: 'video', mimeType: 'video/mp4', byteLength: 50, sha256: 'a'.repeat(64),
  durationSeconds: 5, width: 1280, height: 720, frameRate: 24, thumbnailOutputId: null, expiresAt: null,
}
const policy: NonNullable<PiAgentSessionConfig['toolPolicy']> = {
  preset: 'workspace-edit', allowedTools: ['read'], allowedPaths: [], deniedPaths: [],
  commandPolicy: 'disabled', approvalMode: 'confirm-each', workspaceDir: '/workspace',
}
const secrets = {
  apiKey: 'private-key', url: 'https://private.example/video', path: '/private/video.mp4',
  windowsPath: 'C:\\private\\video.mp4', request: { creativeBrief: 'secret Pi prompt' },
  receipt: { receiptId: 'remote-receipt' }, referenceIds: ['remote-reference'],
}
const sensitiveText = Object.values(secrets).map(value => JSON.stringify(value)).join(' ')

type Handler = (event: Record<string, unknown>) => unknown | Promise<unknown>

/** Mock only the SDK extension API; exercise the factories used by createSession. */
async function sdk(overrides: Partial<PiAgentSessionConfig> = {}, result: unknown = job) {
  const definitions = new Map<string, ToolDefinition>()
  const handlers = new Map<string, Handler[]>()
  const calls: Array<{ name: VideoToolName; input: unknown; signal?: AbortSignal }> = []
  const approvals: unknown[] = []
  const events: unknown[] = []
  const host: VideoHostTools = {
    names,
    async execute(name, input, signal) {
      calls.push({ name, input, signal })
      if (result instanceof Error) throw result
      return result
    },
  }
  const config: PiAgentSessionConfig = {
    runId: 'run-a', modelId: 'model-a', gatewayUrl: 'http://localhost/v1', workspaceDir: '/workspace',
    agentDir: '/workspace/agent', sessionDir: '/workspace/sessions', systemPrompt: 'secret Pi prompt',
    getAccessToken: async () => 'test-token', videoTools: host,
    authorizeTool: async request => { approvals.push(request); return false },
    reportPolicyEvent: (type, data) => { events.push({ type, data }) }, ...overrides,
  }
  let active: string[] = []
  const api = {
    registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool) },
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    getActiveTools() { return active },
  } as unknown as Parameters<ExtensionFactory>[0]
  const restore = setLogSink(() => {})
  try {
    for (const factory of buildExtensions(config, { tools: [], permissions: new Map(), dispose: async () => {} })) await factory(api)
  } finally { restore() }
  const videoNames = [...definitions.keys()].filter(name => name.startsWith('video_')) as VideoToolName[]
  const mediaNames = [...definitions.keys()].filter(name => name.startsWith('media_')) as Array<'media_get_job'>
  const options = sessionToolOptions(config.toolPolicy, config.disableTools, [], mediaNames, videoNames)
  active = options.tools ?? []
  async function emit(type: string, event: Record<string, unknown>) {
    const results = []
    for (const handler of handlers.get(type) ?? []) results.push(await handler(event))
    return results
  }
  async function execute(name: string, input: unknown, signal = new AbortController().signal) {
    const definition = definitions.get(name)
    assert.ok(definition, `Missing registered definition: ${name}`)
    return definition.execute('call-a', input, signal, undefined, {} as never)
  }
  return { config, definitions, options, calls, approvals, events, execute, emit, deactivate: () => { active = [] } }
}

function value(result: Awaited<ReturnType<Awaited<ReturnType<typeof sdk>>['execute']>>) {
  assert.equal(result.content[0].type, 'text')
  return result.content[0].type === 'text' ? result.content[0].text : ''
}

describe('video tools through the mocked Pi SDK extension API', () => {
  it('accepts a brief without a profile or technical specifications', async () => {
    const runtime = await sdk()
    const result = await runtime.execute('video_generate', { creativeBrief: 'A product video' })
    assert.deepEqual(result.details, { isError: false })
    assert.deepEqual(runtime.calls[0].input, { creativeBrief: 'A product video', localAssetIds: [] })
  })

  it('allows video discovery without guessing a job id and strips arbitrary reference fields', async () => {
    const asset = { localAssetId: 'asset-a', taskId: 'task-a', jobId: null, outputId: null, source: 'reference', mime: 'image/png', size: 30, width: 1, height: 1, status: 'SAVED' }
    const runtime = await sdk({}, { mock: true, runtime: videoFixture.runtime, jobs: [], referenceAssets: [{ ...asset, ...secrets }] })
    const result = await runtime.execute('video_get_job', {})
    assert.deepEqual(result.details, { isError: false })
    assert.deepEqual(JSON.parse(value(result)).referenceAssets, [asset])
    assert.ok(!value(result).includes('private-key'))
  })

  it('reports fixed business codes without echoing exception messages or inventing missing models', async () => {
    for (const code of ['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'AUTH_REQUIRED', 'NETWORK_ERROR', 'CONFLICT', 'SERVICE_UNAVAILABLE'] as const) {
      const runtime = await sdk({}, new AppError(code, { message: sensitiveText }))
      const result = await runtime.execute('video_generate', { creativeBrief: 'A product video' })
      assert.deepEqual(result.details, { isError: true })
      const error = JSON.parse(value(result)).error
      assert.equal(error.code, code)
      assert.ok(error.message.length > 20)
      assert.ok(!value(result).includes('private-key'))
      assert.ok(!value(result).includes('private.example'))
    }
  })
  it('accepts real job and task queries with every billing state and preserves measured output metadata', async () => {
    for (const billingStatus of ['NOT_RESERVED', 'RESERVED', 'RECONCILING', 'SETTLED', 'RELEASED'] as const) {
      const measured = { ...output, width: 1344, height: 768, durationSeconds: 4.458333, frameRate: 24 }
      const realJob = { ...job, generationStatus: 'SUCCEEDED', billingStatus, amountCny: '0.900000',
        actualCostCny: '0.800000', amountUsd: '0.12', outputs: [measured] }
      const realTask = { mock: false, runtime: videoRuntimeSchema.parse({ ...videoFixture.runtime, executionMode: 'real' }), jobs: [realJob] }
      for (const payload of [realJob, realTask]) {
        const runtime = await sdk({}, { ...payload, ...secrets })
        const result = await runtime.execute('video_get_job', { jobId: 'job-a' })
        assert.deepEqual(result.details, { isError: false })
        const parsed = JSON.parse(value(result))
        const projected = 'jobs' in parsed ? parsed.jobs[0] : parsed
        assert.deepEqual(projected, realJob)
        if ('runtime' in parsed) { assert.equal(parsed.mock, false); assert.equal(parsed.runtime.executionMode, 'real') }
        for (const secret of ['private-key', 'private.example', '/private/video.mp4', 'secret Pi prompt', 'remote-receipt', 'remote-reference']) assert.ok(!value(result).includes(secret))
      }
    }
  })

  it('rejects mixed mock/real task modes, invented billing and malformed costs without forwarding host data', async () => {
    const realJob = { ...job, billingStatus: 'RECONCILING', amountCny: '0.900000' }
    const realRuntime = videoRuntimeSchema.parse({ ...videoFixture.runtime, executionMode: 'real' })
    for (const payload of [
      { ...realJob, billingStatus: 'UNKNOWN' }, { ...realJob, amountCny: '-0.900000' },
      { ...realJob, actualCostCny: sensitiveText }, { ...realJob, amountUsd: 'NaN' }, { ...job, amountCny: '0.000000' },
      { mock: false, runtime: realRuntime, jobs: [job] }, { mock: true, runtime: realRuntime, jobs: [realJob] },
      { mock: false, runtime: videoFixture.runtime, jobs: [realJob] },
      { mock: true, runtime: videoFixture.runtime, jobs: [realJob] },
    ]) {
      const runtime = await sdk({}, payload)
      const result = await runtime.execute('video_get_job', { jobId: 'job-a' })
      assert.deepEqual(result.details, { isError: true })
      assert.equal(value(result), 'Video tool request failed.')
    }
  })
  it('registers strict definitions independently of image tools and never advertises cancel', async () => {
    const runtime = await sdk({ mediaTools: { names: ['media_get_job'], execute: async () => null } })
    assert.deepEqual([...runtime.definitions.keys()], ['media_get_job', ...names])
    assert.deepEqual(runtime.options.tools, ['read', 'bash', 'edit', 'write', 'media_get_job', ...names])
    for (const name of names) {
      const definition = runtime.definitions.get(name)!
      assert.equal(definition.executionMode, 'sequential')
      assert.equal((definition.parameters as Record<string, unknown>).additionalProperties, false)
    }
    const schema = runtime.definitions.get('video_from_image')!.parameters as Record<string, unknown>
    assert.deepEqual(schema.required, ['localAssetIds', 'creativeBrief'])
    assert.deepEqual((runtime.definitions.get('video_generate')!.parameters as Record<string, unknown>).required, ['creativeBrief'])
    const fields = schema.properties as Record<string, Record<string, unknown>>
    assert.equal(fields.operation.const, 'image-to-video')
    assert.equal(fields.localAssetIds.maxItems, 1)
    assert.equal(fields.parameters.additionalProperties, false)
    assert.equal((runtime.definitions.get('video_get_job')!.parameters as Record<string, unknown>).required, undefined)
    assert.equal(runtime.definitions.has('video_cancel_job'), false)
    assert.ok(!JSON.stringify([...runtime.definitions.values()]).includes('secret Pi prompt'))
  })

  it('only advertises injected known names, even when policy lists unavailable or cancellation tools', async () => {
    for (const videoTools of [undefined, { names: [] as const, execute: async () => job }]) {
      const runtime = await sdk({ videoTools, toolPolicy: { ...policy, allowedTools: [...names, 'video_cancel_job', 'video_unknown'] } })
      assert.equal(runtime.definitions.size, 0)
      assert.deepEqual(runtime.options.tools, [])
    }
    const runtime = await sdk({ videoTools: { names: ['video_get_job', 'video_cancel_job'] as unknown as VideoToolName[], execute: async () => job } })
    assert.deepEqual([...runtime.definitions.keys()], ['video_get_job'])
  })

  it('forwards validated generation, query and AbortSignal without a duplicate Pi approval', async () => {
    const runtime = await sdk()
    for (const [name, input] of [
      ['video_generate', { ...generation, creativeBrief: '  A product video  ' }],
      ['video_from_image', { ...generation, operation: 'image-to-video', localAssetIds: ['asset-a'] }],
      ['video_get_job', { jobId: 'job-a' }],
    ] as const) {
      assert.deepEqual(await runtime.emit('tool_call', { toolName: name, input }), [{ block: false }])
      const signal = new AbortController().signal
      const result = await runtime.execute(name, input, signal)
      assert.deepEqual(result.details, { isError: false })
      assert.deepEqual(JSON.parse(value(result)), job)
      assert.equal(runtime.calls.at(-1)?.signal, signal)
    }
    assert.deepEqual(runtime.calls[0].input, generation)
    assert.equal(runtime.calls.length, 3)
    assert.deepEqual(runtime.approvals, [])
  })

  it('validates strict generation inputs inside execute before calling the facade', async () => {
    const runtime = await sdk()
    const invalid = [null, {}, { ...generation, ...secrets }, { ...generation, profileId: '../profile' },
      { ...generation, creativeBrief: ' ' }, { ...generation, creativeBrief: 'a'.repeat(4001) },
      { ...generation, localAssetIds: ['remote-reference'] }, { ...generation, operation: 'image-to-video', localAssetIds: ['asset-a'] },
      { ...generation, parameters: { ...parameters, path: '/private/video.mp4' } },
      { ...generation, parameters: { ...parameters, durationSeconds: 601 } },
      { ...generation, parameters: { ...parameters, audio: 'false' } },
      { ...generation, parameters: { ...parameters, frameRate: 1.5 } },
      { ...generation, parameters: { ...parameters, resolution: '8k' } },
      { ...generation, parameters: { ...parameters, outputFormat: 'image/png' } },
    ]
    for (const input of invalid) {
      const result = await runtime.execute('video_generate', input)
      assert.deepEqual(result.details, { isError: true })
      assert.equal(JSON.parse(value(result)).error.code, 'INVALID_ARGUMENT')
    }
    for (const localAssetIds of [[], ['asset-a', 'asset-a'], ['asset-a', 'asset-b'], ['/private/file']]) {
      const result = await runtime.execute('video_from_image', { ...generation, operation: 'image-to-video', localAssetIds })
      assert.deepEqual(result.details, { isError: true })
    }
    assert.deepEqual((await runtime.execute('video_from_image', generation)).details, { isError: true })
    assert.deepEqual(runtime.calls, [])
  })

  it('requires a strict local jobId object and ignores an already aborted call', async () => {
    const runtime = await sdk()
    for (const input of [{ jobId: '../job' }, { jobId: 'job-a', receiptId: 'remote-receipt' }, { jobId: 'a'.repeat(129) }]) {
      assert.deepEqual((await runtime.execute('video_get_job', input)).details, { isError: true })
    }
    const signal = AbortSignal.abort(new Error(sensitiveText))
    const result = await runtime.execute('video_get_job', { jobId: 'job-a' }, signal)
    assert.equal(value(result), 'Video tool request cancelled.')
    assert.deepEqual(runtime.calls, [])
  })

  it('discards a result when cancellation arrives while the host executes', async () => {
    const controller = new AbortController()
    const runtime = await sdk({ videoTools: {
      names: ['video_get_job'], async execute(_name, _input, signal) {
        assert.equal(signal, controller.signal)
        controller.abort(new Error(sensitiveText))
        return job
      },
    } })
    assert.equal(value(await runtime.execute('video_get_job', { jobId: 'job-a' }, controller.signal)), 'Video tool request cancelled.')
  })

  it('honors read-only, workspace allowlists, disableTools and full-local host delegation', async () => {
    for (const toolPolicy of [
      { ...policy, preset: 'read-only' as const, allowedTools: names }, policy,
      { ...policy, allowedTools: ['video_from_image'] },
      { ...policy, preset: 'full-local' as const, approvalMode: 'auto-approve' as const },
      { ...policy, preset: 'full-local' as const },
    ]) {
      const runtime = await sdk({ toolPolicy })
      const expected = toolPolicy.preset === 'full-local' ? names
        : toolPolicy.preset === 'read-only' ? ['video_get_job'] : [...names].filter(name => name === 'video_get_job' || toolPolicy.allowedTools.includes(name))
      assert.deepEqual([...runtime.definitions.keys()], expected)
      for (const name of [...names, 'video_cancel_job', 'video_unknown']) {
        const [decision] = await runtime.emit('tool_call', { toolName: name, input: generation })
        assert.equal((decision as { block: boolean }).block, !expected.includes(name))
      }
      if (runtime.definitions.has('video_generate')) await runtime.execute('video_generate', generation)
      assert.equal(runtime.approvals.length, 0)
    }
    const disabled = await sdk({ disableTools: true, toolPolicy: { ...policy, preset: 'full-local', approvalMode: 'auto-approve' } })
    assert.deepEqual(disabled.options, { noTools: 'all' })
    assert.equal(disabled.definitions.size, 0)
    assert.equal(((await disabled.emit('tool_call', { toolName: 'video_generate' }))[0] as { block: boolean }).block, true)
  })

  it('blocks inactive tools and rechecks revoked facade names and policy before execute', async () => {
    const runtime = await sdk()
    runtime.deactivate()
    assert.equal(((await runtime.emit('tool_call', { toolName: 'video_generate' }))[0] as { block: boolean }).block, true)
    runtime.config.toolPolicy = { ...policy, preset: 'read-only' }
    assert.deepEqual((await runtime.execute('video_generate', generation)).details, { isError: true })
    runtime.config.videoTools = { names: [], execute: async () => job }
    assert.deepEqual((await runtime.execute('video_get_job', { jobId: 'job-a' })).details, { isError: true })
    assert.equal(runtime.calls.length, 0)
    assert.ok(runtime.events.length > 0)
  })

  it('projects job/output views and removes arbitrary host data and echoed sensitive errors', async () => {
    const runtime = await sdk({}, { ...job, ...secrets, error: sensitiveText, outputs: [{ ...output, ...secrets }] })
    const result = await runtime.execute('video_get_job', { jobId: 'job-a' })
    assert.deepEqual(result.details, { isError: false })
    assert.deepEqual(JSON.parse(value(result)), { ...job, error: 'Video job reported an error.', outputs: [output] })
    assert.equal(await runtime.emit('tool_result', { toolName: 'video_get_job', details: result.details }).then(values => values[0]), undefined)
  })

  it('projects task views, limits runtime tool names and suppresses free-form profile text', async () => {
    const task: VideoTaskView = {
      mock: true, jobs: [job], runtime: {
        protocolVersion: 1, executionAvailable: true, defaultProfileId: 'profile-a', tools: [...names, 'video_cancel_job'],
        profiles: [{
          profileId: 'profile-a', kind: 'video', displayName: 'secret Pi prompt', configVersion: 'v1',
          operations: ['image-to-video', 'text-to-video'], executionMode: 'async-query',
          capabilities: {
            supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: false, durationsSeconds: [5], aspectRatios: ['16:9'],
            resolutions: ['720p'], frameRates: [24], maxInputBytes: 1024, maxReferenceCount: 1,
            outputFormats: ['video/mp4'], supportsTaskQuery: true, supportsCancel: true, resultRetentionSeconds: 60,
          },
        }],
      },
    }
    const runtime = await sdk({ videoTools: { names: ['video_get_job'], execute: async () => ({ ...task, ...secrets, jobs: [{ ...job, ...secrets }] }) } })
    const result = await runtime.execute('video_get_job', { jobId: 'job-a' })
    const expected = structuredClone(task)
    expected.runtime.tools = ['video_get_job']
    expected.runtime.profiles[0].displayName = 'Video profile'
    assert.deepEqual(JSON.parse(value(result)), expected)
  })

  it('fails closed on raw errors, transport records, malformed or unbounded business fields', async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const result of [new Error(sensitiveText), { ok: false, error: { message: sensitiveText } }, secrets, cycle,
      { ...job, generationStatus: sensitiveText }, { ...job, taskId: secrets.path },
      { ...job, error: sensitiveText.repeat(100) }, { ...job, createdAt: Infinity },
      { ...job, parameters: { ...parameters, aspectRatio: '1'.repeat(100) + ':1' } },
      { ...job, outputs: Array(5).fill(output) }, { ...job, outputs: [{ ...output, outputId: secrets.url }] },
      { mock: true, runtime: { protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles: [] }, jobs: Array(51).fill(job) },
    ]) {
      const runtime = await sdk({}, result)
      const failure = await runtime.execute('video_get_job', { jobId: 'job-a' })
      assert.equal(value(failure), 'Video tool request failed.')
      assert.deepEqual(failure.details, { isError: true })
      assert.deepEqual(await runtime.emit('tool_result', { toolName: 'video_get_job', details: failure.details }), [{ isError: true }])
      assert.deepEqual(await runtime.emit('tool_result', { toolName: 'video_unknown', details: failure.details }), [undefined])
    }
  })

  it('bounds the total serialized result while keeping every individual business field valid', async () => {
    const runtime = await sdk({}, {
      mock: true, runtime: { protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles: [] },
      jobs: Array(50).fill({ ...job, outputs: Array(4).fill(output) }),
    })
    const result = await runtime.execute('video_get_job', { jobId: 'job-a' })
    assert.deepEqual(result.details, { isError: true })
    assert.equal(value(result), 'Video tool result exceeds the safe limit.')
  })
})

describe('isolated streaming video model fixture with the actual Pi SDK', () => {
  for (const { denied, real } of [{ denied: false, real: false }, { denied: true, real: false }, { denied: false, real: true }]) {
    it(`runs deterministic ${real ? 'real-contract' : 'mock'} generation and ${denied ? 'stops on host denial' : 'queries the returned job'} without external I/O`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'sep-pi-video-'))
      const input = { ...generation, operation: 'image-to-video' as const, localAssetIds: ['asset-a'] }
      const model = createPiVideoModelMock({ generationInput: input })
      const originalFetch = globalThis.fetch
      const restoreLog = setLogSink(() => {})
      const executions: Array<{ name: VideoToolName; input: unknown }> = []
      const requests: unknown[] = []
      let session: Awaited<ReturnType<PiCodingAgentAdapter['createSession']>> | undefined
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'http://127.0.0.1:1/pi-video-model-mock/chat/completions')
        assert.equal(typeof options?.body, 'string')
        const body: unknown = JSON.parse(options!.body as string)
        requests.push(body)
        return model.respond(body)
      }
      try {
        session = await new PiCodingAgentAdapter().createSession({
          runId: 'run-video', modelId: 'model-video', gatewayUrl: 'http://127.0.0.1:1/pi-video-model-mock',
          workspaceDir: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), mcpServers: [],
          getAccessToken: async () => 'test-token', authorizeTool: async () => { assert.fail('Host owns video approvals') },
          videoTools: { names: ['video_from_image', 'video_get_job'], async execute(name, input, signal) {
            assert.ok(signal instanceof AbortSignal)
            executions.push({ name, input })
            if (denied) throw new Error(sensitiveText)
            return { ...job, ...secrets, operation: 'image-to-video', error: null,
              ...(real ? { billingStatus: 'RECONCILING', amountCny: '0.900000', amountUsd: '0.12', generationStatus: 'SUCCEEDED',
                outputs: [{ ...output, width: 1344, height: 768, durationSeconds: 4.458333 }] } : {}) }
          } },
        })
        await session.prompt(PI_VIDEO_MODEL_MOCK_PROMPT)
        assert.deepEqual(executions, denied ? [{ name: 'video_from_image', input }] : [
          { name: 'video_from_image', input }, { name: 'video_get_job', input: { jobId: job.jobId } },
        ])
        assert.deepEqual(model.audit, {
          requests: denied ? 2 : 3,
          steps: { video_from_image: 1, video_get_job: denied ? 0 : 1, final: 1, businessError: denied ? 1 : 0 },
          generationCount: 1,
        })
        for (const secret of ['private-key', 'private.example', '/private/video.mp4', 'secret Pi prompt', 'remote-receipt', 'remote-reference']) {
          assert.ok(!JSON.stringify(requests).includes(secret))
        }
      } finally {
        try { await session?.dispose() } finally {
          globalThis.fetch = originalFetch
          restoreLog()
          await rm(root, { recursive: true, force: true })
        }
      }
    })
  }

  it('validates fixture input and rejects missing tools, wrong prompts or forged history without echoing data', async () => {
    assert.throws(() => createPiVideoModelMock({ generationInput: generation }), /INVALID_GENERATION_INPUT/)
    const model = createPiVideoModelMock({ generationInput: { ...generation, operation: 'image-to-video', localAssetIds: ['asset-a'] } })
    const tools = ['video_from_image', 'video_get_job'].map(name => ({ type: 'function', function: { name } }))
    const body = { model: 'model-video', stream: true, tools, messages: [{ role: 'user', content: PI_VIDEO_MODEL_MOCK_PROMPT }] }
    assert.throws(() => model.respond({ ...body, tools: [] }), /TOOL_NOT_ADVERTISED/)
    assert.throws(() => model.respond({ ...body, messages: [{ role: 'user', content: sensitiveText }] }), { message: 'Pi video model mock: UNKNOWN_PROMPT' })
    assert.throws(() => model.respond({ ...body, messages: [...body.messages, { role: 'assistant', content: null,
      tool_calls: [{ id: 'bad', type: 'function', function: { name: 'video_from_image', arguments: JSON.stringify(secrets) } }],
    }, { role: 'tool', content: '{}', tool_call_id: 'bad' }] }), { message: 'Pi video model mock: INVALID_TOOL_HISTORY' })
  })
})
