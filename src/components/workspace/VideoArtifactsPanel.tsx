/// <reference types="vite/client" />
import { Download, Film, ImagePlus, LoaderCircle, Play, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { z } from 'zod'
import type { ElectronAPI, IpcCommandResult } from '../../shared/ipc'
import type { MediaAssetView } from '../../shared/media'
import { mediaGenerationLabels, mediaSaveLabels, mediaTrackingLabels, selectMediaProfile, videoFormParameters } from '../../shared/media-view'
import { videoGenerationInputSchema, type VideoGenerationInput, type VideoJobView, type VideoTaskView } from '../../shared/video-host'
import { videoAllowedAudioModes, videoBillingPending, videoBillingStatusSchema, videoOperationSchema, videoOutputSchema, videoParametersSchema, videoRuntimeSchema, type VideoRuntime } from '../../shared/video-media'
import { useMediaParameterPreferences } from './media-preference-scope'

type Command = 'import' | 'generate' | 'export' | 'resume' | 'retry'
type JobAction = 'resume' | 'retry'
type Notice = { message: string; tone: 'error' | 'success' }
type OutputSelection = { jobId: string; outputId: string }
const POLL_INTERVAL = 3000
const localId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const jobSchema = z.object({
  jobId: localId, taskId: localId, profileId: localId, operation: videoOperationSchema,
  parameters: videoParametersSchema, generationStatus: z.string().max(80),
  trackingStatus: z.enum(['ACTIVE', 'INTERRUPTED', 'AUTH_REQUIRED', 'STOPPED']),
  saveStatus: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
  billingStatus: videoBillingStatusSchema, amountCny: z.string().optional(), actualCostCny: z.string().optional(), amountUsd: z.string().optional(), createdAt: z.number().finite(), updatedAt: z.number().finite(),
  error: z.string().nullable(), outputs: z.array(videoOutputSchema).max(4),
  savedOutputIds: z.array(localId).max(4).optional(),
})
const referenceSchema = z.object({
  localAssetId: localId, taskId: localId, jobId: localId.nullable(), outputId: localId.nullable(),
  source: z.literal('reference'), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  size: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  status: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
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

function safeReferences(values: unknown, taskId: string): MediaAssetView[] {
  if (!Array.isArray(values)) return []
  const ids = new Set<string>()
  return values.flatMap(value => {
    const result = referenceSchema.safeParse(value)
    if (!result.success || result.data.taskId !== taskId || ids.has(result.data.localAssetId)) return []
    ids.add(result.data.localAssetId)
    return [result.data]
  })
}

function operations(runtime: VideoRuntime, profile: VideoRuntime['profiles'][number]): VideoGenerationInput['operation'][] {
  return profile.operations.filter(operation => operation === 'image-to-video'
    ? runtime.tools.includes('video_from_image') && profile.capabilities.supportsImageToVideo
    : runtime.tools.includes('video_generate') && profile.capabilities.supportsTextToVideo)
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

function VideoFeedback({ pending, notice, id }: { pending: Command | null; notice: Notice | null; id?: string }) {
  if (!pending && !notice) return null
  return <p id={id} className={`media-notice${notice ? ` media-tone-${notice.tone}` : ''}`} role={notice?.tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
    {notice?.message || <><LoaderCircle size={13} aria-hidden="true" />正在处理视频操作</>}
  </p>
}

export function VideoCreationForm({ taskId, runtime, references, busy, pending = null, notice = null, onImport, onGenerate }: {
  taskId: string; runtime: VideoRuntime; references: MediaAssetView[]; busy: boolean; pending?: Command | null; notice?: Notice | null
  onImport: () => void; onGenerate: (input: VideoGenerationInput) => void
}) {
  const id = useId()
  const profiles = runtime.profiles.filter(profile => operations(runtime, profile).length > 0)
  const [profileId, setProfileId] = useState('')
  const profile = selectMediaProfile(profiles, profileId, runtime.defaultProfileId)
  const availableOperations = profile ? operations(runtime, profile) : []
  const [chosenOperation, setOperation] = useState<VideoGenerationInput['operation']>('image-to-video')
  const operation = availableOperations.includes(chosenOperation) ? chosenOperation : availableOperations[0]
  const [selectedId, setSelectedId] = useState('')
  const [brief, setBrief] = useState('')
  const preferences = useMediaParameterPreferences('video', profile?.profileId)
  const binding = JSON.stringify([preferences.key, profile, operation, runtime.protocolVersion, runtime.executionMode])
  const [choices, setChoices] = useState<{ binding: string; parameters: Partial<VideoGenerationInput['parameters']> }>({ binding: '', parameters: {} })
  const caps = profile?.capabilities
  const audioModes = profile ? videoAllowedAudioModes(runtime, profile) : []
  const localReferences = safeReferences(references, taskId)
  const selected = localReferences.find(asset => asset.localAssetId === selectedId && asset.status === 'SAVED' && caps && asset.size <= caps.maxInputBytes)
  const parameters = profile ? videoFormParameters(runtime, profile, choices.binding === binding ? choices.parameters : preferences.parameters) : null
  useEffect(() => {
    setSelectedId('')
  }, [binding])
  useEffect(() => {
    if (profile && profileId !== profile.profileId) setProfileId(profile.profileId)
  }, [profile, profileId])
  function changeParameters(patch: Partial<VideoGenerationInput['parameters']>): void {
    if (!profile) return
    const next = videoFormParameters(runtime, profile, { ...parameters, ...patch })
    setChoices({ binding, parameters: next ?? {} })
    if (next) preferences.save(next)
  }
  const input = videoGenerationInputSchema.safeParse({ profileId: profile?.profileId, operation,
    localAssetIds: operation === 'image-to-video' && selected ? [selected.localAssetId] : [], creativeBrief: brief, parameters })
  const problem = !runtime.executionAvailable || !profile || !operation ? '当前没有可用的视频生成配置'
    : operation === 'image-to-video' && !selected ? '请选择一张已保存的本地参考图'
      : !brief.trim() ? '请填写视频创作需求' : !input.success ? '请检查视频参数和创作需求' : null
  const disabled = busy || !runtime.executionAvailable || !profile

  return <form className="media-creation video-creation" onSubmit={event => {
    event.preventDefault()
    if (!disabled && !problem && input.success) onGenerate(input.data)
  }}>
    <label htmlFor={`${id}-profile`}>视频模型</label>
    <select id={`${id}-profile`} value={profile?.profileId || ''} disabled={disabled} onChange={event => { setProfileId(event.target.value); setSelectedId('') }}>
      {!profile && <option value="">尚未配置</option>}
      {profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>)}
    </select>
    <label htmlFor={`${id}-operation`}>视频创作方式{availableOperations.length === 1 ? '（固定）' : ''}</label>
    <select id={`${id}-operation`} value={operation || ''} disabled={disabled || availableOperations.length === 1} onChange={event => setOperation(event.target.value as VideoGenerationInput['operation'])}>
      {availableOperations.map(value => <option key={value} value={value}>{value === 'image-to-video' ? '图片生成视频' : '文字生成视频'}</option>)}
    </select>
    {operation === 'image-to-video' && <>
      <div className="media-subheading"><span>本地参考图 · 单选</span><button type="button" className="media-command" disabled={disabled} onClick={onImport}><ImagePlus size={14} />从系统选择视频参考图</button></div>
      <fieldset className="video-references" disabled={disabled}><legend className="sr-only">选择一张视频参考图</legend>
        {localReferences.length ? localReferences.map((asset, index) => <label className="media-reference-select video-reference" key={asset.localAssetId}>
          <input type="radio" name={`${id}-reference`} aria-label={`视频参考图 ${index + 1}`} checked={selected?.localAssetId === asset.localAssetId} disabled={asset.status !== 'SAVED' || !caps || asset.size > caps.maxInputBytes} onChange={() => setSelectedId(asset.localAssetId)} />
          <span>视频参考图 {index + 1}<small>{asset.width} × {asset.height} · {asset.mime} · {mediaSaveLabels[asset.status].label}{caps && asset.size > caps.maxInputBytes ? ' · 超出当前配置大小限制' : ''}</small></span>
        </label>) : <p className="artifact-empty">尚无本地视频参考图</p>}
      </fieldset>
    </>}
    {caps && parameters && <div className="media-specs">
      <label>时长{caps.durationsSeconds.length === 1 ? '（固定）' : ''}<select aria-label="视频时长" value={parameters.durationSeconds} disabled={disabled || caps.durationsSeconds.length === 1} onChange={event => changeParameters({ durationSeconds: Number(event.target.value) })}>{caps.durationsSeconds.map(value => <option key={value} value={value}>{value} 秒</option>)}</select></label>
      <label>比例{caps.aspectRatios.length === 1 ? '（固定）' : ''}<select aria-label="视频比例" value={parameters.aspectRatio} disabled={disabled || caps.aspectRatios.length === 1} onChange={event => changeParameters({ aspectRatio: event.target.value })}>{caps.aspectRatios.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>分辨率{caps.resolutions.length === 1 ? '（固定）' : ''}<select aria-label="视频分辨率" value={parameters.resolution} disabled={disabled || caps.resolutions.length === 1} onChange={event => changeParameters({ resolution: event.target.value as typeof parameters.resolution })}>{caps.resolutions.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>帧率{caps.frameRates.length === 1 ? '（固定）' : ''}<select aria-label="视频帧率" value={parameters.frameRate} disabled={disabled || caps.frameRates.length === 1} onChange={event => changeParameters({ frameRate: Number(event.target.value) })}>{caps.frameRates.map(value => <option key={value} value={value}>{value} fps</option>)}</select></label>
      <label>音频{audioModes.length === 1 ? '（固定）' : ''}<select aria-label="视频音频" value={String(parameters.audio)} disabled={disabled || audioModes.length === 1} onChange={event => changeParameters({ audio: event.target.value === 'true' })}>{audioModes.map(value => <option key={String(value)} value={String(value)}>{value ? '含音频' : '无音频'}</option>)}</select></label>
      <label>格式{caps.outputFormats.length === 1 ? '（固定）' : ''}<select aria-label="视频输出格式" value={parameters.outputFormat} disabled={disabled || caps.outputFormats.length === 1} onChange={event => changeParameters({ outputFormat: event.target.value as typeof parameters.outputFormat })}>{caps.outputFormats.map(value => <option key={value} value={value}>{value === 'video/mp4' ? 'MP4' : 'WebM'}</option>)}</select></label>
    </div>}
    <label htmlFor={`${id}-brief`}>视频创作需求</label>
    <textarea id={`${id}-brief`} rows={4} maxLength={4000} value={brief} disabled={disabled} placeholder="画面内容、镜头运动、商品特征与动作要求" onChange={event => setBrief(event.target.value)} />
    {problem && <p className="media-notice">{problem}</p>}
    <button type="submit" className="media-command media-primary" disabled={disabled || !!problem} aria-describedby={pending || notice ? `${id}-feedback` : undefined}><Film size={14} />提交视频生成</button>
    <VideoFeedback id={`${id}-feedback`} pending={pending} notice={notice} />
  </form>
}

export function VideoJobList({ jobs, busy, onAction, onPreview, onExport }: {
  jobs: VideoJobView[]; busy: boolean; onAction: (job: VideoJobView, action: JobAction) => void
  onPreview: (selection: OutputSelection) => void; onExport: (selection: OutputSelection) => void
}) {
  return <div className="media-jobs video-jobs">{jobs.map(job => {
    const generation = Object.hasOwn(mediaGenerationLabels, job.generationStatus)
      ? mediaGenerationLabels[job.generationStatus as keyof typeof mediaGenerationLabels]
      : { label: job.generationStatus === 'NOT_SUBMITTED' ? '尚未提交' : '未知生成状态', tone: 'warning' }
    const generated = ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(job.generationStatus)
    const unfinished = ['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(job.generationStatus)
    const downloadable = videoJobCanDownload(job) && job.outputs.some(output => !videoOutputIsSaved(job, output.outputId) && (!output.expiresAt || Date.parse(output.expiresAt) > Date.now()))
    const retry = generated && downloadable && ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus)
    const resume = job.trackingStatus !== 'ACTIVE' && (videoBillingPending(job.billingStatus) || unfinished || generated && downloadable && ['PENDING', 'SAVE_FAILED', 'MISSING'].includes(job.saveStatus))
    return <article className="media-job" key={job.jobId} aria-label={`视频任务 ${job.jobId}`}>
      <div className="media-job-heading"><strong>{job.operation === 'image-to-video' ? '图片生成视频' : '文字生成视频'}</strong><span>{job.parameters.durationSeconds} 秒 · {job.parameters.aspectRatio}</span></div>
      <small className="media-job-id">配置 {job.profileId} · {job.parameters.resolution} · {job.parameters.frameRate} fps · {job.parameters.audio ? '含音频' : '无音频'}</small>
      <small className="media-job-id">任务 {job.jobId}</small>
      <div className="media-job-states" aria-live="polite">{[generation, mediaTrackingLabels[job.trackingStatus], mediaSaveLabels[job.saveStatus]].map((status, index) => <span className={`media-tone-${status.tone}`} key={index}>{status.label}</span>)}</div>
      <small>{job.billingStatus === 'MOCK_NOT_CHARGED' ? 'Mock · 不收费 · MOCK_NOT_CHARGED' : `${({ NOT_RESERVED: '尚未预占', RESERVED: '费用已预占', SETTLED: '已结算', RELEASED: '预占已释放', RECONCILING: '账务核对中' } as const)[job.billingStatus]}${job.actualCostCny ? ` · 实付 ¥${job.actualCostCny}` : job.amountCny ? ` · 报价 ¥${job.amountCny}` : ''}`}</small>
      {job.generationStatus === 'SUBMISSION_UNKNOWN' && <p className="media-notice">提交结果不明，请恢复跟踪原任务，不会自动重新生成。</p>}
      {job.trackingStatus === 'AUTH_REQUIRED' && <p className="media-notice">认证恢复后，请手动恢复跟踪。</p>}
      {job.error && <p className="media-notice media-tone-error">{job.error}</p>}
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
export function VideoTaskContent({ taskId, view: value, references, busy, pending, notice, error, onRefresh, onImport, onGenerate, onAction, onPreview, onExport }: {
  taskId: string; view: VideoTaskView | null; references: MediaAssetView[]; busy: boolean; pending: Command | null; notice: Notice | null; error: string | null
  onRefresh: () => void; onImport: () => void; onGenerate: (input: VideoGenerationInput) => void
  onAction: (job: VideoJobView, action: JobAction) => void; onPreview: (selection: OutputSelection) => void; onExport: (selection: OutputSelection) => void
}) {
  const view = safeView(value, taskId)
  if (!view) return null
  return <section className="artifact-section media-artifacts video-artifacts" aria-label="视频创作与成果">
    <h3><Film size={15} />视频创作与成果{view.mock && <span className="video-mock-badge">Mock · 不收费</span>}</h3>
    {view.mock && <p className="media-notice">仅供 Mock 视频验证 · MOCK_NOT_CHARGED</p>}
    {error && <p className="media-notice media-tone-error" role="alert">{error}<button type="button" className="media-icon-button" disabled={!!pending} title="重新读取视频任务" aria-label="重新读取视频任务" onClick={onRefresh}><RefreshCw size={14} /></button></p>}
    <VideoCreationForm taskId={taskId} runtime={view.runtime} references={references} busy={busy} pending={pending} notice={notice} onImport={onImport} onGenerate={onGenerate} />
    {view.jobs.length ? <><h4>视频任务与成果</h4><VideoJobList jobs={view.jobs} busy={busy} onAction={onAction} onPreview={onPreview} onExport={onExport} /></> : <p className="artifact-empty">尚无视频任务</p>}
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
  const [references, setReferences] = useState<MediaAssetView[]>([])
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
      if (result.data === null) { setView(null); setReferences([]); setPreview(null); setError(null); return }
      const next = safeView(result.data, taskId)
      if (!next) { setView(null); setReferences([]); setPreview(null); setError('视频任务数据无效'); return }
      setView(next)
      setError(null)
      const refs = await window.electronAPI.getVideoReferences(taskId)
      if (!current()) return
      setReferences(refs.success ? safeReferences(refs.data, taskId) : [])
      if (!refs.success) setError(failure(refs, '读取视频参考图失败'))
    } catch {
      if (current()) { setReferences([]); setError('读取视频任务失败，请稍后重试') }
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
        setNotice({ message: command === 'generate' ? '未收到提交结果，请查看原任务记录，不要重复提交。' : '视频操作失败，请稍后重试', tone: 'error' })
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
    <VideoTaskContent taskId={taskId} view={view} references={references} busy={busy} pending={pending} notice={notice} error={error}
      onRefresh={() => { void refresh() }} onImport={() => { void run('import', api => api.importVideoReferences(taskId)) }}
      onGenerate={input => { void run('generate', api => api.generateTaskVideo({ taskId, input })) }}
      onAction={(job, action) => { void run(action, api => action === 'resume' ? api.resumeVideoTracking({ taskId, jobId: job.jobId }) : api.retryVideoSave({ taskId, jobId: job.jobId })) }}
      onPreview={setPreview} onExport={exportOutput} />
    {preview && previewAvailable && <VideoPreviewDialog key={`${taskId}:${preview.jobId}:${preview.outputId}`} taskId={taskId} selection={preview} busy={busy} pending={pending} notice={notice} onClose={() => setPreview(null)} onExport={() => exportOutput(preview)} />}
  </>
}

export function VideoTaskPanel({ taskId }: { taskId: string }) {
  return <VideoTaskController key={taskId} taskId={taskId} />
}

export { VideoTaskPanel as VideoArtifactsPanel }
