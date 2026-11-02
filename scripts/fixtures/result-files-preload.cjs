// Sandboxed Electron preloads use CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  previewResultFile: input => ipcRenderer.invoke('result-test:preview', input),
  releaseResultFilePreview: input => ipcRenderer.invoke('result-test:release', input),
  revealResultFile: input => ipcRenderer.invoke('result-test:reveal', input),
  getTaskTimeline: async () => ({ success: true, data: [] }),
  listTaskRuns: async () => ({ success: true, runs: [] }),
  onTaskUpdated: () => () => {},
  onPiEvent: () => () => {},
})
contextBridge.exposeInMainWorld('resultTest', {
  state: () => ipcRenderer.invoke('result-test:state'),
  logout: () => ipcRenderer.invoke('result-test:logout'),
  replace: () => ipcRenderer.invoke('result-test:replace'),
})
