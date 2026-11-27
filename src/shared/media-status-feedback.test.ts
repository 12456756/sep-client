import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MediaJobView } from './media'
import type { VideoJobView } from './video-host'
import { mediaIssueMessage } from './media-feedback'
import { mediaTrackingLabels } from './media-view'
import { RUNTIME_FAILURE_MESSAGES } from './runtime-feedback'

const { MediaJobList } = await import(new URL('../components/workspace/MediaArtifactsPanel.tsx', import.meta.url).href)
const { VideoJobList, videoTaskIssue } = await import(new URL('../components/workspace/VideoArtifactsPanel.tsx', import.meta.url).href)
const { FeedbackProvider } = await import(new URL('../components/feedback/FeedbackProvider.tsx', import.meta.url).href)
const noop = () => {}

test('429 cooling down displays waiting rather than generation or save failure', () => {
  for (const kind of ['image', 'video'] as const) {
    const message = mediaIssueMessage({ ...(kind === 'image' ? image() : video()), saveStatus: 'SAVING', rateLimitRetryAt: Date.now() + 600000 }, kind)
    assert.match(message!, /已生成.*等待自动恢复/)
    assert.doesNotMatch(message!, /失败|磁盘|重新保存/)
  }
  assert.match(mediaIssueMessage(video({ generationStatus: 'CANCELLED', saveStatus: 'PENDING', rateLimitRetryAt: 123 }), 'video')!, /已取消.*查询受限/)
  assert.match(mediaIssueMessage(image({ rateLimitRetryAt: 123 }), 'image')!, /已生成并保存.*恢复查询/)
})

function image(patch: Partial<MediaJobView> = {}): MediaJobView {
  return { jobId: 'job', taskId: 'task', runId: 'run', profileId: 'profile', operation: 'generate', parameters: {},
    generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', billingStatus: 'SETTLED',
    error: null, createdAt: 1, updatedAt: 1, assets: [], canCancelUpstream: false, ...patch }
}

function video(patch: Partial<VideoJobView> = {}): VideoJobView {
  return { jobId: 'job', taskId: 'task', profileId: 'profile', operation: 'text-to-video', parameters: {},
    generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', billingStatus: 'SETTLED',
    error: null, createdAt: 1, updatedAt: 1, outputs: [], ...patch }
}

function render(element: React.ReactElement): string {
  const previous = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try { return renderToStaticMarkup(React.createElement(FeedbackProvider, null, element)) }
  finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previous })
  }
}

function imageList(job: MediaJobView): string {
  return render(React.createElement(MediaJobList, { jobs: [job], archived: false, busy: false, onAction: noop }))
}

function videoList(job: VideoJobView, compact = true): string {
  return render(React.createElement(VideoJobList, { jobs: [job], busy: false, compact, onAction: noop, onPreview: noop, onExport: noop }))
}

const finished = ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'] as const
const expectedOutcome = { SUCCEEDED: /已生成/, PARTIAL_SUCCEEDED: /部分.*已生成/, FAILED: /生成失败/, CANCELLED: /已取消/, RESULT_EXPIRED: /已过期/ }
const actions = { submissionFinished: true, generationFinished: true, shouldPoll: false, pollPurpose: 'none' as const,
  canStartNewRequest: true, canRetryDownload: false }
const execution = { requestId: 'request', taskId: 'upstream', submissionStatus: 'accepted' as const,
  generationStatus: 'completed' as const, isFinal: true, observedAt: 1, statusSource: 'upstream' as const,
  billing: { status: 'settled' as const, actualCostUsd: '1' } }

test('all confirmed image outcomes suppress the ongoing generation warning on legacy records', () => {
  for (const generationStatus of finished) {
    const html = imageList(image({ generationStatus }))
    assert.doesNotMatch(html, /可能继续生成|可能继续计费|可能仍在执行/)
  }
})

test('stopping delivery or billing tracking never implies that completed generation continues', () => {
  for (const pollPurpose of ['delivery', 'billing'] as const) {
    const html = imageList(image({ trackingStatus: 'ACTIVE', saveStatus: 'SAVE_FAILED',
      clientActions: { ...actions, shouldPoll: true, pollPurpose } }))
    assert.match(html, /停止跟踪/)
    assert.match(html, /生成.*已结束/)
    assert.doesNotMatch(html, /可能继续生成|可能继续计费/)
  }
})

test('interruptions and recovery limits preserve every confirmed generation outcome for both media kinds', () => {
  for (const kind of ['image', 'video'] as const) {
    for (const generationStatus of finished) {
      for (const error of [null, 'TRACKING_LIMIT']) {
        const message = mediaIssueMessage({ ...image({ generationStatus, error, trackingStatus: 'INTERRUPTED' }) }, kind)!
        assert.match(message, expectedOutcome[generationStatus])
        assert.doesNotMatch(message, /生成结果仍待确认|尚未确认原任务|可能继续生成|可能继续计费/)
      }
    }
  }
})

test('recovery limits respect completed v2 generation and original query capability', () => {
  const message = mediaIssueMessage({ ...image({ trackingStatus: 'INTERRUPTED', error: 'TRACKING_LIMIT', canResumeTracking: false }),
    receiptVersion: 2, execution, clientActions: actions }, 'image')!
  assert.match(message, /已生成/)
  assert.doesNotMatch(message, /可恢复原任务跟踪|结果仍待确认/)
})

test('expired v2 results do not suggest retrying unavailable original downloads', () => {
  for (const kind of ['image', 'video'] as const) {
    const message = mediaIssueMessage({ ...image({ saveStatus: 'SAVE_FAILED', canRetrySave: false }), receiptVersion: 2,
      execution, clientActions: actions, fileStatus: 'expired' }, kind)!
    assert.match(message, /已过期.*无法重新下载/)
    assert.doesNotMatch(message, /请重新保存|重试下载|可能继续生成/)
  }
})

test('v2 unavailable results distinguish download prohibition from a recoverable disk failure', () => {
  const message = mediaIssueMessage({ ...image({ saveStatus: 'SAVE_FAILED', canRetrySave: false }), receiptVersion: 2,
    execution, clientActions: actions, fileStatus: 'unavailable', canDownload: false }, 'image')!
  assert.match(message, /已生成.*当前不可下载/)
  assert.doesNotMatch(message, /请重新保存|重试下载/)
  const recoverable = mediaIssueMessage({ ...image({ saveStatus: 'SAVE_FAILED', canRetrySave: true }), receiptVersion: 2,
    execution, clientActions: { ...actions, canRetryDownload: true }, fileStatus: 'available',
    failure: { code: 'INTERNAL_ERROR', stage: 'image-save', reasonCode: 'ENOSPC' } }, 'image')!
  assert.match(recoverable, /已生成.*清理磁盘空间后重新保存原结果/)
})

test('cancelled video summaries never claim success or wait for nonexistent outputs', () => {
  for (const billingStatus of ['SETTLED', 'RESERVED', 'RELEASED', 'RECONCILING', 'UNKNOWN'] as const) {
    const job = video({ generationStatus: 'CANCELLED', saveStatus: 'PENDING', billingStatus })
    for (const compact of [true, false]) {
      const html = videoList(job, compact)
      assert.match(html, /已取消/)
      assert.doesNotMatch(html, /生成完成|等待保存|可能继续生成|可能继续计费/)
    }
    if (billingStatus === 'RESERVED' || billingStatus === 'RECONCILING') assert.match(videoList(job), /费用.*核对/)
  }
})

test('legacy video expiry is reported from unsaved output deadlines without expiring saved files', () => {
  const expired = { outputId: 'expired', kind: 'video' as const, mimeType: 'video/mp4', byteLength: 1, sha256: 'a'.repeat(64),
    durationSeconds: 5, width: 1280, height: 720, frameRate: 24, thumbnailOutputId: null, expiresAt: '2020-01-01T00:00:00Z' }
  const job = video({ saveStatus: 'SAVE_FAILED', outputs: [expired], canDownload: true,
    error: 'VIDEO_SAVE_FAILED', failure: { code: 'INTERNAL_ERROR', stage: 'video-save' } })
  assert.match(videoTaskIssue([job])!, /已过期.*无法重新下载/)
  assert.doesNotMatch(videoList(job), />重新保存<|>继续</)
  assert.equal(videoTaskIssue([video({ outputs: [expired], savedOutputIds: ['expired'] })]), null)
  const mixed = video({ ...job, outputs: [expired, { ...expired, outputId: 'available', expiresAt: null }] })
  assert.match(videoTaskIssue([mixed])!, /部分.*已过期/)
  assert.match(videoList(mixed), />重新保存</)
})

test('terminal media without outputs does not advertise pending saves', () => {
  for (const generationStatus of ['FAILED', 'CANCELLED'] as const) {
    assert.doesNotMatch(imageList(image({ generationStatus, saveStatus: 'PENDING' })), /等待保存/)
    assert.doesNotMatch(videoList(video({ generationStatus, saveStatus: 'PENDING' }), false), /等待保存/)
  }
})

test('expired video output details never promise preview after an impossible save', () => {
  const output = { outputId: 'expired', kind: 'video' as const, mimeType: 'video/mp4', byteLength: 1, sha256: 'a'.repeat(64),
    durationSeconds: 5, width: 1280, height: 720, frameRate: 24, thumbnailOutputId: null, expiresAt: '2020-01-01T00:00:00Z' }
  const html = videoList(video({ saveStatus: 'SAVE_FAILED', outputs: [output] }), false)
  assert.match(html, /已过期.*无法重新下载/)
  assert.doesNotMatch(html, /保存后可预览或导出/)
})

test('platform file availability does not invalidate a verified local result', () => {
  for (const kind of ['image', 'video'] as const) {
    for (const fileStatus of ['expired', 'download_failed', 'unavailable'] as const) {
      assert.equal(mediaIssueMessage({ ...image(), receiptVersion: 2, execution, clientActions: actions, fileStatus }, kind), null)
    }
  }
})

test('v2 query interruptions identify the confirmed result as well as the interrupted operation', () => {
  for (const kind of ['image', 'video'] as const) {
    const message = mediaIssueMessage({ ...image({ trackingStatus: 'INTERRUPTED' }), receiptVersion: 2,
      execution, clientActions: actions, fileStatus: 'available' }, kind)!
    assert.match(message, /已生成.*查询已中断/)
    assert.doesNotMatch(message, /尚未确认|可能继续/)
  }
})

test('a stopped uncertain submission never becomes a rejection just because its transport error says not submitted', () => {
  const message = mediaIssueMessage({ ...image({ generationStatus: 'SUBMISSION_UNKNOWN', error: 'TRACKING_LIMIT' }),
    failure: { code: 'SERVICE_UNAVAILABLE', stage: 'image-submit', submissionState: 'not_submitted' } }, 'image')!
  assert.match(message, /提交结果仍待确认/)
  assert.doesNotMatch(message, /未提交，本次请求已结束/)
})

test('a rejected query never reclassifies an already successful generation as not submitted', () => {
  const message = mediaIssueMessage({ ...image({ trackingStatus: 'INTERRUPTED', error: 'TRACKING_LIMIT' }),
    failure: { code: 'SERVICE_UNAVAILABLE', stage: 'image-query', submissionState: 'not_submitted' } }, 'image')!
  assert.match(message, /图片已生成/)
  assert.doesNotMatch(message, /图片未提交|生成失败|生成结果仍待确认/)
})

test('explicit saved output IDs take precedence over an aggregate saved status when checking expiry', () => {
  const job = video({ saveStatus: 'SAVED', savedOutputIds: [], outputs: [{ outputId: 'expired', kind: 'video',
    mimeType: 'video/mp4', byteLength: 1, sha256: 'a'.repeat(64), durationSeconds: 5, width: 1280, height: 720,
    frameRate: 24, thumbnailOutputId: null, expiresAt: '2020-01-01T00:00:00Z' }] })
  assert.match(videoTaskIssue([job])!, /已过期.*无法重新下载/)
})

test('generic interruption labels do not guess the generation result or promise unavailable recovery', () => {
  assert.doesNotMatch(mediaTrackingLabels.INTERRUPTED.label, /可恢复/)
  assert.match(RUNTIME_FAILURE_MESSAGES.MEDIA_QUERY_UNAVAILABLE, /查询.*中断.*任务详情/)
  assert.doesNotMatch(RUNTIME_FAILURE_MESSAGES.MEDIA_QUERY_UNAVAILABLE, /尚未确认生成结果|生成失败|可能继续生成/)
})
