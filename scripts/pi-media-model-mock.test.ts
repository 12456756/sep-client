import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createPiMediaModelMock, PiMediaModelMock } from './pi-media-model-mock'

type Value = Record<string, unknown>
type WireCall = { id: string; type: string; function: { name: string; arguments: string } }
type Delta = { role: string; content?: string; tool_calls?: Array<WireCall & { index: number }> }
type Body = { model: string; stream: boolean; messages: Value[]; tools: Value[] }
const approvedSkillPath = '/test/approved/ecommerce-image-mock/SKILL.md'
const toolNames = ['read', 'media_get_capabilities', 'media_generate_image', 'media_get_job']

function body(scenario = 'SYNC', path = approvedSkillPath): Body {
  return {
    model: 'local-test-model', stream: true,
    messages: [
      { role: 'system', content: `<skill><name>ecommerce-image-mock</name><location>${path}</location></skill>` },
      { role: 'user', content: `[SEP_PI_MEDIA_MOCK_${scenario}] 本地图片验收` },
    ],
    tools: toolNames.map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
  }
}

function capabilities(referenceAssets: Value[] = [{ localAssetId: 'reference-first' }, { localAssetId: 'reference-second' }]): Value {
  return {
    capabilities: {
      protocolVersion: 1, tools: toolNames.slice(1),
      // Deliberately reverse their order: selection must use the returned profile ID.
      profiles: ['mock-async', 'mock-sync'].map(profileId => ({
        profileId, kind: 'image', displayName: profileId, configVersion: 'mock-v1',
        executionMode: profileId === 'mock-sync' ? 'sync-response' : 'async-query',
        operations: ['generate', 'edit'], capabilities: { referenceImage: true, cancel: false, recoverByRequestId: true },
        allowedAspectRatios: ['1:1'], allowedSizes: ['1x1'], maxCount: 1,
      })),
    }, referenceAssets,
  }
}

async function delta(response: Response): Promise<Delta> {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const frames = (await response.text()).trim().split('\n\n')
  assert.equal(frames.length, 3)
  assert.equal(frames[2], 'data: [DONE]')
  const chunks = frames.slice(0, 2).map(frame => JSON.parse(frame.slice(6)) as {
    id: string; model: string; object: string; created: number;
    choices: Array<{ index: number; delta: Delta; finish_reason: string | null }>
  })
  for (const chunk of chunks) {
    assert.equal(chunk.object, 'chat.completion.chunk')
    assert.equal(chunk.model, 'local-test-model')
    assert.equal(chunk.created, 1)
    assert.equal(chunk.choices[0].index, 0)
  }
  assert.equal(chunks[0].id, chunks[1].id)
  const first = chunks[0].choices[0]
  assert.equal(first.finish_reason, null)
  assert.deepEqual(chunks[1].choices[0].delta, {})
  assert.equal(chunks[1].choices[0].finish_reason, first.delta.tool_calls ? 'tool_calls' : 'stop')
  return first.delta
}

function append(request: Body, answer: Delta, result: unknown): WireCall {
  assert.equal(answer.role, 'assistant')
  assert.equal(answer.tool_calls?.length, 1)
  const { index, ...call } = answer.tool_calls![0]
  assert.equal(index, 0)
  request.messages.push({ role: 'assistant', content: null, tool_calls: [call] }, {
    role: 'tool', tool_call_id: call.id, name: call.function.name,
    content: typeof result === 'string' ? result : JSON.stringify(result),
  })
  return call
}

async function readSkill(mock: PiMediaModelMock, request: Body): Promise<void> {
  const answer = await delta(mock.respond(request))
  assert.ok(answer.tool_calls)
  assert.equal(answer.tool_calls?.[0].function.name, 'read')
  assert.deepEqual(JSON.parse(answer.tool_calls[0].function.arguments), { path: approvedSkillPath })
  append(request, answer, '# Approved test skill\nSEP_ECOMMERCE_IMAGE_MOCK_V1\nUse media tools.')
}

async function getCapabilities(mock: PiMediaModelMock, request: Body, result = capabilities()): Promise<void> {
  const answer = await delta(mock.respond(request))
  assert.ok(answer.tool_calls)
  assert.equal(answer.tool_calls?.[0].function.name, 'media_get_capabilities')
  assert.deepEqual(JSON.parse(answer.tool_calls[0].function.arguments), {})
  append(request, answer, result)
}

describe('deterministic Pi media model SSE fixture', () => {
  it('reads the actual approved skill through a host read before a successful reference edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-pi-media-model-'))
    try {
      const path = join(root, 'SKILL.md')
      await writeFile(path, '# ecommerce-image-mock\nSEP_ECOMMERCE_IMAGE_MOCK_V1\nReal file body.')
      const mock = createPiMediaModelMock({ approvedSkillPath: path })
      const request = body('SYNC', path)
      const read = await delta(mock.respond(request))
      const input = JSON.parse(read.tool_calls![0].function.arguments) as { path: string }
      assert.equal(read.tool_calls![0].function.name, 'read')
      assert.equal(input.path, path)
      assert.equal(mock.audit.skillReadVerified, false)
      // The test host performs the filesystem read; the model helper never does.
      append(request, read, await readFile(input.path, 'utf8'))
      await getCapabilities(mock, request)
      assert.equal(mock.audit.skillReadVerified, true)
      const generate = await delta(mock.respond(request))
      assert.equal(generate.tool_calls![0].function.name, 'media_generate_image')
      const generation = JSON.parse(generate.tool_calls![0].function.arguments)
      assert.deepEqual(generation, {
        profileId: 'mock-sync', operation: 'edit', localAssetIds: ['reference-first'],
        creativeBrief: 'Deterministic ecommerce mock reference edit.',
        parameters: { aspectRatio: '1:1', count: 1, size: '1x1' },
      })
      append(request, generate, { jobId: 'actual-sync-job', profileId: 'mock-sync', operation: 'edit' })
      const get = await delta(mock.respond(request))
      assert.equal(get.tool_calls![0].function.name, 'media_get_job')
      assert.deepEqual(JSON.parse(get.tool_calls![0].function.arguments), { jobId: 'actual-sync-job' })
      append(request, get, { jobId: 'actual-sync-job', generationStatus: 'SUCCEEDED', error: null })
      const final = await delta(mock.respond(request))
      assert.equal(final.tool_calls, undefined)
      assert.match(final.content!, /图片编辑/)
      assert.deepEqual(mock.audit, {
        requests: 5, skillReadVerified: true, generationCount: 1,
        steps: { read: 1, media_get_capabilities: 1, media_generate_image: 1, media_get_job: 1, final: 1, businessError: 0 },
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('generates asynchronously without references, even when capabilities contain references', async () => {
    for (const references of [[], [{ localAssetId: 'unused-reference' }]]) {
      const mock = new PiMediaModelMock({ approvedSkillPath })
      const request = body('ASYNC')
      await readSkill(mock, request)
      await getCapabilities(mock, request, capabilities(references))
      const answer = await delta(mock.respond(request))
      const input = JSON.parse(answer.tool_calls![0].function.arguments)
      assert.equal(input.profileId, 'mock-async')
      assert.equal(input.operation, 'generate')
      assert.deepEqual(input.localAssetIds, [])
      append(request, answer, { jobId: 'returned-async-id', generationStatus: 'QUEUED' })
      const get = await delta(mock.respond(request))
      assert.deepEqual(JSON.parse(get.tool_calls![0].function.arguments), { jobId: 'returned-async-id' })
      append(request, get, { jobId: 'returned-async-id', generationStatus: 'RUNNING' })
      assert.match((await delta(mock.respond(request))).content!, /异步/)
      assert.equal(mock.audit.generationCount, 1)
    }
  })

  it('lets the real generation tool deny the request and terminates without polling or retry', async () => {
    const mock = new PiMediaModelMock({ approvedSkillPath })
    const request = body('DENY')
    await readSkill(mock, request)
    await getCapabilities(mock, request, capabilities([]))
    const answer = await delta(mock.respond(request))
    assert.equal(answer.tool_calls![0].function.name, 'media_generate_image')
    assert.equal(JSON.parse(answer.tool_calls![0].function.arguments).operation, 'generate')
    append(request, answer, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Bearer private-token /private/path' } })
    const final = await delta(mock.respond(request))
    assert.match(final.content!, /拒绝/)
    assert.equal(final.tool_calls, undefined)
    assert.doesNotMatch(JSON.stringify(final), /private-token|private\/path/)
    request.messages.push({ role: 'assistant', content: final.content })
    assert.equal((await delta(mock.respond(request))).tool_calls, undefined)
    assert.equal(mock.audit.generationCount, 1)
    assert.equal(mock.audit.steps.media_get_job, 0)
    assert.equal(mock.audit.steps.businessError, 1)
  })

  it('does not claim a denial when the host unexpectedly accepts DENY', async () => {
    const mock = new PiMediaModelMock({ approvedSkillPath })
    const request = body('DENY')
    await readSkill(mock, request)
    await getCapabilities(mock, request)
    append(request, await delta(mock.respond(request)), { jobId: 'unexpected-acceptance' })
    assert.throws(() => mock.respond(request), /DENIAL_NOT_OBSERVED/)
  })

  it('never regenerates after generation, and gives identical SSE IDs on a fetch replay', async () => {
    const mock = new PiMediaModelMock({ approvedSkillPath })
    const request = body('ASYNC')
    await readSkill(mock, request)
    await getCapabilities(mock, request)
    const first = await delta(mock.respond(request))
    assert.deepEqual(await delta(mock.respond(request)), first)
    assert.equal(mock.audit.generationCount, 1)
    append(request, first, { jobId: 'only-job' })
    const get = await delta(mock.respond(request))
    assert.equal(get.tool_calls![0].function.name, 'media_get_job')
    append(request, get, { jobId: 'only-job', generationStatus: 'QUEUED' })
    const final = await delta(mock.respond(request))
    assert.equal(final.tool_calls, undefined)
    assert.deepEqual(await delta(mock.respond(request)), final)
    request.messages.push({ role: 'assistant', content: final.content })
    assert.equal((await delta(mock.respond(request))).tool_calls, undefined)
    assert.equal(mock.audit.generationCount, 1)
  })

  it('uses only the latest user marker and performs a fresh skill read in each turn', async () => {
    const mock = new PiMediaModelMock({ approvedSkillPath })
    const request = body('DENY')
    await readSkill(mock, request)
    await getCapabilities(mock, request)
    append(request, await delta(mock.respond(request)), { ok: false, error: { code: 'MEDIA_DENIED' } })
    const final = await delta(mock.respond(request))
    request.messages.push({ role: 'assistant', content: final.content }, { role: 'user', content: '[SEP_PI_MEDIA_MOCK_ASYNC]' })
    const fresh = await delta(mock.respond(request))
    assert.equal(fresh.tool_calls![0].function.name, 'read')
    assert.equal(mock.audit.steps.read, 2)
    assert.equal(mock.audit.generationCount, 1)
    request.messages.push({ role: 'user', content: '请随意生成一张图片' })
    assert.throws(() => mock.respond(request), /UNKNOWN_PROMPT/)
  })

  it('fails closed for unknown or ambiguous prompts without echoing their content', () => {
    for (const prompt of ['Bearer secret-token /private/SKILL.md', '[SEP_PI_MEDIA_MOCK_SYNC] [SEP_PI_MEDIA_MOCK_ASYNC]', 'SEP_PI_MEDIA_MOCK_SYNC']) {
      const mock = new PiMediaModelMock({ approvedSkillPath })
      const request = body()
      request.messages[1].content = prompt
      assert.throws(() => mock.respond(request), { message: 'Pi media model mock: UNKNOWN_PROMPT' })
      assert.equal(mock.audit.generationCount, 0)
    }
  })

  it('requires the explicitly approved path and skill name in a system message', () => {
    for (const content of ['ecommerce-image-mock', approvedSkillPath, `ecommerce-image-mock ${approvedSkillPath}.other`, '']) {
      const request = body()
      request.messages[0].content = content
      request.messages[1].content += ` ecommerce-image-mock ${approvedSkillPath}`
      assert.throws(() => new PiMediaModelMock({ approvedSkillPath }).respond(request), /APPROVED_SKILL_MISSING/)
    }
    for (const path of ['', 'relative/SKILL.md', '/private/not-a-skill', '/private/\nSKILL.md']) {
      assert.throws(() => new PiMediaModelMock({ approvedSkillPath: path }), { message: 'Pi media model mock: INVALID_APPROVED_SKILL' })
    }
  })

  it('requires the marker in the paired read result before advertising a media call', async () => {
    const mock = new PiMediaModelMock({ approvedSkillPath })
    const request = body()
    request.messages[0].content += ' SEP_ECOMMERCE_IMAGE_MOCK_V1'
    append(request, await delta(mock.respond(request)), 'A different file, no approved body marker.')
    assert.throws(() => mock.respond(request), /SKILL_READ_UNVERIFIED/)
    assert.equal(mock.audit.skillReadVerified, false)
    assert.equal(mock.audit.steps.media_get_capabilities, 0)
  })

  it('rejects malformed normalized completion bodies with fixed errors', () => {
    for (const value of [null, [], 'Bearer private', {}, { ...body(), model: null }, { ...body(), stream: false },
      { ...body(), messages: [{ role: 'user', content: { text: 'secret' } }] },
      { ...body(), messages: [{ role: 'developer', content: 'secret' }] },
      { ...body(), tools: [{}] }, { ...body(), messages: [] }]) {
      assert.throws(() => new PiMediaModelMock({ approvedSkillPath }).respond(value), { message: 'Pi media model mock: INVALID_BODY' })
    }
  })

  it('never invents absent tools, including read, and does not use other advertised tools', async () => {
    for (const name of toolNames) {
      const request = body()
      request.tools = request.tools.filter(tool => (tool.function as Value).name !== name)
      request.tools.push({ type: 'function', function: { name: 'bash' } })
      assert.throws(() => new PiMediaModelMock({ approvedSkillPath }).respond(request), /TOOL_NOT_ADVERTISED/)
    }
    const mock = new PiMediaModelMock({ approvedSkillPath })
    const request = body()
    await readSkill(mock, request)
    request.tools = request.tools.filter(tool => (tool.function as Value).name !== 'read')
    assert.throws(() => mock.respond(request), /TOOL_NOT_ADVERTISED/)
  })

  it('fails closed instead of downgrading an edit when the first reference is absent or invalid', async () => {
    for (const references of [[], [{ localAssetId: '../private' }], [{}, { localAssetId: 'valid-second' }]]) {
      const mock = new PiMediaModelMock({ approvedSkillPath })
      const request = body()
      await readSkill(mock, request)
      await getCapabilities(mock, request, capabilities(references))
      assert.throws(() => mock.respond(request), /REFERENCE_REQUIRED/)
      assert.equal(mock.audit.generationCount, 0)
    }
  })

  it('rejects unpaired, reordered, changed, or duplicate tool calls', async () => {
    const seed = body()
    const source = new PiMediaModelMock({ approvedSkillPath })
    await readSkill(source, seed)
    const mutations: Array<(request: Body) => void> = [
      request => { request.messages[3].tool_call_id = 'unrelated-call' },
      request => { request.messages.splice(2, 1) },
      request => { request.messages.pop() },
      request => { (request.messages[2].tool_calls as WireCall[])[0].function.name = 'media_get_capabilities' },
      request => { (request.messages[2].tool_calls as WireCall[])[0].function.arguments = JSON.stringify({ path: '/private/other/SKILL.md' }) },
      request => { request.messages.push(...structuredClone(request.messages.slice(2))) },
      request => { (request.messages[2].tool_calls as WireCall[]).push(...structuredClone(request.messages[2].tool_calls as WireCall[])) },
    ]
    for (const mutate of mutations) {
      const request = structuredClone(seed)
      mutate(request)
      assert.throws(() => new PiMediaModelMock({ approvedSkillPath }).respond(request), /INVALID_TOOL_HISTORY/)
    }
  })

  it('stops for business errors at every stage, including read, with no output leakage', async () => {
    for (let failureStage = 0; failureStage < 4; failureStage++) {
      const mock = new PiMediaModelMock({ approvedSkillPath })
      const request = body('ASYNC')
      const results = ['SEP_ECOMMERCE_IMAGE_MOCK_V1', capabilities(), { jobId: 'real-job' }, { jobId: 'real-job' }]
      for (let stage = 0; stage <= failureStage; stage++) {
        append(request, await delta(mock.respond(request)), stage === failureStage
          ? { ok: false, error: { code: 'MEDIA_DENIED', message: `Bearer private-token ${approvedSkillPath} SEP_ECOMMERCE_IMAGE_MOCK_V1` } }
          : results[stage])
      }
      const final = await delta(mock.respond(request))
      assert.equal(final.tool_calls, undefined)
      assert.match(final.content!, /终止/)
      const audit = JSON.stringify(mock.audit)
      assert.doesNotMatch(`${JSON.stringify(final)}${audit}`, /private-token|SKILL\.md|SEP_ECOMMERCE_IMAGE_MOCK_V1/)
      assert.equal(mock.audit.skillReadVerified, failureStage > 0)
      assert.equal(mock.audit.steps.businessError, 1)
    }
  })

  it('rejects invalid capabilities and malformed or mismatched job IDs without another generation', async () => {
    for (const result of [{ capabilities: {}, referenceAssets: [] }, { ...capabilities(), referenceAssets: null },
      { capabilities: { ...(capabilities().capabilities as Value), profiles: [] }, referenceAssets: [] }]) {
      const mock = new PiMediaModelMock({ approvedSkillPath })
      const request = body('ASYNC')
      await readSkill(mock, request)
      await getCapabilities(mock, request, result)
      assert.throws(() => mock.respond(request), /INVALID_TOOL_RESULT|CAPABILITIES_UNAVAILABLE/)
      assert.equal(mock.audit.generationCount, 0)
    }
    for (const result of ['not-json private-token', {}, { jobId: '../unsafe' }, { jobId: 'job-a', profileId: 'foreign' }]) {
      const mock = new PiMediaModelMock({ approvedSkillPath })
      const request = body('ASYNC')
      await readSkill(mock, request)
      await getCapabilities(mock, request)
      append(request, await delta(mock.respond(request)), result)
      assert.throws(() => mock.respond(request), { message: 'Pi media model mock: INVALID_TOOL_RESULT' })
      assert.equal(mock.audit.generationCount, 1)
    }
    const mock = new PiMediaModelMock({ approvedSkillPath })
    const request = body('ASYNC')
    await readSkill(mock, request)
    await getCapabilities(mock, request)
    append(request, await delta(mock.respond(request)), { jobId: 'job-a' })
    append(request, await delta(mock.respond(request)), { jobId: 'job-b' })
    assert.throws(() => mock.respond(request), /INVALID_TOOL_RESULT/)
  })

  it('audit snapshots cannot mutate counters and store no request data', async () => {
    const mock = new PiMediaModelMock({ approvedSkillPath })
    await delta(mock.respond(body()))
    const snapshot = mock.audit
    snapshot.steps.read = 999
    snapshot.generationCount = 999
    assert.equal(mock.audit.steps.read, 1)
    assert.equal(mock.audit.generationCount, 0)
    assert.deepEqual(Object.keys(mock.audit).sort(), ['generationCount', 'requests', 'skillReadVerified', 'steps'])
    assert.doesNotMatch(JSON.stringify(mock.audit), /SKILL\.md|ecommerce-image-mock|local-test-model/)
  })
})
