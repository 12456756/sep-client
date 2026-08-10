/**
 * electron/preload.ts — Preload script (contextBridge)
 *
 * 通过 contextBridge 安全地暴露 IPC 通道给 renderer 进程。
 * Renderer 通过 window.electronAPI 调用主进程功能。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface ElectronAPI {
  // Auth
  login: (credentials: { email: string; password: string }) => Promise<{
    success: boolean;
    data?: {
      accessToken: string;
      expiresIn: number;
      user: { id: string; email: string; name: string };
      enterprise: { id: string; name: string } | null;
    };
    error?: { message: string; statusCode: number };
  }>;
  checkStoredCredentials: () => Promise<{
    hasCredentials: boolean;
    user?: { name: string; email: string };
    enterprise?: { name: string };
  }>;
  logout: () => Promise<{ success: boolean; error?: { message: string } }>;
  getInstances: (accessToken: string) => Promise<{
    success: boolean;
    data?: Array<{
      id: string;
      name: string;
      status: string;
      templateVersion: string;
      template: {
        id: string;
        name: string;
        avatar: string | null;
      };
      department: {
        id: string;
        name: string;
      } | null;
    }>;
    error?: { message: string; statusCode: number };
  }>;
  getInstanceToken: (instanceId: string) => Promise<{
    success: boolean;
    data?: {
      instanceToken: string;
      expiresIn: number;
      instance: {
        id: string;
        name: string;
        templateId: string;
        status: string;
      };
    };
    error?: { message: string; statusCode: number };
  }>;
  getRefreshToken: () => Promise<{
    success: boolean;
    data?: { refreshToken: string };
    error?: { message: string };
  }>;

  // Pi session management
  startSession: (config: { employeeId: string; gatewayUrl: string; refreshToken: string }) => Promise<{ ok: boolean }>;
  sendPrompt: (text: string) => Promise<{ ok: boolean }>;
  stopSession: () => Promise<{ ok: boolean }>;

  // Task management
  createTask: (data: { title: string; prompt: string; workDir?: string }) => Promise<{
    success: boolean;
    task?: any;
    error?: { message: string };
  }>;
  executeTask: (taskId: string) => Promise<{ success: boolean; error?: { message: string } }>;
  getTask: (taskId: string) => Promise<{ success: boolean; task?: any; error?: { message: string } }>;
  getAllTasks: () => Promise<{ success: boolean; tasks?: any[]; error?: { message: string } }>;
  pauseTask: (taskId: string) => Promise<{ success: boolean; error?: { message: string } }>;
  cancelTask: (taskId: string) => Promise<{ success: boolean; error?: { message: string } }>;
  deleteTask: (taskId: string) => Promise<{ success: boolean; error?: { message: string } }>;
  getTaskStats: () => Promise<{ success: boolean; stats?: any; error?: { message: string } }>;

  // Utility
  selectDirectory: () => Promise<{ success: boolean; path?: string | null; error?: { message: string } }>;

  // Event listeners (main → renderer)
  onPiEvent: (callback: (event: unknown) => void) => () => void;
  onToolApprovalRequest: (callback: (request: { toolName: string; input: unknown }) => void) => () => void;
  onTaskUpdated: (callback: (task: any) => void) => () => void;
  onTaskListUpdated: (callback: (tasks: any[]) => void) => () => void;

  // Tool approval response (renderer → main)
  sendToolApprovalResponse: (response: { approved: boolean; reason?: string }) => void;
}

const electronAPI: ElectronAPI = {
  // Auth
  login: (credentials) => ipcRenderer.invoke('auth:login', credentials),
  checkStoredCredentials: () => ipcRenderer.invoke('auth:check-stored-credentials'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getInstances: (accessToken) => ipcRenderer.invoke('auth:get-instances', accessToken),
  getInstanceToken: (instanceId) => ipcRenderer.invoke('auth:get-instance-token', instanceId),
  getRefreshToken: () => ipcRenderer.invoke('auth:get-refresh-token'),

  // Pi session
  startSession: (config) => ipcRenderer.invoke('pi:start-session', config),
  sendPrompt: (text) => ipcRenderer.invoke('pi:send-prompt', text),
  stopSession: () => ipcRenderer.invoke('pi:stop-session'),

  // Task management
  createTask: (data) => ipcRenderer.invoke('task:create', data),
  executeTask: (taskId) => ipcRenderer.invoke('task:execute', taskId),
  getTask: (taskId) => ipcRenderer.invoke('task:get', taskId),
  getAllTasks: () => ipcRenderer.invoke('task:get-all'),
  pauseTask: (taskId) => ipcRenderer.invoke('task:pause', taskId),
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  deleteTask: (taskId) => ipcRenderer.invoke('task:delete', taskId),
  getTaskStats: () => ipcRenderer.invoke('task:get-stats'),

  // Utility
  selectDirectory: () => ipcRenderer.invoke('util:select-directory'),

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

  onTaskUpdated: (callback) => {
    const handler = (_event: IpcRendererEvent, task: any) => callback(task);
    ipcRenderer.on('task:updated', handler);
    return () => ipcRenderer.removeListener('task:updated', handler);
  },

  onTaskListUpdated: (callback) => {
    const handler = (_event: IpcRendererEvent, tasks: any[]) => callback(tasks);
    ipcRenderer.on('task:list-updated', handler);
    return () => ipcRenderer.removeListener('task:list-updated', handler);
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
