import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { formatComputeAmount, formatComputePercent, formatAllowanceValue, formatConfiguredLimit, formatOptionalComputeAmount, formatRemainingPercent, getComputeTrendPoints, getComputeTrendTotal, selectComputeBreakdown, sumComputeAmounts, computeModelLabel, getComputeDistribution, computeUsageDateError } from './compute-center-model'

describe('compute center display model', () => {
  it('formats decimal strings for display without merging enterprise and wallet balances', () => {
    assert.equal(formatComputeAmount('35.4200'), '¥35.42')
    assert.equal(formatComputeAmount(null), '不限额')
    assert.equal(formatAllowanceValue(null), '不限额')
    assert.equal(formatConfiguredLimit(null), '未设置')
    assert.equal(formatConfiguredLimit('20.00'), '¥20.00')
    assert.equal(formatOptionalComputeAmount(undefined), '—')
    assert.equal(formatOptionalComputeAmount(null), '—')
  })
  it('clamps usage percentages for progress rendering', () => {
    assert.equal(formatComputePercent(null), 0)
    assert.equal(formatComputePercent(140), 100)
    assert.equal(formatComputePercent(35.4), 35.4)
  })

  it('calculates the remaining allowance percentage from the limit and balance', () => {
    assert.equal(formatRemainingPercent('200.00', '199.66'), 99.83)
    assert.equal(formatRemainingPercent('200.00', '0.00'), 0)
    assert.equal(formatRemainingPercent(null, null), null)
    assert.equal(formatRemainingPercent('0.00', '0.00'), null)
  })

  it('uses data for the selected trend range without falling back to another range', () => {
    const overview = { days: 30, series: [] }
    const requested = { days: 7, series: [] }
    assert.equal(selectComputeBreakdown(30, overview, requested), overview)
    assert.equal(selectComputeBreakdown(7, overview, null), null)
    assert.equal(selectComputeBreakdown(7, overview, requested), requested)
  })

  it('reads the platform trend response and total amount', () => {
    const breakdown = {
      rangeDays: 30,
      totalCNY: '0.4200',
      trend: [
        { date: '2026-09-29', costCNY: '0.1200' },
        { date: '2026-09-30', costCNY: '0.3000' },
      ],
    }
    assert.deepEqual(getComputeTrendPoints(breakdown), [
      { label: '2026-09-29', value: 0.12 },
      { label: '2026-09-30', value: 0.3 },
    ])
    assert.equal(getComputeTrendTotal(breakdown), '0.4200')
  })

  it('keeps compatibility with the legacy nested trend response', () => {
    assert.deepEqual(getComputeTrendPoints({ totals: { costCNY: '1.00' }, series: [{ label: '昨天', value: '1.00' }] }), [{ label: '昨天', value: 1 }])
    assert.equal(getComputeTrendTotal({ totals: { costCNY: '1.00' } }), '1.00')
  })

  it('sums all enterprise funding sources separately from personal and unpaid amounts', () => {
    assert.equal(sumComputeAmounts(['0.1200', '0.2300', '0.0500']), '0.4000')
    assert.equal(sumComputeAmounts([undefined, null]), undefined)
  })

  it('retains sub-cent charges and six decimal ledger precision', () => {
    assert.equal(formatComputeAmount('0.000123'), '¥0.000123')
    assert.equal(formatComputeAmount('0.0042'), '¥0.0042')
    assert.equal(sumComputeAmounts(['0.000001', '0.000002']), '0.000003')
    assert.equal(sumComputeAmounts(['99999999999999.999999', '0.000001']), '100000000000000.000000')
  })

  it('labels legacy image usage without inventing an actual model name', () => {
    assert.equal(computeModelLabel('media-real'), '图片生成 / 编辑（历史未记录模型）')
    assert.equal(computeModelLabel('gpt-image-2'), 'gpt-image-2')
    assert.equal(computeModelLabel(undefined), '未记录模型')
  })

  it('reads server aggregate dimensions rather than deriving totals from a single page', () => {
    const row = { key: 'media-real', label: 'media-real', costCNY: '0.12', callCount: 2, pct: 60 }
    assert.deepEqual(getComputeDistribution({ byModel: [row] }, 'byModel'), [row])
    assert.deepEqual(getComputeDistribution({}, 'byModel'), [])
    assert.deepEqual(getComputeDistribution({ byModel: [{ key: 'bad', costCNY: 'secret' }] }, 'byModel'), [])
  })

  it('validates real calendar dates and rejects inverted usage ranges', () => {
    assert.equal(computeUsageDateError('2026-10-01', '2026-10-16'), null)
    assert.equal(computeUsageDateError('', ''), null)
    assert.ok(computeUsageDateError('2026-10-17', '2026-10-16'))
    assert.ok(computeUsageDateError('2026-02-30', ''))
  })
})
