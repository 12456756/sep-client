import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MediaAssetView, MediaJobView, MediaProfile } from './media'
import { mediaGenerationLabels, mediaInputProblem, mediaJobActions, mediaSaveLabels, mediaTrackingLabels } from './media-view'

// Shared tests also compile under the Node tsconfig, which intentionally has no JSX setting.
const { MediaArtifactsPanel, MediaAssetGrid, MediaCreationForm, MediaJobList } = await import(new URL('../components/workspace/MediaArtifactsPanel.tsx', import.meta.url).href)

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
  for (const text of ['图片配置', '编辑参考图', '从系统选择参考图', '图片比例', '图片数量', '图片尺寸', '图片质量', '创作需求']) assert.match(html, new RegExp(text))
  assert.match(html, /max="4"/)
  assert.match(html, /disabled=""[^>]*>.*提交图片生成/)
  assert.doesNotMatch(html, /role="dialog"|确认费用|视频|type="file"/)
  const minimal = render(React.createElement(MediaCreationForm, { profiles: [{ ...profile, allowedSizes: undefined, allowedQualities: undefined }], references: [], archived: true, busy: false,
    taskId: 'task-1', onImport: noop, onGenerate: noop, onPreview: noop }))
  assert.doesNotMatch(minimal, /图片尺寸|图片质量/)
  assert.match(minimal, /任务已归档/)
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

test('SSR panel is safe without browser IPC and escapes backend error text', () => {
  const html = render(React.createElement(MediaArtifactsPanel, { taskId: 'task-1' }))
  assert.match(html, /图片创作与成果/)
  assert.match(html, /正在读取图片能力/)
  const escaped = jobs(job({ error: '<script>bad()</script>' }))
  assert.match(escaped, /&lt;script&gt;/)
  assert.doesNotMatch(escaped, /<script>/)
})
