/**
 * electron/preload.ts — Preload script (contextBridge)
 *
 * 通过 contextBridge 安全地暴露 IPC 通道给 renderer 进程。
 * Renderer 通过 window.electronAPI 调用主进程功能。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface ElectronAPI {
  // Pi session management
  startSession: (config: { employeeId: string; gatewayUrl: string; refreshToken: string }) => Promise<{ ok: boolean }>;
  sendPrompt: (text: string) => Promise<{ ok: boolean }>;
  stopSession: () => Promise<{ ok: boolean }>;

  // Credentials (safeStorage)
  saveRefreshToken: (token: string) => Promise<{ ok: boolean }>;
  getRefreshToken: () => Promise<{ token: string | null }>;

  // Event listeners (main → renderer)
  onPiEvent: (callback: (event: unknown) => void) => () => void;
  onToolApprovalRequest: (callback: (request: { toolName: string; input: unknown }) => void) => () => void;

  // Tool approval response (renderer → main)
  sendToolApprovalResponse: (response: { approved: boolean; reason?: string }) => void;
}

const electronAPI: ElectronAPI = {
  // Invoke handlers
  startSession: (config) => ipcRenderer.invoke('pi:start-session', config),
  sendPrompt: (text) => ipcRenderer.invoke('pi:send-prompt', text),
  stopSession: () => ipcRenderer.invoke('pi:stop-session'),

  saveRefreshToken: (token) => ipcRenderer.invoke('credentials:save-refresh-token', token),
  getRefreshToken: () => ipcRenderer.invoke('credentials:get-refresh-token'),

  // Event listeners with cleanup
  onPiEvent: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('pi:event', handler);
    return () => ipcRenderer.removeListener('pi:event', handler);
  },

  onToolApprovalRequest: (callback) => {
    const handler = (_event: IpcRendererEvent, request: { toolName: string; input: unknown }) => callback(request);
    ipcRenderer.on('pi:tool-approval-request', handler);
    return () => ipcRenderer.removeListener('pi:tool-approval-request', handler);
  },

  sendToolApprovalResponse: (response) => {
    ipcRenderer.send('pi:tool-approval-response', response);
  },
};

// Expose API to renderer via contextBridge
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// TypeScript augmentation for window.electronAPI
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
