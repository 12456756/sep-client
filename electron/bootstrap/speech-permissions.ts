import type { BrowserWindow } from 'electron'

export interface SpeechPermissionGate {
  canUseMicrophone(): boolean
  stop(): void
}

export function installSpeechPermissions(window: BrowserWindow, trustedUrl: string, gate?: SpeechPermissionGate): void {
  const session = window.webContents.session
  const trusted = (contents: Electron.WebContents | null): boolean => !window.isDestroyed()
    && contents === window.webContents && contents.getURL() === trustedUrl
  session.setPermissionCheckHandler((contents, permission, _origin, details) => trusted(contents) && details.isMainFrame && (
    permission === 'clipboard-sanitized-write'
    || (Boolean(gate?.canUseMicrophone()) && permission === 'media' && details.mediaType === 'audio')
  ))
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(trusted(contents) && details.isMainFrame === true && (
    permission === 'clipboard-sanitized-write'
    || (Boolean(gate?.canUseMicrophone()) && permission === 'media'
      && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio')
  )))
  window.on('blur', () => gate?.stop())
  window.on('closed', () => gate?.stop())
  window.webContents.on('render-process-gone', () => gate?.stop())
  window.webContents.on('will-navigate', (event, url) => { if (url !== trustedUrl) event.preventDefault() })
  window.webContents.on('will-redirect', (event, url) => { if (url !== trustedUrl) event.preventDefault() })
}
