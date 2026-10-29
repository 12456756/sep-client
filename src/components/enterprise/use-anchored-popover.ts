import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

/** Keeps toolbar pickers attached even inside transformed or clipped page containers. */
export function useAnchoredPopover(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>, preferAbove = false) {
  const root = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 16, top: 16, maxHeight: 560 })

  useLayoutEffect(() => {
    if (!open) return
    const popup = popover.current
    const place = () => {
      const rect = root.current?.getBoundingClientRect()
      if (!rect || !popup) return
      const margin = 16
      const gap = 8
      const width = popup.getBoundingClientRect().width
      const aboveSpace = Math.max(0, rect.top - margin - gap)
      const belowSpace = Math.max(0, window.innerHeight - rect.bottom - margin - gap)
      const above = (preferAbove && aboveSpace >= Math.min(popup.scrollHeight + 2, 240)) || aboveSpace >= belowSpace
      const maxHeight = Math.min(560, window.innerHeight * 0.7, above ? aboveSpace : belowSpace)
      const height = Math.min(popup.scrollHeight + 2, maxHeight)
      const top = above ? rect.top - gap - height : rect.bottom + gap
      const next = { left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)), top: Math.max(margin, top), maxHeight }
      setPosition(current => current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight ? current : next)
    }
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !popover.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); root.current?.querySelector('button')?.focus() } }
    place()
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const observer = new ResizeObserver(place)
    if (popup) observer.observe(popup)
    if (root.current) observer.observe(root.current)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      observer.disconnect()
    }
  }, [open, setOpen, preferAbove])

  return { root, popover, position }
}
