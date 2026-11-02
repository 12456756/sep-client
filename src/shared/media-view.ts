import type { MediaGenerationInput, MediaGenerationStatus, MediaJobView, MediaOperation, MediaProfile, MediaSaveStatus, MediaTrackingStatus } from './media'
import { imageAspectRatio } from './media-spec'
import { videoAllowedAudioModes, videoParametersSchema } from './video-media'
import type { VideoParameters, VideoRuntime } from './video-media'
import type { VideoRequestedSpec } from './media-spec-contract'

/** Preserve an explicit available choice; otherwise use the server default before list order. */
export function selectMediaProfile<T extends { profileId: string }>(profiles: readonly T[], selectedId?: string, defaultProfileId?: string | null): T | undefined {
  return profiles.find(profile => profile.profileId === selectedId) ?? profiles.find(profile => profile.profileId === defaultProfileId) ?? profiles[0]
}

export function imageFormAspectRatios(profile: MediaProfile): string[] {
  return [...new Set(profile.allowedAspectRatios)].filter(ratio => !profile.allowedSizes?.length || profile.allowedSizes.some(size => {
    const mapped = imageAspectRatio(size)
    // Legacy local mock profiles may advertise an opaque size rather than pixels.
    return mapped === undefined || mapped === ratio
  }))
}

export function imageFormSizes(profile: MediaProfile): string[] {
  return [...new Set(profile.allowedSizes ?? [])].filter(size => {
    const ratio = imageAspectRatio(size)
    return ratio === undefined || profile.allowedAspectRatios.includes(ratio)
  })
}

/** Normalize both controls and submitted values, including after capability changes. */
export function imageFormParameters(profile: MediaProfile, choices: Partial<MediaGenerationInput['parameters']> = {}, preferred: 'size' | 'aspectRatio' = 'size'): MediaGenerationInput['parameters'] | null {
  const ratios = imageFormAspectRatios(profile)
  const sizes = imageFormSizes(profile)
  if (!ratios.length || profile.maxCount === undefined || profile.maxCount < 1 || profile.allowedSizes?.length && !sizes.length) return null
  const chosenSize = choices.size && sizes.includes(choices.size) ? choices.size : undefined
  const defaultSize = profile.defaultSize && sizes.includes(profile.defaultSize) ? profile.defaultSize : undefined
  let size: string | undefined = chosenSize ?? defaultSize ?? sizes[0]
  const chosenRatio = choices.aspectRatio && ratios.includes(choices.aspectRatio) ? choices.aspectRatio : undefined
  let aspectRatio = chosenRatio ?? (size && imageAspectRatio(size)) ?? ratios[0]
  const mapped = size && imageAspectRatio(size)
  if (mapped && mapped !== aspectRatio) {
    if ((preferred === 'aspectRatio' || !chosenSize) && chosenRatio) size = sizes.find(value => !imageAspectRatio(value) || imageAspectRatio(value) === aspectRatio) ?? sizes[0]
    else aspectRatio = mapped
  }
  const qualities = profile.allowedQualities ?? []
  const quality = choices.quality && qualities.includes(choices.quality) ? choices.quality
    : profile.defaultQuality && qualities.includes(profile.defaultQuality) ? profile.defaultQuality : qualities[0]
  const count = Number.isFinite(choices.count) ? Math.trunc(choices.count!) : 1
  return { aspectRatio, count: Math.min(profile.maxCount, Math.max(1, count)), ...(size ? { size } : {}), ...(quality ? { quality } : {}) }
}

type VideoFormProfile = VideoRuntime['profiles'][number]
export function videoFormParameters(runtime: Pick<VideoRuntime, 'protocolVersion' | 'executionMode'>, profile: VideoFormProfile, choices: VideoRequestedSpec = {}): VideoParameters | null {
  if (runtime.protocolVersion === 3) return null
  const caps = profile.capabilities
  const audioModes = videoAllowedAudioModes(runtime, profile)
  if (![caps.durationsSeconds, caps.aspectRatios, caps.resolutions, caps.frameRates, caps.outputFormats, audioModes].every(values => values.length)) return null
  function pick<T>(values: T[], chosen: T | undefined, fallback: T | undefined): T {
    return chosen !== undefined && values.includes(chosen) ? chosen : fallback !== undefined && values.includes(fallback) ? fallback : values[0]
  }
  const result = videoParametersSchema.safeParse({
    durationSeconds: pick(caps.durationsSeconds, choices.durationSeconds, caps.defaults?.durationSeconds),
    aspectRatio: pick(caps.aspectRatios, choices.aspectRatio, caps.defaults?.aspectRatio),
    resolution: pick(caps.resolutions, choices.resolution, caps.defaults?.resolution),
    frameRate: pick(caps.frameRates, choices.frameRate, caps.defaults?.frameRate),
    audio: pick(audioModes, choices.audio, caps.defaultAudio ?? caps.defaults?.audio ?? caps.supportsAudio),
    outputFormat: pick(caps.outputFormats, choices.outputFormat, caps.defaults?.outputFormat),
  })
  return result.success ? result.data : null
}

export interface MediaStatusLabel {
  label: string
  tone: 'neutral' | 'active' | 'success' | 'warning' | 'error'
}

export const mediaGenerationLabels: Record<MediaGenerationStatus, MediaStatusLabel> = {
  SUBMITTING: { label: '正在提交受理', tone: 'active' },
  QUEUED: { label: '已受理，等待生成', tone: 'active' },
  RUNNING: { label: '正在生成', tone: 'active' },
  SUBMISSION_UNKNOWN: { label: '提交结果不明，待核实', tone: 'warning' },
  SUCCEEDED: { label: '生成完成', tone: 'success' },
  PARTIAL_SUCCEEDED: { label: '部分生成成功', tone: 'warning' },
  FAILED: { label: '生成失败', tone: 'error' },
  CANCELLED: { label: '上游已取消', tone: 'neutral' },
  RESULT_EXPIRED: { label: '上游结果已过期', tone: 'warning' },
}

export const mediaTrackingLabels: Record<MediaTrackingStatus, MediaStatusLabel> = {
  ACTIVE: { label: '本地跟踪中', tone: 'active' },
  INTERRUPTED: { label: '跟踪中断，可恢复', tone: 'warning' },
  AUTH_REQUIRED: { label: '需要恢复认证', tone: 'warning' },
  STOPPED: { label: '本地跟踪已停止', tone: 'neutral' },
}

export const mediaSaveLabels: Record<MediaSaveStatus, MediaStatusLabel> = {
  PENDING: { label: '等待保存', tone: 'neutral' },
  SAVING: { label: '正在保存', tone: 'active' },
  SAVED: { label: '已保存到本地', tone: 'success' },
  SAVE_FAILED: { label: '本地保存失败', tone: 'error' },
  MISSING: { label: '本地文件缺失', tone: 'error' },
}

export function mediaJobActions(job: MediaJobView, archived: boolean): {
  stopTracking: boolean; cancelUpstream: boolean; resumeTracking: boolean; retrySave: boolean; redo: boolean
} {
  const unfinished = ['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(job.generationStatus)
  const generated = ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)
  const recoverable = unfinished || (generated && ['PENDING', 'SAVING', 'SAVE_FAILED', 'MISSING'].includes(job.saveStatus))
  return {
    stopTracking: job.trackingStatus === 'ACTIVE' && recoverable,
    cancelUpstream: job.canCancelUpstream && ['QUEUED', 'RUNNING'].includes(job.generationStatus),
    resumeTracking: job.canResumeTracking !== false && job.trackingStatus !== 'ACTIVE' && recoverable && job.generationStatus !== 'RESULT_EXPIRED',
    retrySave: job.canRetrySave !== false && ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus) && ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus),
    // Unknown receipts must be resolved before offering a fresh charged request.
    redo: !archived && !unfinished,
  }
}

export function mediaInputProblem(profile: MediaProfile | undefined, operation: MediaOperation, referenceCount: number, brief: string, negotiated = false): string | null {
  if (!profile) return '图片能力尚未配置'
  if (!profile.operations.includes(operation)) return operation === 'edit' ? '当前配置不支持图片编辑' : '当前配置不支持图片生成'
  if (operation === 'edit' && !profile.capabilities.referenceImage) return '当前配置不支持参考图编辑'
  if (operation === 'edit' && referenceCount === 0) return '请先选择编辑所需的参考图'
  if (referenceCount > 0 && !profile.capabilities.referenceImage) return '当前配置不支持参考图，请取消选择或切换配置'
  if (!negotiated && (!profile.allowedAspectRatios.length || profile.maxCount === undefined || profile.maxCount < 1)) return '当前配置没有可用的图片规格'
  if (!brief.trim()) return '请填写创作需求'
  return null
}
