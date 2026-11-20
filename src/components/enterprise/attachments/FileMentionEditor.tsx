import { forwardRef, Fragment, useCallback, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react'
import type { FileMention } from '../../../shared/file-mention'
import './file-mention-picker.css'

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string
  mention: { marks: readonly FileMention[] }
}

const textMetrics = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
  'font-kerning', 'font-feature-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent',
  'text-transform', 'direction', 'tab-size', 'white-space', 'overflow-wrap', 'word-break', 'padding', 'color']

export const FileMentionEditor = forwardRef<HTMLTextAreaElement, Props>(function FileMentionEditor(
  { mention, value, onScroll, onCompositionStart, onCompositionEnd, ...props }, ref,
) {
  const input = useRef<HTMLTextAreaElement | null>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [composing, setComposing] = useState(false)
  const setInput = useCallback((element: HTMLTextAreaElement | null) => {
    input.current = element
    if (typeof ref === 'function') ref(element)
    else if (ref) ref.current = element
  }, [ref])

  const marks = [...mention.marks].sort((a, b) => a.start - b.start)
  const highlighted = marks.length > 0 && !composing
  const syncScroll = useCallback(() => {
    if (!input.current || !mirror.current) return
    mirror.current.scrollTop = input.current.scrollTop
    mirror.current.scrollLeft = input.current.scrollLeft
  }, [])
  const syncLayout = useCallback(() => {
    const editor = input.current, layer = mirror.current
    if (!editor || !layer) return
    const style = getComputedStyle(editor)
    for (const property of textMetrics) layer.style.setProperty(property, style.getPropertyValue(property))
    // Fit the native text viewport, excluding borders and any visible scrollbar.
    layer.style.inset = `${editor.clientTop}px ${editor.offsetWidth - editor.clientWidth - editor.clientLeft}px ${editor.offsetHeight - editor.clientHeight - editor.clientTop}px ${editor.clientLeft}px`
    syncScroll()
    layer.dataset.ready = ''
  }, [syncScroll])
  useLayoutEffect(() => { syncLayout() })
  useLayoutEffect(() => {
    if (!highlighted || !input.current) return
    const observer = new ResizeObserver(syncLayout)
    observer.observe(input.current)
    return () => observer.disconnect()
  }, [highlighted, syncLayout])

  let end = 0
  return <div className="ent-file-mention-editor">
    <textarea {...props} ref={setInput} value={value}
      onScroll={event => { syncScroll(); onScroll?.(event) }}
      onCompositionStart={event => { setComposing(true); onCompositionStart?.(event) }}
      onCompositionEnd={event => { setComposing(false); onCompositionEnd?.(event) }} />
    {highlighted && <div className="ent-file-mention-mirror" ref={mirror} aria-hidden="true">
      {marks.map(mark => {
        const before = value.slice(end, mark.start)
        end = mark.end
        return <Fragment key={mark.start}>{before}<span className="ent-file-mention-highlight">{value.slice(mark.start, end)}</span></Fragment>
      })}{value.slice(end)}{value.endsWith('\n') && '\u200b'}
    </div>}
  </div>
})
