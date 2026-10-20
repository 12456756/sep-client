/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandbox preloads require CommonJS. */
const { contextBridge, ipcRenderer } = require('electron')
const channels = require('./recorder-channels.cjs')

contextBridge.exposeInMainWorld('speechPoc', {
  arm: recordingId => ipcRenderer.invoke(channels.ARM, { recordingId }),
  prepare: input => ipcRenderer.invoke(channels.PREPARE, input),
  recognize: input => ipcRenderer.invoke(channels.RECOGNIZE, input),
  cancel: recordingId => ipcRenderer.invoke(channels.CANCEL, { recordingId }),
})
