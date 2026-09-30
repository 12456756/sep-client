import { AlertCircle, ArrowDownLeft, ArrowUpRight, ChevronRight, Coins, CreditCard, Gauge, RefreshCw, Wallet, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatAllowanceValue, formatComputeAmount, formatConfiguredLimit, formatOptionalComputeAmount, formatRemainingPercent, getComputeTrendPoints, getComputeTrendTotal, selectComputeBreakdown, sumComputeAmounts } from '../../features/enterprise/compute-center-model'
import { useComputeCenter, type ComputeCenterTab } from '../../features/enterprise/use-compute-center'
import type { ComputeUsageRecord, WalletTransaction } from '../../shared/compute-credit-contracts'

type DrawerState = { title: string; children: React.ReactNode } | null

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function valueText(value: unknown, fallback = '—'): string {
  if (typeof value === 'string' && value.length) return value
  if (typeof value === 'number') return String(value)
  return fallback
}

function TrendChart({ data }: { data: unknown }): React.JSX.Element {
  const points = getComputeTrendPoints(data)
  if (!points.length) return <div className="compute-empty-chart">暂无趋势数据</div>
  const max = Math.max(...points.map(point => point.value), 1)
  const coords = points.map((point, index) => `${(index / Math.max(1, points.length - 1)) * 100},${40 - (point.value / max) * 34}`).join(' ')
  return (
    <div className="compute-trend-wrap">
      <svg className="compute-trend" viewBox="0 0 100 40" role="img" aria-label="消费趋势">
        <line x1="0" y1="39" x2="100" y2="39" className="compute-chart-grid" />
        <polyline points={coords} className="compute-chart-line" />
        {points.map((point, index) => {
          const x = (index / Math.max(1, points.length - 1)) * 100
          const y = 40 - (point.value / max) * 34
          return <circle key={`${point.label}-${index}`} cx={x} cy={y} r="1.4" className="compute-chart-dot" />
        })}
      </svg>
      <div className="compute-chart-labels"><span>{points[0].label}</span><span>{points.at(-1)?.label}</span></div>
    </div>
  )
}

function LoadingBlock(): React.JSX.Element {
  return <div className="compute-loading" role="status"><span /><span /><span /></div>
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return <div className="compute-error" role="alert"><AlertCircle size={17} /><span>{message}</span><button type="button" onClick={onRetry}>重试</button></div>
}

function DetailDrawer({ drawer, onClose }: { drawer: DrawerState; onClose: () => void }): React.JSX.Element | null {
  if (!drawer) return null
  return (
    <div className="compute-drawer-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="compute-drawer" role="dialog" aria-modal="true" aria-label={drawer.title}>
        <div className="compute-drawer-head"><div><span className="compute-eyebrow">详细信息</span><h2>{drawer.title}</h2></div><button type="button" className="compute-icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></div>
        <div className="compute-drawer-body">{drawer.children}</div>
      </aside>
    </div>
  )
}

function DetailRows({ entries }: { entries: Array<[string, string]> }): React.JSX.Element {
  return <dl className="compute-detail-list">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

type AllowanceProgressTone = 'recharge' | 'monthly' | 'daily'

function AllowanceProgress({ label, limit, used, remaining, tone, unlimited = false }: {
  label: string
  limit: string | null | undefined
  used: string | undefined
  remaining: string | null | undefined
  tone: AllowanceProgressTone
  unlimited?: boolean
}): React.JSX.Element {
  const configured = unlimited || typeof limit === 'string'
  const percent = unlimited ? null : formatRemainingPercent(limit, remaining)
  const progressWidth = unlimited ? 100 : percent ?? 0
  const limitText = unlimited ? '不限额' : formatConfiguredLimit(limit)
  const remainingText = unlimited ? '不限额' : formatOptionalComputeAmount(remaining)
  const statusText = !configured ? '未设置' : unlimited ? '不限额' : percent === null ? '—' : `剩余 ${percent.toFixed(1)}%`
  return (
    <div className={`compute-allowance-progress ${tone}${configured ? '' : ' is-unconfigured'}`}>
      <div className="compute-allowance-progress-head"><span>{label}</span><strong>{remainingText} <em>/ {limitText}</em></strong></div>
      <div className={`compute-progress ${tone}${unlimited ? ' is-unlimited' : ''}`} role="progressbar" aria-label={`${label}${!configured ? '未设置' : `，${statusText}`}`} aria-valuemin={configured && !unlimited ? 0 : undefined} aria-valuemax={configured && !unlimited ? 100 : undefined} aria-valuenow={configured && !unlimited ? percent ?? 0 : undefined}><span style={{ width: `${progressWidth}%` }} /></div>
      <div className="compute-allowance-progress-foot"><span>已用 {formatOptionalComputeAmount(used)}</span><strong>{statusText}</strong></div>
    </div>
  )
}

function OverviewTab({ state, days, trend, trendLoading, trendError, onRetryTrend, onDrawer }: {
  state: ReturnType<typeof useComputeCenter>
  days: 7 | 30 | 90
  trend: ReturnType<typeof selectComputeBreakdown>
  trendLoading: boolean
  trendError: string | null
  onRetryTrend: () => void
  onDrawer: (drawer: DrawerState) => void
}): React.JSX.Element {
  const data = state.overview.data
  if (state.overview.loading && !data) return <LoadingBlock />
  if (state.overview.error && !data) return <ErrorBlock message={state.overview.error} onRetry={state.refresh} />
  if (!data) return <div className="compute-empty">暂无算力数据</div>
  const { allowance, wallet } = data
  const remaining = formatAllowanceValue(allowance.remainingCNY)
  const monthlyLimit = allowance.monthlyLimitCNY !== undefined ? allowance.monthlyLimitCNY : allowance.period === 'MONTH' ? allowance.limitCNY : undefined
  const monthlyUsed = allowance.monthlyUsedCNY !== undefined ? allowance.monthlyUsedCNY : allowance.period === 'MONTH' ? allowance.usedCNY : undefined
  const monthlyRemaining = allowance.monthlyRemainingCNY !== undefined ? allowance.monthlyRemainingCNY : allowance.period === 'MONTH' ? allowance.remainingCNY : undefined
  const monthlyIsCurrentPeriod = allowance.period === 'MONTH' && allowance.monthlyLimitCNY === undefined
  return (
    <div className="compute-overview-grid">
      <section className="compute-card compute-allowance-card">
        <div className="compute-card-head"><div><span className="compute-eyebrow">企业充值余额</span><h2>{formatComputeAmount(allowance.topUpRemainingCNY)}</h2><p>当前成员 {allowance.name} · 跨周期保留 · 当前周期剩余 {remaining}</p></div><span className="compute-card-icon purple"><Gauge size={20} /></span></div>
        <div className="compute-allowance-progress-list" aria-label="企业额度进度">
          <AllowanceProgress label="企业充值余额" tone="recharge" limit={allowance.topUpAmountCNY} used={allowance.topUpConsumedCNY} remaining={allowance.topUpRemainingCNY} />
          <AllowanceProgress label="每月限额" tone="monthly" limit={monthlyLimit} used={monthlyUsed} remaining={monthlyRemaining} unlimited={monthlyIsCurrentPeriod && monthlyLimit === null} />
          <AllowanceProgress label="每日限额" tone="daily" limit={allowance.dailyLimitCNY} used={allowance.dailyUsedCNY} remaining={allowance.dailyRemainingCNY} />
        </div>
        <div className="compute-card-foot"><span>企业额度与充值余额分开计算</span><button type="button" className="compute-link" onClick={() => onDrawer({ title: '企业额度详情', children: <DetailRows entries={[
          ['额度上限', formatAllowanceValue(allowance.limitCNY)], ['已使用', formatComputeAmount(allowance.usedCNY)], ['可用额度', remaining], ['企业充值余额', formatComputeAmount(allowance.topUpRemainingCNY)], ['充值总额', formatOptionalComputeAmount(allowance.topUpAmountCNY)], ['充值已用', formatOptionalComputeAmount(allowance.topUpConsumedCNY)], ['每日限额', formatConfiguredLimit(allowance.dailyLimitCNY)], ['每日已用', formatOptionalComputeAmount(allowance.dailyUsedCNY)], ['每日剩余', formatOptionalComputeAmount(allowance.dailyRemainingCNY)], ['每月限额', formatConfiguredLimit(monthlyLimit)], ['每月已用', formatOptionalComputeAmount(monthlyUsed)], ['每月剩余', formatOptionalComputeAmount(monthlyRemaining)],
        ]} /> })}>查看详情 <ChevronRight size={14} /></button></div>
      </section>
      <section className="compute-card compute-wallet-card">
        <div className="compute-card-head"><div><span className="compute-eyebrow">个人钱包</span><h2>{formatComputeAmount(wallet.balanceCNY)}</h2><p>个人自费余额，不与企业额度合并</p></div><span className="compute-card-icon blue"><Wallet size={20} /></span></div>
        <div className="compute-wallet-stats"><div><span>累计充值</span><strong>{formatComputeAmount(wallet.totalDepositCNY)}</strong></div><div><span>累计消费</span><strong>{formatComputeAmount(wallet.totalConsumeCNY)}</strong></div></div>
        <div className="compute-card-foot"><button type="button" className="compute-link" onClick={() => onDrawer({ title: '个人钱包说明', children: <p className="compute-drawer-note">个人钱包用于企业额度不足时的个人自费扣费。充值与支付闭环暂未在客户端开放，钱包流水可在“个人钱包”页查看。</p> })}>了解更多 <ChevronRight size={14} /></button></div>
      </section>
      <section className="compute-card compute-trend-card"><div className="compute-card-head"><div><span className="compute-eyebrow">近 {days} 天消费总额</span><h2>{trend ? formatComputeAmount(getComputeTrendTotal(trend)) : '—'}</h2><p>管理员按企业账单统计，成员仅统计本人；额度已用只计企业承担</p></div><span className="compute-card-icon green"><Coins size={20} /></span></div>{trendLoading ? <LoadingBlock /> : trendError ? <ErrorBlock message={trendError} onRetry={onRetryTrend} /> : <TrendChart data={trend} />}</section>
      <section className="compute-note-card"><div className="compute-note-icon"><CreditCard size={18} /></div><div><strong>额度分开计算</strong><p>企业额度、管理员追加余额和个人钱包分别展示。这里的余额不是下一次调用成功的承诺，最终以 SEP 平台扣费结果为准。</p></div></section>
    </div>
  )
}

function UsageTab({ state, onDrawer }: { state: ReturnType<typeof useComputeCenter>; onDrawer: (drawer: DrawerState) => void }): React.JSX.Element {
  const page = state.usageRecords.data
  if (state.usageRecords.loading && !page) return <LoadingBlock />
  if (state.usageRecords.error && !page) return <ErrorBlock message={state.usageRecords.error} onRetry={() => state.loadUsageRecords()} />
  const records = page?.records ?? []
  return <section className="compute-list-card"><div className="compute-list-head"><div><span className="compute-eyebrow">用量账单</span><h2>消费明细</h2></div><button type="button" className="compute-icon-button" onClick={() => state.loadUsageRecords()} aria-label="刷新消费明细"><RefreshCw size={16} /></button></div>{records.length ? <div className="compute-table-wrap"><table className="compute-table"><thead><tr><th>时间</th><th>成员 / 员工 / 模型</th><th>企业承担</th><th>个人钱包</th><th>欠费</th><th>总消费</th><th /></tr></thead><tbody>{records.map((record, index) => <UsageRow key={valueText(record.id, String(index))} record={record} onOpen={() => onDrawer({ title: '消费记录详情', children: <DetailRows entries={[
    ['时间', valueText(record.createdAt)], ['成员', valueText(asRecord(record).memberName ?? asRecord(record).memberId, '当前成员')], ['硅基员工', valueText(asRecord(record).employeeName ?? asRecord(record).employeeId)], ['模型', valueText(asRecord(record).modelName ?? asRecord(record).modelId)], ['总消费', formatComputeAmount(record.costCNY ?? null)], ['企业赠送额度承担', formatComputeAmount(record.creditPaidCNY ?? null)], ['成员企业充值承担', formatComputeAmount(record.memberWalletPaidCNY ?? null)], ['企业公共钱包承担', formatComputeAmount(record.walletPaidCNY ?? null)], ['个人钱包承担', formatComputeAmount(record.personalPaidCNY ?? null)], ['欠费', formatComputeAmount(record.unpaidCNY ?? null)],
  ]} /> })} />)}</tbody></table></div> : <div className="compute-empty">暂无消费记录</div>}</section>
}

function UsageRow({ record, onOpen }: { record: ComputeUsageRecord; onOpen: () => void }): React.JSX.Element {
  const raw = asRecord(record)
  const enterprisePaid = sumComputeAmounts([record.creditPaidCNY, record.memberWalletPaidCNY, record.walletPaidCNY])
  return <tr><td>{valueText(record.createdAt)}</td><td><strong>{valueText(raw.memberName ?? raw.memberId, '当前成员')}</strong><small>{valueText(raw.employeeName ?? raw.employeeId, '算力调用')} · {valueText(raw.modelName ?? raw.modelId, '')}</small></td><td>{formatComputeAmount(enterprisePaid)}</td><td>{formatComputeAmount(record.personalPaidCNY ?? null)}</td><td>{formatComputeAmount(record.unpaidCNY ?? null)}</td><td><strong>{formatComputeAmount(record.costCNY ?? null)}</strong></td><td><button type="button" className="compute-link" onClick={onOpen}>详情</button></td></tr>
}

function WalletTab({ state, onDrawer }: { state: ReturnType<typeof useComputeCenter>; onDrawer: (drawer: DrawerState) => void }): React.JSX.Element {
  const page = state.walletTransactions.data
  if (state.walletTransactions.loading && !page) return <LoadingBlock />
  if (state.walletTransactions.error && !page) return <ErrorBlock message={state.walletTransactions.error} onRetry={() => state.loadWalletTransactions()} />
  const records = page?.records ?? []
  return <section className="compute-list-card"><div className="compute-list-head"><div><span className="compute-eyebrow">个人钱包</span><h2>钱包流水</h2></div><button type="button" className="compute-icon-button" onClick={() => state.loadWalletTransactions()} aria-label="刷新钱包流水"><RefreshCw size={16} /></button></div>{records.length ? <div className="compute-table-wrap"><table className="compute-table"><thead><tr><th>时间</th><th>类型</th><th>说明</th><th>发生金额</th><th>余额</th><th /></tr></thead><tbody>{records.map(record => <WalletRow key={record.id} record={record} onOpen={() => onDrawer({ title: '钱包流水详情', children: <DetailRows entries={[
    ['流水类型', record.type], ['说明', valueText(record.description)], ['发生金额', formatComputeAmount(record.amountCNY)], ['交易后余额', formatComputeAmount(record.balanceAfterCNY)], ['关联记录', valueText(record.relatedId)], ['时间', record.createdAt],
  ]} /> })} />)}</tbody></table></div> : <div className="compute-empty">暂无钱包流水</div>}</section>
}

function WalletRow({ record, onOpen }: { record: WalletTransaction; onOpen: () => void }): React.JSX.Element {
  const positive = record.type === 'DEPOSIT' || record.type === 'REFUND'
  return <tr><td>{record.createdAt}</td><td><span className={`compute-type ${positive ? 'positive' : 'negative'}`}>{positive ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}{record.type === 'DEPOSIT' ? '充值' : record.type === 'CONSUME' ? '消费' : record.type === 'REFUND' ? '退款' : '调整'}</span></td><td>{valueText(record.description)}</td><td className={positive ? 'compute-money-positive' : 'compute-money-negative'}>{formatComputeAmount(record.amountCNY)}</td><td>{formatComputeAmount(record.balanceAfterCNY)}</td><td><button type="button" className="compute-link" onClick={onOpen}>详情</button></td></tr>
}

export function ComputeCenterPage(): React.JSX.Element {
  const [tab, setTab] = useState<ComputeCenterTab>('overview')
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const state = useComputeCenter(tab)
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const trend = useMemo(() => selectComputeBreakdown(days, state.overview.data?.breakdown, state.breakdown.data), [days, state.breakdown.data, state.overview.data?.breakdown])
  const trendLoading = days === 30 ? state.overview.loading && !state.overview.data : state.breakdown.loading
  const trendError = days === 30 ? state.overview.error : state.breakdown.error
  const content = tab === 'overview' ? <OverviewTab state={state} days={days} trend={trend} trendLoading={trendLoading} trendError={trendError} onRetryTrend={() => days === 30 ? state.refresh() : state.loadBreakdown(days)} onDrawer={setDrawer} /> : tab === 'usage' ? <UsageTab state={state} onDrawer={setDrawer} /> : <WalletTab state={state} onDrawer={setDrawer} />
  return <div className="compute-page"><div className="compute-section-head"><div className="compute-tabs" role="tablist" aria-label="算力中心分区"><button type="button" role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>概览</button><button type="button" role="tab" aria-selected={tab === 'usage'} className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>消费明细</button><button type="button" role="tab" aria-selected={tab === 'wallet'} className={tab === 'wallet' ? 'active' : ''} onClick={() => setTab('wallet')}>个人钱包</button></div>{tab === 'overview' ? <button type="button" className="compute-refresh-button" onClick={() => { state.refresh(); if (days !== 30) state.loadBreakdown(days) }}><RefreshCw size={15} />刷新</button> : null}</div>{tab === 'overview' ? <div className="compute-range">{([7, 30, 90] as const).map(option => <button type="button" key={option} className={days === option ? 'active' : ''} onClick={() => { setDays(option); if (option !== 30) state.loadBreakdown(option) }}>{option} 天</button>)}</div> : null}{content}<DetailDrawer drawer={drawer} onClose={() => setDrawer(null)} /></div>
}
