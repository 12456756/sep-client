import type { ArrangementDraftDocument, ArrangementPermissionPreset } from '../../shared/types';

/** Task settings use the persisted backend contract, not employee-local display switches. */
export interface RunSettings {
  workDir: string;
  modelId: string;
  permissions: ArrangementDraftDocument['permissions'];
}

export const RUN_PERMISSIONS: { id: ArrangementPermissionPreset; label: string; hint: string }[] = [
  { id: 'read-only', label: '只读', hint: '读取、搜索文件，不允许修改文件或执行命令。' },
  { id: 'workspace-edit', label: '工作区编辑', hint: '允许读取和修改工作目录中的文件，不允许执行命令。' },
  { id: 'full-local', label: '完整本地权限', hint: '允许读写文件及执行系统命令；仍受路径和工具安全检查约束。' },
];

export function defaultRunSettings(): RunSettings {
  return { workDir: '', modelId: '', permissions: { preset: 'read-only', approvalMode: 'confirm-each' } };
}

export function conversationDocument(
  title: string, prompt: string, subscriptionId: string, modelId: string,
  settings: { workDir?: string; permissions?: ArrangementDraftDocument['permissions'] } = {},
): ArrangementDraftDocument {
  return {
    schemaVersion: 1, mode: 'conversation', title, goal: prompt,
    confirmedInputs: [], sharedSkillIds: [], nodes: [], lastPlanning: null,
    conversation: { participants: [{ subscriptionId, modelId }], activeSubscriptionId: subscriptionId },
    workspace: { mode: 'shared', path: settings.workDir?.trim() || null },
    permissions: { ...(settings.permissions ?? defaultRunSettings().permissions) },
  };
}
