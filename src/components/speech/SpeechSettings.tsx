import { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { speechInput } from '../../features/speech/speech-input'
import { resolveSpeechPermission } from '../../features/speech/speech-permission-state'
import { speechPermissionSchema, type SpeechPermission } from '../../shared/speech-contracts'
import { responseError, UserFeedbackError } from '../../shared/arrangement-feedback'
import { useFeedback } from '../feedback/FeedbackProvider'
import { useOperationFeedback } from '../feedback/use-operation-feedback'
import '../../styles/speech.css'

export function SpeechSettings() {
  const [permission, setPermission] = useState<SpeechPermission | null>(null)
  const [busy, setBusy] = useState(false)
  const feedback = useFeedback()
  const { capture } = useOperationFeedback()
  const permissionRevision = useRef(0)
  const consentAbort = useRef<AbortController | null>(null)
  useEffect(() => () => consentAbort.current?.abort(), [])
  const supported = typeof window !== 'undefined' && typeof window.electronAPI?.getSpeechPermission === 'function'
  useEffect(() => {
    if (!supported) return
    let mounted = true
    const revision = permissionRevision.current
    const notice = capture()
    void window.electronAPI.getSpeechPermission().then(response => {
      if (!mounted || !notice.isCurrent() || revision !== permissionRevision.current) return
      if (!response.success) throw responseError(response, 'speech')
      setPermission(speechPermissionSchema.parse(response.data?.permission))
    }).catch(error => { if (mounted) notice.fail(error, 'speech') })
    return () => { mounted = false }
  }, [supported, capture])

  if (!supported) return null
  const change = async (enabled: boolean): Promise<void> => {
    if (busy) return
    const revision = ++permissionRevision.current
    const previous = permission
    const notice = capture()
    const abort = new AbortController()
    consentAbort.current = abort
    if (!enabled) speechInput.cancel()
    setBusy(true)
    try {
      const consent = enabled && previous !== 'granted'
        ? await feedback.ask({ message: '允许使用麦克风进行语音输入？语音将在本机识别。', actionLabel: '允许', key: 'speech-consent', signal: abort.signal })
        : undefined
      if (!notice.isCurrent() || consent === false) return
      const response = await window.electronAPI.setSpeechEnabled({ enabled, ...(consent === undefined ? {} : { consent }) })
      if (!notice.isCurrent() || revision !== permissionRevision.current) return
      if (!response.success) throw responseError(response, 'speech')
      const next = resolveSpeechPermission(response, previous)
      setPermission(next)
      if (enabled && next !== 'granted') notice.show('语音输入未授权，请检查系统麦克风设置', 'warning')
    } catch (error) {
      if (notice.isCurrent()) setPermission(previous)
      notice.fail(error, 'speech')
    } finally {
      if (consentAbort.current === abort) consentAbort.current = null
      if (notice.isCurrent()) setBusy(false)
    }
  }
  const openSystemSettings = async (): Promise<void> => {
    if (busy) return
    const notice = capture()
    setBusy(true)
    try {
      const response = await window.electronAPI.openSpeechSystemSettings()
      if (!response.success) throw responseError(response, 'speech')
    } catch (error) {
      notice.fail(error instanceof UserFeedbackError ? error : new UserFeedbackError('无法打开系统麦克风设置，请手动打开系统隐私设置'), 'speech')
    } finally { if (notice.isCurrent()) setBusy(false) }
  }
  return <section className="speech-settings" aria-label="语音设置">
    <label><input type="checkbox" checked={permission === 'granted'} disabled={busy || permission === null} onChange={event => { void change(event.target.checked) }} />允许语音输入</label>
    <button type="button" className="speech-system-settings" disabled={busy} onClick={() => { void openSystemSettings() }}>
      <Settings size={15} aria-hidden />打开系统麦克风设置
    </button>
  </section>
}
