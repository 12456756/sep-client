import { Camera, ImagePlus, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClientProfile } from '../../shared/profile-wallet-contracts'
import type { UploadInput } from '../../shared/ipc'
import { EmployeeFace } from './EmployeeFace'

interface Props {
  profile: ClientProfile | null
  userName: string
  canManage: boolean
  uploading: 'avatar' | 'logo' | null
  error: string | null
  onUploadAvatar: (input: UploadInput) => Promise<unknown>
  onUploadLogo: (input: UploadInput) => Promise<unknown>
  onRefresh: () => Promise<unknown>
  onClose: () => void
}

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

async function readImage(file: File): Promise<UploadInput> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  if (file.size === 0 || file.size > 2 * 1024 * 1024) throw new Error('图片大小必须大于 0 且不超过 2 MB。')
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, contentType: file.type }
}

export function ProfileSettingsDialog({
  profile, userName, canManage, uploading, error, onUploadAvatar, onUploadLogo, onRefresh, onClose,
}: Props) {
  const avatarInput = useRef<HTMLInputElement>(null)
  const logoInput = useRef<HTMLInputElement>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [logoFailed, setLogoFailed] = useState(false)
  const displayName = profile?.user.name || userName

  useEffect(() => setLogoFailed(false), [profile?.enterprise?.logo])

  const choose = async (kind: 'avatar' | 'logo', file: File | undefined) => {
    if (!file) return
    try {
      setLocalError(null)
      const input = await readImage(file)
      await (kind === 'avatar' ? onUploadAvatar(input) : onUploadLogo(input))
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : '图片上传失败')
    }
  }

  const refreshProfile = () => {
    void onRefresh().catch(() => undefined)
  }

  return (
    <div className="ent-profile-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="ent-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-settings-title">
        <header className="ent-profile-head">
          <div><span className="ent-top-breadcrumb">我的账号</span><h2 id="profile-settings-title">资料设置</h2></div>
          <button type="button" className="ent-profile-close" onClick={onClose} aria-label="关闭资料设置"><X size={17} aria-hidden /></button>
        </header>
        <div className="ent-profile-body">
          <div className="ent-profile-preview">
            <EmployeeFace employee={profile ? { name: displayName, avatar: profile.user.avatar } : null} name={displayName} size="xl" round />
            <div><strong>{displayName}</strong><span>{profile?.user.email || '当前登录账号'}</span></div>
          </div>
          <div className="ent-profile-actions">
            <button type="button" className="ent-btn" disabled={uploading !== null} onClick={() => avatarInput.current?.click()}>
              {uploading === 'avatar' ? <RefreshCw size={15} className="ent-spin" aria-hidden /> : <Camera size={15} aria-hidden />}
              更换头像
            </button>
            <input ref={avatarInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void choose('avatar', event.target.files?.[0]); event.target.value = '' }} />
          </div>
          {canManage ? (
            <div className="ent-profile-logo-row">
              <div className="ent-profile-logo-preview">
                {profile?.enterprise?.logo && !logoFailed ? <img src={profile.enterprise.logo} alt="企业 Logo" onError={() => setLogoFailed(true)} /> : <span>{profile?.enterprise?.name?.slice(0, 1) || '企'}</span>}
              </div>
              <div><strong>{profile?.enterprise?.name || '当前企业'}</strong><span>企业 Logo</span></div>
              <button type="button" className="ent-btn" disabled={uploading !== null} onClick={() => logoInput.current?.click()}>
                {uploading === 'logo' ? <RefreshCw size={15} className="ent-spin" aria-hidden /> : <ImagePlus size={15} aria-hidden />}
                更换 Logo
              </button>
              <input ref={logoInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void choose('logo', event.target.files?.[0]); event.target.value = '' }} />
            </div>
          ) : null}
          {localError || error ? <p className="ent-profile-error" role="alert">{localError || error}</p> : null}
          <button type="button" className="ent-profile-refresh" disabled={uploading !== null} onClick={refreshProfile}>
            <RefreshCw size={14} aria-hidden />刷新资料
          </button>
        </div>
      </section>
    </div>
  )
}
