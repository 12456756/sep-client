import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { mediaPreferenceKey, readMediaPreference, saveMediaPreference, type MediaParameterPreference, type MediaPreferenceScope } from '../../shared/media-preferences'

export const MediaPreferenceScopeContext = createContext<MediaPreferenceScope | null>(null)

function preferenceStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function useMediaParameterPreferences(kind: 'image' | 'video', profileId?: string) {
  const scope = useContext(MediaPreferenceScopeContext)
  const key = mediaPreferenceKey(scope, kind, profileId)
  const [stored, setStored] = useState(() => ({ key, parameters: readMediaPreference(preferenceStorage(), key, kind) }))
  const parameters = stored.key === key ? stored.parameters : readMediaPreference(preferenceStorage(), key, kind)
  useEffect(() => { setStored({ key, parameters: readMediaPreference(preferenceStorage(), key, kind) }) }, [key, kind])
  const save = useCallback((next: MediaParameterPreference): void => {
    saveMediaPreference(preferenceStorage(), key, kind, next)
    setStored({ key, parameters: next })
  }, [key, kind])
  return { key, parameters, save }
}
