import type { ApiDiagnostic } from '../../src/shared/api-diagnostic'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const fieldLabels: Readonly<Record<string, string>> = {
  email: '邮箱', name: '名称', description: '说明', query: '搜索词', topK: '结果数量',
  title: '标题', content: '内容', changeSummary: '变更说明', model: '模型',
  count: '生成数量', width: '宽度', height: '高度', duration: '时长', durationSeconds: '时长',
  aspectRatio: '宽高比', resolution: '分辨率',
}

function validationIssue(field: unknown, reason: unknown, code?: unknown): string | undefined {
  if (typeof field !== 'string' || typeof reason !== 'string') return undefined
  const key = /^(?:(?:requestedSpec|effectiveSpec)\.)?([A-Za-z][A-Za-z0-9]*)$/.exec(field)?.[1]
  const label = key && Object.hasOwn(fieldLabels, key) ? fieldLabels[key] : undefined
  if (/\b(?:required|missing)\b|收到\s*undefined|不能为空|必填/i.test(reason) || /received undefined/i.test(reason)) return label ? `请填写${label}` : '缺少必填项'
  if (/expected (?:a )?(?:number|integer)|必须(?:是|为)(?:数字|整数)/i.test(reason)) return label ? `${label}必须为数字` : '有字段必须填写数字'
  if (/expected (?:a )?string|必须(?:是|为)(?:字符串|文本)/i.test(reason)) return label ? `${label}必须为文本` : '有字段必须填写文本'
  if (/too (?:small|big|long|short)|at (?:least|most)|超出|至少|至多|不得超过/i.test(reason) || code === 'too_small' || code === 'too_big') return label ? `${label}超出允许范围` : '有字段超出允许范围'
  if (key === 'email' && /invalid email|邮箱格式/i.test(reason)) return '邮箱格式无效'
  return label ? `${label}不符合要求` : undefined
}

/** Translate recognized facts only; never interpolate raw response text, identifiers, or field paths. */
export function platformDiagnosticMessage(diagnostic: ApiDiagnostic | undefined, status = diagnostic?.httpStatus): string | undefined {
  if (!diagnostic) return undefined
  if (status === 400 || status === 422) {
    const body = record(diagnostic.body)
    const wrapped = record(body.body)
    const errors = [record(body.error), record(wrapped.error)]
    const issues = [...[body.errors, wrapped.errors, ...errors.map(error => error.errors)].flatMap(value => Array.isArray(value) ? value : []),
      ...errors, body, wrapped].map(record)
    const messages = issues.map(issue => validationIssue(issue.field, issue.reason ?? issue.message, issue.code))
    messages.push(validationIssue(diagnostic.field, diagnostic.message))
    const unique = [...new Set(messages.filter((message): message is string => message !== undefined))]
    if (unique.length > 0) return `${unique.slice(0, 3).join('；')}，请修改后重试。`
  }
  if (status === 409 && diagnostic.source !== 'upstream') {
    if (diagnostic.code === 'STALE_CLIENT_RUN' || /\bstale client run\b/i.test(diagnostic.message ?? '')) return '工作运行记录已更新，本次请求对应旧记录，请刷新后重试。'
    if (/\b(?:event sequence|event seq)\b/i.test(diagnostic.message ?? '') || diagnostic.code === 'EVENT_SEQUENCE_CONFLICT') return '同步事件的顺序已变化，请刷新工作记录后重试。'
  }
  return undefined
}
