import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelBillingLabel, modelCatalogSchema } from './model-catalog-contracts'

describe('model catalog contract', () => {
  it('preserves explicit vision support and leaves missing capability unknown', () => {
    const models = modelCatalogSchema.parse([
      { modelId: 'vision', vision: true }, { modelId: 'text', vision: false },
      { modelId: 'legacy' }, { modelId: 'unknown', vision: null },
    ])
    assert.deepEqual(models.map(model => model.vision), [true, false, null, null])
    assert.equal(modelCatalogSchema.safeParse([{ modelId: 'invalid', vision: 'false' }]).success, false)
  })
  it('keeps legacy models usable without guessing billing data', () => {
    assert.deepEqual(modelCatalogSchema.parse([{ modelId: 'model-a' }]), [{
      modelId: 'model-a', displayName: 'model-a', billingMultiplier: null, discountLabel: null, isFree: null, vision: null,
    }])
  })

  it('accepts the older SEP id and label fields', () => {
    assert.deepEqual(modelCatalogSchema.parse([{ id: 'model-old', label: '旧版模型' }]), [{
      modelId: 'model-old', displayName: '旧版模型', billingMultiplier: null, discountLabel: null, isFree: null, vision: null,
    }])
  })

  it('normalizes SEP display and billing data without changing its meaning', () => {
    const [campaign, relayFree, unavailable] = modelCatalogSchema.parse([
      { modelId: 'model-a', displayName: '模型 A', billingMultiplier: '1', discountLabel: '按中转倍率计费', isFree: false },
      { modelId: 'model-b', displayName: '模型 B', billingMultiplier: '0', discountLabel: '活动免费', isFree: true },
      { modelId: 'model-c', billingMultiplier: null, discountLabel: '中转倍率暂不可用', isFree: false },
    ])

    assert.equal(modelBillingLabel(campaign!), '1×')
    assert.equal(modelBillingLabel(relayFree!), '0×')
    assert.equal(unavailable?.isFree, false)
    assert.equal(modelBillingLabel(unavailable!), '中转倍率暂不可用')
  })
})
