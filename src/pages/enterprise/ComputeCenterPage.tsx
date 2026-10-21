import { AlertCircle, ChevronRight, Coins, Gauge, Info, RefreshCw, Wallet, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatAllowanceValue, formatComputeAmount, formatConfiguredLimit, formatOptionalComputeAmount, formatRemainingPercent, getComputeTrendPoints, getComputeTrendTotal, selectComputeBreakdown } from '../../features/enterprise/compute-center-model'
import { useComputeCenter, type ComputeCenterTab } from '../../features/enterprise/use-compute-center'
import { ComputeUsageTab, ComputeWalletTab, type ComputeDetail } from '../../components/enterprise/ComputeUsageTables'
import { ComputeUsageAnalysis } from '../../components/enterprise/ComputeUsageAnalysis'

type DrawerState = { title: string; children: React.ReactNode } | null

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
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!drawer) return
    const previous = document.activeElement
    const element = panel.current
    element?.querySelector<HTMLButtonElement>('button')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = element?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex="0"]')
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [drawer, onClose])
  if (!drawer) return null
  return (
    <div className="compute-drawer-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <aside ref={panel} className="compute-drawer" role="dialog" aria-modal="true" aria-label={drawer.title}>
        <div className="compute-drawer-head"><div><h2>{drawer.title}</h2></div><button type="button" className="compute-icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></div>
        <div className="compute-drawer-body">{drawer.children}</div>
      </aside>
    </div>
  )
}

function DetailRows({ entries }: { entries: Array<[string, string]> }): React.JSX.Element {
  return <dl className="compute-detail-list">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

type AllowanceProgressTone = 'recharge' | 'monthly' | 'daily'

const ALLOWANCE_TONE_LABEL: Record<AllowanceProgressTone, string> = {
  recharge: '充值余额',
  monthly: '每月额度',
  daily: '每日额度',
}

/**
 * 一条额度进度。
 *
 * 原来把「已用 ¥x」「剩余 99.8%」拆成上下两行小字，再配上「¥x / ¥y」，
 * 一条进度条要读三段文字。这里压成一行：左边是已用，右边是剩余比例，
 * 上限放进 title —— 上限是低频信息，不该常驻在界面上。
 */
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
  // 进度条画的是「已用比例」，剩余 100% 对应已用 0%，空槽才是正确表达。
  const usedWidth = unlimited ? 0 : percent === null ? 0 : Math.max(0, Math.min(100, 100 - percent))
  const limitText = unlimited ? '不限额' : formatConfiguredLimit(limit)
  const statusText = !configured ? '未设置' : unlimited ? '不限额' : percent === null ? '—' : `剩余 ${percent.toFixed(1)}%`

  return (
    <div className={`compute-allowance-progress ${tone}${configured ? '' : ' is-unconfigured'}`}>
      <div className="compute-allowance-progress-head">
        <span>{label}</span>
        <strong>{statusText}</strong>
      </div>
      <div
        className={`compute-progress ${tone}${unlimited ? ' is-unlimited' : ''}`}
        role="progressbar"
        aria-label={`${ALLOWANCE_TONE_LABEL[tone]}${!configured ? '未设置' : `，已用 ${formatOptionalComputeAmount(used)}，${statusText}`}`}
        aria-valuemin={configured && !unlimited ? 0 : undefined}
        aria-valuemax={configured && !unlimited ? 100 : undefined}
        aria-valuenow={configured && !unlimited ? usedWidth : undefined}
        title={unlimited ? `${label}：不限额` : `${label}：已用 ${formatOptionalComputeAmount(used)} / ${limitText}`}
      >
        <span style={{ width: `${usedWidth}%` }} />
      </div>
    </div>
  )
}

/**
 * 概览：先给结论，再给明细。
 *
 * 层次是「一句话结论 → 三个核心数字 → 明细与趋势」：
 * 顶部通栏只回答「我有多少钱、花了多少」；下半区才展开额度的三条进度和消费曲线。
 *
 * 原先散在卡片副标题和 footer 里的大量说明文字（跨周期保留、分开计算、
 * 以平台扣费为准等）属于解释性口径，不是每次都要读的信息，统一收进
 * 标题旁的 info 提示和「查看详情」抽屉里。
 */
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
  const trendTotal = !trendLoading && !trendError && trend ? formatOptionalComputeAmount(getComputeTrendTotal(trend)) : '—'

  const allowanceDetail = (
    <DetailRows entries={[
      ['额度上限', formatAllowanceValue(allowance.limitCNY)], ['已使用', formatComputeAmount(allowance.usedCNY)], ['可用额度', remaining], ['企业充值余额', formatComputeAmount(allowance.topUpRemainingCNY)], ['充值总额', formatOptionalComputeAmount(allowance.topUpAmountCNY)], ['充值已用', formatOptionalComputeAmount(allowance.topUpConsumedCNY)], ['每日限额', formatConfiguredLimit(allowance.dailyLimitCNY)], ['每日已用', formatOptionalComputeAmount(allowance.dailyUsedCNY)], ['每日剩余', formatOptionalComputeAmount(allowance.dailyRemainingCNY)], ['每月限额', formatConfiguredLimit(monthlyLimit)], ['每月已用', formatOptionalComputeAmount(monthlyUsed)], ['每月剩余', formatOptionalComputeAmount(monthlyRemaining)],
    ]} />
  )

  return (
    <div className="compute-overview">
      {state.overview.error ? <ErrorBlock message={state.overview.error} onRetry={state.refresh} /> : null}
      {/* 结论层：三个数字，一眼看完 */}
      <section className="compute-summary" aria-label="算力总览">
        <div className="compute-summary-item">
          <span className="compute-summary-label"><Gauge size={14} aria-hidden />企业余额</span>
          <strong className="compute-summary-value">{formatComputeAmount(allowance.topUpRemainingCNY)}</strong>
          <span className="compute-summary-note">当前周期剩余 {remaining}</span>
        </div>
        <div className="compute-summary-item">
          <span className="compute-summary-label"><Wallet size={14} aria-hidden />个人钱包</span>
          <strong className="compute-summary-value">{formatComputeAmount(wallet.balanceCNY)}</strong>
          <span className="compute-summary-note">累计充 {formatComputeAmount(wallet.totalDepositCNY)} · 累计消费 {formatComputeAmount(wallet.totalConsumeCNY)}</span>
        </div>
        <div className="compute-summary-item">
          <span className="compute-summary-label"><Coins size={14} aria-hidden />近 {days} 天消费</span>
          <strong className="compute-summary-value">{trendTotal}</strong>
          <span className="compute-summary-note">
            企业额度与个人钱包分开计算
            <span className="compute-hint" tabIndex={0} role="note" aria-label="口径说明：管理员按企业账单统计，成员仅统计本人；额度已用只计企业承担；余额不是下一次调用成功的承诺，最终以 SEP 平台扣费结果为准。">
              <Info size={13} aria-hidden />
            </span>
          </span>
        </div>
      </section>

      {/* 明细层：左右分栏 */}
      <div className="compute-detail-grid">
        <section className="compute-card compute-allowance-card">
          <div className="compute-card-head">
            <div className="compute-card-title">
              <h3>额度明细</h3>
              <span className="compute-hint" tabIndex={0} role="note" aria-label="额度说明：企业额度、管理员追加余额和个人钱包分别展示；余额不是下一次调用成功的承诺，最终以 SEP 平台扣费结果为准。">
                <Info size={13} aria-hidden />
              </span>
            </div>
            <button type="button" className="compute-link" onClick={() => onDrawer({ title: '企业额度详情', children: allowanceDetail })}>查看详情 <ChevronRight size={14} /></button>
          </div>
          <div className="compute-allowance-progress-list" aria-label="企业额度进度">
            <AllowanceProgress label="充值余额" tone="recharge" limit={allowance.topUpAmountCNY} used={allowance.topUpConsumedCNY} remaining={allowance.topUpRemainingCNY} />
            <AllowanceProgress label="每月额度" tone="monthly" limit={monthlyLimit} used={monthlyUsed} remaining={monthlyRemaining} unlimited={monthlyIsCurrentPeriod && monthlyLimit === null} />
            <AllowanceProgress label="每日额度" tone="daily" limit={allowance.dailyLimitCNY} used={allowance.dailyUsedCNY} remaining={allowance.dailyRemainingCNY} />
          </div>
        </section>

        <section className="compute-card compute-trend-card">
          <div className="compute-card-head">
            <div className="compute-card-title">
              <h3>消费趋势</h3>
            </div>
            <strong className="compute-trend-total">{trendTotal}</strong>
          </div>
          {trendLoading ? <LoadingBlock /> : trendError ? <ErrorBlock message={trendError} onRetry={onRetryTrend} /> : <TrendChart data={trend} />}
        </section>
      </div>
      <ComputeUsageAnalysis data={trend} loading={trendLoading} error={trendError} />
    </div>
  )
}

export function ComputeCenterPage(): React.JSX.Element {
  const [tab, setTab] = useState<ComputeCenterTab>('overview')
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const openDetail = (detail: ComputeDetail): void => setDrawer({ title: detail.title, children: <DetailRows entries={detail.entries} /> })
  const closeDrawer = useMemo(() => () => setDrawer(null), [])
  const state = useComputeCenter(tab)
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const trend = useMemo(() => selectComputeBreakdown(days, state.overview.data?.breakdown, state.breakdown.data), [days, state.breakdown.data, state.overview.data?.breakdown])
  const trendLoading = days === 30 ? state.overview.loading : state.breakdown.loading
  const trendError = days === 30 ? state.overview.error : state.breakdown.error
  const content = tab === 'overview' ? <OverviewTab state={state} days={days} trend={trend} trendLoading={trendLoading} trendError={trendError} onRetryTrend={() => days === 30 ? state.refresh() : state.loadBreakdown(days)} onDrawer={setDrawer} /> : tab === 'usage' ? <ComputeUsageTab state={state} onDetail={openDetail} /> : <ComputeWalletTab state={state} onDetail={openDetail} />
  return <div className="compute-page">
    <div className="compute-section-head">
      <div className="compute-tabs" role="tablist" aria-label="算力中心分区">
        {([{ key: 'overview', label: '概览' }, { key: 'usage', label: '消费明细' }, { key: 'wallet', label: '个人钱包' }] as const).map(item => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>{item.label}</button>)}
      </div>
      {tab === 'overview' ? <button type="button" className="compute-refresh-button" disabled={state.overview.loading || state.breakdown.loading} onClick={() => { state.refresh(); if (days !== 30) state.loadBreakdown(days) }}><RefreshCw size={15} />刷新</button> : null}
    </div>
    {tab === 'overview' ? <div className="compute-range" role="group" aria-label="统计时间范围">{([7, 30, 90] as const).map(option => <button type="button" key={option} aria-pressed={days === option} className={days === option ? 'active' : ''} onClick={() => { setDays(option); if (option !== 30) state.loadBreakdown(option) }}>{option} 天</button>)}</div> : null}
    {content}<DetailDrawer drawer={drawer} onClose={closeDrawer} />
  </div>
}
