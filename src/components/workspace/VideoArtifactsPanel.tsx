/// <reference types="vite/client" />
import { Download, Film, LoaderCircle, Play, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { ElectronAPI, IpcCommandResult } from '../../shared/ipc'
import { mediaGenerationLabels, mediaSaveLabels, mediaTrackingLabels } from '../../shared/media-view'
import type { VideoJobView, VideoTaskView } from '../../shared/video-host'
import { videoBillingPending, videoBillingStatusSchema, videoOperationSchema, videoOutputSchema, videoParametersSchema, videoRuntimeSchema } from '../../shared/video-media'
import { isVideoSubmissionRejectionCode, videoErrorMessage } from '../../shared/video-errors'

type Command = 'export' | 'resume' | 'retry'
type JobAction = 'resume' | 'retry'
type Notice = { message: string; tone: 'error' | 'success' }
type OutputSelection = { jobId: string; outputId: string }
const POLL_INTERVAL = 3000
const localId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

function elapsedLabel(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} 秒`
}

function queryLabel(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}
const jobSchema = z.object({
  jobId: localId, taskId: localId, profileId: localId, operation: videoOperationSchema,
  parameters: videoParametersSchema, generationStatus: z.string().max(80),
  trackingStatus: z.enum(['ACTIVE', 'INTERRUPTED', 'AUTH_REQUIRED', 'STOPPED']),
  saveStatus: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
  billingStatus: videoBillingStatusSchema, amountCny: z.string().optional(), actualCostCny: z.string().optional(), amountUsd: z.string().optional(), createdAt: z.number().finite(), updatedAt: z.number().finite(),
  lastQueriedAt: z.number().finite().optional(), providerWaitMs: z.number().finite().nonnegative().optional(), downloadMs: z.number().finite().nonnegative().optional(),
  error: z.string().nullable(), outputs: z.array(videoOutputSchema).max(4),
  savedOutputIds: z.array(localId).max(4).optional(),
})

function safeView(value: unknown, taskId: string): VideoTaskView | null {
  const result = z.object({ mock: z.boolean(), runtime: videoRuntimeSchema, jobs: z.array(z.unknown()) }).safeParse(value)
  if (!result.success) return null
  if ((result.data.runtime.executionMode ?? 'mock') !== (result.data.mock ? 'mock' : 'real')) return null
  const jobs = result.data.jobs.flatMap(value => {
    const job = jobSchema.safeParse(value)
    return job.success && job.data.taskId === taskId && (job.data.billingStatus === 'MOCK_NOT_CHARGED') === result.data.mock ? [job.data] : []
  })
  return { mock: result.data.mock, runtime: result.data.runtime, jobs }
}


function failure(result: IpcCommandResult, fallback: string): string {
  return result.error?.message || fallback
}

export function videoOutputIsSaved(job: VideoJobView & { savedOutputIds?: string[] }, outputId: string): boolean {
  return job.outputs.some(output => output.outputId === outputId) &&
    (job.savedOutputIds === undefined ? job.saveStatus === 'SAVED' : job.savedOutputIds.includes(outputId))
}

function videoJobCanDownload(job: VideoJobView): boolean {
  const recovery = job as VideoJobView & { canDownload?: boolean }
  return recovery.canDownload !== false
}

function validVideoAmount(value: string | undefined): string | undefined {
  return value !== undefined && /^\d+(?:\.\d{1,6})?$/.test(value) && Number.isFinite(Number(value)) ? value : undefined
}

function videoBillingLabel(job: VideoJobView): string {
  if (job.billingStatus === 'MOCK_NOT_CHARGED') return 'Mock · 不收费 · MOCK_NOT_CHARGED'
  const actual = job.billingStatus === 'SETTLED' ? validVideoAmount(job.actualCostCny) : undefined
  const quote = validVideoAmount(job.amountCny)
  const status = job.billingStatus === 'SETTLED' && actual === undefined ? '结算金额待核对'
    : job.billingStatus === 'NOT_RESERVED' && job.generationStatus === 'SUBMISSION_UNKNOWN' ? '账务待确认'
      : { NOT_RESERVED: '尚未预占', RESERVED: '费用已预占', SETTLED: '已结算', RELEASED: '预占已释放', RECONCILING: '账务核对中' }[job.billingStatus]
  return `${status}${actual !== undefined ? ` · 实付 ¥${actual}` : quote !== undefined ? ` · 报价 ¥${quote}` : ''}`
}

function VideoFeedback({ pending, notice, id }: { pending: Command | null; notice: Notice | null; id?: string }) {
  if (!pending && !notice) return null
  return <p id={id} className={`media-notice${notice ? ` media-tone-${notice.tone}` : ''}`} role={notice?.tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
    {notice?.message || <><LoaderCircle size={13} aria-hidden="true" />正在处理视频操作</>}
  </p>
}


export function VideoJobList({ jobs, busy, onAction, onPreview, onExport }: {
  jobs: VideoJobView[]; busy: boolean; onAction: (job: VideoJobView, action: JobAction) => void
  onPreview: (selection: OutputSelection) => void; onExport: (selection: OutputSelection) => void
}) {
  return <div className="media-jobs video-jobs">{jobs.map(job => {
    const explicitlyRejected = job.generationStatus === 'FAILED' && job.trackingStatus === 'STOPPED' && isVideoSubmissionRejectionCode(job.error)
    const generation = explicitlyRejected ? { label: '提交被拒绝', tone: 'error' }
      : Object.hasOwn(mediaGenerationLabels, job.generationStatus)
      ? mediaGenerationLabels[job.generationStatus as keyof typeof mediaGenerationLabels]
      : { label: job.generationStatus === 'NOT_SUBMITTED' ? '尚未提交' : '未知生成状态', tone: 'warning' }
    const generated = ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)
    const unfinished = ['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(job.generationStatus)
    const downloadable = videoJobCanDownload(job) && job.outputs.some(output => !videoOutputIsSaved(job, output.outputId) && (!output.expiresAt || Date.parse(output.expiresAt) > Date.now()))
    const retry = generated && downloadable && ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus)
    const resume = !explicitlyRejected && job.trackingStatus !== 'ACTIVE' && (videoBillingPending(job.billingStatus) || unfinished || generated && downloadable && ['PENDING', 'SAVE_FAILED', 'MISSING'].includes(job.saveStatus))
    return <article className="media-job" key={job.jobId} aria-label={`视频任务 ${job.jobId}`}>
      <div className="media-job-heading"><strong>{job.operation === 'image-to-video' ? '图片生成视频' : '文字生成视频'}</strong><span>{job.parameters.durationSeconds} 秒 · {job.parameters.aspectRatio}</span></div>
      <small className="media-job-id">配置 {job.profileId} · {job.parameters.resolution} · {job.parameters.frameRate} fps · {job.parameters.audio ? '含音频' : '无音频'}</small>
      <small className="media-job-id">任务 {job.jobId}</small>
      <div className="media-job-states" aria-live="polite">{[generation, mediaTrackingLabels[job.trackingStatus], mediaSaveLabels[job.saveStatus]].map((status, index) => <span className={`media-tone-${status.tone}`} key={index}>{status.label}</span>)}</div>
      <small>{videoBillingLabel(job)}</small>
      <div className="media-job-timings">
        {queryLabel(job.lastQueriedAt) && <small>最近查询：{queryLabel(job.lastQueriedAt)}</small>}
        {elapsedLabel(job.providerWaitMs) && <small>供应商等待：{elapsedLabel(job.providerWaitMs)}</small>}
        {elapsedLabel(job.downloadMs) && <small>下载保存：{elapsedLabel(job.downloadMs)}</small>}
      </div>
      {job.generationStatus === 'SUBMISSION_UNKNOWN' && <p className="media-notice">提交结果不明{['NOT_RESERVED', 'RECONCILING'].includes(job.billingStatus) ? '，账务待确认' : ''}，请恢复跟踪原任务，不会自动重新生成。</p>}
      {job.trackingStatus === 'AUTH_REQUIRED' && <p className="media-notice">认证恢复后，请手动恢复跟踪。</p>}
      {job.error && <p className="media-notice media-tone-error">{videoErrorMessage(job.error) || (job.generationStatus === 'SUBMISSION_UNKNOWN' ? '提交结果待确认。' : '视频任务未能完成。')}</p>}
      <div className="media-job-actions">
        {resume && <button type="button" className="media-command" disabled={busy} onClick={() => onAction(job, 'resume')}><Play size={13} />恢复跟踪</button>}
        {retry && <button type="button" className="media-command" disabled={busy} title="重新保存原结果，不重新生成" onClick={() => onAction(job, 'retry')}><Download size={13} />重新保存</button>}
      </div>
      {job.outputs.map((output, index) => <div className="video-output" key={output.outputId}>
        <strong>视频成果 {index + 1}</strong>
        <small>{output.width} × {output.height} · {output.durationSeconds} 秒 · {output.mimeType}</small>
        {videoOutputIsSaved(job, output.outputId) ? <div className="media-job-actions">
          <button type="button" className="media-command" disabled={busy} onClick={() => onPreview({ jobId: job.jobId, outputId: output.outputId })}><Play size={13} />预览视频成果 {index + 1}</button>
          <button type="button" className="media-command" disabled={busy} onClick={() => onExport({ jobId: job.jobId, outputId: output.outputId })}><Download size={13} />导出视频成果 {index + 1}</button>
        </div> : <p className="media-notice">此成果尚未确认保存到本地，保存后可预览或导出。</p>}
      </div>)}
    </article>
  })}</div>
}

/** Presentation only: no IPC, remote URLs or eager media reads. */
export function VideoTaskContent({ taskId, view: value, busy, pending, notice, error, onRefresh, onAction, onPreview, onExport }: {
  taskId: string; view: VideoTaskView | null; busy: boolean; pending: Command | null; notice: Notice | null; error: string | null
  onRefresh: () => void
  onAction: (job: VideoJobView, action: JobAction) => void; onPreview: (selection: OutputSelection) => void; onExport: (selection: OutputSelection) => void
}) {
  const view = safeView(value, taskId)
  if (!view) return null
  return <section className="artifact-section media-artifacts video-artifacts" aria-label="视频成果">
    <h3><Film size={15} />视频成果{view.mock && <span className="video-mock-badge">Mock · 不收费</span>}</h3>
    {view.mock && <p className="media-notice">仅供 Mock 视频验证 · MOCK_NOT_CHARGED</p>}
    {error && <p className="media-notice media-tone-error" role="alert">{error}<button type="button" className="media-icon-button" disabled={!!pending} title="重新读取视频任务" aria-label="重新读取视频任务" onClick={onRefresh}><RefreshCw size={14} /></button></p>}
    <VideoFeedback pending={pending} notice={notice} />
    {view.jobs.length ? <VideoJobList jobs={view.jobs} busy={busy} onAction={onAction} onPreview={onPreview} onExport={onExport} /> : <p className="artifact-empty">尚无视频任务</p>}
  </section>
}

function VideoPreviewDialog({ taskId, selection, busy, pending, notice, onClose, onExport }: {
  taskId: string; selection: OutputSelection; busy: boolean; pending: Command | null; notice: Notice | null; onClose: () => void; onExport: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    dialog.current?.showModal()
    closeButton.current?.focus()
  }, [])
  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    setUrl(null)
    setOpened(false)
    setError(null)
    const load = async () => {
      try {
        const result = await window.electronAPI.previewVideoOutput({ taskId, jobId: selection.jobId, outputId: selection.outputId })
        if (!active) return
        if (!result.success || !result.data) { setError(failure(result, '视频预览读取失败')); return }
        if ('opened' in result.data && result.data.opened === true) { setOpened(true); return }
        if (!('bytes' in result.data)) { setError('视频预览数据无效'); return }
        const { mime, bytes } = result.data
        if (!['video/mp4', 'video/webm'].includes(mime) || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
          setError('视频预览数据无效'); return
        }
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mime }))
        setUrl(objectUrl)
      } catch {
        if (active) setError('视频预览读取失败')
      }
    }
    void load()
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [taskId, selection.jobId, selection.outputId, attempt])
  return <dialog ref={dialog} className="media-preview-dialog video-preview-dialog" aria-label="本地视频预览" onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="media-dialog-heading"><strong>本地视频预览</strong><div className="media-dialog-tools">
      <button type="button" className="media-icon-button" title="导出视频" aria-label="导出视频" disabled={busy} onClick={onExport}><Download size={18} /></button>
      <button ref={closeButton} type="button" className="media-icon-button" title="关闭视频预览" aria-label="关闭视频预览" onClick={onClose}><X size={18} /></button>
    </div></div>
    <VideoFeedback pending={pending} notice={notice} />
    {error ? <div><p className="media-notice media-tone-error" role="alert">{error}</p><button type="button" className="media-command" onClick={() => setAttempt(value => value + 1)}>重新读取本地视频</button></div>
      : url ? <video className="video-player" aria-label="本地视频播放器" src={url} controls preload="metadata" playsInline onError={() => setError('本地视频无法播放')} /> : <p className="media-notice" role="status">{opened ? '已在系统播放器打开' : '正在读取本地视频'}</p>}
  </dialog>
}

function VideoTaskController({ taskId }: { taskId: string }) {
  const [view, setView] = useState<VideoTaskView | null>(null)
  const [pending, setPending] = useState<Command | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<OutputSelection | null>(null)
  const alive = useRef(false)
  const lifetime = useRef(0)
  const requestVersion = useRef(0)
  const commandBusy = useRef(false)

  const refresh = useCallback(async (afterCommand = false): Promise<void> => {
    if (!alive.current || commandBusy.current && !afterCommand) return
    const epoch = lifetime.current
    const version = ++requestVersion.current
    const current = () => alive.current && lifetime.current === epoch && version === requestVersion.current
    try {
      const result = await window.electronAPI.getTaskVideo(taskId)
      if (!current()) return
      if (!result.success) { setError(failure(result, '读取视频任务失败')); return }
      if (result.data === null) { setView(null); setPreview(null); setError(null); return }
      const next = safeView(result.data, taskId)
      if (!next) { setView(null); setPreview(null); setError('视频任务数据无效'); return }
      setView(next)
      setError(null)
    } catch {
      if (current()) setError('读取视频任务失败，请稍后重试')
    }
  }, [taskId])

  useEffect(() => {
    // Keep the presentation importable by the existing Node SSR test runner.
    void import('../../styles/video-artifacts.css')
    alive.current = true
    const epoch = ++lifetime.current
    commandBusy.current = false
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await refresh()
      if (active) timer = setTimeout(() => { void poll() }, POLL_INTERVAL)
    }
    if (typeof window.electronAPI?.getTaskVideo === 'function') void poll()
    return () => { alive.current = false; active = false; lifetime.current = epoch + 1; if (timer) clearTimeout(timer) }
  }, [refresh])

  async function run(command: Command, execute: (api: ElectronAPI) => Promise<IpcCommandResult & { cancelled?: boolean }>): Promise<void> {
    if (!alive.current || commandBusy.current) return
    const epoch = lifetime.current
    commandBusy.current = true
    requestVersion.current++
    setPending(command)
    setNotice(null)
    try {
      const result = await execute(window.electronAPI)
      if (!alive.current || lifetime.current !== epoch) return
      if (!result.success) setNotice({ message: failure(result, '视频操作失败'), tone: 'error' })
      else if (command === 'export' && !result.cancelled) setNotice({ message: '视频已导出', tone: 'success' })
      if (command !== 'export') await refresh(true)
    } catch {
      if (alive.current && lifetime.current === epoch) {
        setNotice({ message: '视频操作失败，请稍后重试', tone: 'error' })
        if (command !== 'export') await refresh(true)
      }
    } finally {
      if (alive.current && lifetime.current === epoch) { commandBusy.current = false; setPending(null) }
    }
  }

  const exportOutput = (selection: OutputSelection) => { void run('export', api => api.exportVideoOutput({ taskId, ...selection })) }
  const previewAvailable = preview && view?.jobs.some(job => job.jobId === preview.jobId && videoOutputIsSaved(job, preview.outputId))
  useEffect(() => { if (preview && !previewAvailable) setPreview(null) }, [preview, previewAvailable])
  const busy = pending !== null || error !== null
  return <>
    <VideoTaskContent taskId={taskId} view={view} busy={busy} pending={pending} notice={notice} error={error}
      onRefresh={() => { void refresh() }}
      onAction={(job, action) => { void run(action, api => action === 'resume' ? api.resumeVideoTracking({ taskId, jobId: job.jobId }) : api.retryVideoSave({ taskId, jobId: job.jobId })) }}
      onPreview={setPreview} onExport={exportOutput} />
    {preview && previewAvailable && <VideoPreviewDialog key={`${taskId}:${preview.jobId}:${preview.outputId}`} taskId={taskId} selection={preview} busy={busy} pending={pending} notice={notice} onClose={() => setPreview(null)} onExport={() => exportOutput(preview)} />}
  </>
}

export function VideoTaskPanel({ taskId }: { taskId: string }) {
  return <VideoTaskController key={taskId} taskId={taskId} />
}

export { VideoTaskPanel as VideoArtifactsPanel }
