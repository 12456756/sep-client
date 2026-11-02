import { FolderOpen, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { responseError } from '../../shared/arrangement-feedback'

function labelForPath(path: string | null): string {
  if (!path) return '使用系统默认位置'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || path
}

export function DefaultWorkspaceSettings() {
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void window.electronAPI.getDefaultWorkspaceDirectory().then(result => {
      if (!mounted) return
      if (!result.success) throw responseError(result, 'settings')
      setPath(result.path ?? null)
    }).catch(cause => { if (mounted) setError(cause instanceof Error ? cause.message : '无法读取默认工作目录') })
      .finally(() => { if (mounted) setBusy(false) })
    return () => { mounted = false }
  }, [])

  const choose = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const selected = await window.electronAPI.selectDefaultWorkspaceDirectory()
      if (!selected.success || !selected.path) return
      setPath(selected.path)
      window.dispatchEvent(new CustomEvent('default-workspace-directory-changed', { detail: selected.path }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法保存默认工作目录')
    } finally { setBusy(false) }
  }

  const clear = async () => {
    if (busy || !path) return
    setBusy(true)
    setError(null)
    try {
      const saved = await window.electronAPI.clearDefaultWorkspaceDirectory()
      if (!saved.success) throw responseError(saved, 'settings')
      setPath(null)
      window.dispatchEvent(new CustomEvent('default-workspace-directory-changed', { detail: null }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法清除默认工作目录')
    } finally { setBusy(false) }
  }

  return <section className="ent-default-workspace-settings" aria-label="默认工作目录设置">
    <div className="ent-default-workspace-heading">
      <div><strong>默认工作目录</strong><span>每个任务会在此目录下创建独立文件夹</span></div>
      <div className="ent-default-workspace-actions">
        <button type="button" className="ent-btn" disabled={busy} onClick={() => { void choose() }} title={path || '选择默认工作目录'}>
          <FolderOpen size={15} aria-hidden />{labelForPath(path)}
        </button>
        {path ? <button type="button" className="ent-profile-close" disabled={busy} onClick={() => { void clear() }} aria-label="恢复系统默认工作目录" title="恢复系统默认"><RotateCcw size={14} aria-hidden /></button> : null}
      </div>
    </div>
    {path ? <small className="ent-default-workspace-path" title={path}>{path}</small> : null}
    {error ? <p className="ent-profile-error" role="alert">{error}</p> : null}
  </section>
}
