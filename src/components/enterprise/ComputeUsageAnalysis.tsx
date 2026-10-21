import { useState } from 'react'
import { computeModelLabel, formatOptionalComputeAmount, getComputeDistribution, type ComputeDistribution } from '../../features/enterprise/compute-center-model'
import type { ComputeUsageBreakdown } from '../../shared/compute-credit-contracts'

const dimensions: Array<{ key: ComputeDistribution; label: string }> = [
  { key: 'byModel', label: '模型' }, { key: 'byEmployee', label: '硅基员工' }, { key: 'byMember', label: '成员' }, { key: 'byDepartment', label: '部门' },
]

export function ComputeUsageAnalysis({ data, loading, error }: { data: ComputeUsageBreakdown | null; loading: boolean; error: string | null }): React.JSX.Element {
  const [selected, setSelected] = useState<ComputeDistribution>('byModel')
  const available = dimensions.filter(item => item.key === 'byModel' || getComputeDistribution(data, item.key).length > 0)
  const dimension = available.some(item => item.key === selected) ? selected : 'byModel'
  const rows = getComputeDistribution(data, dimension)
  return <section className="compute-analysis" aria-label="模型使用情况" aria-busy={loading}>
    <div className="compute-list-head"><h3>用量分析</h3><div role="tablist" aria-label="用量分析维度" className="compute-analysis-tabs">{available.map(item => <button key={item.key} type="button" role="tab" aria-selected={dimension === item.key} onClick={() => setSelected(item.key)}>{item.label}</button>)}</div></div>
    {loading ? <div className="compute-list-status" role="status">正在加载用量分析…</div> : error ? <div className="compute-list-error" role="alert">{error}</div> : <>
      <dl className="compute-usage-metrics"><div><dt>调用次数</dt><dd>{data?.callCount?.toLocaleString() ?? '—'}</dd></div><div><dt>输入 Token</dt><dd>{data?.inputTokens?.toLocaleString() ?? '—'}</dd></div><div><dt>输出 Token</dt><dd>{data?.outputTokens?.toLocaleString() ?? '—'}</dd></div><div><dt>较上一周期</dt><dd>{typeof data?.deltaPct === 'number' ? `${data.deltaPct > 0 ? '+' : ''}${data.deltaPct}%` : '—'}</dd></div></dl>
      {rows.length ? <div className="compute-table-wrap"><table className="compute-table"><thead><tr><th>{available.find(item => item.key === dimension)?.label}</th><th>调用次数</th><th>消费金额</th><th>消费占比</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><td className="compute-model-cell"><strong>{dimension === 'byModel' ? computeModelLabel(row.label) : row.label}</strong>{row.hint ? <small>{row.hint}</small> : null}</td><td>{row.callCount.toLocaleString()}</td><td>{formatOptionalComputeAmount(row.costCNY)}</td><td><div className="compute-share"><progress max={100} value={row.pct} aria-label={`${row.label}消费占比`} /><span>{row.pct}%</span></div></td></tr>)}</tbody></table></div> : <div className="compute-empty">当前区间暂无用量数据</div>}
    </>}
  </section>
}
