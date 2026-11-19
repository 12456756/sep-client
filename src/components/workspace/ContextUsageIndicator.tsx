import * as Tooltip from '@radix-ui/react-tooltip'
import { contextUsageLabel, formatContextTokens } from '../../shared/context-usage'
import { useContextUsage } from '../../features/workspace/use-context-usage'

export function ContextUsageIndicator({ taskId, scopeKey }: { taskId?: string; scopeKey?: string }) {
  const usage = useContextUsage(taskId, scopeKey)
  if (!taskId) return null
  const label = contextUsageLabel(usage)
  const fill = Math.min(100, usage?.percent ?? 0)
  const remaining = usage?.percent == null ? null : Math.max(0, 100 - Math.round(usage.percent))
  return <Tooltip.Provider delayDuration={180}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span tabIndex={0} className="context-usage-indicator" aria-label={label.detail}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden className="context-usage-ring">
            <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeOpacity=".23" strokeWidth="3" />
            {fill > 0 && <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="3" pathLength="100" strokeDasharray={`${fill} 100`} strokeLinecap="round" transform="rotate(-90 10 10)" />}
          </svg>
          <span>{label.text}</span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="context-usage-card" side="top" sideOffset={8} collisionPadding={12} aria-label={label.detail}>
          <div className="context-usage-heading">上下文窗口</div>
          {usage?.tokens != null && remaining !== null ? <>
            <div><strong>已用 {label.text}</strong>（剩余 {remaining}%）</div>
            <div className="context-usage-note">约 {formatContextTokens(usage.tokens)} / {formatContextTokens(usage.contextWindow)} Token</div>
          </> : <div className="context-usage-note">暂无用量数据</div>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
}
