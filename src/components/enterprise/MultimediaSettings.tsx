import { useEffect, useId, useState } from 'react'
import { Film, Image, RefreshCw } from 'lucide-react'
import type { Subscription } from '../../shared/types'
import type { MultimediaSettings as MultimediaSettingsData } from '../../shared/multimedia-settings'
import type { MediaProfile } from '../../shared/media'
import type { VideoRuntimeProfile } from '../../shared/video-media'
import { describeMediaParameters, mediaOperationLabel } from '../../features/enterprise/multimedia-settings'

type DirectoryState = { loading: boolean; employees: Subscription[]; error: string | null }
type CapabilityState = { subscriptionId: string; loading: boolean; data: MultimediaSettingsData | null; error: string | null }
const EMPTY_CAPABILITIES: CapabilityState = { subscriptionId: '', loading: false, data: null, error: null }

function bytesLabel(bytes: number): string { return `${Number((bytes / 1024 / 1024).toFixed(2))} MiB` }

function ProfileDetails({ profile, isDefault }: { profile: MediaProfile | VideoRuntimeProfile; isDefault: boolean }) {
  const parameters = describeMediaParameters(profile)
  const references = profile.referenceRules
  const legacyReferences = profile.kind === 'image' ? profile.adapter?.referenceSupport : profile.referenceSupport ?? {
    maxCount: profile.capabilities.maxReferenceCount, maxInputBytes: profile.capabilities.maxInputBytes, mimeTypes: [],
  }
  return <div className="ent-multimedia-details">
    <dl className="ent-multimedia-summary">
      <div><dt>模型</dt><dd>{profile.modelDisplayName || profile.modelId || '未提供'}{profile.modelId && profile.modelId !== profile.modelDisplayName ? <small>{profile.modelId}</small> : null}</dd></div>
      <div><dt>配置</dt><dd>{profile.displayName}{isDefault ? <span className="ent-multimedia-badge">默认</span> : null}<small>{profile.profileId} · 版本 {profile.configVersion}</small></dd></div>
      <div><dt>支持操作</dt><dd>{profile.operations.map(mediaOperationLabel).join('、') || '未声明'}</dd></div>
      <div><dt>处理方式</dt><dd>{profile.executionMode === 'async-query' ? '异步生成' : '同步返回'}</dd></div>
    </dl>
    <h4>参数</h4>
    {parameters.length ? <dl className="ent-multimedia-parameters">{parameters.map(parameter => <div key={parameter.key}>
      <dt>{parameter.label}<small>{parameter.key}</small></dt>
      <dd>{parameter.details.map((detail, index) => <span key={index}>{detail}</span>)}</dd>
    </div>)}</dl> : <p className="ent-multimedia-status">未提供参数详情</p>}
    <h4>参考图限制</h4>
    {references ? <dl className="ent-multimedia-parameters">{references.map(rule => <div key={rule.operation}>
      <dt>{mediaOperationLabel(rule.operation)}</dt><dd>{rule.maxCount === 0 ? <span>不接受参考图</span> : <>
        <span>数量：{rule.minCount}–{rule.maxCount} 张</span><span>单张上限：{bytesLabel(rule.maxInputBytes)}</span>
        <span>格式：{rule.mimeTypes.join('、') || '未声明'}</span>
      </>}</dd>
    </div>)}</dl> : legacyReferences ? <dl className="ent-multimedia-parameters"><div><dt>参考图</dt><dd>
      <span>最多 {legacyReferences.maxCount} 张</span><span>单张上限：{bytesLabel(legacyReferences.maxInputBytes)}</span>
      <span>格式：{legacyReferences.mimeTypes.join('、') || '未声明'}</span>
    </dd></div></dl> : <p className="ent-multimedia-status">未提供参考图限制</p>}
    {profile.constraints?.length ? <><h4>参数约束</h4><ul className="ent-multimedia-constraints">{profile.constraints.map((constraint, index) => <li key={index}>
      <span>{constraint.message}</span><small>{constraint.operations.map(mediaOperationLabel).join('、')} · {constraint.code}</small>
    </li>)}</ul></> : null}
  </div>
}

export function MultimediaSettings() {
  const id = useId()
  const [directory, setDirectory] = useState<DirectoryState>({ loading: true, employees: [], error: null })
  const [subscriptionId, setSubscriptionId] = useState('')
  const [revision, setRevision] = useState(0)
  const [capability, setCapability] = useState<CapabilityState>(EMPTY_CAPABILITIES)
  const [kind, setKind] = useState<'image' | 'video'>('image')
  const [profileId, setProfileId] = useState('')

  useEffect(() => {
    let cancelled = false
    setDirectory({ loading: true, employees: [], error: null })
    void (async () => {
      try {
        const result = await window.electronAPI.getSubscriptions()
        if (cancelled) return
        if (!result.success || !result.data) {
          setDirectory({ loading: false, employees: [], error: result.error?.message || '员工列表获取失败，请重试。' })
          return
        }
        const employees = result.data.filter(employee => employee.status === 'ACTIVE')
        setSubscriptionId(current => employees.some(employee => employee.subscriptionId === current) ? current : employees[0]?.subscriptionId ?? '')
        setDirectory({ loading: false, employees, error: null })
      } catch {
        if (!cancelled) setDirectory({ loading: false, employees: [], error: '员工列表获取失败，请重试。' })
      }
    })()
    return () => { cancelled = true }
  }, [revision])

  useEffect(() => {
    let cancelled = false
    if (directory.loading || !directory.employees.some(employee => employee.subscriptionId === subscriptionId)) {
      setCapability(EMPTY_CAPABILITIES)
      return
    }
    setCapability({ subscriptionId, loading: true, data: null, error: null })
    void (async () => {
      try {
        const result = await window.electronAPI.getMultimediaSettings({ subscriptionId })
        if (!cancelled) setCapability({ subscriptionId, loading: false, data: result.success ? result.data ?? null : null,
          error: result.success && result.data ? null : result.error?.message || '多媒体信息获取失败，请重试。' })
      } catch {
        if (!cancelled) setCapability({ subscriptionId, loading: false, data: null, error: '多媒体信息获取失败，请重试。' })
      }
    })()
    return () => { cancelled = true }
  }, [directory, subscriptionId])

  const loading = directory.loading || capability.loading || (Boolean(subscriptionId) && capability.subscriptionId !== subscriptionId && !directory.error)
  const data = !loading && capability.subscriptionId === subscriptionId ? capability.data : null
  const runtime = kind === 'image' ? data?.image : data?.video
  const profiles = runtime?.profiles ?? []
  const selected = profiles.find(profile => profile.profileId === profileId) ?? profiles.find(profile => profile.profileId === runtime?.defaultProfileId) ?? profiles[0]
  const error = directory.error || capability.error

  return <div className="ent-multimedia-settings">
    <div className="ent-multimedia-toolbar">
      <label htmlFor={`${id}-employee`}>硅基员工</label>
      <select id={`${id}-employee`} value={subscriptionId} disabled={directory.loading || !directory.employees.length} onChange={event => { setSubscriptionId(event.target.value); setProfileId('') }}>
        {!directory.employees.length ? <option value="">{directory.loading ? '正在加载' : '暂无可用员工'}</option> : directory.employees.map(employee => <option key={employee.subscriptionId} value={employee.subscriptionId}>{employee.name}</option>)}
      </select>
      <button type="button" className="ent-settings-icon" title="刷新多媒体信息" aria-label="刷新多媒体信息" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} className={loading ? 'ent-spin' : undefined} aria-hidden /></button>
    </div>
    <fieldset className="ent-multimedia-switch" aria-label="媒体类型">
      {(['image', 'video'] as const).map(value => { const Icon = value === 'image' ? Image : Film; return <label key={value} className={kind === value ? 'active' : undefined}>
        <input type="radio" name={`${id}-kind`} value={value} checked={kind === value} onChange={() => { setKind(value); setProfileId('') }} /><Icon size={16} aria-hidden /><span>{value === 'image' ? '图片' : '视频'}</span>
      </label> })}
    </fieldset>
    {error ? <p className="ent-profile-error" role="alert">{error}</p> : loading ? <p className="ent-multimedia-status" role="status">正在获取多媒体信息…</p> : !directory.employees.length ? <p className="ent-multimedia-status">暂无可用的硅基员工</p> : kind === 'image' && data?.imageError ? <p className="ent-profile-error" role="alert">{data.imageError}</p> : !selected ? <p className="ent-multimedia-status">该员工暂无可用的{kind === 'image' ? '图片' : '视频'}能力</p> : <>
      {profiles.length > 1 ? <div className="ent-multimedia-profile-select"><label htmlFor={`${id}-profile`}>模型配置</label><select id={`${id}-profile`} value={selected.profileId} onChange={event => setProfileId(event.target.value)}>{profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.displayName}{profile.profileId === runtime?.defaultProfileId ? '（默认）' : ''}</option>)}</select></div> : null}
      <ProfileDetails profile={selected} isDefault={selected.profileId === runtime?.defaultProfileId} />
    </>}
  </div>
}
