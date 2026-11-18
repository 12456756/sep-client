import { Gauge } from 'lucide-react'
import { contextUsageLabel } from '../../shared/context-usage'
import { useContextUsage } from '../../features/workspace/use-context-usage'
import { IconHint } from '../enterprise/IconHint'

export function ContextUsageIndicator({ taskId, scopeKey }: { taskId?: string; scopeKey?: string }) {
  const usage = useContextUsage(taskId, scopeKey)
  if (!taskId) return null
  const label = contextUsageLabel(usage)
  return <IconHint label={label.detail} side="top"><span tabIndex={0} className="context-usage-indicator" aria-label={label.detail}>
    <Gauge size={14} aria-hidden />
    <span>{label.text}</span>
  </span></IconHint>
}
