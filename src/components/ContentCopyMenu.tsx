import { Copy, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useOperationFeedback } from './feedback/use-operation-feedback'

export interface ContentMenuItem {
  label: string
  icon?: LucideIcon
  separator?: boolean
  disabledReason?: string
  danger?: boolean
}

export interface ContentMenuCommand extends ContentMenuItem {
  run: (signal: AbortSignal) => Promise<void>
}
export class ContentMenuError extends Error {}

interface CopyMenuRequest {
  commands: readonly ContentMenuCommand[]
  trigger: HTMLElement
  x: number
  y: number
}

type CopyTriggerEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>
export type CopyMenuHandler = (event: CopyTriggerEvent, commands: ContentMenuCommand | readonly ContentMenuCommand[]) => void
type ReadImage = (url: string, signal: AbortSignal) => Promise<Blob>

function encodePng(image: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context || !width || !height) throw new Error('Image is unavailable')
  context.drawImage(image, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png')
  })
}

function imageCommand(image: HTMLImageElement, readImage?: ReadImage): ContentMenuCommand {
  const source = image.currentSrc
  return { label: '复制图片', run: async signal => {
    if (!image.isConnected || !image.naturalWidth || image.currentSrc !== source) throw new Error('Image is unavailable')
    const png = readImage ? readImage(source, signal).then(async blob => {
      signal.throwIfAborted()
      if (blob.type === 'image/png') return blob
      const bitmap = await createImageBitmap(blob)
      try { return await encodePng(bitmap, bitmap.width, bitmap.height) }
      finally { bitmap.close() }
    }) : encodePng(image, image.naturalWidth, image.naturalHeight)
    // Start the clipboard write during the click, before the image bytes are ready.
    const payload = png.then(blob => {
      signal.throwIfAborted()
      return blob
    })
    void payload.catch(() => undefined) // The clipboard may reject before consuming the payload.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': payload })])
  } }
}

export function imageCopyHandlers(showMenu: CopyMenuHandler, readImage?: ReadImage, commands: readonly ContentMenuCommand[] = []) {
  const open = (event: CopyTriggerEvent) => {
    const trigger = event.currentTarget
    const image = trigger instanceof HTMLImageElement ? trigger : trigger.querySelector('img')
    const available = image?.complete && image.naturalWidth
      ? [...commands, { ...imageCommand(image, readImage), separator: commands.length > 0 }] : commands
    if (available.length) showMenu(event, available)
  }
  return { onContextMenu: open, onKeyDown: open }
}

export function useContentCopy() {
  const [request, setRequest] = useState<CopyMenuRequest | null>(null)
  const pending = useRef<AbortController | null>(null)
  const { capture } = useOperationFeedback()
  const onClose = useCallback(() => setRequest(null), [])
  useEffect(() => () => pending.current?.abort(), [])
  const showMenu: CopyMenuHandler = (event, commands) => {
    const keyboard = 'key' in event
    if (keyboard && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    event.stopPropagation()
    if (keyboard && event.repeat) return
    const trigger = event.currentTarget
    const { left, bottom } = trigger.getBoundingClientRect()
    setRequest({ commands: 'label' in commands ? [commands] : commands, trigger, x: keyboard ? left : event.clientX, y: keyboard ? bottom : event.clientY })
  }
  const copy = async (command: ContentMenuCommand) => {
    const notice = capture()
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    try { await command.run(controller.signal) }
    catch (error) { if (!controller.signal.aborted) notice.show(error instanceof ContentMenuError ? error.message : `${command.label}失败，请重试。`) }
    finally { if (pending.current === controller) pending.current = null }
  }
  return { showMenu, copy, menu: request ? <ContentMenu trigger={request.trigger} point={request} items={request.commands}
    label={request.commands.length === 1 ? '复制操作' : '文件操作'} onClose={onClose} onSelect={copy} /> : null }
}

export function useImagePreviewCopy(url: string | null, readImage?: ReadImage, commands?: readonly ContentMenuCommand[]) {
  const { showMenu, copy, menu } = useContentCopy()
  const imageRef = useRef<HTMLImageElement>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const enabled = Boolean(url && url === loadedUrl)
  const triggerProps = imageCopyHandlers(showMenu, readImage, commands)
  return {
    menu, triggerProps,
    imageProps: { ref: imageRef, tabIndex: 0, ...triggerProps, className: 'ent-copyable-preview-image',
      onLoad: () => setLoadedUrl(url), onError: () => setLoadedUrl(null) },
    copyButtonProps: { disabled: !enabled, title: '复制图片', 'aria-label': '复制图片', onClick: () => {
      if (enabled && imageRef.current) void copy(imageCommand(imageRef.current, readImage))
    } },
  }
}

export function ContentActionMenu<T extends ContentMenuItem>({ label, triggerLabel, triggerClassName, triggerIcon, className, children, items, onSelect }: {
  label: string; triggerLabel: string; triggerClassName?: string; triggerIcon: ReactNode; className?: string
  children: ReactNode; items: readonly T[]; onSelect: (item: T) => void
}) {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [request, setRequest] = useState<{ trigger: HTMLElement; point?: { x: number; y: number } } | null>(null)
  const onClose = useCallback(() => setRequest(null), [])
  return <div className={className} onContextMenu={event => {
    const trigger = triggerRef.current
    if (!trigger) return
    event.preventDefault()
    event.stopPropagation()
    setRequest(event.button === 2 ? { trigger, point: { x: event.clientX, y: event.clientY } } : { trigger })
  }}>
    {children}
    <button ref={triggerRef} type="button" className={triggerClassName} aria-label={triggerLabel} title="更多操作" aria-haspopup="menu"
      aria-expanded={request !== null} aria-controls={request ? id : undefined}
      onClick={event => { const trigger = event.currentTarget; setRequest(current => current ? null : { trigger }) }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setRequest({ trigger: event.currentTarget }) } }}>{triggerIcon}</button>
    {request && <ContentMenu id={id} trigger={request.trigger} point={request.point} popover="manual"
      label={label} items={items} onClose={onClose} onSelect={onSelect} />}
  </div>
}

function ContentMenu<T extends ContentMenuItem>({ id, trigger, point, popover = 'auto', label, items, onClose, onSelect }: {
  id?: string; trigger: HTMLElement; point?: { x: number; y: number }; label: string; items: readonly T[]
  popover?: 'auto' | 'manual'; onClose: () => void; onSelect: (item: T) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const hintId = useId()
  const hints = popover === 'manual' ? [...new Set(items.flatMap(item => item.disabledReason ? [item.disabledReason] : []))] : []

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const handleToggle = () => { if (!menu.matches(':popover-open')) onClose() }
    menu.addEventListener('toggle', handleToggle)
    menu.showPopover()
    const anchor = trigger.getBoundingClientRect()
    const { width, height } = menu.getBoundingClientRect()
    const x = point?.x ?? anchor.right - width
    const y = point?.y ?? (anchor.bottom + height + 12 > window.innerHeight ? anchor.top - height - 4 : anchor.bottom + 4)
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`
    const firstItem = menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu
    firstItem.focus({ preventScroll: true })
    const handleScroll = () => {
      const current = trigger.getBoundingClientRect()
      if (anchor.x !== current.x || anchor.y !== current.y) onClose()
    }
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) onClose()
    }
    if (popover === 'manual') document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      menu.removeEventListener('toggle', handleToggle)
      if (popover === 'manual') document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', onClose)
      if (menu.matches(':popover-open')) menu.hidePopover()
    }
  }, [trigger, point, popover, onClose])

  const close = () => {
    if (menuRef.current?.matches(':popover-open')) menuRef.current.hidePopover()
    trigger.focus({ preventScroll: true })
    onClose()
  }
  return <div ref={menuRef} id={id} {...{ popover }} className="ent-content-copy-menu" role="menu"
    aria-label={label} aria-describedby={hints.length ? hintId : undefined} tabIndex={-1}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'Tab') close()
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }}>
    {hints.length > 0 && <p id={hintId} className="ent-content-menu-hint">{hints.join(' ')}</p>}
    {items.map(item => {
      const Icon = item.icon ?? Copy
      return <div key={item.label} role="none">
        {item.separator ? <div role="separator" /> : null}
        <button type="button" role="menuitem" data-danger={item.danger || undefined} disabled={Boolean(item.disabledReason)} title={item.disabledReason} onClick={() => { close(); onSelect(item) }}>
          <Icon size={16} aria-hidden />{item.label}
        </button>
      </div>
    })}
  </div>
}
