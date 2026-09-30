import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { formatComputeAmount, formatComputePercent, formatAllowanceValue } from './compute-center-model'

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
})
