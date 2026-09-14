import type { ElectronAPI } from './shared/ipc'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly VITE_SEP_TEST_EMAIL?: string
    readonly VITE_SEP_TEST_PASSWORD?: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}

