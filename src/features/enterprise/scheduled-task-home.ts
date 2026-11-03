import { defaultRunSettings, type RunSettings } from './run-settings'
import type { SiliconEmployee } from './types'

export interface ScheduledTaskDraft {
  goal: string
  mode: 'employee' | 'auto'
  subscriptionId: string
  settings: RunSettings
}

export function emptyScheduledTaskDraft(): ScheduledTaskDraft {
  return { goal: '', mode: 'employee', subscriptionId: '', settings: { ...defaultRunSettings(), permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } } }
}

export function authorizedScheduledModels(employees: ReadonlyArray<Pick<SiliconEmployee, 'assignedToMe' | 'availability' | 'allowedModels'>>): string[] {
  return [...new Set(employees.filter(item => item.assignedToMe && !['unavailable', 'needs-auth'].includes(item.availability)).flatMap(item => item.allowedModels))]
}

export function automaticPlanningSelection(
  employees: ReadonlyArray<Pick<SiliconEmployee, 'id' | 'assignedToMe' | 'availability' | 'allowedModels'>>,
  modelId: string,
  preferredSubscriptionId: string,
): { subscriptionId: string; modelId: string } {
  const available = employees.filter(item => item.assignedToMe && !['unavailable', 'needs-auth'].includes(item.availability) && item.allowedModels.length > 0)
  const preferred = available.find(item => item.id === preferredSubscriptionId)
  const employee = preferred?.allowedModels.includes(modelId) ? preferred : available.find(item => item.allowedModels.includes(modelId)) ?? preferred ?? available[0]
  return { subscriptionId: employee?.id ?? '', modelId: employee?.allowedModels.includes(modelId) ? modelId : employee?.allowedModels[0] ?? '' }
}

export const SCHEDULE_EXAMPLES = [
  { id: 'industry', title: '行业日报', description: '收集行业动态，整理重点与来源', prompt: '每个工作日早上 9 点，收集过去 24 小时的 AI 应用行业动态，整理重点变化、影响分析及来源链接，在工作目录生成一份 Markdown 日报。' },
  { id: 'sales', title: '销售周报', description: '汇总销售数据，交付趋势与分析', prompt: '每周五下午 5 点，读取工作目录中本周的销售数据，汇总销售额、产品表现及环比变化，生成一份 Excel 汇总表和 Markdown 分析报告。缺少源数据时说明缺失项，不编造数据。' },
  { id: 'meeting', title: '会议纪要', description: '整理会议资料，提取结论与待办', prompt: '每个工作日下午 6 点，整理工作目录中当天新增的会议记录，提取关键结论、待办事项、负责人和截止时间，生成一份 Markdown 会议纪要。未明确的信息标为待确认。' },
  { id: 'competitor', title: '竞品动态', description: '跟踪产品更新，汇总变化和机会', prompt: '每周一早上 10 点，根据工作目录中的竞品清单，收集上一周各产品的公开更新，比较功能和定位的变化，附上来源链接，生成一份 Markdown 竞品周报。没有竞品清单时说明需要补充。' },
  { id: 'documents', title: '资料索引', description: '梳理新增文件，生成可查阅的目录', prompt: '每天晚上 8 点，检查工作目录中当天新增的文档，按主题整理文件名称、相对路径和内容摘要，生成一份 Markdown 资料索引，不移动、修改或删除原始文件。' },
] as const
