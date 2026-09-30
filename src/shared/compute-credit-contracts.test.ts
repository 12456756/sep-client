import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { computeAllowanceSchema, personalWalletSchema, walletTransactionsPageSchema } from './compute-credit-contracts'

const allowance = {
  userId: 'user-1', name: '测试用户', email: 'user@example.com', departmentName: '研发部',
  limitCNY: '300.00', period: 'MONTH', periodLabel: '每月', carryOver: true, enabled: true,
  carriedInCNY: '0.00', usedCNY: '35.4200', remainingCNY: '264.5800', topUpRemainingCNY: '50.00',
  totalRemainingCNY: '264.5800', usedPct: 12, periodStart: '2026-09-01T00:00:00.000Z', resetAt: '2026-10-01T00:00:00.000Z',
  dailyLimitCNY: null, dailyUsedCNY: '0.0000', dailyRemainingCNY: null,
  monthlyLimitCNY: '300.00', monthlyUsedCNY: '35.4200', monthlyRemainingCNY: '264.5800',
  dailyBypassUntil: null, dailyBypassActive: false, topUpAmountCNY: '50.00', topUpConsumedCNY: '0.00',
}

describe('compute credit contracts', () => {
  it('keeps unlimited allowance fields as null instead of coercing them to zero', () => {
    const result = computeAllowanceSchema.parse({ ...allowance, limitCNY: null, remainingCNY: null, totalRemainingCNY: null, usedPct: null })
    assert.equal(result.limitCNY, null)
    assert.equal(result.remainingCNY, null)
    assert.equal(result.totalRemainingCNY, null)
    assert.equal(result.usedPct, null)
  })

  it('accepts allowance responses without optional daily and monthly fields', () => {
    const {
      dailyLimitCNY: _dailyLimit,
      dailyUsedCNY: _dailyUsed,
      dailyRemainingCNY: _dailyRemaining,
      monthlyLimitCNY: _monthlyLimit,
      monthlyUsedCNY: _monthlyUsed,
      monthlyRemainingCNY: _monthlyRemaining,
      ...withoutPeriodBreakdown
    } = allowance
    const result = computeAllowanceSchema.parse(withoutPeriodBreakdown)
    assert.equal(result.dailyLimitCNY, undefined)
    assert.equal(result.monthlyRemainingCNY, undefined)
  })

  it('accepts wallet amounts as decimal strings and preserves unknown platform fields', () => {
    const result = personalWalletSchema.parse({ balanceCNY: '20.00', totalDepositCNY: '50.00', totalConsumeCNY: '30.0000', future: true })
    assert.equal(result.balanceCNY, '20.00')
    assert.equal(result.future, true)
  })

  it('rejects malformed pagination and invalid money', () => {
    assert.throws(() => walletTransactionsPageSchema.parse({ total: 0, page: 0, pageSize: 20, totalPages: 0, records: [] }))
    assert.throws(() => personalWalletSchema.parse({ balanceCNY: 0, totalDepositCNY: '1', totalConsumeCNY: '0' }))
  })
})
