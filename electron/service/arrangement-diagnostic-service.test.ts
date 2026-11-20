import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { ArrangementDiagnosticStore } from '../data/arrangement-diagnostic-store'
import { workDiagnosticRequest } from '../domain/arrangement-diagnostic'
import { ArrangementMediaRecoveryError } from '../domain/arrangement-media-runtime'
import type { LocalMediaJob } from '../domain/media'
import type { LocalVideoJob } from '../domain/video-media'
import { appendMediaDiagnosticError, describeArrangementFailure } from '../errors/arrangement-diagnostic'
import { AppError } from '../errors/app-error'
import { trackModelFailureEvidence } from '../runtime/model-failure-evidence'
import { trackMediaToolFailureEvidence } from '../runtime/media-tool-failure-evidence'
import { ArrangementDiagnosticService } from './arrangement-diagnostic-service'

const owner = { enterpriseId: 'enterprise', memberId: 'member' }
const request = { taskId: 'task', nodeId: 'node', nodeRunId: 'run' }
const input = { ...request, failedAt: 1, attempt: 2, phase: 'media-wait' as const,
  ...describeArrangementFailure(new AppError('SERVICE_UNAVAILABLE', { message: 'Gateway connection failed', diagnostic: {
    code: 'gateway_failure', sepRequestId: 'request-123', httpStatus: 503, body: { secret: 'PRIVATE_RESPONSE', message: 'Provider unavailable' },
  } })) }

async function setup(t: TestContext, jobs: LocalVideoJob[] = [], listImageJobs?: () => Promise<LocalMediaJob[]>) {
  const dir = await mkdtemp(join(tmpdir(), 'arrangement-diagnostic-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const store = new ArrangementDiagnosticStore(dir)
  let current = owner
  let revision = 0
  const service = new ArrangementDiagnosticService({ clientVersion: '0.5.6', store,
    scope: { currentScope: () => current }, authorizationRevision: () => revision, listVideoJobs: async () => jobs, listImageJobs })
  return { dir, store, service, setOwner: (next: typeof owner) => { current = next; revision++ } }
}

it('exports one scoped attempt on the stable build and distinguishes video submission states', async t => {
  const base = { runId: 'run', saveStatus: 'PENDING', updatedAt: 1, failure: { stage: 'video-submit', code: 'SERVICE_UNAVAILABLE', requestId: 'video-request', message: 'Video service unavailable' } }
  const jobs = [
    { ...base, jobId: 'unsent', submission: 'NOT_SENT' },
    { ...base, jobId: 'uncertain', submission: 'MAYBE_SENT' },
    { ...base, jobId: 'recovered', runId: 'older', submission: 'RECEIPTED', receipt: { status: 'QUEUED' } },
    { ...base, jobId: 'unrelated', runId: 'older', submission: 'RECEIPTED', receipt: { status: 'RUNNING' } },
  ] as unknown as LocalVideoJob[]
  const { dir, service, store, setOwner } = await setup(t, jobs)
  await service.record(owner, input, { subscriptionId: 'employee', recoveredJobIds: ['recovered'] })
  const target = join(dir, 'export.json')
  assert.equal(await service.export(request, async name => { assert.equal(name, 'work-diagnostic-run.json'); return target }), true)
  const text = await readFile(target, 'utf8')
  const saved = await store.get(owner, request)
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(saved)))
  assert.equal(saved?.evidence?.requestId, 'request-123')
  assert.equal(saved?.exception?.entries[0]?.diagnostic?.body && JSON.stringify(saved.exception.entries[0].diagnostic.body),
    '{"secret":"[redacted]","message":"Provider unavailable"}')
  assert.equal(saved?.clientVersion, '0.5.6')
  assert.deepEqual(saved?.video.jobs.map(job => [job.jobId, job.submission]), [
    ['unsent', 'NOT_SUBMITTED'], ['uncertain', 'SUBMISSION_UNKNOWN'], ['recovered', 'SUBMITTED'],
  ])
  assert.equal(saved?.video.jobs[0]?.failureDetail?.message, 'Video service unavailable')
  assert.doesNotMatch(text, /PRIVATE_|unrelated|member|employee/)
  assert.equal(await store.get(owner, { ...request, nodeId: 'other' }), null)
  assert.equal(await store.get({ ...owner, enterpriseId: 'other' }, request), null)
  setOwner({ ...owner, memberId: 'other' })
  await assert.rejects(service.export(request, async () => assert.fail('must not open a save dialog')), { code: 'NOT_FOUND' })
})

it('rejects invalid input and stale authorization; cancel does not write', async t => {
  assert.equal(workDiagnosticRequest.safeParse({ ...request, taskId: '../other' }).success, false)
  assert.equal(workDiagnosticRequest.safeParse({ taskId: 'task', runId: '../other' }).success, false)
  assert.equal(workDiagnosticRequest.safeParse({ ...request, runId: 'run' }).success, false)
  assert.equal(workDiagnosticRequest.safeParse({ ...request, file: 'provided-by-renderer.json' }).success, false)
  const { dir, service, setOwner } = await setup(t)
  await service.record(owner, input)
  assert.equal(await service.export(request, async () => null), false)
  const path = join(dir, 'not-written.json')
  await assert.rejects(service.export(request, async () => { setOwner(owner); return path }), { code: 'AUTH_REQUIRED' })
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

it('exports only the requested conversation turn without replacing a node diagnostic with the same run id', async t => {
  const { dir, service, store, setOwner } = await setup(t)
  const turn = { taskId: request.taskId, runId: request.nodeRunId }
  await service.record(owner, input)
  await service.record(owner, { ...turn, failedAt: 2, phase: 'model-execution', ...describeArrangementFailure(new Error('Conversation worker failed')) })
  const path = join(dir, 'conversation.json')
  assert.equal(await service.export(turn, async () => path), true)
  const output = await readFile(path, 'utf8')
  assert.equal(JSON.parse(output).runId, turn.runId)
  assert.doesNotMatch(output, /nodeRunId/)
  assert.match(output, /Conversation worker failed/)
  assert.equal((await store.get(owner, request))?.failedAt, 1)
  await assert.rejects(service.export({ ...turn, runId: 'other' }, async () => assert.fail()), { code: 'NOT_FOUND' })
  setOwner({ ...owner, memberId: 'other' })
  await assert.rejects(service.export(turn, async () => assert.fail()), { code: 'NOT_FOUND' })
})

it('keeps the original exception, stack, system fields and aggregate causes without credentials', () => {
  const nested = Object.assign(new Error('EACCES: C:/work/customer.txt'), { code: 'EACCES', errno: -4092, syscall: 'open', path: 'C:/work/customer.txt' })
  const failure = describeArrangementFailure(new AggregateError([new TypeError('Secondary failure; Bearer PRIVATE_TOKEN')], 'Local write failed', {
    cause: nested,
  }))
  assert.equal(failure.reason, 'EACCES')
  assert.deepEqual(failure.exception.entries.map(entry => [entry.parent, entry.relation, entry.name]),
    [[undefined, undefined, 'AggregateError'], [0, 'cause', 'Error'], [0, 'aggregate', 'TypeError']])
  assert.equal(failure.exception.entries[1]?.path, 'C:/work/customer.txt')
  assert.match(failure.exception.entries[1]?.stack ?? '', /EACCES: C:\/work\/customer.txt/)
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_TOKEN/)
  assert.equal(describeArrangementFailure(new Error('ATTACHMENT_INTEGRITY_MISMATCH')).reason, 'ATTACHMENT_INTEGRITY_MISMATCH')
  assert.equal(describeArrangementFailure(new Error('Agent run failed.')).reason, 'SDK_MISSING_FAILURE_REASON')
})

const imageJobs = [{ jobId: 'image-job', runId: 'run', subscriptionId: 'employee', clientRequestId: 'image-client-request',
  receiptId: null, submission: 'MAYBE_SENT', generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'STOPPED', saveStatus: 'PENDING',
  updatedAt: 10, createdAt: 1, attempts: 3, lastQueriedAt: 9, outputs: [], billingStatus: 'UNKNOWN',
  failure: { stage: 'image-query', code: 'NETWORK_TIMEOUT', requestId: 'query-request' },
  submissionFailure: { stage: 'image-submit', code: 'SERVICE_UNAVAILABLE', source: 'upstream', httpStatus: 502,
    requestId: 'submit-request', diagnostic: { sepRequestId: 'sep-submit-request', upstreamRequestId: 'provider-request',
      body: { message: 'Provider rejected submission', input: 'PRIVATE_INPUT' },
      headers: { 'x-request-id': 'sep-submit-request', 'set-cookie': 'PRIVATE_COOKIE' } } },
  diagnosticErrors: appendMediaDiagnosticError(undefined, 'image-submit', new TypeError('Socket closed'), 1),
  input: { creativeBrief: 'PRIVATE_BRIEF' },
}] as unknown as LocalMediaJob[]

it('exports the image submission and query evidence for the failing conversation only', async t => {
  const image = imageJobs[0]!
  const { dir, service } = await setup(t, [], async () => [image, { ...image, runId: 'other', jobId: 'unrelated' },
    { ...image, runId: 'older', jobId: 'recovered' }, { ...image, subscriptionId: 'someone', jobId: 'different-employee' }])
  const turn = { taskId: 'task', runId: 'run' }
  await service.record(owner, { ...turn, failedAt: 11, phase: 'media-wait',
    ...describeArrangementFailure(new ArrangementMediaRecoveryError('submission', new Error('Missing receipt'))) },
  { subscriptionId: 'employee', recoveredJobIds: ['recovered'] })
  const target = join(dir, 'image.json')
  assert.equal(await service.export(turn, async () => target), true)
  const text = await readFile(target, 'utf8')
  const saved = JSON.parse(text)
  assert.equal(saved.image.source, 'failure-time')
  assert.deepEqual(saved.image.jobs.map((job: { jobId: string; association: string }) => [job.jobId, job.association]),
    [['image-job', 'run'], ['recovered', 'recovery']])
  const job = saved.image.jobs[0]
  assert.equal(job.submission, 'SUBMISSION_UNKNOWN')
  assert.equal(job.clientRequestId, 'image-client-request')
  assert.equal(job.receiptId, null)
  assert.equal(job.submissionFailure.diagnostic.upstreamRequestId, 'provider-request')
  assert.deepEqual(job.submissionFailure.diagnostic.body, { message: 'Provider rejected submission' })
  assert.equal(job.failureDetail.requestId, 'query-request')
  assert.equal(job.diagnosticErrors.entries[0].exception.entries[0].message, 'Socket closed')
  assert.doesNotMatch(text, /PRIVATE_|unrelated|different-employee/)
})

it('backfills only original-run image evidence on legacy exports and reports local lookup failures independently', async t => {
  const { dir, service, store } = await setup(t, [], async () => [...imageJobs, { ...imageJobs[0]!, jobId: 'unrelated', runId: 'old' }])
  const { exception: _exception, ...legacy } = input
  await store.save(owner, { ...legacy, clientVersion: '0.5.6', version: 1, video: { evidence: 'not-applicable', jobs: [] } })
  const path = join(dir, 'legacy.json')
  assert.equal(await service.export(request, async () => path), true)
  const result = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(result.image.source, 'export-time')
  assert.equal(result.image.jobs.length, 1)
  assert.equal(result.exception, undefined)
  assert.equal((await store.get(owner, request))?.image, undefined)

  const failing = new ArrangementDiagnosticService({ scope: { currentScope: () => owner }, store, authorizationRevision: () => 0,
    clientVersion: '0.5.6', listImageJobs: async () => { throw new Error('Image manifest unreadable') }, listVideoJobs: async () => [] })
  await failing.record(owner, input, { subscriptionId: 'employee' })
  const saved = await store.get(owner, request)
  assert.equal(saved?.image?.lookupError?.entries[0]?.message, 'Image manifest unreadable')
  assert.equal(saved?.video.evidence, 'no-local-job')
})

it('retains model retry and pre-job tool errors without copying trace or tool input', async () => {
  const model = trackModelFailureEvidence()
  await model.record({ phase: '', kind: 'status', requestNumber: 1, text: 'PRIVATE_TRACE', metrics: {
    '原因链': '[{"code":"UND_ERR_SOCKET","message":"Other side closed"}]', '传输阶段': 'stream', '底层错误码': 'UND_ERR_SOCKET',
    '关联诊断': '{"sepRequestId":"first-request"}', other: 'PRIVATE_METRIC',
  } })
  await model.record({ phase: '', kind: 'status', requestNumber: 2, text: 'PRIVATE_TRACE', metrics: { '响应状态码': 200, '平台请求标识': 'retry-request' } })
  assert.equal(model.evidence()?.requestId, 'retry-request')
  assert.equal(model.history()?.entries[0]?.relatedDiagnostic?.sepRequestId, 'first-request')
  assert.equal(model.history()?.entries[0]?.causes?.[0]?.code, 'UND_ERR_SOCKET')
  assert.equal(model.history()?.total, 1)
  assert.doesNotMatch(JSON.stringify(model.history()), /PRIVATE_/)
  await model.record({ phase: '', kind: 'tool', text: 'PRIVATE_TOOL_TRACE', metrics: {
    失败工具: 'read', 工具调用标识: 'call-1', 工具失败分类: 'execution-failed', 工具耗时毫秒: 2,
    工具错误信息: 'ENOENT: no such file', other: 'PRIVATE_TOOL_INPUT',
  } })
  assert.equal(model.toolFailures()?.entries[0]?.message, 'ENOENT: no such file')
  assert.doesNotMatch(JSON.stringify(model.toolFailures()), /PRIVATE_/)

  const media = trackMediaToolFailureEvidence()
  const error = new AppError('SERVICE_UNAVAILABLE', { message: 'Quote unavailable' })
  const tools = media.wrap({ names: ['media_generate_image'], async execute() { throw error } })!
  await assert.rejects(tools.execute('media_generate_image', { prompt: 'PRIVATE_TOOL_INPUT' }), thrown => thrown === error)
  assert.equal(media.history()?.entries[0]?.exception.entries[0]?.message, 'Quote unavailable')
  assert.doesNotMatch(JSON.stringify(media.history()), /PRIVATE_TOOL_INPUT/)
})
