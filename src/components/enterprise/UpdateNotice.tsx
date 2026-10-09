import * as Dialog from '@radix-ui/react-dialog'
import { ArrowDownToLine, CircleAlert, RefreshCw, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { UpdateModel } from '../../features/update/use-update'
import type { UpdateState } from '../../shared/ipc'
import { readUpdateTaskStatus } from './update-restart'
import type { UpdateTaskStatus } from './update-restart'

interface Props {
  update: UpdateModel
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenWorkRecords: () => void
}

function noticeLabel(state: UpdateState | null): string {
  if (!state) return '客户端更新'
  switch (state.status) {
    case 'available': return '有新版本'
    case 'downloading': return `下载中 ${Math.floor(state.percent)}%`
    case 'downloaded': return '重启更新'
    case 'checking': return '检查更新中'
    case 'error': return '更新失败'
    default: return '客户端更新'
  }
}

function bytes(value: number): string {
  if (value < 1024) return `${Math.floor(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function retryLabel(state: UpdateState): string {
  if (state.status !== 'error') return '检查更新'
  return state.operation === 'download' ? '重试下载'
    : '重新检查'
}

export function UpdateDetails({ update, onRestart, onClose }: {
  update: UpdateModel
  onRestart: () => void
  onClose: () => void
}) {
  const { state, pending, error, release } = update
  const busy = pending !== null
  const version = state && 'version' in state ? state.version : null
  const notes = state?.status === 'available' ? state.releaseNotes
    : release?.version === version ? release.releaseNotes : []
  const date = state?.status === 'available' ? state.releaseDate
    : release?.version === version ? release.releaseDate : null
  const retry = () => {
    if (state?.status !== 'error') return
    if (state.operation === 'download') void update.download()
    else void update.check()
  }

  return <>
    <p className="ent-update-version">当前版本 <strong>{state?.currentVersion ?? '正在读取…'}</strong></p>
    <div className="ent-update-status" role="status" aria-live="polite">
      {!state && <p>正在读取更新状态…</p>}
      {state?.status === 'idle' && <p>检查是否有可用的新版本。</p>}
      {state?.status === 'checking' && <p>正在检查新版本…</p>}
      {state?.status === 'not-available' && <p>当前已是最新版本。</p>}
      {version && <p><strong>新版本 {version}</strong></p>}
      {state?.status === 'available' && <p>新版本已准备好，下载时可以继续工作。</p>}
      {state?.status === 'downloaded' && <p>下载完成。确认后将关闭客户端，安装更新并重新打开。</p>}
    </div>
    {state?.status === 'downloading' && <div className="ent-update-progress">
      <div><span>正在下载</span><strong>{Math.floor(state.percent)}%</strong></div>
      <progress max={100} value={state.percent} aria-label={`新版本 ${state.version} 下载进度`} />
      <p>{bytes(state.transferred)} / {state.total > 0 ? bytes(state.total) : '计算中'} · {bytes(state.bytesPerSecond)}/秒</p>
      {state.percent >= 100 && <p>正在校验更新文件，请稍候…</p>}
    </div>}
    {version && <section className="ent-update-notes" aria-label="更新说明">
      <h3>更新说明</h3>
      {date && <time dateTime={date}>{new Date(date).toLocaleDateString('zh-CN')}</time>}
      {notes.length ? <ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : <p>此版本未提供更新说明。</p>}
    </section>}
    {(error || state?.status === 'error') && <p className="ent-update-error" role="alert">
      <CircleAlert size={15} aria-hidden />{error || (state?.status === 'error' ? state.message : '')}
    </p>}
    {pending && <p className="ent-update-hint" role="status">{
      pending === 'install' ? '正在准备重启…' : pending === 'cancel' ? '正在取消下载…'
        : pending === 'download' ? '正在下载更新…' : '正在检查更新…'
    }</p>}
    <footer className="ent-update-actions">
      {state?.status === 'available' && <button type="button" className="ent-btn primary" disabled={busy} onClick={() => void update.download()}>
        <ArrowDownToLine size={14} aria-hidden />下载更新
      </button>}
      {state?.status === 'downloading' && <button type="button" className="ent-btn" disabled={pending === 'cancel' || pending === 'install'} onClick={() => void update.cancel()}>取消下载</button>}
      {state?.status === 'downloaded' && <button type="button" className="ent-btn primary" disabled={busy} onClick={onRestart}>
        <RotateCw size={14} aria-hidden />重启并安装
      </button>}
      {state?.status === 'error' && state.retryable && <button type="button" className="ent-btn primary" disabled={busy} onClick={retry}>{retryLabel(state)}</button>}
      {(!state || state.status === 'idle' || state.status === 'not-available' || state.status === 'available'
        || (state.status === 'error' && state.operation === 'download' && state.retryable)) && <button type="button" className="ent-btn" disabled={busy} onClick={() => void update.check()}>检查更新</button>}
      <button type="button" className="ent-btn ghost" onClick={onClose}>{version ? '稍后更新' : '关闭'}</button>
    </footer>
  </>
}

export function UpdateRestartDetails({ tasks, installing, onConfirm, onRetry, onClose, onOpenWorkRecords }: {
  tasks: UpdateTaskStatus
  installing: boolean
  onConfirm: () => void
  onRetry: () => void
  onClose: () => void
  onOpenWorkRecords: () => void
}) {
  return <>
    {tasks.status === 'checking' && <p role="status">正在检查活动任务…</p>}
    {tasks.status === 'ready' && <p>当前没有运行、排队或待审批的任务。请保存正在编辑的内容，再确认重启。</p>}
    {tasks.status === 'blocked' && <div role="status">
      <p>还有活动任务，请处理完成后再安装更新。</p>
      <p>运行中 {tasks.running} · 排队中 {tasks.pending} · 待审批 {tasks.waitingApproval}</p>
    </div>}
    {tasks.status === 'error' && <p className="ent-update-error" role="alert">无法确认任务状态，请重新检查后再安装。</p>}
    <div className="ent-update-actions">
      <button type="button" className="ent-btn ghost" disabled={installing} onClick={onClose}>稍后更新</button>
      {tasks.status === 'blocked' && <button type="button" className="ent-btn" disabled={installing} onClick={onOpenWorkRecords}>查看工作记录</button>}
      {(tasks.status === 'blocked' || tasks.status === 'error') && <button type="button" className="ent-btn" disabled={installing} onClick={onRetry}>重新检查任务</button>}
      <button type="button" className="ent-btn primary" disabled={installing || tasks.status !== 'ready'} onClick={onConfirm}>
        {installing ? '正在准备重启…' : '确认重启并安装'}
      </button>
    </div>
  </>
}

export function UpdateNotice({ update, open, onOpenChange, onOpenWorkRecords }: Props) {
  const [restartOpen, setRestartOpen] = useState(false)
  const [tasks, setTasks] = useState<UpdateTaskStatus>({ status: 'checking' })
  const [taskRevision, setTaskRevision] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const confirmationLock = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  const lifetime = useRef(0)
  const { state, pending } = update
  const installable = state?.status === 'downloaded'
  const label = noticeLabel(state)
  const noticed = state?.status === 'available' || state?.status === 'downloading' || state?.status === 'downloaded' || state?.status === 'error' || update.error !== null

  useEffect(() => {
    if (!restartOpen || !open || !installable) return
    let active = true
    void readUpdateTaskStatus(window.electronAPI).then(result => { if (active) setTasks(result) })
    return () => { active = false }
  }, [restartOpen, open, installable, taskRevision])

  useEffect(() => {
    const owner = ++lifetime.current
    return () => { lifetime.current = owner + 1 }
  }, [])

  const openRestart = () => { setTasks({ status: 'checking' }); setRestartOpen(true) }
  const retryTasks = () => { setTasks({ status: 'checking' }); setTaskRevision(value => value + 1) }
  const close = () => { setRestartOpen(false); onOpenChange(false) }
  const confirm = async () => {
    if (confirmationLock.current || tasks.status !== 'ready' || !installable || pending !== null) return
    confirmationLock.current = true
    setPreparing(true)
    const owner = lifetime.current
    let attemptedInstall = false
    try {
      const currentTasks = await readUpdateTaskStatus(window.electronAPI)
      if (lifetime.current !== owner) return
      setTasks(currentTasks)
      if (currentTasks.status === 'ready') { attemptedInstall = true; await update.install() }
    } finally {
      confirmationLock.current = false
      if (lifetime.current === owner) {
        setPreparing(false)
        // A task may have started between the UI check and main's final check.
        if (attemptedInstall) retryTasks()
      }
    }
  }

  return <Dialog.Root open={open} onOpenChange={value => { if (!value) setRestartOpen(false); onOpenChange(value) }} modal={false}>
    <Dialog.Trigger asChild>
      <button type="button" className={`ent-update-entry${noticed ? ' has-update' : ''}`} aria-label={`${label}，打开更新面板`} title={label}>
        {state?.status === 'checking' || state?.status === 'downloading' ? <RefreshCw size={15} className="ent-spin" aria-hidden />
          : state?.status === 'error' ? <CircleAlert size={15} aria-hidden /> : <ArrowDownToLine size={15} aria-hidden />}
        <span>{label}</span>
      </button>
    </Dialog.Trigger>
    <Dialog.Content ref={panel} className="ent-update-panel" onInteractOutside={event => { if (restartOpen) event.preventDefault() }}>
      <header className="ent-update-head">
        <Dialog.Title>客户端更新</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="ent-top-icon" aria-label="关闭更新面板"><X size={15} aria-hidden /></button></Dialog.Close>
      </header>
      <Dialog.Description className="ent-update-hint">客户端版本与更新状态</Dialog.Description>
      <UpdateDetails update={update} onRestart={openRestart} onClose={close} />
      <Dialog.Root open={restartOpen && installable} onOpenChange={value => { if (!preparing && pending !== 'install') setRestartOpen(value) }}>
        <Dialog.Overlay className="ent-update-overlay" />
        <Dialog.Content className="ent-update-confirm" onCloseAutoFocus={event => {
          event.preventDefault()
          panel.current?.focus()
        }} onOpenAutoFocus={event => {
          // Focus the safe defer action instead of the restart button.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          content.querySelector<HTMLButtonElement>('button')?.focus()
        }}>
          <Dialog.Title>重启并安装更新？</Dialog.Title>
          <Dialog.Description>客户端将关闭，安装完成后自动重新打开。</Dialog.Description>
          {update.error && <p className="ent-update-error" role="alert">{update.error}</p>}
          <UpdateRestartDetails tasks={tasks} installing={preparing || pending === 'install'} onConfirm={() => void confirm()}
            onRetry={retryTasks} onClose={() => setRestartOpen(false)} onOpenWorkRecords={() => { close(); onOpenWorkRecords() }} />
        </Dialog.Content>
      </Dialog.Root>
    </Dialog.Content>
  </Dialog.Root>
}
