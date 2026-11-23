import { useEffect, useState } from 'react'
import { windowClosePreferenceChanged } from '../../features/enterprise/window-close'
import { windowCloseBehavior, type WindowCloseBehavior } from '../../shared/window-close'

export function WindowCloseSettings() {
  const [behavior, setBehavior] = useState<WindowCloseBehavior | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener(windowClosePreferenceChanged, refresh)
    return () => window.removeEventListener(windowClosePreferenceChanged, refresh)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    const load = async () => {
      try {
        const result = await window.electronAPI.windowClose({ type: 'get' })
        if (!result.success || !result.data) throw new Error()
        if (active) setBehavior(result.data)
      } catch {
        if (active) {
          setBehavior(null)
          setError('无法读取关闭窗口设置。')
        }
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [revision])

  const change = async (value: string) => {
    const selection = windowCloseBehavior.safeParse(value)
    if (!selection.success || saving || loading || selection.data === behavior) return
    setSaving(true)
    setError(null)
    try {
      const result = await window.electronAPI.windowClose({ type: 'set', behavior: selection.data })
      if (!result.success || !result.data) throw new Error()
      setBehavior(result.data)
    } catch {
      setError('无法保存关闭窗口设置，请重试。')
    } finally { setSaving(false) }
  }

  return <div className="ent-default-model-settings">
    <div className="ent-default-model-label"><label htmlFor="client-close-behavior">点击关闭按钮时</label></div>
    {error && !behavior ? <button className="ent-btn" type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>重试</button> :
      <select id="client-close-behavior" value={behavior ?? ''} disabled={loading || saving} onChange={event => void change(event.target.value)}>
        {behavior === null && <option value="">正在读取…</option>}
        <option value="ask">每次询问</option>
        <option value="minimize">最小化</option>
        <option value="quit">直接退出</option>
      </select>}
    {error && <p className="ent-profile-error" role="alert">{error}</p>}
  </div>
}
