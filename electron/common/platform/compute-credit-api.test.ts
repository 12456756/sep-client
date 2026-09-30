import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import * as api from './platform-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
const allowance = {
  userId: 'user-1', name: '测试用户', email: 'user@example.com', departmentName: '研发部', limitCNY: '300.00', period: 'MONTH', periodLabel: '每月', carryOver: true, enabled: true, carriedInCNY: '0.00', usedCNY: '35.4200', remainingCNY: '264.5800', topUpRemainingCNY: '50.00', totalRemainingCNY: '264.5800', usedPct: 12, periodStart: '2026-09-01T00:00:00.000Z', resetAt: '2026-10-01T00:00:00.000Z', dailyLimitCNY: null, dailyUsedCNY: '0.0000', dailyRemainingCNY: null, monthlyLimitCNY: '300.00', monthlyUsedCNY: '35.4200', monthlyRemainingCNY: '264.5800', dailyBypassUntil: null, dailyBypassActive: false, topUpAmountCNY: '50.00', topUpConsumedCNY: '0.00',
}
const wallet = { balanceCNY: '20.00', totalDepositCNY: '50.00', totalConsumeCNY: '30.0000' }

describe('SEP compute credit API', () => {
  it('uses accessToken, documented paths, query parameters, and parses responses', async () => {
    const calls: string[] = []
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url)
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
      if (url.endsWith('/my-allowance')) return response(allowance)
      if (url.endsWith('/personal-wallet')) return response(wallet)
      if (url.includes('/transactions?')) return response({ total: 0, page: 2, pageSize: 10, totalPages: 0, records: [] })
      if (url.includes('/usage-records?')) return response({ total: 0, page: 1, pageSize: 20, totalPages: 0, records: [] })
      return response({ days: 30, totals: { costCNY: '1.00' }, series: [] })
    }
    assert.equal((await api.getMyComputeAllowance('access')).usedCNY, '35.4200')
    assert.equal((await api.getPersonalWallet('access')).balanceCNY, '20.00')
    assert.equal((await api.getPersonalWalletTransactions('access', { page: 2, pageSize: 10 })).page, 2)
    assert.equal((await api.getComputeUsageRecords('access', { page: 1, pageSize: 20 })).page, 1)
    assert.deepEqual((await api.getComputeUsageBreakdown('access', 30)).totals, { costCNY: '1.00' })
    assert.ok(calls.some(url => url.endsWith('/compute-credit/my-allowance')))
    assert.ok(calls.some(url => url.endsWith('/personal-wallet')))
    assert.ok(calls.some(url => url.includes('/compute-credit/usage-breakdown?days=30')))
  })

  it('validates page and days before making a request', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return response({}) }
    await assert.rejects(() => api.getPersonalWalletTransactions('access', { page: 0, pageSize: 20 }))
    await assert.rejects(() => api.getComputeUsageBreakdown('access', 14))
    assert.equal(calls, 0)
  })
})
