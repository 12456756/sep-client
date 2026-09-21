/**
 * 截图脚手架专用：一份内存版 window.electronAPI。
 *
 * 它实现渲染层真正会调用的那些方法（见 useEnterpriseWorkspace / useSkillLibrary /
 * use-arrangement-plans / ClientAppPage），全部返回 fixtures 里的静态数据，监听类方法
 * 一律返回空的退订函数、不主动推送——这样每个页面在截图时是稳定、可复现的。
 *
 * 不是产品代码，不接真实主进程。生产入口 src/main.tsx 完全不引用本文件。
 */

import type { ElectronAPI } from '../shared/ipc';
import type { IpcCommandResult } from '../shared/ipc';
import type { ClientTask } from '../shared/types';
import {
  EMPLOYEE_STATUSES,
  MESSAGES,
  ORGANIZATION,
  RUNTIME_INFO,
  SKILL_LIBRARY,
  SKILL_SOURCES,
  SUBSCRIPTIONS,
  TASKS,
} from './fixtures';

const ok = (): IpcCommandResult => ({ success: true });
const noop = (): (() => void) => () => {};

/** 任务 id → 它的工作目录（产出文件按此展示）。 */
function findTask(taskId: string): ClientTask | undefined {
  return TASKS.find(task => task.id === taskId);
}

export const mockElectronAPI = {
  // ── 身份 / 运行时 ──────────────────────────────────────────────
  listRememberedAccounts: async () => ({ accounts: [], encryptionAvailable: true }),
  getRememberedPassword: async () => ({ passwordAvailable: false }),
  revealRememberedPassword: async () => ({ password: null }),
  forgetAccount: async () => ({ success: true }),
  login: async () => ({ success: true as const }),
  logout: async () => ({ success: true as const }),
  getRuntimeInfo: async () => ({ success: true, data: RUNTIME_INFO }),

  // ── 员工目录 ──────────────────────────────────────────────────
  getSubscriptions: async () => ({ success: true, data: SUBSCRIPTIONS }),
  getEmployeeStatus: async () => ({ success: true, data: EMPLOYEE_STATUSES }),
  getEnterpriseOrganization: async () => ({ success: true, data: ORGANIZATION }),
  getEmployeeSkills: async (employeeId: string) => ({
    success: true,
    data: { subscriptionId: employeeId, canManage: false, skills: [] },
  }),
  previewSkill: async () => ({ success: true, data: { content: '' } }),

  // ── 工作（任务）───────────────────────────────────────────────
  getAllTasks: async () => ({ success: true, tasks: TASKS }),
  getTask: async (taskId: string) => ({ success: true, task: findTask(taskId) }),
  getTaskMessages: async (taskId: string) => ({ success: true, messages: MESSAGES[taskId] ?? [] }),
  getTaskStats: async () => ({
    success: true,
    stats: {
      total: TASKS.length,
      pending: TASKS.filter(t => t.status === 'pending').length,
      running: TASKS.filter(t => t.status === 'running').length,
      waitingApproval: TASKS.filter(t => t.status === 'waiting_approval').length,
      paused: TASKS.filter(t => t.status === 'paused').length,
      interrupted: TASKS.filter(t => t.status === 'interrupted').length,
      completed: TASKS.filter(t => t.status === 'completed').length,
      failed: TASKS.filter(t => t.status === 'failed').length,
    },
  }),
  listTaskRuns: async () => ({ success: true, runs: [] }),
  getTaskRun: async () => ({ success: true }),
  getTaskTimeline: async () => ({ success: true, events: [] }),

  // ── 编排计划 / 草稿 ───────────────────────────────────────────
  getArrangementContext: async () => ({}),
  getArrangementPlan: async () => ({ success: true, plan: null }),
  listArrangementDrafts: async () => ({ success: true, drafts: [] }),
  createArrangementDraft: async () => ({ success: true }),
  getArrangementDraft: async () => ({ success: true }),
  updateArrangementDraft: async () => ({ success: true }),
  deleteArrangementDraft: async () => ({}),
  validateArrangementDraft: async () => ({}),
  preflightArrangementDraft: async () => ({ success: true }),
  confirmArrangementDraft: async () => ({}),
  confirmAndStartArrangement: async () => ({ success: true }),
  planArrangementDraft: async () => ({ success: true }),
  cancelArrangementPlanning: async () => ({ success: true }),

  // ── 工作动作 ──────────────────────────────────────────────────
  createTask: async () => ({ success: true }),
  createConversation: async () => ({ success: true }),
  executeTask: async () => ok(),
  continueTask: async () => ok(),
  switchConversationEmployee: async () => ok(),
  retryTask: async () => ok(),
  pauseTask: async () => ok(),
  cancelTask: async () => ok(),
  deleteTask: async () => ok(),
  selectDirectory: async () => ({ success: true, path: '/Users/yao/Documents/龙道科技/工作区' }),

  // ── 技能库 ────────────────────────────────────────────────────
  listSkillLibrary: async () => ({ success: true, data: SKILL_LIBRARY }),
  previewLibrarySkill: async (input: { capabilityId: string; versionId: string }) => ({
    success: true,
    data: SKILL_SOURCES[input.capabilityId] ?? '# 技能原文\n（脚手架未提供该版本的原文）',
  }),
  selectSkillVersion: async () => ok(),
  savePersonalSkill: async () => ({ success: true, data: { idempotencyKey: '', uploaded: true } }),
  retryPersonalSkillUpload: async () => ({ success: true, data: { idempotencyKey: '', uploaded: true } }),

  // ── 事件订阅：脚手架不主动推送，只返回退订函数 ───────────────────
  onPiEvent: noop,
  onToolApprovalRequest: noop,
  onTaskUpdated: noop,
  onTaskListUpdated: noop,
  onAuthenticationRequired: noop,
  onArrangementPlanningEvent: noop,
  sendToolApprovalResponse: () => {},
} satisfies ElectronAPI;
