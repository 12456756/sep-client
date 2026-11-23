export type LocalMediaSettingsAction = 'get' | 'choose' | 'use-default'

export interface LocalMediaSettings {
  supported: boolean
  path: string
  defaultPath: string
  custom: boolean
}
