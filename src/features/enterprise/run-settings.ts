import type { ArrangementDraftDocument, ArrangementPermissionPreset } from '../../shared/types';
import type { FeedbackConfirmation } from '../../shared/feedback-controller';
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
  { id: 'read-only', label: '仅可查看', hint: '可以读取和搜索，不允许修改文件。' },
  { id: 'workspace-edit', label: '工作区内修改', hint: '可以新建成果；修改已有文件须确认。' },
  { id: 'full-local', label: '完全访问（本机文件）', hint: '仅本次运行；运行内置 Python 仍需单独确认。' },
];

export const DEFAULT_CONVERSATION_PERMISSION: ArrangementPermissionPreset = 'workspace-edit';

export const FULL_FILE_ACCESS_CONFIRMATION: FeedbackConfirmation = {
  title: '确认允许完全访问？',
  message: '仅本次运行可以读取和修改本机文件（含附件原件），修改时不再逐次确认。若员工请求运行内置 Python，客户端会另行确认。',
  checkboxLabel: '我了解风险', checkboxRequired: true, actionLabel: '允许完全访问', busyLabel: '确认中',
};

export function defaultRunSettings(): RunSettings {
  return { workDir: '', modelId: '', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' }, knowledge: noKnowledgeSelection() };
}

export function defaultAutoRunSettings(modelId = ''): RunSettings {
  return { ...defaultRunSettings(), modelId };
}

export function defaultConversationRunSettings(preset = DEFAULT_CONVERSATION_PERMISSION): RunSettings {
  return { ...defaultRunSettings(), permissions: { preset, approvalMode: 'confirm-each' } };
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
