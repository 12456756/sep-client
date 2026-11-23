import { FolderOpen, FolderPlus, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { responseError } from '../../shared/arrangement-feedback'
import type { ResultArchiveSettings as ArchiveSettings } from '../../shared/result-files'

export function ResultArchiveSettings() {
  const [state, setState] = useState<ArchiveSettings | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const result = await window.electronAPI.resultArchiveSettings('get')
        if (!result.success) throw responseError(result, 'settings')
        if (active) setState(result.data ?? null)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '无法读取生成文件的保存位置。')
      } finally { if (active) setBusy(false) }
    })()
    return () => { active = false }
  }, [])

  const change = async (action: 'get' | 'choose' | 'use-default' | 'open') => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.resultArchiveSettings(action)
      if (!result.success) throw responseError(result, 'settings')
      if (result.data) setState(result.data)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法访问保存位置，请重试。') }
    finally { setBusy(false) }
  }

  const day = new Date().toLocaleDateString('sv-SE')
  const delimiter = state?.path.includes('\\') ? '\\' : '/'
  const example = ['任务名称-ab12cd34ef56', '报告.docx'].join(delimiter)
  return <section className="ent-default-workspace-settings ent-result-archive-settings" aria-label="自动保存生成的文件" aria-busy={busy}>
    <div className="ent-default-workspace-heading">
      <div><strong>自动保存生成的文件</strong><span>{state?.mode === 'off' ? '未开启' : state?.mode === 'system' ? '已开启 · 默认位置' : state ? '已开启 · 自定义位置' : busy ? '正在读取' : '暂不可用'}</span></div>
      <div className="ent-default-workspace-actions ent-result-archive-actions">
        <button type="button" className="ent-btn" disabled={busy} onClick={() => void change('choose')}><FolderPlus size={15} aria-hidden />选择文件夹</button>
        {state?.mode !== 'system' && state ? <button type="button" className="ent-btn" disabled={busy} title={state.defaultPath} onClick={() => void change('use-default')}><RotateCcw size={15} aria-hidden />{state.mode === 'off' ? '使用默认位置' : '恢复默认位置'}</button> : null}
        {state && state.mode !== 'off' ? <button type="button" className="ent-btn" disabled={busy || !state.available} onClick={() => void change('open')}><FolderOpen size={15} aria-hidden />打开文件夹</button> : null}
        {!state && error ? <button type="button" className="ent-btn" disabled={busy} onClick={() => void change('get')}><RotateCcw size={15} aria-hidden />重试</button> : null}
      </div>
    </div>
    {state ? <><small className="ent-default-workspace-path" title={state.path}>{state.mode === 'off' ? '默认保存位置：' : '保存位置：'}{state.path}</small>
      <small className="ent-default-workspace-path">保存示例：{[state.path.replace(/[\\/]$/, ''), day, example].join(delimiter)}</small></> : null}
    {state?.mode === 'custom' ? <small className="ent-default-workspace-path">默认保存位置：{state.defaultPath}</small> : null}
    {error || (state && state.mode !== 'off' && !state.available) ? <p className="ent-profile-error" role="alert">{error ?? '保存位置不可用，请重新连接或选择其他文件夹。'}</p> : null}
  </section>
}
