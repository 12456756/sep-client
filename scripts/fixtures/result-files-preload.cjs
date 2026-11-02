// Sandboxed Electron preloads use CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  previewResultFile: input => ipcRenderer.invoke('result-test:preview', input),
  releaseResultFilePreview: input => ipcRenderer.invoke('result-test:release', input),
  revealResultFile: input => ipcRenderer.invoke('result-test:reveal', input),
  getTaskMedia: taskId => ipcRenderer.invoke('result-test:images', taskId),
  getTaskVideo: taskId => ipcRenderer.invoke('result-test:videos', taskId),
  beginAttachmentImport: async ({ target }) => ({ success: true, data: { schemaVersion: 1, sessionId: 'result-test-attachment', owner: { memberId: 'member', enterpriseId: 'enterprise' }, target, status: 'open', createdAt: Date.now(), expiresAt: Date.now() + 3600000, attachments: [], revision: 0 } }),
  selectAttachments: async () => ({ success: true, data: [] }),
  listAttachments: async () => ({ success: true, data: [] }),
  removeAttachment: async () => ({ success: true }),
  cancelAttachmentImport: async () => ({ success: true }),
  bindAttachmentPaste: () => () => {},
  onAttachmentPaste: () => () => {},
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
