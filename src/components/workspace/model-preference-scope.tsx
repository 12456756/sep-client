import { createContext, useContext, useState, type ReactNode } from 'react'
import { modelPreferenceKey, readDefaultModel, saveDefaultModel, type ModelPreferenceScope } from '../../shared/model-preferences'

interface ModelPreference {
  defaultModelId: string
  error: string | null
  save: (modelId: string) => void
}

const ModelPreferenceContext = createContext<ModelPreference>({ defaultModelId: '', error: null, save: () => {} })

function preferenceStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function ModelPreferenceProvider({ scope, children }: { scope: ModelPreferenceScope; children: ReactNode }) {
  return <ScopedModelPreference key={modelPreferenceKey(scope)} scope={scope}>{children}</ScopedModelPreference>
}

function ScopedModelPreference({ scope, children }: { scope: ModelPreferenceScope; children: ReactNode }) {
  const key = modelPreferenceKey(scope)
  const [defaultModelId, setDefaultModelId] = useState(() => readDefaultModel(preferenceStorage(), key))
  const [error, setError] = useState<string | null>(null)
  const save = (modelId: string): void => {
    if (!saveDefaultModel(preferenceStorage(), key, modelId)) {
      setError('默认模型保存失败，请重试。')
      return
    }
    setDefaultModelId(modelId)
    setError(null)
  }
  return <ModelPreferenceContext.Provider value={{ defaultModelId, error, save }}>{children}</ModelPreferenceContext.Provider>
}

export function useModelPreference(): ModelPreference {
  return useContext(ModelPreferenceContext)
}
