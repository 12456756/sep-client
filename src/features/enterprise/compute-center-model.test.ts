import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { formatComputeAmount, formatComputePercent, formatAllowanceValue, formatRemainingPercent, selectComputeBreakdown } from './compute-center-model'

describe('compute center display model', () => {
  it('formats decimal strings for display without merging enterprise and wallet balances', () => {
    assert.equal(formatComputeAmount('35.4200'), '¥35.42')
    assert.equal(formatComputeAmount(null), '不限额')
    assert.equal(formatAllowanceValue(null), '不限额')
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
})
