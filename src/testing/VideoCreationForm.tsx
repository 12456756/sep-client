import { Film, ImagePlus, LoaderCircle } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { z } from 'zod'
import type { MediaAssetView } from '../shared/media'
import { mediaSaveLabels, selectMediaProfile, videoFormParameters } from '../shared/media-view'
import { videoGenerationInputSchema, type VideoGenerationInput } from '../shared/video-host'
import { videoAllowedAudioModes, type VideoRuntime } from '../shared/video-media'
import { useMediaParameterPreferences } from '../components/workspace/media-preference-scope'

type Command = 'import' | 'generate' | 'export' | 'resume' | 'retry'
type Notice = { message: string; tone: 'error' | 'success' }
const localId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const referenceSchema = z.object({
  localAssetId: localId, taskId: localId, jobId: localId.nullable(), outputId: localId.nullable(),
  source: z.literal('reference'), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  size: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  status: z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING']),
})

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

function VideoFeedback({ pending, notice, id }: { pending: Command | null; notice: Notice | null; id?: string }) {
  if (!pending && !notice) return null
  return <p id={id} className={`media-notice${notice ? ` media-tone-${notice.tone}` : ''}`} role={notice?.tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
    {notice?.message || <><LoaderCircle size={13} aria-hidden="true" />正在处理视频操作</>}
  </p>
}

/** Legacy manual submission fixture, not included in the production results panel. */
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
