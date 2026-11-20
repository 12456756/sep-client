import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { setLogLevel, setLogSink } from '../../electron/common/logger.js'
import { redactModelTraceText } from '../../electron/common/redact.js'
import { inspectMediaImage } from '../../electron/data/media-image.js'
import { MOCK_MEDIA_CAPABILITIES, MockMediaGateway } from '../../electron/data/mock-media-gateway.js'
import { MediaStore } from '../../electron/data/media-store.js'
import { advanceModelRequestProgress, type ModelRequestProgress } from '../../electron/domain/model-request-progress.js'
import type { MediaToolName } from '../../electron/domain/media-tools.js'
import type { LocalMediaAsset, MediaJobView, MediaReceipt } from '../../electron/domain/media.js'
import { PiCodingAgentAdapter } from '../../electron/pi/sdk/pi-coding-agent-adapter.js'
import type { PiAgentSession } from '../../electron/pi/sdk/pi-agent-runtime.js'
import { translatePiNativeSystemPrompt } from '../../electron/pi/sdk/pi-native-system-prompt.js'
import { buildArrangementNodeSystemPrompt } from '../../electron/runtime/arrangement-node-prompts.js'
import { MediaService } from '../../electron/service/media-service.js'
import { listen, readJson, startResponsesRelay, type ModelAccess } from './responses-relay.mjs'

const modelId = 'gpt-6.1-sol'
const imageSide = 1024
const nodeId = 'image-node'
const deliverable = { id: 'lamp', path: 'deliverables/lamp.png' } as const
const prompt = `请生成一张 ${imageSide}×${imageSide} 的原创台灯商品概念图，交付 PNG。`
const generation = { operation: 'generate', localAssetIds: [], creativeBrief: '原创台灯商品图', protocolVersion: 3,
  requestedSpec: { size: `${imageSide}x${imageSide}`, count: 1, quality: 'standard' },
  parameterSources: { size: 'user', count: 'user', quality: 'model' }, specRevision: 1 }
const maxRequests = 8
type Row = { arrangement: boolean; recoverable: boolean; negative?: 'resubmit' | 'wrong-artifact' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function matchesFinalMediaMapping(text: string, job: MediaJobView | undefined, savedAsset: LocalMediaAsset | undefined): boolean {
  const toolAsset = job?.assets[0]
  if (job?.saveStatus !== 'SAVED' || job.assets.length !== 1 || !toolAsset || toolAsset.status !== 'SAVED' ||
      !savedAsset || savedAsset.status !== 'SAVED' || savedAsset.source !== 'output' || savedAsset.jobId !== job.jobId ||
      savedAsset.localAssetId !== toolAsset.localAssetId) return false
  let manifest: unknown
  try { manifest = JSON.parse(text) } catch { return false }
  if (!isRecord(manifest) || manifest.nodeId !== nodeId || typeof manifest.summary !== 'string' || !manifest.summary.trim() ||
      !Array.isArray(manifest.finalDeliverables) || manifest.finalDeliverables.length !== 1 ||
      !Array.isArray(manifest.mediaDeliverables) || manifest.mediaDeliverables.length !== 1) return false
  const [file]: unknown[] = manifest.finalDeliverables
  const [mapping]: unknown[] = manifest.mediaDeliverables
  return isRecord(file) && file.id === deliverable.id && file.path === deliverable.path &&
    isRecord(mapping) && mapping.deliverableId === deliverable.id && mapping.artifactId === toolAsset.localAssetId
}

function makeFixturePng(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name, 'ascii'), data])
    const bytes = Buffer.alloc(body.length + 8)
    bytes.writeUInt32BE(data.length)
    body.copy(bytes, 4)
    bytes.writeUInt32BE(crc32(body), bytes.length - 4)
    return bytes
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(imageSide, 0)
  header.writeUInt32BE(imageSide, 4)
  header[8] = 8
  const stride = imageSide + 1
  const scanlines = Buffer.alloc(stride * imageSide, 238)
  for (let y = 0; y < imageSide; y++) {
    const row = y * stride
    scanlines[row] = 0
    if (y >= 230 && y < 400) scanlines.fill(90, row + 1 + 355 - (y - 230), row + 1 + 669 + (y - 230))
    if (y >= 400 && y < 760) scanlines.fill(60, row + 1 + 488, row + 1 + 536)
    if (y >= 760 && y < 811) scanlines.fill(60, row + 1 + 310, row + 1 + 714)
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
}

const fixturePng = makeFixturePng()
const fixtureImage = inspectMediaImage(fixturePng)
const fixtureSha256 = createHash('sha256').update(fixturePng).digest('hex')

// Keep the shared 1x1 mock unchanged; this evaluation requires a spec-matching PNG.
class EvaluationMediaGateway extends MockMediaGateway {
  private withFixture(receipt: MediaReceipt): MediaReceipt {
    return { ...receipt, outputs: receipt.outputs.map(output => ({ ...output, ...fixtureImage,
      size: fixturePng.length, sha256: fixtureSha256 })) }
  }

  override async findReceipt(...args: Parameters<MockMediaGateway['findReceipt']>): Promise<MediaReceipt | null> {
    const receipt = await super.findReceipt(...args)
    return receipt ? this.withFixture(receipt) : null
  }

  override async getReceipt(...args: Parameters<MockMediaGateway['getReceipt']>): Promise<MediaReceipt> {
    return this.withFixture(await super.getReceipt(...args))
  }

  override async content(...args: Parameters<MockMediaGateway['content']>): Promise<AsyncIterable<Uint8Array>> {
    await super.content(...args)
    const signal = args[3]
    return (async function* () { signal.throwIfAborted(); yield Buffer.from(fixturePng) })()
  }
}

function toolOutput(name: string, input: unknown, id: string) {
  return [{ type: 'reasoning', id: `rs_${id}`, encrypted_content: `fixture-${id}`, summary: [] },
    { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(input), status: 'completed' }]
}

async function localGateway(row: Row, names: readonly MediaToolName[]) {
  let steps = 0
  let checked = false
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/responses')
      assert.equal(request.headers.authorization, 'Bearer offline-fixture')
      const { model, input, tools, instructions: system, stream, store, include } = await readJson(request) as {
        model: string; input: Array<{ role?: string; type?: string; call_id?: string; encrypted_content?: string; output?: string }>;
        tools: Array<{ name: string; type: string }>; instructions: string; stream: boolean; store: boolean; include: string[] }
      assert.equal(model, modelId)
      assert.equal(stream, true)
      assert.equal(store, false)
      assert.deepEqual(include, ['reasoning.encrypted_content'])
      assert.ok(tools.every(tool => tool.type === 'function'))
      assert.deepEqual(tools.map(tool => tool.name).filter(name => name !== 'get_current_time').sort(), [...names].sort())
      assert.equal(system.split('【图片生成与交付】').length, 2)
      assert.equal(system.includes('【后续对话中的重新生成】'), !row.arrangement)
      assert.equal(system.includes('# 硅基员工节点执行要求'), row.arrangement)
      let output: object[]
      if (++steps === 1) output = toolOutput('media_generate_image', generation, 'original')
      else {
        const expectedId = steps === 2 ? 'original' : row.negative === 'resubmit' ? 'duplicate' : 'lookup'
        const result = input.at(-1)
        assert.equal(result?.type, 'function_call_output')
        assert.equal(result?.call_id, `call_${expectedId}`)
        assert.equal(input.at(-2)?.call_id, result?.call_id)
        assert.equal(input.at(-3)?.encrypted_content, `fixture-${expectedId}`)
        const job: MediaJobView = JSON.parse(result!.output!)
        if (steps === 2) {
          assert.equal(job.generationStatus, 'SUBMISSION_UNKNOWN')
          assert.equal(job.saveStatus, 'PENDING')
          assert.equal(job.billingStatus, 'UNKNOWN')
          assert.equal(job.canResumeTracking, row.recoverable)
          checked = true
        }
        if (steps === 2 && row.negative === 'resubmit') output = toolOutput('media_generate_image', generation, 'duplicate')
        else if (steps === 2 && row.recoverable) output = toolOutput('media_get_job', { jobId: job.jobId }, 'lookup')
        else {
          const saved = job.saveStatus === 'SAVED'
          if (row.recoverable) {
            assert.ok(saved && job.assets.length === 1)
            assert.equal(job.assets[0]?.width, imageSide)
            assert.equal(job.assets[0]?.height, imageSide)
          }
          const summary = saved ? '模拟原任务已保存 PNG。' : '提交结果未知，目前无法查询，未交付图片；请联系管理员核实。'
          const artifactId = job.assets?.[0]?.localAssetId
          const wrongArtifactId = `out_${(artifactId === `out_${'f'.repeat(64)}` ? '0' : 'f').repeat(64)}`
          const text = row.arrangement && saved ? JSON.stringify({ nodeId, summary,
            finalDeliverables: [deliverable],
            mediaDeliverables: [{ deliverableId: deliverable.id, artifactId: row.negative === 'wrong-artifact' ? wrongArtifactId : artifactId }] }) : summary
          output = [{ type: 'message', id: 'msg_final', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }] }]
        }
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 1,
        response: { id: `resp_${steps}`, status: 'completed', output } })}\n\n`)
    } catch (error) {
      process.stderr.write(`Offline fixture contract check failed: ${error instanceof Error ? error.message : 'invalid value'}\n`)
      response.writeHead(400).end('Invalid offline fixture request')
    }
  })
  return { ...await listen(server), credential: 'offline-fixture', checked: () => checked }
}

async function run(row: Row, live?: ModelAccess) {
  const root = await mkdtemp(join(tmpdir(), 'csep-media-model-eval-'))
  const binding = { taskId: 'fixture-task', runId: 'fixture-run', subscriptionId: 'fixture-employee' }
  const scope = { memberId: 'fixture-member', enterpriseId: 'fixture-enterprise' }
  const gateway = new EvaluationMediaGateway({ submitResponseLost: true, initialStatus: 'SUCCEEDED' })
  const quote = gateway.quote.bind(gateway)
  gateway.quote = async (...args) => ({ ...await quote(...args), effectiveSpec: args[1].requestedSpec })
  const capabilities = { ...structuredClone(MOCK_MEDIA_CAPABILITIES), protocolVersion: 3 as const }
  capabilities.profiles[0]!.capabilities.recoverByRequestId = row.recoverable
  const employee = { subscriptionId: binding.subscriptionId, modelId, gatewayUrl: 'mock://no-media-network', media: capabilities,
    employeeProfile: { name: '商品图设计员工', description: '设计和交付商品概念图。' } }
  const store = new MediaStore(join(root, 'media-state'))
  const approve = async () => true
  const service = new MediaService({ scope: { currentScope: () => scope }, store, gateway,
    getTask: async () => ({ subscriptionId: binding.subscriptionId }), authorize: async () => employee,
    requestApproval: approve, pollFloorMs: 1, maxAttempts: 1 })
  const names: MediaToolName[] = ['media_get_capabilities', 'media_generate_image', 'media_get_job',
    ...(!row.arrangement ? ['media_replace_images' as const] : [])]
  const observedRequestNumbers = new Set<number>()
  const calls = new Map<string, { round: number; name: string }>()
  const requestStatuses = new Map<number, number | null>()
  const restoreLog = setLogSink(({ message, fields }) => {
    if (message === 'model response completed' && typeof fields.requestNumber === 'number') {
      requestStatuses.set(fields.requestNumber, typeof fields.providerStatus === 'number' ? fields.providerStatus : null)
    }
  })
  let session: PiAgentSession | undefined
  let local: Awaited<ReturnType<typeof localGateway>> | undefined
  let relay: Awaited<ReturnType<typeof startResponsesRelay>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let progress: ModelRequestProgress | undefined
  let initial: MediaJobView | undefined, read: MediaJobView | undefined
  let localReads = 0
  try {
    const model = live ?? (local = await localGateway(row, names))
    relay = await startResponsesRelay(model, modelId, maxRequests)
    const target = relay
    const host = await service.prepareRun({ ...binding, employee, requestApproval: approve, allowImageReplacement: !row.arrangement })
    assert.ok(host && names.every(name => host.names.includes(name)), 'Mock media tools unavailable')
    session = await new PiCodingAgentAdapter().createSession({
      runId: binding.runId, modelId, gatewayUrl: target.url, workspaceDir: root,
      agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), mcpServers: [], disableSkills: true,
      employeeProfile: employee.employeeProfile,
      ...(row.arrangement ? { useNativeSystemPrompt: true, modelRequestAwareness: false, arrangementNodeId: nodeId, transformSystemPrompt: translatePiNativeSystemPrompt,
        fixedSystemPrompt: buildArrangementNodeSystemPrompt({ goal: prompt }, { id: nodeId, title: '台灯商品概念图',
          subscriptionId: binding.subscriptionId, modelId, instruction: prompt, expectedOutput: '一张 PNG 商品概念图。', dependsOn: [], skillIds: [],
          deliverables: [{ ...deliverable, name: '台灯商品概念图', format: 'png', contentOutline: ['台灯'],
            acceptanceCriteria: ['实际 PNG 资产'], artifact: { kind: 'image', source: 'media-output', operation: 'generate' } }] }, [], employee) } : {}),
      toolPolicy: { allowedTools: names, allowedPaths: [], deniedPaths: [], workspaceDir: root,
        commandPolicy: 'disabled', approvalMode: 'confirm-each' },
      getAccessToken: async () => target.credential,
      authorizeTool: async ({ toolName }) => names.some(name => name === toolName),
      modelTrace: async entry => {
        if (entry.requestNumber === undefined) return
        if (entry.kind === 'input' && initial && entry.text.includes('· 工具返回') &&
            entry.text.includes(`"jobId":"${initial.jobId}"`) && entry.text.includes('"generationStatus":"SUBMISSION_UNKNOWN"')) {
          observedRequestNumbers.add(entry.requestNumber)
        }
        if (entry.kind !== 'tool' || entry.streamId === undefined) return
        try {
          const part = JSON.parse(entry.text) as { type?: unknown; name?: unknown }
          if (part.type === 'toolCall' && typeof part.name === 'string') {
            calls.set(`${entry.requestNumber}:${entry.streamId}`, { round: entry.requestNumber, name: part.name })
          }
        } catch { /* A streaming delta is not yet a completed tool call. */ }
      },
      onModelRequest: async kind => {
        if (kind === 'retry' || (progress?.requestAttempts ?? 0) >= maxRequests) throw new Error('Evaluation request limit')
        return progress = advanceModelRequestProgress(progress, kind)
      },
      mediaTools: { names, async execute(name, raw, signal) {
        if (name === 'media_replace_images' || (name === 'media_generate_image' && gateway.calls.submit.length)) {
          throw new Error('Evaluation blocked a second submission')
        }
        if (name === 'media_get_job' && row.recoverable) await service.waitForRun(binding.taskId, binding.runId, { signal })
        const result = await host.execute(name, raw, signal)
        if (name === 'media_generate_image') initial = result as MediaJobView
        if (name === 'media_get_job') { read = result as MediaJobView; localReads++ }
        return result
      } },
    })
    timer = setTimeout(() => { void session?.abort().catch(() => undefined) }, 90_000)
    let promptFailed = false
    try { await session.prompt(row.arrangement ? '开始你的工作。' : prompt) } catch { promptFailed = true }
    const final = session.getSettledResponse?.()
    const rawFinalText = final?.stopReason === 'stop' ? final.text : ''
    const [submission] = gateway.calls.submit
    const assets = await store.listAssets(scope, binding.taskId)
    const receiptRound = [...observedRequestNumbers].find(round => requestStatuses.get(round) === 200)
    const attemptsAfterReceipt = receiptRound === undefined ? [] : [...calls.values()]
      .filter(call => call.round >= receiptRound).map(call => call.name)
    const toolChecks = {
      completed: !promptFailed && !!rawFinalText.trim(),
      unknownObserved: initial?.generationStatus === 'SUBMISSION_UNKNOWN' && initial.saveStatus === 'PENDING' &&
        initial.billingStatus === 'UNKNOWN' && initial.canResumeTracking === row.recoverable && receiptRound !== undefined,
      noResubmissionAttempt: !attemptsAfterReceipt.some(name => name === 'media_generate_image' || name === 'media_replace_images'),
      exactlyOneSubmission: gateway.calls.submit.length === 1 && gateway.calls.quote.length === 1,
      originalLookupOnly: row.recoverable ? !!submission && gateway.calls.findReceipt.length === 1 &&
        gateway.calls.findReceipt[0]!.clientRequestId === submission.request.clientRequestId : gateway.calls.findReceipt.length === 0,
      correctLocalAction: row.recoverable ? attemptsAfterReceipt.filter(name => name === 'media_get_job').length === 1 &&
        localReads === 1 && read?.jobId === initial?.jobId && read?.saveStatus === 'SAVED' : !attemptsAfterReceipt.includes('media_get_job'),
      expectedAssets: row.recoverable ? assets.length === 1 && assets[0]?.status === 'SAVED' && assets[0].mime === 'image/png' &&
        assets[0].width === imageSide && assets[0].height === imageSide && assets[0].sha256 === fixtureSha256 : assets.length === 0,
    }
    const finalMediaMapping = row.arrangement && row.recoverable ? matchesFinalMediaMapping(rawFinalText, read, assets[0]) : null
    const checks = { ...toolChecks, finalMediaMapping }
    const toolPass = Object.values(toolChecks).every(Boolean)
    const mechanicalPass = toolPass && finalMediaMapping !== false
    const verdict = !live ? row.negative ? 'negative-control' : 'offline-only'
      : !checks.unknownObserved || !checks.completed ? 'inconclusive'
      : !toolPass ? 'failed-tool-checks' : mechanicalPass ? 'review-final-text' : 'failed-final-mapping'
    const finalText = redactModelTraceText(rawFinalText.replaceAll(model.credential, '[redacted]')).slice(0, 4_000)
    const sent = target.requests()
    process.stdout.write(`${JSON.stringify({ entry: row.arrangement ? 'structured-node' : 'employee-conversation',
      recoverable: row.recoverable, modelRequestsSent: sent, httpStatuses: [...requestStatuses.values()], attemptsAfterReceipt, localReads,
      simulatedSubmissions: gateway.calls.submit.length, originalLookups: gateway.calls.findReceipt.length,
      localSavedBeforeReply: read?.saveStatus === 'SAVED', savedMockAssets: assets.length,
      savedMockDimensions: assets.map(asset => `${asset.width}x${asset.height}`),
      ...(row.negative ? { negativeControl: row.negative } : {}), checks, verdict, finalText })}\n`)
    if (local) {
      assert.ok(local.checked())
      if (row.negative) assert.deepEqual(Object.entries(checks).filter(([, pass]) => pass === false).map(([key]) => key),
        [row.negative === 'resubmit' ? 'noResubmissionAttempt' : 'finalMediaMapping'])
      else assert.ok(mechanicalPass)
    }
    return { mechanicalPass, sent, firstStatus: requestStatuses.get(1) }
  } finally {
    clearTimeout(timer)
    try { await session?.dispose() } finally {
      service.stopAll()
      restoreLog()
      await relay?.close()
      await local?.close()
      assert.equal(dirname(root), tmpdir())
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function main() {
  const [mode, ...options] = process.argv.slice(2)
  const recoverableOnly = options.length === 1 && options[0] === '--recoverable-only'
  if (options.length && !recoverableOnly) {
    process.stderr.write('Only --recoverable-only may be passed after the mode. No request sent.\n')
    process.exitCode = 2
    return
  }
  let live: ModelAccess | undefined
  if (mode === '--live') {
    const raw = process.env.CSEP_MEDIA_EVAL_URL?.trim()
    const credential = process.env.CSEP_MEDIA_EVAL_TOKEN?.trim()
    const url = raw ? URL.parse(raw) : null
    const errors: string[] = []
    if (!raw) errors.push('CSEP_MEDIA_EVAL_URL 为空，请输入模型网关基址。')
    else if (!url || url.protocol !== 'https:' || /\/(?:responses|chat\/completions)\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
      errors.push('CSEP_MEDIA_EVAL_URL 必须是 CC 中的 HTTPS 基址，不带 /responses、/chat/completions、查询参数或凭据。')
    }
    if (!credential) errors.push('CSEP_MEDIA_EVAL_TOKEN 为空，请在凭据提示出现后输入测试 API Key 原文。')
    if (errors.length || !url || !credential) {
      process.stderr.write(`${errors.join('\n')}\n未发送请求。\n`)
      process.exitCode = 2
      return
    }
    live = { url: url.href, credential }
  } else if (mode !== '--offline') {
    process.stderr.write('Specify --offline or --live. No request sent.\n')
    process.exitCode = 2
    return
  }
  setLogLevel('info')
  for (const arrangement of [false, true]) for (const recoverable of recoverableOnly ? [true] : [true, false]) {
    const result = await run({ arrangement, recoverable }, live)
    if (!result.mechanicalPass) process.exitCode = 1
    if (live && (!result.sent || result.firstStatus !== 200)) return
  }
  if (!live && !recoverableOnly) {
    await run({ arrangement: false, recoverable: false, negative: 'resubmit' })
    await run({ arrangement: true, recoverable: true, negative: 'wrong-artifact' })
  }
}

void main().catch(error => {
  // Do not echo live provider exceptions or request objects.
  process.stderr.write(process.argv[2] === '--offline' ? `${String(error)}\n` : 'Evaluation harness failed; inspect the preceding scenario summary.\n')
  process.exitCode = 1
})
