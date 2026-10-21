import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, RefreshCw, Search, X } from 'lucide-react'
import { useState } from 'react'
import { computeModelLabel, computeUsageDateError, formatOptionalComputeAmount, sumComputeAmounts } from '../../features/enterprise/compute-center-model'
import type { ComputeCenterState } from '../../features/enterprise/use-compute-center'
import type { ComputePageQuery, ComputeUsageRecord, WalletTransaction } from '../../shared/compute-credit-contracts'

export type ComputeDetail = { title: string; entries: Array<[string, string]> }

const text = (value: string | null | undefined, fallback = '—'): string => value || fallback
const money = formatOptionalComputeAmount

export function ComputePagination({ query, total, totalPages, loading, onChange, label }: {
  query: ComputePageQuery; total: number; totalPages: number; loading: boolean
  onChange: (query: ComputePageQuery) => void; label: string
}): React.JSX.Element {
  const pages = Math.max(1, totalPages)
  const previous = loading || query.page <= 1
  const next = loading || query.page >= pages
  return <nav className="compute-pagination" aria-label={`${label}分页`}>
    <span>共 {total} 条</span>
    <label>每页 <select aria-label={`${label}每页条数`} value={query.pageSize} disabled={loading} onChange={event => onChange({ page: 1, pageSize: Number(event.target.value) })}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select> 条</label>
    <div className="compute-page-actions">
      <button type="button" className="compute-icon-button" aria-label={`${label}首页`} title="首页" disabled={previous} onClick={() => onChange({ ...query, page: 1 })}><ChevronsLeft size={16} /></button>
      <button type="button" className="compute-icon-button" aria-label={`${label}上一页`} title="上一页" disabled={previous} onClick={() => onChange({ ...query, page: query.page - 1 })}><ChevronLeft size={16} /></button>
      <span aria-live="polite">第 {query.page} / {pages} 页</span>
      <button type="button" className="compute-icon-button" aria-label={`${label}下一页`} title="下一页" disabled={next} onClick={() => onChange({ ...query, page: query.page + 1 })}><ChevronRight size={16} /></button>
      <button type="button" className="compute-icon-button" aria-label={`${label}末页`} title="末页" disabled={next} onClick={() => onChange({ ...query, page: pages })}><ChevronsRight size={16} /></button>
    </div>
  </nav>
}

function ListStatus({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }): React.JSX.Element | null {
  if (error) return <div className="compute-list-error" role="alert"><span>{error}</span><button type="button" className="compute-link" onClick={onRetry}>重试</button></div>
  return loading ? <div className="compute-list-status" role="status">正在加载…</div> : null
}

export function computeUsageDetails(record: ComputeUsageRecord): ComputeDetail {
  return { title: '消费记录详情', entries: [
    ['记录 ID', text(record.id)], ['时间', text(record.createdAt)], ['成员', text(record.memberName ?? record.memberId, '当前成员')],
    ['硅基员工', text(record.employeeName ?? record.employeeId)], ['模型', computeModelLabel(record.modelName ?? record.modelId)],
    ['输入 Token', record.modelId === 'media-real' ? '不适用' : record.inputTokens?.toLocaleString() ?? '—'],
    ['输出 Token', record.modelId === 'media-real' ? '不适用' : record.outputTokens?.toLocaleString() ?? '—'],
    ['总消费', money(record.costCNY)], ['企业赠送额度承担', money(record.creditPaidCNY)], ['成员企业充值承担', money(record.memberWalletPaidCNY)],
    ['企业公共钱包承担', money(record.walletPaidCNY)], ['个人钱包承担', money(record.personalPaidCNY)], ['欠费', money(record.unpaidCNY)],
    ['定价', record.fallbackPricing === undefined ? '—' : record.fallbackPricing ? '兜底定价' : '标准定价'], ['会话 ID', text(record.sessionId)],
  ] }
}

export function ComputeUsageTab({ state, onDetail }: { state: ComputeCenterState; onDetail: (detail: ComputeDetail) => void }): React.JSX.Element {
  const { usageRecords: { data, loading, error }, usageQuery: query } = state
  const [startDate, setStartDate] = useState(query.startDate ?? '')
  const [endDate, setEndDate] = useState(query.endDate ?? '')
  const dateError = computeUsageDateError(startDate, endDate)
  return <section className="compute-list-section" aria-label="消费明细" aria-busy={loading}>
    <div className="compute-list-head"><h3>消费明细</h3><button type="button" className="compute-icon-button" disabled={loading} onClick={() => state.loadUsageRecords()} aria-label="刷新消费明细" title="刷新消费明细"><RefreshCw size={16} /></button></div>
    <form className="compute-filters" onSubmit={event => { event.preventDefault(); if (!dateError) state.loadUsageRecords({ ...query, page: 1, startDate: startDate || undefined, endDate: endDate || undefined }) }}>
      <label>开始日期<input type="date" aria-label="开始日期" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
      <label>结束日期<input type="date" aria-label="结束日期" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
      <button className="compute-refresh-button" type="submit" disabled={loading || !!dateError}><Search size={15} />筛选</button>
      <button className="compute-refresh-button" type="button" disabled={loading} onClick={() => { setStartDate(''); setEndDate(''); state.loadUsageRecords({ page: 1, pageSize: query.pageSize }) }}><X size={15} />重置</button>
      {dateError ? <span role="alert" className="compute-filter-error">{dateError}</span> : null}
    </form>
    <ListStatus loading={loading} error={error} onRetry={() => state.loadUsageRecords()} />
    {data?.records.length ? <div className="compute-table-wrap"><table className="compute-table"><thead><tr><th>时间</th><th>成员 / 员工</th><th>模型</th><th>企业承担</th><th>个人钱包</th><th>欠费</th><th>总消费</th><th aria-label="操作" /></tr></thead><tbody>{data.records.map((record, index) => <tr key={record.id ?? index}>
      <td>{text(record.createdAt)}</td><td><strong>{text(record.memberName ?? record.memberId, '当前成员')}</strong><small>{text(record.employeeName ?? record.employeeId)}</small></td>
      <td className="compute-model-cell">{computeModelLabel(record.modelName ?? record.modelId)}</td><td>{money(sumComputeAmounts([record.creditPaidCNY, record.memberWalletPaidCNY, record.walletPaidCNY]))}</td>
      <td>{money(record.personalPaidCNY)}</td><td>{money(record.unpaidCNY)}</td><td><strong>{money(record.costCNY)}</strong></td>
      <td><button type="button" className="compute-link" onClick={() => onDetail(computeUsageDetails(record))}>详情</button></td>
    </tr>)}</tbody></table></div> : !loading && !error ? <div className="compute-empty">{query.startDate || query.endDate ? '所选日期内暂无消费记录' : '暂无消费记录'}</div> : null}
    <ComputePagination query={query} total={data?.total ?? 0} totalPages={data?.totalPages ?? 0} loading={loading || !!error} label="消费明细" onChange={page => state.loadUsageRecords({ ...query, ...page })} />
  </section>
}

const walletTypes: Record<WalletTransaction['type'], string> = { DEPOSIT: '充值', CONSUME: '消费', REFUND: '退款', ADJUSTMENT: '调整' }

export function ComputeWalletTab({ state, onDetail }: { state: ComputeCenterState; onDetail: (detail: ComputeDetail) => void }): React.JSX.Element {
  const { walletTransactions: { data, loading, error }, walletQuery: query } = state
  return <section className="compute-list-section" aria-label="钱包流水" aria-busy={loading}>
    <div className="compute-list-head"><h3>钱包流水</h3><button type="button" className="compute-icon-button" disabled={loading} onClick={() => state.loadWalletTransactions()} aria-label="刷新钱包流水" title="刷新钱包流水"><RefreshCw size={16} /></button></div>
    <ListStatus loading={loading} error={error} onRetry={() => state.loadWalletTransactions()} />
    {data?.records.length ? <div className="compute-table-wrap"><table className="compute-table"><thead><tr><th>时间</th><th>类型</th><th>说明</th><th>发生金额</th><th>余额</th><th aria-label="操作" /></tr></thead><tbody>{data.records.map(record => {
      const positive = Number(record.amountCNY) > 0
      return <tr key={record.id}><td>{record.createdAt}</td><td><span className={`compute-type ${positive ? 'positive' : 'negative'}`}>{positive ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}{walletTypes[record.type]}</span></td><td className="compute-description-cell">{text(record.description)}</td><td className={positive ? 'compute-money-positive' : 'compute-money-negative'}>{money(record.amountCNY)}</td><td>{money(record.balanceAfterCNY)}</td><td><button type="button" className="compute-link" onClick={() => onDetail({ title: '钱包流水详情', entries: [
        ['流水 ID', record.id], ['流水类型', walletTypes[record.type]], ['说明', text(record.description)], ['发生金额', money(record.amountCNY)], ['交易后余额', money(record.balanceAfterCNY)], ['关联类型', text(record.relatedType)], ['关联记录', text(record.relatedId)], ['时间', record.createdAt],
      ] })}>详情</button></td></tr>
    })}</tbody></table></div> : !loading && !error ? <div className="compute-empty">暂无钱包流水</div> : null}
    <ComputePagination query={query} total={data?.total ?? 0} totalPages={data?.totalPages ?? 0} loading={loading || !!error} label="钱包流水" onChange={state.loadWalletTransactions} />
  </section>
}
