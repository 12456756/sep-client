import { MAX_DIAGNOSTIC_MODEL_STATUSES, MAX_DIAGNOSTIC_TOOL_FAILURES, type DiagnosticEvidence, type DiagnosticModelStatus, type DiagnosticToolFailureHistory } from '../domain/arrangement-diagnostic'
import type { ModelTraceRecorder } from '../domain/model-trace'
import { pickDiagnosticEvidence, workApiDiagnostic, workDiagnosticText } from '../errors/arrangement-diagnostic'

const metricNames = ['失败阶段', '传输阶段', '错误类型', '错误信息', '错误代码', '底层错误类型', '底层错误码', '底层原因',
  '平台请求标识', '响应状态码', '已接收字节数', '总耗时毫秒', '网络首字节毫秒', '距离最后收包毫秒', '是否主动取消',
  '响应头耗时毫秒', '首个SDK流事件毫秒', '首次思考毫秒', '首次正文毫秒', '发送状态', '结束原因', 'SDK错误信息'] as const

function decode(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 256 * 1024) return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function decodeCauses(value: unknown): DiagnosticModelStatus['causes'] {
  const entries = decode(value)
  if (!Array.isArray(entries)) return undefined
  return entries.slice(0, 16).flatMap(item => item && typeof item === 'object' ? [{
    name: workDiagnosticText(item.name), message: workDiagnosticText(item.message), code: workDiagnosticText(item.code),
  }] : [])
}

export function trackModelFailureEvidence(trace?: ModelTraceRecorder) {
  let request: DiagnosticEvidence | undefined
  let failure: DiagnosticEvidence | undefined
  let requestNumber = -1
  let total = 0
  const entries: DiagnosticModelStatus[] = []
  let toolTotal = 0
  const toolEntries: DiagnosticToolFailureHistory['entries'] = []
  const record: ModelTraceRecorder = async entry => {
    const { metrics } = entry
    if (entry.kind === 'tool' && metrics?.['失败工具'] && typeof metrics['失败工具'] === 'string') {
      const elapsed = metrics['工具耗时毫秒']
      toolEntries.push({ name: workDiagnosticText(metrics['失败工具'], 128)!, callId: workDiagnosticText(metrics['工具调用标识'], 128),
        timestamp: entry.timestamp ?? Date.now(), reason: workDiagnosticText(metrics['工具失败分类'], 128),
        message: workDiagnosticText(metrics['工具错误信息']),
        elapsedMs: typeof elapsed === 'number' && Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : undefined })
      if (toolEntries.length > MAX_DIAGNOSTIC_TOOL_FAILURES) toolEntries.shift()
      toolTotal++
    }
    if (entry.kind === 'status' && entry.requestNumber !== undefined && Number.isSafeInteger(entry.requestNumber) && entry.requestNumber >= 0) {
      if (entry.requestNumber > requestNumber) {
        requestNumber = entry.requestNumber
        request = failure = undefined
      }
      if (metrics) {
        const diagnostic = workApiDiagnostic(decode(metrics['诊断']))
        const relatedDiagnostic = workApiDiagnostic(decode(metrics['关联诊断']))
        const detail = diagnostic ?? relatedDiagnostic
        const current = pickDiagnosticEvidence({ requestId: metrics['平台请求标识'], httpStatus: metrics['响应状态码'] })
        const failed = pickDiagnosticEvidence({ code: detail?.code ?? metrics['底层错误码'] ?? metrics['错误代码'],
          httpStatus: detail?.httpStatus ?? current?.httpStatus, requestId: detail?.sepRequestId ?? current?.requestId })
        if (entry.requestNumber === requestNumber) {
          request = current ?? request
          if (detail || metrics['传输阶段']) failure = failed ?? failure
        }
        if (detail || metrics['失败阶段'] || metrics['传输阶段'] || metrics['结束原因'] === 'error' || metrics['结束原因'] === 'aborted') {
          const selected: DiagnosticModelStatus['metrics'] = {}
          for (const key of metricNames) {
            const value = metrics[key]
            if (typeof value === 'number' && Number.isFinite(value)) selected[key] = value
            else if (typeof value === 'string') selected[key] = workDiagnosticText(value)!
          }
          entries.push({ requestNumber: entry.requestNumber, timestamp: entry.timestamp ?? Date.now(), evidence: failed ?? current,
            metrics: selected, diagnostic, relatedDiagnostic, causes: decodeCauses(metrics['原因链']) })
          if (entries.length > MAX_DIAGNOSTIC_MODEL_STATUSES) entries.shift()
          total++
        }
      }
    }
    await trace?.(entry)
  }
  return { record, evidence: () => failure ?? request, history: () => total ? { total, entries: [...entries] } : undefined,
    toolFailures: () => toolTotal ? { total: toolTotal, entries: [...toolEntries] } : undefined }
}
