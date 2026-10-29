import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MediaAssetView } from './media'
import type { VideoJobView, VideoTaskView } from './video-host'
import type { VideoOutput, VideoRuntime } from './video-media'
import { videoAllowedAudioModes } from './video-media'
import { videoFormParameters } from './media-view'

// Dynamic import keeps TSX outside the shared Node tsconfig's compilation graph.
const { VideoTaskContent, VideoTaskPanel, VideoArtifactsPanel, videoOutputIsSaved, savedVideoOutputCount, videoTaskIssue } = await import(new URL('../components/workspace/VideoArtifactsPanel.tsx', import.meta.url).href)
const { canImportVideoReference } = await import(new URL('../components/workspace/MediaArtifactsPanel.tsx', import.meta.url).href)
const { VideoCreationForm } = await import(new URL('../testing/VideoCreationForm.tsx', import.meta.url).href)

const runtime: VideoRuntime = {
  protocolVersion: 1, executionAvailable: true, defaultProfileId: 'video-profile',
  tools: ['video_from_image', 'video_generate', 'video_get_job'],
  profiles: [{
    profileId: 'video-profile', kind: 'video', displayName: 'Mock 商品视频', configVersion: 'v1',
    executionMode: 'async-query', operations: ['image-to-video', 'text-to-video'],
    capabilities: {
      supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: false,
      durationsSeconds: [5, 8], aspectRatios: ['16:9', '9:16'], resolutions: ['720p'], frameRates: [24],
      maxInputBytes: 2048, maxReferenceCount: 1, outputFormats: ['video/mp4'],
      supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 3600,
    },
  }],
}
const output: VideoOutput = {
  outputId: 'output-1', kind: 'video', mimeType: 'video/mp4', byteLength: 1024, sha256: 'a'.repeat(64),
  durationSeconds: 5, width: 1280, height: 720, frameRate: 24, thumbnailOutputId: null, expiresAt: null,
}
const reference: MediaAssetView = {
  localAssetId: 'reference-1', taskId: 'task-1', jobId: null, outputId: null, source: 'reference',
  mime: 'image/png', size: 1024, width: 512, height: 512, status: 'SAVED',
}
function job(patch: Partial<VideoJobView> = {}): VideoJobView {
  return {
    jobId: 'job-1', taskId: 'task-1', profileId: 'video-profile', operation: 'image-to-video',
    parameters: { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' },
    generationStatus: 'RUNNING', trackingStatus: 'ACTIVE', saveStatus: 'PENDING',
    billingStatus: 'MOCK_NOT_CHARGED', createdAt: 1, updatedAt: 1, error: null, outputs: [], ...patch,
  }
}
const { FeedbackProvider } = await import(new URL('../components/feedback/FeedbackProvider.tsx', import.meta.url).href)
const noop = () => {}
function render(element: React.ReactElement): string {
  const previous = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try { return renderToStaticMarkup(React.createElement(FeedbackProvider, null, element)) }
  finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previous })
  }
}
type Overrides = {
  view?: VideoTaskView | null; references?: MediaAssetView[]; busy?: boolean; pending?: string | null
  notice?: { message: string; tone: 'error' | 'success' } | null; error?: string | null
}
function panel(patch: Overrides = {}): string {
  return render(React.createElement(VideoTaskContent, {
    taskId: 'task-1', view: { mock: true, runtime, jobs: [] }, busy: false, pending: null, notice: null, error: null,
    onRefresh: noop, onAction: noop, onPreview: noop, onExport: noop, ...patch,
  }))
}
function form(patch: Overrides = {}): string {
  return render(React.createElement(VideoCreationForm, { taskId: 'task-1', runtime: patch.view?.runtime ?? runtime,
    references: patch.references ?? [], busy: patch.busy ?? false, onImport: noop, onGenerate: noop }))
}

test('video results panel has no duplicate creation form or technical configuration', () => {
  const html = panel()
  assert.match(html, /视频成果/)
  assert.doesNotMatch(html, /<form|<select|<textarea|视频模型|视频时长|提交视频生成|从系统选择视频参考图/)
})

test('real terminal billing stays visible and resumable while preserving measured output metadata', () => {
  const actual = { ...output, width: 1344, height: 768, durationSeconds: 4.458333, frameRate: 24 }
  const view: VideoTaskView = { mock: false, runtime: { ...runtime, executionMode: 'real' }, jobs: [job({
    generationStatus: 'SUCCEEDED', trackingStatus: 'INTERRUPTED', saveStatus: 'SAVED', outputs: [actual],
    billingStatus: 'RECONCILING', amountCny: '0.900000',
  })] }
  const html = panel({ view })
  assert.match(html, /账务核对中/); assert.match(html, /0\.900000/); assert.match(html, /恢复跟踪/)
  assert.match(html, /1344 × 768/); assert.match(html, /4\.458333 秒/)
  assert.doesNotMatch(html, /Mock · 不收费|MOCK_NOT_CHARGED/)
  for (const generationStatus of ['FAILED', 'CANCELLED', 'RESULT_EXPIRED']) {
    assert.match(panel({ view: { ...view, jobs: [job({ generationStatus, trackingStatus: 'AUTH_REQUIRED', billingStatus: 'RESERVED' })] } }), /恢复跟踪/)
  }
  assert.doesNotMatch(panel({ view: { ...view, jobs: [{ ...view.jobs[0], billingStatus: 'SETTLED', trackingStatus: 'STOPPED' }] } }), /恢复跟踪/)
})
function jobs(value: VideoJobView): string { return panel({ view: { mock: true, runtime, jobs: [value] } }) }
function options(html: string, label: string): string[] {
  const select = html.match(new RegExp(`<select aria-label="${label}"[^>]*>(.*?)</select>`))
  assert.ok(select, label)
  return Array.from(select[1].matchAll(/<option(?: value="([^"]*)")?[^>]*>(.*?)<\/option>/g), match => match[1] || match[2])
}

test('video defaults and choices are validated independently against the current model', () => {
  const v2 = { ...runtime, protocolVersion: 2 as const }
  const configured = { ...runtime.profiles[0], capabilities: { ...runtime.profiles[0].capabilities,
    durationsSeconds: [4, 8], aspectRatios: ['16:9', '9:16'], frameRates: [24, 30],
    audioModes: [false, true], defaultAudio: false,
    defaults: { durationSeconds: 8, aspectRatio: '9:16', resolution: '720p' as const, frameRate: 30, audio: false, outputFormat: 'video/mp4' as const },
  } }
  const expected = { durationSeconds: 8, aspectRatio: '9:16', resolution: '720p', frameRate: 30, audio: false, outputFormat: 'video/mp4' }
  assert.deepEqual(videoFormParameters(v2, configured), expected)
  assert.deepEqual(videoFormParameters(v2, configured, { durationSeconds: 99, aspectRatio: '4:3', resolution: '4k', frameRate: 120, audio: false, outputFormat: 'video/webm' }), expected)
  assert.equal(videoFormParameters(v2, configured, { audio: true })?.audio, true)
  const fixed = { ...configured, capabilities: { ...configured.capabilities, audioModes: [true], durationsSeconds: [4] } }
  assert.deepEqual(videoFormParameters(v2, fixed, { durationSeconds: 8, audio: false }), { ...expected, durationSeconds: 4, audio: true })
  assert.equal(videoFormParameters(v2, { ...fixed, capabilities: { ...fixed.capabilities, audioModes: [] } }), null)
})

test('legacy real H3 audio stays fixed true while mock respects supportsAudio', () => {
  const caps = runtime.profiles[0].capabilities
  assert.deepEqual(videoAllowedAudioModes({ ...runtime, executionMode: 'real' }, { capabilities: caps }), [true])
  assert.deepEqual(videoAllowedAudioModes(runtime, { capabilities: caps }), [false])
  assert.deepEqual(videoAllowedAudioModes(runtime, { capabilities: { ...caps, supportsAudio: true } }), [false, true])
  const silent = { capabilities: { ...caps, audioModes: [false], defaultAudio: false } }
  assert.deepEqual(videoAllowedAudioModes({ ...runtime, protocolVersion: 2, executionMode: 'real' }, silent), [false])
  assert.equal(videoFormParameters({ ...runtime, executionMode: 'real' }, runtime.profiles[0], { audio: false })?.audio, true)
  const html = form({ view: { mock: false, runtime: { ...runtime, executionMode: 'real' }, jobs: [] } })
  assert.deepEqual(options(html, '视频音频'), ['true'])
  assert.match(html, /音频（固定）<select aria-label="视频音频"[^>]*disabled=""/)
  for (const label of ['视频分辨率', '视频帧率', '视频输出格式']) assert.match(html, new RegExp(`aria-label="${label}"[^>]*disabled=""`))
})

test('video panel stays hidden for a disabled host and SSR never reads IPC', () => {
  assert.equal(panel({ view: null }), '')
  assert.equal(VideoArtifactsPanel, VideoTaskPanel)
  assert.equal(render(React.createElement(VideoTaskPanel, { taskId: 'task-1' })), '')
  assert.match(panel(), /视频成果/)
  assert.match(panel(), /Mock · 不收费/)
  assert.match(panel(), /MOCK_NOT_CHARGED/)
})

test('video reference import is available only for an authorized image-to-video profile', () => {
  assert.equal(canImportVideoReference(runtime), true)
  assert.equal(canImportVideoReference({ ...runtime, executionAvailable: false }), false)
  assert.equal(canImportVideoReference({ ...runtime, tools: ['video_generate', 'video_get_job'] }), false)
  assert.equal(canImportVideoReference({ ...runtime, profiles: [{ ...runtime.profiles[0], capabilities: { ...runtime.profiles[0].capabilities, supportsImageToVideo: false } }] }), false)
})

test('null host views cannot retain stale controls, jobs or command notices', () => {
  assert.equal(panel({ view: null, references: [reference], pending: 'generate', busy: true,
    notice: { message: '旧任务信息', tone: 'error' }, error: '读取失败' }), '')
})

test('unavailable runtimes retain saved results while disabling creation', () => {
  const unavailable: VideoRuntime = { protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles: [] }
  const html = panel({ view: { mock: true, runtime: unavailable, jobs: [job({ generationStatus: 'SUCCEEDED', saveStatus: 'SAVED', outputs: [output] })] } })
  assert.doesNotMatch(html, /<form|<select|<textarea|type="submit"/)
  assert.match(html, /预览视频成果 1/)
  assert.match(html, /导出视频成果 1/)
  assert.doesNotMatch(html, /从系统选择视频参考图|type="radio"/)
})

test('creation controls use exactly the runtime profile values, with no invented parameters', () => {
  const html = form({ references: [reference] })
  assert.deepEqual(options(html, '视频时长'), ['5', '8'])
  assert.deepEqual(options(html, '视频比例'), ['16:9', '9:16'])
  assert.deepEqual(options(html, '视频分辨率'), ['720p'])
  assert.deepEqual(options(html, '视频帧率'), ['24'])
  assert.deepEqual(options(html, '视频输出格式'), ['video/mp4'])
  assert.deepEqual(options(html, '视频音频'), ['false'])
  assert.match(html, /aria-label="视频音频"[^>]*disabled=""/)
  assert.match(html, /maxLength="4000"/i)
  assert.match(html, /从系统选择视频参考图/)
  assert.match(html, /type="submit"[^>]*disabled=""/)
  assert.doesNotMatch(html, /type="file"|type="url"|确认费用|图片数量|seed|1080p|4k|video\/webm/)
})

test('default profile and enabled operations drive the form, including audio and WebM', () => {
  const textProfile: VideoRuntime['profiles'][number] = {
    ...runtime.profiles[0], profileId: 'text-profile', displayName: '文字视频', operations: ['text-to-video'],
    capabilities: { ...runtime.profiles[0].capabilities, supportsImageToVideo: false, supportsAudio: true,
      durationsSeconds: [12], aspectRatios: ['4:3'], resolutions: ['1080p'], frameRates: [30], outputFormats: ['video/webm'] },
  }
  const html = form({ view: { mock: true, runtime: { ...runtime, defaultProfileId: textProfile.profileId, profiles: [...runtime.profiles, textProfile] }, jobs: [] } })
  assert.match(html, /value="text-profile" selected=""/)
  assert.deepEqual(options(html, '视频时长'), ['12'])
  assert.deepEqual(options(html, '视频比例'), ['4:3'])
  assert.deepEqual(options(html, '视频分辨率'), ['1080p'])
  assert.deepEqual(options(html, '视频帧率'), ['30'])
  assert.deepEqual(options(html, '视频输出格式'), ['video/webm'])
  assert.deepEqual(options(html, '视频音频'), ['false', 'true'])
  assert.doesNotMatch(html, /图片生成视频|type="radio"|从系统选择视频参考图/)
})

test('tool grants restrict otherwise supported operations and read-only runtimes disable generation', () => {
  const limited = form({ view: { mock: true, runtime: { ...runtime, tools: ['video_generate', 'video_get_job'] }, jobs: [] } })
  assert.match(limited, /文字生成视频/)
  assert.doesNotMatch(limited, /图片生成视频|type="radio"|从系统选择视频参考图/)
  const disabled = panel({ view: { mock: true, runtime: { ...runtime, executionAvailable: false, tools: [] }, jobs: [job()] } })
  assert.doesNotMatch(disabled, /<form|<select|<textarea/)
  assert.match(disabled, /正在生成/)
})

test('reference selection is a single native radio group, scoped to this task and local references', () => {
  const html = form({ references: [reference, { ...reference, localAssetId: 'reference-2' },
    { ...reference, localAssetId: 'wrong-task', taskId: 'task-2' }, { ...reference, localAssetId: 'an-output', source: 'output' }, reference] })
  const radios = Array.from(html.matchAll(/<input type="radio" name="([^"]+)"/g))
  assert.equal(radios.length, 2)
  assert.equal(new Set(radios.map(match => match[1])).size, 1)
  assert.match(html, /aria-label="视频参考图 1"/)
  assert.doesNotMatch(html, /checkbox|<img|<video|(?:src|href)=/)
  const unavailable = form({ references: [{ ...reference, status: 'MISSING' }, { ...reference, localAssetId: 'too-large', size: 4096 }] })
  assert.equal(Array.from(unavailable.matchAll(/<input type="radio"[^>]*disabled=""/g)).length, 2)
  assert.match(unavailable, /本地文件缺失/)
  assert.match(unavailable, /超出当前配置大小限制/)
})

test('generation, tracking and local save status are independently visible', () => {
  const html = jobs(job({ generationStatus: 'SUCCEEDED', trackingStatus: 'AUTH_REQUIRED', saveStatus: 'SAVE_FAILED', outputs: [output] }))
  for (const text of ['生成完成', '需要恢复认证', '本地保存失败', '恢复跟踪', '重新保存', '重新保存原结果，不重新生成']) assert.ok(html.includes(text), text)
  assert.doesNotMatch(html, /预览视频成果|导出视频成果|重做|重新生成视频/)
})

test('uncertain submission offers original tracking recovery and never a replacement action', () => {
  const html = jobs(job({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED' }))
  assert.match(html, /提交结果不明，待核实/)
  assert.match(html, /恢复跟踪/)
  assert.match(html, /不会自动重新生成/)
  assert.doesNotMatch(html, /重新保存|重做|预览视频成果|导出视频成果/)
  const auth = jobs(job({ trackingStatus: 'AUTH_REQUIRED' }))
  assert.match(auth, /认证恢复后，请手动恢复跟踪/)
})

test('definitive business rejection shows its cause without recovery or regeneration actions', () => {
  const html = panel({ view: { mock: false, runtime: { ...runtime, executionMode: 'real' },
    jobs: [job({ generationStatus: 'FAILED', trackingStatus: 'STOPPED',
      billingStatus: 'NOT_RESERVED', error: 'VIDEO_BUDGET_EXCEEDED' })] } })
  assert.doesNotMatch(html, /role="alert"/)
  assert.equal(videoTaskIssue([job({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', error: 'VIDEO_BUDGET_EXCEEDED' })]), '已超过企业视频预算，请联系平台管理员')
  assert.match(html, /提交被拒绝/)
  assert.match(html, /尚未预占/)
  assert.doesNotMatch(html, /生成失败|恢复跟踪|重新保存|重新生成|提交结果不明|Video job reported/)
})

function realJobs(patch: Partial<VideoJobView>): string {
  return panel({ view: { mock: false, runtime: { ...runtime, executionMode: 'real' }, jobs: [job({
    billingStatus: 'NOT_RESERVED', ...patch,
  })] } })
}

test('only stopped failed jobs with a controlled rejection code show submission rejected', () => {
  for (const error of ['INSUFFICIENT_FUNDS', 'VIDEO_BUDGET_EXCEEDED', 'QUOTE_EXPIRED', 'VIDEO_CONCURRENCY_LIMIT']) {
    const html = realJobs({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', error })
    assert.match(html, /提交被拒绝/)
    assert.doesNotMatch(html, /生成失败|恢复跟踪|重新生成/)
    for (const patch of [
      { generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'STOPPED' as const },
      { generationStatus: 'FAILED', trackingStatus: 'INTERRUPTED' as const },
    ]) assert.doesNotMatch(realJobs({ ...patch, error }), /提交被拒绝/)
  }
  assert.match(realJobs({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', error: 'UNKNOWN_ERROR' }), /生成失败/)
})

test('unknown and legacy submissions never claim generation failure or uncharged funds', () => {
  for (const billingStatus of ['NOT_RESERVED', 'RECONCILING'] as const) {
    for (const error of [null, 'SUBMISSION_UNKNOWN', 'UNKNOWN_ERROR', '生成失败，未扣费', 'VIDEO_BUDGET_EXCEEDED']) {
      const html = realJobs({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', billingStatus,
        actualCostCny: '28.800000', amountCny: '28.800000', error })
      assert.match(html, /提交结果不明/)
      assert.match(html, /账务待确认/)
      assert.match(html, /报价 ¥28\.800000/)
      assert.match(html, /恢复跟踪/)
      assert.doesNotMatch(html, /生成失败|未扣费|不收费|尚未预占|实付|已结算|提交被拒绝|任务未能完成/)
    }
  }
})

test('actual payment requires settled billing and a valid nonnegative decimal amount including zero', () => {
  for (const actualCostCny of ['28.800000', '0.000000', '0', '0.00']) {
    const html = realJobs({ billingStatus: 'SETTLED', actualCostCny, amountCny: '30.000000' })
    assert.ok(html.includes(`实付 ¥${actualCostCny}`))
    assert.match(html, /已结算/)
    assert.doesNotMatch(html, /报价 ¥30/)
  }
  for (const actualCostCny of [undefined, '', ' ', '-1.000000', '-0.000000', 'NaN', 'Infinity', '1e2', '0x10', '1.0000001', '1,000.00', '<script>', '9'.repeat(400)]) {
    const html = realJobs({ billingStatus: 'SETTLED', actualCostCny, amountCny: '28.800000' })
    assert.match(html, /结算金额待核对/)
    assert.match(html, /报价 ¥28\.800000/)
    assert.doesNotMatch(html, /实付|已结算|尚无视频任务/)
  }
})

test('unsettled billing displays quote and reservation facts, never actual payment', () => {
  const labels = { NOT_RESERVED: '尚未预占', RESERVED: '费用已预占', RELEASED: '预占已释放', RECONCILING: '账务核对中' } as const
  for (const billingStatus of Object.keys(labels) as (keyof typeof labels)[]) {
    const html = realJobs({ billingStatus, actualCostCny: '24.000000', amountCny: '28.800000' })
    assert.ok(html.includes(labels[billingStatus]))
    assert.match(html, /报价 ¥28\.800000/)
    assert.doesNotMatch(html, /实付|已结算|24\.000000/)
  }
  for (const amountCny of ['', '-1.000000', 'NaN', 'Infinity', '1e2', '<script>']) {
    const html = realJobs({ billingStatus: 'RECONCILING', amountCny })
    assert.match(html, /账务核对中/)
    assert.doesNotMatch(html, /报价|实付|尚无视频任务/)
  }
  assert.match(jobs(job({ actualCostCny: '28.800000' })), /Mock · 不收费/)
  assert.doesNotMatch(jobs(job({ actualCostCny: '28.800000' })), /实付|28\.800000/)
})

test('uncertain real submission retains the cause and displays pending billing with original recovery', () => {
  const html = panel({ view: { mock: false, runtime: { ...runtime, executionMode: 'real' },
    jobs: [job({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED',
      billingStatus: 'RECONCILING', error: 'MEDIA_FORBIDDEN' })] } })
  assert.doesNotMatch(html, /当前账号没有视频生成权限/)
  assert.match(html, /账务待确认/)
  assert.match(html, /恢复跟踪/)
  assert.doesNotMatch(html, /尚未预占|未产生扣费|重新保存/)
})

test('terminal, not-submitted and unknown generation states do not offer invalid recovery', () => {
  for (const generationStatus of ['FAILED', 'CANCELLED', 'RESULT_EXPIRED', 'NOT_SUBMITTED', 'future-status', '__proto__']) {
    const html = jobs(job({ generationStatus, trackingStatus: 'STOPPED', saveStatus: 'SAVE_FAILED', outputs: [output] }))
    assert.doesNotMatch(html, />恢复跟踪<|>重新保存<|预览视频成果|导出视频成果/)
    if (generationStatus === 'NOT_SUBMITTED') assert.match(html, /尚未提交/)
    if (['future-status', '__proto__'].includes(generationStatus)) assert.match(html, /未知生成状态/)
  }
})

test('saved videos expose local preview and native export actions without eager media loading', () => {
  const html = jobs(job({ generationStatus: 'SUCCEEDED', saveStatus: 'SAVED', trackingStatus: 'STOPPED', outputs: [output] }))
  assert.match(html, /预览视频成果 1/)
  assert.match(html, /导出视频成果 1/)
  assert.doesNotMatch(html, /<video|<source|<iframe|<img|(?:src|href|poster)=|恢复跟踪|重新保存/)
  for (const saveStatus of ['PENDING', 'SAVING', 'SAVE_FAILED', 'MISSING'] as const) {
    const unavailable = jobs(job({ generationStatus: 'PARTIAL_SUCCEEDED', saveStatus, outputs: [output] }))
    assert.doesNotMatch(unavailable, /预览视频成果|导出视频成果/)
    assert.match(unavailable, /保存后可预览或导出/)
  }
})

test('video summaries preserve saved outputs while reporting generation or tracking failures', () => {
  const failed = job({ generationStatus: 'FAILED', trackingStatus: 'AUTH_REQUIRED', saveStatus: 'SAVE_FAILED', outputs: [output], error: 'MEDIA_FORBIDDEN' })
  assert.equal(savedVideoOutputCount([failed]), 0)
  assert.equal(videoTaskIssue([failed]), '当前账号没有视频生成权限，请联系平台管理员')
  const partial = job({ generationStatus: 'FAILED', saveStatus: 'SAVE_FAILED', outputs: [output], savedOutputIds: ['output-1'], error: 'unknown-error' })
  assert.equal(savedVideoOutputCount([partial]), 1)
  assert.equal(videoTaskIssue([partial]), '视频成果保存失败，请联系平台管理员')
  assert.equal(savedVideoOutputCount(null), null)
  assert.equal(savedVideoOutputCount([partial], true), null)
})

test('saved videos remain available while billing is reconciling and show query timing', () => {
  const lastQueriedAt = Date.parse('2026-10-23T12:34:56Z')
  const html = panel({ view: { mock: false, runtime: { ...runtime, executionMode: 'real' }, jobs: [job({ generationStatus: 'SUCCEEDED', saveStatus: 'SAVED', trackingStatus: 'STOPPED', billingStatus: 'RECONCILING', outputs: [output], lastQueriedAt, providerWaitMs: 2100, downloadMs: 320 })] } })
  assert.match(html, /预览视频成果 1/)
  assert.match(html, /导出视频成果 1/)
  assert.ok(html.includes(`最近查询：${new Date(lastQueriedAt).toLocaleTimeString('zh-CN', { hour12: false })}`))
  assert.match(html, /供应商等待：2\.1 秒/)
  assert.match(html, /下载保存：320 ms/)
})

test('partial local saves allow only verified saved outputs to preview and export', () => {
  const partial = { ...job({ generationStatus: 'PARTIAL_SUCCEEDED', saveStatus: 'SAVE_FAILED', trackingStatus: 'STOPPED',
    outputs: [output, { ...output, outputId: 'output-2' }] }), savedOutputIds: ['output-1'] }
  const html = jobs(partial)
  assert.match(html, /部分生成成功/)
  assert.match(html, /本地保存失败/)
  assert.match(html, /预览视频成果 1/)
  assert.match(html, /导出视频成果 1/)
  assert.doesNotMatch(html, /预览视频成果 2|导出视频成果 2/)
  assert.match(html, /重新保存/)
  assert.doesNotMatch(html, /<video|<source|(?:src|href)=/)
})

test('explicit saved-output IDs override aggregate SAVED including an empty list', () => {
  const saved = job({ generationStatus: 'SUCCEEDED', saveStatus: 'SAVED', outputs: [output, { ...output, outputId: 'output-2' }] })
  const partial = jobs({ ...saved, savedOutputIds: ['output-2'] } as VideoJobView)
  assert.doesNotMatch(partial, /预览视频成果 1|导出视频成果 1/)
  assert.match(partial, /预览视频成果 2/)
  assert.match(partial, /导出视频成果 2/)
  const none = jobs({ ...saved, savedOutputIds: [] } as VideoJobView)
  assert.doesNotMatch(none, /预览视频成果|导出视频成果/)
  assert.match(none, /尚未确认保存到本地/)
  const older = jobs(saved)
  for (const index of [1, 2]) {
    assert.ok(older.includes(`预览视频成果 ${index}`))
    assert.ok(older.includes(`导出视频成果 ${index}`))
  }
})

test('preview eligibility uses verified saved IDs and requires the output to belong to the job', () => {
  const partial = { ...job({ saveStatus: 'SAVE_FAILED', outputs: [output] }), savedOutputIds: ['output-1', 'another-output'] }
  assert.equal(videoOutputIsSaved(partial, 'output-1'), true)
  assert.equal(videoOutputIsSaved(partial, 'another-output'), false)
  assert.equal(videoOutputIsSaved({ ...partial, savedOutputIds: [] }, 'output-1'), false)
  assert.equal(videoOutputIsSaved({ ...partial, outputs: [] }, 'output-1'), false)
  assert.equal(videoOutputIsSaved(job({ saveStatus: 'SAVED', outputs: [output] }), 'output-1'), true)
  assert.equal(videoOutputIsSaved(job({ saveStatus: 'MISSING', outputs: [output] }), 'output-1'), false)
  const invalid = { ...partial, savedOutputIds: ['file:///private/video.mp4'] } as VideoJobView
  assert.match(jobs(invalid), /尚无视频任务/)
})

test('expired original downloads cannot offer recovery but saved local files remain usable', () => {
  const expired = { ...output, expiresAt: '2000-01-01T00:00:00.000Z' }
  const missing = jobs(job({ generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'MISSING', outputs: [expired] }))
  assert.doesNotMatch(missing, />重新保存<|>恢复跟踪</)
  const saved = jobs(job({ generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', outputs: [expired] }))
  assert.match(saved, /预览视频成果 1/)
  assert.match(saved, /导出视频成果 1/)
})

test('saved unexpired outputs cannot authorize retry of an expired missing output', () => {
  const partial = { ...job({ generationStatus: 'PARTIAL_SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVE_FAILED',
    outputs: [{ ...output, expiresAt: '2000-01-01T00:00:00.000Z' }, { ...output, outputId: 'output-2', expiresAt: null }],
  }), savedOutputIds: ['output-2'] }
  const html = jobs(partial)
  assert.doesNotMatch(html, />恢复跟踪<|>重新保存</)
  assert.match(html, /预览视频成果 2|导出视频成果 2/)
  assert.doesNotMatch(html, /预览视频成果 1|导出视频成果 1/)
  const expiredSaved = jobs({ ...partial, outputs: partial.outputs.map(item => ({ ...item, expiresAt: '2000-01-01T00:00:00.000Z' })) })
  assert.match(expiredSaved, /预览视频成果 2|导出视频成果 2/)
})

test('authoritative canDownload false suppresses retry without hiding already saved local outputs', () => {
  const saved = { ...job({ generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', outputs: [output] }), canDownload: false } as VideoJobView & { canDownload: boolean }
  const html = jobs(saved)
  assert.match(html, /预览视频成果 1|导出视频成果 1/)
  assert.doesNotMatch(html, /重新保存|恢复跟踪/)
})

test('unsafe cross-task identifiers, output URLs, invalid MIME and real-charge payloads are rejected', () => {
  const unsafe = [
    job({ taskId: 'another-task' }), job({ jobId: '../../secret' }), job({ jobId: 'https://example.test/video' }),
    job({ outputs: [{ ...output, mimeType: 'text/html' } as unknown as VideoOutput] }),
    job({ outputs: [{ ...output, url: 'https://example.test/video' } as VideoOutput] }),
    { ...job(), billingStatus: 'charged' } as unknown as VideoJobView,
  ]
  const html = panel({ view: { mock: true, runtime, jobs: unsafe }, references: [
    { ...reference, localAssetId: 'file:///secret' }, { ...reference, mime: 'image/svg+xml' } as unknown as MediaAssetView,
  ] })
  assert.match(html, /尚无视频任务/)
  assert.doesNotMatch(html, /视频任务 job|type="radio"|example\.test|file:|\.\.\/|charged/)
  assert.equal(panel({ view: { mock: false, runtime, jobs: [] } as unknown as VideoTaskView }), '')
  assert.equal(panel({ view: { mock: true, runtime: { ...runtime, profiles: [{ ...runtime.profiles[0], profileId: 'file:///secret' }] }, jobs: [] } }), '')
})

test('unknown video errors use fixed copy and feedback stays above results without revealing configuration text', () => {
  const attack = '<script>alert("unsafe")</script>'
  const html = panel({ view: { mock: true, runtime: { ...runtime, profiles: [{ ...runtime.profiles[0], displayName: attack }] }, jobs: [job({ error: attack })] },
    busy: true, pending: 'export', notice: { message: attack, tone: 'error' } })
  assert.doesNotMatch(html, /<script>|dangerouslySetInnerHTML|(?:src|href)=/)
  assert.equal(html.split('&lt;script&gt;').length - 1, 0)
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /<form|<select|<textarea/)
  assert.match(videoTaskIssue([job({ error: attack })])!, /请联系平台管理员/)
})

test('pending commands and export feedback are visible and disable all mutations', () => {
  for (const pending of ['export', 'resume', 'retry']) {
    const html = panel({ busy: true, pending, references: [reference], view: { mock: true, runtime, jobs: [job({ generationStatus: 'SUCCEEDED', trackingStatus: 'INTERRUPTED', saveStatus: 'MISSING', outputs: [output] })] } })
    assert.match(html, /role="status" aria-atomic="true"/)
    assert.equal(html.split('正在处理视频操作').length - 1, 1)
    assert.doesNotMatch(html, /<fieldset|<textarea|<select/)
    assert.doesNotMatch(html, /<button(?![^>]*disabled="")[^>]*>/)
  }
  assert.doesNotMatch(panel({ notice: { message: '视频已导出', tone: 'success' } }), /视频已导出/)
})

test('persisted submit diagnostics explain unsupported specifications without hiding uncertainty', () => {
  const pending = job({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', billingStatus: 'RECONCILING',
    error: 'UPSTREAM_SPEC_UNSUPPORTED', specFailure: { code: 'UPSTREAM_SPEC_UNSUPPORTED', source: 'provider', field: 'resolution', requestedValue: '8k',
      alternatives: [{ resolution: '1080p' }], submissionState: 'not_submitted', billingState: 'not_reserved' } })
  const issue = videoTaskIssue([pending])
  assert.match(issue, /8k/); assert.match(issue, /1080p/); assert.match(issue, /上游模型/)
  const html = render(React.createElement(VideoTaskContent, { taskId: 'task-1', view: { mock: false, runtime: { ...runtime, executionMode: 'real' }, jobs: [pending] }, busy: false, pending: null, onAction: noop, onPreview: noop, onExport: noop }))
  assert.match(html, /8k/); assert.match(html, /1080p/); assert.match(html, /提交结果不明/)
})
