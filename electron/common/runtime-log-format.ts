import type { LogRecord } from './logger'
import { redactModelTraceText } from './redact'

const phases: Record<string, string> = {
  initialization: '初始化', 'provider-request': '等待模型响应', 'response-assembly': '响应整理',
  'json-extraction': 'JSON 提取', 'json-parse': 'JSON 解析', 'output-validation': '输出结构校验',
  'employee-validation': '员工校验', 'model-validation': '模型权限校验', 'dag-validation': '依赖关系校验',
  finalization: '结果保存', cleanup: '资源释放', authorized: '第一阶段 · 已授权员工匹配',
  'round-1': '第一阶段 · 已授权员工匹配', 'round-2': '第二阶段 · 企业员工推荐', 'round-3': '第三阶段 · 平台员工推荐',
  enterprise: '第二阶段 · 企业员工推荐', platform: '第三阶段 · 平台员工推荐',
}
const titles: Record<string, string> = {
  'model request overview': '模型请求已发送', 'model response completed': '模型响应完成',
  'model stream progress': '模型响应进度', 'provider response received': '收到响应头',
  'planning phase started': '规划环节开始', 'planning phase completed': '规划环节完成',
  'planning completed': '规划完成', 'planning phase failed': '规划失败', 'planning failed': '规划失败',
  'planning cancelled': '规划已取消', 'planning result discarded': '规划结果已丢弃',
  'planning output rejected; requesting correction': '规划校验失败，继续修正',
  'run started': '模型会话开始', 'run completed': '模型会话结束', 'run failed': '模型会话失败',
  'run setup failed': '模型会话初始化失败', 'model request prepared': '模型请求准备完成',
  'model trace document': '详细日志已创建', 'model trace write failed': '详细日志写入失败',
  'delivery validation passed': '交付校验通过', 'delivery validation failed': '交付校验失败，继续修正',
  'business validation passed': '业务验收通过', 'business validation failed': '业务验收失败，继续修正',
  'tool execution started': '工具执行开始', 'tool execution completed': '工具执行结束',
  'auto_retry_start': '模型自动重试', 'auto_retry_end': '模型重试结束',
  'auto_compaction_start': '上下文压缩开始', 'auto_compaction_end': '上下文压缩结束',
  'compaction_start': '上下文压缩开始', 'compaction_end': '上下文压缩结束',
  'summarization_retry_scheduled': '摘要重试等待',
  'client monitor pending operation retained': '客户端同步待重试',
  'conversation run failed': '对话执行失败', 'conversation finalization failed': '对话结果保存失败',
  'provider returned unavailable tool calls': '模型返回了不可用工具', 'common skill unavailable': '通用 Skill 不可用',
}
const labels: Record<string, string> = {
  taskTitle: '任务', nodeTitle: '节点', phase: '环节', employeeScope: '员工匹配阶段',
  model: '模型', modelId: '模型', requestNumber: '本会话请求次数',
  elapsedMs: '耗时', firstEventMs: '首个 SDK 流事件', firstThinkingMs: '首次思考', firstTextMs: '首次正文',
  providerStatus: '响应状态', statusCode: '状态码', stopReason: '结束原因',
  nodeCount: '执行节点数', completedNodeCount: '已生成节点数', unresolvedStepCount: '未匹配步骤数',
  employeeCount: '目录员工数', toolCount: '工具数', toolName: '工具', success: '成功',
  status: '状态', reason: '原因', error: '错误', cause: '原因', errorCode: '错误代码', path: '日志位置', delayMs: '等待时间',
  attempt: '尝试次数', validationKind: '校验类型',
  kind: '操作类型',
  stage: '当前环节',
}
const values: Record<string, string> = {
  stop: '正常结束', length: '达到输出上限', error: '错误', aborted: '已中断', toolUse: '调用工具',
  ready: '可执行', create: '创建同步记录', status: '同步状态',
  submission: '提交格式', files: '实际文件',
}

export function runtimePhaseLabel(phase: string): string { return phases[phase] ?? phase }

export function formatDuration(ms: number): string {
  const seconds = (ms % 60000 / 1000).toFixed(3)
  return ms >= 60000 ? `${Math.floor(ms / 60000)} 分 ${seconds} 秒` : `${seconds} 秒`
}

/** Return null for legacy body logs, regardless of the configured console level. */
export function formatRuntimeLog(record: LogRecord): string | null | undefined {
  if (/^model input added:|^model response (thinking|content)$|^model request tool list$/.test(record.message)) return null
  if (!/^(pi-gateway|pi-task-worker|arrangement-planner|arrangement-service|model-trace|arrangement-executor|client-monitor|task-runtime|conversation-executor|arrangement)(\.|$)/.test(record.scope)) return undefined
  if ((record.level === 'trace' || record.level === 'debug') && !titles[record.message]) return null
  const title = titles[record.message] ?? (record.level === 'warn' ? '运行提醒' : record.level === 'error' ? '运行错误' : '运行状态')
  const time = new Date(record.timestamp).toTimeString().slice(0, 8)
  const lines = [`\n──────── ${time}｜${title} ────────`]
  if (record.scope === 'client-monitor') lines.push('类别：客户端同步（独立于模型请求）')
  for (const [key, rawValue] of Object.entries(record.fields)) {
    const value = typeof rawValue === 'string' && (key === 'error' || key === 'cause')
      ? redactModelTraceText(rawValue) : rawValue
    const label = labels[key]
    if (!label || value === undefined || value === null) continue
    const display = typeof value === 'number' && key.endsWith('Ms') ? formatDuration(value)
      : typeof value === 'boolean' ? (value ? '是' : '否')
        : typeof value === 'string' ? (phases[value] ?? values[value] ?? value).replace(/[\r\n]+/g, ' ').slice(0, 200)
          : typeof value === 'number' ? String(value) : undefined
    if (display !== undefined) lines.push(`${label}：${display}`)
  }
  const usage = record.fields.usage as Record<string, unknown> | undefined
  if (usage) lines.push(`Token 用量：输入 ${usage.input ?? '未提供'}｜输出 ${usage.output ?? '未提供'}｜总计 ${usage.total ?? '未提供'}｜缓存读取 ${usage.cacheRead ?? '未提供'}｜缓存写入 ${usage.cacheWrite ?? '未提供'}`)
  if (lines.length === 1) lines.push(`来源：${record.scope}`)
  return `${lines.join('\n')}\n────────────────────────────────`
}
