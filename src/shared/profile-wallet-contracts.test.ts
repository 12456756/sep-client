import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  personalRechargeRequestSchema,
  personalRechargeOrderSchema,
  personalRechargeStatusSchema,
  personalRechargeReconcileSchema,
  clientProfileSchema,
} from './profile-wallet-contracts'

describe('profile and personal wallet contracts', () => {
  it('accepts valid profile and recharge responses', () => {
    assert.deepEqual(clientProfileSchema.parse({
      user: { id: 'u1', email: 'u@example.com', name: 'User', avatar: null, role: 'USER' },
      enterprise: { id: 'e1', name: 'Enterprise', logo: '/api/enterprise/logos/logo.png' },
    }).user.avatar, null)
    assert.equal(personalRechargeRequestSchema.parse({ amountCNY: 10.5 }).amountCNY, 10.5)
    assert.equal(personalRechargeOrderSchema.parse({ orderId: 'o1', orderNo: 'R1', amountCNY: '10.50', payUrl: '<form>' }).orderNo, 'R1')
    assert.equal(personalRechargeStatusSchema.parse('PAID'), 'PAID')
    assert.equal(personalRechargeReconcileSchema.parse({ status: 'PENDING', reconciled: false }).reconciled, false)
  })

  it('rejects invalid recharge amounts and malformed profile data', () => {
    for (const amount of [0, -1, 100000.01, 1.001]) {
      assert.throws(() => personalRechargeRequestSchema.parse({ amountCNY: amount }))
    }
    assert.throws(() => personalRechargeRequestSchema.parse({ amountCNY: 10, userId: 'another-user' }))
    assert.throws(() => clientProfileSchema.parse({ user: { id: 'u1' }, enterprise: null }))
  })

  it('accepts the nullable user name returned by the client profile API', () => {
    const profile = clientProfileSchema.parse({
      user: { id: 'u1', email: 'u@example.com', name: null, avatar: null, role: 'USER' },
      enterprise: null,
    })
    assert.equal(profile.user.name, null)
  })
})
