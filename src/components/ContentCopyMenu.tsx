import { Copy, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useOperationFeedback } from './feedback/use-operation-feedback'

export interface ContentMenuCommand {
  label: string
  run: (signal: AbortSignal) => Promise<void>
  icon?: LucideIcon
  separator?: boolean
  disabledReason?: string
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
  return { showMenu, copy, menu: request ? <ContentCopyMenu request={request} onClose={onClose} onCopy={copy} /> : null }
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

function ContentCopyMenu({ request, onClose, onCopy }: { request: CopyMenuRequest; onClose: () => void; onCopy: (command: ContentMenuCommand) => Promise<void> }) {
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const handleToggle = () => { if (!menu.matches(':popover-open')) onClose() }
    menu.addEventListener('toggle', handleToggle)
    menu.showPopover()
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(request.x, window.innerWidth - width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(request.y, window.innerHeight - height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const anchor = request.trigger.getBoundingClientRect()
    const handleScroll = () => {
      const current = request.trigger.getBoundingClientRect()
      if (anchor.x !== current.x || anchor.y !== current.y) onClose()
    }
    document.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      menu.removeEventListener('toggle', handleToggle)
      document.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', onClose)
      if (menu.matches(':popover-open')) menu.hidePopover()
    }
  }, [request, onClose])

  const close = () => {
    if (menuRef.current?.matches(':popover-open')) menuRef.current.hidePopover()
    request.trigger.focus({ preventScroll: true })
    onClose()
  }
  return <div ref={menuRef} {...{ popover: 'auto' }} className="ent-content-copy-menu" role="menu" aria-label={request.commands.length === 1 ? '复制操作' : '文件操作'}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'Tab') close()
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }}>
    {request.commands.map(command => {
      const Icon = command.icon ?? Copy
      return <div key={command.label} role="none">
        {command.separator ? <div role="separator" /> : null}
        <button type="button" role="menuitem" disabled={Boolean(command.disabledReason)} title={command.disabledReason} onClick={() => { close(); void onCopy(command) }}>
          <Icon size={16} aria-hidden />{command.label}
        </button>
      </div>
    })}
  </div>
}
