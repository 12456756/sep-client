import { Download, ImagePlus, Image as ImageIcon, LoaderCircle, Play, RefreshCw, RotateCcw, Square, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ElectronAPI, IpcCommandResult } from '../../shared/ipc'
import type { MediaAssetView, MediaGenerationInput, MediaJobView, MediaOperation, MediaPreview, MediaProfile, MediaTaskView } from '../../shared/media'
import { mediaGenerationLabels, mediaInputProblem, mediaJobActions, mediaSaveLabels, mediaTrackingLabels, selectMediaProfile } from '../../shared/media-view'
import { videoRuntimeSchema } from '../../shared/video-media'
import { VideoTaskPanel } from './VideoArtifactsPanel'
import { useMediaParameterPreferences } from './media-preference-scope'
import { imageRequestedSpecSchema, type ImageRequestedSpec, type MediaParameterSources } from '../../shared/media-spec-contract'


import { useOperationFeedback } from '../feedback/use-operation-feedback'
import { useFeedback } from '../feedback/FeedbackProvider'
import { operationFailure, responseError, feedbackMessage, type FeedbackOperation } from '../../shared/arrangement-feedback'
import { mediaIssueMessage, mediaSpecFailureMessage } from '../../shared/media-feedback'

type Command = 'import' | 'video-import' | 'selection' | 'generate' | 'export' | 'retry' | 'cancel' | 'resume' | 'redo'
type JobAction = Exclude<Command, 'import' | 'video-import' | 'selection' | 'generate' | 'export'>
type CommandFeedback = { pending: Command | null }
const POLL_INTERVAL = 3000
const IMAGE_SPEC_LABELS: Record<keyof ImageRequestedSpec, string> = { width: '宽度', height: '高度', aspectRatio: '比例', size: '尺寸', count: '数量', quality: '质量', outputFormat: '格式' }
function imageSpecSummary(spec: ImageRequestedSpec, sources?: MediaParameterSources): string {
  return Object.entries(spec).filter(([, value]) => value !== undefined).map(([field, value]) => {
    const source = sources?.[field as keyof MediaParameterSources]
    return `${IMAGE_SPEC_LABELS[field as keyof ImageRequestedSpec]} ${String(value)}${source ? `（${source === 'user' ? '用户指定' : source === 'model' ? '模型建议' : '上游决定'}）` : ''}`
  }).join('、') || '未指定，由模型协商或上游确认'
}

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

export function MediaCommandFeedback({ pending, id }: Partial<CommandFeedback> & { id?: string }) {
  if (!pending) return null
  return <p id={id} className="media-notice" role="status" aria-atomic="true"><LoaderCircle size={13} aria-hidden />正在处理图片操作</p>
}
function failure(result: IpcCommandResult, operation: FeedbackOperation): string {
  if (result.error?.code) { const specMessage = mediaSpecFailureMessage({ ...result.error, code: result.error.code }); if (specMessage) return specMessage }
  return responseError(result, operation).message
}

export function mediaTaskIssue(jobs: MediaJobView[]): string | null {
  for (const job of jobs) {
    const message = mediaIssueMessage(job, 'image')
    if (message) return message
  }
  return null
}

export function savedImageOutputCount(taskId: string, view: MediaTaskView | null, jobs: MediaJobView[], queryError = false): number | null {
  if (!view || queryError) return null
  const outputs = new Set<string>()
  for (const asset of [...view.assets, ...jobs.flatMap(job => job.assets)]) {
    if (asset.taskId === taskId && asset.source === 'output' && asset.status === 'SAVED') outputs.add(asset.localAssetId)
  }
  return outputs.size
}

function useAssetPreview(taskId: string, asset: MediaAssetView): { url: string | null; error: string | null; retry: () => void } {
  const { capture } = useOperationFeedback(`${taskId}:${asset.localAssetId}`)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    const notice = capture()
    const failed = (message: string) => {
      if (!active || !notice.isCurrent()) return
      setError(message)
      notice.show(message, 'error', `image-preview:${taskId}:${asset.localAssetId}:${attempt}`, true)
    }
    let objectUrl: string | null = null
    setUrl(null)
    setError(null)
    if (asset.status !== 'SAVED') return
    const load = async () => {
      try {
        const result = await window.electronAPI.previewMediaAsset({ taskId, assetId: asset.localAssetId })
        if (!active || !notice.isCurrent()) return
        if (!result.success || !result.data) {
          failed(failure(result, 'imagePreview'))
          return
        }
        const preview: MediaPreview = result.data
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(preview.bytes).buffer], { type: preview.mime }))
        setUrl(objectUrl)
      } catch {
        failed(operationFailure('imagePreview'))
      }
    }
    void load()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [taskId, asset.localAssetId, asset.status, attempt, capture])
  return { url, error, retry: () => setAttempt(value => value + 1) }
}

function AssetImage({ taskId, asset, large = false }: { taskId: string; asset: MediaAssetView; large?: boolean }) {
  const { capture } = useOperationFeedback(`${taskId}:${asset.localAssetId}`)
  const preview = useAssetPreview(taskId, asset)
  const [decodeError, setDecodeError] = useState(false)
  useEffect(() => setDecodeError(false), [preview.url])
  const error = preview.error || (decodeError ? operationFailure('imagePreview') : null)
  useEffect(() => { if (decodeError) capture().show(operationFailure('imagePreview'), 'error', `image-decode:${taskId}:${asset.localAssetId}`, true) }, [decodeError, capture, taskId, asset.localAssetId])
  return <div className={`media-image ${large ? 'media-image-large' : ''}`}>
    {preview.url && !error ? <img src={preview.url} alt={asset.source === 'reference' ? '商品参考图' : '图片成果'} onError={() => setDecodeError(true)} /> :
      <span className="media-image-placeholder"><ImageIcon size={20} /><span>{error ? '预览不可用' : (asset.status === 'SAVED' ? '读取图片' : mediaSaveLabels[asset.status].label)}</span></span>}
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
    <small>{asset.status === 'SAVED' ? '本地文件实测：' : ''}{asset.width} × {asset.height} · {asset.mime.replace('image/', '').toUpperCase()}</small>
    <small className={`media-tone-${mediaSaveLabels[asset.status].tone}`}>{mediaSaveLabels[asset.status].label}</small>
  </div>)}</div>
}

export function MediaCreationForm({ profiles, protocolVersion, defaultProfileId, references, archived, busy, onImport, onGenerate, taskId, onPreview, feedback }: {
  profiles: MediaProfile[]; references: MediaAssetView[]; archived: boolean; busy: boolean; taskId: string
  protocolVersion?: 1 | 3
  defaultProfileId?: string | null
  onImport: () => void; onGenerate: (input: MediaGenerationInput) => void; onPreview: (asset: MediaAssetView) => void
  feedback?: CommandFeedback
}) {
  const id = useId()
  const { capture } = useOperationFeedback(taskId)
  const [profileId, setProfileId] = useState('')
  const profile = selectMediaProfile(profiles, profileId, defaultProfileId)
  const [operation, setOperation] = useState<MediaOperation>('generate')
  const [selected, setSelected] = useState<string[]>([])
  const [brief, setBrief] = useState('')
  const preferences = useMediaParameterPreferences('image', profile?.profileId)
  const binding = JSON.stringify([preferences.key, profile, operation])
  const [choices, setChoices] = useState<{ binding: string; parameters: Partial<MediaGenerationInput['parameters']> }>({ binding: '', parameters: {} })
  const negotiated = protocolVersion === 3
  const parameters = profile ? choices.binding === binding ? choices.parameters : {} : null
  const selectedIds = selected.filter(assetId => references.some(asset => asset.localAssetId === assetId && asset.status === 'SAVED'))
  const problem = archived ? '任务已归档，只可查看已有成果' : profile && !parameters ? '当前配置没有可用的图片规格' : mediaInputProblem(profile, operation, selectedIds.length, brief, negotiated)
  useEffect(() => {
    setSelected([])
  }, [binding])
  useEffect(() => {
    if (profile && profileId !== profile.profileId) setProfileId(profile.profileId)
  }, [profile, profileId])
  function changeParameters(patch: Partial<MediaGenerationInput['parameters']>): void {
    if (!profile) return
    const next = { ...parameters, ...patch }
    setChoices({ binding, parameters: next ?? {} })
    if (next) preferences.save(next)
  }

  return <form className="media-creation" onSubmit={event => {
    event.preventDefault()
    if (busy) return
    if (!profile || !parameters || problem) { capture().show(problem || '图片生成配置不可用，请联系平台管理员', 'warning'); return }
    if (negotiated && !imageRequestedSpecSchema.safeParse(parameters).success) { capture().show('图片规格有冲突或格式错误，请检查填写内容。', 'warning'); return }
    onGenerate({ profileId: profile.profileId, operation, localAssetIds: selectedIds, creativeBrief: brief.trim(), parameters,
      ...(negotiated ? { protocolVersion: 3 as const, requestedSpec: parameters, specRevision: 1,
        parameterSources: Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined).map(([key]) => [key, 'user' as const])) } : {}),
    })
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
        <p className="media-notice">未填写的规格保持未指定，由模型协商或上游确认。</p>
        <button type="button" disabled={busy || archived} onClick={() => setChoices({ binding, parameters: preferences.parameters })}>复用上次规格</button>
        {(['aspectRatio', 'size', 'quality', 'outputFormat'] as const).map(field => <label key={field}>{({ aspectRatio: '比例', size: '尺寸', quality: '质量', outputFormat: '输出格式' })[field]}<input aria-label={`图片${field}`} value={parameters?.[field] ?? ''} disabled={busy || archived} onChange={event => changeParameters({ [field]: event.target.value || undefined })} /></label>)}
        <label>数量<input aria-label="图片数量" type="number" min={1} step={1} value={parameters?.count ?? ''} disabled={busy || archived} onChange={event => changeParameters({ count: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
    </div>
    <label htmlFor={`${id}-brief`}>创作需求</label>
    <textarea id={`${id}-brief`} rows={4} value={brief} disabled={busy || archived} placeholder="用途、画面要求、不可改变的商品特征" onChange={event => setBrief(event.target.value)} />
    <button type="submit" className="media-command media-primary" disabled={busy} aria-describedby={feedback?.pending ? `${id}-feedback` : undefined}>{busy ? <LoaderCircle size={14} /> : <ImagePlus size={14} />}{operation === 'edit' ? '提交图片编辑' : '提交图片生成'}</button>
    <MediaCommandFeedback {...feedback} id={`${id}-feedback`} />
  </form>
}

export function MediaJobList({ jobs, archived, busy, onAction }: { jobs: MediaJobView[]; archived: boolean; busy: boolean; onAction: (job: MediaJobView, action: JobAction, cancelUpstream?: boolean) => void }) {
  return <div className="media-jobs">{jobs.map(job => {
    const actions = mediaJobActions(job, archived)
    return <div className="media-job" key={job.jobId}>
      <div className="media-job-heading"><strong>{job.operation === 'edit' ? '图片编辑' : '图片生成'} · {job.parameters.count === undefined ? '数量未指定' : `${job.parameters.count} 张`}</strong><span>{job.parameters.aspectRatio ?? '比例未指定'}</span></div>
      {job.requestedSpec && <small>请求规格：{imageSpecSummary(job.requestedSpec, job.parameterSources)}</small>}
      {job.effectiveSpec && <small>报价规格：{imageSpecSummary(job.effectiveSpec)}</small>}
      {job.actualSpec && <small>实际规格（上游报告，尚未实测核验）：{imageSpecSummary(job.actualSpec)}</small>}
      {job.requestedSpec && !job.actualSpec && <small>实际规格尚未核验，请查看已保存文件的尺寸。</small>}
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

function MediaTaskPanel({ taskId, visible = true, onSummary }: { taskId: string; visible?: boolean; onSummary?: (summary: { outputs: number | null; error: string | null }) => void }) {
  const [view, setView] = useState<MediaTaskView | null>(null)
  const [videoReferenceAvailable, setVideoReferenceAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const feedbackController = useFeedback()
  const { capture } = useOperationFeedback(taskId)
  const seenIssues = useRef(new Set<string>())
  const queryFailure = useRef(false)
  const [pending, setPending] = useState<Command | null>(null)
  const [preview, setPreview] = useState<MediaAssetView | null>(null)
  const alive = useRef(false)
  const lifetime = useRef(0)
  const commandBusy = useRef(false)
  const requestVersion = useRef(0)

  const refresh = useCallback(async (refreshCapabilities = false): Promise<void> => {
    if (!alive.current) return
    const epoch = lifetime.current
    const version = ++requestVersion.current
    const notice = capture()
    try {
      const videoPromise = typeof window.electronAPI?.getTaskVideo === 'function' ? window.electronAPI.getTaskVideo(taskId).catch(() => null) : Promise.resolve(null)
      const [result, videoResult] = await Promise.all([window.electronAPI.getTaskMedia(taskId, { refreshCapabilities }), videoPromise])
      if (!alive.current || epoch !== lifetime.current || version !== requestVersion.current || !notice.isCurrent()) return
      setVideoReferenceAvailable(!!videoResult?.success && !!videoResult.data && canImportVideoReference(videoResult.data.runtime))
      if (result.success && result.data) {
        setView(result.data)
        setError(null)
        queryFailure.current = false
        for (const job of result.data.jobs) {
          const message = mediaIssueMessage(job, 'image')
          const key = `${job.jobId}:${message}`
          if (message && !seenIssues.current.has(key)) { seenIssues.current.add(key); notice.show(message, 'error', `image-job:${taskId}:${key}`, true) }
        }
      } else {
        const message = failure(result, 'imageRead'); setError(message)
        if (!queryFailure.current) { queryFailure.current = true; notice.show(message) }
      }
    } catch {
      if (alive.current && epoch === lifetime.current && version === requestVersion.current && notice.isCurrent()) {
        setError(operationFailure('imageRead'))
        if (!queryFailure.current) { queryFailure.current = true; notice.show(operationFailure('imageRead')) }
      }
    }
  }, [taskId, capture])

  useEffect(() => {
    alive.current = true
    const epoch = ++lifetime.current
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (refreshCapabilities = false) => {
      await refresh(refreshCapabilities)
      if (active) timer = setTimeout(() => { void poll() }, POLL_INTERVAL)
    }
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(true) }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    if (typeof window !== 'undefined' && typeof window.electronAPI?.getTaskMedia === 'function') void poll(true)
    else setView({ capabilities: null, unavailableReason: '图片服务尚未配置，普通聊天仍可使用', assets: [], selectedReferenceIds: [], jobs: [], archived: false })
    return () => {
      alive.current = false
      active = false
      lifetime.current = epoch + 1
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [taskId, refresh])

  async function run(command: Command, execute: (api: ElectronAPI) => Promise<IpcCommandResult & { cancelled?: boolean }>, quiet = false): Promise<{ success: boolean; message?: string }> {
    if (commandBusy.current || !alive.current) return { success: false }
    const epoch = lifetime.current
    commandBusy.current = true
    setPending(command)
    const notice = capture()
    const operation: FeedbackOperation = ({ import: 'imageImport', 'video-import': 'videoImport', selection: 'imageSelection', generate: 'imageGenerate', export: 'imageExport', retry: 'imageSave', cancel: 'imageCancel', resume: 'imageResume', redo: 'imageGenerate' } as const)[command]
    try {
      const result = await execute(window.electronAPI)
      if (!alive.current || epoch !== lifetime.current || !notice.isCurrent()) return { success: false }
      const message = result.success ? undefined : failure(result, operation)
      if (message && !quiet) notice.show(message)
      else if (result.success && command === 'export' && !result.cancelled) notice.show('图片已导出', 'success')
      if (command !== 'export') await refresh()
      return { success: result.success, message }
    } catch {
      if (alive.current && epoch === lifetime.current && notice.isCurrent()) {
        const message = command === 'generate' || command === 'redo' ? '图片提交结果尚未确认，请查看原任务，勿重复提交' : operationFailure(operation)
        if (!quiet) notice.show(message)
        if (command !== 'export') await refresh()
        return { success: false, message }
      }
      return { success: false }
    } finally {
      commandBusy.current = false
      if (alive.current && epoch === lifetime.current) setPending(null)
    }
  }

  const exportAsset = (asset: MediaAssetView) => { void run('export', api => api.exportMediaAsset({ taskId, assetId: asset.localAssetId })) }
  const jobAction = (job: MediaJobView, action: JobAction, cancelUpstream = false) => {
    const notice = capture()
    const execute = (api: ElectronAPI) => {
      const input = { taskId, jobId: job.jobId }
      switch (action) {
        case 'retry': return api.retryMediaSave(input)
        case 'cancel': return api.cancelMediaJob({ ...input, cancelUpstream })
        case 'resume': return api.resumeMediaTracking(input)
        case 'redo': return api.redoMediaJob(input)
      }
    }
    if (action !== 'cancel' && action !== 'redo') { void run(action, execute); return }
    const message = action === 'redo' ? '确认重新生成图片？本次将创建新任务，可能产生费用。' : cancelUpstream ? '确认请求平台取消此任务？取消结果以平台返回为准，不代表退款。' : '确认停止本地跟踪？平台任务可能继续生成和计费。'
    void feedbackController.confirm({ key: `image-action:${taskId}:${job.jobId}:${action}:${cancelUpstream}`, message,
      actionLabel: action === 'redo' ? '重新生成' : cancelUpstream ? '请求取消' : '停止跟踪', busyLabel: '正在处理',
      onConfirm: async () => {
        if (!notice.isCurrent()) return { success: false }
        try { return await run(action, execute, true) }
        catch (cause) { return { success: false, message: feedbackMessage(cause, action === 'redo' ? 'imageGenerate' : 'imageCancel') } }
      } })
  }
  const references = view?.assets.filter(asset => asset.taskId === taskId && asset.source === 'reference') || []
  const jobs = view?.jobs.filter(job => job.taskId === taskId) || []
  const outputs = new Map<string, MediaAssetView>()
  for (const asset of [...(view?.assets || []), ...jobs.flatMap(job => job.assets)]) {
    if (asset.taskId === taskId && asset.source === 'output' && asset.status === 'SAVED') outputs.set(asset.localAssetId, asset)
  }
  const outputCount = savedImageOutputCount(taskId, view, jobs, Boolean(error))
  const taskIssue = mediaTaskIssue(jobs)
  const summaryError = error || taskIssue
  useEffect(() => { onSummary?.({ outputs: outputCount, error: summaryError }) }, [onSummary, outputCount, summaryError])
  const busy = pending !== null
  const feedback = { pending }
  if (!visible) return null
  return <section className="artifact-section media-artifacts" aria-label="图片创作与成果" hidden={!visible}>
    <h3><ImageIcon size={15} />图片创作与成果<button type="button" className="media-icon-button" title="刷新图片能力与任务" aria-label="刷新图片能力与任务" onClick={() => { void refresh(true) }}><RefreshCw size={14} /></button></h3>
    {!view && !error && <p className="artifact-empty" role="status">正在读取图片能力</p>}
    {!preview && !view?.capabilities?.tools.includes('media_generate_image') && <MediaCommandFeedback {...feedback} />}
    {view && <>
      {!view.capabilities?.tools.includes('media_generate_image') && <p className="media-notice">图片生成配置不可用</p>}
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

export function MediaArtifactsPanel({ taskId, visible = true, onSummary }: { taskId: string; visible?: boolean; onSummary?: (summary: { images: number | null; videos: number | null; error: string | null }) => void }) {
  const [imageSummary, setImageSummary] = useState<{ outputs: number | null; error: string | null }>({ outputs: null, error: null })
  const [videoSummary, setVideoSummary] = useState<{ outputs: number | null; error: string | null }>({ outputs: null, error: null })
  const imageCount = imageSummary.outputs
  const videoCount = videoSummary.outputs
  const mediaError = imageSummary.error || videoSummary.error
  useEffect(() => { onSummary?.({ images: imageCount, videos: videoCount, error: mediaError }) }, [imageCount, mediaError, onSummary, videoCount])
  const onImageSummary = useCallback((summary: { outputs: number | null; error: string | null }) => setImageSummary(summary), [])
  return <><MediaTaskPanel key={taskId} taskId={taskId} visible={visible} onSummary={onImageSummary} /><VideoTaskPanel taskId={taskId} visible={visible} onSummary={setVideoSummary} /></>
}
