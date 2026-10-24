import { ARRANGEMENT_PLANNER_RULES } from '../../domain/arrangement-planner-prompts'
import { translatePiNativeSystemPrompt } from './pi-native-system-prompt'

export function transformArrangementPlannerSystemPrompt(prompt: string): string {
  if (prompt.includes(ARRANGEMENT_PLANNER_RULES)) return prompt
  const translated = translatePiNativeSystemPrompt(prompt)
  if (!translated.startsWith('你运行在 Pi 中。')) return prompt
  return `${translated}\n\n${ARRANGEMENT_PLANNER_RULES}`
}
