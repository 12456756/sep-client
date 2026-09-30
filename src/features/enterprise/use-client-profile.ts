import { useCallback, useEffect, useState } from 'react'
import type { ClientProfile } from '../../shared/profile-wallet-contracts'
import type { UploadInput } from '../../shared/ipc'

type UploadKind = 'avatar' | 'logo' | null

/** Loads the server-owned profile and refreshes it after either image upload. */
export function useClientProfile() {
  const [profile, setProfile] = useState<ClientProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState<UploadKind>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<ClientProfile> => {
    setLoading(true)
    try {
      const result = await window.electronAPI.getClientProfile()
      if (!result.success || !result.data) throw new Error(result.error?.message || '资料加载失败')
      setProfile(result.data)
      setError(null)
      return result.data
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '资料加载失败'
      setError(message)
      throw cause
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  const upload = useCallback(async (
    kind: Exclude<UploadKind, null>,
    input: UploadInput,
  ): Promise<ClientProfile> => {
    setUploading(kind)
    setError(null)
    try {
      const result = kind === 'avatar'
        ? await window.electronAPI.uploadUserAvatar(input)
        : await window.electronAPI.uploadEnterpriseLogo(input)
      if (!result.success || !result.data) throw new Error(result.error?.message || '图片上传失败')
      // The upload response is only a path acknowledgement; profile is the source of truth.
      return await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图片上传失败')
      throw cause
    } finally {
      setUploading(null)
    }
  }, [refresh])

  return {
    profile,
    loading,
    uploading,
    error,
    refresh,
    uploadAvatar: (input: UploadInput) => upload('avatar', input),
    uploadLogo: (input: UploadInput) => upload('logo', input),
  }
}

export type ClientProfileWorkspace = ReturnType<typeof useClientProfile>
