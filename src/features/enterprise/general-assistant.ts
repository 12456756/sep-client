import type { SiliconEmployee } from './types';

/** Presentation-only option. Never insert it into platform employee directories. */
export const GENERAL_ASSISTANT_ID = 'builtin:general-assistant';

export function generalAssistant(employees: readonly { allowedModels: readonly string[] }[]): SiliconEmployee {
  const allowedModels = [...new Set(employees[0]?.allowedModels ?? [])]
    .filter(model => employees.every(employee => employee.allowedModels.includes(model)));
  return {
    id: GENERAL_ASSISTANT_ID, name: '通用助手', mark: '助', roleName: '通用对话',
    avatar: null, avatarAsset: null, department: null, availability: allowedModels.length ? 'ready' : 'unavailable',
    assignedToMe: true, intro: '日常问答与通用协助', goodAt: [], cannotDo: [],
    lastWorkedAt: null, allowedModels, skillIds: [], permissions: [], templateVersion: '',
  };
}
