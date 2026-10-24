import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AttachmentImportSession, AttachmentImportTarget, AttachmentView } from '../../shared/attachment-contracts'

type AttachmentApi = Pick<Window['electronAPI'], 'beginAttachmentImport' | 'selectAttachments' | 'listAttachments' | 'removeAttachment' | 'cancelAttachmentImport'> & {
  bindAttachmentPaste?: (input: { composerId: string; sessionId: string; target: AttachmentImportTarget; isEnabled?: () => boolean; onPasteEdit?: (input: { operationId: string; composerId: string; text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => boolean }) => () => void
  onAttachmentPaste?: (callback: (event: { composerId: string; sessionId: string; operationId: string; text?: string; status?: 'started' | 'completed' | 'failed'; error?: string }) => void) => () => void
}

export interface AttachmentComposerOptions {
  target: AttachmentImportTarget
  bindingKey?: string
  disabled?: boolean
  onPasteEdit?: (input: { operationId: string; composerId: string; text: string; selectionStart: number; selectionEnd: number; editorVersion: number }) => boolean
  onPasteImported?: (operationId: string, attachments: AttachmentView[]) => void
  onPasteStarted?: (operationId: string) => void
  onSelectStarted?: () => void
  onSelectFinished?: (attachments: AttachmentView[] | null) => void
}

export function useAttachmentComposer({ target, bindingKey = '', disabled = false, onPasteEdit, onPasteImported, onPasteStarted, onSelectStarted, onSelectFinished }: AttachmentComposerOptions) {
  const [session, setSession] = useState<AttachmentImportSession | null>(null)
  const [attachments, setAttachments] = useState<AttachmentView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const bindDispose = useRef<(() => void) | null>(null)
  const generation = useRef(0)
  const identityGeneration = useRef(0)
  const identityKey = `${bindingKey}:${JSON.stringify(target)}`
  const identityRef = useRef(identityKey)
  const pasteHandledRef = useRef(new Set<string>())
  const generatedComposerId = useRef(`composer-${crypto.randomUUID()}`)
  const composerId = target.kind === 'compose' ? target.composerId : generatedComposerId.current
  const api = window.electronAPI as AttachmentApi
  const onPasteImportedRef = useRef(onPasteImported)
  useEffect(() => { onPasteImportedRef.current = onPasteImported }, [onPasteImported])
  const onPasteStartedRef = useRef(onPasteStarted)
  useEffect(() => { onPasteStartedRef.current = onPasteStarted }, [onPasteStarted])
  const onPasteEditRef = useRef(onPasteEdit)
  useEffect(() => { onPasteEditRef.current = onPasteEdit }, [onPasteEdit])
  const onSelectStartedRef = useRef(onSelectStarted)
  useEffect(() => { onSelectStartedRef.current = onSelectStarted }, [onSelectStarted])
  const onSelectFinishedRef = useRef(onSelectFinished)
  useEffect(() => { onSelectFinishedRef.current = onSelectFinished }, [onSelectFinished])

  const begin = useCallback(async (): Promise<AttachmentImportSession | null> => {
    if (disabled || busyRef.current) return null
    busyRef.current = true
    setBusy(true)
    setError(null)
    const currentGeneration = ++generation.current
    try {
      const result = await api.beginAttachmentImport({ target })
      if (!result.success || !result.data) throw new Error(result.error?.message || '附件会话创建失败')
      if (currentGeneration !== generation.current) {
        void api.cancelAttachmentImport({ sessionId: result.data.sessionId })
        return null
      }
      bindDispose.current?.()
      setSession(result.data)
      setAttachments(result.data.attachments)
      if (api.bindAttachmentPaste) bindDispose.current = api.bindAttachmentPaste({ composerId, sessionId: result.data.sessionId, target, isEnabled: () => !disabledRef.current && !busyRef.current, onPasteEdit: input => onPasteEditRef.current?.(input) ?? false })
      return result.data
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '附件会话创建失败')
      return null
    } finally {
      if (currentGeneration === generation.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }, [api, composerId, disabled, target, onPasteEdit])

  const select = useCallback(async () => {
    const current = session ?? await begin()
    if (!current) return
    const requestGeneration = generation.current
    onSelectStartedRef.current?.()
    let selectedItems: AttachmentView[] | null = null
    busyRef.current = true
    setBusy(true)
    try {
      const result = await api.selectAttachments({ sessionId: current.sessionId })
      if (requestGeneration !== generation.current) return
      if (!result.success) throw new Error(result.error?.message || '选择附件失败')
      selectedItems = Array.isArray(result.data) ? result.data : result.data?.attachments ?? []
      setAttachments(selectedItems)
    } catch (cause) {
      if (requestGeneration !== generation.current) return
      setError(cause instanceof Error ? cause.message : '选择附件失败')
      const latest = await api.listAttachments({ sessionId: current.sessionId }).catch(() => null)
      if (requestGeneration === generation.current && latest?.success) {
        selectedItems = Array.isArray(latest.data) ? latest.data : latest.data?.attachments ?? []
        setAttachments(selectedItems)
      }
    } finally {
      if (requestGeneration === generation.current) {
        onSelectFinishedRef.current?.(selectedItems)
        busyRef.current = false
        setBusy(false)
      }
    }
  }, [api, begin, session])

  useEffect(() => {
    if (!session && !busy && !disabled) void begin()
  }, [begin, busy, disabled, session])

  useEffect(() => {
    if (!session || !api.onAttachmentPaste) return
    const currentIdentity = identityGeneration.current
    const pasteOperations = new Set<string>()
    const inFlight = new Set<string>()
    return api.onAttachmentPaste(event => {
      if (event.composerId !== composerId || event.sessionId !== session.sessionId) return
      if (event.status === 'started') {
        pasteOperations.add(event.operationId)
        inFlight.add(event.operationId)
        busyRef.current = true
        setBusy(true)
        onPasteStartedRef.current?.(event.operationId)
        return
      }
      const started = pasteOperations.delete(event.operationId)
      inFlight.delete(event.operationId)
      busyRef.current = inFlight.size > 0
      setBusy(inFlight.size > 0)
      if (!started) return
      if (event.status === 'failed') {
        setError(event.error || '附件导入失败')
        void api.listAttachments({ sessionId: session.sessionId }).then(result => {
          if (currentIdentity !== identityGeneration.current) return
          if (result.success) {
            const items = Array.isArray(result.data) ? result.data : result.data?.attachments ?? []
            setAttachments(items)
            onPasteImportedRef.current?.(event.operationId, items)
          }
        }).catch(() => undefined)
        return
      }
      if (pasteHandledRef.current.has(event.operationId)) return
      pasteHandledRef.current.add(event.operationId)
      void api.listAttachments({ sessionId: session.sessionId }).then(result => {
        if (currentIdentity !== identityGeneration.current) return
        if (result.success) {
          const items = Array.isArray(result.data) ? result.data : result.data?.attachments ?? []
          setAttachments(items)
          if (event.status === 'completed') onPasteImportedRef.current?.(event.operationId, items)
        }
        else setError(result.error?.message || '读取附件列表失败')
      })
    })
  }, [api, composerId, session])

  const remove = useCallback(async (attachmentId: string) => {
    if (!session) return
    const result = await api.removeAttachment({ sessionId: session.sessionId, attachmentId })
    if (!result.success) setError(result.error?.message || '移除附件失败')
    else setAttachments(items => items.filter(item => item.attachmentId !== attachmentId))
  }, [api, session])

  const sessionRef = useRef<AttachmentImportSession | null>(null)
  useEffect(() => { sessionRef.current = session }, [session])
  useLayoutEffect(() => {
    if (identityRef.current === identityKey) return
    identityRef.current = identityKey
    identityGeneration.current += 1
    pasteHandledRef.current.clear()
    generation.current += 1
    busyRef.current = false
    bindDispose.current?.()
    bindDispose.current = null
    const current = sessionRef.current
    sessionRef.current = null
    if (current?.status === 'open') void api.cancelAttachmentImport({ sessionId: current.sessionId })
    setSession(null)
    setAttachments([])
    setBusy(false)
    setError(null)
  }, [api, identityKey])
  useEffect(() => () => {
    generation.current += 1
    identityGeneration.current += 1
    bindDispose.current?.()
    const current = sessionRef.current
    if (current?.status === 'open') void api.cancelAttachmentImport({ sessionId: current.sessionId })
  }, [api])

  return { session, attachments, busy, error, select, remove, setError, composerId }
}

