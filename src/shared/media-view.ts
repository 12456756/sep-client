import type { MediaGenerationStatus, MediaJobView, MediaOperation, MediaProfile, MediaSaveStatus, MediaTrackingStatus } from './media'

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

export function mediaInputProblem(profile: MediaProfile | undefined, operation: MediaOperation, referenceCount: number, brief: string): string | null {
  if (!profile) return '图片能力尚未配置'
  if (!profile.operations.includes(operation)) return operation === 'edit' ? '当前配置不支持图片编辑' : '当前配置不支持图片生成'
  if (operation === 'edit' && !profile.capabilities.referenceImage) return '当前配置不支持参考图编辑'
  if (operation === 'edit' && referenceCount === 0) return '请先选择编辑所需的参考图'
  if (referenceCount > 0 && !profile.capabilities.referenceImage) return '当前配置不支持参考图，请取消选择或切换配置'
  if (!profile.allowedAspectRatios.length || profile.maxCount < 1) return '当前配置没有可用的图片规格'
  if (!brief.trim()) return '请填写创作需求'
  return null
}
