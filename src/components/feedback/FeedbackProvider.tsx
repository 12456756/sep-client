import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, CheckCircle2, TriangleAlert } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { FeedbackController, type FeedbackItem } from '../../shared/feedback-controller'
import './feedback.css'

const FeedbackContext = createContext<FeedbackController | null>(null)

export function useFeedback(): FeedbackController {
  const controller = useContext(FeedbackContext)
  if (!controller) throw new Error('FeedbackProvider is required')
  return controller
}

function FeedbackDialog({ controller, item }: { controller: FeedbackController; item: FeedbackItem }) {
  const cancel = useRef<HTMLButtonElement>(null)
  const acknowledge = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    if (item.tone !== 'success') return
    const timer = window.setTimeout(() => controller.dismiss(item.id), 2000)
    return () => window.clearTimeout(timer)
  }, [controller, item.id, item.tone])
  useEffect(() => {
    if (item.tone !== 'confirm') acknowledge.current?.focus()
  }, [item.tone])
  const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? AlertCircle : TriangleAlert
  return <Dialog.Root open onOpenChange={open => { if (!open) controller.dismiss(item.id) }}>
    <Dialog.Portal>
      <Dialog.Overlay className="feedback-overlay" />
      <Dialog.Content className={`feedback-dialog feedback-${item.tone}`} onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (item.busy) event.preventDefault() }}
        onOpenAutoFocus={event => { event.preventDefault(); (cancel.current ?? acknowledge.current)?.focus() }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (controller.getSnapshot()) return
          const target = previousFocus.current
          if (target?.isConnected && !target.matches(':disabled')) target.focus()
          else document.querySelector<HTMLElement>('#login-email, .ent-side-user')?.focus()
        }}>
        <Icon className="feedback-status" size={24} aria-hidden />
        <div className="feedback-copy">
          <Dialog.Title className={item.title ? 'feedback-title' : 'feedback-sr-only'}>{item.title ?? (item.tone === 'success' ? '操作成功' : item.tone === 'confirm' ? '操作确认' : '提醒')}</Dialog.Title>
          <Dialog.Description className="feedback-description">{item.message}</Dialog.Description>
        </div>
        <footer className="feedback-actions">
          {item.tone === 'confirm' ? <>
            <button ref={cancel} type="button" disabled={item.busy} onClick={() => controller.dismiss(item.id)}>取消</button>
            <button type="button" className="feedback-primary" disabled={item.busy} onClick={() => void controller.accept(item.id)}>{item.busy ? item.busyLabel : item.actionLabel}</button>
          </> : <button ref={acknowledge} type="button" className="feedback-primary" onClick={() => controller.dismiss(item.id)}>{item.tone === 'success' ? '关闭' : '知道了'}</button>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new FeedbackController())
  const item = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => null)
  useEffect(() => () => controller.clear(), [controller])
  return <FeedbackContext.Provider value={controller}>{children}{item && <FeedbackDialog key={item.id} controller={controller} item={item} />}</FeedbackContext.Provider>
}
