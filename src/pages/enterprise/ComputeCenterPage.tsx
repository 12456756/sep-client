import { AlertCircle, ArrowDownLeft, ArrowUpRight, ChevronRight, Coins, CreditCard, Gauge, RefreshCw, Wallet, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatAllowanceValue, formatComputeAmount, formatComputePercent } from '../../features/enterprise/compute-center-model'
import { useComputeCenter, type ComputeCenterTab } from '../../features/enterprise/use-compute-center'
import type { ComputeUsageRecord, WalletTransaction } from '../../shared/compute-credit-contracts'

interface TrendPoint { label: string; value: number }
type DrawerState = { title: string; children: React.ReactNode } | null

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function valueText(value: unknown, fallback = '—'): string {
  if (typeof value === 'string' && value.length) return value
  if (typeof value === 'number') return String(value)
  return fallback
}

function trendPoints(value: unknown): TrendPoint[] {
  const source = asRecord(value)
  const rows = Array.isArray(source.series) ? source.series : Array.isArray(source.daily) ? source.daily : []
  return rows.flatMap((row, index) => {
    const item = asRecord(row)
    const raw = item.costCNY ?? item.amountCNY ?? item.value ?? item.totalCNY
    const number = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN
    return Number.isFinite(number) ? [{ label: valueText(item.date ?? item.label, `${index + 1}`), value: number }] : []
  })
}

function TrendChart({ data }: { data: unknown }): React.JSX.Element {
  const points = trendPoints(data)
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

function OverviewTab({ state, days, onDrawer }: { state: ReturnType<typeof useComputeCenter>; days: 7 | 30 | 90; onDrawer: (drawer: DrawerState) => void }): React.JSX.Element {
  const data = state.overview.data
  if (state.overview.loading && !data) return <LoadingBlock />
  if (state.overview.error && !data) return <ErrorBlock message={state.overview.error} onRetry={state.refresh} />
  if (!data) return <div className="compute-empty">暂无算力数据</div>
  const { allowance, wallet, breakdown } = data
  const percent = formatComputePercent(allowance.usedPct)
  const remaining = formatAllowanceValue(allowance.remainingCNY)
  return (
    <div className="compute-overview-grid">
      <section className="compute-card compute-allowance-card">
        <div className="compute-card-head"><div><span className="compute-eyebrow">企业额度</span><h2>{remaining}</h2><p>{allowance.periodLabel ?? allowance.period}额度 · 已使用 {formatComputeAmount(allowance.usedCNY)}</p></div><span className="compute-card-icon purple"><Gauge size={20} /></span></div>
        <div className="compute-progress-row"><div className="compute-progress"><span style={{ width: `${percent}%` }} /></div><strong>{allowance.usedPct === null ? '不限额' : `${percent.toFixed(1)}%`}</strong></div>
        <div className="compute-card-foot"><span>追加余额 {formatComputeAmount(allowance.topUpRemainingCNY)}</span><button type="button" className="compute-link" onClick={() => onDrawer({ title: '企业额度详情', children: <DetailRows entries={[
          ['额度上限', formatAllowanceValue(allowance.limitCNY)], ['已使用', formatComputeAmount(allowance.usedCNY)], ['可用额度', remaining], ['追加余额', formatComputeAmount(allowance.topUpRemainingCNY)], ['日额度', formatAllowanceValue(allowance.dailyLimitCNY)], ['月额度', formatAllowanceValue(allowance.monthlyLimitCNY)],
        ]} /> })}>查看详情 <ChevronRight size={14} /></button></div>
      </section>
      <section className="compute-card compute-wallet-card">
        <div className="compute-card-head"><div><span className="compute-eyebrow">个人钱包</span><h2>{formatComputeAmount(wallet.balanceCNY)}</h2><p>个人自费余额，不与企业额度合并</p></div><span className="compute-card-icon blue"><Wallet size={20} /></span></div>
        <div className="compute-wallet-stats"><div><span>累计充值</span><strong>{formatComputeAmount(wallet.totalDepositCNY)}</strong></div><div><span>累计消费</span><strong>{formatComputeAmount(wallet.totalConsumeCNY)}</strong></div></div>
        <div className="compute-card-foot"><button type="button" className="compute-link" onClick={() => onDrawer({ title: '个人钱包说明', children: <p className="compute-drawer-note">个人钱包用于企业额度不足时的个人自费扣费。充值与支付闭环暂未在客户端开放，钱包流水可在“个人钱包”页查看。</p> })}>了解更多 <ChevronRight size={14} /></button></div>
      </section>
      <section className="compute-card compute-trend-card"><div className="compute-card-head"><div><span className="compute-eyebrow">近 {days} 天消费</span><h2>{formatComputeAmount(valueText(asRecord(breakdown).totals && asRecord(asRecord(breakdown).totals).costCNY, '0'))}</h2></div><span className="compute-card-icon green"><Coins size={20} /></span></div><TrendChart data={breakdown} /></section>
      <section className="compute-note-card"><div className="compute-note-icon"><CreditCard size={18} /></div><div><strong>额度分开计算</strong><p>企业额度、管理员追加余额和个人钱包分别展示。这里的余额不是下一次调用成功的承诺，最终以 SEP 平台扣费结果为准。</p></div></section>
    </div>
  )
}

function UsageTab({ state, onDrawer }: { state: ReturnType<typeof useComputeCenter>; onDrawer: (drawer: DrawerState) => void }): React.JSX.Element {
  const page = state.usageRecords.data
  if (state.usageRecords.loading && !page) return <LoadingBlock />
  if (state.usageRecords.error && !page) return <ErrorBlock message={state.usageRecords.error} onRetry={() => state.loadUsageRecords()} />
  const records = page?.records ?? []
  return <section className="compute-list-card"><div className="compute-list-head"><div><span className="compute-eyebrow">用量账单</span><h2>消费明细</h2></div><button type="button" className="compute-icon-button" onClick={() => state.loadUsageRecords()} aria-label="刷新消费明细"><RefreshCw size={16} /></button></div>{records.length ? <div className="compute-table-wrap"><table className="compute-table"><thead><tr><th>时间</th><th>员工 / 模型</th><th>企业额度</th><th>个人钱包</th><th>总消费</th><th /></tr></thead><tbody>{records.map((record, index) => <UsageRow key={valueText(record.id, String(index))} record={record} onOpen={() => onDrawer({ title: '消费记录详情', children: <DetailRows entries={[
    ['时间', valueText(record.createdAt)], ['员工', valueText(asRecord(record).employeeName ?? asRecord(record).employeeId)], ['模型', valueText(asRecord(record).modelName ?? asRecord(record).modelId)], ['总消费', formatComputeAmount(record.costCNY ?? null)], ['企业额度承担', formatComputeAmount(record.creditPaidCNY ?? null)], ['个人钱包承担', formatComputeAmount(record.personalPaidCNY ?? record.walletPaidCNY ?? null)],
  ]} /> })} />)}</tbody></table></div> : <div className="compute-empty">暂无消费记录</div>}</section>
}

function UsageRow({ record, onOpen }: { record: ComputeUsageRecord; onOpen: () => void }): React.JSX.Element {
  const raw = asRecord(record)
  return <tr><td>{valueText(record.createdAt)}</td><td><strong>{valueText(raw.employeeName ?? raw.employeeId, '算力调用')}</strong><small>{valueText(raw.modelName ?? raw.modelId, '')}</small></td><td>{formatComputeAmount(record.creditPaidCNY ?? null)}</td><td>{formatComputeAmount(record.personalPaidCNY ?? record.walletPaidCNY ?? null)}</td><td><strong>{formatComputeAmount(record.costCNY ?? null)}</strong></td><td><button type="button" className="compute-link" onClick={onOpen}>详情</button></td></tr>
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
  const trend = useMemo(() => (days === 30 ? state.overview.data?.breakdown ?? state.breakdown.data : state.breakdown.data ?? state.overview.data?.breakdown), [days, state.breakdown.data, state.overview.data?.breakdown])
  const content = tab === 'overview' ? <OverviewTab state={{ ...state, overview: { ...state.overview, data: state.overview.data ? { ...state.overview.data, breakdown: trend ?? state.overview.data.breakdown } : null } }} days={days} onDrawer={setDrawer} /> : tab === 'usage' ? <UsageTab state={state} onDrawer={setDrawer} /> : <WalletTab state={state} onDrawer={setDrawer} />
  return <div className="compute-page"><div className="compute-section-head"><div className="compute-tabs" role="tablist" aria-label="算力中心分区"><button type="button" role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>概览</button><button type="button" role="tab" aria-selected={tab === 'usage'} className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>消费明细</button><button type="button" role="tab" aria-selected={tab === 'wallet'} className={tab === 'wallet' ? 'active' : ''} onClick={() => setTab('wallet')}>个人钱包</button></div>{tab === 'overview' ? <button type="button" className="compute-refresh-button" onClick={() => { state.refresh(); if (days !== 30) state.loadBreakdown(days) }}><RefreshCw size={15} />刷新</button> : null}</div>{tab === 'overview' ? <div className="compute-range">{([7, 30, 90] as const).map(option => <button type="button" key={option} className={days === option ? 'active' : ''} onClick={() => { setDays(option); if (option !== 30) state.loadBreakdown(option) }}>{option} 天</button>)}</div> : null}{content}<DetailDrawer drawer={drawer} onClose={() => setDrawer(null)} /></div>
}
