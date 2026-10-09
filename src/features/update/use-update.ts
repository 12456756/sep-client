import { useEffect, useState, useSyncExternalStore } from 'react'
import { createUpdateController } from './update-controller'
import type { UpdateModel } from './update-controller'

export type { UpdateModel } from './update-controller'

/** Mount once in App so navigation/auth changes retain the subscription and release metadata. */
export function useUpdate(): UpdateModel {
  const [controller] = useState(() => createUpdateController(window.electronAPI))
  const model = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => controller.connect(), [controller])
  return model
}
