import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, Check, ChevronRight, Link, LoaderCircle, Paperclip, Plus, RefreshCw, Settings, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CONNECTOR_CATALOG } from '../../../features/enterprise/connector-catalog'
import type { ConnectorDefinition } from '../../../features/enterprise/connector-catalog'
import { useConnectors } from '../../../features/enterprise/use-connectors'
import { connectorPreparationText } from '../../../features/enterprise/connector-preparation'
import type { ConnectorId } from '../../../shared/connectors'
import { useAnchoredPopover } from '../use-anchored-popover'
import { GitHubConnectDialog } from '../GitHubConnectDialog'
import './composer-add-menu.css'

const ConnectorsPage = lazy(() => import('../../../pages/enterprise/ConnectorsPage').then(module => ({ default: module.ConnectorsPage })))

interface Props {
  disabled: boolean
  demo?: boolean
  selected?: ConnectorId
  onFile: () => void
  onSelect: (id: ConnectorId) => void
  onManage?: () => void
  children?: ReactNode
}

export function ComposerAddMenu({ disabled, demo = false, selected, onFile, onSelect, onManage, children }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'connectors'>('main')
  const [managing, setManaging] = useState(false)
  const [githubOpen, setGithubOpen] = useState(false)
  const { root, popover, position } = useAnchoredPopover(open, setOpen, true)
  const id = useId()
  const close = () => { setOpen(false); root.current?.querySelector('button')?.focus() }
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => { if (open) popover.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus() }, [open, view, popover])
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'ArrowLeft' && view === 'connectors') { event.preventDefault(); setView('main'); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(popover.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }
  return <div ref={root} className="sep-composer-add">
    <button type="button" className="sep-composer-add-trigger" aria-label="添加文件或连接器" title="添加文件或连接器" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => { setView('main'); setOpen(value => !value) }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setView('main'); setOpen(true) } }}><Plus size={22} aria-hidden /></button>
    {open ? createPortal(<div ref={popover} id={id} className="sep-composer-add-menu" role="menu" aria-label={view === 'main' ? '添加' : '选择连接器'} style={position} onKeyDown={navigate}>
      {view === 'main' ? <>
        <button type="button" role="menuitem" onClick={() => { close(); onFile() }}><Paperclip size={18} aria-hidden /><span>添加文件</span></button>
        <div role="separator" />
        <button type="button" role="menuitem" onClick={() => setView('connectors')} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); setView('connectors') } }}><Link size={18} aria-hidden /><span>连接器</span><ChevronRight size={15} aria-hidden /></button>
        {children}
      </> : <>
        <button type="button" role="menuitem" onClick={() => setView('main')}><ArrowLeft size={16} aria-hidden /><span>连接器</span></button>
        <div role="separator" />
        <ConnectorChoices demo={demo} selected={selected} onSelect={connectorId => { close(); onSelect(connectorId) }} onGitHubConnect={() => { close(); setGithubOpen(true) }} />
        <div role="separator" />
        <button type="button" role="menuitem" onClick={() => { close(); if (onManage) onManage(); else setManaging(true) }}><Settings size={16} aria-hidden /><span>管理连接器</span><ChevronRight size={15} aria-hidden /></button>
      </>}
    </div>, document.body) : null}
    {githubOpen ? <GitHubComposerConnect onClose={() => setGithubOpen(false)} restoreFocus={() => root.current?.querySelector('button')?.focus()} /> : null}
    <Dialog.Root open={managing} onOpenChange={setManaging}><Dialog.Portal><Dialog.Overlay className="sep-composer-connectors-overlay" /><Dialog.Content className="sep-composer-connectors-dialog" aria-describedby={undefined} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setManaging(false) } else if (event.key === 'Tab') event.stopPropagation() }} onCloseAutoFocus={event => { event.preventDefault(); root.current?.querySelector('button')?.focus() }}>
      <div className="sep-composer-connectors-heading"><Dialog.Title>管理连接器</Dialog.Title><Dialog.Close asChild><button type="button" aria-label="关闭连接器管理" title="关闭"><X size={18} aria-hidden /></button></Dialog.Close></div>
      {managing ? <Suspense fallback={<p role="status">加载中…</p>}><ConnectorsPage /></Suspense> : null}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>
}

function GitHubComposerConnect({ onClose, restoreFocus }: { onClose(): void; restoreFocus(): void }): React.JSX.Element {
  const connection = useConnectors('github')
  return <GitHubConnectDialog busy={connection.busy} error={connection.error} onConnect={connection.connect} onClose={onClose} restoreFocus={restoreFocus} />
}

function ConnectorChoices({ demo, selected, onSelect, onGitHubConnect }: Pick<Props, 'demo' | 'selected' | 'onSelect'> & { onGitHubConnect(): void }): React.JSX.Element {
  return <>{CONNECTOR_CATALOG.map(connector => <ConnectorChoice key={connector.id} connector={connector} demo={demo} selected={selected} onSelect={onSelect} onGitHubConnect={onGitHubConnect} />)}</>
}

function ConnectorChoice({ connector, demo, selected, onSelect, onGitHubConnect }: Pick<Props, 'demo' | 'selected' | 'onSelect'> & { connector: ConnectorDefinition; onGitHubConnect(): void }): React.JSX.Element {
  const connection = useConnectors(connector.id)
  const connected = !demo && connection.state.status === 'connected'
  const authorizing = !demo && connection.state.status === 'authorizing'
  const preparing = !demo && connection.state.status === 'preparing'
  const status = demo || !connection.available ? '仅限桌面客户端' : connection.loading ? '加载中' : connection.error ? '状态不可用' : connected ? '已连接' : preparing ? connectorPreparationText(connection.state) : authorizing ? '等待授权' : connection.state.status === 'error' ? '点击重试' : '点击连接'
  return <>
    <button type="button" role="menuitem" aria-label={`${connector.name}，${status}`} disabled={demo || !connection.available || connection.loading || connection.busy || preparing || authorizing || Boolean(connection.error)}
      onClick={() => { if (connected) onSelect(connector.id); else if (connector.id === 'github') onGitHubConnect(); else void connection.connect() }}>
      <img src={connector.logoUrl} alt="" /><span>{connector.name}<small>{status}</small></span>
      {connection.loading || connection.busy || preparing || authorizing ? <LoaderCircle size={15} className="spin" aria-hidden /> : connected && selected === connector.id ? <Check size={15} aria-hidden /> : null}
    </button>
    {connection.state.error ? <p role="alert">{connection.state.error}</p> : null}
    {connection.error ? <><p role="alert">{connection.error}</p><button type="button" role="menuitem" disabled={connection.busy || connection.loading} onClick={() => { void connection.refresh() }}><RefreshCw size={16} aria-hidden /><span>重试</span></button></> : null}
  </>
}
