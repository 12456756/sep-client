import { createContext, useContext, type ReactNode } from 'react'
import type { ModelCatalogEntry } from '../../shared/model-catalog-contracts'

interface ModelCatalogContextValue {
  models: readonly ModelCatalogEntry[]
  error: string | null
  retry?: () => void
}

interface ModelCatalogProviderProps {
  models?: readonly ModelCatalogEntry[]
  error?: string | null
  retry?: () => void
  children: ReactNode
}

const defaultValue: ModelCatalogContextValue = { models: [], error: null }
const ModelCatalogContext = createContext(defaultValue)

export function ModelCatalogProvider({
  models,
  error = null,
  retry,
  children,
}: ModelCatalogProviderProps) {
  return <ModelCatalogContext.Provider value={{ models: models ?? [], error, retry }}>{children}</ModelCatalogContext.Provider>
}

export function useModelCatalog(): ModelCatalogContextValue {
  return useContext(ModelCatalogContext)
}
