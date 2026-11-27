import { scheduledAssessmentItemsSchema, type ScheduledAssessmentItem } from '../../src/shared/scheduled-tasks'

export const scheduledAssessmentPlanningRule = `可选附加顶层 assessmentItems 数组（最多 16 项，仅用于执行后展示，不改变原计划）。按用户明确要求的最终结果拆分，勿列辅助查找、工具重试或诊断。每项 source 必须原样连续摘录任务需求中的对应短语。文件项填 kind="file"、title、source、deliverableId；自动编排必须填写 nodeId；有明确内容要求时填 contentCheck。外部项填 kind="external"、title、source；只在确定时填 target（须原样出现在 source 中）、准确工具名 tool、子命令 action；发送或上传文件时填 includesFile=true。不猜测连接器、账号或对象，不因为该字段重写工作指令。`

export function parseScheduledAssessment(raw: unknown, goal: string, nodes: readonly { id: string; deliverables?: readonly { id: string }[] }[]): ScheduledAssessmentItem[] | undefined {
  const items = scheduledAssessmentItemsSchema.parse(raw)
  if (!items) return
  const seen = new Set<string>()
  const accepted = items.filter(item => {
    if (!goal.includes(item.source)) return false
    if (item.kind === 'file' && !nodes.some(node => node.id === (item.nodeId ?? 'employee-work') && node.deliverables?.some(file => file.id === item.deliverableId))) return false
    if (item.kind === 'external' && item.target && !item.source.includes(item.target)) return false
    const key = item.kind === 'file' ? JSON.stringify([item.kind, item.nodeId ?? 'employee-work', item.deliverableId]) : JSON.stringify([item.kind, item.source])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return accepted.length ? accepted : undefined
}
