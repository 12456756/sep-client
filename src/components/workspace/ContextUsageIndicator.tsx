import * as Tooltip from '@radix-ui/react-tooltip'
import { contextUsageLabel, formatContextTokens } from '../../shared/context-usage'
import { useContextUsage } from '../../features/workspace/use-context-usage'

const categories = [
  ['system', '系统提示词'],
  ['tools', '工具定义'],
  ['messages', '对话消息'],
] as const

export function ContextUsageIndicator({ taskId, scopeKey }: { taskId?: string; scopeKey?: string }) {
  const usage = useContextUsage(taskId, scopeKey)
  if (!taskId) return null
  const label = contextUsageLabel(usage)
  const fill = Math.min(100, usage?.percent ?? 0)
  const breakdown = usage?.breakdown
  const total = usage && usage.percent !== null ? usage.tokens : null
  const detail = breakdown ? `${label.detail} ${categories.map(([key, name]) => `${name}约 ${formatContextTokens(breakdown[key])} Token`).join('；')}` : label.detail
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
        <Tooltip.Content className="context-usage-card" side="top" align="end" sideOffset={10} collisionPadding={12} aria-label={detail}>
          <div className="context-usage-heading">
            <span>上下文已用 <strong>{label.text}</strong></span>
            {usage && total !== null && <strong className="context-usage-total">~{formatContextTokens(total)} / {formatContextTokens(usage.contextWindow)}<span> Token</span></strong>}
          </div>
          <div className="context-usage-track" aria-hidden>
            {breakdown && total ? categories.map(([key]) => breakdown[key] > 0 && (
              <span key={key} data-kind={key} style={{ width: `${breakdown[key] / total * fill}%` }} />
            )) : <span data-kind="total" style={{ width: `${fill}%` }} />}
          </div>
          {breakdown ? <dl className="context-usage-breakdown">
            {categories.map(([key, name]) => <div key={key}>
              <dt><span data-kind={key} aria-hidden />{name}</dt>
              <dd>~{formatContextTokens(breakdown[key])}</dd>
            </div>)}
          </dl> : <p className="context-usage-note">{total !== null ? '暂无分项统计' : '暂无用量数据'}</p>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
}
