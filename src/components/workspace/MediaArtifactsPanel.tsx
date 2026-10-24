import { Download, ImagePlus, Image as ImageIcon, LoaderCircle, Play, RefreshCw, RotateCcw, Square, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ElectronAPI, IpcCommandResult } from '../../shared/ipc'
import type { MediaAssetView, MediaGenerationInput, MediaJobView, MediaOperation, MediaPreview, MediaProfile, MediaTaskView } from '../../shared/media'
import { imageFormAspectRatios, imageFormParameters, imageFormSizes, mediaGenerationLabels, mediaInputProblem, mediaJobActions, mediaSaveLabels, mediaTrackingLabels, selectMediaProfile } from '../../shared/media-view'
import { videoRuntimeSchema } from '../../shared/video-media'
import { VideoTaskPanel } from './VideoArtifactsPanel'
import { useMediaParameterPreferences } from './media-preference-scope'

type Command = 'import' | 'video-import' | 'selection' | 'generate' | 'export' | 'retry' | 'cancel' | 'resume' | 'redo'
type JobAction = Exclude<Command, 'import' | 'video-import' | 'selection' | 'generate' | 'export'>
type CommandNotice = { message: string; tone: 'error' | 'success' }
type CommandFeedback = { pending: Command | null; notice: CommandNotice | null }
const POLL_INTERVAL = 3000

function elapsedLabel(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} 秒`
}

function queryLabel(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

export function canImportVideoReference(value: unknown): boolean {
  const result = videoRuntimeSchema.safeParse(value)
  return result.success && result.data.executionAvailable && result.data.tools.includes('video_from_image') &&
    result.data.profiles.some(profile => profile.operations.includes('image-to-video') && profile.capabilities.supportsImageToVideo)
}

export function MediaCommandFeedback({ pending, notice, id }: Partial<CommandFeedback> & { id?: string }) {
  if (!pending && !notice) return null
  return <p id={id} className={`media-notice${notice ? ` media-tone-${notice.tone}` : ''}`} role={notice?.tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
    {notice ? notice.message : <><LoaderCircle size={13} aria-hidden="true" />{pending === 'video-import' ? '正在导入视频参考图' : '正在处理图片操作'}</>}
  </p>
}

function failure(result: IpcCommandResult, fallback: string): string {
  return result.error?.message || fallback
}

function useAssetPreview(taskId: string, asset: MediaAssetView): { url: string | null; error: string | null; retry: () => void } {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    setUrl(null)
    setError(null)
    if (asset.status !== 'SAVED') return
    const load = async () => {
      try {
        const result = await window.electronAPI.previewMediaAsset({ taskId, assetId: asset.localAssetId })
        if (!active) return
        if (!result.success || !result.data) {
          setError(failure(result, '图片预览不可用'))
          return
        }
        const preview: MediaPreview = result.data
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(preview.bytes).buffer], { type: preview.mime }))
        setUrl(objectUrl)
      } catch {
        if (active) setError('图片预览读取失败')
      }
    }
    void load()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [taskId, asset.localAssetId, asset.status, attempt])
  return { url, error, retry: () => setAttempt(value => value + 1) }
}

function AssetImage({ taskId, asset, large = false }: { taskId: string; asset: MediaAssetView; large?: boolean }) {
  const preview = useAssetPreview(taskId, asset)
  const [decodeError, setDecodeError] = useState(false)
  useEffect(() => setDecodeError(false), [preview.url])
  const error = preview.error || (decodeError ? '图片解码失败' : null)
  return <div className={`media-image ${large ? 'media-image-large' : ''}`}>
    {preview.url && !error ? <img src={preview.url} alt={asset.source === 'reference' ? '商品参考图' : '图片成果'} onError={() => setDecodeError(true)} /> :
      <span className="media-image-placeholder"><ImageIcon size={20} /><span>{error || (asset.status === 'SAVED' ? '读取图片' : mediaSaveLabels[asset.status].label)}</span></span>}
    {error && large && <button type="button" className="media-command" onClick={preview.retry}><RefreshCw size={14} />重新读取</button>}
  </div>
}

export function MediaAssetGrid({ taskId, assets, references = false, selected = [], disabled = false, onSelect, onPreview, onExport }: {
  taskId: string; assets: MediaAssetView[]; references?: boolean; selected?: string[]; disabled?: boolean
  onSelect?: (id: string) => void; onPreview: (asset: MediaAssetView) => void; onExport?: (asset: MediaAssetView) => void
}) {
  return <div className="media-grid">{assets.map((asset, index) => <div className="media-asset" key={asset.localAssetId}>
    <button type="button" className="media-preview-button" disabled={asset.status !== 'SAVED'} onClick={() => onPreview(asset)} title={`放大查看${references ? '参考图' : '成果'} ${index + 1}`} aria-label={`放大查看${references ? '参考图' : '成果'} ${index + 1}`}>
      <AssetImage key={`${taskId}:${asset.localAssetId}:${asset.status}`} taskId={taskId} asset={asset} />
    </button>
    <div className="media-asset-caption">
      {references ? <label className="media-reference-select"><input type="checkbox" checked={selected.includes(asset.localAssetId)} disabled={disabled || asset.status !== 'SAVED'} onChange={() => onSelect?.(asset.localAssetId)} />参考图 {index + 1}</label> : <span>成果 {index + 1}</span>}
      {!references && asset.status === 'SAVED' && <button type="button" className="media-icon-button" disabled={disabled} title={`导出成果 ${index + 1}`} aria-label={`导出成果 ${index + 1}`} onClick={() => onExport?.(asset)}><Download size={14} /></button>}
    </div>
    <small>{asset.width} × {asset.height} · {asset.mime.replace('image/', '').toUpperCase()}</small>
    <small className={`media-tone-${mediaSaveLabels[asset.status].tone}`}>{mediaSaveLabels[asset.status].label}</small>
  </div>)}</div>
}

export function MediaCreationForm({ profiles, defaultProfileId, references, archived, busy, onImport, onGenerate, taskId, onPreview, feedback }: {
  profiles: MediaProfile[]; references: MediaAssetView[]; archived: boolean; busy: boolean; taskId: string
  defaultProfileId?: string | null
  onImport: () => void; onGenerate: (input: MediaGenerationInput) => void; onPreview: (asset: MediaAssetView) => void
  feedback?: CommandFeedback
}) {
  const id = useId()
  const [profileId, setProfileId] = useState('')
  const profile = selectMediaProfile(profiles, profileId, defaultProfileId)
  const [operation, setOperation] = useState<MediaOperation>('generate')
  const [selected, setSelected] = useState<string[]>([])
  const [brief, setBrief] = useState('')
  const preferences = useMediaParameterPreferences('image', profile?.profileId)
  const binding = JSON.stringify([preferences.key, profile, operation])
  const [choices, setChoices] = useState<{ binding: string; parameters: Partial<MediaGenerationInput['parameters']> }>({ binding: '', parameters: {} })
  const parameters = profile ? imageFormParameters(profile, choices.binding === binding ? choices.parameters : preferences.parameters) : null
  const ratios = profile ? imageFormAspectRatios(profile) : []
  const sizes = profile ? imageFormSizes(profile) : []
  const qualities = profile?.allowedQualities ?? []
  const selectedIds = selected.filter(assetId => references.some(asset => asset.localAssetId === assetId && asset.status === 'SAVED'))
  const problem = archived ? '任务已归档，只可查看已有成果' : profile && !parameters ? '当前配置没有可用的图片规格' : mediaInputProblem(profile, operation, selectedIds.length, brief)
  useEffect(() => {
    setSelected([])
  }, [binding])
  useEffect(() => {
    if (profile && profileId !== profile.profileId) setProfileId(profile.profileId)
  }, [profile, profileId])
  function changeParameters(patch: Partial<MediaGenerationInput['parameters']>, preferred: 'size' | 'aspectRatio' = 'size'): void {
    if (!profile) return
    const next = imageFormParameters(profile, { ...parameters, ...patch }, preferred)
    setChoices({ binding, parameters: next ?? {} })
    if (next) preferences.save(next)
  }

  return <form className="media-creation" onSubmit={event => {
    event.preventDefault()
    if (!profile || !parameters || problem || busy) return
    onGenerate({ profileId: profile.profileId, operation, localAssetIds: selectedIds, creativeBrief: brief.trim(), parameters })
  }}>
    <label htmlFor={`${id}-profile`}>图片模型</label>
    <select id={`${id}-profile`} value={profile?.profileId || ''} disabled={busy || archived || !profiles.length} onChange={event => setProfileId(event.target.value)}>
      {!profiles.length && <option value="">尚未配置</option>}
      {profiles.map(item => <option key={item.profileId} value={item.profileId}>{item.displayName}</option>)}
    </select>
    <div className="media-mode" role="group" aria-label="图片创作方式">
      <button type="button" aria-pressed={operation === 'generate'} disabled={busy || archived || !profile?.operations.includes('generate')} onClick={() => setOperation('generate')}>生成</button>
      <button type="button" aria-pressed={operation === 'edit'} disabled={busy || archived || !profile?.operations.includes('edit') || !profile.capabilities.referenceImage} onClick={() => setOperation('edit')}>编辑参考图</button>
    </div>
    {operation === 'edit' && (!profile?.operations.includes('edit') || !profile.capabilities.referenceImage) && <p className="media-notice">当前配置不支持图片编辑</p>}
    <div className="media-subheading"><span>商品参考图</span><button type="button" className="media-icon-button" title="从系统选择参考图" aria-label="从系统选择参考图" disabled={busy || archived || !profile?.capabilities.referenceImage} onClick={onImport}><ImagePlus size={16} /></button></div>
    {references.length > 0 ? <MediaAssetGrid taskId={taskId} assets={references} references selected={selectedIds} disabled={busy || archived} onSelect={assetId => setSelected(value => value.includes(assetId) ? value.filter(item => item !== assetId) : [...value, assetId])} onPreview={onPreview} /> : <p className="artifact-empty">尚无参考图</p>}
    <div className="media-specs">
      <label>比例{ratios.length === 1 ? '（固定）' : ''}<select aria-label="图片比例" value={parameters?.aspectRatio || ''} disabled={busy || archived || !parameters || ratios.length === 1} onChange={event => changeParameters({ aspectRatio: event.target.value }, 'aspectRatio')}>{ratios.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>数量{profile?.maxCount === 1 ? '（固定）' : ''}<input aria-label="图片数量" type="number" min={1} max={profile?.maxCount || 1} step={1} value={parameters?.count ?? 1} disabled={busy || archived || !parameters} readOnly={profile?.maxCount === 1} onChange={event => changeParameters({ count: Number(event.target.value) })} /></label>
      {!!profile?.allowedSizes?.length && <label>尺寸{sizes.length === 1 ? '（固定）' : ''}<select aria-label="图片尺寸" value={parameters?.size ?? ''} disabled={busy || archived || !parameters || sizes.length === 1} onChange={event => changeParameters({ size: event.target.value })}>{sizes.map(value => <option key={value}>{value}</option>)}</select></label>}
      {!!qualities.length && <label>质量{qualities.length === 1 ? '（固定）' : ''}<select aria-label="图片质量" value={parameters?.quality ?? ''} disabled={busy || archived || !parameters || qualities.length === 1} onChange={event => changeParameters({ quality: event.target.value })}>{qualities.map(value => <option key={value}>{value}</option>)}</select></label>}
    </div>
    <label htmlFor={`${id}-brief`}>创作需求</label>
    <textarea id={`${id}-brief`} rows={4} value={brief} disabled={busy || archived} placeholder="用途、画面要求、不可改变的商品特征" onChange={event => setBrief(event.target.value)} />
    {problem && <p className="media-notice">{problem}</p>}
    <button type="submit" className="media-command media-primary" disabled={busy || !!problem} aria-describedby={feedback?.pending || feedback?.notice ? `${id}-feedback` : undefined}>{busy ? <LoaderCircle size={14} /> : <ImagePlus size={14} />}{operation === 'edit' ? '提交图片编辑' : '提交图片生成'}</button>
    <MediaCommandFeedback {...feedback} id={`${id}-feedback`} />
  </form>
}

export function MediaJobList({ jobs, archived, busy, onAction }: { jobs: MediaJobView[]; archived: boolean; busy: boolean; onAction: (job: MediaJobView, action: JobAction, cancelUpstream?: boolean) => void }) {
  return <div className="media-jobs">{jobs.map(job => {
    const actions = mediaJobActions(job, archived)
    return <div className="media-job" key={job.jobId}>
      <div className="media-job-heading"><strong>{job.operation === 'edit' ? '图片编辑' : '图片生成'} · {job.parameters.count} 张</strong><span>{job.parameters.aspectRatio}</span></div>
      <small className="media-job-id">配置 {job.profileId}{job.parameters.size ? ` · ${job.parameters.size}` : ''}{job.parameters.quality ? ` · ${job.parameters.quality}` : ''}</small>
      <small className="media-job-id">任务 {job.jobId}</small>
      <div className="media-job-states" aria-live="polite">{[mediaGenerationLabels[job.generationStatus], mediaTrackingLabels[job.trackingStatus], mediaSaveLabels[job.saveStatus]].map((status, index) => <span className={`media-tone-${status.tone}`} key={index}>{status.label}</span>)}</div>
      <small>账务状态：{job.billingStatus || '未确认'}</small>
      <div className="media-job-timings">
        {queryLabel(job.lastQueriedAt) && <small>最近查询：{queryLabel(job.lastQueriedAt)}</small>}
        {elapsedLabel(job.providerWaitMs) && <small>供应商等待：{elapsedLabel(job.providerWaitMs)}</small>}
        {elapsedLabel(job.downloadMs) && <small>下载保存：{elapsedLabel(job.downloadMs)}</small>}
      </div>
      {job.generationStatus === 'SUBMISSION_UNKNOWN' && <p className="media-notice">尚不能确认上游是否接单，不会自动重新生成。</p>}
      {job.trackingStatus === 'AUTH_REQUIRED' && <p className="media-notice">认证恢复后可继续跟踪原任务。</p>}
      {job.trackingStatus === 'STOPPED' && <p className="media-notice">仅停止本地跟踪，上游可能继续生成和计费。</p>}
      {job.error && <p className="media-notice media-tone-error">{job.error}</p>}
      <div className="media-job-actions">
        {actions.stopTracking && <button type="button" className="media-command" disabled={busy} onClick={() => onAction(job, 'cancel', false)} title="停止本地跟踪，上游可能继续计费"><Square size={13} />停止跟踪</button>}
        {actions.cancelUpstream && <button type="button" className="media-command" disabled={busy} onClick={() => onAction(job, 'cancel', true)} title="请求上游取消，不代表退款"><X size={13} />请求上游取消</button>}
        {actions.resumeTracking && <button type="button" className="media-command" disabled={busy} onClick={() => onAction(job, 'resume')}><Play size={13} />恢复跟踪</button>}
        {actions.retrySave && <button type="button" className="media-command" disabled={busy} onClick={() => onAction(job, 'retry')} title="重新保存原结果，不重新生成"><Download size={13} />重新保存</button>}
        {actions.redo && <button type="button" className="media-command" disabled={busy} onClick={() => onAction(job, 'redo')} title="按原任务重做，新生成可能收费"><RotateCcw size={13} />重做（可能收费）</button>}
      </div>
    </div>
  })}</div>
}

function MediaPreviewDialog({ taskId, asset, busy, onClose, onExport, feedback }: { taskId: string; asset: MediaAssetView; busy: boolean; onClose: () => void; onExport: () => void; feedback: CommandFeedback }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
    closeButton.current?.focus()
  }, [])
  return <dialog className="media-preview-dialog" ref={dialog} aria-label="图片大图预览" onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="media-dialog-heading"><strong>{asset.source === 'reference' ? '商品参考图' : '图片成果'}</strong><div className="media-dialog-tools"><button type="button" className="media-icon-button" title="导出图片" aria-label="导出图片" disabled={busy} onClick={onExport}><Download size={18} /></button><button type="button" className="media-icon-button" title="关闭大图预览" aria-label="关闭大图预览" ref={closeButton} onClick={onClose}><X size={18} /></button></div></div>
    <MediaCommandFeedback {...feedback} />
    <AssetImage key={`${taskId}:${asset.localAssetId}`} taskId={taskId} asset={asset} large />
    <p>{asset.width} × {asset.height} · {asset.mime} · {mediaSaveLabels[asset.status].label}</p>
  </dialog>
}

function MediaTaskPanel({ taskId }: { taskId: string }) {
  const [view, setView] = useState<MediaTaskView | null>(null)
  const [videoReferenceAvailable, setVideoReferenceAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<CommandNotice | null>(null)
  const [pending, setPending] = useState<Command | null>(null)
  const [preview, setPreview] = useState<MediaAssetView | null>(null)
  const alive = useRef(false)
  const lifetime = useRef(0)
  const commandBusy = useRef(false)
  const requestVersion = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!alive.current) return
    const epoch = lifetime.current
    const version = ++requestVersion.current
    try {
      const videoPromise = typeof window.electronAPI?.getTaskVideo === 'function' ? window.electronAPI.getTaskVideo(taskId).catch(() => null) : Promise.resolve(null)
      const [result, videoResult] = await Promise.all([window.electronAPI.getTaskMedia(taskId), videoPromise])
      if (!alive.current || epoch !== lifetime.current || version !== requestVersion.current) return
      setVideoReferenceAvailable(!!videoResult?.success && !!videoResult.data && canImportVideoReference(videoResult.data.runtime))
      if (result.success && result.data) {
        setView(result.data)
        setError(null)
      } else setError(failure(result, '读取图片任务失败'))
    } catch {
      if (alive.current && epoch === lifetime.current && version === requestVersion.current) setError('读取图片任务失败，可稍后重试')
    }
  }, [taskId])

  useEffect(() => {
    alive.current = true
    const epoch = ++lifetime.current
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await refresh()
      if (active) timer = setTimeout(() => { void poll() }, POLL_INTERVAL)
    }
    if (typeof window !== 'undefined' && typeof window.electronAPI?.getTaskMedia === 'function') void poll()
    else setView({ capabilities: null, unavailableReason: '图片服务尚未配置，普通聊天仍可使用', assets: [], selectedReferenceIds: [], jobs: [], archived: false })
    return () => {
      alive.current = false
      active = false
      lifetime.current = epoch + 1
      if (timer) clearTimeout(timer)
    }
  }, [taskId, refresh])

  async function run(command: Command, execute: (api: ElectronAPI) => Promise<IpcCommandResult & { cancelled?: boolean }>): Promise<void> {
    if (commandBusy.current || !alive.current) return
    const epoch = lifetime.current
    commandBusy.current = true
    setPending(command)
    setNotice(null)
    try {
      const result = await execute(window.electronAPI)
      if (!alive.current || epoch !== lifetime.current) return
      if (!result.success) setNotice({ message: failure(result, command === 'video-import' ? '导入视频参考图失败' : '图片操作失败'), tone: 'error' })
      else if (command === 'export' && !result.cancelled) setNotice({ message: '图片已导出', tone: 'success' })
      if (command !== 'export') await refresh()
    } catch {
      if (alive.current && epoch === lifetime.current) {
        setNotice({ message: command === 'generate' || command === 'redo' ? '未收到操作结果，请查看任务记录；不要重复提交。' : command === 'video-import' ? '导入视频参考图失败，请稍后重试' : '图片操作失败，请稍后重试', tone: 'error' })
        if (command !== 'export') await refresh()
      }
    } finally {
      commandBusy.current = false
      if (alive.current && epoch === lifetime.current) setPending(null)
    }
  }

  const exportAsset = (asset: MediaAssetView) => { void run('export', api => api.exportMediaAsset({ taskId, assetId: asset.localAssetId })) }
  const jobAction = (job: MediaJobView, action: JobAction, cancelUpstream = false) => {
    void run(action, api => {
      const input = { taskId, jobId: job.jobId }
      switch (action) {
        case 'retry': return api.retryMediaSave(input)
        case 'cancel': return api.cancelMediaJob({ ...input, cancelUpstream })
        case 'resume': return api.resumeMediaTracking(input)
        case 'redo': return api.redoMediaJob(input)
      }
    })
  }
  const references = view?.assets.filter(asset => asset.taskId === taskId && asset.source === 'reference') || []
  const jobs = view?.jobs.filter(job => job.taskId === taskId) || []
  const outputs = new Map<string, MediaAssetView>()
  for (const asset of [...(view?.assets || []), ...jobs.flatMap(job => job.assets)]) {
    if (asset.taskId === taskId && asset.source === 'output') outputs.set(asset.localAssetId, asset)
  }
  const busy = pending !== null
  const feedback = { pending, notice }
  return <section className="artifact-section media-artifacts" aria-label="图片创作与成果">
    <h3><ImageIcon size={15} />图片创作与成果</h3>
    {error && <p className="media-notice media-tone-error" role="alert">{error}<button type="button" className="media-icon-button" title="重新读取图片任务" aria-label="重新读取图片任务" onClick={() => { void refresh() }}><RefreshCw size={14} /></button></p>}
    {!view && !error && <p className="artifact-empty" role="status">正在读取图片能力</p>}
    {!preview && !view?.capabilities?.tools.includes('media_generate_image') && <MediaCommandFeedback {...feedback} />}
    {view && <>
      {!view.capabilities?.tools.includes('media_generate_image') && <p className="media-notice">{view.unavailableReason || '图片能力尚未配置，普通聊天仍可使用'}</p>}
      <div className="media-subheading"><span>创作参考图</span><button type="button" className="media-command" disabled={busy || view.archived} onClick={() => { void run('import', api => api.importMediaReferences(taskId)) }}><ImagePlus size={14} />导入参考图</button></div>
      {references.length > 0 ? <MediaAssetGrid taskId={taskId} assets={references} references selected={view.selectedReferenceIds} disabled={busy || view.archived} onSelect={assetId => {
        const selected = new Set(view.selectedReferenceIds)
        if (selected.has(assetId)) selected.delete(assetId)
        else selected.add(assetId)
        void run('selection', api => api.setMediaReferenceSelection({ taskId, assetIds: [...selected] }))
      }} onPreview={setPreview} /> : <p className="artifact-empty">尚无参考图</p>}
      {!view.capabilities?.tools.includes('media_generate_image') && videoReferenceAvailable && <div className="media-subheading"><span>视频参考图</span><button type="button" className="media-command" disabled={busy || view.archived} onClick={() => { void run('video-import', api => api.importVideoReferences(taskId)) }}><ImagePlus size={14} />导入视频参考图</button></div>}
      {!!jobs.length && <><h4>图片任务</h4><MediaJobList jobs={jobs} archived={view.archived} busy={busy} onAction={jobAction} /></>}
      {outputs.size > 0 && <><h4>图片成果</h4><MediaAssetGrid taskId={taskId} assets={[...outputs.values()]} onPreview={setPreview} onExport={exportAsset} disabled={busy} /></>}
    </>}
    {preview && <MediaPreviewDialog key={preview.localAssetId} taskId={taskId} asset={preview} busy={busy} feedback={feedback} onClose={() => setPreview(null)} onExport={() => exportAsset(preview)} />}
  </section>
}

export function MediaArtifactsPanel({ taskId }: { taskId: string }) {
  return <><MediaTaskPanel key={taskId} taskId={taskId} /><VideoTaskPanel taskId={taskId} /></>
}
