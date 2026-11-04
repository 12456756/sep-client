import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { type SkillImportStateView, type SkillImportConsentInputSchema } from '../../shared/skill-import-contracts'
type SkillImportConsentInput = z.infer<typeof SkillImportConsentInputSchema>

type Root = SkillImportStateView['roots'][number]
type State = SkillImportStateView
type Result<T> = { success: boolean; data?: T; error?: { message: string } }
type SkillImportApi = {
  getSkillImportState: () => Promise<Result<State>>
  onSkillImportStateChanged: (handler: (state: State) => void) => () => void
  setSkillImportVisible: (input: { visible: boolean }) => Promise<Result<unknown>>
  confirmSkillImportConsent: (input: SkillImportConsentInput) => Promise<Result<unknown>>
  selectSkillImportRoot: () => Promise<Result<Root>>
  removeSkillImportRoot: (input: { rootId: string }) => Promise<Result<unknown>>
  cancelSkillImport: (input: { sessionId: string }) => Promise<Result<unknown>>
  revokeSkillImportDevice: (input: { deviceId: string; instanceId: string }) => Promise<Result<unknown>>
}

const idleState: State = {
  revision: 0, visible: false, phase: 'idle', clientVersion: '', protocolVersion: 1,
  sessionId: null, instanceId: null, siteLabel: null, initiatorLabel: null, scope: null,
  roots: [], pairing: null, devices: [], progress: null, error: null,
  persistenceAvailable: false, busySessionId: null,
}

export interface SkillImportController {
  state: State
  loading: boolean
  error: string | null
  setSkillImportVisible: (visible: boolean) => Promise<void>
  confirmConsent: (input: SkillImportConsentInput) => Promise<void>
  selectRoot: () => Promise<void>
  removeRoot: (rootId: string) => Promise<void>
  cancel: () => Promise<void>
  revoke: (deviceId: string, instanceId: string) => Promise<void>
  refresh: () => Promise<void>
}

function api(): SkillImportApi {
  return window.electronAPI as typeof window.electronAPI & SkillImportApi
}

function failureMessage(result: { success: boolean; error?: { message: string } }, fallback: string): string | null {
  return result.success ? null : result.error?.message || fallback
}

export function acceptSkillImportSnapshot(current: State, incoming: State): State {
  return incoming.revision >= current.revision ? incoming : current
}

export function useSkillImport(): SkillImportController {
  const [state, setState] = useState<State>(idleState)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const apply = useCallback((next: State) => {
    const accepted = acceptSkillImportSnapshot(stateRef.current, next)
    if (accepted !== stateRef.current) {
      stateRef.current = accepted
      setState(accepted)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api().getSkillImportState()
      if (!result.success || !result.data) throw new Error(result.error?.message || '无法读取本机 Skills 导入状态。')
      apply(result.data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本机 Skills 导入状态。')
    } finally { setLoading(false) }
  }, [apply])

  useEffect(() => {
    let active = true
    const unsubscribe = api().onSkillImportStateChanged(next => { if (active) apply(next) })
    void refresh()
    return () => { active = false; unsubscribe() }
  }, [apply, refresh])

  const run = useCallback(async <T,>(action: () => Promise<Result<T>>, fallback: string) => {
    setError(null)
    try {
      const result = await action()
      const message = failureMessage(result, fallback)
      if (message) throw new Error(message)
      return result.data
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback)
      return undefined
    }
  }, [])

  const setSkillImportVisible = useCallback(async (visible: boolean) => {
    await run(() => api().setSkillImportVisible({ visible }), '无法切换导入窗口。')
    await refresh()
  }, [refresh, run])
  const confirmConsent = useCallback(async (input: SkillImportConsentInput) => {
    if (stateRef.current.phase !== 'awaiting-local-consent') return
    await run(() => api().confirmSkillImportConsent(input), '本机授权未能提交。')
    await refresh()
  }, [refresh, run])
  const selectRoot = useCallback(async () => {
    await run(() => api().selectSkillImportRoot(), '未能选择本机目录。')
    await refresh()
  }, [refresh, run])
  const removeRoot = useCallback(async (rootId: string) => {
    await run(() => api().removeSkillImportRoot({ rootId }), '未能移除此目录。')
    await refresh()
  }, [refresh, run])
  const cancel = useCallback(async () => {
    const sessionId = stateRef.current.sessionId
    if (sessionId) await run(() => api().cancelSkillImport({ sessionId }), '无法取消本次导入。')
    await refresh()
  }, [refresh, run])
  const revoke = useCallback(async (deviceId: string, instanceId: string) => {
    await run(() => api().revokeSkillImportDevice({ deviceId, instanceId }), '无法撤销设备授权。')
    await refresh()
  }, [refresh, run])

  return { state, loading, error, setSkillImportVisible, confirmConsent, selectRoot, removeRoot, cancel, revoke, refresh }
}
