import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, CheckCircle2, ListChecks, TriangleAlert, X } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { FeedbackController, isFeedbackConfirmationBlocked, type FeedbackItem } from '../../shared/feedback-controller'

const FeedbackContext = createContext<FeedbackController | null>(null)

export function useOptionalFeedback(): FeedbackController | null {
  return useContext(FeedbackContext)
}

export function useFeedback(): FeedbackController {
  const controller = useContext(FeedbackContext)
  if (!controller) throw new Error('FeedbackProvider is required')
  return controller
}

function FeedbackReview({ item, review }: { item: FeedbackItem; review: NonNullable<FeedbackItem['review']> }) {
  const factsId = useId()
  const detailsId = useId()
  return <>
    <header className="feedback-review-header">
      <span className="feedback-review-icon"><ListChecks size={19} aria-hidden /></span>
      <div>
        <Dialog.Title className="feedback-title">{item.title}</Dialog.Title>
        <Dialog.Description className="feedback-review-subject">{item.message}</Dialog.Description>
      </div>
    </header>
    <div className="feedback-review-body">
      <section className="feedback-review-facts" aria-labelledby={factsId} tabIndex={0}>
        <h3 id={factsId}>{review.factsTitle}</h3>
        <dl>{review.facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>
      <section className="feedback-review-details" aria-labelledby={detailsId} tabIndex={0}>
        <h3 id={detailsId}>{review.detailsTitle}</h3>
        {review.sections.map(section => <div className="feedback-review-section" key={section.title}>
          <h4>{section.title}</h4>
          <p>{section.text}</p>
        </div>)}
      </section>
    </div>
  </>
}

function FeedbackDialog({ controller, item }: { controller: FeedbackController; item: FeedbackItem }) {
  const content = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const acknowledge = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [host] = useState(() => Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter(dialog => dialog.matches(':modal')).at(-1))
  useLayoutEffect(() => {
    if (!host) return
    host.dataset.feedbackHost = 'true'
    return () => { delete host.dataset.feedbackHost }
  }, [host])
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const [focusFallbacks] = useState(() => {
    const list = previousFocus.current?.closest<HTMLElement>('.ent-work-list')
    if (!list) return []
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.ent-work-row'))
    const row = previousFocus.current?.closest('.ent-work-row-wrap')?.querySelector('.ent-work-row')
    const index = rows.findIndex(element => element === row)
    return [...rows.slice(index + 1), ...rows.slice(0, Math.max(0, index)).reverse(), list]
  })
  useEffect(() => {
    if (item.tone !== 'success') return
    const timer = window.setTimeout(() => controller.dismiss(item.id), 2000)
    return () => window.clearTimeout(timer)
  }, [controller, item.id, item.tone])
  useEffect(() => {
    if (item.tone !== 'confirm') acknowledge.current?.focus()
  }, [item.tone])
  const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? AlertCircle : TriangleAlert
  const confirmDisabled = isFeedbackConfirmationBlocked(item)
  return <Dialog.Root open onOpenChange={open => { if (!open) controller.dismiss(item.id) }}>
    <Dialog.Portal container={host}>
      <Dialog.Overlay className="feedback-overlay" />
      <Dialog.Content ref={content} className={`feedback-dialog feedback-${item.tone}${item.review ? ' feedback-review' : ''}`} onInteractOutside={event => event.preventDefault()}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
        onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); if (!item.busy) controller.dismiss(item.id) }}
        onOpenAutoFocus={event => {
          event.preventDefault()
          if (item.review) content.current?.focus({ preventScroll: true })
          else (cancel.current ?? acknowledge.current ?? input.current)?.focus()
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (controller.getSnapshot()) return
          const target = [previousFocus.current, ...focusFallbacks].find(element => element?.isConnected && !element.matches(':disabled'))
          if (target) target.focus({ preventScroll: true })
          else document.querySelector<HTMLElement>('#login-email, .ent-side-user')?.focus()
        }}>
        {item.tone === 'confirm' && item.cancelPlacement === 'corner' &&
          <button ref={cancel} type="button" className="feedback-corner-close" aria-label="关闭弹窗" title="关闭弹窗"
            disabled={item.busy} onClick={() => controller.dismiss(item.id)}><X size={16} aria-hidden /></button>}
        {item.review ? <FeedbackReview item={item} review={item.review} /> : <>
          <Icon className="feedback-status" size={24} aria-hidden />
          <div className="feedback-copy">
            <Dialog.Title className={item.title ? 'feedback-title' : 'feedback-sr-only'}>{item.title ?? (item.tone === 'success' ? '操作成功' : item.tone === 'confirm' ? '操作确认' : '提醒')}</Dialog.Title>
            <Dialog.Description className="feedback-description">{item.message}</Dialog.Description>
            {item.input && <label className="feedback-field">{item.input.label}<input ref={input} value={item.input.value} maxLength={item.input.maxLength} placeholder={item.input.placeholder} disabled={item.busy}
              aria-invalid={Boolean(item.validationMessage)} aria-describedby={item.validationMessage ? 'feedback-validation' : undefined}
              onChange={event => controller.setInput(item.id, event.target.value)} /></label>}
            {item.validationMessage && <p id="feedback-validation" className="feedback-validation" role="alert">{item.validationMessage}</p>}
            {item.checkbox && <label className="feedback-checkbox"><input type="checkbox" checked={item.checkbox.checked} required={item.checkboxRequired} disabled={item.busy}
              onChange={event => controller.setChecked(item.id, event.target.checked)} />{item.checkbox.label}</label>}
          </div>
        </>}
        <footer className="feedback-actions">
          {item.tone === 'confirm' ? <>
            {item.cancelPlacement !== 'corner' &&
              <button ref={cancel} type="button" className="feedback-cancel" disabled={item.busy} onClick={() => controller.dismiss(item.id)}>{item.cancelLabel ?? '取消'}</button>}
            {item.alternateLabel && <button type="button" disabled={confirmDisabled} onClick={() => void controller.accept(item.id, 'alternate')}>
              {item.activeAction === 'alternate' ? item.alternateBusyLabel : item.alternateLabel}</button>}
            <button type="button" className="feedback-primary" disabled={confirmDisabled} onClick={() => void controller.accept(item.id)}>{item.activeAction === 'primary' ? item.busyLabel : item.actionLabel}</button>
          </> : <button ref={acknowledge} type="button" className="feedback-primary" onClick={() => controller.dismiss(item.id)}>{item.tone === 'success' ? '关闭' : '知道了'}</button>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new FeedbackController())
  const [stylesReady, setStylesReady] = useState(false)
  useEffect(() => {
    let active = true
    void import('./feedback.css').then(() => { if (active) setStylesReady(true) })
    return () => { active = false }
  }, [])
  const item = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => null)
  useEffect(() => () => controller.clear(), [controller])
  return <FeedbackContext.Provider value={controller}>{children}{stylesReady && item && <FeedbackDialog key={item.id} controller={controller} item={item} />}</FeedbackContext.Provider>
}
