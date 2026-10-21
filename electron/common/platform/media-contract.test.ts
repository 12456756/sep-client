import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mediaCapabilitiesSchema, mediaGenerationInputSchema, mediaQuoteSchema, mediaReceiptSchema, parseMediaCapabilities } from './media-contract'
import * as mediaV2Fixture from '../../../src/shared/fixtures/media-runtime-v2.json'

const sepFixtures: { name: string; media: Record<string, unknown> }[] = JSON.parse(readFileSync(
  new URL('./fixtures/sep-media-runtime-v1.json', import.meta.url), 'utf8',
))

test('formal SEP configuration fixtures never advertise executable image tools', () => {
  for (const fixture of sepFixtures) {
    assert.deepEqual(parseMediaCapabilities(fixture.media), { protocolVersion: 1, tools: [], profiles: [] }, fixture.name)
  }
})

test('formal SEP runtime rejects unsupported execution and malformed configuration without leaking input', () => {
  const configured = sepFixtures[1].media
  for (const invalid of [
    { ...configured, executionAvailable: true },
    { ...configured, executionAvailable: 'false' },
    { ...configured, protocolVersion: 2 },
    { ...configured, tools: ['media_generate_image'] },
    { ...configured, profiles: [{ modelId: 'private-model', apiKey: 'secret' }] },
  ]) assert.throws(() => parseMediaCapabilities(invalid), { message: 'Invalid or unsupported SEP media runtime.' })
})

test('SEP image v2 defaults map into optional local fields while preserving protocol 1', () => {
  const wire = { protocolVersion: 2, executionAvailable: true, defaultProfileId: 'image-v2', tools: ['image_generate'], profiles: [{
    profileId: 'image-v2', kind: 'image', displayName: 'Image v2', configVersion: 'cfg-v2', operations: ['generate'], executionMode: 'sync-response',
    capabilities: { supportsReferenceImage: false, maxOutputs: 2, sizes: ['1024x1024', '1536x1024'], maxWidth: 1536, maxHeight: 1024,
      qualities: ['low', 'medium', 'high'], defaultQuality: 'high', defaultSize: '1536x1024' },
  }] }
  const local = parseMediaCapabilities(wire)
  assert.equal(local.protocolVersion, 1)
  assert.equal(local.defaultProfileId, 'image-v2')
  assert.equal(local.profiles[0]?.defaultQuality, 'high')
  assert.equal(local.profiles[0]?.defaultSize, '1536x1024')
  assert.throws(() => parseMediaCapabilities({ ...wire, protocolVersion: 1 }))
  assert.equal(mediaCapabilitiesSchema.safeParse({ ...capabilities, profiles: [{ ...capabilities.profiles[0], defaultSize: '1024x1024' }] }).success, false)
})

test('SEP backend image v2 fixture is consumed with strict defaults', () => {
  const local = parseMediaCapabilities(mediaV2Fixture.media)
  assert.equal(local.protocolVersion, 1)
  assert.equal(local.defaultProfileId, 'product-image-standard')
  assert.deepEqual(local.profiles[0]?.allowedQualities, ['low', 'medium', 'high'])
  assert.equal(local.profiles[0]?.defaultQuality, 'medium')
  assert.equal(local.profiles[0]?.defaultSize, '1024x1024')
  assert.throws(() => parseMediaCapabilities({
    ...mediaV2Fixture.media,
    profiles: [{ ...mediaV2Fixture.media.profiles[0], capabilities: {
      ...mediaV2Fixture.media.profiles[0].capabilities,
      defaultQuality: 'ultra',
    } }],
  }))
})

const capabilities = { protocolVersion: 1, tools: ['media_generate_image'], profiles: [{
  profileId: 'product', kind: 'image', displayName: 'Product image', configVersion: 'v1', operations: ['generate'], executionMode: 'async-query',
  capabilities: { referenceImage: false, cancel: false, recoverByRequestId: true }, allowedAspectRatios: ['1:1'], maxCount: 4,
}] }
const input = { profileId: 'product', operation: 'generate', localAssetIds: [], creativeBrief: 'Create a product image', parameters: { aspectRatio: '1:1', count: 1 } }
test('media accepts the explicit v1 image capability format and rejects unsupported protocols/video', () => {
  assert.equal(mediaCapabilitiesSchema.parse(capabilities).profiles.length, 1)
  assert.equal(mediaCapabilitiesSchema.safeParse({ ...capabilities, protocolVersion: 2 }).success, false)
  assert.equal(mediaCapabilitiesSchema.safeParse({ ...capabilities, profiles: [{ ...capabilities.profiles[0], kind: 'video' }] }).success, false)
})
test('media tool input rejects paths, provider payloads, billing and request identity', () => {
  assert.equal(mediaGenerationInputSchema.safeParse(input).success, true)
  for (const key of ['path', 'subscriptionId', 'clientRequestId', 'quoteId', 'providerPayload', 'price', 'url', 'apiKey']) {
    assert.equal(mediaGenerationInputSchema.safeParse({ ...input, [key]: 'untrusted' }).success, false, key)
  }
  assert.equal(mediaGenerationInputSchema.safeParse({ ...input, localAssetIds: ['../../secret'] }).success, false)
  assert.equal(mediaGenerationInputSchema.safeParse({ ...input, parameters: { ...input.parameters, count: 17 } }).success, false)
})
test('local quote port requires explicit authorization fields and platform-owned amount strings', () => {
  const quote = { quoteId: 'q', requestHash: 'a'.repeat(64), expiresAt: 1234, status: 'quoted', amount: '1.25', currency: 'CNY', authorized: true, budgetAuthorized: true, allowUnknownCost: false }
  assert.equal(mediaQuoteSchema.safeParse(quote).success, true)
  assert.equal(mediaQuoteSchema.safeParse({ ...quote, amount: 1.25 }).success, false)
  assert.equal(mediaQuoteSchema.safeParse({ ...quote, amount: null }).success, false)
  assert.equal(mediaQuoteSchema.safeParse({ ...quote, status: 'unavailable', amount: null, currency: null, allowUnknownCost: true }).success, true)
  const { budgetAuthorized: _budget, ...missing } = quote
  assert.equal(mediaQuoteSchema.safeParse(missing).success, false)
})
test('receipt input does not accept arbitrary output URLs or oversized content', () => {
  const receipt = { receiptId: 'receipt', clientRequestId: 'client', profileId: 'product', configVersion: 'v1', status: 'SUCCEEDED', pollAfterMs: 1000, billingStatus: 'SETTLED', outputs: [] }
  const output = { outputId: 'out', mime: 'image/png', size: 100, width: 1, height: 1, expiresAt: null }
  assert.equal(mediaReceiptSchema.safeParse({ ...receipt, outputs: [output] }).success, true)
  assert.equal(mediaReceiptSchema.safeParse({ ...receipt, outputs: [{ ...output, url: 'https://untrusted.test/image' }] }).success, false)
  assert.equal(mediaReceiptSchema.safeParse({ ...receipt, outputs: [{ ...output, size: 33 * 1024 * 1024 }] }).success, false)
})
