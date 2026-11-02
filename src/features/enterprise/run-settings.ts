import type { ArrangementDraftDocument, ArrangementPermissionPreset } from '../../shared/types';
import type { KnowledgeSelection } from '../../shared/knowledge-selection';
import { noKnowledgeSelection } from '../../shared/knowledge-selection';
import { GENERAL_ASSISTANT_ID } from './general-assistant';

/** Task settings use the persisted backend contract, not employee-local display switches. */
export interface RunSettings {
  workDir: string;
  modelId: string;
  permissions: ArrangementDraftDocument['permissions'];
  knowledge: KnowledgeSelection;
}

export const RUN_PERMISSIONS: { id: ArrangementPermissionPreset; label: string; hint: string }[] = [
  { id: 'read-only', label: '只读', hint: '读取、搜索文件，不允许修改文件或执行命令。' },
  { id: 'workspace-edit', label: '工作区编辑', hint: '允许读取和修改工作目录中的文件，不允许执行命令。' },
  { id: 'full-local', label: '完整本地权限', hint: '允许读写文件及执行系统命令；开启“自动放行”后，已注册工具会直接运行并绕过路径、命令和逐次确认限制。' },
];

export function defaultRunSettings(): RunSettings {
  return { workDir: '', modelId: '', permissions: { preset: 'read-only', approvalMode: 'confirm-each' }, knowledge: noKnowledgeSelection() };
}

export function defaultAutoRunSettings(modelId = ''): RunSettings {
  return { workDir: '', modelId, permissions: { preset: 'full-local', approvalMode: 'auto-approve' }, knowledge: noKnowledgeSelection() };
}

export function defaultConversationRunSettings(): RunSettings {
  return { ...defaultRunSettings(), permissions: { preset: 'full-local', approvalMode: 'auto-approve' } };
}

export function conversationDocument(
  title: string, prompt: string, subscriptionId: string, modelId: string,
  settings: { workDir?: string; permissions?: ArrangementDraftDocument['permissions']; knowledge?: KnowledgeSelection } = {},
): ArrangementDraftDocument {
  return {
    schemaVersion: 1, mode: 'conversation', title, goal: prompt,
    knowledge: settings.knowledge ?? noKnowledgeSelection(),
    confirmedInputs: [], sharedSkillIds: [], nodes: [], lastPlanning: null,
    conversation: subscriptionId === GENERAL_ASSISTANT_ID
      ? { kind: 'general', modelId, participants: [], activeSubscriptionId: null }
      : { participants: [{ subscriptionId, modelId }], activeSubscriptionId: subscriptionId },
    workspace: { mode: 'shared', path: settings.workDir?.trim() || null },
    permissions: { ...(settings.permissions ?? defaultConversationRunSettings().permissions) },
  };
}
