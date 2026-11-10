import { useRef, type RefObject } from 'react'
import '../../styles/composer-resize.css'

export function ComposerResizeHandle({ inputRef }: { inputRef: RefObject<HTMLTextAreaElement> }) {
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const resize = (height: number) => {
    const input = inputRef.current
    if (input && !input.disabled) input.style.height = `${Math.max(0, height)}px`
  }

  return <button type="button" className="ent-composer-resize" aria-label="调整输入框高度" title="调整输入框高度"
    onPointerDown={event => {
      const input = inputRef.current
      if (event.button !== 0 || !input || input.disabled) return
      event.preventDefault()
      drag.current = { pointerId: event.pointerId, y: event.clientY, height: input.offsetHeight }
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
      const input = inputRef.current
      if (input) resize(input.offsetHeight + (event.key === 'ArrowDown' ? 20 : -20))
    }} />
}
