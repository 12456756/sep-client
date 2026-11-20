import { AtSign, FileText, FolderOpen, ImageIcon, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AttachmentPreviewRequest, AttachmentView } from '../../../shared/attachment-contracts'
import { distinguishSameNameMentions, fileMentionQuery, moveFileMentions, resolveMentionAttachments, type FileMention, type FileMentionMemory, type MentionQuery } from '../../../shared/file-mention'
import type { ResultFileRequest } from '../../../shared/result-files'
import type { AttachmentComposerOperations } from './AttachmentComposer'
import './file-mention-picker.css'

export type MentionCandidate = { key: string; name: string; source: '本会话历史' | '本工作成果'; detail?: string; file: ResultFileRequest }

interface Options {
  input: RefObject<HTMLTextAreaElement | null>
  text: string
  update(value: string): void
  attachments: AttachmentView[]
  attachmentSessionId?: string
  operations?: RefObject<AttachmentComposerOperations | null>
  candidates?: MentionCandidate[]
  disabled?: boolean
  memory?: FileMentionMemory
}

export function useFileMention({ input, text, update, attachments, attachmentSessionId, operations, candidates = [], disabled = false, memory }: Options) {
  const local = useRef<FileMentionMemory>({})
  const stored = memory ?? local.current
  const draft = stored.draft ??= { text, mentions: [] }
  const history = stored.history ??= []
  const redo = stored.redo ??= []
  const only = stored.mentionOnly ??= new Set<string>()
  const imported = stored.imported ??= new Map<string, string>()
  const id = useId()
  const [query, setQuery] = useState<MentionQuery | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [failedText, setFailedText] = useState<string | null>(null)
  const version = useRef(0)
  const editVersion = useRef(0)
  const queryVersion = useRef(0)
  const running = useRef(false)
  const composing = useRef(false)
  const previousSelection = useRef<{ start: number; end: number } | undefined>(undefined)
  const nextCaret = useRef<number | undefined>(undefined)
  const textRef = useRef(text)
  textRef.current = text
  const restore = (value: string, mentions: FileMention[]) => {
    editVersion.current++
    if (value !== textRef.current) { setFailedText(null); setError('') }
    stored.draft = { text: value, mentions }
    update(value)
  }
  const marks = draft.text === text ? draft.mentions : moveFileMentions(draft.text, text, draft.mentions)
  useLayoutEffect(() => {
    if (draft.text !== text) { editVersion.current++; stored.draft = { text, mentions: marks } }
    const caret = nextCaret.current
    if (caret !== undefined) { input.current?.setSelectionRange(caret, caret); nextCaret.current = undefined }
  }, [draft.text, input, marks, stored, text])
  useLayoutEffect(() => () => { version.current++ }, [stored])

  const current = attachments.map((item, index) => ({ key: item.attachmentId, name: item.displayName, source: '本轮已添加', item,
    detail: attachments.some(other => other !== item && other.displayName === item.displayName) ? `第 ${index + 1} 份附件` : undefined } as const))
  const search = query?.query.toLocaleLowerCase() ?? ''
  const rank = (name: string) => name === search ? 0 : name.startsWith(search) ? 1 : 2
  const matches = query ? [...current, ...candidates].filter(item => item.name.toLocaleLowerCase().includes(search))
    .sort((a, b) => rank(a.name.toLocaleLowerCase()) - rank(b.name.toLocaleLowerCase())).slice(0, 36) : []
  const groups = new Map<(typeof matches)[number]['source'], typeof matches>()
  for (const item of matches) {
    const group = groups.get(item.source)
    if (group) group.push(item)
    else groups.set(item.source, [item])
  }
  const list = [...groups.values()].flat()
  const active = Math.min(highlight, list.length)
  const eligibility = resolveMentionAttachments(attachments, marks, only)
  const remember = () => {
    redo.length = 0
    history.push({ text, mentions: marks }); if (history.length > 40) history.shift()
  }
  const close = () => { queryVersion.current++; setQuery(null) }
  const fail = (message: string, before: string) => { setError(message); setFailedText(before) }
  const detect = (element: HTMLTextAreaElement) => {
    const caret = element.selectionStart
    const found = caret === element.selectionEnd ? fileMentionQuery(element.value, caret) : null
    setQuery(found && !stored.draft?.mentions.some(mark => mark.start <= found.start && mark.end >= found.end) ? found : null)
    setHighlight(0)
  }
  const change = (element: HTMLTextAreaElement, inputType?: string) => {
    const next = element.value
    const original = stored.draft ?? { text, mentions: marks }
    const undo = inputType === 'historyUndo' || inputType === 'historyRedo'
    const before = undo ? [...history].reverse().find(entry => entry.text === next) : undefined
    remember()
    restore(next, before?.mentions ?? moveFileMentions(original.text, next, original.mentions, previousSelection.current))
    previousSelection.current = undefined
    if (!disabled && !composing.current) detect(element)
    else setQuery(null)
  }
  const open = () => {
    if (disabled || running.current || composing.current || !input.current) return
    const element = input.current
    if (query) { close(); element.focus(); return }
    const start = element.selectionStart, end = element.selectionEnd
    if (element.maxLength >= 0 && text.length - (end - start) >= element.maxLength) return
    const next = `${text.slice(0, start)}@${text.slice(end)}`
    remember(); restore(next, moveFileMentions(text, next, marks, { start, end }))
    element.focus(); nextCaret.current = start + 1
    setQuery({ start, end: start + 1, query: '' }); setHighlight(0); setError('')
  }
  const insert = (selected: AttachmentView[], target: MentionQuery, before: string) => {
    if (!selected.length || !input.current || textRef.current !== before) return
    let offset = target.start
    const nextMarks = selected.map(item => {
      const name = `@${item.displayName.replace(/[\r\n]/g, ' ')}`
      const start = offset; offset += name.length + 1
      return { start, end: offset - 1, attachment: { attachmentId: item.attachmentId, sha256: item.sha256 }, name }
    })
    const next = before.slice(0, target.start) + nextMarks.map(item => item.name).join(' ') + ' ' + before.slice(target.end)
    if (input.current.maxLength >= 0 && next.length > input.current.maxLength) {
      fail('引用后内容超过长度限制，请先缩短正文。', before); return
    }
    remember()
    restore(next, [...moveFileMentions(before, next, marks, target), ...nextMarks.map(({ start, end, attachment }) => ({ start, end, attachment }))].sort((a, b) => a.start - b.start))
    input.current.focus(); nextCaret.current = offset; setQuery(null)
  }
  const select = async (index: number) => {
    if (!query || running.current || disabled) return
    const option = list[index], target = query, before = text
    if (option && 'item' in option) { setError(''); setFailedText(null); insert([option.item], target, before); return }
    if (!operations?.current) return
    const cached = option && attachments.find(item => item.attachmentId === imported.get(option.key))
    if (cached) { setError(''); setFailedText(null); insert([cached], target, before); return }
    const epoch = version.current, edit = editVersion.current, queryEpoch = queryVersion.current
    const selection = [input.current?.selectionStart, input.current?.selectionEnd]
    const stillCurrent = () => edit === editVersion.current && queryEpoch === queryVersion.current && textRef.current === before
      && selection[0] === input.current?.selectionStart && selection[1] === input.current?.selectionEnd
    running.current = true; setPending(true)
    try {
      const items = option ? await operations.current.addFile(option.file) : await operations.current.select(true)
      if (!items || epoch !== version.current) return
      const known = new Set(attachments.map(item => item.attachmentId))
      const fresh = items.filter(item => !known.has(item.attachmentId))
      const selected = fresh.length || !option ? fresh : 'attachmentId' in option.file ? items.filter(item => item.sha256 === (option.file as { sha256: string }).sha256 && item.displayName === option.name) : []
      for (const item of fresh) only.add(item.attachmentId)
      if (option && selected.length === 1) imported.set(option.key, selected[0].attachmentId)
      if (!stillCurrent()) return
      if (!selected.length) { fail('该文件已添加或不可用，请从本轮已添加中选择。', before); return }
      insert(selected, target, before)
    } catch (cause) {
      if (epoch === version.current && stillCurrent()) fail(cause instanceof Error ? cause.message : '无法引用此文件，请重试。', before)
    } finally {
      if (epoch === version.current) { running.current = false; setPending(false); if (stillCurrent()) input.current?.focus() }
    }
  }
  const remove = (mark: FileMention) => {
    remember()
    const next = text.slice(0, mark.start) + text.slice(mark.end)
    restore(next, moveFileMentions(text, next, marks, mark)); setQuery(null)
    input.current?.focus(); nextCaret.current = mark.start
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { selectionStart: start, selectionEnd: end } = event.currentTarget
    previousSelection.current = { start, end }
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const key = event.key.toLowerCase()
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      const forward = key === 'y' || event.shiftKey
      const source = forward ? redo : history, destination = forward ? history : redo
      const other = source.at(-1)
      if (other && (marks.length || other.mentions.length)) {
        event.preventDefault(); source.pop(); destination.push({ text, mentions: marks })
        restore(other.text, other.mentions); setQuery(null); nextCaret.current = Math.min(start, other.text.length)
        return
      }
    }
    if (query && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (query && !disabled) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); setHighlight((active + (event.key === 'ArrowUp' ? list.length : 1)) % (list.length + 1)); return
      }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!event.repeat) void select(active); return }
    }
    const mark = marks.find(item => start === end && (event.key === 'Backspace' ? item.start < start && start <= item.end : event.key === 'Delete' && item.start <= start && start < item.end))
    if (mark) { event.preventDefault(); remove(mark) }
  }
  const expanded = Boolean(query && (!disabled || pending))
  return { id, input, query: expanded ? query : null, active, list, groups, pending, error: failedText === text ? error : '', marks, invalid: eligibility.invalid || failedText === text, stale: eligibility.invalid,
    attachments: eligibility.items, unreferencedAttachments: eligibility.unreferenced, attachmentSessionId, submissionText: distinguishSameNameMentions(text, marks, eligibility.items), disabled, open, select, remove, keyDown, change,
    editorAria: { 'aria-controls': expanded ? id : undefined, 'aria-activedescendant': expanded ? `${id}-${active}` : undefined, 'aria-autocomplete': 'list' as const,
      onSelect: (event: { currentTarget: HTMLTextAreaElement }) => { if (query && (event.currentTarget.selectionStart !== query.end || event.currentTarget.selectionEnd !== query.end)) close() } },
    close, activate: setHighlight,
    compositionStart: () => { composing.current = true; close() },
    compositionEnd: (element: HTMLTextAreaElement) => { composing.current = false; if (!disabled) detect(element) },
  }
}

type ImageSource = { attachment: AttachmentPreviewRequest } | { result: ResultFileRequest }
const isImageName = (name: string) => /\.(png|jpe?g|webp)$/i.test(name)
const isAttachmentImage = (item: AttachmentView) => /^image\/(png|jpeg|webp)$/.test(item.mediaType)
const draftImage = (item: AttachmentView, sessionId?: string): ImageSource | null =>
  sessionId && isAttachmentImage(item) ? { attachment: { sessionId, attachmentId: item.attachmentId, sha256: item.sha256 } } : null

function useMentionImage(source: ImageSource | null) {
  const key = source ? JSON.stringify(source) : ''
  const request = useRef(source)
  request.current = source
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null)
  useEffect(() => {
    const target = request.current
    if (!target || !window.electronAPI) return
    let active = true
    let dispose: (() => void) | undefined
    const load = async () => {
      if ('attachment' in target) {
        const { success, data } = await window.electronAPI.previewAttachment(target.attachment)
        if (!active || !success || !data) return
        const url = URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: data.mediaType }))
        dispose = () => URL.revokeObjectURL(url)
        setPreview({ key, url })
      } else {
        const { success, data } = await window.electronAPI.previewResultFile(target.result)
        if (!success || !data) return
        const { url } = data
        const release = () => { void window.electronAPI.releaseResultFilePreview({ url }).catch(() => undefined) }
        if (!active || data.kind !== 'image') { release(); return }
        dispose = release
        setPreview({ key, url })
      }
    }
    const timer = window.setTimeout(() => { void load().catch(() => undefined) }, 120)
    return () => { active = false; window.clearTimeout(timer); dispose?.(); setPreview(previous => previous?.key === key ? null : previous) }
  }, [key])
  const url = preview?.key === key ? preview.url : undefined
  return { url, onError: () => setPreview(previous => previous?.url === url ? null : previous) }
}

function mentionPortalHost(anchor: HTMLElement) {
  return anchor.closest<HTMLElement>('[role="dialog"], .ent-shell') ?? document.body
}

function MentionImagePreview({ anchor, menu, url, onError }: { anchor: HTMLElement; menu?: HTMLElement | null; url: string; onError(): void }) {
  const [placement, setPlacement] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const row = anchor.getBoundingClientRect()
      const panel = menu?.getBoundingClientRect() ?? row
      const width = document.documentElement.clientWidth, height = window.innerHeight
      const gap = 8, maxWidth = 360, maxHeight = 300
      if (!anchor.isConnected || row.bottom <= Math.max(0, panel.top) || row.top >= Math.min(height, panel.bottom)) { setPlacement(null); return }
      const right = width - panel.right - gap * 2, left = panel.left - gap * 2
      if (menu && Math.max(right, left) >= 200) {
        const toRight = right >= Math.min(maxWidth, left)
        const cardWidth = Math.min(maxWidth, toRight ? right : left)
        const cardHeight = Math.min(maxHeight, height - gap * 2)
        setPlacement({ width: cardWidth, maxHeight: cardHeight, left: toRight ? panel.right + gap : panel.left - gap - cardWidth,
          top: Math.max(gap, Math.min(row.top, height - cardHeight - gap)) })
        return
      }
      const above = panel.top - gap * 2, below = height - panel.bottom - gap * 2
      const edge = Math.max(above, below) >= 144 ? panel : row
      const up = edge.top > height - edge.bottom
      const room = (up ? edge.top : height - edge.bottom) - gap * 2
      if (room < 64) { setPlacement(null); return }
      const cardWidth = Math.min(maxWidth, width - gap * 2)
      setPlacement({ width: cardWidth, maxHeight: Math.min(maxHeight, room), left: Math.max(gap, Math.min(row.left, width - cardWidth - gap)),
        ...(up ? { bottom: height - edge.top + gap } : { top: edge.bottom + gap }) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor, menu])
  return placement && createPortal(<div className="ent-file-mention-image-preview" style={placement} aria-hidden="true">
    <img key={url} src={url} alt="" onError={onError} />
  </div>, mentionPortalHost(anchor))
}

function MentionThumbnail({ source, previewAnchor, popup }: { source: ImageSource | null; previewAnchor?: HTMLButtonElement; popup: RefObject<HTMLDivElement> }) {
  const thumbnail = useRef<HTMLSpanElement>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = thumbnail.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      root: element.closest('.ent-file-mention-list'),
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // Keep the decoded source only for visible rows, and reuse it for the hover card.
  const image = useMentionImage(inView ? source : null)
  return <>
    <span ref={thumbnail} className="ent-file-mention-thumbnail" aria-hidden="true">
      {image.url ? <img src={image.url} alt="" onError={image.onError} /> : <ImageIcon size={20} />}
    </span>
    {previewAnchor && image.url && <MentionImagePreview anchor={previewAnchor} menu={popup.current} url={image.url} onError={image.onError} />}
  </>
}

export function FileMentionPicker({ mention }: { mention: ReturnType<typeof useFileMention> }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<{ left: number; edge: number; above: boolean; width: number; maxHeight: number } | null>(null)
  const { query, input, close } = mention
  const closeRef = useRef(close); closeRef.current = close
  const visible = Boolean(query)
  const host = visible && input.current ? mentionPortalHost(input.current) : null
  const [hover, setHover] = useState<{ key: string; anchor: HTMLButtonElement } | null>(null)
  useEffect(() => { if (!visible) setHover(null) }, [visible])
  useLayoutEffect(() => {
    if (!visible || !input.current) return
    const element = input.current
    const place = () => {
      const rect = element.getBoundingClientRect()
      const width = Math.max(0, Math.min(382, window.innerWidth - 16, Math.max(240, rect.width)))
      const above = rect.top > window.innerHeight - rect.bottom
      const space = above ? rect.top : window.innerHeight - rect.bottom
      setPlacement({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, edge: above ? window.innerHeight - rect.top + 4 : rect.bottom + 4,
        above, maxHeight: Math.max(68, Math.min(344, space - 12)) })
    }
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !element.contains(target) && !popup.current?.contains(target) && !trigger.current?.contains(target)) closeRef.current()
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', outside, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside, true) }
  }, [input, visible])
  useEffect(() => { if (!hover) popup.current?.querySelector('.ent-file-mention-list [aria-selected=true]')?.scrollIntoView({ block: 'nearest' }) }, [mention.active, hover])
  const indices = new Map(mention.list.map((item, index) => [item.key, index]))
  return <>
    <button ref={trigger} type="button" className="ent-icon-btn ent-file-mention-trigger" aria-label="引用文件" title="引用文件 (@)" aria-expanded={visible} aria-controls={visible ? mention.id : undefined} disabled={mention.disabled} onMouseDown={event => event.preventDefault()} onClick={mention.open}><AtSign size={16} aria-hidden /></button>
    {visible && placement && host && createPortal(<div ref={popup} className="ent-file-mention-popup" style={{ left: placement.left, width: placement.width, maxHeight: placement.maxHeight, ...(placement.above ? { bottom: placement.edge } : { top: placement.edge }) }}>
      <div className="ent-file-mention-heading"><strong>引用文件</strong><span title={query?.query}>{query?.query}</span></div>
      <div id={mention.id} role="listbox" aria-label="可引用文件" className="ent-file-mention-options" aria-busy={mention.pending}>
      <div className="ent-file-mention-list" role="presentation">
        {!mention.list.length && <p role="status">{mention.pending ? '正在读取文件…' : query?.query ? '未找到匹配文件' : '暂无可引用的文件'}</p>}
        {[...mention.groups].map(([group, items]) => <div role="group" aria-label={group} key={group}>
          <div className="ent-file-mention-group" aria-hidden="true">{group}</div>
          {items.map(option => {
            const index = indices.get(option.key)!
            const isImage = 'item' in option ? isAttachmentImage(option.item) : isImageName(option.name)
            const source = !isImage ? null : 'item' in option ? draftImage(option.item, mention.attachmentSessionId)
              : 'attachmentId' in option.file ? { attachment: option.file } : { result: option.file }
            const previewAnchor = hover?.key === option.key && index === mention.active ? hover.anchor : undefined
            return <button type="button" id={`${mention.id}-${index}`} role="option" tabIndex={-1} aria-selected={index === mention.active} key={option.key} onMouseDown={event => event.preventDefault()}
              onMouseEnter={event => { mention.activate(index); setHover(isImage ? { key: option.key, anchor: event.currentTarget } : null) }}
              onMouseLeave={() => setHover(current => current?.key === option.key ? null : current)} onClick={() => { setHover(null); void mention.select(index) }}>
              {isImage ? <MentionThumbnail source={source} previewAnchor={previewAnchor} popup={popup} /> : <FileText size={17} aria-hidden />}
              <span><strong title={option.name}>{option.name}</strong>{option.detail && <small>{option.detail}</small>}</span>
            </button>
          })}
        </div>)}
      </div>
        <button className="ent-file-mention-local" type="button" id={`${mention.id}-${mention.list.length}`} role="option" tabIndex={-1} aria-selected={mention.active === mention.list.length} onMouseDown={event => event.preventDefault()} onMouseEnter={() => mention.activate(mention.list.length)} onClick={() => void mention.select(mention.list.length)}><FolderOpen size={17} aria-hidden /><span>选择本地文件…</span></button>
      </div>
    </div>, host)}
    {mention.error && <span className="ent-file-mention-error" role="alert">{mention.error}</span>}
    {mention.stale && <span className="ent-file-mention-error" role="alert">引用文件已移除。{mention.marks.filter(mark => !mention.attachments.some(item => item.attachmentId === mark.attachment.attachmentId && item.sha256 === mark.attachment.sha256)).map(mark =>
      <button type="button" key={mark.start} className="ent-btn sm" onClick={() => mention.remove(mark)}><X size={12} aria-hidden />移除失效引用</button>)}</span>}
  </>
}

export function FileMentionChips({ mention }: { mention: ReturnType<typeof useFileMention> }) {
  const resolved = mention.marks.flatMap(mark => {
    const item = mention.attachments.find(file => file.attachmentId === mark.attachment.attachmentId && file.sha256 === mark.attachment.sha256)
    return item ? [{ mark, item }] : []
  })
  return resolved.length ? <div className="ent-file-mention-chips" aria-label="本轮文件引用">{resolved.map(({ mark, item }) =>
    <FileMentionChip key={`${mark.start}:${item.attachmentId}`} item={item} sessionId={mention.attachmentSessionId} disabled={mention.disabled || mention.pending} remove={() => mention.remove(mark)} />
  )}</div> : null
}

function FileMentionChip({ item, sessionId, disabled, remove }: { item: AttachmentView; sessionId?: string; disabled: boolean; remove(): void }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const source = draftImage(item, sessionId)
  const image = useMentionImage(hovered || focused ? source : null)
  const name = item.displayName
  return <span className="ent-file-mention-chip" ref={anchor} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <button type="button" disabled={disabled} title={source && (hovered || focused) ? undefined : name} aria-label={`解除引用 ${name}`}
      onFocus={event => setFocused(event.currentTarget.matches(':focus-visible'))} onBlur={() => setFocused(false)}
      onKeyDown={event => { if (event.key === 'Escape' && image.url) { event.preventDefault(); event.stopPropagation(); setFocused(false); setHovered(false) } }} onClick={remove}>
      {source ? <ImageIcon size={12} aria-hidden /> : <AtSign size={12} aria-hidden />}<span>{name}</span><X size={12} aria-hidden />
    </button>
    {(hovered || focused) && anchor.current && image.url && <MentionImagePreview anchor={anchor.current} url={image.url} onError={image.onError} />}
  </span>
}
