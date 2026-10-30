import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArrangementNode } from '../domain/arrangement-plan'
import { buildDeliveryCorrection, DeliveryExecutionError, type DeliverySubmission, type NodeDeliveryProgress } from '../domain/arrangement-delivery'
import { ArrangementMediaRecoveryError, ArrangementMediaSubmissionError, type ArrangementMediaSession } from '../domain/arrangement-media-runtime'
import { AppError } from '../errors/app-error'
import { ArrangementDeliveryValidation, buildArrangementDeliveryCorrection, resolveArrangementNodeFailure,
  type ArrangementDeliveryCheck } from './arrangement-delivery-validation'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(media?: Partial<ArrangementMediaSession>) {
  const root = await mkdtemp(join(tmpdir(), 'sep-delivery-validation-'))
  roots.push(root)
  await mkdir(join(root, 'deliverables'))
  const node: ArrangementNode = { id: 'node', title: 'Report', subscriptionId: 'employee', modelId: 'model', objective: 'Write a report',
    instruction: 'Write a report', expectedOutput: 'Report', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
    deliverables: [{ id: 'report', name: 'Report', format: 'txt', path: 'deliverables/report.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Saved'] }] }
  const submission: DeliverySubmission = { nodeId: node.id, summary: 'Saved report', finalDeliverables: [{ id: 'report', path: 'deliverables/report.txt' }] }
  let progress: NodeDeliveryProgress = { validationAttempts: 0, finalFiles: [], issues: [] }
  const saved: NodeDeliveryProgress[] = [], checked: ArrangementDeliveryCheck[] = []
  const signal = new AbortController()
  const mediaSession: ArrangementMediaSession | undefined = media && {
    inputPrompt: '', recoverJobIds: [], readyForTracking: () => false, automaticSubmission: async () => undefined,
    artifactSummary: async () => [], onJobCreated: async () => {}, bind: () => ({}), materialize: async () => [], ...media,
  }
  const options = { node, workspaceDir: root, nodeRunId: 'run', signal: signal.signal,
    fileOptions: { taskDirectory: join(root, 'task') }, mediaSession,
    getProgress: () => progress,
    saveProgress: async (value: NodeDeliveryProgress) => { progress = value; saved.push(structuredClone(value)) },
    checkControl: () => {}, waitForMedia: async () => {}, onChecked: async (value: ArrangementDeliveryCheck) => { checked.push(value) },
  }
  return { root, node, submission, signal, saved, checked, options,
    progress: () => progress, validation: new ArrangementDeliveryValidation(options),
    write: () => writeFile(join(root, 'deliverables/report.txt'), 'Verified findings') }
}

test('unified correction supplies actual node data and diagnostics while preserving the media suffix', async () => {
  const f = await fixture()
  const issues = [{ code: 'INVALID_SUBMISSION', message: 'Actual diagnostic' }]
  const assets = [{ kind: 'video' as const, jobId: 'original-job', assets: [] }]
  assert.equal(buildArrangementDeliveryCorrection(issues, f.node), buildDeliveryCorrection(issues, f.node))
  assert.equal(buildArrangementDeliveryCorrection(issues, f.node, assets), buildDeliveryCorrection(issues, f.node) +
    `\n【主进程已核验的媒体资产】\n${JSON.stringify(assets)}\n仅从这些原任务资产选择交付，不等待、不重新生成。`)
  assert.equal(buildArrangementDeliveryCorrection(issues, f.node, []), buildDeliveryCorrection(issues, f.node) +
    '\n【主进程已核验的媒体资产】\n[]\n仅从这些原任务资产选择交付，不等待、不重新生成。')
})

test('normal validation waits before incrementing attempts and accepts real document files', async () => {
  const f = await fixture()
  let waits = 0
  f.options.waitForMedia = async () => { waits++; assert.equal(f.progress().validationAttempts, 0); await f.write() }
  const result = await f.validation.settle({ text: JSON.stringify(f.submission), stopReason: 'stop' })
  assert.equal(result.status, 'accepted')
  assert.equal(waits, 1)
  assert.equal(f.progress().validationAttempts, 1)
  assert.equal(f.progress().finalFiles.length, 1)
  assert.equal(f.progress().summary, f.submission.summary)
  assert.equal(f.checked[0]?.accepted, true)
  assert.equal(f.checked[0]?.validationKind, 'files')
})

test('submission errors include real diagnostics and file errors retain their original prompt', async () => {
  const f = await fixture()
  const invalid = await f.validation.settle({ text: 'not JSON', stopReason: 'stop' })
  assert.equal(invalid.status, 'correction')
  if (invalid.status === 'correction') {
    assert.equal(invalid.continueWith, buildDeliveryCorrection(f.progress().issues, f.node))
    assert.match(invalid.continueWith, /字段、节点 ID、交付清单和实际文件检查尚未执行/)
    assert.ok(invalid.continueWith.includes(JSON.stringify(f.node.id)))
  }
  assert.equal(f.progress().issues[0]?.code, 'INVALID_SUBMISSION')
  assert.equal(f.checked[0]?.validationKind, 'submission')
  const missing = await f.validation.settle({ text: JSON.stringify(f.submission), stopReason: 'stop' })
  assert.equal(missing.status, 'correction')
  if (missing.status === 'correction') assert.equal(missing.continueWith, buildDeliveryCorrection(f.progress().issues, f.node))
  assert.equal(f.progress().issues[0]?.code, 'FILE_MISSING')
  assert.equal(f.checked[1]?.validationKind, 'files')
})

test('document and mixed nodes keep correcting beyond two and five attempts', async () => {
  for (const media of [undefined, {}]) {
    const f = await fixture(media)
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = await f.validation.settle({ text: '', stopReason: 'stop' })
      assert.equal(result.status, 'correction')
      assert.equal(f.progress().validationAttempts, attempt)
    }
  }
})

for (const kind of ['image', 'video'] as const) {
  test(`pure ${kind} keeps correcting JSON, fields, node IDs and manifests beyond two and five failures`, async () => {
    let summaries = 0
    const f = await fixture({ artifactSummary: async () => { summaries++; return [] } })
    f.node.deliverables![0]!.artifact = { kind, source: 'media-output' }
    const submission = { ...f.submission, mediaDeliverables: [{ deliverableId: 'report', artifactId: 'original-asset' }] }
    const invalid = [
      { text: '', code: 'INVALID_SUBMISSION' },
      { text: JSON.stringify({ ...submission, summary: '' }), code: 'INVALID_SUBMISSION' },
      { text: JSON.stringify({ ...submission, nodeId: 'other' }), code: 'WRONG_NODE' },
      { text: JSON.stringify({ ...submission, finalDeliverables: [{ id: 'report', path: 'wrong-path' }] }), code: 'DELIVERY_MANIFEST_MISMATCH' },
      { text: JSON.stringify({ ...submission, finalDeliverables: [...submission.finalDeliverables, ...submission.finalDeliverables] }), code: 'DELIVERY_MANIFEST_MISMATCH' },
      { text: JSON.stringify({ ...submission, finalDeliverables: [{ id: 'unknown', path: 'unknown' }] }), code: 'MISSING_DELIVERY' },
      { text: JSON.stringify({ ...submission, mediaDeliverables: [] }), code: 'MISSING_MEDIA_DELIVERY' },
      { text: JSON.stringify({ ...submission, mediaDeliverables: [...submission.mediaDeliverables, ...submission.mediaDeliverables] }), code: 'DUPLICATE_MEDIA_DELIVERY' },
    ]
    for (const [index, response] of invalid.entries()) {
      const result = await f.validation.settle({ text: response.text, stopReason: 'stop' })
      assert.equal(result.status, 'correction')
      assert.ok(f.progress().issues.some(issue => issue.code === response.code))
      assert.equal(f.progress().validationAttempts, index + 1)
      assert.equal(f.checked[index]?.accepted, false)
      if (result.status === 'correction') assert.equal(result.continueWith, buildArrangementDeliveryCorrection(f.progress().issues, f.node, []))
    }
    assert.equal(f.checked.length, invalid.length)
    assert.equal(summaries, invalid.length)
  })

  for (const failure of ['mapping', 'files'] as const) test(`pure ${kind} keeps correcting ${failure} failures with a restored high attempt count`, async () => {
    const f = await fixture(failure === 'mapping'
      ? { materialize: async () => { throw new ArrangementMediaSubmissionError('Invalid original mapping') } }
      : {})
    f.node.deliverables![0]!.artifact = { kind, source: 'media-output' }
    const submission = { ...f.submission, mediaDeliverables: [{ deliverableId: 'report', artifactId: 'original-asset' }] }
    await f.options.saveProgress({ validationAttempts: 20, finalFiles: [], issues: [] })
    for (let attempt = 21; attempt <= 28; attempt++) {
      const result = await f.validation.settle({ text: JSON.stringify(submission), stopReason: 'stop' })
      assert.equal(result.status, 'correction')
      assert.equal(f.progress().issues[0]?.code, failure === 'mapping' ? 'MEDIA_DELIVERY_MANIFEST_MISMATCH' : 'INVALID_FORMAT')
      assert.equal(f.progress().validationAttempts, attempt)
      assert.equal(f.checked.at(-1)?.validationKind, 'files')
    }
  })
}

test('normal settlement corrects media mappings but does not absorb copy or download failures', async () => {
  const mapping = new ArrangementMediaSubmissionError('Invalid original mapping')
  const f = await fixture({ materialize: async () => { throw mapping } })
  assert.equal((await f.validation.settle({ text: JSON.stringify(f.submission), stopReason: 'stop' })).status, 'correction')
  assert.equal(f.progress().issues[0]?.code, 'MEDIA_DELIVERY_MANIFEST_MISMATCH')
  const copy = new Error('EACCES')
  f.options.mediaSession!.materialize = async () => { throw copy }
  const copying = await f.validation.settle({ text: JSON.stringify(f.submission), stopReason: 'stop' })
  assert.equal(copying.status, 'failed')
  if (copying.status === 'failed') {
    assert.ok(copying.error instanceof ArrangementMediaRecoveryError)
    assert.equal(copying.error.cause, copy)
    assert.equal(copying.stage, 'materialization')
  }
  const download = new AppError('INVALID_STATE')
  f.options.waitForMedia = async () => { throw download }
  const downloading = await f.validation.settle({ text: '', stopReason: 'stop' })
  assert.equal(downloading.status, 'failed')
  if (downloading.status === 'failed') { assert.equal(downloading.error, download); assert.equal(downloading.stage, 'media-wait') }
  assert.equal(f.progress().validationAttempts, 2)
})

test('host automatic submission remains restricted to a normally settled reply', async () => {
  let automatic = 0
  const f = await fixture({ automaticSubmission: async () => { automatic++; return f.submission } })
  await f.write()
  assert.equal((await f.validation.settle({ text: '', stopReason: 'length' })).status, 'correction')
  assert.equal(automatic, 0)
  assert.equal((await f.validation.settle({ text: 'Host will deliver.', stopReason: 'stop' })).status, 'accepted')
  assert.equal(automatic, 1)
})

test('recovery preserves validation counts and pending submissions without model correction or checked events', async () => {
  const f = await fixture({ automaticSubmission: async () => f.submission })
  await f.write()
  const result = await f.validation.resume()
  assert.equal(result.status, 'accepted')
  assert.equal(f.progress().validationAttempts, 0)
  assert.equal(f.progress().mediaPhase, 'delivered')
  assert.equal(f.progress().pendingSubmission, undefined)
  assert.equal(f.checked.length, 0)
  const ambiguous = await fixture({})
  assert.equal((await ambiguous.validation.resume()).status, 'pending')
  assert.equal(ambiguous.progress().validationAttempts, 0)
  assert.equal(ambiguous.checked.length, 0)
})

test('recovery sends invalid pending submissions and mappings back to the original employee', async () => {
  const f = await fixture({})
  await f.options.saveProgress({ validationAttempts: 3, finalFiles: [], issues: [], pendingSubmission: { ...f.submission, nodeId: 'other' } })
  const invalid = await f.validation.resume()
  assert.equal(invalid.status, 'correction')
  if (invalid.status === 'correction') assert.match(invalid.continueWith, /other/)
  assert.equal(f.progress().pendingSubmission, undefined)
  const error = new ArrangementMediaSubmissionError('Invalid recovered mapping')
  await f.options.saveProgress({ ...f.progress(), pendingSubmission: f.submission })
  f.options.mediaSession!.materialize = async () => { throw error }
  const mapping = await f.validation.resume()
  assert.equal(mapping.status, 'correction')
  if (mapping.status === 'correction') assert.match(mapping.continueWith, /Invalid recovered mapping/)
  assert.equal(f.progress().validationAttempts, 3)
  assert.equal(f.checked.length, 0)
})

test('temporary media copy errors are retried without asking the model to generate again', async () => {
  let copies = 0
  const f = await fixture({ materialize: async () => {
    if (++copies < 3) throw Object.assign(new Error('temporary sharing violation'), { code: 'EBUSY' })
    return []
  } })
  await f.write()
  assert.equal((await f.validation.settle({ text: JSON.stringify(f.submission) })).status, 'accepted')
  assert.equal(copies, 3)
  assert.equal(f.progress().validationAttempts, 1)
})

test('cancellation cannot become a correction or increment validation counts', async () => {
  const f = await fixture()
  const reason = new Error('User stopped')
  f.signal.abort(reason)
  const result = await f.validation.settle({ text: '', stopReason: 'stop' })
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.equal(result.error, reason)
  assert.equal(f.progress().validationAttempts, 0)
  assert.equal(f.checked.length, 0)
})

test('unified failure presentation preserves current UI text and terminal classification', () => {
  assert.deepEqual(resolveArrangementNodeFailure(new ArrangementMediaRecoveryError('download', new Error('Original expired')), false, false), {
    message: '图片或视频下载失败，自动恢复未成功，请联系平台管理员', terminal: false,
  })
  assert.deepEqual(resolveArrangementNodeFailure(new ArrangementMediaRecoveryError('copy', new Error('ENOSPC')), false, false), {
    message: '图片或视频已生成，但保存到交付目录失败，请联系平台管理员', terminal: false,
  })
  assert.deepEqual(resolveArrangementNodeFailure(new DeliveryExecutionError('Invalid manifest'), false, false), {
    message: '工作成果校验未通过，请联系平台管理员', terminal: true,
  })
  assert.deepEqual(resolveArrangementNodeFailure(new Error('EACCES'), false, false), {
    message: '工作运行失败，请联系平台管理员', terminal: false,
  })
  assert.deepEqual(resolveArrangementNodeFailure(new AppError('AUTH_REQUIRED'), false, true), {
    message: '登录验证未通过，请重新登录', terminal: true,
  })
  assert.deepEqual(resolveArrangementNodeFailure(new DeliveryExecutionError('Stopped'), true, true), {
    message: '工作已停止', terminal: false,
  })
})
