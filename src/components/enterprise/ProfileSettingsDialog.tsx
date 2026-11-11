import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, Camera, CircleUserRound, ImagePlus, Mic, RefreshCw, Search, Settings, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ClientProfile } from '../../shared/profile-wallet-contracts'
import type { UploadInput } from '../../shared/ipc'
import { EmployeeFace } from './EmployeeFace'
import { SpeechSettings } from '../speech/SpeechSettings'
import { DefaultModelSettings } from './DefaultModelSettings'
import { DefaultWorkspaceSettings } from './DefaultWorkspaceSettings'
import { getSettingsPages, type SettingsPageId, type SettingsSectionId } from '../../features/enterprise/settings-catalog'
import '../../styles/settings.css'

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
  models: readonly string[]
}

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

async function readImage(file: File): Promise<UploadInput> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  if (file.size === 0 || file.size > 2 * 1024 * 1024) throw new Error('图片大小必须大于 0 且不超过 2 MB。')
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, contentType: file.type }
}

export function ProfileSettingsDialog({
  profile, userName, canManage, uploading, error, onUploadAvatar, onUploadLogo, onRefresh, onClose, models,
}: Props) {
  const avatarInput = useRef<HTMLInputElement>(null)
  const logoInput = useRef<HTMLInputElement>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [logoFailed, setLogoFailed] = useState(false)
  const [activePage, setActivePage] = useState<SettingsPageId>('general')
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const returnFocus = useRef(typeof document === 'undefined' ? null : document.activeElement)
  const displayName = profile?.user.name || userName
  const speechSupported = typeof window !== 'undefined' && typeof window.electronAPI?.getSpeechPermission === 'function'
  const pages = getSettingsPages(canManage, speechSupported)
  const searching = query.trim().length > 0
  const matches = getSettingsPages(canManage, speechSupported, query)
  const currentPage = pages.find(page => page.id === activePage) ?? pages[0]
  const visiblePages = searching ? matches : currentPage ? [currentPage] : []
  const pageIcons = { general: Settings, account: CircleUserRound, voice: Mic }

  useEffect(() => setLogoFailed(false), [profile?.enterprise?.logo])
  useEffect(() => { content.current?.scrollTo(0, 0) }, [activePage, query])

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

  const refreshProfile = async () => {
    setRefreshing(true)
    try {
      setLocalError(null)
      await onRefresh()
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : '资料刷新失败，请重试')
    } finally { setRefreshing(false) }
  }

  const sections: Record<SettingsSectionId, ReactNode> = {
    models: <DefaultModelSettings models={models} />,
    workspace: <DefaultWorkspaceSettings />,
    profile: <>
      <div className="ent-settings-profile-row">
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
      </div>
      <div className="ent-settings-row">
        <div className="ent-settings-label"><strong>账号资料</strong><span>同步当前账号的最新资料</span></div>
        <button type="button" className="ent-btn" disabled={uploading !== null || refreshing} onClick={() => { void refreshProfile() }}>
          <RefreshCw size={15} className={refreshing ? 'ent-spin' : undefined} aria-hidden />{refreshing ? '正在刷新' : '刷新资料'}
        </button>
      </div>
    </>,
    enterprise: <div className="ent-profile-logo-row">
      <div className="ent-profile-logo-preview">
        {profile?.enterprise?.logo && !logoFailed ? <img src={profile.enterprise.logo} alt="企业 Logo" onError={() => setLogoFailed(true)} /> : <span>{profile?.enterprise?.name?.slice(0, 1) || '企'}</span>}
      </div>
      <div><strong>{profile?.enterprise?.name || '当前企业'}</strong><span>企业 Logo</span></div>
      <button type="button" className="ent-btn" disabled={uploading !== null} onClick={() => logoInput.current?.click()}>
        {uploading === 'logo' ? <RefreshCw size={15} className="ent-spin" aria-hidden /> : <ImagePlus size={15} aria-hidden />}
        更换 Logo
      </button>
      <input ref={logoInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void choose('logo', event.target.files?.[0]); event.target.value = '' }} />
    </div>,
    speech: <SpeechSettings />,
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Overlay className="ent-settings-backdrop" />
      <Dialog.Content className="ent-settings-layout" aria-describedby={undefined}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault()
            event.stopPropagation()
            searchInput.current?.focus()
          }
        }}
        onOpenAutoFocus={event => { event.preventDefault(); searchInput.current?.focus() }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const previous = returnFocus.current
          if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
          else document.querySelector<HTMLElement>('.ent-side-user')?.focus({ preventScroll: true })
        }}>
        <aside className="ent-settings-sidebar">
          <header className="ent-settings-sidebar-head">
            <button type="button" className="ent-settings-icon" onClick={onClose} aria-label="返回工作台" title="返回工作台"><ArrowLeft size={18} aria-hidden /></button>
            <Dialog.Title>设置</Dialog.Title>
          </header>
          <div className="ent-settings-search">
            <Search size={16} aria-hidden />
            <input ref={searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索设置" aria-label="搜索设置" />
            {query ? <button type="button" className="ent-settings-icon" onClick={() => { setQuery(''); searchInput.current?.focus() }} aria-label="清空搜索" title="清空搜索"><X size={14} aria-hidden /></button> : null}
          </div>
          <nav className="ent-settings-nav" aria-label="设置分类">
            {Array.from(new Set(pages.map(page => page.group))).map(group => <div key={group} className="ent-settings-nav-group">
              <span className="ent-settings-nav-label">{group}</span>
              {pages.filter(page => page.group === group).map(page => {
                const Icon = pageIcons[page.id]
                return <button key={page.id} type="button" className={`ent-settings-nav-item${!searching && currentPage?.id === page.id ? ' active' : ''}`} aria-current={!searching && currentPage?.id === page.id ? 'page' : undefined}
                  onClick={() => { setActivePage(page.id); setQuery('') }}>
                  <Icon size={17} strokeWidth={1.8} aria-hidden /><span>{page.title}</span>
                </button>
              })}
            </div>)}
          </nav>
        </aside>
        <button type="button" className="ent-settings-icon ent-settings-close" onClick={onClose} aria-label="关闭设置" title="关闭设置"><X size={20} aria-hidden /></button>
        <div ref={content} className="ent-settings-content" role="region" aria-labelledby="ent-settings-page-title" tabIndex={0}>
          <div className="ent-settings-reading">
            <h2 id="ent-settings-page-title">{searching ? '搜索结果' : currentPage?.title}</h2>
            {searching ? <p className="ent-settings-search-status" role="status">{matches.length ? `找到 ${matches.reduce((count, page) => count + page.sections.length, 0)} 组设置` : '没有找到匹配的设置，请尝试其他关键词。'}</p> : null}
            {localError || error ? <p className="ent-profile-error" role="alert">{localError || error}</p> : null}
            {visiblePages.map(page => <div key={page.id} className="ent-settings-page-sections">
              {page.sections.map(section => <section key={section.id} className="ent-settings-section" aria-labelledby={`settings-section-${section.id}`}>
                <h3 id={`settings-section-${section.id}`}>{searching ? `${page.title} / ${section.title}` : section.title}</h3>
                <div className="ent-settings-rows">{sections[section.id]}</div>
              </section>)}
            </div>)}
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}
