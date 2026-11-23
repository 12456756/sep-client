import { FolderPlus, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { responseError } from '../../shared/arrangement-feedback'
import type { LocalMediaSettings, LocalMediaSettingsAction } from '../../shared/local-media-settings'

export function LocalMediaTempSettings() {
  const [state, setState] = useState<LocalMediaSettings | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const lifetime = useRef<{ active: boolean } | null>(null)

  const change = useCallback(async (action: LocalMediaSettingsAction) => {
    const request = lifetime.current
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.localMediaSettings(action)
      if (!result.success) throw responseError(result, 'settings')
      if (request?.active && result.data) setState(result.data)
    } catch (cause) {
      if (request?.active) setError(cause instanceof Error ? cause.message : '无法操作音视频临时目录。')
    } finally { if (request?.active) setBusy(false) }
  }, [])

  useEffect(() => {
    const current = { active: true }
    lifetime.current = current
    void change('get')
    return () => { current.active = false }
  }, [change])

  if (state?.supported === false) return null
  return <section className="ent-default-workspace-settings ent-result-archive-settings" aria-label="音视频临时文件位置" aria-busy={busy}>
    <div className="ent-default-workspace-heading">
      <div><strong>音视频临时文件位置</strong><span>仅用于后续音视频任务的中间文件，不影响成品保存位置</span></div>
      <div className="ent-default-workspace-actions ent-result-archive-actions">
        <button type="button" className="ent-btn" disabled={busy || !state} onClick={() => void change('choose')}><FolderPlus size={15} aria-hidden />选择文件夹</button>
        {state?.custom ? <button type="button" className="ent-btn" disabled={busy} onClick={() => void change('use-default')}><RotateCcw size={15} aria-hidden />恢复默认</button> : null}
        {!state && error ? <button type="button" className="ent-btn" disabled={busy} onClick={() => void change('get')}><RotateCcw size={15} aria-hidden />重试</button> : null}
      </div>
    </div>
    {state ? <small className="ent-default-workspace-path" title={state.path}>{state.custom ? '' : '系统默认：'}{state.path}</small> : null}
    {error ? <p className="ent-profile-error" role="alert">{error}</p> : null}
  </section>
}
