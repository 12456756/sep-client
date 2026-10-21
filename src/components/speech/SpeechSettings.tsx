import { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import { speechPermissionSchema, type SpeechPermission } from '../../shared/speech-contracts'
import { speechInput } from '../../features/speech/speech-input'
import '../../styles/speech.css'

export function SpeechSettings() {
  const [permission, setPermission] = useState<SpeechPermission | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = typeof window !== 'undefined' && typeof window.electronAPI?.getSpeechPermission === 'function'
  useEffect(() => {
    if (!supported) return
    let mounted = true
    void window.electronAPI.getSpeechPermission().then(response => {
      if (!response.success) throw new Error(response.error?.message || '无法读取语音设置。')
      const value = speechPermissionSchema.parse(response.data?.permission)
      if (mounted) setPermission(value)
    }).catch(() => { if (mounted) setError('无法读取语音设置，请稍后重试。') })
    return () => { mounted = false }
  }, [supported])

  if (!supported) return null
  const change = async (enabled: boolean): Promise<void> => {
    if (busy) return
    const previous = permission
    if (!enabled) speechInput.cancel()
    setPermission(enabled ? 'granted' : 'denied')
    setBusy(true)
    setError(null)
    try {
      const response = await window.electronAPI.setSpeechEnabled({ enabled })
      if (!response.success) {
        setPermission(enabled ? previous : 'denied')
        setError(response.error?.message || '语音设置未能保存，请重试。')
        return
      }
      setPermission(speechPermissionSchema.parse(response.data?.permission))
    } catch {
      setPermission(enabled ? previous : 'denied')
      setError('语音设置未能保存，请重试。')
    }
    finally { setBusy(false) }
  }
  const openSystemSettings = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await window.electronAPI.openSpeechSystemSettings()
      if (!response.success) throw new Error('Settings unavailable')
    } catch { setError('无法打开系统麦克风设置，请手动打开系统隐私设置。') }
    finally { setBusy(false) }
  }
  return <section className="speech-settings" aria-label="语音设置">
    <label><input type="checkbox" checked={permission === 'granted'} disabled={busy || permission === null} onChange={event => { void change(event.target.checked) }} />允许语音输入</label>
    <button type="button" className="speech-system-settings" disabled={busy} onClick={() => { void openSystemSettings() }}>
      <Settings size={15} aria-hidden />打开系统麦克风设置
    </button>
    {error ? <p className="speech-feedback error" role="alert">{error}</p> : null}
  </section>
}
