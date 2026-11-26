import type { ScheduledOccurrence, ScheduledOperation } from '../../../shared/scheduled-tasks'
import { scheduledDingTalkActionLabels } from '../../../shared/scheduled-tasks'
import { TERMINAL_RUNS } from '../../../features/enterprise/scheduled-task-model'

const operationNames: Record<string, string> = {
  dingtalk_execute: '钉钉操作', qqmail_execute: 'QQ 邮件', feishu_execute: '飞书操作', wecom_execute: '企业微信操作',
  kdocs_execute: '金山文档操作', tencent_meeting_execute: '腾讯会议操作',
  mcp__playwright__browser_submit_scheduled_form: '网页表单',
  mcp__playwright__browser_click: '网页点击',
  mcp__playwright__browser_press_key: '网页按键',
  mcp__playwright__browser_handle_dialog: '网页对话框',
  mcp__playwright__browser_type: '网页输入',
  scheduled_external_work: '外部操作',
  mcp__playwright__browser_set_mode: '浏览器人工接管',
  scheduled_file_publish: '文件交付',
}
const reasons: Record<NonNullable<ScheduledOperation['reason']>, string> = {
  'not-attempted': '没有提交记录',
  'scope-unverified': '无法核实任务要求的操作范围',
  cancelled: '任务已停止或执行资格已变化',
  'connection-unavailable': '定时任务绑定的连接不可用',
  'target-unverified': '未能核实目标或参数',
  'platform-rejected': '连接器返回失败，未记录更具体的原因',
  'receipt-unverified': '没有可核实的成功回执',
  'submission-uncertain': '无法确认提交结果，不会自动重发',
  'file-not-published': '文件未发布到指定目录，已生成的工作产物仍可查看',
  'interaction-required': '该步骤需要登录、验证码或人工接管，定时任务不等待',
  'authentication-required': '钉钉登录已失效，请重新连接',
  'resource-not-found': '钉钉未找到目标资源，请核对资源及访问权限',
}

function dingTalkActionLabel(operation: ScheduledOperation) {
  return operation.tool === 'dingtalk_execute' && operation.dingTalkAction ? scheduledDingTalkActionLabels[operation.dingTalkAction] : undefined
}

function visibleReceipt(operation: ScheduledOperation) {
  const receipt = operation.receipt?.trim()
  return operation.tool !== 'scheduled_file_publish' && receipt !== 'browser-action-completed' ? receipt : undefined
}

function hasUsefulSuccessDetails(operation: ScheduledOperation) {
  return !!(operation.target?.trim() || visibleReceipt(operation) || dingTalkActionLabel(operation) || operation.tool === 'scheduled_file_publish' ||
    (operation.tool.startsWith('mcp__playwright__browser_') && Object.hasOwn(operationNames, operation.tool)))
}

function OperationRow({ operation, position, active }: { operation: ScheduledOperation; position: number; active: boolean }) {
  const action = dingTalkActionLabel(operation)
  const receipt = visibleReceipt(operation)
  const status = {
    submitting: active ? '正在执行' : '结果待核实',
    succeeded: operation.tool === 'scheduled_file_publish' ? '已交付' : operation.tool.startsWith('mcp__playwright__browser_') ? '网页动作已执行' : '执行成功',
    failed: '执行失败', unknown: '结果待核实', 'not-executed': '未执行',
  }[operation.status]
  return <li value={position}>
    <strong>{action ? `钉钉 · ${action}` : operationNames[operation.tool] ?? '外部操作'}
      {operation.target ? <> · <bdi>{operation.target}</bdi></> : null} · <span className={`ent-sch-operation-status is-${operation.status}`}>{status}</span></strong>
    {!action && operation.tool === 'dingtalk_execute' ? <small>未记录具体钉钉动作</small> : null}
    {operation.reason ? <small>{reasons[operation.reason]}</small> : null}
    {receipt ? <small>回执：<code className="ent-sch-path">{receipt}</code></small> : null}
  </li>
}

export function ScheduledOperationResults({ run }: { run: Pick<ScheduledOccurrence, 'operations' | 'status' | 'actionResults'> & Partial<Pick<ScheduledOccurrence, 'input'>> }) {
  const legacyActions = run.input?.actions
  const active = ['running', 'launching', 'cancelling'].includes(run.status)
  const operations = (run.operations ?? []).map((operation, index) => ({ operation, position: index + 1 }))
  const successes = operations.filter(({ operation }) => operation.status === 'succeeded' && hasUsefulSuccessDetails(operation))
  const exceptions = operations.filter(({ operation }) => operation.status !== 'succeeded')
  if (!exceptions.length && !successes.length && !legacyActions?.length) return null
  return <section aria-label="操作执行记录">
    <h4>操作执行记录</h4>
    {!!exceptions.length && <ol className="ent-sch-attempts ent-sch-operations" aria-label="未成功或尚未完成的操作">
      {exceptions.map(row => <OperationRow key={row.operation.key} {...row} active={active} />)}
    </ol>}
    {!!successes.length && <details className="ent-sch-operation-successes"><summary>成功操作（{successes.length} 项）</summary>
      <ol className="ent-sch-attempts ent-sch-operations">{successes.map(row => <OperationRow key={row.operation.key} {...row} active={active} />)}</ol>
    </details>}
    {!!legacyActions?.length && <><h4>旧版钉钉消息回执</h4><ol className="ent-sch-attempts">{legacyActions.map((action, index) => {
      const result = run.actionResults?.find(item => item.index === index)
      const label = result?.status === 'succeeded' ? '已发送' : result?.status === 'unknown' || (result?.status === 'submitting' && !active) ? '结果待核实'
        : result?.status === 'submitting' ? '正在提交' : result?.status === 'not-executed' || TERMINAL_RUNS.has(run.status) || run.status === 'review' ? '未发送' : '待发送'
      return <li key={index}><strong>{label} · <code className="ent-sch-path">{action.targetId}</code></strong><p className="ent-sch-instruction">{action.body}</p>
        {result?.receipt && <small>回执：<code className="ent-sch-path">{result.receipt}</code></small>}</li>
    })}</ol></>}
  </section>
}
