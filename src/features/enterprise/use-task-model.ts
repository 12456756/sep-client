import { useState } from 'react'
import { resolveTaskModel } from '../../shared/model-preferences'

interface TaskModelSelection {
  scene: string
  selectedModelId: string | null
  committedModelId: string | null
}

/** Follow settings until a model is selected explicitly or committed to a plan. */
export function useTaskModel(scene: string, models: readonly string[], preferredModelId: string) {
  const initial = (): TaskModelSelection => ({ scene, selectedModelId: null, committedModelId: null })
  const [stored, setStored] = useState(initial)
  let selection = stored
  if (stored.scene !== scene) {
    selection = initial()
    setStored(selection)
  }
  const modelId = selection.committedModelId ?? resolveTaskModel(models, preferredModelId, selection.selectedModelId)
  const select = (selectedModelId: string): void => {
    setStored(current => ({ ...current, selectedModelId, committedModelId: current.committedModelId === null ? null : selectedModelId }))
  }
  const commit = (): void => { setStored(current => ({ ...current, committedModelId: modelId })) }
  return { modelId, select, commit }
}
