import { useRef, type RefObject } from 'react'
import '../../styles/composer-resize.css'

interface Props {
  inputRef: RefObject<HTMLTextAreaElement>
  resizeTargetRef?: RefObject<HTMLElement>
  onResize?: (previousHeight: number, nextHeight: number) => void
}

function constrainedHeight(target: HTMLElement, height: number): number {
  const style = window.getComputedStyle(target)
  const minHeight = Number.parseFloat(style.minHeight) || 0
  const maxHeight = Number.parseFloat(style.maxHeight)
  return Math.max(minHeight, Number.isFinite(maxHeight) ? Math.min(maxHeight, height) : height)
}

export function ComposerResizeHandle({ inputRef, resizeTargetRef, onResize }: Props) {
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const resize = (height: number) => {
    const input = inputRef.current
    const target = resizeTargetRef?.current ?? input
    if (!input || !target || input.disabled) return
    const previousHeight = target.offsetHeight
    const nextHeight = constrainedHeight(target, height)
    target.style.height = `${nextHeight}px`
    onResize?.(previousHeight, nextHeight)
  }

  return <button type="button" className="ent-composer-resize" aria-label="调整输入框高度" title="调整输入框高度"
    onPointerDown={event => {
      const input = inputRef.current
      const target = resizeTargetRef?.current ?? input
      if (event.button !== 0 || !input || !target || input.disabled) return
      event.preventDefault()
      drag.current = { pointerId: event.pointerId, y: event.clientY, height: target.offsetHeight }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      const start = drag.current
      if (start?.pointerId === event.pointerId) resize(start.height + event.clientY - start.y)
    }}
    onPointerUp={event => {
      if (drag.current?.pointerId !== event.pointerId) return
      drag.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={() => { drag.current = null }}
    onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const target = resizeTargetRef?.current ?? inputRef.current
      if (target) resize(target.offsetHeight + (event.key === 'ArrowDown' ? 20 : -20))
    }} />
}
