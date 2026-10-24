import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MediaAssetView, MediaJobView, MediaProfile } from './media'
import { imageFormAspectRatios, imageFormParameters, imageFormSizes, mediaGenerationLabels, mediaInputProblem, mediaJobActions, mediaSaveLabels, mediaTrackingLabels, selectMediaProfile } from './media-view'
import { imageAspectRatio } from './media-spec'

// Shared tests also compile under the Node tsconfig, which intentionally has no JSX setting.
const { MediaArtifactsPanel, MediaAssetGrid, MediaCommandFeedback, MediaCreationForm, MediaJobList } = await import(new URL('../components/workspace/MediaArtifactsPanel.tsx', import.meta.url).href)

const profile: MediaProfile = {
  profileId: 'image-profile', kind: 'image', displayName: '商品图片', configVersion: '1', operations: ['generate', 'edit'],
  executionMode: 'async-query', capabilities: { referenceImage: true, cancel: false, recoverByRequestId: true },
  allowedAspectRatios: ['1:1', '4:3'], allowedSizes: ['1024'], allowedQualities: ['high'], maxCount: 4,
}
const asset: MediaAssetView = {
  localAssetId: 'asset-1', taskId: 'task-1', jobId: 'job-1', outputId: 'output-1', source: 'output',
  mime: 'image/png', size: 2048, width: 1024, height: 1024, status: 'SAVED',
}
function job(patch: Partial<MediaJobView> = {}): MediaJobView {
  return { jobId: 'job-1', taskId: 'task-1', runId: 'run-1', profileId: profile.profileId, operation: 'generate',
    parameters: { aspectRatio: '1:1', count: 2 }, generationStatus: 'RUNNING', trackingStatus: 'ACTIVE', saveStatus: 'PENDING',
    billingStatus: 'pending', error: null, createdAt: 1, updatedAt: 1, assets: [], canCancelUpstream: false, ...patch }
}
const noop = () => {}

test('model selection honors the default after loading or removal while preserving valid explicit choices', () => {
  const alternate = { ...profile, profileId: 'preferred' }
  assert.equal(selectMediaProfile([profile, alternate], '', 'preferred'), alternate)
  assert.equal(selectMediaProfile([profile, alternate], profile.profileId, 'preferred'), profile)
  assert.equal(selectMediaProfile([profile, alternate], 'removed', 'preferred'), alternate)
  assert.equal(selectMediaProfile([profile], 'removed', 'missing'), profile)
  assert.equal(selectMediaProfile([], 'removed', 'preferred'), undefined)
})

const pixelProfile = {
  ...profile, allowedAspectRatios: ['1:1', '3:2', '2:3'], allowedSizes: ['1024x1024', '1536x1024', '1024x1536'],
  allowedQualities: ['low', 'medium', 'high'], defaultSize: '1536x1024', defaultQuality: 'high',
}

test('image defaults come from advertised capabilities rather than list order or an invented quality', () => {
  assert.deepEqual(imageFormParameters(pixelProfile), { aspectRatio: '3:2', size: '1536x1024', quality: 'high', count: 1 })
  assert.equal(imageFormParameters({ ...pixelProfile, defaultQuality: 'unknown' })?.quality, 'low')
  const noQuality = imageFormParameters({ ...pixelProfile, allowedQualities: undefined })
  assert.ok(noQuality)
  assert.equal(Object.hasOwn(noQuality, 'quality'), false)
  assert.deepEqual(imageFormParameters({ ...profile, allowedSizes: undefined, allowedQualities: undefined }), { aspectRatio: '1:1', count: 1 })
})

test('image size and aspect ratio changes map in both directions and preserve valid quality/count', () => {
  const initial = imageFormParameters(pixelProfile)!
  const portrait = imageFormParameters(pixelProfile, { ...initial, aspectRatio: '2:3', count: 3 }, 'aspectRatio')!
  assert.deepEqual(portrait, { aspectRatio: '2:3', size: '1024x1536', count: 3, quality: 'high' })
  assert.deepEqual(imageFormParameters(pixelProfile, { ...portrait, size: '1024x1024' }), { aspectRatio: '1:1', size: '1024x1024', count: 3, quality: 'high' })
  assert.equal(imageFormParameters(pixelProfile, { aspectRatio: '1:1' })?.size, '1024x1024')
  assert.equal(imageAspectRatio('1536x1024'), '3:2')
  assert.equal(imageAspectRatio('0x10'), undefined)
  assert.equal(imageAspectRatio('1024'), undefined)
})

test('image choices are revalidated when a model or capability loses previous specs', () => {
  const changed = { ...pixelProfile, allowedAspectRatios: ['1:1'], allowedSizes: ['1024x1024'], allowedQualities: ['medium'], maxCount: 1 }
  assert.deepEqual(imageFormParameters(changed, { aspectRatio: '2:3', size: '1024x1536', count: 4, quality: 'high' }), { aspectRatio: '1:1', size: '1024x1024', count: 1, quality: 'medium' })
  assert.equal(imageFormParameters(pixelProfile, { count: NaN })?.count, 1)
  assert.equal(imageFormParameters(pixelProfile, { count: -4 })?.count, 1)
  assert.equal(imageFormParameters(pixelProfile, { count: 2.8 })?.count, 2)
  assert.equal(imageFormParameters({ ...pixelProfile, allowedAspectRatios: ['16:9'] }), null)
  assert.deepEqual(imageFormSizes({ ...pixelProfile, allowedSizes: ['1024x1024', '1920x1080'] }), ['1024x1024'])
  assert.deepEqual(imageFormAspectRatios({ ...pixelProfile, allowedSizes: ['1536x1024'] }), ['3:2'])
})

test('image SSR selects the server default model and its quality, and marks single-value specs fixed', () => {
  const preferred = { ...pixelProfile, profileId: 'preferred', allowedQualities: ['high'], maxCount: 1 }
  const html = render(React.createElement(MediaCreationForm, { profiles: [profile, preferred], defaultProfileId: preferred.profileId,
    references: [], archived: false, busy: false, taskId: 'task-1', onImport: noop, onGenerate: noop, onPreview: noop }))
  assert.match(html, /value="preferred" selected=""/)
  assert.match(html, /aria-label="图片质量"[^>]*disabled=""[^>]*><option selected="">high/)
  assert.match(html, /数量（固定）<input[^>]*readOnly=""/i)
  assert.match(html, /<option selected="">1536x1024/)
  assert.doesNotMatch(html, /<option value="">默认/)
})
function render(element: React.ReactElement): string {
  const previous = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try { return renderToStaticMarkup(element) }
  finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previous })
  }
}
function jobs(value: MediaJobView, archived = false, busy = false): string {
  return render(React.createElement(MediaJobList, { jobs: [value], archived, busy, onAction: noop }))
}

test('generation, tracking and save states remain distinct and exhaustive', () => {
  assert.equal(Object.keys(mediaGenerationLabels).length, 9)
  assert.equal(Object.keys(mediaTrackingLabels).length, 4)
  assert.equal(Object.keys(mediaSaveLabels).length, 5)
  assert.equal(new Set([...Object.values(mediaGenerationLabels), ...Object.values(mediaTrackingLabels), ...Object.values(mediaSaveLabels)].map(value => value.label)).size, 18)
  const html = jobs(job({ generationStatus: 'SUCCEEDED', trackingStatus: 'AUTH_REQUIRED', saveStatus: 'SAVE_FAILED' }))
  assert.match(html, /生成完成/)
  assert.match(html, /需要恢复认证/)
  assert.match(html, /本地保存失败/)
  assert.match(html, /重新保存/)
  assert.match(html, /恢复跟踪/)
})

test('unsupported editing never falls back to text-to-image generation', () => {
  assert.equal(mediaInputProblem({ ...profile, operations: ['generate'] }, 'edit', 1, '产品图'), '当前配置不支持图片编辑')
  assert.equal(mediaInputProblem({ ...profile, capabilities: { ...profile.capabilities, referenceImage: false } }, 'edit', 1, '产品图'), '当前配置不支持参考图编辑')
  assert.equal(mediaInputProblem(profile, 'edit', 0, '产品图'), '请先选择编辑所需的参考图')
  assert.equal(mediaInputProblem(profile, 'edit', 1, '产品图'), null)
  assert.equal(mediaInputProblem(profile, 'generate', 0, '   '), '请填写创作需求')
  assert.equal(mediaInputProblem(undefined, 'generate', 0, '产品图'), '图片能力尚未配置')
  assert.equal(mediaInputProblem({ ...profile, allowedAspectRatios: [] }, 'generate', 0, '产品图'), '当前配置没有可用的图片规格')
  assert.equal(mediaInputProblem({ ...profile, capabilities: { ...profile.capabilities, referenceImage: false } }, 'generate', 1, '产品图'), '当前配置不支持参考图，请取消选择或切换配置')
})

test('local stop is always distinguished from capability-gated upstream cancellation', () => {
  const running = job()
  assert.equal(mediaJobActions(running, false).stopTracking, true)
  assert.equal(mediaJobActions(running, false).cancelUpstream, false)
  const html = jobs(running)
  assert.match(html, /停止跟踪/)
  assert.doesNotMatch(html, /请求上游取消/)
  assert.match(jobs(job({ canCancelUpstream: true })), /请求上游取消/)
  assert.equal(mediaJobActions(job({ canCancelUpstream: true, generationStatus: 'SUBMISSION_UNKNOWN' }), false).cancelUpstream, false)
  const stopped = jobs(job({ trackingStatus: 'STOPPED' }))
  assert.match(stopped, /本地跟踪已停止/)
  assert.match(stopped, /上游可能继续生成和计费/)
  assert.match(stopped, /恢复跟踪/)
  assert.doesNotMatch(stopped, />停止跟踪</)
  for (const generationStatus of ['CANCELLED', 'FAILED'] as const) {
    const terminal = job({ generationStatus, trackingStatus: 'STOPPED' })
    assert.equal(mediaJobActions(terminal, false).resumeTracking, false)
    assert.doesNotMatch(jobs(terminal), /恢复跟踪/)
  }
})

test('submission uncertainty cannot offer redo; expiration cannot offer old-result recovery', () => {
  const unknown = job({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED' })
  assert.equal(mediaJobActions(unknown, false).redo, false)
  assert.match(jobs(unknown), /提交结果不明，待核实/)
  assert.doesNotMatch(jobs(unknown), /重做（可能收费）/)
  const expired = job({ generationStatus: 'RESULT_EXPIRED', saveStatus: 'SAVE_FAILED', trackingStatus: 'STOPPED' })
  assert.equal(mediaJobActions(expired, false).retrySave, false)
  assert.equal(mediaJobActions(expired, false).resumeTracking, false)
  assert.match(jobs(expired), /上游结果已过期/)
  assert.match(jobs(expired), /重做（可能收费）/)
  assert.doesNotMatch(jobs(expired), /重新保存|恢复跟踪/)
})

test('partial success and missing files offer original save recovery without automatic generation', () => {
  const partial = job({ generationStatus: 'PARTIAL_SUCCEEDED', saveStatus: 'MISSING', trackingStatus: 'STOPPED' })
  assert.match(jobs(partial), /部分生成成功/)
  assert.match(jobs(partial), /本地文件缺失/)
  assert.match(jobs(partial), /重新保存原结果，不重新生成/)
  assert.equal(mediaJobActions(partial, true).retrySave, true)
  assert.equal(mediaJobActions(partial, true).redo, false)
  assert.doesNotMatch(jobs(partial, true), /重做（可能收费）/)
  assert.match(jobs(partial, false, true), /disabled=""/)
})

test('authoritative gateway recovery flags hide unavailable tracking and expired downloads', () => {
  const unknown = job({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', canResumeTracking: false })
  assert.equal(mediaJobActions(unknown, false).resumeTracking, false)
  assert.equal(mediaJobActions(unknown, false).redo, false)
  assert.doesNotMatch(jobs(unknown), /恢复跟踪|重做（可能收费）/)
  const expired = job({ generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVE_FAILED', canRetrySave: false, canResumeTracking: false })
  assert.equal(mediaJobActions(expired, false).retrySave, false)
  assert.equal(mediaJobActions(expired, false).resumeTracking, false)
  assert.doesNotMatch(jobs(expired), /重新保存|恢复跟踪/)
})

test('SSR creation controls provide system reference selection, specs and no fee-confirmation modal', () => {
  const html = render(React.createElement(MediaCreationForm, { profiles: [profile], references: [], archived: false, busy: false,
    taskId: 'task-1', onImport: noop, onGenerate: noop, onPreview: noop }))
  for (const text of ['图片模型', '编辑参考图', '从系统选择参考图', '图片比例', '图片数量', '图片尺寸', '图片质量', '创作需求']) assert.match(html, new RegExp(text))
  assert.match(html, /max="4"/)
  assert.match(html, /disabled=""[^>]*>.*提交图片生成/)
  assert.doesNotMatch(html, /role="dialog"|确认费用|视频|type="file"/)
  const minimal = render(React.createElement(MediaCreationForm, { profiles: [{ ...profile, allowedSizes: undefined, allowedQualities: undefined }], references: [], archived: true, busy: false,
    taskId: 'task-1', onImport: noop, onGenerate: noop, onPreview: noop }))
  assert.doesNotMatch(minimal, /图片尺寸|图片质量/)
  assert.match(minimal, /任务已归档/)
})

test('SSR command failures appear once immediately beside creation submit and before long task history', () => {
  const message = '认证失败，请重新登录 <script>bad()</script>'
  const html = render(React.createElement(React.Fragment, null,
    React.createElement(MediaCreationForm, { profiles: [profile], references: [], archived: false, busy: true,
      taskId: 'task-1', onImport: noop, onGenerate: noop, onPreview: noop,
      feedback: { pending: 'generate', notice: { message, tone: 'error' } } }),
    React.createElement(MediaJobList, { jobs: Array.from({ length: 20 }, (_, index) => job({ jobId: `job-${index}` })), archived: false, busy: true, onAction: noop })))
  const feedbackId = html.match(/aria-describedby="([^"]+)"/)?.[1]
  assert.ok(feedbackId)
  assert.ok(html.includes(`提交图片生成</button><p id="${feedbackId}" class="media-notice media-tone-error" role="alert" aria-atomic="true">`))
  assert.equal(html.split('认证失败，请重新登录').length - 1, 1)
  assert.ok(html.indexOf('认证失败，请重新登录') < html.indexOf('media-jobs'))
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|正在处理图片操作/)
})

test('SSR pending feedback stays beside submit for every media command without changing controls', () => {
  for (const pending of ['generate', 'import', 'export', 'retry', 'cancel', 'resume', 'redo']) {
    const html = render(React.createElement(MediaCreationForm, { profiles: [profile], references: [], archived: false, busy: true,
      taskId: 'task-1', onImport: noop, onGenerate: noop, onPreview: noop, feedback: { pending, notice: null } }))
    assert.match(html, /提交图片生成<\/button><p[^>]*role="status" aria-atomic="true">/)
    assert.equal(html.split('正在处理图片操作').length - 1, 1)
    assert.match(html, /<textarea[^>]*disabled=""/)
    assert.match(html, /type="submit"[^>]*disabled=""[^>]*aria-describedby="[^"]+"/)
  }
  const idle = render(React.createElement(MediaCommandFeedback, { pending: null, notice: null }))
  assert.equal(idle, '')
})

test('SSR standalone feedback supports errors and export success outside the creation form', () => {
  const failure = render(React.createElement(MediaCommandFeedback, { notice: { message: '导出失败', tone: 'error' } }))
  assert.match(failure, /media-tone-error" role="alert" aria-atomic="true">导出失败/)
  const success = render(React.createElement(MediaCommandFeedback, { notice: { message: '图片已导出', tone: 'success' } }))
  assert.match(success, /media-tone-success" role="status" aria-atomic="true">图片已导出/)
  assert.doesNotMatch(success, /role="alert"/)
})

test('SSR grids allow saved results immediately but never export missing or unsaved files', () => {
  const html = render(React.createElement(MediaAssetGrid, { taskId: 'task-1', assets: [asset, { ...asset, localAssetId: 'asset-2', status: 'MISSING' }, { ...asset, localAssetId: 'asset-3', status: 'SAVING' }], onPreview: noop, onExport: noop }))
  assert.match(html, /导出成果 1/)
  assert.doesNotMatch(html, /导出成果 2|导出成果 3|(?:src|href)="(?:file:|https?:)/)
  assert.match(html, /本地文件缺失/)
  assert.match(html, /正在保存/)
  const refs = render(React.createElement(MediaAssetGrid, { taskId: 'task-1', assets: [{ ...asset, source: 'reference' }], references: true, selected: [asset.localAssetId], onSelect: noop, onPreview: noop }))
  assert.match(refs, /type="checkbox" checked=""/)
  assert.doesNotMatch(refs, /导出成果/)
})

test('saved image results remain available while billing is pending and show query timing', () => {
  const lastQueriedAt = Date.parse('2026-10-23T12:34:56Z')
  const html = jobs(job({ generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', billingStatus: 'pending', lastQueriedAt, providerWaitMs: 1250, downloadMs: 240 }))
  assert.ok(html.includes(`最近查询：${new Date(lastQueriedAt).toLocaleTimeString('zh-CN', { hour12: false })}`))
  assert.match(html, /供应商等待：1\.3 秒/)
  assert.match(html, /下载保存：240 ms/)
})

test('SSR panel is safe without browser IPC and escapes backend error text', () => {
  const html = render(React.createElement(MediaArtifactsPanel, { taskId: 'task-1' }))
  assert.match(html, /图片创作与成果/)
  assert.match(html, /正在读取图片能力/)
  const escaped = jobs(job({ error: '<script>bad()</script>' }))
  assert.match(escaped, /&lt;script&gt;/)
  assert.doesNotMatch(escaped, /<script>/)
})
