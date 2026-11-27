import type { ScheduledOccurrence } from '../../shared/scheduled-tasks'
import { scheduledAssessmentItemsSchema } from '../../shared/scheduled-tasks'
import type { ArrangementExecutionSnapshot } from '../../shared/types'
import type { ScheduledAttachmentEvidence } from './scheduled-delivery-evidence'
import { TERMINAL_RUNS } from './scheduled-task-model'

interface AssessmentRow {
  title: string
  label: '已核验' | '文件已验收' | '待核验' | '未达成'
  detail: string
}

function assessedReport(run: ScheduledOccurrence, execution?: ArrangementExecutionSnapshot | null) {
  const files = (run.plan.assessmentItems ?? []).filter(item => item.kind === 'file')
  // Without an explicit attachment mapping, only a single file outcome can be linked.
  return files.length === 1 ? execution?.nodes.find(node => node.nodeId === (files[0].nodeId ?? 'employee-work'))
    ?.finalFiles.find(file => file.id === files[0].deliverableId) : undefined
}

export function scheduledDeliveryRunId(run: ScheduledOccurrence, execution?: ArrangementExecutionSnapshot | null): string | undefined {
  if ((!TERMINAL_RUNS.has(run.status) && run.status !== 'review') ||
    !run.plan.assessmentItems?.some(item => item.kind === 'external' && item.includesFile) ||
    !run.operations?.some(operation => operation.tool === 'dingtalk_execute' && operation.dingTalkAction === 'chat +messages-send' && operation.status === 'succeeded')) return
  return assessedReport(run, execution)?.nodeRunId
}

/** A read-only projection. It is never used by the dispatcher or execution runtime. */
export function assessScheduledRun(run: ScheduledOccurrence, execution?: ArrangementExecutionSnapshot | null,
  evidence: readonly ScheduledAttachmentEvidence[] = [], loading = false): AssessmentRow[] {
  if (!TERMINAL_RUNS.has(run.status) && run.status !== 'review') return []
  const items = scheduledAssessmentItemsSchema.parse(run.plan.assessmentItems)
  if (!items) return []
  const report = assessedReport(run, execution)
  return items.map(item => {
    const row = (label: AssessmentRow['label'], detail: string): AssessmentRow => ({ title: item.title, label, detail })
    if (item.kind === 'file') {
      const node = execution?.nodes.find(node => node.nodeId === (item.nodeId ?? 'employee-work'))
      const file = node?.finalFiles.find(file => file.id === item.deliverableId)
      if (file) return item.contentCheck
        ? row('文件已验收', `${file.path}；内容要求未独立复核。`)
        : row('已核验', `文件 ${file.path} 已通过节点验收`)
      if (node?.status === 'failed' || node?.status === 'blocked') return row('未达成', '对应节点未交付通过验收的文件')
      return row('待核验', '未取得对应文件的验收记录')
    }
    // Command tools can perform several different operations. Match the command when known.
    const matches = item.tool ? (run.operations ?? []).filter(operation => operation.tool === item.tool &&
      (item.action ? operation.dingTalkAction === item.action : !operation.dingTalkAction)) : []
    const exact = item.target ? matches.filter(operation => operation.target === item.target) : []
    if (exact.some(operation => operation.status === 'unknown' || operation.status === 'submitting')) {
      return row('待核验', '提交结果尚未确认')
    }
    if (item.includesFile && report && /发送|发给/.test(item.source)) {
      const matched = evidence.filter(receipt => (!item.tool || receipt.tool === item.tool) && (!item.action || receipt.action === item.action) &&
        (item.tool || item.source.includes('钉钉')) &&
        (item.target ? receipt.target === item.target : item.source.includes(`向${receipt.target}发送`) ||
          item.source.split(/[,，。；、\s]/u).some(phrase => phrase.endsWith(`发送给${receipt.target}`) || phrase.endsWith(`发给${receipt.target}`))) &&
        receipt.nodeRunId === report.nodeRunId && receipt.path === report.path.replaceAll('\\', '/').replace(/^\.\//, '') &&
        receipt.size === report.size)
      if (new Set(matched.map(receipt => receipt.target)).size === 1) {
        return row('已核验', `发送回执已确认：${report.path} 已发送给${matched[0].target}，不代表已读。`)
      }
      if (loading) return row('待核验', '正在读取本次发送回执。')
    }
    const success = exact.find(operation => operation.status === 'succeeded' && operation.receipt?.trim() && operation.receipt !== 'browser-action-completed')
    if (success && !item.includesFile) return row('已核验', '本次有匹配操作的成功回执')
    if (success || exact.some(operation => operation.status === 'succeeded')) {
      return row('待核验', item.includesFile ? '有成功操作记录，尚未核验交付的是本次文件' : '有成功操作记录，尚未取得可核验的回执')
    }
    if (exact.some(operation => operation.status === 'failed' || operation.status === 'not-executed')) {
      return row('待核验', '有失败或未执行记录，尚未核实目标最终结果')
    }
    if (matches.some(operation => operation.status === 'succeeded')) return row('待核验', '有同类成功操作，尚未核实目标或文件')
    return row('待核验', '未取得能匹配该验收项的操作证据')
  })
}
